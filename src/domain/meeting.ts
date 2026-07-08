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
  | "retry_summary";

export interface StatusError {
  message: string;
  action: ErrorAction;
}

export interface WhisperState {
  jobId: string | null;
  progress: number;
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

export interface StatusJson {
  id: string;
  title: string;
  status: MeetingStatus;
  error: StatusError | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  audioMime: string;
  whisper: WhisperState;
  paths: StatusPaths;
  review: ReviewInput;
  // Number of failed summarize attempts — the background worker uses this to
  // back off instead of re-spawning a subprocess every poll. Reset by a manual retry.
  summarizeAttempts?: number;
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
