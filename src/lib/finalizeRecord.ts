import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type Dirent } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { z } from "zod";

import { parseStatusJson } from "@/domain/library";
import type { StatusJson } from "@/domain/meeting";
import { acquireArtifactWriteLease } from "@/lib/artifactLease";
import {
  createDirectorySyncCapability,
  durableAtomicReplace,
  durableUnlink,
  syncNamespaces,
  type DirectorySyncCapability,
  type DurableCommitDurability,
} from "@/lib/durableFileOps";
import { assertMeetingOperationOwner } from "@/lib/meetingLifecycle";
import { isSafeId } from "@/lib/meetingId";
import { inspectMeetingTombstone } from "@/lib/meetingTombstone";
import {
  dataRoot,
  finalizeReceiptPath,
  finalizeStagingPaths,
  meetingPaths,
  meetingsRoot,
} from "@/lib/paths";
import { initialStatus } from "@/lib/status";

const locationSchema = z.object({
  workspaceId: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
}).strict();

const intentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  acceptedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().nonnegative().safe(),
  mimeType: z.enum(["audio/webm", "audio/webm;codecs=opus", "audio/mp4"]),
  requestedLocation: locationSchema.nullable(),
  locationSource: z.enum(["explicit", "legacy_default", "unavailable"]),
}).strict();

const receiptSchema = intentSchema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(1),
  audioSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type FinalizeLocation = z.infer<typeof locationSchema>;
export type FinalizeIntent = z.infer<typeof intentSchema>;
export type FinalizeReceipt = z.infer<typeof receiptSchema>;

export interface FinalizeMetadata {
  startedAt: string;
  durationMs: number;
  mimeType: FinalizeIntent["mimeType"];
}

export class FinalizeRecordError extends Error {
  readonly code:
    | "finalize_conflict"
    | "finalize_state_ambiguous"
    | "finalize_durability_pending"
    | "finalize_write_failed"
    | "meeting_deleted";

  constructor(code: FinalizeRecordError["code"]) {
    super(code);
    this.name = "FinalizeRecordError";
    this.code = code;
  }
}

export type PreparedFinalize =
  | {
      kind: "already_published";
      id: string;
      receipt: FinalizeReceipt | null;
      durability: "durable" | "best_effort" | "pending";
    }
  | {
      kind: "staged";
      id: string;
      intent: FinalizeIntent;
      needsBody: boolean;
      durability: "durable" | "best_effort";
    };

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function safeDirectory(path: string): Promise<"missing" | "safe" | "unsafe"> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() ? "safe" : "unsafe";
  } catch (error) {
    return errno(error) === "ENOENT" ? "missing" : "unsafe";
  }
}

async function safeFile(path: string): Promise<"missing" | "safe" | "unsafe"> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() ? "safe" : "unsafe";
  } catch (error) {
    return errno(error) === "ENOENT" ? "missing" : "unsafe";
  }
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  const state = await safeFile(path);
  if (state === "missing") return null;
  if (state === "unsafe") throw new FinalizeRecordError("finalize_state_ambiguous");
  try {
    const bytes = await readFile(path, "utf8");
    if (Buffer.byteLength(bytes) > 32 * 1024) throw new Error("too_large");
    return schema.parse(JSON.parse(bytes));
  } catch {
    throw new FinalizeRecordError("finalize_state_ambiguous");
  }
}

async function createIntentExclusive(
  path: string,
  intent: FinalizeIntent,
  capability: DirectorySyncCapability,
): Promise<"created" | "exists"> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (errno(error) === "EEXIST") return "exists";
    throw new FinalizeRecordError("finalize_write_failed");
  }
  try {
    await handle.writeFile(serialize(intent));
    await handle.sync();
  } catch {
    await handle.close().catch(() => {});
    handle = null;
    await rm(path, { force: true }).catch(() => {});
    await syncNamespaces([dirname(path)], { capability }).catch(() => {});
    throw new FinalizeRecordError("finalize_write_failed");
  } finally {
    await handle?.close().catch(() => {});
  }
  acceptedDurability((await syncNamespaces([dirname(path)], { capability })).durability);
  return "created";
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function finalizeReceiptHash(receipt: FinalizeReceipt): string {
  return sha256(serialize(receiptSchema.parse(receipt)));
}

function acceptedDurability(
  durability: DurableCommitDurability | "durable" | "best_effort" | "pending",
): "durable" | "best_effort" {
  if (durability === "durable" || durability === "best_effort") return durability;
  if (durability === "pending") throw new FinalizeRecordError("finalize_durability_pending");
  throw new FinalizeRecordError("finalize_write_failed");
}

function mergeDurability(
  left: "durable" | "best_effort",
  right: "durable" | "best_effort",
): "durable" | "best_effort" {
  return left === "best_effort" || right === "best_effort" ? "best_effort" : "durable";
}

