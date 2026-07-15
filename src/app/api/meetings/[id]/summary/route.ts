import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import {
  manualSummaryRequestSchema,
  saveManualSummary,
  type ManualMeetingContentSaveResult,
} from "@/lib/manualMeetingContent";
import { assertSafeId } from "@/lib/meetingId";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failureResponse(
  result: Exclude<ManualMeetingContentSaveResult, { ok: true }>,
): Response {
  if (result.reason === "invalid_transcript" || result.reason === "invalid_summary") {
    return publicErrorResponse("invalid_request", 400, { field: result.field ?? "summary" });
  }
  if (result.reason === "not_found") {
    return publicErrorResponse("meeting_not_found", 404);
  }
  if (result.reason === "revision_conflict") {
    return publicErrorResponse("content_revision_conflict", 409);
  }
  if (result.reason === "operation_in_progress") {
    return publicErrorResponse("content_operation_in_progress", 409, {
      operation: result.operation ?? "content_mutation",
    });
  }
  if (result.reason === "source_conflict") {
    return publicErrorResponse("content_source_conflict", 409);
  }
  if (result.reason === "state_ambiguous") {
    return publicErrorResponse("content_state_ambiguous", 409);
  }
  return publicErrorResponse("content_save_unavailable", 503);
}

export async function PATCH(
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
    body = await parseBoundedJsonBody(request, 512 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = manualSummaryRequestSchema.safeParse(body);
  if (!parsed.success) {
    return publicErrorResponse("invalid_request", 400, { field: "summary" });
  }

  const result = await saveManualSummary({ id, ...parsed.data });
  return result.ok
    ? jsonNoStore({ ...result.content, durability: result.durability })
    : failureResponse(result);
}
