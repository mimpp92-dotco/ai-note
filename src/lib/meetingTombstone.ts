import { constants } from "node:fs";
import { join, relative, resolve } from "node:path";

import { z } from "zod";

import {
  createDirectorySyncCapability,
  createNodeFileOps,
  durableAtomicReplace,
  retryNamespaceDurability,
  type DirectorySyncCapability,
  type FileOps,
} from "@/lib/durableFileOps";
import { assertSafeId } from "@/lib/meetingId";
import { dataRoot as defaultDataRoot } from "@/lib/paths";

const tombstoneSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  deletedAt: z.string().datetime({ offset: true }),
}).strict();

export interface MeetingTombstone {
  id: string;
  deletedAt: string;
}

export type MeetingTombstoneObservation =
  | { state: "none" }
  | { state: "deleted"; tombstone: MeetingTombstone }
  | { state: "ambiguous" };

export interface MeetingTombstoneCreateResult {
  state: "deleted";
  tombstone: MeetingTombstone;
  durability: "durable" | "best_effort" | "pending";
  created: boolean;
}

export class MeetingTombstoneError extends Error {
  readonly code: "delete_state_ambiguous" | "tombstone_write_failed";

  constructor(code: MeetingTombstoneError["code"]) {
    super(code);
    this.name = "MeetingTombstoneError";
    this.code = code;
  }
}

export interface MeetingTombstoneStoreOptions {
  dataRoot: string;
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
  now?: () => string;
}

export interface MeetingTombstoneStore {
  inspect(meetingId: string): Promise<MeetingTombstoneObservation>;
  create(meetingId: string): Promise<MeetingTombstoneCreateResult>;
  retryDurability(meetingId: string): Promise<"durable" | "best_effort" | "pending">;
}

interface GlobalTombstoneState {
  pending: Map<string, string[]>;
  defaults: Map<string, MeetingTombstoneStore>;
}

declare global {
  var __aiNoteMeetingTombstones: GlobalTombstoneState | undefined;
}

function state(): GlobalTombstoneState {
  globalThis.__aiNoteMeetingTombstones ??= { pending: new Map(), defaults: new Map() };
  return globalThis.__aiNoteMeetingTombstones;
}

export function resetMeetingTombstoneStateForTests(): void {
  globalThis.__aiNoteMeetingTombstones = { pending: new Map(), defaults: new Map() };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

export function meetingTombstonesRoot(root = defaultDataRoot()): string {
  return join(root, "meeting-tombstones");
}

export function meetingTombstonePath(meetingId: string, root = defaultDataRoot()): string {
  return join(meetingTombstonesRoot(root), `${assertSafeId(meetingId)}.json`);
}

export function createMeetingTombstoneStore(
  options: MeetingTombstoneStoreOptions,
): MeetingTombstoneStore {
  const root = resolve(options.dataRoot);
  const directory = meetingTombstonesRoot(root);
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const now = options.now ?? (() => new Date().toISOString());

  const inspect = async (meetingId: string): Promise<MeetingTombstoneObservation> => {
    const path = meetingTombstonePath(meetingId, root);
    try {
      const directoryInfo = await fileOps.lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return { state: "ambiguous" };
      const realRoot = await fileOps.realpath(root);
      const realDirectory = await fileOps.realpath(directory);
      if (!contained(realRoot, realDirectory)) return { state: "ambiguous" };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { state: "none" };
      return { state: "ambiguous" };
    }

    let handle: Awaited<ReturnType<FileOps["openFile"]>> | null = null;
    try {
      const info = await fileOps.lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024) {
        return { state: "ambiguous" };
      }
      handle = await fileOps.openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const bytes = await handle.readFile();
      const value = tombstoneSchema.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ));
      if (value.id !== meetingId) return { state: "ambiguous" };
      return { state: "deleted", tombstone: value };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { state: "none" };
      return { state: "ambiguous" };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  };

  const retryDurability = async (
    meetingId: string,
  ): Promise<"durable" | "best_effort" | "pending"> => {
    const path = meetingTombstonePath(meetingId, root);
    const directories = state().pending.get(path) ?? [directory];
    const durability = await retryNamespaceDurability(directories, { fileOps, capability });
    if (durability === "pending") state().pending.set(path, directories);
    else state().pending.delete(path);
    return durability;
  };

  return {
    inspect,
    async create(meetingId): Promise<MeetingTombstoneCreateResult> {
      const safeId = assertSafeId(meetingId);
      await fileOps.mkdir(directory, { recursive: true, mode: 0o700 });
      const current = await inspect(safeId);
      if (current.state === "ambiguous") {
        throw new MeetingTombstoneError("delete_state_ambiguous");
      }
      if (current.state === "deleted") {
        return {
          ...current,
          durability: await retryDurability(safeId),
          created: false,
        };
      }
      const tombstone = tombstoneSchema.parse({ id: safeId, deletedAt: now() });
      const path = meetingTombstonePath(safeId, root);
      const commit = await durableAtomicReplace({
        rootPath: root,
        targetPath: path,
        data: `${JSON.stringify(tombstone, null, 2)}\n`,
        fileOps,
        capability,
      });
      if (commit.state === "not_committed") {
        throw new MeetingTombstoneError("tombstone_write_failed");
      }
      if (commit.durability === "pending") state().pending.set(path, [directory]);
      return {
        state: "deleted",
        tombstone,
        durability: commit.durability === "none" ? "pending" : commit.durability,
        created: true,
      };
    },
    retryDurability,
  };
}

export function getMeetingTombstoneStore(root = defaultDataRoot()): MeetingTombstoneStore {
  const canonicalRoot = resolve(root);
  const existing = state().defaults.get(canonicalRoot);
  if (existing) return existing;
  const store = createMeetingTombstoneStore({ dataRoot: canonicalRoot });
  state().defaults.set(canonicalRoot, store);
  return store;
}

export function inspectMeetingTombstone(
  meetingId: string,
  root = defaultDataRoot(),
): Promise<MeetingTombstoneObservation> {
  return getMeetingTombstoneStore(root).inspect(meetingId);
}
