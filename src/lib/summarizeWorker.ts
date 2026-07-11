import { lstat } from "node:fs/promises";

import { classifyMeetingRecord } from "@/domain/library";
import { ensureSummarizeReconciled } from "@/lib/artifactPair";
import { scanMeetingRecordObservations } from "@/lib/library";
import { dataRoot, meetingPaths } from "@/lib/paths";
import { readSettings } from "@/lib/settings";
import { MAX_SUMMARIZE_ATTEMPTS, runSummarize } from "@/lib/summarize";
import { inspectTranscriptionPublication } from "@/lib/transcriptionArtifacts";

// Background poller that summarizes transcribed meetings once an LLM is configured.
// The app has no queue/DB — candidacy is derived purely from files on disk plus the
// attempt counter, so a crash mid-summarize (leftover `summarizing`, no summary.json)
// is simply retried.

// A meeting is a candidate when it has been transcribed (raw.md), not yet summarized
// (no summary.json), and hasn't exhausted its retries. No LLM configured ⇒ nothing to do.
export async function findSummarizeCandidates(): Promise<string[]> {
  if ((await readSettings()) === null) return [];

  const candidates: Array<{ id: string; startedAt: string }> = [];
  const records = (await scanMeetingRecordObservations(dataRoot()))
    .map((observation) => classifyMeetingRecord({ ...observation, hasPlacement: false }));
  for (const record of records) {
    if (record.kind !== "live" || record.meetingId === null || record.status === null) continue;
    const id = record.meetingId;
    const p = meetingPaths(id);
    const status = record.status;
    if (
      inspectTranscriptionPublication(id, status.transcriptionDispatch?.dispatchId).state
      !== "complete"
    ) continue;
    if (status.summarizeAttempt) {
      await ensureSummarizeReconciled(id).catch(() => "ambiguous" as const);
      // The reconciliation may have changed status and artifacts. Re-enter via
      // a fresh classified scan on the next tick instead of following a status
      // path that could have been swapped after this no-follow observation.
      continue;
    }
    try {
      const summary = await lstat(p.summary);
      if (summary.isSymbolicLink() || !summary.isFile()) continue;
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    // A durable interruption is user-visible attention, not an invitation for
    // the poller to immediately hide the error behind another automatic retry.
    if (
      status.error?.code === "summary_interrupted"
      || status.error?.code === "summarize_ambiguous"
    ) continue;
    if ((status.summarizeAttempts ?? 0) >= MAX_SUMMARIZE_ATTEMPTS) continue;
    candidates.push({ id, startedAt: status.startedAt });
  }
  return candidates
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id, "en"))
    .map((candidate) => candidate.id);
}

export async function resolveLatestSummarizable(): Promise<string | null> {
  return (await findSummarizeCandidates())[0] ?? null;
}

// Guards against overlapping ticks when a summarize outlasts the interval.
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const id of await findSummarizeCandidates()) {
      await runSummarize(id);
    }
  } catch {
    // Never let a poll error escape the interval and kill the timer.
  } finally {
    running = false;
  }
}

export function startSummarizeWorker(): void {
  const g = globalThis as typeof globalThis & { __aiNoteWorkerStarted?: boolean };
  if (g.__aiNoteWorkerStarted) return;
  g.__aiNoteWorkerStarted = true;

  const timer = setInterval(tick, 5000);
  timer.unref?.(); // don't hold the process open for the sake of the poller
}
