import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { assertSafeId } from "@/lib/meetingId";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { acceptSummarize } from "@/lib/summarize";

// POST /api/meetings/[id]/summarize — user-initiated (re)summarize. Correction +
// summary can take minutes on a long meeting, so this does NOT block on the work:
// it validates synchronously, fires runSummarize (fire-and-forget), and returns 202.
// The client polls (router.refresh) for the new summary or a retry_summary failure.
// Body { resummarize: true } forces regenerating an already-summarized meeting
// ("다시 요약"); without it an existing summary still 409s (no accidental re-summarize,
// so glossary saves / the worker sweep can never trigger one).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  let body: { resummarize?: boolean } | null;
  try {
    body = await parseBoundedJsonBody(request, 4 * 1024) as { resummarize?: boolean } | null;
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  if (
    body === null
    || typeof body !== "object"
    || Object.keys(body).some((key) => key !== "resummarize")
    || (body.resummarize !== undefined && typeof body.resummarize !== "boolean")
  ) {
    return publicErrorResponse("invalid_request", 400);
  }
  const force = body?.resummarize === true;

  const accepted = await acceptSummarize(id, { force });
  if (!accepted.accepted) {
    if (accepted.reason === "not_found") {
      return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
    }
    if (accepted.reason === "no_model") {
      return publicErrorResponse("invalid_request", 400, { field: "provider" });
    }
    if (accepted.reason === "error") return publicErrorResponse("internal_error", 503);
    return publicErrorResponse("meeting_conflict", 409, { meetingId: id, action: "summarize" });
  }

  return jsonNoStore({ ok: true, durability: accepted.durability }, 202);
}
