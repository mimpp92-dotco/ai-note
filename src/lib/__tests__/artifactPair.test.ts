// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SummarizeAttempt } from "@/domain/meeting";
import { readArtifactPair } from "@/lib/artifactPair";
import { resetArtifactLeaseStateForTests } from "@/lib/artifactLease";
import {
  acquireMeetingOperation,
  resetMeetingLifecycleForTests,
} from "@/lib/meetingLifecycle";
import { meetingPaths } from "@/lib/paths";
import { initialStatus, writeStatus } from "@/lib/status";
import { resetStatusUpdaterStateForTests } from "@/lib/statusUpdater";
import { publishSummarizeAttempt } from "@/lib/summarizePublisher";

const OLD_T = "old transcript\n";
const OLD_S = "old summary\n";
const NEW_T = "new transcript\n";
const NEW_S = "new summary\n";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "artifact-pair-"));
  process.chdir(workDir);
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetStatusUpdaterStateForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetStatusUpdaterStateForTests();
  rmSync(workDir, { recursive: true, force: true });
});

async function seed(id: string): Promise<SummarizeAttempt> {
  const paths = meetingPaths(id);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.transcript, OLD_T);
  await writeFile(paths.summary, OLD_S);
  const attempt: SummarizeAttempt = {
    attemptId: randomUUID(),
    kind: "resummarize",
    startedAt: "2026-07-10T00:00:00.000Z",
    preTranscriptHash: hash(OLD_T),
    preSummaryHash: hash(OLD_S),
  };
  await writeStatus(id, {
    ...initialStatus(id, {
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: "2026-07-10T00:01:00.000Z",
      durationMs: 60_000,
      audioMime: "audio/webm",
    }),
    status: "summarizing",
    summarizeAttempt: attempt,
  });
  return attempt;
}

describe("generation-consistent artifact pair reader", () => {
  it("returns the old pair while a publisher waits, then the complete new pair", async () => {
    const id = "meeting-reader";
    const attempt = await seed(id);
    const operation = await acquireMeetingOperation(id, "summarize");
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let readerHasTranscript!: () => void;
    const readerReady = new Promise<void>((resolve) => { readerHasTranscript = resolve; });
    const oldRead = readArtifactPair(id, {
      barrier: async (point) => {
        if (point === "after_transcript_read") {
          readerHasTranscript();
          await blocked;
        }
      },
    });
    await readerReady;
    let publishDone = false;
    const publishing = publishSummarizeAttempt({
      id,
      ownerToken: operation.ownerToken,
      attempt,
      transcript: NEW_T,
      summary: NEW_S,
    }).then(() => { publishDone = true; });
    await Promise.resolve();
    expect(publishDone).toBe(false);
    unblock();

    await expect(oldRead).resolves.toMatchObject({ transcript: OLD_T, summary: OLD_S });
    await publishing;
    operation.release();
    await expect(readArtifactPair(id)).resolves.toMatchObject({
      transcript: NEW_T,
      summary: NEW_S,
      state: "stable",
    });
  });

  it("serializes concurrent first readers through one restart reconciliation", async () => {
    const id = "meeting-restart-readers";
    const attempt = await seed(id);
    const operation = await acquireMeetingOperation(id, "summarize");
    await expect(publishSummarizeAttempt({
      id,
      ownerToken: operation.ownerToken,
      attempt,
      transcript: NEW_T,
      summary: NEW_S,
    }, {
      barrier: async (point) => {
        if (point === "after_transcript_publish") {
          throw Object.assign(new Error("crash"), { simulateCrash: true });
        }
      },
    })).rejects.toThrowError("crash");
    operation.release();

    const [first, second] = await Promise.all([
      readArtifactPair(id),
      readArtifactPair(id),
    ]);
    expect(first).toMatchObject({ transcript: NEW_T, summary: NEW_S, state: "stable" });
    expect(second).toMatchObject({ transcript: NEW_T, summary: NEW_S, state: "stable" });
  });
});
