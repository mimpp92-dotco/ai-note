import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ClassifiedMeetingRecord, LibraryDocument } from "@/domain/library";
import {
  knowledgeCardSchema,
  type CorpusMap,
  type KnowledgeCard,
} from "@/domain/knowledge";
import type { MeetingStatus } from "@/domain/meeting";
import { buildCorpusMap } from "@/lib/knowledgeIndex";
import {
  createKnowledgeIndexRepository,
  type CorpusMapReadResult,
} from "@/lib/knowledgeIndexRepository";
import { readResolvedLibraryState } from "@/lib/libraryService";
import { isSafeId } from "@/lib/meetingId";
import {
  inspectMeetingTombstone,
  type MeetingTombstoneObservation,
} from "@/lib/meetingTombstone";
import {
  dataRoot as defaultDataRoot,
  knowledgeCardPath,
} from "@/lib/paths";

const MAX_QUERY_CHARACTERS = 500;
const MAX_KNOWLEDGE_CARD_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024 * 1024;
const MAX_EXCERPT_CHARACTERS = 180;
const MAX_MATCH_REASONS = 3;

export const SEARCH_FIELD_WEIGHTS = {
  title: 120,
  topic: 100,
  oneLine: 90,
  highlights: 80,
  decisions: 75,
  actionItems: 70,
  discussion: 60,
  participants: 55,
  people: 50,
  risks: 40,
  followups: 35,
  location: 30,
  date: 20,
  status: 10,
} as const;

export const EXACT_PHRASE_BONUS = 160;

export type SearchField = keyof typeof SEARCH_FIELD_WEIGHTS;
export type SearchIndexReason = "missing" | "stale" | "corrupt" | "io_error";

const SEARCH_FIELD_LABELS: Record<SearchField, string> = {
  title: "제목",
  topic: "주제",
  oneLine: "한 줄 요약",
  highlights: "핵심 내용",
  decisions: "결정",
  actionItems: "할 일",
  discussion: "논의",
  participants: "참석자",
  people: "사람",
  risks: "리스크",
  followups: "후속",
  location: "위치",
  date: "날짜",
  status: "상태",
};

const FIELD_ORDER = Object.keys(SEARCH_FIELD_WEIGHTS) as SearchField[];
const REASON_ORDER: readonly SearchIndexReason[] = [
  "missing",
  "stale",
  "corrupt",
  "io_error",
];

const STATUS_SEARCH_TEXT: Record<MeetingStatus, string> = {
  recording: "녹음 중",
  recorded: "녹음 완료",
  transcribing: "전사 중",
  transcribed: "전사 완료 요약 대기",
  summarizing: "요약 중",
  summarized: "요약 완료",
};

export interface MeetingSearchLocation {
  workspaceId: string;
  folderId: string | null;
  breadcrumb: string[];
}

export interface SearchLiveRecord {
  meetingId: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
  location: MeetingSearchLocation | null;
  reviewParticipants: string[];
  summarizeAttemptPending: boolean;
  summaryOutdated?: boolean;
  contentRevision?: {
    transcriptSha256: string;
    summarySha256: string;
  };
}

export interface SearchLiveSnapshot {
  generation: { libraryId: string; revision: number };
  records: SearchLiveRecord[];
  invalidRecords: Array<{ meetingId: string; reason: SearchIndexReason }>;
}

export type SearchLiveSnapshotReadResult =
  | { mode: "ready"; snapshot: SearchLiveSnapshot }
  | { mode: "unavailable"; reason: SearchIndexReason };

export type SearchKnowledgeCardReadResult =
  | { mode: "ready"; card: KnowledgeCard }
  | { mode: "missing" }
  | { mode: "stale" }
  | { mode: "corrupt" }
  | { mode: "io_error" };

export interface MeetingSearchSources {
  readCorpusMap(): Promise<CorpusMapReadResult>;
  readKnowledgeCard(meetingId: string): Promise<SearchKnowledgeCardReadResult>;
  readLiveSnapshot(): Promise<SearchLiveSnapshotReadResult>;
  inspectTombstone(meetingId: string): Promise<MeetingTombstoneObservation>;
}

