import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type {
  ContentRevision,
  StatusJson,
  SummarizeAttempt,
} from "@/domain/meeting";
import { acquireArtifactWriteLease } from "@/lib/artifactLease";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  durableAtomicReplace,
  durableUnlink,
  syncNamespaces,
  type DirectorySyncCapability,
  type DurableCommitResult,
  type FileOps,
} from "@/lib/durableFileOps";
import { dataRoot, meetingPaths } from "@/lib/paths";
import { readStatus, updateStatus } from "@/lib/status";

const MANIFEST_VERSION = 1 as const;
const SHA256 = /^[a-f0-9]{64}$/u;

export type SummarizeManifestPhase =
  | "prepared"
  | "preimage_durable"
  | "transcript_published"
  | "summary_published";

interface SummarizeManifest {
  schemaVersion: typeof MANIFEST_VERSION;
  meetingId: string;
  attemptId: string;
  kind: SummarizeAttempt["kind"];
  phase: SummarizeManifestPhase;
  intendedTranscriptHash: string;
  intendedSummaryHash: string;
  preTranscriptHash: string | null;
  preSummaryHash: string | null;
  preimage: null | { present: false; hash: null } | { present: true; hash: string };
  intendedContentRevision?: ContentRevision;
}

const contentRevisionSchema = z.object({
  transcript: z.object({
    source: z.enum(["generated", "manual"]),
    sha256: z.string().regex(SHA256),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  summary: z.object({
    source: z.enum(["generated", "manual"]),
    sha256: z.string().regex(SHA256),
    basedOnTranscriptSha256: z.string().regex(SHA256),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_VERSION),
  meetingId: z.string().min(1),
  attemptId: z.string().uuid(),
  kind: z.enum([
    "initial",
    "resummarize",
    "manual_edit",
    "transcript_regenerate",
    "summary_regenerate",
  ]),
  phase: z.enum(["prepared", "preimage_durable", "transcript_published", "summary_published"]),
  intendedTranscriptHash: z.string().regex(SHA256),
  intendedSummaryHash: z.string().regex(SHA256),
  preTranscriptHash: z.string().regex(SHA256).nullable(),
  preSummaryHash: z.string().regex(SHA256).nullable(),
  preimage: z.union([
    z.null(),
    z.object({ present: z.literal(false), hash: z.null() }).strict(),
    z.object({ present: z.literal(true), hash: z.string().regex(SHA256) }).strict(),
  ]),
  intendedContentRevision: contentRevisionSchema.optional(),
}).strict().superRefine((manifest, context) => {
  if (
    manifest.kind !== "initial"
    && manifest.kind !== "resummarize"
    && manifest.intendedContentRevision === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["intendedContentRevision"],
      message: "content mutation manifests require intended revision metadata",
    });
  }
});

export interface SummarizeAttemptPaths {
  dir: string;
  manifest: string;
  transcript: string;
  summary: string;
  preTranscript: string;
}

export function summarizeAttemptPaths(id: string, attemptId: string): SummarizeAttemptPaths {
  const safeAttemptId = z.string().uuid().parse(attemptId);
  const dir = join(meetingPaths(id).dir, `.summarize-${safeAttemptId}`);
  return {
    dir,
    manifest: join(dir, "manifest.json"),
    transcript: join(dir, "transcript.md"),
    summary: join(dir, "summary.json"),
    preTranscript: join(dir, "pre-transcript.md"),
  };
}

export type SummarizePublisherBarrierPoint =
  | "after_staging"
  | "after_preimage_durable"
  | "after_transcript_publish"
  | "before_summary_publish"
  | "after_summary_publish"
  | "after_status_clear";

export type SummarizePublisherBarrier = (
  point: SummarizePublisherBarrierPoint,
) => void | Promise<void>;

export interface SummarizePublisherOptions {
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
  barrier?: SummarizePublisherBarrier;
}

export class SummarizePublishError extends Error {
  readonly code: "summarize_publication_failed" | "summarize_ambiguous";
  readonly restored: boolean;

  constructor(
    code: SummarizePublishError["code"],
    options: { restored?: boolean; cause?: unknown } = {},
  ) {
    super(code, { cause: options.cause });
    this.name = "SummarizePublishError";
    this.code = code;
    this.restored = options.restored ?? false;
  }
}

interface HashPair {
  transcript: string | null;
  summary: string | null;
}

export interface ReconciliationPlanInput {
  pre: HashPair;
  intended: HashPair;
  current: HashPair;
  staged: boolean;
  phase: SummarizeManifestPhase | null;
}

export type SummarizeReconciliationAction =
  | "completed"
  | "resume"
  | "restore"
  | "interrupt"
  | "ambiguous";

function pairEquals(a: HashPair, b: HashPair): boolean {
  return a.transcript === b.transcript && a.summary === b.summary;
}

export function planSummarizeReconciliation(
  input: ReconciliationPlanInput,
): SummarizeReconciliationAction {
  if (pairEquals(input.current, input.intended)) return "completed";
  const oldPair = pairEquals(input.current, input.pre);
  const mixed = input.current.transcript === input.intended.transcript
    && input.current.summary === input.pre.summary;

  if (!input.staged) {
    if (oldPair) return "interrupt";
    if (mixed) return "restore";
    return "ambiguous";
  }
  if (input.phase === "summary_published") return "ambiguous";
  if (oldPair || mixed) return "resume";
  return "ambiguous";
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readOrNull(path: string, fileOps: FileOps): Promise<Uint8Array | null> {
  try {
    return await fileOps.readFile(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function hashOrNull(path: string, fileOps: FileOps): Promise<string | null> {
  const bytes = await readOrNull(path, fileOps);
  return bytes === null ? null : sha256(bytes);
}

function acceptedDurability(
  result: DurableCommitResult,
  stage: string,
): "durable" | "best_effort" {
  if (result.state === "committed_durable") return "durable";
  if (result.state === "committed_best_effort") return "best_effort";
  throw new SummarizePublishError("summarize_publication_failed", {
    cause: new Error(`${stage}:${result.errorCode ?? result.state}`),
  });
}

function mergeDurability(
  current: "durable" | "best_effort",
  next: "durable" | "best_effort",
): "durable" | "best_effort" {
  return current === "best_effort" || next === "best_effort" ? "best_effort" : "durable";
}

async function writeManifest(
  id: string,
  path: string,
  manifest: SummarizeManifest,
  fileOps: FileOps,
  capability: DirectorySyncCapability,
): Promise<"durable" | "best_effort"> {
  const parsed = manifestSchema.parse(manifest);
  return acceptedDurability(await durableAtomicReplace({
    rootPath: dataRoot(),
    targetPath: path,
    data: `${JSON.stringify(parsed, null, 2)}\n`,
    fileOps,
    capability,
  }), `${id}:manifest:${manifest.phase}`);
}

function manifestFor(
  id: string,
  attempt: SummarizeAttempt,
  transcript: string,
  summary: string,
): SummarizeManifest {
  const intendedTranscriptHash = sha256(transcript);
  const intendedSummaryHash = sha256(summary);
  const intendedContentRevision = attempt.intendedContentRevision ?? {
    transcript: {
      source: "generated" as const,
      sha256: intendedTranscriptHash,
      updatedAt: attempt.startedAt,
    },
    summary: {
      source: "generated" as const,
      sha256: intendedSummaryHash,
      basedOnTranscriptSha256: intendedTranscriptHash,
      updatedAt: attempt.startedAt,
    },
  };
  if (
    intendedContentRevision.transcript.sha256 !== intendedTranscriptHash
    || intendedContentRevision.summary.sha256 !== intendedSummaryHash
  ) throw new SummarizePublishError("summarize_ambiguous");
  return {
    schemaVersion: MANIFEST_VERSION,
    meetingId: id,
    attemptId: attempt.attemptId,
    kind: attempt.kind,
    phase: "prepared",
    intendedTranscriptHash,
    intendedSummaryHash,
    preTranscriptHash: attempt.preTranscriptHash ?? null,
    preSummaryHash: attempt.preSummaryHash ?? null,
    preimage: null,
    intendedContentRevision,
  };
}

function intendedRevisionForManifest(
  manifest: SummarizeManifest,
  attempt: SummarizeAttempt,
): ContentRevision {
  if (manifest.intendedContentRevision) {
    if (
      manifest.intendedContentRevision.transcript.sha256 !== manifest.intendedTranscriptHash
      || manifest.intendedContentRevision.summary.sha256 !== manifest.intendedSummaryHash
    ) throw new SummarizePublishError("summarize_ambiguous");
    return manifest.intendedContentRevision;
  }
  if (manifest.kind !== "initial" && manifest.kind !== "resummarize") {
    throw new SummarizePublishError("summarize_ambiguous");
  }
  return {
    transcript: {
      source: "generated",
      sha256: manifest.intendedTranscriptHash,
      updatedAt: attempt.startedAt,
    },
    summary: {
      source: "generated",
      sha256: manifest.intendedSummaryHash,
      basedOnTranscriptSha256: manifest.intendedTranscriptHash,
      updatedAt: attempt.startedAt,
    },
  };
}

function contentRevisionsEqual(
  left: ContentRevision,
  right: ContentRevision,
): boolean {
  return left.transcript.source === right.transcript.source
    && left.transcript.sha256 === right.transcript.sha256
    && left.transcript.updatedAt === right.transcript.updatedAt
    && left.summary.source === right.summary.source
    && left.summary.sha256 === right.summary.sha256
    && left.summary.basedOnTranscriptSha256 === right.summary.basedOnTranscriptSha256
    && left.summary.updatedAt === right.summary.updatedAt;
}

async function verifyPreSummary(
  id: string,
  expected: string | null,
  fileOps: FileOps,
): Promise<void> {
  const actual = await hashOrNull(meetingPaths(id).summary, fileOps);
  if (actual !== expected) throw new SummarizePublishError("summarize_ambiguous");
}

async function ensurePreimage(
  id: string,
  manifest: SummarizeManifest,
  paths: SummarizeAttemptPaths,
  fileOps: FileOps,
  capability: DirectorySyncCapability,
): Promise<{ manifest: SummarizeManifest; durability: "durable" | "best_effort" }> {
  if (manifest.phase !== "prepared") {
    if (manifest.preimage === null) throw new SummarizePublishError("summarize_ambiguous");
    return { manifest, durability: "durable" };
  }
  await verifyPreSummary(id, manifest.preSummaryHash, fileOps);
  let durability: "durable" | "best_effort" = "durable";
  let preimage: SummarizeManifest["preimage"];
  if (manifest.preTranscriptHash === null) {
    if (await hashOrNull(meetingPaths(id).transcript, fileOps) !== null) {
      throw new SummarizePublishError("summarize_ambiguous");
    }
    preimage = { present: false, hash: null };
  } else {
    const bytes = await readOrNull(meetingPaths(id).transcript, fileOps);
    if (bytes === null || sha256(bytes) !== manifest.preTranscriptHash) {
      throw new SummarizePublishError("summarize_ambiguous");
    }
    durability = mergeDurability(durability, acceptedDurability(await durableAtomicReplace({
      rootPath: dataRoot(),
      targetPath: paths.preTranscript,
      data: bytes,
      fileOps,
      capability,
    }), `${id}:pre-transcript`));
    if (await hashOrNull(paths.preTranscript, fileOps) !== manifest.preTranscriptHash) {
      throw new SummarizePublishError("summarize_publication_failed");
    }
    preimage = { present: true, hash: manifest.preTranscriptHash };
  }
  const next = { ...manifest, phase: "preimage_durable" as const, preimage };
  durability = mergeDurability(
    durability,
    await writeManifest(id, paths.manifest, next, fileOps, capability),
  );
  return { manifest: next, durability };
}

async function restoreTranscript(
  id: string,
  manifest: SummarizeManifest,
  paths: SummarizeAttemptPaths,
  fileOps: FileOps,
  capability: DirectorySyncCapability,
): Promise<boolean> {
  try {
    if (manifest.preTranscriptHash === null) {
      if (await hashOrNull(meetingPaths(id).transcript, fileOps) === null) return true;
      const removed = await durableUnlink({
        rootPath: dataRoot(),
        targetPath: meetingPaths(id).transcript,
        fileOps,
        capability,
      });
      if (removed.state === "not_committed") return false;
      return await hashOrNull(meetingPaths(id).transcript, fileOps) === null;
    }
    const backup = await readOrNull(paths.preTranscript, fileOps);
    if (backup === null || sha256(backup) !== manifest.preTranscriptHash) return false;
    const restored = await durableAtomicReplace({
      rootPath: dataRoot(),
      targetPath: meetingPaths(id).transcript,
      data: backup,
      fileOps,
      capability,
    });
    if (restored.state === "not_committed") return false;
    return await hashOrNull(meetingPaths(id).transcript, fileOps) === manifest.preTranscriptHash;
  } catch {
    return false;
  }
}

function isSimulatedCrash(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "simulateCrash" in error
    && (error as { simulateCrash?: unknown }).simulateCrash === true;
}

async function publishPrepared(
  id: string,
  manifestInput: SummarizeManifest,
  paths: SummarizeAttemptPaths,
  fileOps: FileOps,
  capability: DirectorySyncCapability,
  barrier?: SummarizePublisherBarrier,
): Promise<{ manifest: SummarizeManifest; durability: "durable" | "best_effort" }> {
  let manifest = manifestInput;
  let durability: "durable" | "best_effort" = "durable";
  let transcriptPublished = false;
  let summaryPublished = false;
  try {
    const stagedTranscript = await readOrNull(paths.transcript, fileOps);
    const stagedSummary = await readOrNull(paths.summary, fileOps);
    if (
      stagedTranscript === null
      || stagedSummary === null
      || sha256(stagedTranscript) !== manifest.intendedTranscriptHash
      || sha256(stagedSummary) !== manifest.intendedSummaryHash
      || manifest.preimage === null
    ) throw new SummarizePublishError("summarize_ambiguous");

    if (await hashOrNull(meetingPaths(id).transcript, fileOps) !== manifest.intendedTranscriptHash) {
      const transcriptCommit = await durableAtomicReplace({
        rootPath: dataRoot(),
        targetPath: meetingPaths(id).transcript,
        data: stagedTranscript,
        fileOps,
        capability,
      });
      transcriptPublished = transcriptCommit.state !== "not_committed";
      durability = mergeDurability(durability, acceptedDurability(
        transcriptCommit,
        `${id}:publish-transcript`,
      ));
    }
    transcriptPublished = true;
    await barrier?.("after_transcript_publish");
    manifest = { ...manifest, phase: "transcript_published" };
    durability = mergeDurability(
      durability,
      await writeManifest(id, paths.manifest, manifest, fileOps, capability),
    );

    await barrier?.("before_summary_publish");
    if (await hashOrNull(meetingPaths(id).summary, fileOps) !== manifest.intendedSummaryHash) {
      const summaryCommit = await durableAtomicReplace({
        rootPath: dataRoot(),
        targetPath: meetingPaths(id).summary,
        data: stagedSummary,
        fileOps,
        capability,
      });
      summaryPublished = summaryCommit.state !== "not_committed";
      durability = mergeDurability(durability, acceptedDurability(
        summaryCommit,
        `${id}:publish-summary`,
      ));
    }
    summaryPublished = true;
    await barrier?.("after_summary_publish");
    manifest = { ...manifest, phase: "summary_published" };
    durability = mergeDurability(
      durability,
      await writeManifest(id, paths.manifest, manifest, fileOps, capability),
    );

    if (
      await hashOrNull(meetingPaths(id).transcript, fileOps) !== manifest.intendedTranscriptHash
      || await hashOrNull(meetingPaths(id).summary, fileOps) !== manifest.intendedSummaryHash
    ) throw new SummarizePublishError("summarize_ambiguous");
    return { manifest, durability };
  } catch (error) {
    if (isSimulatedCrash(error)) throw error;
    if (summaryPublished) {
      throw error instanceof SummarizePublishError
        ? error
        : new SummarizePublishError("summarize_publication_failed", { cause: error });
    }
    const restored = transcriptPublished
      ? await restoreTranscript(id, manifest, paths, fileOps, capability)
      : false;
    if (error instanceof SummarizePublishError && error.code === "summarize_ambiguous") {
      throw new SummarizePublishError("summarize_ambiguous", { restored, cause: error });
    }
    throw new SummarizePublishError("summarize_publication_failed", { restored, cause: error });
  }
}

function withoutAttempt(latest: StatusJson): StatusJson {
  return { ...latest, summarizeAttempt: undefined };
}

async function clearSuccessfulAttempt(
  id: string,
  ownerToken: string,
  attemptId: string,
  contentRevision: ContentRevision,
): Promise<"durable" | "best_effort" | "pending" | "mismatch"> {
  let matched = false;
  const result = await updateStatus(id, ownerToken, (latest) => {
    if (latest.summarizeAttempt?.attemptId !== attemptId) return latest;
    matched = true;
    return {
      ...withoutAttempt(latest),
      status: "summarized",
      error: null,
      summarizeAttempts: 0,
      contentRevision,
    };
  });
  if (!matched) return "mismatch";
  if (result.commit.durability === "none") {
    throw new SummarizePublishError("summarize_publication_failed");
  }
  return result.commit.durability;
}

async function clearInterruptedAttempt(
  id: string,
  ownerToken: string,
  attempt: SummarizeAttempt,
): Promise<void> {
  await updateStatus(id, ownerToken, (latest) => {
    if (latest.summarizeAttempt?.attemptId !== attempt.attemptId) return latest;
    if (attempt.kind === "manual_edit") return withoutAttempt(latest);
    return {
      ...withoutAttempt(latest),
      status: attempt.preSummaryHash ? "summarized" : "transcribed",
      summarizeAttempts: (latest.summarizeAttempts ?? 0) + 1,
      error: {
        code: "summary_interrupted",
        message: "요약 작업이 중단되었습니다. 다시 시도해 주세요",
        action: "retry_summary",
      },
    };
  });
}

async function markAmbiguousAttempt(
  id: string,
  ownerToken: string,
  attemptId: string,
): Promise<void> {
  await updateStatus(id, ownerToken, (latest) => latest.summarizeAttempt?.attemptId === attemptId
    ? {
        ...latest,
        error: {
          code: "summarize_ambiguous",
          message: "요약 산출물 상태를 안전하게 판정할 수 없습니다",
          action: "retry_summary",
        },
      }
    : latest);
}

async function cleanupAttempt(
  id: string,
  ownerToken: string,
  paths: SummarizeAttemptPaths,
  fileOps: FileOps,
  capability: DirectorySyncCapability,
): Promise<void> {
  const lease = await acquireArtifactWriteLease(id, ownerToken);
  try {
    await rm(paths.dir, { recursive: true, force: true });
    await syncNamespaces([meetingPaths(id).dir], { fileOps, capability });
  } finally {
    lease.release();
  }
}

export async function discardSummarizeAttempt(
  id: string,
  ownerToken: string,
  attemptId: string,
): Promise<void> {
  const fileOps = createNodeFileOps();
  const capability = createDirectorySyncCapability();
  await cleanupAttempt(
    id,
    ownerToken,
    summarizeAttemptPaths(id, attemptId),
    fileOps,
    capability,
  );
}

export interface PublishSummarizeAttemptInput {
  id: string;
  ownerToken: string;
  attempt: SummarizeAttempt;
  transcript: string;
  summary: string;
}

export async function publishSummarizeAttempt(
  input: PublishSummarizeAttemptInput,
  options: SummarizePublisherOptions = {},
): Promise<{
  state: "published";
  artifactDurability: "durable" | "best_effort";
  statusDurability: "durable" | "best_effort" | "pending";
}> {
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const paths = summarizeAttemptPaths(input.id, input.attempt.attemptId);
  const current = await readStatus(input.id);
  if (current?.summarizeAttempt?.attemptId !== input.attempt.attemptId) {
    throw new SummarizePublishError("summarize_ambiguous");
  }
  const initialManifest = manifestFor(
    input.id,
    input.attempt,
    input.transcript,
    input.summary,
  );
  const intendedContentRevision = initialManifest.intendedContentRevision!;

  let artifactDurability: "durable" | "best_effort" = "durable";
  const lease = await acquireArtifactWriteLease(input.id, input.ownerToken);
  try {
    await fileOps.mkdir(paths.dir, { recursive: true, mode: 0o700 });
    const namespace = await syncNamespaces([meetingPaths(input.id).dir], { fileOps, capability });
    if (namespace.durability === "pending") {
      throw new SummarizePublishError("summarize_publication_failed");
    }
    artifactDurability = namespace.durability;
    artifactDurability = mergeDurability(artifactDurability, acceptedDurability(
      await durableAtomicReplace({
        rootPath: dataRoot(),
        targetPath: paths.transcript,
        data: input.transcript,
        fileOps,
        capability,
      }),
      `${input.id}:stage-transcript`,
    ));
    artifactDurability = mergeDurability(artifactDurability, acceptedDurability(
      await durableAtomicReplace({
        rootPath: dataRoot(),
        targetPath: paths.summary,
        data: input.summary,
        fileOps,
        capability,
      }),
      `${input.id}:stage-summary`,
    ));
    let manifest = initialManifest;
    artifactDurability = mergeDurability(
      artifactDurability,
      await writeManifest(input.id, paths.manifest, manifest, fileOps, capability),
    );
    await options.barrier?.("after_staging");
    const preimage = await ensurePreimage(
      input.id,
      manifest,
      paths,
      fileOps,
      capability,
    );
    manifest = preimage.manifest;
    artifactDurability = mergeDurability(artifactDurability, preimage.durability);
    await options.barrier?.("after_preimage_durable");
    const published = await publishPrepared(
      input.id,
      manifest,
      paths,
      fileOps,
      capability,
      options.barrier,
    );
    artifactDurability = mergeDurability(artifactDurability, published.durability);
  } finally {
    lease.release();
  }

  const statusDurability = await clearSuccessfulAttempt(
    input.id,
    input.ownerToken,
    input.attempt.attemptId,
    intendedContentRevision,
  );
  if (statusDurability === "mismatch") throw new SummarizePublishError("summarize_ambiguous");
  await options.barrier?.("after_status_clear");
  if (statusDurability !== "pending") {
    await cleanupAttempt(input.id, input.ownerToken, paths, fileOps, capability).catch(() => {});
  }
  return { state: "published", artifactDurability, statusDurability };
}

export async function publishManualMeetingContentAttempt(
  input: PublishSummarizeAttemptInput,
  options: SummarizePublisherOptions = {},
): ReturnType<typeof publishSummarizeAttempt> {
  if (input.attempt.kind !== "manual_edit") {
    throw new SummarizePublishError("summarize_ambiguous");
  }
  return publishSummarizeAttempt(input, options);
}

async function readManifest(
  path: string,
  fileOps: FileOps,
): Promise<SummarizeManifest | null> {
  const bytes = await readOrNull(path, fileOps);
  if (bytes === null) return null;
  try {
    return manifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    throw new SummarizePublishError("summarize_ambiguous");
  }
}

export type SummarizeReconcileResult = {
  state: "none" | "completed" | "interrupted" | "ambiguous";
};

export async function reconcileSummarizeAttempt(
  id: string,
  ownerToken: string,
  options: SummarizePublisherOptions = {},
): Promise<SummarizeReconcileResult> {
  const status = await readStatus(id);
  const attempt = status?.summarizeAttempt;
  if (!attempt) return { state: "none" };
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const paths = summarizeAttemptPaths(id, attempt.attemptId);
  let action: SummarizeReconciliationAction = "ambiguous";
  let manifest: SummarizeManifest | null = null;
  let intendedContentRevision: ContentRevision | null = null;

  const lease = await acquireArtifactWriteLease(id, ownerToken);
  try {
    manifest = await readManifest(paths.manifest, fileOps);
    const pre = {
      transcript: attempt.preTranscriptHash ?? null,
      summary: attempt.preSummaryHash ?? null,
    };
    const current = {
      transcript: await hashOrNull(meetingPaths(id).transcript, fileOps),
      summary: await hashOrNull(meetingPaths(id).summary, fileOps),
    };
    if (!manifest) {
      action = pairEquals(pre, current) ? "interrupt" : "ambiguous";
    } else if (
      manifest.meetingId !== id
      || manifest.attemptId !== attempt.attemptId
      || manifest.kind !== attempt.kind
      || manifest.preTranscriptHash !== pre.transcript
      || manifest.preSummaryHash !== pre.summary
    ) {
      action = "ambiguous";
    } else {
      intendedContentRevision = intendedRevisionForManifest(manifest, attempt);
      if (
        attempt.intendedContentRevision
        && !contentRevisionsEqual(
          attempt.intendedContentRevision,
          intendedContentRevision,
        )
      ) throw new SummarizePublishError("summarize_ambiguous");
      const intended = {
        transcript: manifest.intendedTranscriptHash,
        summary: manifest.intendedSummaryHash,
      };
      const staged = await hashOrNull(paths.transcript, fileOps) === intended.transcript
        && await hashOrNull(paths.summary, fileOps) === intended.summary;
      action = planSummarizeReconciliation({
        pre,
        intended,
        current,
        staged,
        phase: manifest.phase,
      });

      if (action === "resume") {
        if (manifest.phase === "prepared") {
          manifest = (await ensurePreimage(id, manifest, paths, fileOps, capability)).manifest;
        }
        await publishPrepared(id, manifest, paths, fileOps, capability, options.barrier);
        action = "completed";
      } else if (action === "restore") {
        if (!await restoreTranscript(id, manifest, paths, fileOps, capability)) {
          action = "ambiguous";
        }
      }
    }
  } catch (error) {
    if (isSimulatedCrash(error)) throw error;
    action = "ambiguous";
  } finally {
    lease.release();
  }

  if (action === "completed") {
    if (!intendedContentRevision && manifest) {
      intendedContentRevision = intendedRevisionForManifest(manifest, attempt);
    }
    if (!intendedContentRevision) {
      await markAmbiguousAttempt(id, ownerToken, attempt.attemptId).catch(() => {});
      return { state: "ambiguous" };
    }
    const durability = await clearSuccessfulAttempt(
      id,
      ownerToken,
      attempt.attemptId,
      intendedContentRevision,
    );
    if (durability === "mismatch") return { state: "ambiguous" };
    if (durability !== "pending") {
      await cleanupAttempt(id, ownerToken, paths, fileOps, capability).catch(() => {});
    }
    return { state: "completed" };
  }
  if (action === "interrupt" || action === "restore") {
    await clearInterruptedAttempt(id, ownerToken, attempt);
    await cleanupAttempt(id, ownerToken, paths, fileOps, capability).catch(() => {});
    return { state: "interrupted" };
  }
  await markAmbiguousAttempt(id, ownerToken, attempt.attemptId).catch(() => {});
  return { state: "ambiguous" };
}
