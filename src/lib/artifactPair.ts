import { readFile } from "node:fs/promises";

import { acquireArtifactReadLease } from "@/lib/artifactLease";
import {
  acquireMeetingOperation,
  isExactMeetingOperationActive,
} from "@/lib/meetingLifecycle";
import { meetingPaths } from "@/lib/paths";
import { readStatus } from "@/lib/status";
import { reconcileSummarizeAttempt } from "@/lib/summarizePublisher";

export type ArtifactPairState = "stable" | "active" | "interrupted" | "ambiguous";
export type ArtifactPairReadBarrierPoint = "after_transcript_read" | "after_summary_read";

export interface ArtifactPairReadOptions {
  barrier?: (point: ArtifactPairReadBarrierPoint) => void | Promise<void>;
}

export interface ArtifactPairReadResult {
  transcript: string | null;
  summary: string | null;
  state: ArtifactPairState;
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function ensureSummarizeReconciled(id: string): Promise<ArtifactPairState> {
  const initial = await readStatus(id);
  if (!initial?.summarizeAttempt) return "stable";
  // A live publisher intentionally leaves the old generation readable. Waiting
  // for a minutes-long adapter run would make detail/export appear hung.
  if (isExactMeetingOperationActive(id, "summarize")) return "active";

  const operation = await acquireMeetingOperation(id, "summarize_reconcile");
  try {
    const latest = await readStatus(id);
    if (!latest?.summarizeAttempt) return "stable";
    const result = await reconcileSummarizeAttempt(id, operation.ownerToken);
    if (result.state === "ambiguous") return "ambiguous";
    if (result.state === "interrupted") return "interrupted";
    return "stable";
  } finally {
    operation.release();
  }
}

export async function readArtifactPair(
  id: string,
  options: ArtifactPairReadOptions = {},
): Promise<ArtifactPairReadResult> {
  const state = await ensureSummarizeReconciled(id);
  if (state === "ambiguous") {
    // A contradictory generation is never exposed as a plausible transcript /
    // summary pair. The UI can still offer folder reveal and retry guidance.
    return { transcript: null, summary: null, state };
  }
  const lease = await acquireArtifactReadLease(id);
  try {
    const paths = meetingPaths(id);
    const transcript = await readTextOrNull(paths.transcript);
    await options.barrier?.("after_transcript_read");
    const summary = await readTextOrNull(paths.summary);
    await options.barrier?.("after_summary_read");
    return { transcript, summary, state };
  } finally {
    lease.release();
  }
}
