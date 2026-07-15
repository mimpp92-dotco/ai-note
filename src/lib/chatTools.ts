import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  CHAT_BUDGETS,
  CHAT_RESULT_LIMITS,
  CHAT_TOOL_ERROR_CODES,
  CHAT_TOOL_NAMES,
  CHAT_WARNING_CODES,
  chatToolCallSchema,
  chatToolResultSchema,
  type ChatMode,
  type ChatSearchFilters,
  type ChatToolCall,
  type ChatToolErrorCode,
  type ChatToolResult,
  type ChatWarning,
} from "@/domain/chat";
import type { ContentRevision, MeetingStatus } from "@/domain/meeting";
import type { KnowledgeCardReadResult } from "@/lib/knowledgeIndexRepository";
import { createKnowledgeIndexRepository } from "@/lib/knowledgeIndexRepository";
import {
  createMeetingSearchSources,
  MeetingSearchRetryError,
  normalizeSearchText,
  searchStoredMeetings,
  type MeetingSearchInput,
  type MeetingSearchLocation,
  type MeetingSearchResponse,
  type SearchLiveSnapshotReadResult,
} from "@/lib/meetingSearch";
import { acquireArtifactReadLease } from "@/lib/artifactLease";
import type { ArtifactGenerationLease } from "@/lib/artifactLease";
import type { ArtifactPairReadResult } from "@/lib/artifactPair";
import { isSafeId } from "@/lib/meetingId";
import {
  inspectMeetingTombstone,
  type MeetingTombstoneObservation,
} from "@/lib/meetingTombstone";
import { dataRoot, meetingPaths } from "@/lib/paths";
import { readStatus } from "@/lib/status";
import { collectTranscriptCandidates } from "@/lib/transcriptSearch";
import {
  readUserProfile,
  type UserProfileReadState,
} from "@/lib/userProfile";

const MAX_INTERNAL_ARTIFACT_BYTES = 4 * 1024 * 1024;

const TOOL_ERROR_MESSAGES: Record<ChatToolErrorCode, string> = {
  unknown_tool: "지원하지 않는 도구입니다",
  invalid_arguments: "도구 요청 내용을 확인할 수 없습니다",
  invalid_meeting_id: "회의 식별자를 확인할 수 없습니다",
  duplicate_meeting_id: "같은 회의가 중복되었습니다",
  budget_exhausted: "도구 읽기 예산을 모두 사용했습니다",
  aggregate_budget_exhausted: "도구 출력 예산을 모두 사용했습니다",
  profile_unavailable: "내 정보를 안전하게 읽을 수 없습니다",
  index_unavailable: "검색 데이터를 사용할 수 없습니다",
  search_retry: "회의 구성이 변경되어 다시 검색해야 합니다",
  meeting_deleted: "삭제된 회의입니다",
  delete_state_ambiguous: "회의 삭제 상태를 안전하게 확인할 수 없습니다",
  artifact_missing: "회의 자료를 찾을 수 없습니다",
  artifact_unavailable: "회의 자료를 안전하게 읽을 수 없습니다",
  card_stale: "회의 검색 자료가 최신 상태가 아닙니다",
  card_corrupt: "회의 검색 자료를 안전하게 읽을 수 없습니다",
  invalid_cursor: "전사 검색 위치를 확인할 수 없습니다",
  transcript_too_large: "전체 전사가 커서 구간 검색이 필요합니다",
};

export type ChatEvidenceTier =
  | "search"
  | "card"
  | "summary"
  | "transcript_chunk"
  | "full_transcript";

export interface ChatLiveMeeting {
  meetingId: string;
  currentTitle: string;
  status: MeetingStatus;
  startedAt: string;
  location: MeetingSearchLocation | null;
  reviewParticipants: string[];
}

export interface ChatEvidenceEntry {
  meetingId: string;
  tiers: ChatEvidenceTier[];
  truncated: boolean;
}

export interface ChatCheckedScope {
  searchResults: number;
  knowledgeCards: number;
  summaries: number;
  transcriptWindows: number;
  fullTranscripts: number;
  distinctMeetings: number;
}

export interface ChatSearchReplay {
  query: string;
  filters: ChatSearchFilters;
  limit: number;
  resultCount: number;
}

export interface ChatToolBudgetUsage {
  knowledgeCardsUsed: number;
  summariesUsed: number;
  transcriptWindowsUsed: number;
  fullTranscriptsUsed: number;
  transcriptScansUsed: number;
  aggregateToolOutputCharsUsed: number;
}

