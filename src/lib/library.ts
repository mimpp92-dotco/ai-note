import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  classifyMeetingRecord,
  countMeetingRecords,
  parseLibraryDocument,
  parseStatusJsonText,
  safeParseLibraryDocument,
  type ClassifiedMeetingRecord,
  type LibraryDocument,
  type LibraryPlacement,
  type LibraryVersion,
  type MeetingRecordCounts,
  type MeetingRecordEntryKind,
  type MeetingRecordObservation,
} from "@/domain/library";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  durableAtomicReplace,
  retryNamespaceDurability,
  type DirectorySyncCapability,
  type DurableCommitDurability,
  type FileOps,
} from "@/lib/durableFileOps";
import { isSafeId } from "@/lib/meetingId";
import { inspectMeetingTombstone } from "@/lib/meetingTombstone";

export type LibraryReadResult =
  | { mode: "missing" }
  | { mode: "ready"; document: LibraryDocument; version: LibraryVersion }
  | { mode: "corrupt"; fingerprint: string }
  | { mode: "unsupported_version"; schemaVersion: number | null; fingerprint: string }
  | { mode: "io_error" };

export type PlacementMaterializationPolicy = (
  record: ClassifiedMeetingRecord,
) => "materialize" | "defer";

export interface LibraryScanResult {
  records: ClassifiedMeetingRecord[];
  counts: MeetingRecordCounts;
}

export interface LibraryViewResult {
  read: LibraryReadResult;
  scan: LibraryScanResult | null;
  effectivePlacements: LibraryPlacement[];
  maintenanceRequired: boolean;
}

export interface LibraryTransactionResult {
  document: LibraryDocument;
  version: LibraryVersion;
  committed: boolean;
  durability: Exclude<DurableCommitDurability, "none"> | null;
  scan: LibraryScanResult;
}

export interface LibraryRepositoryOptions {
  dataRoot: string;
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
  idFactory?: () => string;
  now?: () => string;
  scanRecords?: () => Promise<readonly MeetingRecordObservation[]>;
}

export interface LibraryTransactionOptions {
  expected: LibraryVersion;
  reducer: (document: LibraryDocument) => LibraryDocument;
  placementPolicy?: PlacementMaterializationPolicy;
  validate?: (document: LibraryDocument, scan: LibraryScanResult) => void | Promise<void>;
}

export class LibraryRepositoryError extends Error {
  readonly code:
    | "library_not_ready"
    | "version_conflict"
    | "durability_pending"
    | "persistence_failed"
    | "invalid_reducer_result";
  readonly currentVersion?: LibraryVersion;

  constructor(
    code: LibraryRepositoryError["code"],
    options: { currentVersion?: LibraryVersion } = {},
  ) {
    super(code);
    this.name = "LibraryRepositoryError";
    this.code = code;
    this.currentVersion = options.currentVersion;
  }
}

interface PendingNamespaceSync {
  directories: string[];
  fingerprint: string;
}

interface GlobalLibraryRepositoryState {
  queues: Map<string, Promise<void>>;
  lastGood: Map<string, LibraryDocument>;
  pending: Map<string, PendingNamespaceSync>;
}

declare global {
  var __aiNoteLibraryRepositoryState: GlobalLibraryRepositoryState | undefined;
}

function globalRepositoryState(): GlobalLibraryRepositoryState {
  globalThis.__aiNoteLibraryRepositoryState ??= {
    queues: new Map(),
    lastGood: new Map(),
    pending: new Map(),
  };
  return globalThis.__aiNoteLibraryRepositoryState;
}

export function resetLibraryRepositoryStateForTests(): void {
  globalThis.__aiNoteLibraryRepositoryState = {
    queues: new Map(),
    lastGood: new Map(),
    pending: new Map(),
  };
}

