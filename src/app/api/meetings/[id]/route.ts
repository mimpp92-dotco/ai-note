import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { assertSafeId } from "@/lib/meetingId";
import { meetingPaths, meetingsRoot } from "@/lib/paths";
import { deriveStatus, readStatus, writeStatus } from "@/lib/status";
import { isSummarizeInflight } from "@/lib/summarize";
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

// DELETE /api/meetings/[id] — permanently remove the whole meeting folder. Refused
// while a summarize holds the lock (it would re-create status.json under us).
// Deletion is rename-then-rm: the folder is first renamed to a "."-prefixed trash
// name (isSafeId rejects leading dots → listMeetingIds excludes it) so a slow or
// partial rm never leaves a half-deleted meeting visible in the list.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return NextResponse.json({ error: "invalid meeting id" }, { status: 400 });
  }

  const dir = meetingPaths(id).dir;
  if (!existsSync(dir)) {
    // Idempotent: already gone. The UI treats 404 as "already deleted".
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (isSummarizeInflight(id)) {
    return NextResponse.json({ error: "summarize in progress" }, { status: 409 });
  }

  const trash = join(meetingsRoot(), `.trash-${id}-${Date.now()}`);
  try {
    await rename(dir, trash);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }
  // Best-effort teardown; the trash name is already invisible to the list, so a
  // failed rm degrades to a hidden orphan rather than a resurrected meeting.
  await rm(trash, { recursive: true, force: true }).catch((err) => {
    console.error(`[delete] failed to remove ${trash}:`, err);
  });
  return NextResponse.json({ ok: true });
}
