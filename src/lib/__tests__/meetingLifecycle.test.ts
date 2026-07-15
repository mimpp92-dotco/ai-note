// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireMeetingOperation,
  isExactMeetingOperationActive,
  isMeetingOperationActive,
  resetMeetingLifecycleForTests,
  tryAcquireMeetingOperation,
} from "@/lib/meetingLifecycle";

let cwd: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "meeting-lifecycle-"));
  process.chdir(cwd);
  resetMeetingLifecycleForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  resetMeetingLifecycleForTests();
  rmSync(cwd, { recursive: true, force: true });
});

describe("meeting operation coordinator", () => {
  it("enforces exclusive finalize/delete and one summarize per meeting", async () => {
    const finalize = await tryAcquireMeetingOperation("m1", "finalize");
    expect(finalize).not.toBeNull();
    await expect(tryAcquireMeetingOperation("m1", "status")).resolves.toBeNull();
    await expect(tryAcquireMeetingOperation("m1", "summarize")).resolves.toBeNull();
    finalize?.release();

    const summarize = await tryAcquireMeetingOperation("m1", "summarize");
    expect(summarize).not.toBeNull();
    await expect(tryAcquireMeetingOperation("m1", "summarize")).resolves.toBeNull();
    await expect(tryAcquireMeetingOperation("m1", "delete")).resolves.toBeNull();
    summarize?.release();
  });

  it("allows move with summarize and transcribe while serializing duplicate operation kinds", async () => {
    const summarize = await acquireMeetingOperation("m1", "summarize");
    const move = await tryAcquireMeetingOperation("m1", "move");
    const transcribe = await tryAcquireMeetingOperation("m1", "transcribe_dispatch");
    expect(move).not.toBeNull();
    expect(transcribe).not.toBeNull();
    expect(await tryAcquireMeetingOperation("m1", "transcribe_dispatch")).toBeNull();
    transcribe?.release();
    move?.release();
    summarize.release();
  });

  it("lets only the owner token release and exposes coordinator-backed inflight state", async () => {
    const lease = await acquireMeetingOperation("m1", "summarize");
    expect(isMeetingOperationActive("m1", "summarize")).toBe(true);
    expect(lease.release("wrong-token")).toBe(false);
    expect(isMeetingOperationActive("m1", "summarize")).toBe(true);
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(isMeetingOperationActive("m1", "summarize")).toBe(false);
  });

  it("queues conflicting work and recovers after release", async () => {
    const first = await acquireMeetingOperation("m1", "delete");
    let secondAcquired = false;
    const secondPromise = acquireMeetingOperation("m1", "status").then((lease) => {
      secondAcquired = true;
      return lease;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();
  });

  it("isolates same IDs under different absolute roots", async () => {
    const first = await acquireMeetingOperation("same", "delete");
    const otherRoot = mkdtempSync(join(tmpdir(), "meeting-lifecycle-other-"));
    process.chdir(otherRoot);
    try {
      const other = await tryAcquireMeetingOperation("same", "delete");
      expect(other).not.toBeNull();
      other?.release();
    } finally {
      process.chdir(cwd);
      first.release();
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("serializes every content mutation while keeping status and move compatible", async () => {
    const manual = await acquireMeetingOperation("m1", "manual_edit");
    expect(isExactMeetingOperationActive("m1", "manual_edit")).toBe(true);
    await expect(tryAcquireMeetingOperation("m1", "summarize")).resolves.toBeNull();
    await expect(tryAcquireMeetingOperation("m1", "summarize_reconcile")).resolves.toBeNull();
    await expect(tryAcquireMeetingOperation("m1", "transcript_regenerate")).resolves.toBeNull();
    await expect(tryAcquireMeetingOperation("m1", "summary_regenerate")).resolves.toBeNull();
    await expect(tryAcquireMeetingOperation("m1", "delete")).resolves.toBeNull();

    const statusLease = await tryAcquireMeetingOperation("m1", "status");
    const moveLease = await tryAcquireMeetingOperation("m1", "move");
    expect(statusLease).not.toBeNull();
    expect(moveLease).not.toBeNull();
    statusLease?.release();
    moveLease?.release();
    manual.release();
  });
});
