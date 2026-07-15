import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ContentRevision,
  SummarizeAttemptKind,
} from "@/domain/meeting";

import { acquireArtifactReadLease } from "@/lib/artifactLease";
import {
  acquireMeetingOperation,
  isExactMeetingOperationActive,
  type MeetingOperation,
} from "@/lib/meetingLifecycle";
import { meetingPaths } from "@/lib/paths";
import { readStatus } from "@/lib/status";
import { reconcileSummarizeAttempt } from "@/lib/summarizePublisher";

export type ArtifactPairState =
  | "stable"
  | "active"
  | "interrupted"
  | "ambiguous"
  | "missing"
  | "source_conflict";
export type ArtifactPairReadBarrierPoint = "after_transcript_read" | "after_summary_read";

export interface ArtifactPairReadOptions {
  barrier?: (point: ArtifactPairReadBarrierPoint) => void | Promise<void>;
}

export interface ArtifactPairReadResult {
  transcript: string | null;
  summary: string | null;
  state: ArtifactPairState;
  // Optional at the type boundary while legacy injected readers are migrated;
  // this implementation always emits all three fields on every branch.
  revision?: ArtifactPairRevision | null;
  contentRevision?: ContentRevision | null;
  summaryOutdated?: boolean | null;
}

export interface ArtifactPairRevision {
  transcriptSha256: string;
  summarySha256: string;
}

async function readBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function operationForAttempt(kind: SummarizeAttemptKind): MeetingOperation {
  if (kind === "manual_edit") return "manual_edit";
  if (kind === "transcript_regenerate") return "transcript_regenerate";
  if (kind === "summary_regenerate") return "summary_regenerate";
  return "summarize";
}

function isLiveContentMutationActive(id: string): boolean {
  return ([
    "summarize",
    "manual_edit",
    "transcript_regenerate",
    "summary_regenerate",
  ] as const).some((operation) => isExactMeetingOperationActive(id, operation));
}

export async function ensureSummarizeReconciled(id: string): Promise<ArtifactPairState> {
  const initial = await readStatus(id);
  if (!initial?.summarizeAttempt) return "stable";
  // A live publisher intentionally leaves the old generation readable. Waiting
  // for a minutes-long adapter run would make detail/export appear hung.
  if (
    isExactMeetingOperationActive(
      id,
      operationForAttempt(initial.summarizeAttempt.kind),
    )
    // A caller may already own a different content mutation operation while
    // discovering a durable orphan. Never queue reconcile behind that caller;
    // report active so it can release and let a later probe reconcile.
    || isLiveContentMutationActive(id)
  ) return "active";

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
    return {
      transcript: null,
      summary: null,
      state,
      revision: null,
      contentRevision: null,
      summaryOutdated: null,
    };
  }
  const lease = await acquireArtifactReadLease(id);
  try {
    const paths = meetingPaths(id);
    const transcriptBytes = await readBytesOrNull(paths.transcript);
    await options.barrier?.("after_transcript_read");
    const summaryBytes = await readBytesOrNull(paths.summary);
    await options.barrier?.("after_summary_read");
    if (transcriptBytes === null && summaryBytes === null) {
      return {
        transcript: null,
        summary: null,
        state: "missing",
        revision: null,
        contentRevision: null,
        summaryOutdated: null,
      };
    }
    if (transcriptBytes === null || summaryBytes === null) {
      return {
        transcript: null,
        summary: null,
        state: "ambiguous",
        revision: null,
        contentRevision: null,
        summaryOutdated: null,
      };
    }

    const revision = {
      transcriptSha256: sha256(transcriptBytes),
      summarySha256: sha256(summaryBytes),
    };
    let transcript: string;
    let summary: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      transcript = decoder.decode(transcriptBytes);
      summary = decoder.decode(summaryBytes);
    } catch {
      return {
        transcript: null,
        summary: null,
        state: "ambiguous",
        revision,
        contentRevision: null,
        summaryOutdated: null,
      };
    }

    const status = await readStatus(id);
    if (!status) {
      return {
        transcript: null,
        summary: null,
        state: "ambiguous",
        revision,
        contentRevision: null,
        summaryOutdated: null,
      };
    }
    const contentRevision: ContentRevision = status.contentRevision ?? {
      transcript: {
        source: "generated",
        sha256: revision.transcriptSha256,
        updatedAt: status.updatedAt,
      },
      summary: {
        source: "generated",
        sha256: revision.summarySha256,
        basedOnTranscriptSha256: revision.transcriptSha256,
        updatedAt: status.updatedAt,
      },
    };
    if (
      state !== "active"
      && (
        contentRevision.transcript.sha256 !== revision.transcriptSha256
        || contentRevision.summary.sha256 !== revision.summarySha256
      )
    ) {
      return {
        transcript: null,
        summary: null,
        state: "source_conflict",
        revision,
        contentRevision: null,
        summaryOutdated: null,
      };
    }
    return {
      transcript,
      summary,
      state,
      revision,
      contentRevision,
      summaryOutdated:
        contentRevision.summary.basedOnTranscriptSha256
        !== contentRevision.transcript.sha256,
    };
  } finally {
    lease.release();
  }
}
