import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";

import type { MeetingStatus, StatusJson } from "@/domain/meeting";
import { atomicWriteFile } from "@/lib/atomicWrite";
import { isSafeId } from "@/lib/meetingId";
import { meetingPaths, meetingsRoot } from "@/lib/paths";

// app-api is the primary writer of status.json. These helpers own reading, writing
// (atomic), and — per the contract — deriving transcribed/summarized purely from
// artifact-file existence (whisper/summarizer write those files, not status.json).

const RANK: Record<MeetingStatus, number> = {
  recording: 0,
  recorded: 1,
  transcribing: 2,
  transcribed: 3,
  summarizing: 4,
  summarized: 5,
};

export interface InitialStatusInput {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  audioMime: string;
}

function autoTitle(startedAtIso: string): string {
  const d = new Date(startedAtIso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `회의 ${date} ${time}`;
}

export function initialStatus(id: string, input: InitialStatusInput): StatusJson {
  const p = meetingPaths(id);
  return {
    id,
    title: autoTitle(input.startedAt),
    status: "recorded",
    error: null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    audioMime: input.audioMime,
    whisper: { jobId: null, progress: 0 },
    paths: {
      audio: p.audio,
      play: p.play,
      raw: p.raw,
      transcript: p.transcript,
      summary: p.summary,
      segments: p.segments,
    },
    review: { participants: [] },
    updatedAt: input.endedAt,
  };
}

export async function readStatus(id: string): Promise<StatusJson | null> {
  try {
    const raw = await readFile(meetingPaths(id).status, "utf-8");
    return JSON.parse(raw) as StatusJson;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A corrupt/hand-edited status.json shouldn't 500 the list route or stall the
    // worker — treat it as absent (the meeting is re-derivable from its artifacts).
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function writeStatus(id: string, status: StatusJson): Promise<void> {
  const withStamp: StatusJson = { ...status, updatedAt: new Date().toISOString() };
  await atomicWriteFile(meetingPaths(id).status, JSON.stringify(withStamp, null, 2) + "\n");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

// Fold artifact-file existence into a status view. Monotonic (never steps back):
//   raw.md       → transcribed   (whisper wrote it)
//   summary.json → summarized    (rank), and — unless titleOverride is set —
//                  promote summary.title into status.title.
// titleOverride (app-api owned) wins over summary.title so a manual rename
// survives re-summarize; it gates ONLY the title branch, never the rank
// promotion. Returns whether anything changed so the caller can persist.
export function deriveStatus(id: string, persisted: StatusJson): { status: StatusJson; changed: boolean } {
  const p = meetingPaths(id);
  let s = persisted;
  let rank = RANK[s.status];
  let changed = false;

  if (existsSync(p.raw) && rank < RANK.transcribed) {
    s = { ...s, status: "transcribed", whisper: { ...s.whisper, progress: 1 }, error: null };
    rank = RANK.transcribed;
    changed = true;
  }

  const hasSummary = existsSync(p.summary);

  // Title: a user override wins and applies regardless of summary.json (so the
  // manual title persists even if summary.json is later removed). Without an
  // override, fall back to promoting the summarizer's title.
  if (persisted.titleOverride) {
    if (s.title !== persisted.titleOverride) {
      s = { ...s, title: persisted.titleOverride };
      changed = true;
    }
  } else if (hasSummary) {
    const summary = readJson<{ title?: string }>(p.summary);
    if (summary?.title && summary.title !== s.title) {
      s = { ...s, title: summary.title };
      changed = true;
    }
  }

  // Rank: summary.json existence always promotes to summarized (independent of
  // the title branch above). A re-summarize failure leaves a retry_summary error
  // that must survive this promotion — the GET route persists the derived status,
  // so clearing it here would silently erase the failure banner. Any other stale
  // error is cleared on promotion as before.
  if (hasSummary && rank < RANK.summarized) {
    const keptError = persisted.error?.action === "retry_summary" ? persisted.error : null;
    s = { ...s, status: "summarized", error: keptError };
    rank = RANK.summarized;
    changed = true;
  }

  return { status: s, changed };
}

export async function listMeetingIds(): Promise<string[]> {
  try {
    const entries = await readdir(meetingsRoot(), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => isSafeId(name) && existsSync(meetingPaths(name).status));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
