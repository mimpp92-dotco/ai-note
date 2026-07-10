import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { isSafeId } from "@/lib/meetingId";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { readStatus, updateStatus } from "@/lib/status";
import { enqueueTranscription } from "@/lib/transcribe";

// POST /api/transcribe { id } — manual (re)enqueue, e.g. after a whisper outage on
// finalize. Same delegation path as finalize; whisper being unreachable maps to a
// retryable error + 502 (not a crash).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  let body: { id?: unknown } | null;
  try {
    body = await parseBoundedJsonBody(request, 4 * 1024) as { id?: unknown } | null;
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const id = body?.id;
  if (!isSafeId(id)) {
    return publicErrorResponse("invalid_request", 400, { field: "meetingId" });
  }
  const fenced = await meetingFenceResponse(id);
  if (fenced) return fenced;

  try {
    const result = await enqueueTranscription(id);
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : 409;
      return publicErrorResponse(
        result.reason === "not_found" ? "meeting_not_found" : "meeting_conflict",
        code,
        { meetingId: id },
      );
    }
    return jsonNoStore({
      id,
      status: result.state === "completed" ? "transcribed" : "transcribing",
      durability: result.durability,
    });
  } catch {
    const status = await readStatus(id);
    if (status) {
      await updateStatus(id, undefined, (latest) => ({
        ...latest,
        error: {
          code: "transcription_failed",
          message: "전사를 완료하지 못했습니다. 로컬 전사 서비스를 확인해 주세요",
          action: "retry_transcription",
        },
      }));
    }
    return publicErrorResponse("local_service_unavailable", 502);
  }
}
