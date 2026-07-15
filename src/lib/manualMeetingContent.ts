import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  ContentRevision,
  SummarizeAttempt,
} from "@/domain/meeting";
import type { EditableSummary, Summary } from "@/domain/summary";
import {
  editableSummarySchema,
  summarySchema,
} from "@/domain/summarySchema";
import {
  readArtifactPair,
  type ArtifactPairReadResult,
  type ArtifactPairRevision,
} from "@/lib/artifactPair";
import {
  createKnowledgeIndexRepository,
  type KnowledgeIndexRepository,
} from "@/lib/knowledgeIndexRepository";
import {
  tryAcquireMeetingOperation,
  type MeetingOperationLease,
} from "@/lib/meetingLifecycle";
import { dataRoot } from "@/lib/paths";
import { readStatus, updateStatus } from "@/lib/status";
import {
  publishManualMeetingContentAttempt,
  reconcileSummarizeAttempt,
  type SummarizePublisherOptions,
} from "@/lib/summarizePublisher";

export const MAX_MANUAL_TRANSCRIPT_BYTES = 1024 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const artifactPairRevisionSchema = z.object({
  transcriptSha256: sha256Schema,
  summarySha256: sha256Schema,
}).strict();

export const manualTranscriptRequestSchema = z.object({
  expectedRevision: artifactPairRevisionSchema,
  transcript: z.string(),
}).strict();

export const manualSummaryRequestSchema = z.object({
  expectedRevision: artifactPairRevisionSchema,
  summary: editableSummarySchema,
}).strict();

export interface ManualMeetingContentResource {
  transcript: string;
  summary: EditableSummary;
  revision: ArtifactPairRevision;
  transcriptSource: ContentRevision["transcript"]["source"];
  summarySource: ContentRevision["summary"]["source"];
  summaryOutdated: boolean;
  pairState: "stable";
}

export type ManualMeetingContentFailureReason =
  | "not_found"
  | "revision_conflict"
  | "operation_in_progress"
  | "source_conflict"
  | "state_ambiguous"
  | "interrupted"
  | "save_unavailable"
  | "invalid_transcript"
  | "invalid_summary";

export type ManualMeetingContentReadResult =
  | { ok: true; content: ManualMeetingContentResource }
  | {
      ok: false;
      reason: ManualMeetingContentFailureReason;
      field?: "transcript" | "summary";
      operation?: string;
    };

export type ManualMeetingContentSaveResult =
  | {
      ok: true;
      content: ManualMeetingContentResource;
      durability: "durable" | "best_effort" | "pending";
    }
  | Exclude<ManualMeetingContentReadResult, { ok: true }>;

export interface SaveManualTranscriptInput {
  id: string;
  expectedRevision: ArtifactPairRevision;
  transcript: string;
}

export interface SaveManualSummaryInput {
  id: string;
  expectedRevision: ArtifactPairRevision;
  summary: EditableSummary;
}

type ManualKnowledgeRepository = Pick<KnowledgeIndexRepository, "refreshAfterSummary">;

let knowledgeRepositoryForTests: ManualKnowledgeRepository | null = null;

export function setManualMeetingContentKnowledgeIndexRepositoryForTests(
  repository: ManualKnowledgeRepository | null,
): void {
  knowledgeRepositoryForTests = repository;
}

function knowledgeRepository(): ManualKnowledgeRepository {
  return knowledgeRepositoryForTests
    ?? createKnowledgeIndexRepository({ dataRoot: dataRoot() });
}

