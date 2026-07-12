import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { StatusJson, SummarizeAttempt } from "@/domain/meeting";
import { acquireArtifactReadLease } from "@/lib/artifactLease";
import { readGlossary } from "@/lib/glossary";
import {
  isMeetingOperationActive,
  tryAcquireMeetingOperation,
  type MeetingOperationLease,
} from "@/lib/meetingLifecycle";
import {
  createKnowledgeIndexRepository,
  type KnowledgeIndexRepository,
} from "@/lib/knowledgeIndexRepository";
import { dataRoot, meetingPaths } from "@/lib/paths";
import { classifyLlmFailure, safeLog } from "@/lib/publicApi";
import { readStatus, updateStatus } from "@/lib/status";
import { resolveTranscript, summarizeCore } from "@/lib/summarizeCore";
import {
  discardSummarizeAttempt,
  publishSummarizeAttempt,
  reconcileSummarizeAttempt,
  SummarizePublishError,
} from "@/lib/summarizePublisher";
import { inspectTranscriptionPublication } from "@/lib/transcriptionArtifacts";
import { buildCorrectionPrompt, buildSummaryPrompt } from "@/lib/summarizePrompts";
import { getConfiguredAdapter } from "@/services/llm";
import type { LlmAdapter } from "@/services/llm/types";

export const MAX_SUMMARIZE_ATTEMPTS = 3;

type SummarizeKnowledgeIndexRepository = Pick<
  KnowledgeIndexRepository,
  "refreshAfterSummary"
>;

let knowledgeIndexRepositoryForTests: SummarizeKnowledgeIndexRepository | null = null;

export function setSummarizeKnowledgeIndexRepositoryForTests(
  repository: SummarizeKnowledgeIndexRepository | null,
): void {
  knowledgeIndexRepositoryForTests = repository;
}

function knowledgeIndexRepository(): SummarizeKnowledgeIndexRepository {
  return knowledgeIndexRepositoryForTests
    ?? createKnowledgeIndexRepository({ dataRoot: dataRoot() });
}

export type SummarizeFailureReason =
  | "not_found"
  | "already_summarized"
  | "no_model"
  | "in_progress"
  | "error";

export type SummarizeResult =
  | { ok: true }
  | { ok: false; reason: SummarizeFailureReason; message?: string };

type SummarizePreparationFailure = Extract<SummarizeResult, { ok: false }>;

export type SummarizeAcceptance =
  | { accepted: true; durability: "durable" | "best_effort" }
  | { accepted: false; reason: SummarizeFailureReason };

interface PreparedSummarize {
  lease: MeetingOperationLease;
  adapter: LlmAdapter;
  attempt: SummarizeAttempt;
  acceptanceDurability: "durable" | "best_effort";
}

export function isSummarizeInflight(id: string): boolean {
  return isMeetingOperationActive(id, "summarize");
}

async function prepareSummarize(
  id: string,
  force: boolean,
  resetAttempts: boolean,
): Promise<PreparedSummarize | SummarizePreparationFailure> {
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
    const adapter = await getConfiguredAdapter();
    if (!adapter) {
      lease.release();
      return { ok: false, reason: "no_model" };
    }
    const paths = meetingPaths(id);
    const artifactLease = await acquireArtifactReadLease(id);
    let prepared;
    let attempt: SummarizeAttempt;
    try {
      const preTranscriptHash = await hashFileOrNull(paths.transcript);
      const preSummaryHash = await hashFileOrNull(paths.summary);
      if (!force && preSummaryHash !== null) {
        lease.release();
        return { ok: false, reason: "already_summarized" };
      }
      attempt = {
        attemptId: randomUUID(),
        kind: preSummaryHash === null ? "initial" : "resummarize",
        startedAt: new Date().toISOString(),
        ...(preTranscriptHash === null ? {} : { preTranscriptHash }),
        ...(preSummaryHash === null ? {} : { preSummaryHash }),
      };
      prepared = await updateStatus(id, lease.ownerToken, (latest) => ({
        ...latest,
        status: "summarizing",
        error: null,
        summarizeAttempt: attempt,
        ...(resetAttempts ? { summarizeAttempts: 0 } : {}),
      }));
    } finally {
      artifactLease.release();
    }
    if (prepared.commit.durability === "pending") {
      lease.release();
      return { ok: false, reason: "error", message: "status_durability_pending" };
    }
    if (prepared.commit.durability === "none") {
      lease.release();
      return { ok: false, reason: "error", message: "status_not_committed" };
    }
    return { lease, adapter, attempt, acceptanceDurability: prepared.commit.durability };
  } catch (error) {
    lease.release();
    throw error;
  }
}

