import { join } from "node:path";

import { assertSafeId } from "@/lib/meetingId";

// Filesystem layout for a meeting: data/meetings/{id}/<artifact>.
// Every helper validates the id first (path-traversal defense). cwd is read lazily
// inside functions so importing this module never touches the filesystem/env.

const FILE_NAMES = {
  status: "status.json",
  audio: "audio.webm",
  play: "play.webm",
  raw: "raw.md",
  transcript: "transcript.md",
  summary: "summary.json",
  segments: "segments.json",
} as const;

export interface MeetingPaths {
  dir: string;
  status: string;
  audio: string;
  play: string;
  raw: string;
  transcript: string;
  summary: string;
  segments: string;
}

export interface FinalizeStagingPaths {
  dir: string;
  intent: string;
  audio: string;
  status: string;
  receipt: string;
}

export function dataRoot(): string {
  return join(process.cwd(), "data");
}

export function libraryPath(root = dataRoot()): string {
  return join(root, "library.json");
}

export function knowledgeRoot(root = dataRoot()): string {
  return join(root, "knowledge");
}

export function corpusMapPath(root = dataRoot()): string {
  return join(knowledgeRoot(root), "corpus-map.json");
}

export function meetingsRoot(): string {
  return join(dataRoot(), "meetings");
}

export function meetingDir(id: string): string {
  return join(meetingsRoot(), assertSafeId(id));
}

export function knowledgeCardPath(id: string, root = dataRoot()): string {
  return join(root, "meetings", assertSafeId(id), "knowledge-card.json");
}

export function meetingPaths(id: string): MeetingPaths {
  const dir = meetingDir(id);
  return {
    dir,
    status: join(dir, FILE_NAMES.status),
    audio: join(dir, FILE_NAMES.audio),
    play: join(dir, FILE_NAMES.play),
    raw: join(dir, FILE_NAMES.raw),
    transcript: join(dir, FILE_NAMES.transcript),
    summary: join(dir, FILE_NAMES.summary),
    segments: join(dir, FILE_NAMES.segments),
  };
}

export function finalizeStagingPaths(id: string): FinalizeStagingPaths {
  const safeId = assertSafeId(id);
  const dir = join(meetingsRoot(), `.finalize-${safeId}`);
  return {
    dir,
    intent: join(dir, ".finalize-intent.json"),
    audio: join(dir, FILE_NAMES.audio),
    status: join(dir, FILE_NAMES.status),
    receipt: join(dir, ".finalize-receipt.json"),
  };
}

export function finalizeReceiptPath(id: string): string {
  return join(meetingDir(id), ".finalize-receipt.json");
}
