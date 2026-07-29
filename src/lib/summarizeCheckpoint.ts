import { createHash } from "node:crypto";
import { resolve, join, relative } from "node:path";

import { z } from "zod";

import type { Glossary } from "@/domain/glossary";
import { acquireArtifactReadLease, acquireArtifactWriteLease } from "@/lib/artifactLease";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  durableAtomicReplace,
  durableUnlink,
  NO_FOLLOW_OPEN_FLAGS,
  syncNamespaces,
  type DirectorySyncCapability,
  type DurableCommitResult,
  type FileOps,
} from "@/lib/durableFileOps";
import {
  assertMeetingOperationOwner,
  isExactMeetingOperationActive,
} from "@/lib/meetingLifecycle";
import { assertSafeId } from "@/lib/meetingId";
import { inspectMeetingTombstone } from "@/lib/meetingTombstone";
import {
  CORRECTION_MODES,
  type CorrectionMode,
} from "@/lib/pipelineSettings";
import { dataRoot as defaultDataRoot } from "@/lib/paths";
import { normalizeLoopbackHttpBaseUrl } from "@/lib/localEndpoint";
import type { LlmProvider, LlmSettings } from "@/services/llm/types";

export const CORRECTION_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const CORRECTION_PROMPT_VERSION = "correction-v1";

const CHECKPOINT_FILE_NAME = ".correction-checkpoint.json";
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const MAX_COMPLETED_CHUNKS = 1_024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const checkpointKeySchema = z.object({
  rawSha256: z.string().regex(SHA256),
  glossarySha256: z.string().regex(SHA256),
  provider: z.enum(["claude-cli", "codex-cli", "ollama"]),
  model: z.string().max(512),
  providerEndpointIdentitySha256: z.string().regex(SHA256),
  correctionPromptVersion: z.string().min(1).max(64),
  correctionMode: z.enum(CORRECTION_MODES),
  chunkPlanSha256: z.string().regex(SHA256),
}).strict();

const completedChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  inputSha256: z.string().regex(SHA256),
  outputSha256: z.string().regex(SHA256),
  chunkId: z.string().min(1).max(128).regex(SAFE_ID).optional(),
  correctedText: z.string().max(MAX_CHECKPOINT_BYTES).optional(),
}).strict().superRefine((chunk, context) => {
  if ((chunk.chunkId === undefined) !== (chunk.correctedText === undefined)) {
    context.addIssue({
      code: "custom",
      message: "fast chunk identity and text must be stored together",
    });
  }
  if (
    chunk.correctedText !== undefined
    && chunk.outputSha256 !== sha256(chunk.correctedText)
  ) {
    context.addIssue({
      code: "custom",
      path: ["outputSha256"],
      message: "chunk output hash does not match its text",
    });
  }
});

const correctionCheckpointSchema = checkpointKeySchema.extend({
  schemaVersion: z.literal(CORRECTION_CHECKPOINT_SCHEMA_VERSION),
  meetingId: z.string().min(1).max(128).regex(SAFE_ID),
  correctedTranscript: z.string().max(MAX_CHECKPOINT_BYTES),
  completedChunks: z.array(completedChunkSchema).min(1).max(MAX_COMPLETED_CHUNKS),
  committedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((checkpoint, context) => {
  const indexes = checkpoint.completedChunks.map((chunk) => chunk.index);
  if (
    new Set(indexes).size !== indexes.length
    || indexes.some((index, position) => (
      position > 0 && index <= indexes[position - 1]!
    ))
  ) {
    context.addIssue({
      code: "custom",
      path: ["completedChunks"],
      message: "completed chunk indexes must be unique and source ordered",
    });
  }
  if (
    checkpoint.correctionMode === "full"
    && (
      checkpoint.completedChunks.length !== 1
      || checkpoint.completedChunks[0].index !== 0
      || checkpoint.completedChunks[0].chunkId !== undefined
      || checkpoint.completedChunks[0].correctedText !== undefined
      || checkpoint.completedChunks[0].inputSha256 !== checkpoint.rawSha256
      || checkpoint.completedChunks[0].outputSha256
        !== sha256(checkpoint.correctedTranscript)
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["completedChunks"],
      message: "full correction checkpoint metadata does not match its transcript",
    });
  }
  if (
    checkpoint.correctionMode === "fast"
    && (
      checkpoint.completedChunks.some((chunk) => (
        chunk.chunkId === undefined || chunk.correctedText === undefined
      ))
      || (
        checkpoint.correctedTranscript !== ""
        && checkpoint.completedChunks.map((chunk) => chunk.correctedText).join("")
          !== checkpoint.correctedTranscript
      )
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["completedChunks"],
      message: "fast correction checkpoint metadata does not match its transcript",
    });
  }
});

