import { NextResponse } from "next/server";

import { atomicWriteStream } from "@/lib/atomicStream";
import { remuxToPlay } from "@/lib/ffmpeg";
import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import { enqueueTranscription } from "@/lib/transcribe";

// POST /api/meetings/[id]/finalize — the first server-side write of a meeting.
// Body is the raw audio (binary stream, never base64 JSON). Metadata rides on the
// query string. Saves audio.webm (atomic stream) → remuxes play.webm → status
// `recorded` → auto-delegates transcription (PRD: 자동 전사 on stop).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return NextResponse.json({ error: "invalid meeting id" }, { status: 400 });
  }

  // audio.webm is immutable — refuse to overwrite an already-finalized meeting.
  if (await readStatus(id)) {
    return NextResponse.json({ error: "meeting already finalized" }, { status: 409 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "missing audio body" }, { status: 400 });
  }

  const url = new URL(request.url);
  const durationMs = Number.parseInt(url.searchParams.get("durationMs") ?? "0", 10) || 0;
  const audioMime =
    url.searchParams.get("mime") ?? request.headers.get("content-type") ?? "audio/webm;codecs=opus";
  const endedAt = new Date().toISOString();
  const startedAt =
    url.searchParams.get("startedAt") ?? new Date(Date.now() - durationMs).toISOString();

  const p = meetingPaths(id);
  await atomicWriteStream(p.audio, request.body);
  await remuxToPlay(p.audio, p.play);
  await writeStatus(id, initialStatus(id, { startedAt, endedAt, durationMs, audioMime }));

  // whisper being down is not fatal — audio is safe. Leave `recorded` + a retryable
  // error so the client can retry via POST /api/transcribe.
  let whisperError: string | null = null;
  try {
    await enqueueTranscription(id);
  } catch (err) {
    whisperError = err instanceof Error ? err.message : String(err);
    const status = await readStatus(id);
    if (status) {
      await writeStatus(id, {
        ...status,
        error: { message: whisperError, action: "retry_transcription" },
      });
    }
  }

  const status = await readStatus(id);
  return NextResponse.json(
    { id, status: status?.status, transcription: whisperError ? "failed" : "enqueued" },
    { status: 200 },
  );
}
