import { z } from "zod";

import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { assertSafeId } from "@/lib/meetingId";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { jsonNoStore, publicErrorResponse } from "@/lib/publicApi";
import { deriveStatus, readStatus, updateStatus } from "@/lib/status";

// POST /api/meetings/[id]/title — set a manual display title. Only allowed once
// the meeting is summarized (derived state), and stored as titleOverride so
// deriveStatus keeps it over the summarizer's title (see status.ts). app-api is
// the single writer of status.json.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const titleSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict();

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
  const parsed = titleSchema.safeParse(body);
  if (!parsed.success) {
    return publicErrorResponse("invalid_request", 400, { field: "title" });
  }
  const { title } = parsed.data;

  const persisted = await readStatus(id);
  if (!persisted) return publicErrorResponse("meeting_not_found", 404, { meetingId: id });

  // Gate on the DERIVED state, not persisted: a meeting summarized by the manual
  // /meeting-summarize skill can leave status.json at "transcribed" while
  // summary.json exists — persisted alone would 409 a legitimately-summarized one.
  const { status: derived } = deriveStatus(id, persisted);
  if (derived.status !== "summarized") {
    return publicErrorResponse("meeting_conflict", 409, { meetingId: id });
  }

  // Write the derived object so a lagging status.json is reconciled to
  // "summarized" by the same write. titleOverride pins the manual title.
  await updateStatus(id, undefined, (latest) => {
    const current = deriveStatus(id, latest).status;
    if (current.status !== "summarized") throw new Error("meeting_not_summarized");
    return { ...current, title, titleOverride: title };
  });
  return jsonNoStore({ ok: true, title });
}
