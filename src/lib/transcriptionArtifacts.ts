import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { meetingPaths } from "@/lib/paths";

const claimFields = {
  meetingId: z.string(),
  dispatchId: z.string().uuid(),
  audioSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  phase: z.enum(["accepted", "segments_published", "raw_published"]),
};
const durabilitySchema = z.enum(["pending", "durable", "best_effort"]);

const claimV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...claimFields,
  durability: durabilitySchema.default("best_effort"),
}).strict();

const catalogModelSnapshotSchema = z.union([
  z.object({
    source: z.literal("catalog"),
    id: z.literal("large-v3"),
    mlxRepo: z.literal("mlx-community/whisper-large-v3-mlx"),
    fasterWhisperModel: z.literal("large-v3"),
  }).strict(),
  z.object({
    source: z.literal("catalog"),
    id: z.literal("large-v3-turbo"),
    mlxRepo: z.literal("mlx-community/whisper-large-v3-turbo"),
    fasterWhisperModel: z.literal("large-v3-turbo"),
  }).strict(),
]);
const legacyModelIdentity = z.string().min(1).max(128).refine(
  (value) => !/[\u0000\r\n]/u.test(value),
);
const legacyRepoIdentity = z.string().min(1).max(512).refine(
  (value) => !/[\u0000\r\n]/u.test(value),
);
const legacyModelSnapshotSchema = z.object({
  source: z.literal("legacy"),
  id: legacyModelIdentity,
  mlxRepo: legacyRepoIdentity,
  fasterWhisperModel: legacyModelIdentity,
}).strict().refine((value) => value.id === value.fasterWhisperModel);

const claimV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...claimFields,
  model: z.union([catalogModelSnapshotSchema, legacyModelSnapshotSchema]),
  durability: durabilitySchema,
}).strict();

const claimSchema = z.union([claimV1Schema, claimV2Schema]);

export type TranscriptionPublication =
  | {
      state: "complete";
      legacy: boolean;
      dispatchId: string | null;
      durability: "durable" | "best_effort";
    }
  | { state: "missing" | "incomplete" | "ambiguous" };

function regularFileState(path: string): "missing" | "regular" | "unsafe" {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() ? "regular" : "unsafe";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "unsafe";
  }
}

function sha256File(path: string): string {
  const digest = createHash("sha256");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function validSegments(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) && value.every((segment) =>
      typeof segment === "object"
      && segment !== null
      && !Array.isArray(segment)
      && typeof (segment as { start?: unknown }).start === "number"
      && typeof (segment as { end?: unknown }).end === "number"
      && typeof (segment as { text?: unknown }).text === "string");
  } catch {
    return false;
  }
}

export function inspectTranscriptionPublication(
  id: string,
  expectedDispatchId?: string | null,
): TranscriptionPublication {
  const paths = meetingPaths(id);
  const claimPath = join(paths.dir, ".whisper-dispatch.json");
  const claimState = regularFileState(claimPath);
  const rawState = regularFileState(paths.raw);

  if (claimState === "unsafe" || rawState === "unsafe") return { state: "ambiguous" };
  if (claimState === "missing") {
    if (rawState === "missing") return { state: "missing" };
    return {
      state: "complete",
      legacy: true,
      dispatchId: null,
      durability: "best_effort",
    };
  }

  let claim: z.infer<typeof claimSchema>;
  try {
    const raw = readFileSync(claimPath, "utf8");
    if (Buffer.byteLength(raw) > 16 * 1024) return { state: "ambiguous" };
    claim = claimSchema.parse(JSON.parse(raw));
  } catch {
    return { state: "ambiguous" };
  }
  if (
    claim.meetingId !== id
    || (expectedDispatchId && claim.dispatchId !== expectedDispatchId)
  ) return { state: "ambiguous" };

  const audioState = regularFileState(paths.audio);
  const segmentsState = regularFileState(paths.segments);
  if (audioState === "unsafe" || segmentsState === "unsafe") return { state: "ambiguous" };
  if (audioState === "missing") return { state: "ambiguous" };
  try {
    if (sha256File(paths.audio) !== claim.audioSha256) return { state: "ambiguous" };
  } catch {
    return { state: "ambiguous" };
  }

  if (
    claim.phase !== "raw_published"
    || claim.durability === "pending"
    || rawState !== "regular"
    || segmentsState !== "regular"
    || !validSegments(paths.segments)
  ) return { state: "incomplete" };
  return {
    state: "complete",
    legacy: false,
    dispatchId: claim.dispatchId,
    durability: claim.durability,
  };
}