export interface MeetingSearchFilters {
  dateFrom?: string;
  dateTo?: string;
  workspaceId?: string;
  folderId?: string | null;
  status?: MeetingStatus;
  hasActionItem?: boolean;
}

export interface MeetingSearchInput {
  query: string;
  filters?: MeetingSearchFilters;
  limit?: number;
}

export interface MeetingSearchMatch {
  field: SearchField;
  label: string;
  excerpt: string;
}

export interface MeetingSearchResult {
  meetingId: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
  location: MeetingSearchLocation | null;
  matches: MeetingSearchMatch[];
  href: string;
}

export interface MeetingSearchIndexState {
  status: "ready" | "partial" | "unavailable";
  reasons: SearchIndexReason[];
  reindexable: boolean;
}

export interface MeetingSearchResponse {
  query: string;
  results: MeetingSearchResult[];
  hasMore: boolean;
  summaryPendingCount: number;
  index: MeetingSearchIndexState;
}

export class MeetingSearchInputError extends Error {
  readonly code: "invalid_query" | "query_too_long" | "invalid_limit" | "invalid_filter";

  constructor(code: MeetingSearchInputError["code"]) {
    super(code);
    this.name = "MeetingSearchInputError";
    this.code = code;
  }
}

export class MeetingSearchRetryError extends Error {
  readonly code = "library_generation_changed" as const;

  constructor() {
    super("library_generation_changed");
    this.name = "MeetingSearchRetryError";
  }
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{Letter}\p{Number}\p{Mark}]/u.test(value);
}

/**
 * Query/text normalization is intentionally independent of the host locale.
 * Technical punctuation is retained only when a whole run touches a word
 * character, so C++, C#, v2.1, and ai-note remain searchable tokens while a
 * standalone separator becomes whitespace.
 */