function requestMatches(
  intent: FinalizeIntent,
  metadata: FinalizeMetadata,
  requestedLocation: FinalizeLocation | undefined,
): boolean {
  if (
    intent.startedAt !== metadata.startedAt
    || intent.durationMs !== metadata.durationMs
    || intent.mimeType !== metadata.mimeType
  ) return false;
  if (requestedLocation === undefined) return intent.locationSource !== "explicit";
  return intent.locationSource === "explicit"
    && JSON.stringify(intent.requestedLocation) === JSON.stringify(requestedLocation);
}

function intentFromReceipt(receipt: FinalizeReceipt): FinalizeIntent {
  return intentSchema.parse({
    schemaVersion: receipt.schemaVersion,
    id: receipt.id,
    startedAt: receipt.startedAt,
    endedAt: receipt.endedAt,
    acceptedAt: receipt.acceptedAt,
    durationMs: receipt.durationMs,
    mimeType: receipt.mimeType,
    requestedLocation: receipt.requestedLocation,
    locationSource: receipt.locationSource,
  });
}

async function resolveLocationSnapshot(
  requestedLocation: FinalizeLocation | undefined,
): Promise<Pick<FinalizeIntent, "requestedLocation" | "locationSource">> {
  if (requestedLocation !== undefined) {
    return { requestedLocation: locationSchema.parse(requestedLocation), locationSource: "explicit" };
  }
  // Dynamic import avoids coupling the low-level staging parser to library
  // initialization at module load/build time.
  const { readResolvedLibraryState } = await import("@/lib/libraryService");
  const state = await readResolvedLibraryState();
  if (state.mode === "ready" && state.document) {
    return {
      requestedLocation: { workspaceId: state.document.defaultWorkspaceId, folderId: null },
      locationSource: "legacy_default",
    };
  }
  return { requestedLocation: null, locationSource: "unavailable" };
}

export async function prepareFinalizeRecord(input: {
  id: string;
  metadata: FinalizeMetadata;
  requestedLocation?: FinalizeLocation;
  ownerToken: string;
  now?: () => string;
}): Promise<PreparedFinalize> {
  assertMeetingOperationOwner(input.id, input.ownerToken);
  const fence = await inspectMeetingTombstone(input.id);
  if (fence.state !== "none") throw new FinalizeRecordError("meeting_deleted");

  const finalState = await safeDirectory(meetingPaths(input.id).dir);
  if (finalState === "unsafe") throw new FinalizeRecordError("finalize_state_ambiguous");
  if (finalState === "safe") {
    const capability = createDirectorySyncCapability();
    const namespace = await syncNamespaces([meetingsRoot()], { capability });
    return {
      kind: "already_published",
      id: input.id,
      receipt: await readJson(finalizeReceiptPath(input.id), receiptSchema),
      durability: namespace.durability,
    };
  }

  await mkdir(meetingsRoot(), { recursive: true, mode: 0o700 });
  const staging = finalizeStagingPaths(input.id);
  const stagingState = await safeDirectory(staging.dir);
  if (stagingState === "unsafe") throw new FinalizeRecordError("finalize_state_ambiguous");
  if (stagingState === "missing") {
    try {
      await mkdir(staging.dir, { mode: 0o700 });
    } catch (error) {
      if (errno(error) !== "EEXIST" || await safeDirectory(staging.dir) !== "safe") {
        throw new FinalizeRecordError("finalize_state_ambiguous");
      }
    }
    acceptedDurability((await syncNamespaces([meetingsRoot()])).durability);
  }

  const existingIntent = await readJson(staging.intent, intentSchema);
  const existingReceipt = await readJson(staging.receipt, receiptSchema);
  if (existingIntent && existingReceipt) {
    const receiptIntent = intentFromReceipt(existingReceipt);
    if (JSON.stringify(existingIntent) !== JSON.stringify(receiptIntent)) {
      throw new FinalizeRecordError("finalize_state_ambiguous");
    }
  }
  let intent = existingIntent ?? (existingReceipt ? intentFromReceipt(existingReceipt) : null);
  let durability: "durable" | "best_effort" = "durable";
  if (intent) {
    if (!requestMatches(intent, input.metadata, input.requestedLocation)) {
      throw new FinalizeRecordError("finalize_conflict");
    }
  } else {
    if (
      await safeFile(staging.audio) !== "missing"
      || await safeFile(staging.status) !== "missing"
    ) {
      throw new FinalizeRecordError("finalize_state_ambiguous");
    }
    const location = await resolveLocationSnapshot(input.requestedLocation);
    const acceptedAt = (input.now ?? (() => new Date().toISOString()))();
    intent = intentSchema.parse({
      schemaVersion: 1,
      id: input.id,
      startedAt: input.metadata.startedAt,
      endedAt: acceptedAt,
      acceptedAt,
      durationMs: input.metadata.durationMs,
      mimeType: input.metadata.mimeType,
      ...location,
    });
    const capability = createDirectorySyncCapability();
    const creation = await createIntentExclusive(staging.intent, intent, capability);
    if (creation === "exists") {
      const winner = await readJson(staging.intent, intentSchema);
      if (!winner || !requestMatches(winner, input.metadata, input.requestedLocation)) {
        throw new FinalizeRecordError("finalize_conflict");
      }
      intent = winner;
    } else {
      durability = capability.state === "unsupported" ? "best_effort" : "durable";
    }
  }

  durability = mergeDurability(
    durability,
    acceptedDurability((await syncNamespaces([staging.dir])).durability),
  );

  const audioState = await safeFile(staging.audio);
  if (audioState === "unsafe") throw new FinalizeRecordError("finalize_state_ambiguous");
  if (existingReceipt && audioState !== "safe") {
    throw new FinalizeRecordError("finalize_state_ambiguous");
  }
  if (audioState === "safe") {
    durability = mergeDurability(
      durability,
      acceptedDurability((await syncNamespaces([staging.dir])).durability),
    );
  }
  return {
    kind: "staged",
    id: input.id,
    intent,
    needsBody: audioState === "missing",
    durability,
  };
}

