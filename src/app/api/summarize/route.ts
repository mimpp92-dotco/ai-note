import { z } from "zod";

import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { isSafeId } from "@/lib/meetingId";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { acceptSummarize } from "@/lib/summarize";
import { resolveLatestSummarizable } from "@/lib/summarizeWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  id: z.string(),
  resummarize: z.boolean().optional(),
}).strict();

export async function POST(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, 4 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success || (parsed.data.id !== "latest" && !isSafeId(parsed.data.id))) {
    return publicErrorResponse("invalid_request", 400, { field: "meetingId" });
  }
  const id = parsed.data.id === "latest"
    ? await resolveLatestSummarizable()
    : parsed.data.id;
  if (!id) {
    return jsonNoStore({
      error: {
        code: "no_summarize_candidate",
        message: "요약을 기다리는 회의가 없습니다",
      },
    }, 404);
  }
  const fenced = await meetingFenceResponse(id);
  if (fenced) return fenced;
  const accepted = await acceptSummarize(id, { force: parsed.data.resummarize === true });
  if (accepted.accepted) {
    return jsonNoStore({ ok: true, durability: accepted.durability }, 202);
  }
  if (accepted.reason === "not_found") return publicErrorResponse("meeting_not_found", 404);
  if (accepted.reason === "no_model") return publicErrorResponse("invalid_request", 400, { field: "provider" });
  if (accepted.reason === "revision_conflict") {
    return publicErrorResponse("content_revision_conflict", 409);
  }
  if (accepted.reason === "source_conflict") {
    return publicErrorResponse("content_source_conflict", 409);
  }
  if (accepted.reason === "state_ambiguous") {
    return publicErrorResponse("content_state_ambiguous", 409);
  }
  if (accepted.reason === "in_progress" && parsed.data.resummarize === true) {
    return publicErrorResponse("content_operation_in_progress", 409, {
      operation: "summary_regenerate",
    });
  }
  if (accepted.reason === "error") {
    return publicErrorResponse(
      parsed.data.resummarize === true ? "content_save_unavailable" : "internal_error",
      503,
    );
  }
  return publicErrorResponse("meeting_conflict", 409, { meetingId: id, action: "summarize" });
}
