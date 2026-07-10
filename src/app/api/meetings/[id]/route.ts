import { existsSync } from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { acquireArtifactWriteLease } from "@/lib/artifactLease";
import { syncNamespaces } from "@/lib/durableFileOps";
import { readResolvedLibraryState } from "@/lib/libraryService";
import { guardLocalApiRequest } from "@/lib/localRequestGuard";
import { meetingFenceResponse } from "@/lib/meetingFence";
import { markMeetingCleanupPending } from "@/lib/meetingCleanup";
import { tryAcquireMeetingOperation } from "@/lib/meetingLifecycle";
import { assertSafeId } from "@/lib/meetingId";
import {
  getMeetingTombstoneStore,
  MeetingTombstoneError,
} from "@/lib/meetingTombstone";
import { meetingPaths, meetingsRoot } from "@/lib/paths";
import {
  jsonNoStore,
  publicErrorResponse,
  safeLog,
  toPublicMeeting,
} from "@/lib/publicApi";
import { deriveStatus, readStatus, updateStatus } from "@/lib/status";
import { invalidateSummaryWork } from "@/lib/summaryWorkCache";
import { fetchWhisperJob } from "@/services/whisperClient";

// GET /api/meetings/[id] — the meeting's status, folding in artifact-file existence
// (transcribed/summarized derived) and, while still transcribing, a live whisper
// job poll for progress/errors. app-api is the writer, so any derived change is
// persisted here.
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

  const persisted = await readStatus(id);
  if (!persisted) return publicErrorResponse("meeting_not_found", 404, { meetingId: id });

  let working = persisted;
  let dirty = false;

  // raw.md existence (checked in deriveStatus) is the authoritative "done" signal;
  // this poll only surfaces progress/errors while we wait. whisper being down is
  // non-fatal — leave the status untouched.
  const dispatchId = working.transcriptionDispatch?.dispatchId ?? working.whisper.jobId;
  if (working.status === "transcribing" && dispatchId) {
    try {
      const job = await fetchWhisperJob(id, dispatchId);
      if (job.status === "error" && job.error !== "durability_pending") {
        working = {
          ...working,
          transcriptionDispatch: working.transcriptionDispatch?.dispatchId === dispatchId
            ? { ...working.transcriptionDispatch, state: "failed" }
            : working.transcriptionDispatch,
          error: {
            code: "transcription_failed",
            message: "전사를 완료하지 못했습니다. 로컬 전사 서비스를 확인해 주세요",
            action: "retry_transcription",
          },
        };
        dirty = true;
      } else if (job.status === "done") {
        working = { ...working, whisper: { ...working.whisper, progress: 1 } };
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
  const current = changed || dirty
    ? (await updateStatus(id, undefined, (latest) => {
        let next = latest;
        if (
          dirty
          && latest.status === "transcribing"
          && latest.whisper.jobId === persisted.whisper.jobId
        ) {
          next = {
            ...latest,
            error: working.error,
            transcriptionDispatch: latest.transcriptionDispatch?.dispatchId === dispatchId
              ? working.transcriptionDispatch
              : latest.transcriptionDispatch,
            whisper: { ...latest.whisper, progress: working.whisper.progress },
          };
        }
        return deriveStatus(id, next).status;
      })).status
    : status;
  return jsonNoStore(toPublicMeeting(current));
}

// DELETE /api/meetings/[id] — permanently remove the whole meeting folder. Refused
// while a summarize holds the lock (it would re-create status.json under us).
// Deletion is rename-then-rm: the folder is first renamed to a "."-prefixed trash
// name (isSafeId rejects leading dots → listMeetingIds excludes it) so a slow or
// partial rm never leaves a half-deleted meeting visible in the list.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = guardLocalApiRequest(request);
  if (denied) return denied;
  let id: string;
  try {
    id = assertSafeId((await params).id);
  } catch {
    return publicErrorResponse("invalid_request", 400, { field: "meetingId" });
  }
  const preexistingTombstone = await getMeetingTombstoneStore().inspect(id);
  if (preexistingTombstone.state === "ambiguous") {
    return publicErrorResponse("delete_state_ambiguous", 409, { meetingId: id, action: "reveal" });
  }
  const lease = await tryAcquireMeetingOperation(id, "delete");
  if (!lease) {
    if (preexistingTombstone.state === "deleted") {
      return jsonNoStore({
        ok: true,
        deleted: true,
        durability: "pending",
        cleanup: "pending",
      });
    }
    return publicErrorResponse("meeting_conflict", 409, { meetingId: id, action: "delete" });
  }
  try {
    const artifactLease = await acquireArtifactWriteLease(id, lease.ownerToken);
    try {
      const dir = meetingPaths(id).dir;
      const tombstones = getMeetingTombstoneStore();
      const before = await tombstones.inspect(id);
      if (before.state === "ambiguous") {
        return publicErrorResponse("delete_state_ambiguous", 409, { meetingId: id, action: "reveal" });
      }
      if (before.state === "none" && !existsSync(dir)) {
        return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
      }
      if (before.state === "none") {
        try {
          const info = await lstat(dir);
          if (!info.isDirectory() || info.isSymbolicLink()) {
            return publicErrorResponse("delete_state_ambiguous", 409, { meetingId: id, action: "reveal" });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return publicErrorResponse("meeting_not_found", 404, { meetingId: id });
          }
          return publicErrorResponse("delete_state_ambiguous", 409, { meetingId: id, action: "reveal" });
        }
      }

      let tombstone;
      try {
        tombstone = await tombstones.create(id);
      } catch (error) {
        if (error instanceof MeetingTombstoneError && error.code === "delete_state_ambiguous") {
          return publicErrorResponse("delete_state_ambiguous", 409, { meetingId: id, action: "reveal" });
        }
        return publicErrorResponse("internal_error", 503);
      }
      invalidateSummaryWork();

      let cleanup: "complete" | "pending" = "complete";
      try {
        const library = await readResolvedLibraryState();
        if (library.mode === "ready") {
          await library.repository.transactLatest((document) => ({
            ...document,
            placements: document.placements.filter((placement) => placement.meetingId !== id),
          }));
        }
      } catch {
        cleanup = "pending";
      }

      const trash = join(meetingsRoot(), `.trash-${id}`);
      if (existsSync(dir)) {
        try {
          if (existsSync(trash)) {
            const trashInfo = await lstat(trash);
            if (!trashInfo.isDirectory() || trashInfo.isSymbolicLink()) {
              cleanup = "pending";
            } else {
              await rm(trash, { recursive: true, force: true });
            }
          }
          if (!existsSync(trash)) await rename(dir, trash);
          if ((await syncNamespaces([meetingsRoot()])).durability === "pending") cleanup = "pending";
        } catch {
          cleanup = "pending";
        }
      }
      if (existsSync(trash)) {
        try {
          const trashInfo = await lstat(trash);
          if (!trashInfo.isDirectory() || trashInfo.isSymbolicLink()) {
            cleanup = "pending";
          } else {
            await rm(trash, { recursive: true, force: true });
            if ((await syncNamespaces([meetingsRoot()])).durability === "pending") {
              cleanup = "pending";
            }
          }
        } catch {
          cleanup = "pending";
          safeLog("warn", { code: "meeting_cleanup_failed", operation: "delete", meetingId: id });
        }
      }
      if (cleanup === "pending") markMeetingCleanupPending();
      return jsonNoStore({
        ok: true,
        deleted: true,
        durability: tombstone.durability,
        cleanup,
      });
    } finally {
      artifactLease.release();
    }
  } finally {
    lease.release();
  }
}
