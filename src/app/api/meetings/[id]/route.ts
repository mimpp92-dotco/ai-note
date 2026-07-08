import { existsSync } from "node:fs";

import { NextResponse } from "next/server";

import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths } from "@/lib/paths";
import { deriveStatus, readStatus, writeStatus } from "@/lib/status";
import { fetchWhisperJob } from "@/services/whisperClient";

// GET /api/meetings/[id] — the meeting's status, folding in artifact-file existence
// (transcribed/summarized derived) and, while still transcribing, a live whisper
// job poll for progress/errors. app-api is the writer, so any derived change is
// persisted here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return NextResponse.json({ error: "invalid meeting id" }, { status: 400 });
  }

  const persisted = await readStatus(id);
  if (!persisted) return NextResponse.json({ error: "not found" }, { status: 404 });

  let working = persisted;
  let dirty = false;

  // raw.md existence (checked in deriveStatus) is the authoritative "done" signal;
  // this poll only surfaces progress/errors while we wait. whisper being down is
  // non-fatal — leave the status untouched.
  if (working.status === "transcribing" && working.whisper.jobId && !existsSync(meetingPaths(id).raw)) {
    try {
      const job = await fetchWhisperJob(working.whisper.jobId);
      if (job.status === "error") {
        working = { ...working, error: { message: job.error ?? "전사 실패", action: "retry_transcription" } };
        dirty = true;
      } else if (job.progress !== working.whisper.progress) {
        working = { ...working, whisper: { ...working.whisper, progress: job.progress } };
        dirty = true;
      }
    } catch {
      // whisper unreachable — transient; keep current status.
    }
  }

  const { status, changed } = deriveStatus(id, working);
  if (changed || dirty) await writeStatus(id, status);
  return NextResponse.json(status);
}