export type CorrectionCheckpointKey = z.infer<typeof checkpointKeySchema>;
export type CorrectionCheckpoint = z.infer<typeof correctionCheckpointSchema>;
export type FastCorrectionCheckpointChunk = {
  index: number;
  chunkId: string;
  inputSha256: string;
  outputSha256: string;
  correctedText: string;
};

export type CorrectionCheckpointObservation =
  | { state: "missing" }
  | { state: "valid"; checkpoint: CorrectionCheckpoint }
  | {
      state: "invalid";
      reason: "unsafe" | "oversize" | "duplicate_field" | "corrupt" | "unsupported_version";
    };

export type CorrectionCheckpointRemoveResult =
  | DurableCommitResult
  | { state: "missing"; durability: "none"; fingerprint: null };

export interface CorrectionCheckpointStore {
  read(
    meetingId: string,
    meetingOperationOwnerToken: string,
  ): Promise<CorrectionCheckpointObservation>;
  write(
    meetingId: string,
    meetingOperationOwnerToken: string,
    checkpoint: CorrectionCheckpoint,
  ): Promise<DurableCommitResult>;
  remove(
    meetingId: string,
    meetingOperationOwnerToken: string,
  ): Promise<CorrectionCheckpointRemoveResult>;
}

export class CorrectionCheckpointError extends Error {
  readonly code:
    | "checkpoint_fenced"
    | "checkpoint_invalid"
    | "checkpoint_durability_pending";

  constructor(code: CorrectionCheckpointError["code"]) {
    super(code);
    this.name = "CorrectionCheckpointError";
    this.code = code;
  }
}

export interface CorrectionCheckpointStoreOptions {
  dataRoot: string;
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
  inspectTombstone?: (
    meetingId: string,
  ) => ReturnType<typeof inspectMeetingTombstone>;
}