export interface ManualMeetingContentOptions {
  now?: () => string;
  publisherOptions?: SummarizePublisherOptions;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function editableSummary(summary: Summary): EditableSummary {
  return {
    oneLine: summary.oneLine,
    purpose: summary.purpose,
    highlights: [...summary.highlights],
    discussion: [...summary.discussion],
    decisions: [...summary.decisions],
    actionItems: summary.actionItems.map((item) => ({ ...item })),
    risks: [...summary.risks],
    followups: [...summary.followups],
  };
}

function parseCanonicalSummary(text: string): Summary | null {
  try {
    return summarySchema.parse(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function resourceFromPair(pair: ArtifactPairReadResult): ManualMeetingContentResource | null {
  if (
    pair.state !== "stable"
    || pair.transcript === null
    || pair.summary === null
    || pair.revision === null
    || pair.revision === undefined
    || pair.contentRevision === null
    || pair.contentRevision === undefined
    || pair.summaryOutdated === null
    || pair.summaryOutdated === undefined
  ) return null;
  const parsedSummary = parseCanonicalSummary(pair.summary);
  if (!parsedSummary) return null;
  return {
    transcript: pair.transcript,
    summary: editableSummary(parsedSummary),
    revision: pair.revision,
    transcriptSource: pair.contentRevision.transcript.source,
    summarySource: pair.contentRevision.summary.source,
    summaryOutdated: pair.summaryOutdated,
    pairState: "stable",
  };
}

function operationForPair(pair: ArtifactPairReadResult): string | undefined {
  return pair.state === "active" ? "content_mutation" : undefined;
}

function failureForPair(
  pair: ArtifactPairReadResult,
): Exclude<ManualMeetingContentReadResult, { ok: true }> {
  if (pair.state === "missing") return { ok: false, reason: "not_found" };
  if (pair.state === "source_conflict") return { ok: false, reason: "source_conflict" };
  if (pair.state === "active") {
    return {
      ok: false,
      reason: "operation_in_progress",
      operation: operationForPair(pair),
    };
  }
  if (pair.state === "interrupted") return { ok: false, reason: "interrupted" };
  return { ok: false, reason: "state_ambiguous" };
}

export async function readManualMeetingContent(
  id: string,
): Promise<ManualMeetingContentReadResult> {
  let pair: ArtifactPairReadResult;
  try {
    pair = await readArtifactPair(id);
  } catch {
    return { ok: false, reason: "save_unavailable" };
  }
  const content = resourceFromPair(pair);
  return content ? { ok: true, content } : failureForPair(pair);
}

function sameRevision(
  left: ArtifactPairRevision,
  right: ArtifactPairRevision,
): boolean {
  return left.transcriptSha256 === right.transcriptSha256
    && left.summarySha256 === right.summarySha256;
}

function normalizeTranscript(input: string): string | null {
  const normalized = input.replace(/\r\n?/gu, "\n");
  if (normalized.trim().length === 0) return null;
  if (new TextEncoder().encode(normalized).byteLength > MAX_MANUAL_TRANSCRIPT_BYTES) return null;
  return normalized;
}

function combinedDurability(
  artifact: "durable" | "best_effort",
  status: "durable" | "best_effort" | "pending",
): "durable" | "best_effort" | "pending" {
  if (status === "pending") return "pending";
  if (artifact === "best_effort" || status === "best_effort") return "best_effort";
  return "durable";
}

interface PreparedManualEdit {
  transcript: string;
  summary: string;
  intendedContentRevision: ContentRevision;
}

async function refreshFreshSummary(
  id: string,
  lease: MeetingOperationLease,
): Promise<void> {
  try {
    await knowledgeRepository().refreshAfterSummary({
      meetingId: id,
      meetingOperationOwnerToken: lease.ownerToken,
    });
  } catch {
    // Index artifacts are derived. A fresh canonical content commit remains
    // successful even when the independent refresh is unavailable.
  }
}

async function stableContentAfterPublish(
  id: string,
): Promise<ManualMeetingContentResource | null> {
  const pair = await readArtifactPair(id);
  return resourceFromPair(pair);
}

function contentMatchesIntended(
  content: ManualMeetingContentResource,
  intended: ContentRevision,
): boolean {
  return content.revision.transcriptSha256 === intended.transcript.sha256
    && content.revision.summarySha256 === intended.summary.sha256
    && content.transcriptSource === intended.transcript.source
    && content.summarySource === intended.summary.source
    && content.summaryOutdated === (
      intended.summary.basedOnTranscriptSha256 !== intended.transcript.sha256
    );
}

async function publishManualEdit(
  id: string,
  expectedRevision: ArtifactPairRevision,
  field: "transcript" | "summary",
  prepare: (pair: ArtifactPairReadResult, now: string) => PreparedManualEdit | null,
  options: ManualMeetingContentOptions,
): Promise<ManualMeetingContentSaveResult> {
  const lease = await tryAcquireMeetingOperation(id, "manual_edit");
  if (!lease) {
    return {
      ok: false,
      reason: "operation_in_progress",
      operation: "content_mutation",
    };
  }
  try {
    const status = await readStatus(id);
    if (!status) return { ok: false, reason: "not_found" };

    let pair: ArtifactPairReadResult;
    try {
      pair = await readArtifactPair(id);
    } catch {
      return { ok: false, reason: "save_unavailable" };
    }
    if (pair.state !== "stable") return failureForPair(pair);
    if (!pair.revision || !pair.contentRevision || !sameRevision(pair.revision, expectedRevision)) {
      return pair.revision && !sameRevision(pair.revision, expectedRevision)
        ? { ok: false, reason: "revision_conflict" }
        : { ok: false, reason: "state_ambiguous" };
    }

    const now = options.now?.() ?? new Date().toISOString();
    const prepared = prepare(pair, now);
    if (!prepared) {
      return {
        ok: false,
        reason: field === "transcript" ? "invalid_transcript" : "invalid_summary",
        field,
      };
    }
    const attempt: SummarizeAttempt = {
      attemptId: randomUUID(),
      kind: "manual_edit",
      startedAt: now,
      preTranscriptHash: pair.revision.transcriptSha256,
      preSummaryHash: pair.revision.summarySha256,
      intendedContentRevision: prepared.intendedContentRevision,
    };

    let acceptance;
    try {
      acceptance = await updateStatus(id, lease.ownerToken, (latest) => ({
        ...latest,
        summarizeAttempt: attempt,
      }));
    } catch {
      return { ok: false, reason: "save_unavailable" };
    }
    if (acceptance.commit.durability === "pending") {
      return { ok: false, reason: "save_unavailable" };
    }
    if (acceptance.commit.durability === "none") {
      return { ok: false, reason: "save_unavailable" };
    }

    try {
      const publication = await publishManualMeetingContentAttempt({
        id,
        ownerToken: lease.ownerToken,
        attempt,
        transcript: prepared.transcript,
        summary: prepared.summary,
      }, options.publisherOptions);
      const content = await stableContentAfterPublish(id);
      if (!content) return { ok: false, reason: "state_ambiguous" };
      if (field === "summary") await refreshFreshSummary(id, lease);
      return {
        ok: true,
        content,
        durability: combinedDurability(
          publication.artifactDurability,
          publication.statusDurability,
        ),
      };
    } catch {
      try {
        const reconciled = await reconcileSummarizeAttempt(id, lease.ownerToken);
        if (reconciled.state === "completed") {
          const content = await stableContentAfterPublish(id);
          if (!content) return { ok: false, reason: "state_ambiguous" };
          if (field === "summary") await refreshFreshSummary(id, lease);
          return { ok: true, content, durability: "pending" };
        }
        if (reconciled.state === "interrupted") {
          return { ok: false, reason: "interrupted" };
        }
        if (reconciled.state === "ambiguous") {
          return { ok: false, reason: "state_ambiguous" };
        }
        if (reconciled.state === "none") {
          const content = await stableContentAfterPublish(id);
          if (content && contentMatchesIntended(content, prepared.intendedContentRevision)) {
            if (field === "summary") await refreshFreshSummary(id, lease);
            return { ok: true, content, durability: "pending" };
          }
          if (content && sameRevision(content.revision, expectedRevision)) {
            return { ok: false, reason: "interrupted" };
          }
          return { ok: false, reason: "state_ambiguous" };
        }
        return { ok: false, reason: "save_unavailable" };
      } catch {
        return { ok: false, reason: "save_unavailable" };
      }
    }
  } finally {
    lease.release();
  }
}

export function saveManualTranscript(
  input: SaveManualTranscriptInput,
  options: ManualMeetingContentOptions = {},
): Promise<ManualMeetingContentSaveResult> {
  const normalized = normalizeTranscript(input.transcript);
  if (normalized === null) {
    return Promise.resolve({
      ok: false,
      reason: "invalid_transcript",
      field: "transcript",
    });
  }
  return publishManualEdit(
    input.id,
    input.expectedRevision,
    "transcript",
    (pair, now) => {
      if (!pair.summary || !pair.contentRevision) return null;
      const transcriptHash = hash(normalized);
      return {
        transcript: normalized,
        summary: pair.summary,
        intendedContentRevision: {
          transcript: {
            source: "manual",
            sha256: transcriptHash,
            updatedAt: now,
          },
          summary: { ...pair.contentRevision.summary },
        },
      };
    },
    options,
  );
}

export function saveManualSummary(
  input: SaveManualSummaryInput,
  options: ManualMeetingContentOptions = {},
): Promise<ManualMeetingContentSaveResult> {
  const parsedEditable = editableSummarySchema.safeParse(input.summary);
  if (!parsedEditable.success) {
    return Promise.resolve({
      ok: false,
      reason: "invalid_summary",
      field: "summary",
    });
  }
  return publishManualEdit(
    input.id,
    input.expectedRevision,
    "summary",
    (pair, now) => {
      if (!pair.transcript || !pair.summary || !pair.contentRevision || !pair.revision) return null;
      const canonical = parseCanonicalSummary(pair.summary);
      if (!canonical) return null;
      const next = summarySchema.safeParse({ ...canonical, ...parsedEditable.data });
      if (!next.success) return null;
      const serialized = `${JSON.stringify(next.data, null, 2)}\n`;
      return {
        transcript: pair.transcript,
        summary: serialized,
        intendedContentRevision: {
          transcript: { ...pair.contentRevision.transcript },
          summary: {
            source: "manual",
            sha256: hash(serialized),
            basedOnTranscriptSha256: pair.revision.transcriptSha256,
            updatedAt: now,
          },
        },
      };
    },
    options,
  );
}
