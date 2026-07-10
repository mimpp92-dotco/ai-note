import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";

import { acquireArtifactReadLease } from "@/lib/artifactLease";
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
  const refenced = await meetingFenceResponse(id);
  if (refenced) {
    artifactLease.release();
    return refenced;
  }
  const p = meetingPaths(id);
  const path = existsSync(p.play) ? p.play : existsSync(p.audio) ? p.audio : null;
  if (!path) {
    artifactLease.release();
    return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
  }

  const nodeStream = createReadStream(path);
  const release = () => { artifactLease.release(); };
  nodeStream.once("close", release);
  nodeStream.once("error", release);
  const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: { "content-type": "audio/webm", "cache-control": "no-store" },
  });
}
