import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";

import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";

// GET /api/meetings/[id]/audio — streams the meeting's remuxed audio for the detail
// player. data/ lives outside public/, so the browser cannot reach it without this
// route. Prefers play.webm (seekable remux), falls back to the original audio.webm.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return new Response("invalid meeting id", { status: 400 });
  }

  const p = meetingPaths(id);
  const path = existsSync(p.play) ? p.play : existsSync(p.audio) ? p.audio : null;
  if (!path) return new Response("not found", { status: 404 });

  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: { "content-type": "audio/webm", "cache-control": "no-store" },
  });
}
