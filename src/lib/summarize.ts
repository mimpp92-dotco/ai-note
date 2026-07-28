import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ContentRevision,
  StatusError,
  StatusJson,
  SummarizeAttempt,
} from "@/domain/meeting";
import { GENERATED_SUMMARY_JSON_SCHEMA } from "@/domain/generatedSummaryJsonSchema";
import { summarySchema } from "@/domain/summarySchema";
import {
  readArtifactPair,
  type ArtifactPairRevision,
} from "@/lib/artifactPair";
import { acquireArtifactReadLease } from "@/lib/artifactLease";
import { readGlossary } from "@/lib/glossary";
import {
  isMeetingOperationActive,
  tryAcquireMeetingOperation,
  type MeetingOperation,
  type MeetingOperationLease,
} from "@/lib/meetingLifecycle";
import {
  createKnowledgeIndexRepository,
  type KnowledgeIndexRepository,
} from "@/lib/knowledgeIndexRepository";
import {
  readPipelineSettings,
  type CorrectionMode,
} from "@/lib/pipelineSettings";
import { dataRoot, meetingPaths } from "@/lib/paths";
import { classifyLlmFailure, safeLog } from "@/lib/publicApi";
import { readSettings } from "@/lib/settings";
import { readStatus, updateStatus } from "@/lib/status";
import {
  resolveTranscript,
  summarizeTranscript,
} from "@/lib/summarizeCore";
import {
  buildCorrectionCheckpointKey,
  correctionCheckpointMatches,
  createCorrectionCheckpoint,
  createCorrectionCheckpointStore,
  type CorrectionCheckpointStore,
} from "@/lib/summarizeCheckpoint";
import {
  discardSummarizeAttempt,
  publishSummarizeAttempt,
  reconcileSummarizeAttempt,
  SummarizePublishError,
} from "@/lib/summarizePublisher";
import { buildCorrectionPrompt, buildSummaryPrompt } from "@/lib/summarizePrompts";
import { inspectTranscriptionPublication } from "@/lib/transcriptionArtifacts";
import { getAdapter, getConfiguredAdapter } from "@/services/llm";
import type {
  LlmAdapter,
  LlmSettings,
} from "@/services/llm/types";

export type GenerationIntent =
  | "initial"
  | "transcript_regenerate"
  | "summary_regenerate";

type SummarizeKnowledgeIndexRepository = Pick<
  KnowledgeIndexRepository,
  "refreshAfterSummary"
>;

let knowledgeIndexRepositoryForTests: SummarizeKnowledgeIndexRepository | null = null;
let correctionCheckpointStoreForTests: CorrectionCheckpointStore | null = null;

export function setSummarizeKnowledgeIndexRepositoryForTests(
  repository: SummarizeKnowledgeIndexRepository | null,
): void {
  knowledgeIndexRepositoryForTests = repository;
}

export function setSummarizeCorrectionCheckpointStoreForTests(
  store: CorrectionCheckpointStore | null,
): void {
  correctionCheckpointStoreForTests = store;
}

function knowledgeIndexRepository(): SummarizeKnowledgeIndexRepository {
  return knowledgeIndexRepositoryForTests
    ?? createKnowledgeIndexRepository({ dataRoot: dataRoot() });
}

function correctionCheckpointStore(): CorrectionCheckpointStore {
  return correctionCheckpointStoreForTests
    ?? createCorrectionCheckpointStore({ dataRoot: dataRoot() });
}

export type SummarizeFailureReason =
  | "not_found"
  | "already_summarized"
  | "no_model"
  | "in_progress"
  | "revision_conflict"
  | "source_conflict"
  | "state_ambiguous"
  | "error";

export type SummarizeResult =
  | { ok: true }
  | { ok: false; reason: SummarizeFailureReason; message?: string };

type SummarizePreparationFailure = Extract<SummarizeResult, { ok: false }>;

export type SummarizeAcceptance =
  | { accepted: true; durability: "durable" | "best_effort" }
  | { accepted: false; reason: SummarizeFailureReason };

interface StablePairSnapshot {
  title: string;
  transcript: string;
  summary: string;
  summaryParticipants: string[];
  revision: ArtifactPairRevision;
  contentRevision: ContentRevision;
  raw?: string;
}