async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function writeAudioStream(
  targetPath: string,
  stream: ReadableStream<Uint8Array>,
  capability: DirectorySyncCapability,
): Promise<{ hash: string; durability: "durable" | "best_effort" }> {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const digest = createHash("sha256");
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>),
      hashing,
      createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
    );
    const handle = await open(tempPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, targetPath);
    const durability = acceptedDurability(
      (await syncNamespaces([dirname(targetPath)], { capability })).durability,
    );
    return { hash: digest.digest("hex"), durability };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeAudioStreamInStaging(
  id: string,
  stream: ReadableStream<Uint8Array>,
  capability: DirectorySyncCapability,
): Promise<{ hash: string; durability: "durable" | "best_effort" }> {
  const staging = finalizeStagingPaths(id);
  return writeAudioStream(staging.audio, stream, capability);
}

export interface PublishedFinalizeRecord {
  id: string;
  receipt: FinalizeReceipt;
  receiptHash: string;
  artifact: "published" | "already_published";
  durability: "durable" | "best_effort" | "pending";
}

export async function publishPreparedFinalizeRecord(input: {
  prepared: Extract<PreparedFinalize, { kind: "staged" }>;
  body: ReadableStream<Uint8Array> | null;
  ownerToken: string;
}): Promise<PublishedFinalizeRecord> {
  const { prepared } = input;
  assertMeetingOperationOwner(prepared.id, input.ownerToken);
  const staging = finalizeStagingPaths(prepared.id);
  const capability = createDirectorySyncCapability();
  let durability = prepared.durability;
  let audioHash: string;
  if (prepared.needsBody) {
    if (!input.body) throw new FinalizeRecordError("finalize_write_failed");
    const audio = await writeAudioStreamInStaging(prepared.id, input.body, capability);
    audioHash = audio.hash;
    durability = mergeDurability(durability, audio.durability);
  } else {
    audioHash = await hashFile(staging.audio);
  }

  let receipt = await readJson(staging.receipt, receiptSchema);
  if (receipt && receipt.audioSha256 !== audioHash) {
    throw new FinalizeRecordError("finalize_state_ambiguous");
  }
  receipt ??= receiptSchema.parse({ ...prepared.intent, audioSha256: audioHash });
  const receiptBytes = serialize(receipt);
  const receiptHash = finalizeReceiptHash(receipt);
  const status: StatusJson = parseStatusJson({
    ...initialStatus(prepared.id, {
      startedAt: receipt.startedAt,
      endedAt: receipt.endedAt,
      durationMs: receipt.durationMs,
      audioMime: receipt.mimeType,
    }),
    placementResolution: { state: "pending", receiptHash },
  }, prepared.id);

  for (const [targetPath, bytes] of [
    [staging.status, serialize(status)],
    [staging.receipt, receiptBytes],
  ] as const) {
    const existing = await safeFile(targetPath);
    if (existing === "unsafe") throw new FinalizeRecordError("finalize_state_ambiguous");
    if (existing === "safe") {
      if (await readFile(targetPath, "utf8") !== bytes) {
        throw new FinalizeRecordError("finalize_state_ambiguous");
      }
    } else {
      const commit = await durableAtomicReplace({
        rootPath: dataRoot(),
        targetPath,
        data: bytes,
        capability,
      });
      durability = mergeDurability(durability, acceptedDurability(commit.durability));
    }
  }

  if (existsSync(staging.intent)) {
    const removed = await durableUnlink({
      rootPath: dataRoot(),
      targetPath: staging.intent,
      capability,
    });
    durability = mergeDurability(durability, acceptedDurability(removed.durability));
  }
  durability = mergeDurability(
    durability,
    acceptedDurability((await syncNamespaces([staging.dir], { capability })).durability),
  );

  const artifactLease = await acquireArtifactWriteLease(prepared.id, input.ownerToken);
  let publishDurability: "durable" | "best_effort" | "pending" = durability;
  try {
    if ((await inspectMeetingTombstone(prepared.id)).state !== "none") {
      throw new FinalizeRecordError("meeting_deleted");
    }
    const finalState = await safeDirectory(meetingPaths(prepared.id).dir);
    if (finalState === "unsafe") throw new FinalizeRecordError("finalize_state_ambiguous");
    if (finalState === "safe") {
      return {
        id: prepared.id,
        receipt,
        receiptHash,
        artifact: "already_published",
        durability,
      };
    }
    await rename(staging.dir, meetingPaths(prepared.id).dir);
    const namespace = await syncNamespaces([meetingsRoot()], { capability });
    publishDurability = namespace.durability === "pending"
      ? "pending"
      : mergeDurability(durability, namespace.durability);
  } finally {
    artifactLease.release();
  }
  return {
    id: prepared.id,
    receipt,
    receiptHash,
    artifact: "published",
    durability: publishDurability,
  };
}

