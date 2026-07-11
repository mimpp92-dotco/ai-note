import { lstat, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { acquireArtifactWriteLease } from "@/lib/artifactLease";
import { syncNamespaces } from "@/lib/durableFileOps";
import { createLibraryRepository } from "@/lib/library";
import { tryAcquireMeetingOperation } from "@/lib/meetingLifecycle";
import {
  getMeetingTombstoneStore,
  meetingTombstonesRoot,
} from "@/lib/meetingTombstone";
import { dataRoot as defaultDataRoot } from "@/lib/paths";

interface CleanupState {
  inflight: Map<string, Promise<MeetingCleanupSweepResult>>;
  lastStartedAt: Map<string, number>;
  pendingRoots: Set<string>;
}

declare global {
  var __aiNoteMeetingCleanup: CleanupState | undefined;
}

function cleanupState(): CleanupState {
  globalThis.__aiNoteMeetingCleanup ??= {
    inflight: new Map(),
    lastStartedAt: new Map(),
    pendingRoots: new Set(),
  };
  return globalThis.__aiNoteMeetingCleanup;
}

export function resetMeetingCleanupStateForTests(): void {
  globalThis.__aiNoteMeetingCleanup = {
    inflight: new Map(),
    lastStartedAt: new Map(),
    pendingRoots: new Set(),
  };
}

export function markMeetingCleanupPending(root = defaultDataRoot()): void {
  cleanupState().pendingRoots.add(resolve(root));
}

export interface MeetingCleanupSweepResult {
  inspected: number;
  cleaned: number;
  pending: number;
}

async function pathKind(path: string): Promise<"missing" | "directory" | "unsafe"> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() ? "directory" : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

async function cleanupPlacement(root: string, meetingId: string): Promise<boolean> {
  try {
    const repository = createLibraryRepository({ dataRoot: root });
    const read = await repository.read();
    if (read.mode !== "ready") return read.mode === "missing";
    await repository.transactLatest((document) => ({
      ...document,
      placements: document.placements.filter((placement) => placement.meetingId !== meetingId),
    }));
    return true;
  } catch {
    return false;
  }
}

async function cleanupOne(root: string, meetingId: string): Promise<boolean> {
  const operation = await tryAcquireMeetingOperation(meetingId, "cleanup");
  if (!operation) return false;
  try {
    const artifact = await acquireArtifactWriteLease(meetingId, operation.ownerToken);
    try {
      let complete = await cleanupPlacement(root, meetingId);
      const meetings = join(root, "meetings");
      const live = join(meetings, meetingId);
      const trash = join(meetings, `.trash-${meetingId}`);
      const liveKind = await pathKind(live);
      let trashKind = await pathKind(trash);
      if (liveKind === "unsafe" || trashKind === "unsafe") return false;
      if (liveKind === "directory") {
        if (trashKind === "directory") {
          await rm(trash, { recursive: true, force: true });
          trashKind = "missing";
        }
        if (trashKind === "missing") {
          try {
            await rename(live, trash);
            if ((await syncNamespaces([meetings])).durability === "pending") complete = false;
            trashKind = "directory";
          } catch {
            complete = false;
          }
        }
      }
      if (trashKind === "directory") {
        try {
          await rm(trash, { recursive: true, force: true });
          if ((await syncNamespaces([meetings])).durability === "pending") complete = false;
        } catch {
          complete = false;
        }
      }
      return complete;
    } finally {
      artifact.release();
    }
  } finally {
    operation.release();
  }
}

export async function sweepMeetingTombstones(
  rootInput = defaultDataRoot(),
): Promise<MeetingCleanupSweepResult> {
  const root = resolve(rootInput);
  const tombstoneDirectory = meetingTombstonesRoot(root);
  let entries;
  try {
    const kind = await pathKind(tombstoneDirectory);
    if (kind === "missing") return { inspected: 0, cleaned: 0, pending: 0 };
    if (kind !== "directory") return { inspected: 0, cleaned: 0, pending: 1 };
    entries = await readdir(tombstoneDirectory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return { inspected: 0, cleaned: 0, pending: 1 };
  }

  const result: MeetingCleanupSweepResult = { inspected: 0, cleaned: 0, pending: 0 };
  const store = getMeetingTombstoneStore(root);
  for (const entry of entries) {
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/u.exec(entry.name);
    if (!match) continue;
    const meetingId = match[1];
    result.inspected += 1;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      result.pending += 1;
      continue;
    }
    const observation = await store.inspect(meetingId);
    if (observation.state !== "deleted") {
      result.pending += 1;
      continue;
    }
    if (await cleanupOne(root, meetingId)) result.cleaned += 1;
    else result.pending += 1;
    await import("@/lib/summaryWorkCache")
      .then(({ invalidateSummaryWork }) => invalidateSummaryWork(root))
      .catch(() => {});
  }
  if (result.pending > 0) cleanupState().pendingRoots.add(root);
  else cleanupState().pendingRoots.delete(root);
  return result;
}

export function startMeetingCleanupSweep(
  rootInput = defaultDataRoot(),
  options: { force?: boolean } = {},
): Promise<MeetingCleanupSweepResult> {
  const root = resolve(rootInput);
  const state = cleanupState();
  const existing = state.inflight.get(root);
  if (existing) return existing;
  const now = Date.now();
  if (
    !options.force
    && !state.pendingRoots.has(root)
    && now - (state.lastStartedAt.get(root) ?? 0) < 1_000
  ) return Promise.resolve({ inspected: 0, cleaned: 0, pending: 0 });
  state.lastStartedAt.set(root, now);
  const run = sweepMeetingTombstones(root);
  state.inflight.set(root, run);
  void run.finally(() => {
    if (state.inflight.get(root) === run) state.inflight.delete(root);
  });
  return run;
}
