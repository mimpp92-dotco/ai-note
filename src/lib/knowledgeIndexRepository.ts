import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  classifyMeetingRecord,
  parseStatusJson,
  type ClassifiedMeetingRecord,
} from "@/domain/library";
import type { StatusJson } from "@/domain/meeting";
import {
  corpusMapSchema,
  knowledgeCardSchema,
  type CorpusMap,
  type KnowledgeCard,
} from "@/domain/knowledge";
import { summarySchema } from "@/domain/summarySchema";
import {
  acquireArtifactReadLease as acquireDefaultArtifactReadLease,
  acquireArtifactWriteLease as acquireDefaultArtifactWriteLease,
  type ArtifactGenerationLease,
} from "@/lib/artifactLease";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  durableAtomicReplace,
  syncNamespaces,
  type DirectorySyncCapability,
  type FileOps,
} from "@/lib/durableFileOps";
import {
  buildCorpusMap,
  buildKnowledgeCard,
  hashKnowledgeSourcePair,
  isKnowledgeCardStale,
  type KnowledgeSourcePair,
} from "@/lib/knowledgeIndex";
import { scanMeetingRecordObservations } from "@/lib/library";
import { isSafeId } from "@/lib/meetingId";
import { tryAcquireMeetingOperation } from "@/lib/meetingLifecycle";
import {
  inspectMeetingTombstone as inspectDefaultMeetingTombstone,
  type MeetingTombstoneObservation,
} from "@/lib/meetingTombstone";
import {
  corpusMapPath,
  knowledgeCardPath,
  knowledgeRoot,
} from "@/lib/paths";

const MAX_KNOWLEDGE_CARD_BYTES = 4 * 1024 * 1024;
const MAX_CORPUS_MAP_BYTES = 8 * 1024 * 1024;
const MAX_STATUS_BYTES = 512 * 1024;

export type KnowledgeIndexDurability = "durable" | "best_effort" | "pending";

export type KnowledgeCardReadResult =
  | { mode: "missing" }
  | { mode: "ready"; card: KnowledgeCard }
  | { mode: "stale"; card: KnowledgeCard }
  | { mode: "corrupt" }
  | { mode: "io_error" };

export type CorpusMapReadResult =
  | { mode: "missing" }
  | { mode: "ready"; corpusMap: CorpusMap }
  | { mode: "stale"; corpusMap: CorpusMap }
  | { mode: "corrupt" }
  | { mode: "io_error" };

export interface KnowledgeIndexCommit<T> {
  state: "committed";
  durability: KnowledgeIndexDurability;
  value: T;
}

export interface KnowledgeCardCommit {
  state: "committed";
  durability: KnowledgeIndexDurability;
  card: KnowledgeCard;
}

export interface CorpusMapCommit {
  state: "committed" | "superseded";
  durability: KnowledgeIndexDurability | null;
  corpusMap: CorpusMap;
}

export interface CorpusMapRebuildResult extends CorpusMapCommit {
  indexedCount: number;
  skippedCount: number;
}

export type KnowledgeReindexReason = "missing" | "stale" | "corrupt" | "io_error";

export type KnowledgeReindexScope =
  | { scope: "all" }
  | { scope: "meeting"; meetingId: string };

export interface KnowledgeReindexResult {
  status: "ready" | "partial" | "unavailable";
  reasons: KnowledgeReindexReason[];
  count: {
    total: number;
    indexed: number;
    skipped: number;
  };
  durability: KnowledgeIndexDurability | null;
}

export type KnowledgeIndexRepositoryBarrierPoint =
  | "inside_corpus_queue_before_commit"
  | "inside_reindex_queue_before_work";

