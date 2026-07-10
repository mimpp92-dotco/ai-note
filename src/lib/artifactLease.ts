import { randomUUID } from "node:crypto";

import { assertMeetingOperationOwner } from "@/lib/meetingLifecycle";
import { assertSafeId } from "@/lib/meetingId";
import { meetingDir } from "@/lib/paths";

export type ArtifactLeaseMode = "read" | "write";

interface Waiter {
  mode: ArtifactLeaseMode;
  token: string;
  resolve: (lease: ArtifactGenerationLease) => void;
}

interface ArtifactLeaseState {
  readers: Set<string>;
  writer: string | null;
  waiters: Waiter[];
}

interface GlobalArtifactLeaseState {
  meetings: Map<string, ArtifactLeaseState>;
}

declare global {
  var __aiNoteArtifactLease: GlobalArtifactLeaseState | undefined;
}

function globalState(): GlobalArtifactLeaseState {
  globalThis.__aiNoteArtifactLease ??= { meetings: new Map() };
  return globalThis.__aiNoteArtifactLease;
}

export function resetArtifactLeaseStateForTests(): void {
  globalThis.__aiNoteArtifactLease = { meetings: new Map() };
}

function keyFor(meetingId: string): string {
  assertSafeId(meetingId);
  return meetingDir(meetingId);
}

export interface ArtifactGenerationLease {
  readonly meetingId: string;
  readonly mode: ArtifactLeaseMode;
  readonly ownerToken: string;
  release(ownerToken?: string): boolean;
}

function makeLease(
  key: string,
  meetingId: string,
  mode: ArtifactLeaseMode,
  token: string,
): ArtifactGenerationLease {
  let released = false;
  return {
    meetingId,
    mode,
    ownerToken: token,
    release(providedToken = token): boolean {
      if (released || providedToken !== token) return false;
      const state = globalState().meetings.get(key);
      if (!state) return false;
      let removed = false;
      if (mode === "read") {
        removed = state.readers.delete(token);
      } else if (state.writer === token) {
        state.writer = null;
        removed = true;
      }
      if (!removed) return false;
      released = true;
      drain(key, meetingId, state);
      if (state.writer === null && state.readers.size === 0 && state.waiters.length === 0) {
        globalState().meetings.delete(key);
      }
      return true;
    },
  };
}

function drain(key: string, meetingId: string, state: ArtifactLeaseState): void {
  if (state.writer !== null || state.readers.size > 0 || state.waiters.length === 0) return;
  if (state.waiters[0].mode === "write") {
    const waiter = state.waiters.shift()!;
    state.writer = waiter.token;
    waiter.resolve(makeLease(key, meetingId, "write", waiter.token));
    return;
  }
  while (state.waiters[0]?.mode === "read" && state.writer === null) {
    const waiter = state.waiters.shift()!;
    state.readers.add(waiter.token);
    waiter.resolve(makeLease(key, meetingId, "read", waiter.token));
  }
}

export function acquireArtifactReadLease(
  meetingId: string,
  token = randomUUID(),
): Promise<ArtifactGenerationLease> {
  const key = keyFor(meetingId);
  const state = globalState().meetings.get(key) ?? {
    readers: new Set<string>(),
    writer: null,
    waiters: [],
  };
  globalState().meetings.set(key, state);
  // Once a writer is queued, later readers queue behind it to prevent starvation.
  if (state.writer === null && state.waiters.length === 0) {
    state.readers.add(token);
    return Promise.resolve(makeLease(key, meetingId, "read", token));
  }
  return new Promise((resolve) => state.waiters.push({ mode: "read", token, resolve }));
}

export async function acquireArtifactWriteLease(
  meetingId: string,
  meetingOperationOwnerToken: string,
  token = randomUUID(),
): Promise<ArtifactGenerationLease> {
  assertMeetingOperationOwner(meetingId, meetingOperationOwnerToken);
  const key = keyFor(meetingId);
  const state = globalState().meetings.get(key) ?? {
    readers: new Set<string>(),
    writer: null,
    waiters: [],
  };
  globalState().meetings.set(key, state);
  if (state.writer === null && state.readers.size === 0 && state.waiters.length === 0) {
    state.writer = token;
    return makeLease(key, meetingId, "write", token);
  }
  return new Promise((resolve) => state.waiters.push({ mode: "write", token, resolve }));
}
