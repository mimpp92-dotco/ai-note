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
import {
  acceptTranscriptRegenerate,
  type SummarizeAcceptance,
} from "@/lib/summarize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  expectedRevision: artifactPairRevisionSchema,
  confirmReplacement: z.literal(true),
}).strict();

function failureResponse(
  result: Extract<SummarizeAcceptance, { accepted: false }>,
): Response {
  if (result.reason === "not_found") {
    return publicErrorResponse("meeting_not_found", 404);
  }
  if (result.reason === "no_model") {
    return publicErrorResponse("invalid_request", 400, { field: "provider" });
  }
  if (result.reason === "revision_conflict") {
    return publicErrorResponse("content_revision_conflict", 409);
  }
  if (result.reason === "in_progress") {
    return publicErrorResponse("content_operation_in_progress", 409, {
      operation: "transcript_regenerate",
    });
  }
  if (result.reason === "source_conflict") {
    return publicErrorResponse("content_source_conflict", 409);
  }
  if (result.reason === "state_ambiguous") {
    return publicErrorResponse("content_state_ambiguous", 409);
  }
  if (result.reason === "error") {
    return publicErrorResponse("content_save_unavailable", 503);
  }
  return publicErrorResponse("meeting_conflict", 409, {
    action: "transcript_regenerate",
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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
    return publicErrorResponse("invalid_request", 400, { field: "transcript" });
  }

  const accepted = await acceptTranscriptRegenerate(id, {
    expectedRevision: parsed.data.expectedRevision,
  });
  return accepted.accepted
    ? jsonNoStore({ ok: true, durability: accepted.durability }, 202)
    : failureResponse(accepted);
}
