import { randomUUID } from "node:crypto";

import { assertSafeId } from "@/lib/meetingId";
import { meetingDir } from "@/lib/paths";

export type MeetingOperation =
  | "status"
  | "finalize"
  | "summarize"
  | "summarize_reconcile"
  | "transcribe_dispatch"
  | "move"
  | "delete"
  | "cleanup";

interface ActiveOperation {
  operation: MeetingOperation;
  token: string;
}

interface Waiter {
  operation: MeetingOperation;
  token: string;
  resolve: (lease: MeetingOperationLease) => void;
}

interface MeetingOperationState {
  active: ActiveOperation[];
  waiters: Waiter[];
}

interface GlobalMeetingLifecycleState {
  meetings: Map<string, MeetingOperationState>;
}

declare global {
  var __aiNoteMeetingLifecycle: GlobalMeetingLifecycleState | undefined;
}

function lifecycleState(): GlobalMeetingLifecycleState {
  globalThis.__aiNoteMeetingLifecycle ??= { meetings: new Map() };
  return globalThis.__aiNoteMeetingLifecycle;
}

export function resetMeetingLifecycleForTests(): void {
  globalThis.__aiNoteMeetingLifecycle = { meetings: new Map() };
}

function keyFor(meetingId: string): string {
  assertSafeId(meetingId);
  return meetingDir(meetingId);
}

function operationGroup(operation: MeetingOperation): string {
  return operation === "summarize_reconcile" ? "summarize" : operation;
}

function compatible(a: MeetingOperation, b: MeetingOperation): boolean {
  const groupA = operationGroup(a);
  const groupB = operationGroup(b);
  if (["finalize", "delete", "cleanup"].includes(groupA)) return false;
  if (["finalize", "delete", "cleanup"].includes(groupB)) return false;
  if (groupA === groupB) return false;
  // Short status writes are serialized by their own queue but may occur while a
  // long summarize/move/dispatch lease is active.
  return true;
}

function canGrant(state: MeetingOperationState, operation: MeetingOperation): boolean {
  return state.active.every((active) => compatible(active.operation, operation));
}

export interface MeetingOperationLease {
  readonly meetingId: string;
  readonly operation: MeetingOperation;
  readonly ownerToken: string;
  release(ownerToken?: string): boolean;
}

function makeLease(
  key: string,
  meetingId: string,
  operation: MeetingOperation,
  token: string,
): MeetingOperationLease {
  let released = false;
  return {
    meetingId,
    operation,
    ownerToken: token,
    release(providedToken = token): boolean {
      if (released || providedToken !== token) return false;
      const state = lifecycleState().meetings.get(key);
      if (!state) return false;
      const index = state.active.findIndex((active) => active.token === token);
      if (index < 0) return false;
      state.active.splice(index, 1);
      released = true;
      drainWaiters(key, meetingId, state);
      if (state.active.length === 0 && state.waiters.length === 0) {
        lifecycleState().meetings.delete(key);
      }
      return true;
    },
  };
}

function drainWaiters(
  key: string,
  meetingId: string,
  state: MeetingOperationState,
): void {
  while (state.waiters.length > 0) {
    const waiter = state.waiters[0];
    if (!canGrant(state, waiter.operation)) break;
    state.waiters.shift();
    state.active.push({ operation: waiter.operation, token: waiter.token });
    waiter.resolve(makeLease(key, meetingId, waiter.operation, waiter.token));
  }
}

export async function tryAcquireMeetingOperation(
  meetingId: string,
  operation: MeetingOperation,
  token = randomUUID(),
): Promise<MeetingOperationLease | null> {
  const key = keyFor(meetingId);
  const state = lifecycleState().meetings.get(key) ?? { active: [], waiters: [] };
  lifecycleState().meetings.set(key, state);
  if (state.waiters.length > 0 || !canGrant(state, operation)) return null;
  state.active.push({ operation, token });
  return makeLease(key, meetingId, operation, token);
}

export function acquireMeetingOperation(
  meetingId: string,
  operation: MeetingOperation,
  token = randomUUID(),
): Promise<MeetingOperationLease> {
  const key = keyFor(meetingId);
  const state = lifecycleState().meetings.get(key) ?? { active: [], waiters: [] };
  lifecycleState().meetings.set(key, state);
  if (state.waiters.length === 0 && canGrant(state, operation)) {
    state.active.push({ operation, token });
    return Promise.resolve(makeLease(key, meetingId, operation, token));
  }
  return new Promise((resolve) => {
    state.waiters.push({ operation, token, resolve });
  });
}

export function assertMeetingOperationOwner(meetingId: string, ownerToken: string): void {
  const state = lifecycleState().meetings.get(keyFor(meetingId));
  if (!state?.active.some((active) => active.token === ownerToken)) {
    throw new Error("invalid_meeting_operation_owner");
  }
}

export function isMeetingOperationActive(
  meetingId: string,
  operation?: MeetingOperation,
): boolean {
  const state = lifecycleState().meetings.get(keyFor(meetingId));
  if (!state) return false;
  return operation === undefined
    ? state.active.length > 0
    : state.active.some((active) => operationGroup(active.operation) === operationGroup(operation));
}

export function isExactMeetingOperationActive(
  meetingId: string,
  operation: MeetingOperation,
): boolean {
  const state = lifecycleState().meetings.get(keyFor(meetingId));
  return state?.active.some((active) => active.operation === operation) ?? false;
}