async function hashFileOrNull(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function clearAttempt(latest: StatusJson): StatusJson {
  return { ...latest, summarizeAttempt: undefined };
}

async function failMatchingAttempt(
  id: string,
  ownerToken: string,
  attempt: SummarizeAttempt,
  error: StatusJson["error"],
): Promise<"durable" | "best_effort" | "pending" | "mismatch"> {
  let matched = false;
  const result = await updateStatus(id, ownerToken, (latest) => {
    if (latest.summarizeAttempt?.attemptId !== attempt.attemptId) return latest;
    matched = true;
    return {
      ...clearAttempt(latest),
      status: attempt.preSummaryHash ? "summarized" : "transcribed",
      summarizeAttempts: (latest.summarizeAttempts ?? 0) + 1,
      error,
    };
  });
  if (!matched) return "mismatch";
  return result.commit.durability === "none" ? "pending" : result.commit.durability;
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

async function executePreparedSummarize(
  id: string,
  prepared: PreparedSummarize,
): Promise<SummarizeResult> {
  const { lease, adapter, attempt } = prepared;
  const paths = meetingPaths(id);
  try {
    const status = await readStatus(id);
    if (!status) return { ok: false, reason: "not_found" };
    const raw = await readFile(paths.raw, "utf-8");
    const glossary = await readGlossary();
    const title = status.title;
    const correction = await adapter.run(buildCorrectionPrompt(raw, glossary));
    const transcript = resolveTranscript(raw, correction);
    let summaryOutput = await adapter.run(buildSummaryPrompt(transcript, title), { json: true });

    let result = await summarizeCore({
      title,
      raw,
      correction,
      summaryOutput,
    });
    if (result.usedFallback) {
      try {
        summaryOutput = await adapter.run(buildSummaryPrompt(transcript, title), { json: true });
        result = await summarizeCore({
          title,
          raw,
          correction,
          summaryOutput,
        });
      } catch {
        // The first pass already produced a schema-valid fallback payload.
      }
    }

    const publication = await publishSummarizeAttempt({
      id,
      ownerToken: lease.ownerToken,
      attempt,
      transcript: result.transcript,
      summary: `${JSON.stringify(result.summary, null, 2)}\n`,
    });
    if (publication.state === "published") {
      try {
        const indexing = await knowledgeIndexRepository().refreshAfterSummary({
          meetingId: id,
          meetingOperationOwnerToken: lease.ownerToken,
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
    return { ok: true };
  } catch (error) {
    if (error instanceof SummarizePublishError && !error.restored) {
      try {
        const reconciled = await reconcileSummarizeAttempt(id, lease.ownerToken);
        if (reconciled.state === "completed") return { ok: true };
        if (reconciled.state === "ambiguous") {
          await markAmbiguousAttempt(id, lease.ownerToken, attempt.attemptId);
          return { ok: false, reason: "error", message: "summarize_ambiguous" };
        }
      } catch {
        await markAmbiguousAttempt(id, lease.ownerToken, attempt.attemptId).catch(() => {});
        return { ok: false, reason: "error", message: "summarize_ambiguous" };
      }
    }
    const failure = error instanceof SummarizePublishError
      ? {
          code: "summary_failed",
          message: "요약 산출물을 안전하게 저장하지 못했습니다",
          action: "retry_summary" as const,
        }
      : classifyLlmFailure(error, adapter.provider);
    try {
      const durability = await failMatchingAttempt(id, lease.ownerToken, attempt, failure);
      if (durability === "durable" || durability === "best_effort") {
        await discardSummarizeAttempt(id, lease.ownerToken, attempt.attemptId).catch(() => {});
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

export async function runSummarize(
  id: string,
  options: { force?: boolean } = {},
): Promise<SummarizeResult> {
  const prepared = await prepareSummarize(id, options.force === true, false);
  if (!("lease" in prepared)) return prepared;
  return executePreparedSummarize(id, prepared);
}

export async function acceptSummarize(
  id: string,
  options: { force?: boolean } = {},
): Promise<SummarizeAcceptance> {
  const prepared = await prepareSummarize(id, options.force === true, true);
  if (!("lease" in prepared)) {
    return { accepted: false, reason: prepared.reason };
  }
  void executePreparedSummarize(id, prepared).catch(() => {});
  return {
    accepted: true,
    durability: prepared.acceptanceDurability,
  };
}