export interface KnowledgeIndexRepositoryOptions {
  dataRoot: string;
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
  inspectTombstone?: (meetingId: string) => Promise<MeetingTombstoneObservation>;
  readStatusSnapshot?: (meetingId: string) => Promise<StatusJson | null>;
  acquireArtifactReadLease?: (meetingId: string) => Promise<ArtifactGenerationLease>;
  acquireArtifactWriteLease?: (
    meetingId: string,
    meetingOperationOwnerToken: string,
  ) => Promise<ArtifactGenerationLease>;
  loadClassifiedMeetingRecords?: () => Promise<readonly ClassifiedMeetingRecord[]>;
  barrier?: (point: KnowledgeIndexRepositoryBarrierPoint) => void | Promise<void>;
}

export interface KnowledgeRootResult {
  state: "ready";
  created: boolean;
  durability: KnowledgeIndexDurability;
}

export interface WriteKnowledgeCardInput {
  meetingId: string;
  meetingOperationOwnerToken: string;
}

export interface KnowledgeIndexRepository {
  ensureKnowledgeRoot(): Promise<KnowledgeRootResult>;
  writeKnowledgeCard(input: WriteKnowledgeCardInput): Promise<KnowledgeCardCommit>;
  readKnowledgeCard(meetingId: string): Promise<KnowledgeCardReadResult>;
  writeCorpusMap(corpusMap: CorpusMap): Promise<CorpusMapCommit>;
  readCorpusMap(expectedCards?: readonly KnowledgeCard[]): Promise<CorpusMapReadResult>;
  rebuildCorpusMap(): Promise<CorpusMapRebuildResult>;
  refreshAfterSummary(input: WriteKnowledgeCardInput): Promise<KnowledgeReindexResult>;
  reindex(scope: KnowledgeReindexScope): Promise<KnowledgeReindexResult>;
}

export class KnowledgeIndexRepositoryError extends Error {
  readonly code:
    | "invalid_meeting_id"
    | "meeting_deleted"
    | "delete_state_ambiguous"
    | "status_unavailable"
    | "source_pair_missing"
    | "source_pair_stale"
    | "source_pair_ambiguous"
    | "source_io_error"
    | "unsafe_knowledge_root"
    | "knowledge_root_io_error"
    | "persistence_failed";

  constructor(code: KnowledgeIndexRepositoryError["code"], options: { cause?: unknown } = {}) {
    super(code, { cause: options.cause });
    this.name = "KnowledgeIndexRepositoryError";
    this.code = code;
  }
}

interface GlobalKnowledgeIndexRepositoryState {
  queues: Map<string, Promise<void>>;
  pendingRoots: Set<string>;
  nextSequences: Map<string, number>;
  latestCommittedSequences: Map<string, number>;
}

declare global {
  var __aiNoteKnowledgeIndexRepositoryState: GlobalKnowledgeIndexRepositoryState | undefined;
}

function globalState(): GlobalKnowledgeIndexRepositoryState {
  globalThis.__aiNoteKnowledgeIndexRepositoryState ??= {
    queues: new Map(),
    pendingRoots: new Set(),
    nextSequences: new Map(),
    latestCommittedSequences: new Map(),
  };
  return globalThis.__aiNoteKnowledgeIndexRepositoryState;
}

export function resetKnowledgeIndexRepositoryStateForTests(): void {
  globalThis.__aiNoteKnowledgeIndexRepositoryState = {
    queues: new Map(),
    pendingRoots: new Set(),
    nextSequences: new Map(),
    latestCommittedSequences: new Map(),
  };
}

function enqueueCorpus<T>(key: string, task: () => Promise<T>): Promise<T> {
  const state = globalState();
  const previous = state.queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  state.queues.set(key, tail);
  void tail.then(() => {
    if (state.queues.get(key) === tail) state.queues.delete(key);
  });
  return run;
}

