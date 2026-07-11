import { z } from "zod";

import {
  guardLocalApiRequest,
  parseBoundedJsonBody,
  requestBodyErrorResponse,
} from "@/lib/localRequestGuard";
import { assertSafeId } from "@/lib/meetingId";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { jsonNoStore, publicErrorResponse, toPublicMeeting } from "@/lib/publicApi";
import { readStatus, updateStatus } from "@/lib/status";

// POST /api/meetings/[id]/review — the user's authoritative participants input
// (docs/ARCHITECTURE.md: status.review). Written by app-api. The summarizer never
// infers attendees; this is the source of truth.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reviewSchema = z.object({
  participants: z.array(z.string()).default([]),
}).strict();

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
    body = await parseBoundedJsonBody(request, 32 * 1024);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return publicErrorResponse("invalid_request", 400);
  }

  const status = await readStatus(id);
  if (!status) return publicErrorResponse("meeting_not_found", 404, { meetingId: id });

  await updateStatus(id, undefined, (latest) => ({ ...latest, review: parsed.data }));
  const updated = await readStatus(id);
  if (!updated) return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
  return jsonNoStore(toPublicMeeting(updated));
}