export function correctionCheckpointPath(
  meetingId: string,
  root = defaultDataRoot(),
): string {
  return join(root, "meetings", assertSafeId(meetingId), CHECKPOINT_FILE_NAME);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalGlossary(glossary: Glossary): string {
  return JSON.stringify({
    terms: [...glossary.terms],
    corrections: glossary.corrections.map(({ from, to }) => ({ from, to })),
  });
}

function endpointIdentity(
  provider: LlmProvider,
  settings: LlmSettings,
): string {
  if (provider !== "ollama") return `local-cli:${provider}`;
  return normalizeLoopbackHttpBaseUrl(
    settings.baseUrl || DEFAULT_OLLAMA_BASE_URL,
  );
}

export function buildCorrectionCheckpointKey(input: {
  rawBytes: Uint8Array;
  glossary: Glossary;
  settings: LlmSettings;
  correctionMode: CorrectionMode;
  chunkPlanSha256?: string;
  promptVersion?: string;
}): CorrectionCheckpointKey {
  const rawSha256 = sha256(input.rawBytes);
  const plan = {
    schemaVersion: 1,
    mode: input.correctionMode,
    chunks: [{
      index: 0,
      startByte: 0,
      endByte: input.rawBytes.byteLength,
      inputSha256: rawSha256,
    }],
  };
  return checkpointKeySchema.parse({
    rawSha256,
    glossarySha256: sha256(canonicalGlossary(input.glossary)),
    provider: input.settings.provider,
    model: input.settings.model?.trim() ?? "",
    providerEndpointIdentitySha256: sha256(
      endpointIdentity(input.settings.provider, input.settings),
    ),
    correctionPromptVersion: input.promptVersion ?? CORRECTION_PROMPT_VERSION,
    correctionMode: input.correctionMode,
    chunkPlanSha256: input.correctionMode === "fast"
      ? input.chunkPlanSha256
      : sha256(JSON.stringify(plan)),
  });
}

export function createCorrectionCheckpoint(input: {
  meetingId: string;
  key: CorrectionCheckpointKey;
  correctedTranscript: string;
  committedAt?: string;
}): CorrectionCheckpoint {
  return correctionCheckpointSchema.parse({
    schemaVersion: CORRECTION_CHECKPOINT_SCHEMA_VERSION,
    meetingId: input.meetingId,
    ...input.key,
    correctedTranscript: input.correctedTranscript,
    completedChunks: [{
      index: 0,
      inputSha256: input.key.rawSha256,
      outputSha256: sha256(input.correctedTranscript),
    }],
    committedAt: input.committedAt ?? new Date().toISOString(),
  });
}

export function createFastCorrectionCheckpoint(input: {
  meetingId: string;
  key: CorrectionCheckpointKey;
  correctedTranscript: string;
  completedChunks: readonly FastCorrectionCheckpointChunk[];
  committedAt?: string;
}): CorrectionCheckpoint {
  if (input.key.correctionMode !== "fast") {
    throw new CorrectionCheckpointError("checkpoint_invalid");
  }
  return correctionCheckpointSchema.parse({
    schemaVersion: CORRECTION_CHECKPOINT_SCHEMA_VERSION,
    meetingId: input.meetingId,
    ...input.key,
    correctedTranscript: input.correctedTranscript,
    completedChunks: input.completedChunks.map((chunk) => ({ ...chunk })),
    committedAt: input.committedAt ?? new Date().toISOString(),
  });
}

export function correctionCheckpointMatches(
  checkpoint: CorrectionCheckpoint,
  key: CorrectionCheckpointKey,
): boolean {
  return checkpoint.rawSha256 === key.rawSha256
    && checkpoint.glossarySha256 === key.glossarySha256
    && checkpoint.provider === key.provider
    && checkpoint.model === key.model
    && checkpoint.providerEndpointIdentitySha256
      === key.providerEndpointIdentitySha256
    && checkpoint.correctionPromptVersion === key.correctionPromptVersion
    && checkpoint.correctionMode === key.correctionMode
    && checkpoint.chunkPlanSha256 === key.chunkPlanSha256;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function assertNoDuplicateObjectFields(text: string): void {
  const contexts: Array<
    | { type: "object"; keys: Set<string>; expectingKey: boolean }
    | { type: "array" }
  > = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character !== '"') continue;
      inString = false;
      const context = contexts.at(-1);
      if (context?.type !== "object" || !context.expectingKey) continue;
      let cursor = index + 1;
      while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
      if (text[cursor] !== ":") continue;
      let key: string;
      try {
        key = JSON.parse(text.slice(stringStart, index + 1)) as string;
      } catch {
        throw new Error("checkpoint_corrupt");
      }
      if (context.keys.has(key)) throw new Error("checkpoint_duplicate_field");
      context.keys.add(key);
      context.expectingKey = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      stringStart = index;
      continue;
    }
    if (character === "{") {
      contexts.push({ type: "object", keys: new Set(), expectingKey: true });
      continue;
    }
    if (character === "[") {
      contexts.push({ type: "array" });
      continue;
    }
    if (character === "}" || character === "]") {
      contexts.pop();
      continue;
    }
    if (character === ",") {
      const context = contexts.at(-1);
      if (context?.type === "object") context.expectingKey = true;
    }
  }
}

