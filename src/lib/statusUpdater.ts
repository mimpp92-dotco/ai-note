import {
  parseStatusJson,
  parseStatusJsonText,
} from "@/domain/library";
import type { StatusJson } from "@/domain/meeting";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  durableAtomicReplace,
  retryNamespaceDurability,
  type DirectorySyncCapability,
  type DurableCommitResult,
  type FileOps,
} from "@/lib/durableFileOps";
import {
  acquireMeetingOperation,
  assertMeetingOperationOwner,
  type MeetingOperationLease,
} from "@/lib/meetingLifecycle";
import { assertSafeId } from "@/lib/meetingId";
import { getMeetingTombstoneStore } from "@/lib/meetingTombstone";
import { invalidateSummaryWork } from "@/lib/summaryWorkCache";

interface GlobalStatusUpdaterState {
  queues: Map<string, Promise<void>>;
  pending: Map<string, { directories: string[] }>;
  defaults: Map<string, StatusUpdater>;
}

declare global {
  var __aiNoteStatusUpdater: GlobalStatusUpdaterState | undefined;
}

function updaterState(): GlobalStatusUpdaterState {
  globalThis.__aiNoteStatusUpdater ??= { queues: new Map(), pending: new Map(), defaults: new Map() };
  return globalThis.__aiNoteStatusUpdater;
}

export function resetStatusUpdaterStateForTests(): void {
  globalThis.__aiNoteStatusUpdater = { queues: new Map(), pending: new Map(), defaults: new Map() };
}