function nextSequence(key: string): number {
  const next = (globalState().nextSequences.get(key) ?? 0) + 1;
  globalState().nextSequences.set(key, next);
  return next;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function mergeDurability(
  left: KnowledgeIndexDurability,
  right: KnowledgeIndexDurability,
): KnowledgeIndexDurability {
  if (left === "pending" || right === "pending") return "pending";
  if (left === "best_effort" || right === "best_effort") return "best_effort";
  return "durable";
}

const REINDEX_REASON_ORDER: readonly KnowledgeReindexReason[] = [
  "missing",
  "stale",
  "corrupt",
  "io_error",
];

function mergeOptionalDurability(
  current: KnowledgeIndexDurability | null,
  next: KnowledgeIndexDurability | null,
): KnowledgeIndexDurability | null {
  if (current === null) return next;
  if (next === null) return current;
  return mergeDurability(current, next);
}

function orderedReasons(reasons: ReadonlySet<KnowledgeReindexReason>): KnowledgeReindexReason[] {
  return REINDEX_REASON_ORDER.filter((reason) => reasons.has(reason));
}

function resultForReindex(
  total: number,
  indexed: number,
  reasons: ReadonlySet<KnowledgeReindexReason>,
  durability: KnowledgeIndexDurability | null,
): KnowledgeReindexResult {
  const safeReasons = orderedReasons(reasons);
  return {
    status: safeReasons.length === 0
      ? "ready"
      : indexed > 0
        ? "partial"
        : "unavailable",
    reasons: safeReasons,
    count: {
      total,
      indexed,
      skipped: Math.max(0, total - indexed),
    },
    durability,
  };
}

function reasonForRecord(record: ClassifiedMeetingRecord): KnowledgeReindexReason | null {
  if (record.kind === "hidden_deleted") return null;
  if (record.kind === "corrupt_status") return "corrupt";
  if (record.kind === "unreadable_status" || record.kind === "unsafe_record") return "io_error";
  if (record.kind === "incomplete" || record.kind === "hidden_staging") return "missing";
  if (record.status?.summarizeAttempt !== undefined) return "stale";
  return null;
}

function reasonForRepositoryError(error: unknown): KnowledgeReindexReason {
  if (!(error instanceof KnowledgeIndexRepositoryError)) return "io_error";
  if (error.code === "meeting_deleted" || error.code === "source_pair_missing") return "missing";
  if (error.code === "source_pair_stale") return "stale";
  if (error.code === "source_pair_ambiguous" || error.code === "status_unavailable") {
    return "corrupt";
  }
  if (error.code === "invalid_meeting_id" || error.code === "unsafe_knowledge_root") {
    return "corrupt";
  }
  return "io_error";
}

function serialize(value: CorpusMap | KnowledgeCard): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

type ReadBytesResult =
  | { state: "missing" }
  | { state: "ready"; bytes: Uint8Array }
  | { state: "invalid" }
  | { state: "io_error" };

async function readBytesNoFollow(
  path: string,
  maxBytes: number,
  fileOps: FileOps,
): Promise<ReadBytesResult> {
  let handle: Awaited<ReturnType<FileOps["openFile"]>> | null = null;
  try {
    const info = await fileOps.lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
      return { state: "invalid" };
    }
    handle = await fileOps.openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) return { state: "invalid" };
    return { state: "ready", bytes };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { state: "missing" };
    if (errnoCode(error) === "ELOOP") return { state: "invalid" };
    return { state: "io_error" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function assertMeetingId(meetingId: string): string {
  if (!isSafeId(meetingId)) throw new KnowledgeIndexRepositoryError("invalid_meeting_id");
  return meetingId;
}

function fenceError(observation: MeetingTombstoneObservation): KnowledgeIndexRepositoryError | null {
  if (observation.state === "deleted") return new KnowledgeIndexRepositoryError("meeting_deleted");
  if (observation.state === "ambiguous") {
    return new KnowledgeIndexRepositoryError("delete_state_ambiguous");
  }
  return null;
}

export function createKnowledgeIndexRepository(
  options: KnowledgeIndexRepositoryOptions,
): KnowledgeIndexRepository {
  const root = resolve(options.dataRoot);
  const canonicalKnowledgeRoot = knowledgeRoot(root);
  const canonicalCorpusMapPath = corpusMapPath(root);
  const queueKey = resolve(canonicalCorpusMapPath);
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const inspectTombstone = options.inspectTombstone
    ?? ((meetingId: string) => inspectDefaultMeetingTombstone(meetingId, root));
  const acquireArtifactReadLease = options.acquireArtifactReadLease
    ?? acquireDefaultArtifactReadLease;
  const acquireArtifactWriteLease = options.acquireArtifactWriteLease
    ?? acquireDefaultArtifactWriteLease;
  const loadClassifiedMeetingRecords = options.loadClassifiedMeetingRecords ?? (async () => (
    await scanMeetingRecordObservations(root, fileOps)
  ).map((observation) => classifyMeetingRecord(observation)));

  const inspectFence = async (meetingId: string): Promise<MeetingTombstoneObservation> => {
    try {
      return await inspectTombstone(meetingId);
    } catch (error) {
      throw new KnowledgeIndexRepositoryError("delete_state_ambiguous", { cause: error });
    }
  };

  const inspectKnowledgeRoot = async (): Promise<"missing" | "ready"> => {
    try {
      const rootInfo = await fileOps.lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new KnowledgeIndexRepositoryError("unsafe_knowledge_root");
      }
      const info = await fileOps.lstat(canonicalKnowledgeRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new KnowledgeIndexRepositoryError("unsafe_knowledge_root");
      }
      const realRoot = await fileOps.realpath(root);
      const realKnowledgeRoot = await fileOps.realpath(canonicalKnowledgeRoot);
      if (!contained(realRoot, realKnowledgeRoot)) {
        throw new KnowledgeIndexRepositoryError("unsafe_knowledge_root");
      }
      return "ready";
    } catch (error) {
      if (error instanceof KnowledgeIndexRepositoryError) throw error;
      if (errnoCode(error) === "ENOENT") return "missing";
      throw new KnowledgeIndexRepositoryError("knowledge_root_io_error", { cause: error });
    }
  };

  const ensureKnowledgeRoot = async (): Promise<KnowledgeRootResult> => {
    const current = await inspectKnowledgeRoot();
    if (current === "ready") {
      if (!globalState().pendingRoots.has(canonicalKnowledgeRoot)) {
        return { state: "ready", created: false, durability: "durable" };
      }
      const retried = await syncNamespaces([root], { fileOps, capability });
      if (retried.durability !== "pending") {
        globalState().pendingRoots.delete(canonicalKnowledgeRoot);
      }
      return { state: "ready", created: false, durability: retried.durability };
    }

    let created = false;
    try {
      await fileOps.mkdir(canonicalKnowledgeRoot, { recursive: false, mode: 0o700 });
      created = true;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") {
        throw new KnowledgeIndexRepositoryError("knowledge_root_io_error", { cause: error });
      }
    }
    if (await inspectKnowledgeRoot() !== "ready") {
      throw new KnowledgeIndexRepositoryError("unsafe_knowledge_root");
    }
    if (!created) return { state: "ready", created: false, durability: "durable" };
    const namespace = await syncNamespaces([root], { fileOps, capability });
    if (namespace.durability === "pending") {
      globalState().pendingRoots.add(canonicalKnowledgeRoot);
    }
    return { state: "ready", created: true, durability: namespace.durability };
  };

  const assertSafeMeetingDirectory = async (meetingId: string): Promise<string> => {
    const meetingDirectory = dirname(knowledgeCardPath(meetingId, root));
    const meetingsDirectory = dirname(meetingDirectory);
    try {
      const [rootInfo, meetingsInfo, meetingInfo] = await Promise.all([
        fileOps.lstat(root),
        fileOps.lstat(meetingsDirectory),
        fileOps.lstat(meetingDirectory),
      ]);
      if (
        !rootInfo.isDirectory()
        || rootInfo.isSymbolicLink()
        || !meetingsInfo.isDirectory()
        || meetingsInfo.isSymbolicLink()
        || !meetingInfo.isDirectory()
        || meetingInfo.isSymbolicLink()
      ) throw new KnowledgeIndexRepositoryError("source_pair_ambiguous");
      const [realRoot, realMeetingsDirectory, realMeetingDirectory] = await Promise.all([
        fileOps.realpath(root),
        fileOps.realpath(meetingsDirectory),
        fileOps.realpath(meetingDirectory),
      ]);
      if (
        !contained(realRoot, realMeetingsDirectory)
        || !contained(realMeetingsDirectory, realMeetingDirectory)
      ) throw new KnowledgeIndexRepositoryError("source_pair_ambiguous");
      return meetingDirectory;
    } catch (error) {
      if (error instanceof KnowledgeIndexRepositoryError) throw error;
      if (errnoCode(error) === "ENOENT") {
        throw new KnowledgeIndexRepositoryError("source_pair_missing", { cause: error });
      }
      throw new KnowledgeIndexRepositoryError("source_io_error", { cause: error });
    }
  };

  const readStatusAtRoot = async (meetingId: string): Promise<StatusJson | null> => {
    let meetingDirectory: string;
    try {
      meetingDirectory = await assertSafeMeetingDirectory(meetingId);
    } catch {
      return null;
    }
    const statusBytes = await readBytesNoFollow(
      resolve(meetingDirectory, "status.json"),
      MAX_STATUS_BYTES,
      fileOps,
    );
    if (statusBytes.state !== "ready") return null;
    try {
      return parseStatusJson(parseJson(statusBytes.bytes), meetingId);
    } catch {
      return null;
    }
  };

  const readStatusSnapshot = options.readStatusSnapshot ?? readStatusAtRoot;

  const readSourcePair = async (meetingId: string): Promise<KnowledgeSourcePair> => {
    const meetingDirectory = await assertSafeMeetingDirectory(meetingId);
    const [transcript, summary] = await Promise.all([
      readBytesNoFollow(resolve(meetingDirectory, "transcript.md"), MAX_KNOWLEDGE_CARD_BYTES, fileOps),
      readBytesNoFollow(resolve(meetingDirectory, "summary.json"), MAX_KNOWLEDGE_CARD_BYTES, fileOps),
    ]);
    if (transcript.state === "missing" || summary.state === "missing") {
      throw new KnowledgeIndexRepositoryError("source_pair_missing");
    }
    if (transcript.state === "io_error" || summary.state === "io_error") {
      throw new KnowledgeIndexRepositoryError("source_io_error");
    }
    if (transcript.state !== "ready" || summary.state !== "ready") {
      throw new KnowledgeIndexRepositoryError("source_pair_ambiguous");
    }
    return { transcript: transcript.bytes, summary: summary.bytes };
  };

  const readKnowledgeCard = async (meetingIdInput: string): Promise<KnowledgeCardReadResult> => {
    const meetingId = assertMeetingId(meetingIdInput);
    const firstFence = await inspectFence(meetingId);
    if (firstFence.state === "deleted") return { mode: "missing" };
    if (firstFence.state === "ambiguous") return { mode: "io_error" };

    const lease = await acquireArtifactReadLease(meetingId);
    try {
      const secondFence = await inspectFence(meetingId);
      if (secondFence.state === "deleted") return { mode: "missing" };
      if (secondFence.state === "ambiguous") return { mode: "io_error" };
      try {
        await assertSafeMeetingDirectory(meetingId);
      } catch (error) {
        if (
          error instanceof KnowledgeIndexRepositoryError
          && error.code === "source_pair_missing"
        ) return { mode: "missing" };
        return { mode: "io_error" };
      }
      let currentStatus: StatusJson | null;
      try {
        currentStatus = await readStatusSnapshot(meetingId);
      } catch {
        return { mode: "io_error" };
      }
      if (!currentStatus || currentStatus.id !== meetingId) return { mode: "corrupt" };
      const cardBytes = await readBytesNoFollow(
        knowledgeCardPath(meetingId, root),
        MAX_KNOWLEDGE_CARD_BYTES,
        fileOps,
      );
      if (cardBytes.state === "missing") return { mode: "missing" };
      if (cardBytes.state === "io_error") return { mode: "io_error" };
      if (cardBytes.state === "invalid") return { mode: "corrupt" };
      let card: KnowledgeCard;
      try {
        card = knowledgeCardSchema.parse(parseJson(cardBytes.bytes));
      } catch {
        return { mode: "corrupt" };
      }
      if (card.meetingId !== meetingId) return { mode: "corrupt" };
      let source: KnowledgeSourcePair;
      try {
        source = await readSourcePair(meetingId);
      } catch (error) {
        if (error instanceof KnowledgeIndexRepositoryError) {
          if (error.code === "source_pair_missing") return { mode: "stale", card };
          if (error.code === "source_io_error") return { mode: "io_error" };
        }
        return { mode: "corrupt" };
      }
      try {
        summarySchema.parse(parseJson(source.summary));
      } catch {
        return { mode: "corrupt" };
      }
      const currentHashes = hashKnowledgeSourcePair(source);
      if (currentStatus.summarizeAttempt !== undefined) return { mode: "stale", card };
      if (currentStatus.contentRevision !== undefined) {
        if (
          currentStatus.contentRevision.transcript.sha256 !== currentHashes.transcript
          || currentStatus.contentRevision.summary.sha256 !== currentHashes.summary
        ) return { mode: "corrupt" };
        if (
          currentStatus.contentRevision.summary.basedOnTranscriptSha256
          !== currentStatus.contentRevision.transcript.sha256
        ) return { mode: "stale", card };
      }
      return isKnowledgeCardStale(card, currentHashes)
        ? { mode: "stale", card }
        : { mode: "ready", card };
    } finally {
      lease.release();
    }
  };

  const writeKnowledgeCard = async (
    input: WriteKnowledgeCardInput,
  ): Promise<KnowledgeCardCommit> => {
    const meetingId = assertMeetingId(input.meetingId);
    const firstFence = await inspectFence(meetingId);
    const firstFenceError = fenceError(firstFence);
    if (firstFenceError) throw firstFenceError;

    const lease = await acquireArtifactWriteLease(
      meetingId,
      input.meetingOperationOwnerToken,
    );
    try {
      const secondFence = await inspectFence(meetingId);
      const secondFenceError = fenceError(secondFence);
      if (secondFenceError) throw secondFenceError;
      let status: StatusJson | null;
      try {
        status = await readStatusSnapshot(meetingId);
      } catch (error) {
        throw new KnowledgeIndexRepositoryError("status_unavailable", { cause: error });
      }
      if (!status || status.id !== meetingId) {
        throw new KnowledgeIndexRepositoryError("status_unavailable");
      }
      if (status.summarizeAttempt !== undefined) {
        throw new KnowledgeIndexRepositoryError("source_pair_ambiguous");
      }
      const source = await readSourcePair(meetingId);
      const currentHashes = hashKnowledgeSourcePair(source);
      if (status.contentRevision !== undefined) {
        if (
          status.contentRevision.transcript.sha256 !== currentHashes.transcript
          || status.contentRevision.summary.sha256 !== currentHashes.summary
        ) throw new KnowledgeIndexRepositoryError("source_pair_ambiguous");
        if (
          status.contentRevision.summary.basedOnTranscriptSha256
          !== status.contentRevision.transcript.sha256
        ) throw new KnowledgeIndexRepositoryError("source_pair_stale");
      }
      let card: KnowledgeCard;
      try {
        card = buildKnowledgeCard({ meetingId, source, status });
      } catch (error) {
        throw new KnowledgeIndexRepositoryError("source_pair_ambiguous", { cause: error });
      }
      const commit = await durableAtomicReplace({
        rootPath: root,
        targetPath: knowledgeCardPath(meetingId, root),
        data: serialize(card),
        fileOps,
        capability,
      });
      if (commit.state === "not_committed" || commit.durability === "none") {
        throw new KnowledgeIndexRepositoryError("persistence_failed");
      }
      return { state: "committed", durability: commit.durability, card };
    } finally {
      lease.release();
    }
  };

  const commitCorpusMap = async (
    corpusMapInput: CorpusMap,
    sequence: number,
  ): Promise<CorpusMapCommit> => {
    const corpusMap = corpusMapSchema.parse(corpusMapInput);
    return enqueueCorpus(queueKey, async () => {
      const latestCommitted = globalState().latestCommittedSequences.get(queueKey) ?? 0;
      if (sequence < latestCommitted) {
        return { state: "superseded", durability: null, corpusMap };
      }
      const rootResult = await ensureKnowledgeRoot();
      await options.barrier?.("inside_corpus_queue_before_commit");
      const commit = await durableAtomicReplace({
        rootPath: root,
        targetPath: canonicalCorpusMapPath,
        data: serialize(corpusMap),
        fileOps,
        capability,
      });
      if (commit.state === "not_committed" || commit.durability === "none") {
        throw new KnowledgeIndexRepositoryError("persistence_failed");
      }
      globalState().latestCommittedSequences.set(queueKey, sequence);
      return {
        state: "committed",
        durability: mergeDurability(rootResult.durability, commit.durability),
        corpusMap,
      };
    });
  };

  const writeCorpusMap = (corpusMap: CorpusMap): Promise<CorpusMapCommit> => (
    commitCorpusMap(corpusMap, nextSequence(queueKey))
  );

  const readCorpusMap = async (
    expectedCards?: readonly KnowledgeCard[],
  ): Promise<CorpusMapReadResult> => {
    let rootState: "missing" | "ready";
    try {
      rootState = await inspectKnowledgeRoot();
    } catch {
      return { mode: "io_error" };
    }
    if (rootState === "missing") return { mode: "missing" };
    const bytes = await readBytesNoFollow(canonicalCorpusMapPath, MAX_CORPUS_MAP_BYTES, fileOps);
    if (bytes.state === "missing") return { mode: "missing" };
    if (bytes.state === "io_error") return { mode: "io_error" };
    if (bytes.state === "invalid") return { mode: "corrupt" };
    let corpusMap: CorpusMap;
    try {
      corpusMap = corpusMapSchema.parse(parseJson(bytes.bytes));
    } catch {
      return { mode: "corrupt" };
    }
    if (expectedCards !== undefined) {
      const expected = buildCorpusMap(expectedCards);
      if (JSON.stringify(expected) !== JSON.stringify(corpusMap)) {
        return { mode: "stale", corpusMap };
      }
    }
    return { mode: "ready", corpusMap };
  };

  const rebuildCorpusMap = async (): Promise<CorpusMapRebuildResult> => {
    const sequence = nextSequence(queueKey);
    const records = await loadClassifiedMeetingRecords();
    const cards: KnowledgeCard[] = [];
    for (const record of records) {
      if (
        record.kind !== "live"
        || record.meetingId === null
        || record.status === null
        || record.status.id !== record.meetingId
        || record.status.summarizeAttempt !== undefined
      ) continue;
      const read = await readKnowledgeCard(record.meetingId);
      if (read.mode === "ready") cards.push(read.card);
    }
    const corpusMap = buildCorpusMap(cards);
    const committed = await commitCorpusMap(corpusMap, sequence);
    return {
      ...committed,
      indexedCount: cards.length,
      skippedCount: Math.max(0, records.length - cards.length),
    };
  };

  interface CardReindexOutcome {
    indexed: boolean;
    reason?: KnowledgeReindexReason;
    durability: KnowledgeIndexDurability | null;
  }

  const reindexCardWithOwner = async (
    input: WriteKnowledgeCardInput,
  ): Promise<CardReindexOutcome> => {
    try {
      const commit = await writeKnowledgeCard(input);
      return { indexed: true, durability: commit.durability };
    } catch (error) {
      return {
        indexed: false,
        reason: reasonForRepositoryError(error),
        durability: null,
      };
    }
  };

  const finishReindex = async (
    total: number,
    outcomes: readonly CardReindexOutcome[],
    initialReasons: ReadonlySet<KnowledgeReindexReason> = new Set(),
  ): Promise<KnowledgeReindexResult> => {
    const reasons = new Set(initialReasons);
    let indexed = 0;
    let durability: KnowledgeIndexDurability | null = null;
    for (const outcome of outcomes) {
      if (outcome.indexed) indexed += 1;
      if (outcome.reason) reasons.add(outcome.reason);
      durability = mergeOptionalDurability(durability, outcome.durability);
    }
    try {
      const corpus = await rebuildCorpusMap();
      if (corpus.state === "superseded") {
        reasons.add("stale");
      } else {
        durability = mergeOptionalDurability(durability, corpus.durability);
      }
    } catch {
      reasons.add("io_error");
    }
    return resultForReindex(total, indexed, reasons, durability);
  };

  const refreshAfterSummary = async (
    input: WriteKnowledgeCardInput,
  ): Promise<KnowledgeReindexResult> => {
    const outcome = await reindexCardWithOwner(input);
    return finishReindex(1, [outcome]);
  };

  const reindexQueueKey = `${queueKey}:reindex`;
  const reindex = (scope: KnowledgeReindexScope): Promise<KnowledgeReindexResult> => (
    enqueueCorpus(reindexQueueKey, async () => {
      await options.barrier?.("inside_reindex_queue_before_work");
      let records: readonly ClassifiedMeetingRecord[];
      try {
        records = await loadClassifiedMeetingRecords();
      } catch {
        return resultForReindex(
          scope.scope === "meeting" ? 1 : 0,
          0,
          new Set(["io_error"]),
          null,
        );
      }

      const selected = scope.scope === "meeting"
        ? records.filter((record) => record.meetingId === scope.meetingId).slice(0, 1)
        : records.filter((record) => record.meetingId !== null);
      const total = scope.scope === "meeting" ? 1 : selected.length;
      const reasons = new Set<KnowledgeReindexReason>();
      const outcomes: CardReindexOutcome[] = [];

      if (scope.scope === "meeting" && selected.length === 0) reasons.add("missing");
      for (const record of selected) {
        const classifiedReason = reasonForRecord(record);
        if (record.kind !== "live" || record.meetingId === null || classifiedReason) {
          if (classifiedReason) reasons.add(classifiedReason);
          else if (scope.scope === "meeting" && record.kind === "hidden_deleted") {
            reasons.add("missing");
          }
          continue;
        }
        let operation;
        try {
          operation = await tryAcquireMeetingOperation(record.meetingId, "summarize");
        } catch {
          reasons.add("io_error");
          continue;
        }
        if (!operation) {
          reasons.add("stale");
          continue;
        }
        try {
          outcomes.push(await reindexCardWithOwner({
            meetingId: record.meetingId,
            meetingOperationOwnerToken: operation.ownerToken,
          }));
        } finally {
          operation.release();
        }
      }
      return finishReindex(total, outcomes, reasons);
    })
  );

  return {
    ensureKnowledgeRoot,
    writeKnowledgeCard,
    readKnowledgeCard,
    writeCorpusMap,
    readCorpusMap,
    rebuildCorpusMap,
    refreshAfterSummary,
    reindex,
  };
}
