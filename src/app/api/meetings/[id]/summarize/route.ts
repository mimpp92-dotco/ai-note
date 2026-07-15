import { z } from "zod";

import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { artifactPairRevisionSchema } from "@/lib/manualMeetingContent";
import { assertSafeId } from "@/lib/meetingId";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { acceptSummarize } from "@/lib/summarize";

// Initial generation retains correction + summary. An explicit re-summarize is
// revision-bound and runs summary-only from the current canonical transcript.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  resummarize: z.boolean().optional(),
  expectedRevision: artifactPairRevisionSchema.optional(),
}).strict().superRefine((body, context) => {
  if (body.resummarize === true && body.expectedRevision === undefined) {
    context.addIssue({
      code: "custom",
      path: ["expectedRevision"],
      message: "summary regeneration requires an expected revision",
    });
  }
  if (body.resummarize !== true && body.expectedRevision !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["expectedRevision"],
      message: "initial generation does not accept a content revision",
    });
  }
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return publicErrorResponse("invalid_request", 400, { field: "meetingId" });
  }
  const fenced = await meetingFenceResponse(id);
  if (fenced) return fenced;

  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 4 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return publicErrorResponse("invalid_request", 400);
  }
  const force = parsed.data.resummarize === true;

  const accepted = await acceptSummarize(id, {
    force,
    expectedRevision: parsed.data.expectedRevision,
  });
  if (!accepted.accepted) {
    if (accepted.reason === "not_found") {
      return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
    }
    if (accepted.reason === "no_model") {
      return publicErrorResponse("invalid_request", 400, { field: "provider" });
    }
    if (accepted.reason === "revision_conflict") {
      return publicErrorResponse("content_revision_conflict", 409);
    }
    if (accepted.reason === "source_conflict") {
      return publicErrorResponse("content_source_conflict", 409);
    }
    if (accepted.reason === "state_ambiguous") {
      return publicErrorResponse("content_state_ambiguous", 409);
    }
    if (accepted.reason === "in_progress" && force) {
      return publicErrorResponse("content_operation_in_progress", 409, {
        operation: "summary_regenerate",
      });
    }
    if (accepted.reason === "error") {
      return publicErrorResponse(force ? "content_save_unavailable" : "internal_error", 503);
    }
    return publicErrorResponse("meeting_conflict", 409, { meetingId: id, action: "summarize" });
  }

  return jsonNoStore({ ok: true, durability: accepted.durability }, 202);
}