export interface ChatEvidenceSnapshot {
  evidence: ChatEvidenceEntry[];
  checkedScope: ChatCheckedScope;
  warnings: ChatWarning[];
  searchReplay?: ChatSearchReplay;
  budget: ChatToolBudgetUsage;
}

export interface ChatToolDependencies {
  readUserProfile(): Promise<UserProfileReadState>;
  searchMeetings(input: MeetingSearchInput): Promise<MeetingSearchResponse>;
  readKnowledgeCard(meetingId: string): Promise<KnowledgeCardReadResult>;
  readArtifactPair(meetingId: string): Promise<ArtifactPairReadResult>;
  inspectTombstone(meetingId: string): Promise<MeetingTombstoneObservation>;
  acquireArtifactReadLease(meetingId: string): Promise<ArtifactGenerationLease | { release(): unknown }>;
  readLiveSnapshot(): Promise<SearchLiveSnapshotReadResult>;
}

export interface ChatToolExecutorOptions {
  mode: ChatMode;
  now?: () => Date;
  runtimeTimezone?: () => string;
  dependencies?: ChatToolDependencies;
}

export interface ChatToolExecutor {
  execute(input: unknown): Promise<ChatToolResult>;
  snapshot(): ChatEvidenceSnapshot;
  revalidateMeetings(meetingIds: readonly string[]): Promise<Map<string, ChatLiveMeeting>>;
  inspectPersonalization(): Promise<"configured" | "missing" | "unavailable">;
}

export class ChatToolError extends Error {
  readonly code: ChatToolErrorCode;

  constructor(code: ChatToolErrorCode) {
    super(code);
    this.name = "ChatToolError";
    this.code = code;
  }
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function sliceCharacters(value: string, maximum: number): { text: string; truncated: boolean } {
  const characters = Array.from(value);
  if (characters.length <= maximum) return { text: value, truncated: false };
  return { text: characters.slice(0, maximum).join(""), truncated: true };
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function runtimeTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezone && validTimezone(timezone) ? timezone : "UTC";
  } catch {
    return "UTC";
  }
}