export async function readFinalizeReceipt(id: string): Promise<FinalizeReceipt | null> {
  return readJson(finalizeReceiptPath(id), receiptSchema);
}

export async function listActiveFinalizeLocationIntents(): Promise<FinalizeIntent[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(meetingsRoot(), { withFileTypes: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    throw error;
  }
  const intents: FinalizeIntent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(".finalize-")) {
      continue;
    }
    const id = entry.name.slice(".finalize-".length);
    if (!isSafeId(id)) continue;
    const staging = finalizeStagingPaths(id);
    try {
      const intent = await readJson(staging.intent, intentSchema);
      if (intent) {
        intents.push(intent);
        continue;
      }
      const receipt = await readJson(staging.receipt, receiptSchema);
      if (receipt) intents.push(intentFromReceipt(receipt));
    } catch {
      // An unsafe or partially edited staging entry is not guessed. The
      // container operation still preserves every meeting artifact and the
      // finalize resolver will apply its normal missing-container fallback.
    }
  }
  return intents;
}

export type FinalizeProbeState =
  | { state: "published"; receipt: FinalizeReceipt | null }
  | { state: "body_required"; intent: FinalizeIntent }
  | { state: "resume_required"; intent: FinalizeIntent }
  | { state: "not_committed" };

/** Read-only classifier used before an ambiguous client retries a retained Blob. */
export async function inspectFinalizeRecord(id: string): Promise<FinalizeProbeState> {
  const finalState = await safeDirectory(meetingPaths(id).dir);
  if (finalState === "unsafe") throw new FinalizeRecordError("finalize_state_ambiguous");
  if (finalState === "safe") {
    return { state: "published", receipt: await readJson(finalizeReceiptPath(id), receiptSchema) };
  }
  const staging = finalizeStagingPaths(id);
  const stagingState = await safeDirectory(staging.dir);
  if (stagingState === "missing") return { state: "not_committed" };
  if (stagingState === "unsafe") throw new FinalizeRecordError("finalize_state_ambiguous");
  const intent = await readJson(staging.intent, intentSchema);
  const receipt = await readJson(staging.receipt, receiptSchema);
  const audio = await safeFile(staging.audio);
  const status = await safeFile(staging.status);
  if (audio === "unsafe" || status === "unsafe") {
    throw new FinalizeRecordError("finalize_state_ambiguous");
  }
  if (!intent && !receipt) {
    if (audio === "missing" && status === "missing") return { state: "not_committed" };
    throw new FinalizeRecordError("finalize_state_ambiguous");
  }
  const canonicalIntent = intent ?? (receipt ? intentFromReceipt(receipt) : null);
  if (!canonicalIntent) throw new FinalizeRecordError("finalize_state_ambiguous");
  if (intent && receipt && JSON.stringify(intent) !== JSON.stringify(intentFromReceipt(receipt))) {
    throw new FinalizeRecordError("finalize_state_ambiguous");
  }
  if (receipt && audio !== "safe") throw new FinalizeRecordError("finalize_state_ambiguous");
  if (audio === "safe") return { state: "resume_required", intent: canonicalIntent };
  return { state: "body_required", intent: canonicalIntent };
}