interface PreparedGeneration {
  intent: GenerationIntent;
  lease: MeetingOperationLease;
  adapter: LlmAdapter;
  attempt: SummarizeAttempt;
  acceptanceDurability: "durable" | "best_effort";
  snapshot?: StablePairSnapshot;
  initialContext?: {
    settings: LlmSettings;
    correctionMode: CorrectionMode;
  };
}

export function isSummarizeInflight(id: string): boolean {
  return isMeetingOperationActive(id, "summarize");
}

function sameRevision(
  left: ArtifactPairRevision,
  right: ArtifactPairRevision,
): boolean {
  return left.transcriptSha256 === right.transcriptSha256
    && left.summarySha256 === right.summarySha256;
}

function copyContentRevision(revision: ContentRevision): ContentRevision {
  return {
    transcript: { ...revision.transcript },
    summary: { ...revision.summary },
  };
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFileOrNull(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function prepareInitial(
  id: string,
  resetAttempts: boolean,
): Promise<PreparedGeneration | SummarizePreparationFailure> {
  const lease = await tryAcquireMeetingOperation(id, "summarize");
  if (!lease) return { ok: false, reason: "in_progress" };
  try {
    const status = await readStatus(id);
    if (!status) {
      lease.release();
      return { ok: false, reason: "not_found" };
    }
    if (
      inspectTranscriptionPublication(id, status.transcriptionDispatch?.dispatchId).state
      !== "complete"
    ) {
      lease.release();
      return { ok: false, reason: "in_progress" };
    }

    const paths = meetingPaths(id);
    const artifactLease = await acquireArtifactReadLease(id);
    let preTranscriptHash: string | null;
    let preSummaryHash: string | null;
    try {
      preTranscriptHash = await hashFileOrNull(paths.transcript);
      preSummaryHash = await hashFileOrNull(paths.summary);
    } finally {
      artifactLease.release();
    }
    if (preSummaryHash !== null) {
      lease.release();
      return { ok: false, reason: "already_summarized" };
    }

    const settings = await readSettings();
    if (!settings) {
      lease.release();
      return { ok: false, reason: "no_model" };
    }
    const pipelineSettings = await readPipelineSettings();
    if (pipelineSettings.state === "unavailable") {
      lease.release();
      return {
        ok: false,
        reason: "error",
        message: "pipeline_settings_unavailable",
      };
    }
    const adapter = getAdapter(settings);
    const attempt: SummarizeAttempt = {
      attemptId: randomUUID(),
      kind: "initial",
      startedAt: new Date().toISOString(),
      ...(preTranscriptHash === null ? {} : { preTranscriptHash }),
    };
    const prepared = await updateStatus(id, lease.ownerToken, (latest) => ({
      ...latest,
      status: "summarizing",
      error: null,
      summarizeAttempt: attempt,
      ...(resetAttempts ? { summarizeAttempts: 0 } : {}),
    }));
    if (prepared.commit.durability === "pending") {
      lease.release();
      return { ok: false, reason: "error", message: "status_durability_pending" };
    }
    if (prepared.commit.durability === "none") {
      lease.release();
      return { ok: false, reason: "error", message: "status_not_committed" };
    }
    return {
      intent: "initial",
      lease,
      adapter,
      attempt,
      acceptanceDurability: prepared.commit.durability,
      initialContext: {
        settings,
        correctionMode: pipelineSettings.settings.correction.mode,
      },
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

function pairFailureReason(state: string): SummarizeFailureReason {
  if (state === "active") return "in_progress";
  if (state === "source_conflict") return "source_conflict";
  return "state_ambiguous";
}

async function readStablePairSnapshot(
  id: string,
  status: StatusJson,
  intent: "transcript_regenerate" | "summary_regenerate",
  expectedRevision?: ArtifactPairRevision,
): Promise<StablePairSnapshot | SummarizePreparationFailure> {
  const pair = await readArtifactPair(id);
  if (
    pair.state !== "stable"
    || pair.transcript === null
    || pair.summary === null
    || !pair.revision
    || !pair.contentRevision
  ) {
    return { ok: false, reason: pairFailureReason(pair.state) };
  }
  if (expectedRevision && !sameRevision(pair.revision, expectedRevision)) {
    return { ok: false, reason: "revision_conflict" };
  }

  let summaryParticipants: string[];
  try {
    summaryParticipants = summarySchema.parse(JSON.parse(pair.summary) as unknown).participants;
  } catch {
    return { ok: false, reason: "state_ambiguous" };
  }

  let raw: string | undefined;
  if (intent === "transcript_regenerate") {
    if (
      inspectTranscriptionPublication(id, status.transcriptionDispatch?.dispatchId).state
      !== "complete"
    ) return { ok: false, reason: "state_ambiguous" };
    const artifactLease = await acquireArtifactReadLease(id);
    try {
      raw = await readFile(meetingPaths(id).raw, "utf8");
    } catch {
      return { ok: false, reason: "state_ambiguous" };
    } finally {
      artifactLease.release();
    }
  }

  return {
    title: status.title,
    transcript: pair.transcript,
    summary: pair.summary,
    summaryParticipants: [...summaryParticipants],
    revision: pair.revision,
    contentRevision: copyContentRevision(pair.contentRevision),
    ...(raw === undefined ? {} : { raw }),
  };
}

function operationForIntent(
  intent: "transcript_regenerate" | "summary_regenerate",
): MeetingOperation {
  return intent;
}

async function prepareRegeneration(
  id: string,
  intent: "transcript_regenerate" | "summary_regenerate",
  expectedRevision: ArtifactPairRevision | undefined,
  resetAttempts: boolean,
): Promise<PreparedGeneration | SummarizePreparationFailure> {
  const lease = await tryAcquireMeetingOperation(id, operationForIntent(intent));
  if (!lease) return { ok: false, reason: "in_progress" };
  try {
    const status = await readStatus(id);
    if (!status) {
      lease.release();
      return { ok: false, reason: "not_found" };
    }
    const snapshot = await readStablePairSnapshot(id, status, intent, expectedRevision);
    if ("ok" in snapshot) {
      lease.release();
      return snapshot;
    }
    const adapter = await getConfiguredAdapter();
    if (!adapter) {
      lease.release();
      return { ok: false, reason: "no_model" };
    }

    // The acceptance receipt is committed before the adapter starts. Its first
    // revision is the validated pre-generation pair; execution replaces it with
    // the intended hashes before the publisher can stage canonical output.
    const attempt: SummarizeAttempt = {
      attemptId: randomUUID(),
      kind: intent,
      startedAt: new Date().toISOString(),
      preTranscriptHash: snapshot.revision.transcriptSha256,
      preSummaryHash: snapshot.revision.summarySha256,
      intendedContentRevision: copyContentRevision(snapshot.contentRevision),
    };
    const prepared = await updateStatus(id, lease.ownerToken, (latest) => ({
      ...latest,
      error: null,
      summarizeAttempt: attempt,
      ...(resetAttempts ? { summarizeAttempts: 0 } : {}),
    }));
    if (prepared.commit.durability === "pending") {
      lease.release();
      return { ok: false, reason: "error", message: "status_durability_pending" };
    }
    if (prepared.commit.durability === "none") {
      lease.release();
      return { ok: false, reason: "error", message: "status_not_committed" };
    }
    return {
      intent,
      lease,
      adapter,
      attempt,
      acceptanceDurability: prepared.commit.durability,
      snapshot,
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

async function commitIntendedRevision(
  id: string,
  prepared: PreparedGeneration,
  intendedContentRevision: ContentRevision,
): Promise<void> {
  const nextAttempt: SummarizeAttempt = {
    ...prepared.attempt,
    intendedContentRevision,
  } as SummarizeAttempt;
  let matched = false;
  const updated = await updateStatus(id, prepared.lease.ownerToken, (latest) => {
    if (latest.summarizeAttempt?.attemptId !== prepared.attempt.attemptId) return latest;
    matched = true;
    return { ...latest, summarizeAttempt: nextAttempt };
  });
  if (!matched) throw new SummarizePublishError("summarize_ambiguous");
  if (updated.commit.durability === "pending") {
    throw new Error("status_durability_pending");
  }
  if (updated.commit.durability === "none") {
    throw new Error("status_not_committed");
  }
  prepared.attempt = nextAttempt;
}

async function generateSummary(
  adapter: LlmAdapter,
  title: string,
  transcript: string,
  preservedParticipants: readonly string[] = [],
) {
  let summaryOutput = await adapter.run(buildSummaryPrompt(transcript, title), {
    jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
  });
  let result = await summarizeTranscript({
    title,
    transcript,
    summaryOutput,
    preservedParticipants,
  });
  if (result.usedFallback) {
    try {
      summaryOutput = await adapter.run(buildSummaryPrompt(transcript, title), {
        jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
      });
      result = await summarizeTranscript({
        title,
        transcript,
        summaryOutput,
        preservedParticipants,
      });
    } catch {
      // The first pass already produced a schema-valid fallback payload.
    }
  }
  return result;
}

async function requireCurrentAttempt(
  id: string,
  prepared: PreparedGeneration,
): Promise<StatusJson> {
  const status = await readStatus(id);
  if (status?.summarizeAttempt?.attemptId !== prepared.attempt.attemptId) {
    throw new Error("summarize_attempt_mismatch");
  }
  return status;
}

async function resolveInitialCorrection(
  id: string,
  prepared: PreparedGeneration,
  store: CorrectionCheckpointStore,
): Promise<string> {
  const context = prepared.initialContext!;
  await requireCurrentAttempt(id, prepared);
  const rawBytes = await readFile(meetingPaths(id).raw);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  const glossary = await readGlossary();
  const key = buildCorrectionCheckpointKey({
    rawBytes,
    glossary,
    settings: context.settings,
    correctionMode: context.correctionMode,
  });
  const observed = await store.read(id, prepared.lease.ownerToken);
  await requireCurrentAttempt(id, prepared);
  if (observed.state === "invalid") {
    throw new Error("checkpoint_invalid");
  }
  if (
    observed.state === "valid"
    && correctionCheckpointMatches(observed.checkpoint, key)
  ) {
    return observed.checkpoint.correctedTranscript;
  }

  const correction = await prepared.adapter.run(
    buildCorrectionPrompt(raw, glossary),
  );
  const correctedTranscript = resolveTranscript(raw, correction);
  await requireCurrentAttempt(id, prepared);
  const commit = await store.write(
    id,
    prepared.lease.ownerToken,
    createCorrectionCheckpoint({
      meetingId: id,
      key,
      correctedTranscript,
    }),
  );
  if (
    commit.state !== "committed_durable"
    && commit.state !== "committed_best_effort"
  ) {
    throw new Error(
      commit.state === "committed_durability_pending"
        ? "checkpoint_durability_pending"
        : "checkpoint_not_committed",
    );
  }
  return correctedTranscript;
}

async function refreshKnowledgeIndex(id: string, ownerToken: string): Promise<void> {
  try {
    const indexing = await knowledgeIndexRepository().refreshAfterSummary({
      meetingId: id,
      meetingOperationOwnerToken: ownerToken,
    });
    if (indexing.status !== "ready") {
      safeLog("warn", {
        code: "knowledge_index_incomplete",
        operation: "summarize_index",
        meetingId: id,
      });
    }
  } catch {
    safeLog("warn", {
      code: "knowledge_index_failed",
      operation: "summarize_index",
      meetingId: id,
    });
  }
}

function clearAttempt(latest: StatusJson): StatusJson {
  return { ...latest, summarizeAttempt: undefined };
}

function failureForIntent(
  intent: GenerationIntent,
  error: unknown,
  adapter: LlmAdapter,
): StatusError {
  if (intent === "transcript_regenerate") {
    return {
      code: "transcript_generation_failed",
      message: "전체 스크립트를 다시 만들지 못했습니다",
      action: "retry_transcript_generation",
    };
  }
  if (error instanceof SummarizePublishError) {
    return {
      code: "summary_failed",
      message: "요약 산출물을 안전하게 저장하지 못했습니다",
      action: "retry_summary",
    };
  }
  return classifyLlmFailure(error, adapter.provider);
}

async function failGenerationAttempt(
  id: string,
  ownerToken: string,
  attempt: SummarizeAttempt,
  error: StatusError,
): Promise<"durable" | "best_effort" | "pending" | "mismatch"> {
  let handled = false;
  let clearedLiveAttempt = false;
  const result = await updateStatus(id, ownerToken, (latest) => {
    if (
      latest.summarizeAttempt
      && latest.summarizeAttempt.attemptId !== attempt.attemptId
    ) return latest;
    handled = true;
    clearedLiveAttempt = latest.summarizeAttempt?.attemptId === attempt.attemptId;
    return {
      ...(clearedLiveAttempt ? clearAttempt(latest) : latest),
      status: attempt.preSummaryHash ? "summarized" : "transcribed",
      summarizeAttempts: clearedLiveAttempt
        ? (latest.summarizeAttempts ?? 0) + 1
        : latest.summarizeAttempts,
      error,
    };
  });
  if (!handled) return "mismatch";
  return result.commit.durability === "none" ? "pending" : result.commit.durability;
}

async function markAmbiguousAttempt(
  id: string,
  ownerToken: string,
  attempt: SummarizeAttempt,
  intent: GenerationIntent,
): Promise<void> {
  await updateStatus(id, ownerToken, (latest) => {
    if (latest.summarizeAttempt?.attemptId !== attempt.attemptId) return latest;
    return {
      ...latest,
      error: intent === "transcript_regenerate"
        ? {
            code: "transcript_generation_ambiguous",
            message: "전체 스크립트 생성 상태를 안전하게 판정할 수 없습니다",
            action: "retry_transcript_generation",
          }
        : {
            code: "summarize_ambiguous",
            message: "요약 산출물 상태를 안전하게 판정할 수 없습니다",
            action: "retry_summary",
          },
    };
  });
}

async function executePreparedGeneration(
  id: string,
  prepared: PreparedGeneration,
): Promise<SummarizeResult> {
  const { lease, adapter, intent } = prepared;
  const paths = meetingPaths(id);
  const checkpointStore = intent === "initial"
    ? correctionCheckpointStore()
    : null;
  try {
    let transcript: string;
    let summary: string;

    if (intent === "initial") {
      const status = await requireCurrentAttempt(id, prepared);
      transcript = await resolveInitialCorrection(
        id,
        prepared,
        checkpointStore!,
      );
      await requireCurrentAttempt(id, prepared);
      const result = await generateSummary(adapter, status.title, transcript);
      summary = `${JSON.stringify(result.summary, null, 2)}\n`;
    } else if (intent === "transcript_regenerate") {
      const snapshot = prepared.snapshot!;
      const glossary = await readGlossary();
      const correction = await adapter.run(buildCorrectionPrompt(snapshot.raw!, glossary));
      transcript = resolveTranscript(snapshot.raw!, correction);
      summary = snapshot.summary;
      await commitIntendedRevision(id, prepared, {
        transcript: {
          source: "generated",
          sha256: hash(transcript),
          updatedAt: prepared.attempt.startedAt,
        },
        summary: { ...snapshot.contentRevision.summary },
      });
    } else {
      const snapshot = prepared.snapshot!;
      transcript = snapshot.transcript;
      const result = await generateSummary(
        adapter,
        snapshot.title,
        transcript,
        snapshot.summaryParticipants,
      );
      summary = `${JSON.stringify(result.summary, null, 2)}\n`;
      await commitIntendedRevision(id, prepared, {
        transcript: { ...snapshot.contentRevision.transcript },
        summary: {
          source: "generated",
          sha256: hash(summary),
          basedOnTranscriptSha256: snapshot.revision.transcriptSha256,
          updatedAt: prepared.attempt.startedAt,
        },
      });
    }

    const publication = await publishSummarizeAttempt({
      id,
      ownerToken: lease.ownerToken,
      attempt: prepared.attempt,
      transcript,
      summary,
    });
    if (publication.state === "published" && checkpointStore) {
      await checkpointStore.remove(id, lease.ownerToken).catch(() => {});
    }
    if (publication.state === "published" && intent !== "transcript_regenerate") {
      await refreshKnowledgeIndex(id, lease.ownerToken);
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof SummarizePublishError && !error.restored) {
      try {
        const reconciled = await reconcileSummarizeAttempt(id, lease.ownerToken);
        if (reconciled.state === "completed") {
          if (checkpointStore) {
            await checkpointStore.remove(id, lease.ownerToken).catch(() => {});
          }
          if (intent !== "transcript_regenerate") {
            await refreshKnowledgeIndex(id, lease.ownerToken);
          }
          return { ok: true };
        }
        if (reconciled.state === "ambiguous") {
          await markAmbiguousAttempt(id, lease.ownerToken, prepared.attempt, intent);
          return { ok: false, reason: "error", message: "summarize_ambiguous" };
        }
      } catch {
        await markAmbiguousAttempt(
          id,
          lease.ownerToken,
          prepared.attempt,
          intent,
        ).catch(() => {});
        return { ok: false, reason: "error", message: "summarize_ambiguous" };
      }
    }
    const failure = failureForIntent(intent, error, adapter);
    try {
      const durability = await failGenerationAttempt(
        id,
        lease.ownerToken,
        prepared.attempt,
        failure,
      );
      if (durability === "durable" || durability === "best_effort") {
        await discardSummarizeAttempt(
          id,
          lease.ownerToken,
          prepared.attempt.attemptId,
        ).catch(() => {});
      }
    } catch {
      // A delete/fence or durability failure may make status unavailable. The
      // safe result still never contains provider output.
    }
    return { ok: false, reason: "error", message: failure.message };
  } finally {
    lease.release();
  }
}

async function runPrepared(
  prepared: PreparedGeneration | SummarizePreparationFailure,
  id: string,
): Promise<SummarizeResult> {
  if (!("lease" in prepared)) return prepared;
  return executePreparedGeneration(id, prepared);
}

function acceptPrepared(
  prepared: PreparedGeneration | SummarizePreparationFailure,
  id: string,
): SummarizeAcceptance {
  if (!("lease" in prepared)) {
    return { accepted: false, reason: prepared.reason };
  }
  void executePreparedGeneration(id, prepared).catch(() => {});
  return {
    accepted: true,
    durability: prepared.acceptanceDurability,
  };
}

export async function runTranscriptRegenerate(
  id: string,
  options: { expectedRevision: ArtifactPairRevision },
): Promise<SummarizeResult> {
  return runPrepared(await prepareRegeneration(
    id,
    "transcript_regenerate",
    options.expectedRevision,
    false,
  ), id);
}

export async function acceptTranscriptRegenerate(
  id: string,
  options: { expectedRevision: ArtifactPairRevision },
): Promise<SummarizeAcceptance> {
  return acceptPrepared(await prepareRegeneration(
    id,
    "transcript_regenerate",
    options.expectedRevision,
    true,
  ), id);
}

export async function runSummaryRegenerate(
  id: string,
  options: { expectedRevision?: ArtifactPairRevision } = {},
): Promise<SummarizeResult> {
  return runPrepared(await prepareRegeneration(
    id,
    "summary_regenerate",
    options.expectedRevision,
    false,
  ), id);
}

export async function acceptSummaryRegenerate(
  id: string,
  options: { expectedRevision?: ArtifactPairRevision } = {},
): Promise<SummarizeAcceptance> {
  return acceptPrepared(await prepareRegeneration(
    id,
    "summary_regenerate",
    options.expectedRevision,
    true,
  ), id);
}

export async function runSummarize(
  id: string,
  options: { force?: boolean; expectedRevision?: ArtifactPairRevision } = {},
): Promise<SummarizeResult> {
  if (options.force === true) {
    return runSummaryRegenerate(id, { expectedRevision: options.expectedRevision });
  }
  return runPrepared(await prepareInitial(id, false), id);
}

export async function acceptSummarize(
  id: string,
  options: { force?: boolean; expectedRevision?: ArtifactPairRevision } = {},
): Promise<SummarizeAcceptance> {
  if (options.force === true) {
    return acceptSummaryRegenerate(id, { expectedRevision: options.expectedRevision });
  }
  return acceptPrepared(await prepareInitial(id, true), id);
}