function enqueueLibrary<T>(key: string, task: () => Promise<T>): Promise<T> {
  const state = globalRepositoryState();
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

export function runInLibraryQueue<T>(
  dataRoot: string,
  task: () => Promise<T>,
): Promise<T> {
  return enqueueLibrary(join(resolve(dataRoot), "library.json"), task);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableClone(document: LibraryDocument): LibraryDocument {
  return deepFreeze(structuredClone(document));
}

function versionOf(document: LibraryDocument): LibraryVersion {
  return { libraryId: document.libraryId, revision: document.revision };
}

function fingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function serializeLibrary(document: LibraryDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function entryKind(name: string): MeetingRecordEntryKind {
  if (isSafeId(name)) return "published";
  if (/^\.(?:finalize|finalizing)[._-]/u.test(name)) return "finalize_staging";
  if (/^\.(?:summarize|summary)[._-]/u.test(name)) return "summarize_staging";
  if (/^\.(?:trash|deleted|tombstone)[._-]/u.test(name)) return "deleted";
  return "unknown";
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

async function observePublishedRecord(
  meetingsRoot: string,
  meetingId: string,
  fileOps: FileOps,
): Promise<MeetingRecordObservation> {
  const directoryPath = join(meetingsRoot, meetingId);
  const base: Omit<MeetingRecordObservation, "status" | "safety"> = {
    entryKind: "published",
    meetingId,
    hasAudio: false,
  };
  try {
    const directoryInfo = await fileOps.lstat(directoryPath);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      return { ...base, safety: "unsafe", status: { kind: "missing" } };
    }
    const realMeetingsRoot = await fileOps.realpath(meetingsRoot);
    const realDirectory = await fileOps.realpath(directoryPath);
    if (!contained(realMeetingsRoot, realDirectory)) {
      return { ...base, safety: "unsafe", status: { kind: "missing" } };
    }
  } catch (error) {
    return {
      ...base,
      safety: "safe",
      status: { kind: "unreadable", code: isErrno(error, "EACCES") ? "EACCES" : "EIO" },
    };
  }

  const audioPath = join(directoryPath, "audio.webm");
  let hasAudio = false;
  try {
    const audioInfo = await fileOps.lstat(audioPath);
    if (audioInfo.isSymbolicLink()) {
      return { ...base, safety: "unsafe", status: { kind: "missing" } };
    }
    hasAudio = audioInfo.isFile();
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      // Audio is immutable, but status remains the record authority. A status
      // read below can still classify this record without following audio.
      hasAudio = false;
    }
  }

  const statusPath = join(directoryPath, "status.json");
  let handle: Awaited<ReturnType<FileOps["openFile"]>> | null = null;
  try {
    const statusInfo = await fileOps.lstat(statusPath);
    if (statusInfo.isSymbolicLink()) {
      return { ...base, hasAudio, safety: "unsafe", status: { kind: "missing" } };
    }
    if (!statusInfo.isFile()) {
      return { ...base, hasAudio, safety: "safe", status: { kind: "corrupt" } };
    }
    handle = await fileOps.openFile(
      statusPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const bytes = await handle.readFile();
    const value = parseStatusJsonText(decodeUtf8(bytes), meetingId);
    return { ...base, hasAudio, safety: "safe", status: { kind: "valid", value } };
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { ...base, hasAudio, safety: "safe", status: { kind: "missing" } };
    }
    if (isErrno(error, "ELOOP")) {
      return { ...base, hasAudio, safety: "unsafe", status: { kind: "missing" } };
    }
    if (
      error instanceof SyntaxError
      || (error instanceof Error && (
        error.message === "status_json_malformed"
        || error.message === "status_meeting_id_mismatch"
      ))
      || (typeof error === "object" && error !== null && "issues" in error)
    ) {
      return { ...base, hasAudio, safety: "safe", status: { kind: "corrupt" } };
    }
    return {
      ...base,
      hasAudio,
      safety: "safe",
      status: { kind: "unreadable", code: isErrno(error, "EACCES") ? "EACCES" : "EIO" },
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function scanMeetingRecordObservations(
  dataRoot: string,
  fileOps: FileOps = createNodeFileOps(),
): Promise<MeetingRecordObservation[]> {
  const meetingsRoot = join(dataRoot, "meetings");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(meetingsRoot, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }

  const observations: MeetingRecordObservation[] = [];
  for (const entry of entries) {
    const kind = entryKind(entry.name);
    if (kind === "published") {
      const tombstone = await inspectMeetingTombstone(entry.name, dataRoot);
      if (tombstone.state === "deleted") {
        observations.push({
          entryKind: "deleted",
          meetingId: entry.name,
          safety: "safe",
          status: { kind: "missing" },
          hasAudio: false,
        });
        continue;
      }
      if (tombstone.state === "ambiguous") {
        observations.push({
          entryKind: "delete_ambiguous",
          meetingId: entry.name,
          safety: "unsafe",
          status: { kind: "missing" },
          hasAudio: false,
        });
        continue;
      }
      observations.push(await observePublishedRecord(meetingsRoot, entry.name, fileOps));
      continue;
    }
    observations.push({
      entryKind: kind,
      safety: entry.isSymbolicLink() ? "unsafe" : "safe",
      status: { kind: "missing" },
      hasAudio: false,
    });
  }
  return observations;
}

function classifyObservations(
  observations: readonly MeetingRecordObservation[],
  placementIds: ReadonlySet<string>,
): LibraryScanResult {
  const records = observations.map((observation) => classifyMeetingRecord({
    ...observation,
    hasPlacement: observation.meetingId !== undefined && placementIds.has(observation.meetingId),
  }));
  return { records, counts: countMeetingRecords(records) };
}

interface ReconcileResult {
  document: LibraryDocument;
  effectivePlacements: LibraryPlacement[];
  changed: boolean;
}

function reconcile(
  document: LibraryDocument,
  scan: LibraryScanResult,
  placementPolicy: PlacementMaterializationPolicy,
  materialize: boolean,
): ReconcileResult {
  const publishedRecordIds = new Set(
    scan.records
      .filter((record) => record.meetingId !== null && record.preservePlacement)
      .map((record) => record.meetingId as string),
  );
  const placements = document.placements.filter((placement) => publishedRecordIds.has(placement.meetingId));
  const placementIds = new Set(placements.map((placement) => placement.meetingId));
  const effectivePlacements = placements.map((placement) => ({ ...placement }));
  let needsMaterialization = false;

  for (const record of scan.records) {
    if (record.kind !== "live" || record.meetingId === null || placementIds.has(record.meetingId)) continue;
    if (placementPolicy(record) === "defer") continue;
    needsMaterialization = true;
    const placement: LibraryPlacement = {
      meetingId: record.meetingId,
      workspaceId: document.defaultWorkspaceId,
      folderId: null,
    };
    effectivePlacements.push(placement);
    if (materialize) {
      placements.push(placement);
      placementIds.add(record.meetingId);
    }
  }

  const changed = needsMaterialization
    || JSON.stringify(placements) !== JSON.stringify(document.placements);
  return {
    document: changed ? { ...document, placements } : document,
    effectivePlacements,
    changed,
  };
}

function defaultPlacementPolicy(record: ClassifiedMeetingRecord): "materialize" | "defer" {
  const resolution = record.status?.placementResolution?.state;
  return resolution === "pending" || resolution === "unavailable"
    ? "defer"
    : "materialize";
}

async function recoveryArtifactsBlockBootstrap(
  dataRoot: string,
  fileOps: FileOps,
): Promise<boolean> {
  const recoveryDirectory = join(dataRoot, "library-recovery");
  try {
    const info = await fileOps.lstat(recoveryDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) return true;
  } catch (error) {
    return !isErrno(error, "ENOENT");
  }

  try {
    return (await readdir(recoveryDirectory)).length > 0;
  } catch {
    return true;
  }
}

export interface LibraryRepository {
  read(): Promise<LibraryReadResult>;
  readView(options?: { placementPolicy?: PlacementMaterializationPolicy }): Promise<LibraryViewResult>;
  bootstrap(): Promise<LibraryReadResult>;
  transact(options: LibraryTransactionOptions): Promise<LibraryTransactionResult>;
  transactLatest(
    reducer: (document: LibraryDocument) => LibraryDocument,
    options?: { placementPolicy?: PlacementMaterializationPolicy },
  ): Promise<LibraryTransactionResult>;
  retryPendingDurability(): Promise<"durable" | "best_effort" | "pending">;
  getLastGood(): LibraryDocument | null;
}

export function createLibraryRepository(options: LibraryRepositoryOptions): LibraryRepository {
  const dataRoot = resolve(options.dataRoot);
  const canonicalPath = join(dataRoot, "library.json");
  const queueKey = canonicalPath;
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const scanRecords = options.scanRecords
    ?? (() => scanMeetingRecordObservations(dataRoot, fileOps));

  const rememberLastGood = (document: LibraryDocument): void => {
    globalRepositoryState().lastGood.set(queueKey, immutableClone(document));
  };

  const read = async (): Promise<LibraryReadResult> => {
    let bytes: Uint8Array;
    try {
      bytes = await fileOps.readFile(canonicalPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { mode: "missing" };
      return { mode: "io_error" };
    }

    const fileFingerprint = fingerprint(bytes);
    let candidate: unknown;
    try {
      candidate = JSON.parse(decodeUtf8(bytes)) as unknown;
    } catch {
      return { mode: "corrupt", fingerprint: fileFingerprint };
    }

    if (
      typeof candidate === "object"
      && candidate !== null
      && "schemaVersion" in candidate
      && typeof (candidate as { schemaVersion?: unknown }).schemaVersion === "number"
      && (candidate as { schemaVersion: number }).schemaVersion > 1
    ) {
      return {
        mode: "unsupported_version",
        schemaVersion: (candidate as { schemaVersion: number }).schemaVersion,
        fingerprint: fileFingerprint,
      };
    }

    const parsed = safeParseLibraryDocument(candidate);
    if (!parsed.success) return { mode: "corrupt", fingerprint: fileFingerprint };
    rememberLastGood(parsed.data);
    return { mode: "ready", document: parsed.data, version: versionOf(parsed.data) };
  };

  const scanFor = async (document: LibraryDocument): Promise<LibraryScanResult> => {
    const placementIds = new Set(document.placements.map((placement) => placement.meetingId));
    return classifyObservations(await scanRecords(), placementIds);
  };

  const assertNotPending = (): void => {
    if (globalRepositoryState().pending.has(queueKey)) {
      throw new LibraryRepositoryError("durability_pending");
    }
  };

  const commit = async (
    current: LibraryDocument,
    candidateWithoutRevision: LibraryDocument,
    scan: LibraryScanResult,
  ): Promise<LibraryTransactionResult> => {
    if (candidateWithoutRevision.libraryId !== current.libraryId
      || candidateWithoutRevision.revision !== current.revision) {
      throw new LibraryRepositoryError("invalid_reducer_result");
    }
    const parsedAtCurrentRevision = parseLibraryDocument(candidateWithoutRevision);
    if (JSON.stringify(parsedAtCurrentRevision) === JSON.stringify(current)) {
      return {
        document: current,
        version: versionOf(current),
        committed: false,
        durability: null,
        scan,
      };
    }

    const next = parseLibraryDocument({
      ...parsedAtCurrentRevision,
      revision: current.revision + 1,
    });
    const result = await durableAtomicReplace({
      rootPath: dataRoot,
      targetPath: canonicalPath,
      data: serializeLibrary(next),
      fileOps,
      capability,
    });
    if (result.state === "not_committed") {
      throw new LibraryRepositoryError("persistence_failed");
    }
    if (result.state === "committed_durability_pending") {
      globalRepositoryState().pending.set(queueKey, {
        directories: [dirname(canonicalPath)],
        fingerprint: result.fingerprint ?? "",
      });
    }
    rememberLastGood(next);
    return {
      document: next,
      version: versionOf(next),
      committed: true,
      durability: result.durability as Exclude<DurableCommitDurability, "none">,
      scan,
    };
  };

  const transactInsideQueue = async (
    reducer: (document: LibraryDocument) => LibraryDocument,
    placementPolicy: PlacementMaterializationPolicy,
    expected?: LibraryVersion,
    validate?: (document: LibraryDocument, scan: LibraryScanResult) => void | Promise<void>,
  ): Promise<LibraryTransactionResult> => {
    assertNotPending();
    const currentRead = await read();
    if (currentRead.mode !== "ready") throw new LibraryRepositoryError("library_not_ready");
    const current = currentRead.document;
    if (expected && (
      expected.libraryId !== current.libraryId
      || expected.revision !== current.revision
    )) {
      throw new LibraryRepositoryError("version_conflict", { currentVersion: versionOf(current) });
    }

    const scan = await scanFor(current);
    const reconciled = reconcile(current, scan, placementPolicy, true).document;
    await validate?.(immutableClone(reconciled), deepFreeze(structuredClone(scan)));
    const reducerInput = immutableClone(reconciled);
    const reduced = reducer(reducerInput);
    return commit(current, reduced, scan);
  };

  return {
    read,
    readView: async (viewOptions = {}) => {
      const currentRead = await read();
      if (currentRead.mode !== "ready") {
        return { read: currentRead, scan: null, effectivePlacements: [], maintenanceRequired: false };
      }
      const scan = await scanFor(currentRead.document);
      const reconciled = reconcile(
        currentRead.document,
        scan,
        viewOptions.placementPolicy ?? defaultPlacementPolicy,
        false,
      );
      return {
        read: currentRead,
        scan,
        effectivePlacements: reconciled.effectivePlacements,
        maintenanceRequired: reconciled.changed,
      };
    },
    bootstrap: () => enqueueLibrary(queueKey, async () => {
      assertNotPending();
      const currentRead = await read();
      if (currentRead.mode !== "missing") return currentRead;
      if (await recoveryArtifactsBlockBootstrap(dataRoot, fileOps)) {
        throw new LibraryRepositoryError("library_not_ready");
      }

      await fileOps.mkdir(dataRoot, { recursive: true, mode: 0o700 });
      const observations = await scanRecords();
      const scan = classifyObservations(observations, new Set());
      const timestamp = now();
      const libraryId = idFactory();
      const workspaceId = idFactory();
      const document = parseLibraryDocument({
        schemaVersion: 1,
        libraryId,
        revision: 0,
        defaultWorkspaceId: workspaceId,
        workspaces: [{
          id: workspaceId,
          name: "내 워크스페이스",
          order: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
        folders: [],
        placements: scan.records
          .filter((record) => (
            record.kind === "live"
            && record.meetingId !== null
            && defaultPlacementPolicy(record) === "materialize"
          ))
          .map((record) => ({
            meetingId: record.meetingId as string,
            workspaceId,
            folderId: null,
          })),
      });
      const result = await durableAtomicReplace({
        rootPath: dataRoot,
        targetPath: canonicalPath,
        data: serializeLibrary(document),
        fileOps,
        capability,
      });
      if (result.state === "not_committed") {
        throw new LibraryRepositoryError("persistence_failed");
      }
      if (result.state === "committed_durability_pending") {
        globalRepositoryState().pending.set(queueKey, {
          directories: [dataRoot],
          fingerprint: result.fingerprint ?? "",
        });
      }
      rememberLastGood(document);
      return { mode: "ready", document, version: versionOf(document) };
    }),
    transact: (transactionOptions) => enqueueLibrary(
      queueKey,
      () => transactInsideQueue(
        transactionOptions.reducer,
        transactionOptions.placementPolicy ?? defaultPlacementPolicy,
        transactionOptions.expected,
        transactionOptions.validate,
      ),
    ),
    transactLatest: (reducer, transactionOptions = {}) => enqueueLibrary(
      queueKey,
      () => transactInsideQueue(
        reducer,
        transactionOptions.placementPolicy ?? defaultPlacementPolicy,
      ),
    ),
    retryPendingDurability: () => enqueueLibrary(queueKey, async () => {
      const pending = globalRepositoryState().pending.get(queueKey);
      if (!pending) return "durable";
      const durability = await retryNamespaceDurability(pending.directories, { fileOps, capability });
      if (durability !== "pending") globalRepositoryState().pending.delete(queueKey);
      return durability;
    }),
    getLastGood: () => globalRepositoryState().lastGood.get(queueKey) ?? null,
  };
}