function parseCheckpoint(bytes: Uint8Array): CorrectionCheckpointObservation {
  if (bytes.byteLength > MAX_CHECKPOINT_BYTES) {
    return { state: "invalid", reason: "oversize" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoDuplicateObjectFields(text);
  } catch (error) {
    return {
      state: "invalid",
      reason: error instanceof Error && error.message === "checkpoint_duplicate_field"
        ? "duplicate_field"
        : "corrupt",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { state: "invalid", reason: "corrupt" };
  }
  if (
    typeof parsed === "object"
    && parsed !== null
    && !Array.isArray(parsed)
    && "schemaVersion" in parsed
    && (parsed as { schemaVersion?: unknown }).schemaVersion
      !== CORRECTION_CHECKPOINT_SCHEMA_VERSION
  ) {
    return { state: "invalid", reason: "unsupported_version" };
  }
  const checkpoint = correctionCheckpointSchema.safeParse(parsed);
  return checkpoint.success
    ? { state: "valid", checkpoint: checkpoint.data }
    : { state: "invalid", reason: "corrupt" };
}

export function createCorrectionCheckpointStore(
  options: CorrectionCheckpointStoreOptions,
): CorrectionCheckpointStore {
  const root = resolve(options.dataRoot);
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const inspectTombstone = options.inspectTombstone
    ?? ((meetingId: string) => inspectMeetingTombstone(meetingId, root));

  const assertUnfenced = async (meetingId: string): Promise<void> => {
    if (
      isExactMeetingOperationActive(meetingId, "delete")
      || isExactMeetingOperationActive(meetingId, "cleanup")
      || (await inspectTombstone(meetingId)).state !== "none"
    ) {
      throw new CorrectionCheckpointError("checkpoint_fenced");
    }
  };

  const inspectFile = async (
    meetingId: string,
  ): Promise<CorrectionCheckpointObservation> => {
    const path = correctionCheckpointPath(meetingId, root);
    const directory = join(root, "meetings", assertSafeId(meetingId));
    let handle: Awaited<ReturnType<FileOps["openFile"]>> | null = null;
    try {
      const rootInfo = await fileOps.lstat(root);
      const directoryInfo = await fileOps.lstat(directory);
      if (
        !rootInfo.isDirectory()
        || rootInfo.isSymbolicLink()
        || !directoryInfo.isDirectory()
        || directoryInfo.isSymbolicLink()
      ) return { state: "invalid", reason: "unsafe" };
      const realRoot = await fileOps.realpath(root);
      const realDirectory = await fileOps.realpath(directory);
      if (!contained(realRoot, realDirectory)) {
        return { state: "invalid", reason: "unsafe" };
      }

      const info = await fileOps.lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        return { state: "invalid", reason: "unsafe" };
      }
      if (info.size > MAX_CHECKPOINT_BYTES) {
        return { state: "invalid", reason: "oversize" };
      }
      handle = await fileOps.openFile(path, NO_FOLLOW_OPEN_FLAGS);
      const observation = parseCheckpoint(await handle.readFile());
      if (
        observation.state === "valid"
        && observation.checkpoint.meetingId !== meetingId
      ) return { state: "invalid", reason: "corrupt" };
      return observation;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return { state: "missing" };
      if (errnoCode(error) === "ELOOP") {
        return { state: "invalid", reason: "unsafe" };
      }
      return { state: "invalid", reason: "corrupt" };
    } finally {
      await handle?.close().catch(() => {});
    }
  };

  return {
    async read(meetingId, ownerToken) {
      assertMeetingOperationOwner(meetingId, ownerToken);
      await assertUnfenced(meetingId);
      const lease = await acquireArtifactReadLease(meetingId);
      try {
        await assertUnfenced(meetingId);
        const observation = await inspectFile(meetingId);
        if (observation.state !== "valid") return observation;
        const namespace = await syncNamespaces(
          [join(root, "meetings", assertSafeId(meetingId))],
          { fileOps, capability },
        );
        if (namespace.durability === "pending") {
          throw new CorrectionCheckpointError(
            "checkpoint_durability_pending",
          );
        }
        return observation;
      } finally {
        lease.release();
      }
    },

    async write(meetingId, ownerToken, checkpoint) {
      const parsed = correctionCheckpointSchema.parse(checkpoint);
      if (parsed.meetingId !== meetingId) {
        throw new CorrectionCheckpointError("checkpoint_invalid");
      }
      const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
      if (new TextEncoder().encode(serialized).byteLength > MAX_CHECKPOINT_BYTES) {
        throw new CorrectionCheckpointError("checkpoint_invalid");
      }
      assertMeetingOperationOwner(meetingId, ownerToken);
      await assertUnfenced(meetingId);
      const lease = await acquireArtifactWriteLease(meetingId, ownerToken);
      try {
        await assertUnfenced(meetingId);
        const current = await inspectFile(meetingId);
        if (current.state === "invalid") {
          throw new CorrectionCheckpointError("checkpoint_invalid");
        }
        return await durableAtomicReplace({
          rootPath: root,
          targetPath: correctionCheckpointPath(meetingId, root),
          data: serialized,
          fileOps,
          capability,
          mode: 0o600,
        });
      } finally {
        lease.release();
      }
    },

    async remove(meetingId, ownerToken) {
      assertMeetingOperationOwner(meetingId, ownerToken);
      await assertUnfenced(meetingId);
      const lease = await acquireArtifactWriteLease(meetingId, ownerToken);
      try {
        await assertUnfenced(meetingId);
        const current = await inspectFile(meetingId);
        if (current.state === "missing") {
          return { state: "missing", durability: "none", fingerprint: null };
        }
        if (current.state === "invalid") {
          throw new CorrectionCheckpointError("checkpoint_invalid");
        }
        return await durableUnlink({
          rootPath: root,
          targetPath: correctionCheckpointPath(meetingId, root),
          fileOps,
          capability,
        });
      } finally {
        lease.release();
      }
    },
  };
}
