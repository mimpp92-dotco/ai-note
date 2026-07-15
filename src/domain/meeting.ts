// Meeting lifecycle contract (정본: docs/ARCHITECTURE.md — status.json).
// app-api owns status.json. `transcribed`/`summarized` are derived from
// raw.md / summary.json existence; `summarizing` is a transient state the
// summarizer sets while the LLM runs (no artifact of its own).

export type MeetingStatus =
  | "recording"
  | "recorded"
  | "transcribing"
  | "transcribed"
  | "summarizing"
  | "summarized";

export const MEETING_STATUSES: readonly MeetingStatus[] = [
  "recording",
  "recorded",
  "transcribing",
  "transcribed",
  "summarizing",
  "summarized",
] as const;

// Recovery action carried by status.error, so the UI can offer the right retry.
export type ErrorAction =
  | "retry_transcription"
  | "retry_transcript_generation"
  | "retry_summary";

export interface StatusError {
  code?: string;
  message: string;
  action: ErrorAction;
}

export interface WhisperState {
  jobId: string | null;
  progress: number;
}

export type TranscriptionDispatchState =
  | "proposed"
  | "accepted"
  | "sent"
  | "completed"
  | "failed";

export interface TranscriptionDispatch {
  dispatchId: string;
  createdAt: string;
  state: TranscriptionDispatchState;
}

// status.json `paths` sub-object — the six artifact paths in the contract
// (status.json itself is not listed here; it is the writer).
export interface StatusPaths {
  audio: string;
  play: string;
  raw: string;
  transcript: string;
  summary: string;
  segments: string;
}

// User-supplied review input. Authoritative source of attendees — the
// summarizer never records names it overheard.
export interface ReviewInput {
  participants: string[];
}

export type ContentSource = "generated" | "manual";

export interface ContentRevision {
  transcript: {
    source: ContentSource;
    sha256: string;
    updatedAt: string;
  };
  summary: {
    source: ContentSource;
    sha256: string;
    basedOnTranscriptSha256: string;
    updatedAt: string;
  };
}

export type SummarizeAttemptKind =
  | "initial"
  | "resummarize"
  | "manual_edit"
  | "transcript_regenerate"
  | "summary_regenerate";

interface SummarizeAttemptBase {
  attemptId: string;
  startedAt: string;
  preTranscriptHash?: string;
  preSummaryHash?: string;
}

// Durable acceptance receipt used to recover a content publication after
// process exit. Legacy kinds may omit revision metadata; new kinds cannot.
export type SummarizeAttempt =
  | (SummarizeAttemptBase & {
      kind: "initial" | "resummarize";
      intendedContentRevision?: ContentRevision;
    })
  | (SummarizeAttemptBase & {
      kind: "manual_edit" | "transcript_regenerate" | "summary_regenerate";
      intendedContentRevision: ContentRevision;
    });

export interface StatusJson {
  id: string;
  title: string;
  // User-edited display title. When set, deriveStatus uses it as the title and
  // skips promoting summary.title, so a manual rename survives re-summarize and
  // every re-derive. Owned by app-api (single writer); absent on legacy files.
  titleOverride?: string;
  status: MeetingStatus;
  error: StatusError | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  audioMime: string;
  whisper: WhisperState;
  transcriptionDispatch?: TranscriptionDispatch;
  placementResolution?: {
    state: "pending" | "resolved" | "unavailable";
    receiptHash: string;
    resolvedBy?: "rebuild";
    resolvedLibraryId?: string;
  };
  paths: StatusPaths;
  review: ReviewInput;
  // Number of failed summarize attempts — the background worker uses this to
  // back off instead of re-spawning a subprocess every poll. Reset by a manual retry.
  summarizeAttempts?: number;
  summarizeAttempt?: SummarizeAttempt;
  contentRevision?: ContentRevision;
  updatedAt: string;
}

// Legal forward lifecycle. Retries re-enter a prior processing state, so
// re-transcription (transcribed → transcribing) and a failed summarize
// (summarizing → transcribed) are the non-forward edges. `summarized` is
// file-derived and its re-generation is idempotent.
const ALLOWED_TRANSITIONS: Record<MeetingStatus, readonly MeetingStatus[]> = {
  recording: ["recorded"],
  recorded: ["transcribing"],
  transcribing: ["transcribed"],
  transcribed: ["transcribing", "summarizing"],
  summarizing: ["summarized", "transcribed"],
  summarized: [],
};

export function canTransition(from: MeetingStatus, to: MeetingStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: MeetingStatus, to: MeetingStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal meeting status transition: ${from} → ${to}`);
  }
}