export function setStatusUpdaterForTests(dataRoot: string, updater: StatusUpdater): void {
  updaterState().defaults.set(dataRoot, updater);
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const state = updaterState();
  const prior = state.queues.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(task);
  const tail = run.then(() => undefined, () => undefined);
  state.queues.set(key, tail);
  void tail.then(() => {
    if (state.queues.get(key) === tail) state.queues.delete(key);
  });
  return run;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export class StatusUpdaterError extends Error {
  readonly code:
    | "status_not_found"
    | "status_already_exists"
    | "invalid_status_update"
    | "status_write_failed"
    | "status_durability_pending"
    | "meeting_deleted"
    | "delete_state_ambiguous";

  constructor(code: StatusUpdaterError["code"]) {
    super(code);
    this.name = "StatusUpdaterError";
    this.code = code;
  }
}

export interface StatusUpdateResult {
  status: StatusJson;
  commit: DurableCommitResult;
}

export interface StatusUpdaterOptions {
  dataRoot: string;
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
  now?: () => string;
}

export interface StatusUpdater {
  read(meetingId: string): Promise<StatusJson | null>;
  create(meetingId: string, status: StatusJson, ownerToken?: string): Promise<StatusUpdateResult>;
  update(
    meetingId: string,
    reducer: (latest: StatusJson) => StatusJson,
    ownerToken?: string,
  ): Promise<StatusUpdateResult>;
  retryPending(meetingId: string): Promise<"durable" | "best_effort" | "pending">;
}

export function createStatusUpdater(options: StatusUpdaterOptions): StatusUpdater {
  const root = options.dataRoot;
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const now = options.now ?? (() => new Date().toISOString());
  const tombstones = getMeetingTombstoneStore(root);
  const paths = (meetingId: string) => {
    const safeId = assertSafeId(meetingId);
    const directory = join(root, "meetings", safeId);
    return { directory, status: join(directory, "status.json") };
  };

  const read = async (meetingId: string): Promise<StatusJson | null> => {
    const fence = await tombstones.inspect(meetingId);
    if (fence.state !== "none") return null;
    const target = paths(meetingId);
    let handle: Awaited<ReturnType<FileOps["openFile"]>> | null = null;
    try {
      const meetingsDirectory = join(root, "meetings");
      const [meetingsInfo, directoryInfo, statusInfo] = await Promise.all([
        fileOps.lstat(meetingsDirectory),
        fileOps.lstat(target.directory),
        fileOps.lstat(target.status),
      ]);
      if (
        meetingsInfo.isSymbolicLink()
        || !meetingsInfo.isDirectory()
        || directoryInfo.isSymbolicLink()
        || !directoryInfo.isDirectory()
        || statusInfo.isSymbolicLink()
        || !statusInfo.isFile()
      ) return null;
      handle = await fileOps.openFile(
        target.status,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const bytes = await handle.readFile();
      return parseStatusJsonText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), meetingId);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ELOOP")) return null;
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  };

  const withLease = async <T>(
    meetingId: string,
    ownerToken: string | undefined,
    task: () => Promise<T>,
  ): Promise<T> => {
    let lease: MeetingOperationLease | null = null;
    if (ownerToken) assertMeetingOperationOwner(meetingId, ownerToken);
    else lease = await acquireMeetingOperation(meetingId, "status");
    try {
      return await task();
    } finally {
      lease?.release();
    }
  };

  const persist = async (
    meetingId: string,
    status: StatusJson,
  ): Promise<StatusUpdateResult> => {
    const fence = await tombstones.inspect(meetingId);
    if (fence.state === "deleted") throw new StatusUpdaterError("meeting_deleted");
    if (fence.state === "ambiguous") throw new StatusUpdaterError("delete_state_ambiguous");
    const target = paths(meetingId);
    const stamped = parseStatusJson({ ...status, updatedAt: now() }, meetingId);
    const commit = await durableAtomicReplace({
      rootPath: root,
      targetPath: target.status,
      data: `${JSON.stringify(stamped, null, 2)}\n`,
      fileOps,
      capability,
    });
    if (commit.state === "not_committed") throw new StatusUpdaterError("status_write_failed");
    if (commit.state === "committed_durability_pending") {
      updaterState().pending.set(target.status, { directories: [target.directory] });
    }
    invalidateSummaryWork(root);
    return { status: stamped, commit };
  };

  return {
    read,
    create: (meetingId, status, ownerToken) => withLease(meetingId, ownerToken, () => {
      const target = paths(meetingId);
      return enqueue(target.status, async () => {
        const fence = await tombstones.inspect(meetingId);
        if (fence.state === "deleted") throw new StatusUpdaterError("meeting_deleted");
        if (fence.state === "ambiguous") throw new StatusUpdaterError("delete_state_ambiguous");
        if (updaterState().pending.has(target.status)) {
          throw new StatusUpdaterError("status_durability_pending");
        }
        await fileOps.mkdir(target.directory, { recursive: true, mode: 0o700 });
        if (await read(meetingId)) throw new StatusUpdaterError("status_already_exists");
        let parsed: StatusJson;
        try {
          parsed = parseStatusJson(status, meetingId);
        } catch {
          throw new StatusUpdaterError("invalid_status_update");
        }
        return persist(meetingId, parsed);
      });
    }),
    update: (meetingId, reducer, ownerToken) => withLease(meetingId, ownerToken, () => {
      const target = paths(meetingId);
      return enqueue(target.status, async () => {
        const fence = await tombstones.inspect(meetingId);
        if (fence.state === "deleted") throw new StatusUpdaterError("meeting_deleted");
        if (fence.state === "ambiguous") throw new StatusUpdaterError("delete_state_ambiguous");
        if (updaterState().pending.has(target.status)) {
          throw new StatusUpdaterError("status_durability_pending");
        }
        const latest = await read(meetingId);
        if (!latest) throw new StatusUpdaterError("status_not_found");
        let next: StatusJson;
        try {
          const reduced = reducer(deepFreeze(structuredClone(latest)));
          next = parseStatusJson({ ...latest, ...reduced }, meetingId);
        } catch {
          throw new StatusUpdaterError("invalid_status_update");
        }
        return persist(meetingId, next);
      });
    }),
    retryPending: (meetingId) => {
      const target = paths(meetingId);
      return enqueue(target.status, async () => {
        const pending = updaterState().pending.get(target.status);
        const directories = pending?.directories ?? [target.directory];
        const durability = await retryNamespaceDurability(directories, { fileOps, capability });
        if (durability === "pending") {
          updaterState().pending.set(target.status, { directories });
        } else {
          updaterState().pending.delete(target.status);
        }
        return durability;
      });
    },
  };
}

export function getStatusUpdater(dataRoot: string): StatusUpdater {
  const state = updaterState();
  const existing = state.defaults.get(dataRoot);
  if (existing) return existing;
  const updater = createStatusUpdater({ dataRoot });
  state.defaults.set(dataRoot, updater);
  return updater;
}