export function normalizeSearchText(value: string): string {
  const normalized = value.normalize("NFKC").toLowerCase();
  const characters = Array.from(normalized);
  const protectedTechnical = characters.map((character, index) => {
    if (!/[+#._-]/u.test(character)) return character;
    let left = index - 1;
    while (left >= 0 && /[+#._-]/u.test(characters[left])) left -= 1;
    let right = index + 1;
    while (right < characters.length && /[+#._-]/u.test(characters[right])) right += 1;
    return isWordCharacter(characters[left]) || isWordCharacter(characters[right])
      ? character
      : " ";
  }).join("");
  return protectedTechnical
    .replace(/[^\p{Letter}\p{Number}\p{Mark}+#._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateInput(input: MeetingSearchInput): {
  normalizedQuery: string;
  tokens: string[];
  filters: MeetingSearchFilters;
  limit: number;
} {
  if (typeof input.query !== "string") throw new MeetingSearchInputError("invalid_query");
  if (Array.from(input.query).length > MAX_QUERY_CHARACTERS) {
    throw new MeetingSearchInputError("query_too_long");
  }
  const normalizedQuery = normalizeSearchText(input.query);
  if (!normalizedQuery) throw new MeetingSearchInputError("invalid_query");
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new MeetingSearchInputError("invalid_limit");
  }
  const filters = input.filters ?? {};
  if (
    (filters.dateFrom !== undefined && !validCalendarDate(filters.dateFrom))
    || (filters.dateTo !== undefined && !validCalendarDate(filters.dateTo))
    || (filters.dateFrom !== undefined
      && filters.dateTo !== undefined
      && filters.dateFrom > filters.dateTo)
    || (filters.workspaceId !== undefined && filters.workspaceId.length === 0)
    || (typeof filters.folderId === "string" && filters.folderId.length === 0)
  ) throw new MeetingSearchInputError("invalid_filter");
  return {
    normalizedQuery,
    tokens: normalizedQuery.split(" "),
    filters,
    limit,
  };
}

function orderedReasons(reasons: ReadonlySet<SearchIndexReason>): SearchIndexReason[] {
  return REASON_ORDER.filter((reason) => reasons.has(reason));
}

function unavailableResponse(query: string, reason: SearchIndexReason): MeetingSearchResponse {
  return {
    query,
    results: [],
    hasMore: false,
    summaryPendingCount: 0,
    index: { status: "unavailable", reasons: [reason], reindexable: true },
  };
}

function sameGeneration(
  left: SearchLiveSnapshot["generation"],
  right: SearchLiveSnapshot["generation"],
): boolean {
  return left.libraryId === right.libraryId && left.revision === right.revision;
}

function plainText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]*>/gu, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s|\d+[.)]\s)\s*/gmu, "")
    .replace(/`{1,3}|\*{1,3}|_{2,3}|~{2}/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function excerptAround(value: string, tokens: readonly string[]): string {
  const plain = plainText(value);
  const characters = Array.from(plain);
  if (characters.length <= MAX_EXCERPT_CHARACTERS) return plain;
  const lower = plain.normalize("NFKC").toLowerCase();
  let matchCharacterIndex = 0;
  for (const token of tokens) {
    const codeUnitIndex = lower.indexOf(token);
    if (codeUnitIndex >= 0) {
      matchCharacterIndex = Array.from(lower.slice(0, codeUnitIndex)).length;
      break;
    }
  }
  let start = Math.max(0, matchCharacterIndex - 54);
  let prefix = start > 0 ? "…" : "";
  let suffix = "…";
  let contentLimit = MAX_EXCERPT_CHARACTERS - prefix.length - suffix.length;
  if (start + contentLimit >= characters.length) {
    suffix = "";
    contentLimit = MAX_EXCERPT_CHARACTERS - prefix.length;
    start = Math.max(0, characters.length - contentLimit);
    prefix = start > 0 ? "…" : "";
    contentLimit = MAX_EXCERPT_CHARACTERS - prefix.length;
  }
  return `${prefix}${characters.slice(start, start + contentLimit).join("")}${suffix}`;
}

interface SearchableField {
  field: SearchField;
  values: string[];
  normalized: string[];
}

function field(field: SearchField, values: readonly string[]): SearchableField {
  const plainValues = values.map(plainText).filter((value) => value !== "");
  return {
    field,
    values: plainValues,
    normalized: plainValues.map(normalizeSearchText),
  };
}

function searchableFields(
  live: SearchLiveRecord,
  semanticCard: KnowledgeCard | null,
): SearchableField[] {
  const metadata = [
    field("title", [live.title]),
    field("participants", live.reviewParticipants),
    field("location", live.location?.breadcrumb ?? []),
    field("date", [live.startedAt, live.startedAt.slice(0, 10)]),
    field("status", [STATUS_SEARCH_TEXT[live.status], live.status]),
  ];
  if (!semanticCard) return metadata;
  return [
    ...metadata,
    field("topic", [semanticCard.content.purpose]),
    field("oneLine", [semanticCard.content.oneLine]),
    field("highlights", semanticCard.content.highlights),
    field("decisions", semanticCard.content.decisions),
    field("actionItems", semanticCard.actionItems.map((item) => (
      [item.owner, item.task, item.due, item.searchText].filter(Boolean).join(" ")
    ))),
    field("discussion", semanticCard.content.discussion),
    field("people", semanticCard.mentionedPeople),
    field("risks", semanticCard.content.risks),
    field("followups", semanticCard.content.followups),
  ];
}

function matchesFilters(
  live: SearchLiveRecord,
  semanticCard: KnowledgeCard | null,
  filters: MeetingSearchFilters,
): boolean {
  const date = live.startedAt.slice(0, 10);
  if (filters.dateFrom !== undefined && date < filters.dateFrom) return false;
  if (filters.dateTo !== undefined && date > filters.dateTo) return false;
  if (filters.workspaceId !== undefined && live.location?.workspaceId !== filters.workspaceId) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(filters, "folderId")) {
    if (!live.location || live.location.folderId !== filters.folderId) return false;
  }
  if (filters.status !== undefined && live.status !== filters.status) return false;
  if (
    filters.hasActionItem !== undefined
    && (Boolean(semanticCard && semanticCard.actionItems.length > 0) !== filters.hasActionItem)
  ) return false;
  return true;
}

interface RankedResult {
  score: number;
  result: MeetingSearchResult;
}

function rankCandidate(
  live: SearchLiveRecord,
  semanticCard: KnowledgeCard | null,
  normalizedQuery: string,
  tokens: readonly string[],
): RankedResult | null {
  const fields = searchableFields(live, semanticCard);
  if (!tokens.every((token) => fields.some((candidate) => (
    candidate.normalized.some((value) => value.includes(token))
  )))) return null;

  const contributions = fields.flatMap((candidate) => {
    const matchedTokens = tokens.filter((token) => (
      candidate.normalized.some((value) => value.includes(token))
    ));
    if (matchedTokens.length === 0) return [];
    const phrase = candidate.normalized.some((value) => value.includes(normalizedQuery));
    const contribution = SEARCH_FIELD_WEIGHTS[candidate.field] * matchedTokens.length
      + (phrase ? EXACT_PHRASE_BONUS : 0);
    const excerptValue = candidate.values.find((_, index) => (
      candidate.normalized[index]?.includes(normalizedQuery)
    )) ?? candidate.values.find((_, index) => matchedTokens.some((token) => (
      candidate.normalized[index]?.includes(token)
    ))) ?? candidate.values[0] ?? "";
    return [{ candidate, contribution, excerptValue }];
  }).sort((left, right) => (
    right.contribution - left.contribution
    || FIELD_ORDER.indexOf(left.candidate.field) - FIELD_ORDER.indexOf(right.candidate.field)
  ));

  return {
    score: contributions.reduce((total, item) => total + item.contribution, 0),
    result: {
      meetingId: live.meetingId,
      title: live.title,
      status: live.status,
      startedAt: live.startedAt,
      location: live.location ? {
        workspaceId: live.location.workspaceId,
        folderId: live.location.folderId,
        breadcrumb: [...live.location.breadcrumb],
      } : null,
      matches: contributions.slice(0, MAX_MATCH_REASONS).map((item) => ({
        field: item.candidate.field,
        label: SEARCH_FIELD_LABELS[item.candidate.field],
        excerpt: excerptAround(item.excerptValue, tokens),
      })),
      href: `/meetings/${live.meetingId}`,
    },
  };
}

function projectionMatches(corpusProjection: CorpusMap["cards"][number], card: KnowledgeCard): boolean {
  try {
    return JSON.stringify(buildCorpusMap([card]).cards[0]) === JSON.stringify(corpusProjection);
  } catch {
    return false;
  }
}

async function safeTombstoneObservation(
  sources: MeetingSearchSources,
  meetingId: string,
): Promise<MeetingTombstoneObservation> {
  if (!isSafeId(meetingId)) return { state: "ambiguous" };
  try {
    return await sources.inspectTombstone(meetingId);
  } catch {
    return { state: "ambiguous" };
  }
}

export async function searchMeetings(
  input: MeetingSearchInput,
  sources: MeetingSearchSources,
): Promise<MeetingSearchResponse> {
  const { normalizedQuery, tokens, filters, limit } = validateInput(input);
  let corpusRead: CorpusMapReadResult;
  try {
    corpusRead = await sources.readCorpusMap();
  } catch {
    return unavailableResponse(normalizedQuery, "io_error");
  }
  if (corpusRead.mode === "missing" || corpusRead.mode === "corrupt" || corpusRead.mode === "io_error") {
    return unavailableResponse(normalizedQuery, corpusRead.mode);
  }

  const firstLiveRead = await sources.readLiveSnapshot().catch(() => ({
    mode: "unavailable" as const,
    reason: "io_error" as const,
  }));
  if (firstLiveRead.mode === "unavailable") {
    return unavailableResponse(normalizedQuery, firstLiveRead.reason);
  }

  const reasons = new Set<SearchIndexReason>();
  if (corpusRead.mode === "stale") reasons.add("stale");
  const corpusById = new Map<string, CorpusMap["cards"][number]>();
  for (const projection of corpusRead.corpusMap.cards) {
    if (corpusById.has(projection.meetingId)) reasons.add("corrupt");
    else corpusById.set(projection.meetingId, projection);
  }
  const candidateIds = new Set([
    ...corpusById.keys(),
    ...firstLiveRead.snapshot.records.map((record) => record.meetingId),
  ]);
  const cardReads = new Map<string, SearchKnowledgeCardReadResult>();
  for (const meetingId of [...candidateIds].sort((left, right) => left.localeCompare(right, "en"))) {
    if (!isSafeId(meetingId)) {
      cardReads.set(meetingId, { mode: "corrupt" });
      continue;
    }
    try {
      cardReads.set(meetingId, await sources.readKnowledgeCard(meetingId));
    } catch {
      cardReads.set(meetingId, { mode: "io_error" });
    }
  }

  const finalLiveRead = await sources.readLiveSnapshot().catch(() => ({
    mode: "unavailable" as const,
    reason: "io_error" as const,
  }));
  if (finalLiveRead.mode === "unavailable") {
    return unavailableResponse(normalizedQuery, finalLiveRead.reason);
  }
  if (!sameGeneration(firstLiveRead.snapshot.generation, finalLiveRead.snapshot.generation)) {
    throw new MeetingSearchRetryError();
  }

  const liveById = new Map(finalLiveRead.snapshot.records.map((record) => [record.meetingId, record]));
  const invalidById = new Map(finalLiveRead.snapshot.invalidRecords.map((record) => [
    record.meetingId,
    record.reason,
  ]));
  const ranked: RankedResult[] = [];

  for (const meetingId of candidateIds) {
    const tombstone = await safeTombstoneObservation(sources, meetingId);
    if (tombstone.state === "deleted") {
      reasons.add("stale");
      continue;
    }
    if (tombstone.state === "ambiguous") {
      reasons.add("io_error");
      continue;
    }
    const live = liveById.get(meetingId);
    if (!live) {
      reasons.add(invalidById.get(meetingId) ?? "stale");
      continue;
    }

    const cardRead = cardReads.get(meetingId) ?? { mode: "missing" as const };
    if (cardRead.mode !== "ready") reasons.add(cardRead.mode);
    if (live.summaryOutdated === true) reasons.add("stale");
    const revisionMatchesCard = cardRead.mode !== "ready"
      || live.contentRevision === undefined
      || (
        cardRead.card.sourceHashes.transcript === live.contentRevision.transcriptSha256
        && cardRead.card.sourceHashes.summary === live.contentRevision.summarySha256
      );
    if (cardRead.mode === "ready" && !revisionMatchesCard) reasons.add("stale");
    const statusAllowsSemantic = live.status === "summarized"
      && !live.summarizeAttemptPending
      && live.summaryOutdated !== true
      && revisionMatchesCard;
    if (!statusAllowsSemantic && cardRead.mode === "ready") reasons.add("stale");
    const semanticCard = cardRead.mode === "ready" && statusAllowsSemantic
      ? cardRead.card
      : null;
    const projection = corpusById.get(meetingId);
    if (!projection) reasons.add("missing");
    else if (semanticCard && !projectionMatches(projection, semanticCard)) reasons.add("stale");

    // Filters deliberately run before field normalization/scoring.
    if (!matchesFilters(live, semanticCard, filters)) continue;
    const candidate = rankCandidate(live, semanticCard, normalizedQuery, tokens);
    if (candidate) ranked.push(candidate);
  }

  ranked.sort((left, right) => (
    right.score - left.score
    || Date.parse(right.result.startedAt) - Date.parse(left.result.startedAt)
    || left.result.meetingId.localeCompare(right.result.meetingId, "en")
  ));
  const safeReasons = orderedReasons(reasons);
  const visible = ranked.slice(0, limit).map((item) => item.result);
  return {
    query: normalizedQuery,
    results: visible,
    hasMore: ranked.length > visible.length,
    summaryPendingCount: finalLiveRead.snapshot.records.filter((record) => (
      record.status === "transcribed" || record.status === "summarizing"
    )).length,
    index: {
      status: safeReasons.length === 0 ? "ready" : "partial",
      reasons: safeReasons,
      reindexable: safeReasons.length > 0,
    },
  };
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

type BoundedReadResult =
  | { mode: "ready"; bytes: Uint8Array }
  | { mode: "missing" }
  | { mode: "corrupt" }
  | { mode: "io_error" };

async function readBoundedNoFollow(path: string, maxBytes: number): Promise<BoundedReadResult> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return { mode: "corrupt" };
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) return { mode: "corrupt" };
    return { mode: "ready", bytes };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { mode: "missing" };
    if (errnoCode(error) === "ELOOP") return { mode: "corrupt" };
    return { mode: "io_error" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function safeMeetingDirectory(root: string, meetingId: string): Promise<"ready" | "missing" | "unsafe" | "io_error"> {
  const meetings = resolve(root, "meetings");
  const meeting = resolve(meetings, meetingId);
  try {
    const [rootInfo, meetingsInfo, meetingInfo] = await Promise.all([
      lstat(root),
      lstat(meetings),
      lstat(meeting),
    ]);
    if (
      !rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || !meetingsInfo.isDirectory() || meetingsInfo.isSymbolicLink()
      || !meetingInfo.isDirectory() || meetingInfo.isSymbolicLink()
    ) return "unsafe";
    const [realRoot, realMeetings, realMeeting] = await Promise.all([
      realpath(root),
      realpath(meetings),
      realpath(meeting),
    ]);
    return contained(realRoot, realMeetings) && contained(realMeetings, realMeeting)
      ? "ready"
      : "unsafe";
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "missing" : "io_error";
  }
}

/**
 * Search freshness intentionally does not read transcript.md. The canonical
 * publisher writes transcript and summary as one generation with summary.json
 * last, so the summary completion-marker hash plus current summarizeAttempt is
 * sufficient to reject an old card without re-reading every transcript.
 */
export async function readSearchKnowledgeCard(
  meetingId: string,
  root = defaultDataRoot(),
): Promise<SearchKnowledgeCardReadResult> {
  if (!isSafeId(meetingId)) return { mode: "corrupt" };
  const safeDirectory = await safeMeetingDirectory(resolve(root), meetingId);
  if (safeDirectory === "missing") return { mode: "missing" };
  if (safeDirectory === "unsafe") return { mode: "corrupt" };
  if (safeDirectory === "io_error") return { mode: "io_error" };

  const cardRead = await readBoundedNoFollow(
    knowledgeCardPath(meetingId, resolve(root)),
    MAX_KNOWLEDGE_CARD_BYTES,
  );
  if (cardRead.mode !== "ready") return cardRead;
  let parsed: KnowledgeCard;
  try {
    parsed = knowledgeCardSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(cardRead.bytes),
    ));
  } catch {
    return { mode: "corrupt" };
  }
  if (parsed.meetingId !== meetingId) return { mode: "corrupt" };

  const summaryRead = await readBoundedNoFollow(
    resolve(root, "meetings", meetingId, "summary.json"),
    MAX_SUMMARY_BYTES,
  );
  if (summaryRead.mode === "missing") return { mode: "stale" };
  if (summaryRead.mode !== "ready") return summaryRead;
  const currentSummaryHash = createHash("sha256").update(summaryRead.bytes).digest("hex");
  return currentSummaryHash === parsed.sourceHashes.summary
    ? { mode: "ready", card: parsed }
    : { mode: "stale" };
}

function locationBreadcrumb(
  document: LibraryDocument,
  workspaceId: string,
  folderId: string | null,
): string[] | null {
  const workspace = document.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return null;
  if (folderId === null) return [workspace.name, "미분류"];
  const byId = new Map(document.folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(folderId);
  while (current && !visited.has(current.id)) {
    if (current.workspaceId !== workspaceId) return null;
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  if (names.length === 0) return null;
  return [workspace.name, ...names];
}

function invalidReason(record: ClassifiedMeetingRecord): SearchIndexReason {
  if (record.kind === "corrupt_status") return "corrupt";
  if (record.kind === "unreadable_status" || record.kind === "unsafe_record") return "io_error";
  if (record.kind === "hidden_deleted") return "stale";
  return "missing";
}

async function readDefaultLiveSnapshot(root: string): Promise<SearchLiveSnapshotReadResult> {
  let state: Awaited<ReturnType<typeof readResolvedLibraryState>>;
  try {
    state = await readResolvedLibraryState(root);
  } catch {
    return { mode: "unavailable", reason: "io_error" };
  }
  if (state.mode !== "ready" || !state.document || !state.version) {
    return {
      mode: "unavailable",
      reason: state.degradedReason === "corrupt" ? "corrupt" : "io_error",
    };
  }
  const placementByMeeting = new Map(state.placements.map((placement) => [
    placement.meetingId,
    placement,
  ]));
  const records: SearchLiveRecord[] = [];
  const invalidRecords: SearchLiveSnapshot["invalidRecords"] = [];
  for (const record of state.records) {
    if (record.kind !== "live" || record.meetingId === null || record.status === null) {
      if (record.meetingId !== null) {
        invalidRecords.push({ meetingId: record.meetingId, reason: invalidReason(record) });
      }
      continue;
    }
    const placement = placementByMeeting.get(record.meetingId);
    const breadcrumb = placement
      ? locationBreadcrumb(state.document, placement.workspaceId, placement.folderId)
      : null;
    records.push({
      meetingId: record.meetingId,
      title: record.status.title,
      status: record.status.status,
      startedAt: record.status.startedAt,
      location: placement && breadcrumb ? {
        workspaceId: placement.workspaceId,
        folderId: placement.folderId,
        breadcrumb,
      } : null,
      reviewParticipants: [...record.status.review.participants],
      summarizeAttemptPending: record.status.summarizeAttempt !== undefined,
      summaryOutdated: record.status.contentRevision !== undefined
        && record.status.contentRevision.summary.basedOnTranscriptSha256
          !== record.status.contentRevision.transcript.sha256,
      ...(record.status.contentRevision ? {
        contentRevision: {
          transcriptSha256: record.status.contentRevision.transcript.sha256,
          summarySha256: record.status.contentRevision.summary.sha256,
        },
      } : {}),
    });
  }
  return {
    mode: "ready",
    snapshot: {
      generation: { ...state.version },
      records,
      invalidRecords,
    },
  };
}

export function createMeetingSearchSources(
  root = defaultDataRoot(),
): MeetingSearchSources {
  const canonicalRoot = resolve(root);
  const repository = createKnowledgeIndexRepository({ dataRoot: canonicalRoot });
  return {
    readCorpusMap: () => repository.readCorpusMap(),
    readKnowledgeCard: (meetingId) => readSearchKnowledgeCard(meetingId, canonicalRoot),
    readLiveSnapshot: () => readDefaultLiveSnapshot(canonicalRoot),
    inspectTombstone: (meetingId) => inspectMeetingTombstone(meetingId, canonicalRoot),
  };
}

export function searchStoredMeetings(
  input: MeetingSearchInput,
  root = defaultDataRoot(),
): Promise<MeetingSearchResponse> {
  return searchMeetings(input, createMeetingSearchSources(root));
}
