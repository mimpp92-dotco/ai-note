import { existsSync } from "node:fs";

import { meetingPaths } from "@/lib/paths";
import { readSettings } from "@/lib/settings";
import { listMeetingIds, readStatus } from "@/lib/status";
import { MAX_SUMMARIZE_ATTEMPTS, runSummarize } from "@/lib/summarize";

// Background poller that summarizes transcribed meetings once an LLM is configured.
// The app has no queue/DB — candidacy is derived purely from files on disk plus the
// attempt counter, so a crash mid-summarize (leftover `summarizing`, no summary.json)
// is simply retried.

// A meeting is a candidate when it has been transcribed (raw.md), not yet summarized
// (no summary.json), and hasn't exhausted its retries. No LLM configured ⇒ nothing to do.
export async function findSummarizeCandidates(): Promise<string[]> {
  if ((await readSettings()) === null) return [];

  const candidates: string[] = [];
  for (const id of await listMeetingIds()) {
    const p = meetingPaths(id);
    if (!existsSync(p.raw) || existsSync(p.summary)) continue;
    let status;
    try {
      status = await readStatus(id);
    } catch {
      continue; // corrupt status.json — skip this one, don't stall the whole worker
    }
    if (!status) continue;
    if ((status.summarizeAttempts ?? 0) >= MAX_SUMMARIZE_ATTEMPTS) continue;
    candidates.push(id);
  }
  return candidates;
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