function localDateTime(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`
    + `T${byType.get("hour")}:${byType.get("minute")}:${byType.get("second")}`;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

interface BoundedTextArtifact {
  bytes: Uint8Array;
  text: string;
}

async function readBoundedText(path: string): Promise<BoundedTextArtifact | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INTERNAL_ARTIFACT_BYTES) {
      throw new Error("unsafe_artifact");
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_INTERNAL_ARTIFACT_BYTES) throw new Error("unsafe_artifact");
    return {
      bytes,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readPairUnderHeldLease(meetingId: string): Promise<ArtifactPairReadResult> {
  try {
    const paths = meetingPaths(meetingId);
    const transcriptArtifact = await readBoundedText(paths.transcript);
    const summaryArtifact = await readBoundedText(paths.summary);
    if (transcriptArtifact === null && summaryArtifact === null) {
      return {
        transcript: null,
        summary: null,
        state: "missing",
        revision: null,
        contentRevision: null,
        summaryOutdated: null,
      };
    }
    if (transcriptArtifact === null || summaryArtifact === null) {
      return {
        transcript: null,
        summary: null,
        state: "ambiguous",
        revision: null,
        contentRevision: null,
        summaryOutdated: null,
      };
    }
    const revision = {
      transcriptSha256: createHash("sha256").update(transcriptArtifact.bytes).digest("hex"),
      summarySha256: createHash("sha256").update(summaryArtifact.bytes).digest("hex"),
    };
    const status = await readStatus(meetingId);
    if (!status) {
      return {
        transcript: null,
        summary: null,
        state: "ambiguous",
        revision,
        contentRevision: null,
        summaryOutdated: null,
      };
    }
    const contentRevision: ContentRevision = status.contentRevision ?? {
      transcript: {
        source: "generated",
        sha256: revision.transcriptSha256,
        updatedAt: status.updatedAt,
      },
      summary: {
        source: "generated",
        sha256: revision.summarySha256,
        basedOnTranscriptSha256: revision.transcriptSha256,
        updatedAt: status.updatedAt,
      },
    };
    if (
      contentRevision.transcript.sha256 !== revision.transcriptSha256
      || contentRevision.summary.sha256 !== revision.summarySha256
    ) {
      return {
        transcript: null,
        summary: null,
        state: "source_conflict",
        revision,
        contentRevision: null,
        summaryOutdated: null,
      };
    }
    if (status.summarizeAttempt !== undefined) {
      return {
        transcript: null,
        summary: null,
        state: "active",
        revision,
        contentRevision,
        summaryOutdated:
          contentRevision.summary.basedOnTranscriptSha256
          !== contentRevision.transcript.sha256,
      };
    }
    return {
      transcript: transcriptArtifact.text,
      summary: summaryArtifact.text,
      state: "stable",
      revision,
      contentRevision,
      summaryOutdated:
        contentRevision.summary.basedOnTranscriptSha256
        !== contentRevision.transcript.sha256,
    };
  } catch {
    return {
      transcript: null,
      summary: null,
      state: "ambiguous",
      revision: null,
      contentRevision: null,
      summaryOutdated: null,
    };
  }
}

function defaultDependencies(): ChatToolDependencies {
  const searchSources = createMeetingSearchSources();
  const knowledgeRepository = createKnowledgeIndexRepository({ dataRoot: dataRoot() });
  return {
    readUserProfile,
    searchMeetings: (input) => searchStoredMeetings(input),
    readKnowledgeCard: (meetingId) => knowledgeRepository.readKnowledgeCard(meetingId),
    readArtifactPair: readPairUnderHeldLease,
    inspectTombstone: (meetingId) => inspectMeetingTombstone(meetingId),
    acquireArtifactReadLease: (meetingId) => acquireArtifactReadLease(meetingId),
    readLiveSnapshot: () => searchSources.readLiveSnapshot(),
  };
}

function publicLiveMeeting(record: {
  meetingId: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
  location: MeetingSearchLocation | null;
  reviewParticipants: string[];
}): ChatLiveMeeting {
  return {
    meetingId: record.meetingId,
    currentTitle: record.title,
    status: record.status,
    startedAt: record.startedAt,
    location: record.location ? {
      workspaceId: record.location.workspaceId,
      folderId: record.location.folderId,
      breadcrumb: [...record.location.breadcrumb],
    } : null,
    reviewParticipants: [...record.reviewParticipants],
  };
}

function unavailableReason(
  observation: MeetingTombstoneObservation,
): "meeting_deleted" | "delete_state_ambiguous" | null {
  if (observation.state === "deleted") return "meeting_deleted";
  if (observation.state === "ambiguous") return "delete_state_ambiguous";
  return null;
}

interface EvidenceToRecord {
  meetingId: string;
  tier: ChatEvidenceTier;
  truncated: boolean;
}

interface CursorState {
  meetingId: string;
  query: string;
  nextWindow: number;
}

export function createChatToolExecutor(options: ChatToolExecutorOptions): ChatToolExecutor {
  const budget = CHAT_BUDGETS[options.mode];
  const dependencies = options.dependencies ?? defaultDependencies();
  const startedAt = (options.now ?? (() => new Date()))();
  const requestedRuntimeTimezone = (options.runtimeTimezone ?? runtimeTimezone)();
  const requestTimezone = validTimezone(requestedRuntimeTimezone) ? requestedRuntimeTimezone : "UTC";

  const warnings = new Set<ChatWarning>();
  const evidence = new Map<string, { tiers: Set<ChatEvidenceTier>; truncated: boolean }>();
  const checkedMeetings = new Set<string>();
  const cursors = new Map<string, CursorState>();
  let nextCursor = 0;
  let searchReplay: ChatSearchReplay | undefined;
  const checkedScope: Omit<ChatCheckedScope, "distinctMeetings"> = {
    searchResults: 0,
    knowledgeCards: 0,
    summaries: 0,
    transcriptWindows: 0,
    fullTranscripts: 0,
  };
  const usage: ChatToolBudgetUsage = {
    knowledgeCardsUsed: 0,
    summariesUsed: 0,
    transcriptWindowsUsed: 0,
    fullTranscriptsUsed: 0,
    transcriptScansUsed: 0,
    aggregateToolOutputCharsUsed: 0,
  };

  let profileRead: Promise<
    | { state: "configured"; value: Extract<UserProfileReadState, { configured: true }> }
    | { state: "missing"; value: Extract<UserProfileReadState, { configured: false }> }
    | { state: "unavailable" }
  > | null = null;

  const loadProfile = () => {
    profileRead ??= dependencies.readUserProfile().then((value) => (
      value.configured
        ? { state: "configured" as const, value }
        : { state: "missing" as const, value }
    )).catch(() => ({ state: "unavailable" as const }));
    return profileRead;
  };

  const addWarning = (warning: ChatWarning) => warnings.add(warning);

  const recordEvidence = (entries: readonly EvidenceToRecord[]) => {
    for (const entry of entries) {
      const current = evidence.get(entry.meetingId) ?? { tiers: new Set<ChatEvidenceTier>(), truncated: false };
      current.tiers.add(entry.tier);
      current.truncated ||= entry.truncated;
      evidence.set(entry.meetingId, current);
      checkedMeetings.add(entry.meetingId);
      if (entry.truncated) addWarning("truncated_evidence");
    }
  };

  const consumeResult = (result: ChatToolResult): boolean => {
    const size = JSON.stringify(result).length;
    if (usage.aggregateToolOutputCharsUsed + size > budget.aggregateToolOutputChars) return false;
    usage.aggregateToolOutputCharsUsed += size;
    return true;
  };

  const buildError = (
    call: ChatToolCall,
    code: ChatToolErrorCode,
    budgetExhausted = false,
  ): ChatToolResult => chatToolResultSchema.parse({
    callId: call.callId,
    name: call.name,
    status: "error",
    error: { code, message: TOOL_ERROR_MESSAGES[code] },
    truncated: false,
    budgetExhausted,
  });

  const errorResult = (
    call: ChatToolCall,
    code: ChatToolErrorCode,
    budgetExhausted = false,
  ): ChatToolResult => {
    if (budgetExhausted) addWarning("budget_exhausted");
    const result = buildError(call, code, budgetExhausted);
    consumeResult(result);
    return result;
  };

  const successResult = (
    call: ChatToolCall,
    data: unknown,
    entries: readonly EvidenceToRecord[] = [],
    truncated = false,
  ): ChatToolResult => {
    const result = chatToolResultSchema.parse({
      callId: call.callId,
      name: call.name,
      status: "ok",
      data,
      truncated,
      budgetExhausted: false,
    });
    if (!consumeResult(result)) {
      addWarning("budget_exhausted");
      return errorResult(call, "aggregate_budget_exhausted", true);
    }
    if (truncated) addWarning("truncated_evidence");
    recordEvidence(entries);
    return result;
  };

  const reserve = (
    key: "knowledgeCardsUsed" | "summariesUsed" | "transcriptWindowsUsed" | "fullTranscriptsUsed",
    amount: number,
    maximum: number,
  ) => {
    if (usage[key] + amount > maximum) throw new ChatToolError("budget_exhausted");
    usage[key] += amount;
  };

  const uniqueMeetingIds = (ids: readonly string[]): string[] => {
    if (ids.some((meetingId) => !isSafeId(meetingId))) throw new ChatToolError("invalid_meeting_id");
    if (new Set(ids).size !== ids.length) throw new ChatToolError("duplicate_meeting_id");
    return [...ids];
  };

  const artifactRead = async <T>(
    meetingId: string,
    reader: () => Promise<T>,
  ): Promise<{ status: "ready"; value: T } | { status: "unavailable"; reason: ChatToolErrorCode }> => {
    if (!isSafeId(meetingId)) return { status: "unavailable", reason: "invalid_meeting_id" };
    let first: MeetingTombstoneObservation;
    try {
      first = await dependencies.inspectTombstone(meetingId);
    } catch {
      return { status: "unavailable", reason: "delete_state_ambiguous" };
    }
    const firstReason = unavailableReason(first);
    if (firstReason) return { status: "unavailable", reason: firstReason };

    let lease: ArtifactGenerationLease | { release(): unknown };
    try {
      lease = await dependencies.acquireArtifactReadLease(meetingId);
    } catch {
      return { status: "unavailable", reason: "artifact_unavailable" };
    }
    try {
      let second: MeetingTombstoneObservation;
      try {
        second = await dependencies.inspectTombstone(meetingId);
      } catch {
        return { status: "unavailable", reason: "delete_state_ambiguous" };
      }
      const secondReason = unavailableReason(second);
      if (secondReason) return { status: "unavailable", reason: secondReason };
      try {
        return { status: "ready", value: await reader() };
      } catch {
        return { status: "unavailable", reason: "artifact_unavailable" };
      }
    } finally {
      lease.release();
    }
  };

  const currentMeetings = async (meetingIds: readonly string[]): Promise<Map<string, ChatLiveMeeting>> => {
    let liveRead: SearchLiveSnapshotReadResult;
    try {
      liveRead = await dependencies.readLiveSnapshot();
    } catch {
      return new Map();
    }
    if (liveRead.mode !== "ready") return new Map();
    const wanted = new Set(meetingIds);
    return new Map(liveRead.snapshot.records.flatMap((record) => (
      wanted.has(record.meetingId) && !record.summarizeAttemptPending
        ? [[record.meetingId, publicLiveMeeting(record)] as const]
        : []
    )));
  };

  const handleProfile = async (call: Extract<ChatToolCall, { name: "get_user_profile" }>) => {
    const profile = await loadProfile();
    if (profile.state === "unavailable") {
      addWarning("profile_unavailable");
      return errorResult(call, "profile_unavailable");
    }
    if (profile.state === "missing") {
      return successResult(call, {
        configured: false,
        runtimeTimezone: requestTimezone,
        weekStartsOn: profile.value.defaults.weekStartsOn,
        currentLocalDateTime: localDateTime(startedAt, requestTimezone),
      });
    }
    const timezone = profile.value.profile.timezone;
    return successResult(call, {
      configured: true,
      profile: profile.value.profile,
      currentLocalDateTime: localDateTime(startedAt, timezone),
    });
  };

  const handleSearch = async (call: Extract<ChatToolCall, { name: "search_meetings" }>) => {
    let response: MeetingSearchResponse;
    try {
      response = await dependencies.searchMeetings({
        query: call.arguments.query,
        ...(call.arguments.filters ? { filters: call.arguments.filters } : {}),
        limit: call.arguments.limit ?? 20,
      });
    } catch (error) {
      return errorResult(call, error instanceof MeetingSearchRetryError ? "search_retry" : "index_unavailable");
    }
    if (response.index.status === "unavailable") return errorResult(call, "index_unavailable");
    if (response.index.status === "partial") addWarning("index_partial");
    if (response.index.reasons.includes("stale")) addWarning("stale_evidence");
    if (response.hasMore) addWarning("candidate_limit_reached");
    checkedScope.searchResults += response.results.length;
    for (const result of response.results) checkedMeetings.add(result.meetingId);
    searchReplay = {
      query: response.query,
      filters: call.arguments.filters ?? {},
      limit: call.arguments.limit ?? 20,
      resultCount: response.results.length,
    };
    return successResult(call, response, response.results.map((result) => ({
      meetingId: result.meetingId,
      tier: "search" as const,
      truncated: false,
    })));
  };

  const handleSearchTranscripts = async (
    call: Extract<ChatToolCall, { name: "search_transcripts" }>,
  ) => {
    let liveRead: SearchLiveSnapshotReadResult;
    try {
      liveRead = await dependencies.readLiveSnapshot();
    } catch {
      return errorResult(call, "index_unavailable");
    }
    if (liveRead.mode !== "ready") return errorResult(call, "index_unavailable");

    // Only meetings past transcription can carry a transcript.md. Recent-first so
    // that a scan bounded by transcriptScans favors the most likely answers.
    const scannable = liveRead.snapshot.records
      .filter((record) => record.status !== "recording" && record.status !== "recorded")
      .sort((left, right) => (
        Date.parse(right.startedAt) - Date.parse(left.startedAt)
        || left.meetingId.localeCompare(right.meetingId, "en")
      ));

    const remaining = budget.transcriptScans - usage.transcriptScansUsed;
    if (remaining <= 0) return errorResult(call, "budget_exhausted", true);
    const targeted = scannable.slice(0, remaining);
    usage.transcriptScansUsed += targeted.length;
    const scanBudgetReached = scannable.length > targeted.length;

    const metaById = new Map(targeted.map((record) => [record.meetingId, record]));
    const inputs = await Promise.all(targeted.map(async (record) => {
      const read = await artifactRead(
        record.meetingId,
        () => dependencies.readArtifactPair(record.meetingId),
      );
      const transcript = read.status === "ready" && read.value.state === "stable"
        ? read.value.transcript
        : null;
      return {
        meetingId: record.meetingId,
        transcript,
        summaryOutdated: read.status === "ready" && read.value.state === "stable"
          ? read.value.summaryOutdated === true
          : false,
      };
    }));

    if (inputs.some((input) => input.transcript !== null && input.summaryOutdated)) {
      addWarning("stale_evidence");
    }

    const discovery = collectTranscriptCandidates(inputs, call.arguments.query, {
      limit: call.arguments.limit ?? 10,
    });
    if (scanBudgetReached || discovery.hasMore) addWarning("candidate_limit_reached");

    const candidates = discovery.candidates.map((candidate) => {
      const meta = metaById.get(candidate.meetingId)!;
      checkedMeetings.add(candidate.meetingId);
      return {
        meetingId: candidate.meetingId,
        title: meta.title,
        startedAt: meta.startedAt,
        matchedKeywords: candidate.matchedKeywords,
        snippets: candidate.snippets,
      };
    });
    // Discovery is not citation credit (ADR 0018): record only the non-read
    // "search" tier so the model must re-read a meeting to ground a claim.
    return successResult(call, {
      query: call.arguments.query,
      keywords: discovery.keywords,
      candidates,
      hasMore: discovery.hasMore,
    }, candidates.map((candidate) => ({
      meetingId: candidate.meetingId,
      tier: "search" as const,
      truncated: false,
    })));
  };

  const handleCards = async (call: Extract<ChatToolCall, { name: "read_knowledge_cards" }>) => {
    const ids = uniqueMeetingIds(call.arguments.meetingIds);
    reserve("knowledgeCardsUsed", ids.length, budget.knowledgeCards);
    const reads = await Promise.all(ids.map(async (meetingId) => ({
      meetingId,
      read: await artifactRead(meetingId, () => dependencies.readKnowledgeCard(meetingId)),
    })));
    const live = await currentMeetings(ids);
    const entries: EvidenceToRecord[] = [];
    let anyTruncated = false;
    const items = reads.map(({ meetingId, read }) => {
      if (read.status === "unavailable") {
        return { meetingId, status: "unavailable" as const, reason: read.reason };
      }
      if (read.value.mode !== "ready") {
        const reason = read.value.mode === "missing"
          ? "artifact_missing" as const
          : read.value.mode === "stale"
            ? "card_stale" as const
            : read.value.mode === "corrupt"
              ? "card_corrupt" as const
              : "artifact_unavailable" as const;
        if (reason === "card_stale") addWarning("stale_evidence");
        return { meetingId, status: "unavailable" as const, reason };
      }
      const metadata = live.get(meetingId);
      if (!metadata) return { meetingId, status: "unavailable" as const, reason: "artifact_unavailable" as const };
      const serialized = JSON.stringify({
        meetingId,
        metadata,
        content: read.value.card.content,
        actionItems: read.value.card.actionItems,
        mentionedPeople: read.value.card.mentionedPeople,
      });
      const bounded = sliceCharacters(serialized, CHAT_RESULT_LIMITS.knowledgeCardChars);
      anyTruncated ||= bounded.truncated;
      entries.push({ meetingId, tier: "card", truncated: bounded.truncated });
      checkedScope.knowledgeCards += 1;
      checkedMeetings.add(meetingId);
      return {
        meetingId,
        status: "ready" as const,
        cardJson: bounded.text,
        truncated: bounded.truncated,
      };
    });
    return successResult(call, { items }, entries, anyTruncated);
  };

  const handleSummaries = async (call: Extract<ChatToolCall, { name: "read_summaries" }>) => {
    const ids = uniqueMeetingIds(call.arguments.meetingIds);
    reserve("summariesUsed", ids.length, budget.summaries);
    const reads = await Promise.all(ids.map(async (meetingId) => ({
      meetingId,
      read: await artifactRead(meetingId, () => dependencies.readArtifactPair(meetingId)),
    })));
    const live = await currentMeetings(ids);
    const entries: EvidenceToRecord[] = [];
    let anyTruncated = false;
    const items = reads.map(({ meetingId, read }) => {
      if (read.status === "unavailable") {
        return { meetingId, status: "unavailable" as const, reason: read.reason };
      }
      if (read.value.state === "missing") {
        return { meetingId, status: "unavailable" as const, reason: "artifact_missing" as const };
      }
      if (read.value.state !== "stable") {
        addWarning("stale_evidence");
        return { meetingId, status: "unavailable" as const, reason: "artifact_unavailable" as const };
      }
      if (read.value.summary === null) {
        return { meetingId, status: "unavailable" as const, reason: "artifact_missing" as const };
      }
      if (read.value.summaryOutdated === true) {
        addWarning("stale_evidence");
        return { meetingId, status: "unavailable" as const, reason: "card_stale" as const };
      }
      const metadata = live.get(meetingId);
      if (!metadata) return { meetingId, status: "unavailable" as const, reason: "artifact_unavailable" as const };
      const bounded = sliceCharacters(read.value.summary, CHAT_RESULT_LIMITS.summaryChars);
      anyTruncated ||= bounded.truncated;
      entries.push({ meetingId, tier: "summary", truncated: bounded.truncated });
      checkedScope.summaries += 1;
      checkedMeetings.add(meetingId);
      return {
        meetingId,
        status: "ready" as const,
        metadata,
        summary: bounded.text,
        truncated: bounded.truncated,
      };
    });
    return successResult(call, { items }, entries, anyTruncated);
  };

  const transcriptWindows = (transcript: string, query: string) => {
    const characters = Array.from(transcript);
    const normalizedTranscript = transcript.normalize("NFKC").toLowerCase();
    const normalizedQuery = query.normalize("NFKC").toLowerCase().trim();
    const needles = normalizedQuery
      ? [normalizedQuery]
      : normalizeSearchText(query).split(" ").filter(Boolean);
    const matches: number[] = [];
    for (const needle of needles) {
      let from = 0;
      while (needle && from <= normalizedTranscript.length) {
        const codeUnitIndex = normalizedTranscript.indexOf(needle, from);
        if (codeUnitIndex < 0) break;
        matches.push(Array.from(normalizedTranscript.slice(0, codeUnitIndex)).length);
        from = codeUnitIndex + Math.max(1, needle.length);
      }
      if (matches.length > 0) break;
    }
    matches.sort((left, right) => left - right);
    const windows: Array<{ start: number; end: number; text: string }> = [];
    let previousEnd = 0;
    for (const match of matches) {
      if (match < previousEnd) continue;
      let start = Math.max(previousEnd, match - Math.floor(CHAT_RESULT_LIMITS.transcriptWindowChars / 2));
      const end = Math.min(characters.length, start + CHAT_RESULT_LIMITS.transcriptWindowChars);
      if (end === characters.length) {
        start = Math.max(previousEnd, end - CHAT_RESULT_LIMITS.transcriptWindowChars);
      }
      if (end <= start) continue;
      windows.push({ start, end, text: characters.slice(start, end).join("") });
      previousEnd = end;
    }
    return windows;
  };

  const handleTranscriptChunks = async (
    call: Extract<ChatToolCall, { name: "read_transcript_chunks" }>,
  ) => {
    const limit = call.arguments.limit ?? 3;
    reserve("transcriptWindowsUsed", limit, budget.transcriptWindows);
    let startWindow = 0;
    if (call.arguments.cursor !== undefined) {
      const cursor = cursors.get(call.arguments.cursor);
      if (
        !cursor
        || cursor.meetingId !== call.arguments.meetingId
        || cursor.query !== call.arguments.query
      ) return errorResult(call, "invalid_cursor");
      startWindow = cursor.nextWindow;
    }
    const read = await artifactRead(
      call.arguments.meetingId,
      () => dependencies.readArtifactPair(call.arguments.meetingId),
    );
    if (read.status === "unavailable") return errorResult(call, read.reason);
    if (read.value.state === "missing") return errorResult(call, "artifact_missing");
    if (read.value.state !== "stable") {
      addWarning("stale_evidence");
      return errorResult(call, "artifact_unavailable");
    }
    if (read.value.transcript === null) return errorResult(call, "artifact_missing");
    if (read.value.summaryOutdated === true) addWarning("stale_evidence");
    const allWindows = transcriptWindows(read.value.transcript, call.arguments.query);
    const windows = allWindows.slice(startWindow, startWindow + limit);
    let next: string | undefined;
    if (startWindow + windows.length < allWindows.length) {
      nextCursor += 1;
      const digest = createHash("sha256")
        .update(`${call.arguments.meetingId}\0${call.arguments.query}\0${startWindow + windows.length}\0${nextCursor}`)
        .digest("hex")
        .slice(0, 12);
      next = `cursor-${nextCursor}-${digest}`;
      cursors.set(next, {
        meetingId: call.arguments.meetingId,
        query: call.arguments.query,
        nextWindow: startWindow + windows.length,
      });
    }
    checkedScope.transcriptWindows += windows.length;
    if (windows.length > 0) checkedMeetings.add(call.arguments.meetingId);
    return successResult(call, {
      meetingId: call.arguments.meetingId,
      query: call.arguments.query,
      windows,
      ...(next ? { nextCursor: next } : {}),
    }, windows.length > 0 ? [{
      meetingId: call.arguments.meetingId,
      tier: "transcript_chunk",
      truncated: false,
    }] : []);
  };

  const handleFullTranscript = async (
    call: Extract<ChatToolCall, { name: "read_full_transcript" }>,
  ) => {
    reserve("fullTranscriptsUsed", 1, budget.fullTranscripts);
    const read = await artifactRead(
      call.arguments.meetingId,
      () => dependencies.readArtifactPair(call.arguments.meetingId),
    );
    if (read.status === "unavailable") return errorResult(call, read.reason);
    if (read.value.state === "missing") return errorResult(call, "artifact_missing");
    if (read.value.state !== "stable") {
      addWarning("stale_evidence");
      return errorResult(call, "artifact_unavailable");
    }
    if (read.value.transcript === null) return errorResult(call, "artifact_missing");
    if (read.value.summaryOutdated === true) addWarning("stale_evidence");
    if (characterLength(read.value.transcript) > CHAT_RESULT_LIMITS.fullTranscriptChars) {
      return errorResult(call, "transcript_too_large");
    }
    const live = await currentMeetings([call.arguments.meetingId]);
    const metadata = live.get(call.arguments.meetingId);
    if (!metadata) return errorResult(call, "artifact_unavailable");
    const data = {
      meetingId: call.arguments.meetingId,
      metadata,
      transcript: read.value.transcript,
    };
    const prospective = chatToolResultSchema.parse({
      callId: call.callId,
      name: call.name,
      status: "ok",
      data,
      truncated: false,
      budgetExhausted: false,
    });
    if (
      usage.aggregateToolOutputCharsUsed + JSON.stringify(prospective).length
      > budget.aggregateToolOutputChars
    ) return errorResult(call, "aggregate_budget_exhausted", true);
    checkedScope.fullTranscripts += 1;
    checkedMeetings.add(call.arguments.meetingId);
    return successResult(call, data, [{
      meetingId: call.arguments.meetingId,
      tier: "full_transcript",
      truncated: false,
    }]);
  };

  const execute = async (input: unknown): Promise<ChatToolResult> => {
    const parsed = chatToolCallSchema.safeParse(input);
    if (!parsed.success) {
      const name = typeof input === "object" && input !== null && "name" in input
        ? (input as { name?: unknown }).name
        : undefined;
      throw new ChatToolError(
        typeof name !== "string" || !(CHAT_TOOL_NAMES as readonly string[]).includes(name)
          ? "unknown_tool"
          : "invalid_arguments",
      );
    }
    try {
      switch (parsed.data.name) {
        case "get_user_profile": return await handleProfile(parsed.data);
        case "search_meetings": return await handleSearch(parsed.data);
        case "search_transcripts": return await handleSearchTranscripts(parsed.data);
        case "read_knowledge_cards": return await handleCards(parsed.data);
        case "read_summaries": return await handleSummaries(parsed.data);
        case "read_transcript_chunks": return await handleTranscriptChunks(parsed.data);
        case "read_full_transcript": return await handleFullTranscript(parsed.data);
      }
    } catch (error) {
      const code = error instanceof ChatToolError ? error.code : "artifact_unavailable";
      return errorResult(
        parsed.data,
        code,
        code === "budget_exhausted" || code === "aggregate_budget_exhausted",
      );
    }
  };

  const snapshot = (): ChatEvidenceSnapshot => ({
    evidence: [...evidence.entries()].map(([meetingId, item]) => ({
      meetingId,
      tiers: (["search", "card", "summary", "transcript_chunk", "full_transcript"] as const)
        .filter((tier) => item.tiers.has(tier)),
      truncated: item.truncated,
    })),
    checkedScope: { ...checkedScope, distinctMeetings: checkedMeetings.size },
    warnings: CHAT_WARNING_CODES.filter((warning) => warnings.has(warning)),
    ...(searchReplay ? { searchReplay: { ...searchReplay, filters: { ...searchReplay.filters } } } : {}),
    budget: { ...usage },
  });

  const revalidateMeetings = async (
    meetingIds: readonly string[],
  ): Promise<Map<string, ChatLiveMeeting>> => {
    const ids = [...new Set(meetingIds.filter(isSafeId))];
    const live = await currentMeetings(ids);
    const result = new Map<string, ChatLiveMeeting>();
    for (const meetingId of ids) {
      try {
        const tombstone = await dependencies.inspectTombstone(meetingId);
        if (tombstone.state === "none") {
          const metadata = live.get(meetingId);
          if (metadata) result.set(meetingId, metadata);
        }
      } catch {
        // Final citation validation is fail-closed.
      }
    }
    return result;
  };

  return {
    execute,
    snapshot,
    revalidateMeetings,
    async inspectPersonalization() {
      const profile = await loadProfile();
      return profile.state;
    },
  };
}

export function chatToolErrorResult(
  call: ChatToolCall,
  error: unknown,
): ChatToolResult {
  const code = error instanceof ChatToolError && CHAT_TOOL_ERROR_CODES.includes(error.code)
    ? error.code
    : "invalid_arguments";
  return chatToolResultSchema.parse({
    callId: call.callId,
    name: call.name,
    status: "error",
    error: { code, message: TOOL_ERROR_MESSAGES[code] },
    truncated: false,
    budgetExhausted: code === "budget_exhausted" || code === "aggregate_budget_exhausted",
  });
}

export function isChatToolName(value: string): value is typeof CHAT_TOOL_NAMES[number] {
  return (CHAT_TOOL_NAMES as readonly string[]).includes(value);
}

export function isChatWarning(value: string): value is ChatWarning {
  return (CHAT_WARNING_CODES as readonly string[]).includes(value);
}
