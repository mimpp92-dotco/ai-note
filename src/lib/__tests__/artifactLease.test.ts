// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireArtifactReadLease,
  acquireArtifactWriteLease,
  resetArtifactLeaseStateForTests,
} from "@/lib/artifactLease";
import {
  acquireMeetingOperation,
  resetMeetingLifecycleForTests,
} from "@/lib/meetingLifecycle";

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "artifact-lease-"));
  process.chdir(workDir);
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  rmSync(workDir, { recursive: true, force: true });
});

describe("artifact generation RW lease", () => {
  it("allows concurrent readers and keeps a writer waiting until every reader releases", async () => {
    const first = await acquireArtifactReadLease("meeting-1");
    const second = await acquireArtifactReadLease("meeting-1");
    const operation = await acquireMeetingOperation("meeting-1", "summarize");
    let writerAcquired = false;
    const writerPromise = acquireArtifactWriteLease("meeting-1", operation.ownerToken).then((lease) => {
      writerAcquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(writerAcquired).toBe(false);
    first.release();
    await Promise.resolve();
    expect(writerAcquired).toBe(false);
    second.release();

    const writer = await writerPromise;
    expect(writerAcquired).toBe(true);
    writer.release();
    operation.release();
  });

  it("requires a live meeting-operation owner before granting a write lease", async () => {
    await expect(acquireArtifactWriteLease("meeting-1", "not-an-owner"))
      .rejects.toThrowError("invalid_meeting_operation_owner");
  });

  it("does not let a queued reader overtake a queued writer", async () => {
    const firstReader = await acquireArtifactReadLease("meeting-1");
    const operation = await acquireMeetingOperation("meeting-1", "summarize");
    const order: string[] = [];
    const writerPromise = acquireArtifactWriteLease("meeting-1", operation.ownerToken).then((lease) => {
      order.push("writer");
      return lease;
    });
    const readerPromise = acquireArtifactReadLease("meeting-1").then((lease) => {
      order.push("reader");
      return lease;
    });

    firstReader.release();
    const writer = await writerPromise;
    expect(order).toEqual(["writer"]);
    writer.release();
    const reader = await readerPromise;
    expect(order).toEqual(["writer", "reader"]);
    reader.release();
    operation.release();
  });
});
