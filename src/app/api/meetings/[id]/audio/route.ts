import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";

import { acquireArtifactReadLease } from "@/lib/artifactLease";
import { createLeasedWebStream, resolveByteRange } from "@/lib/audioStream";
import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";
import { publicErrorResponse } from "@/lib/publicApi";

// GET /api/meetings/[id]/audio — streams the meeting's remuxed audio for the detail
// player. data/ lives outside public/, so the browser cannot reach it without this
// route. Prefers play.webm (seekable remux), falls back to the original audio.webm.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rangeNotSatisfiable(total?: number): Response {
  const response = publicErrorResponse("invalid_request", 416);
  response.headers.set("accept-ranges", "bytes");
  if (total !== undefined && Number.isSafeInteger(total) && total >= 0) {
    response.headers.set("content-range", `bytes */${total}`);
  }
  return response;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const artifactLease = await acquireArtifactReadLease(id);
  let leaseReleased = false;
  const releaseLease = () => {
    if (leaseReleased) return;
    leaseReleased = true;
    artifactLease.release();
  };
  const refenced = await meetingFenceResponse(id);
  if (refenced) {
    releaseLease();
    return refenced;
  }
  const p = meetingPaths(id);
  const path = existsSync(p.play) ? p.play : existsSync(p.audio) ? p.audio : null;
  if (!path) {
    releaseLease();
    return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
  }

  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    releaseLease();
    return publicErrorResponse("internal_error", 500);
  }
  const total = metadata.size;
  if (!metadata.isFile() || !Number.isSafeInteger(total) || total <= 0) {
    releaseLease();
    return rangeNotSatisfiable(Number.isSafeInteger(total) && total >= 0 ? total : undefined);
  }

  const selected = resolveByteRange(request.headers.get("range"), total);
  if (selected.kind === "unsatisfiable") {
    releaseLease();
    return rangeNotSatisfiable(total);
  }

  try {
    const nodeStream = createReadStream(path, { start: selected.start, end: selected.end });
    const stream = createLeasedWebStream(nodeStream, releaseLease, request.signal);
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": String(selected.length),
      "content-type": "audio/webm",
    });
    if (selected.kind === "partial") {
      headers.set("content-range", `bytes ${selected.start}-${selected.end}/${total}`);
    }
    return new Response(stream, {
      status: selected.kind === "partial" ? 206 : 200,
      headers,
    });
  } catch {
    releaseLease();
    return publicErrorResponse("internal_error", 500);
  }
}
