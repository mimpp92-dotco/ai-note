// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SummarizeAttempt } from "@/domain/meeting";
import { resetArtifactLeaseStateForTests } from "@/lib/artifactLease";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  type FileOps,
} from "@/lib/durableFileOps";
import {
  acquireMeetingOperation,
  resetMeetingLifecycleForTests,
} from "@/lib/meetingLifecycle";
import { meetingPaths } from "@/lib/paths";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import { resetStatusUpdaterStateForTests } from "@/lib/statusUpdater";
import {
  planSummarizeReconciliation,
  publishSummarizeAttempt,
  reconcileSummarizeAttempt,
  summarizeAttemptPaths,
  type SummarizePublisherBarrier,
} from "@/lib/summarizePublisher";

const OLD_TRANSCRIPT = "old transcript\n";
const OLD_SUMMARY = `${JSON.stringify({ title: "old" })}\n`;
const NEW_TRANSCRIPT = "new transcript\n";
const NEW_SUMMARY = `${JSON.stringify({ title: "new" })}\n`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "summarize-publisher-"));
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

async function seed(id: string, kind: SummarizeAttempt["kind"]): Promise<SummarizeAttempt> {
  const paths = meetingPaths(id);
  await mkdir(paths.dir, { recursive: true });
  if (kind === "resummarize") {
    await writeFile(paths.transcript, OLD_TRANSCRIPT);
    await writeFile(paths.summary, OLD_SUMMARY);
  }
  const attempt: SummarizeAttempt = {
    attemptId: randomUUID(),
    kind,
    startedAt: "2026-07-10T00:00:00.000Z",
    ...(kind === "resummarize"
      ? { preTranscriptHash: hash(OLD_TRANSCRIPT), preSummaryHash: hash(OLD_SUMMARY) }
      : {}),
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

function failDirectorySyncAfterCanonicalRename(targetPath: string): FileOps {
  const base = createNodeFileOps();
  let failNextSync = false;
  let injected = false;
  return {
    ...base,
    rename: async (sourcePath, destinationPath) => {
      await base.rename(sourcePath, destinationPath);
      if (!injected && destinationPath === targetPath) {
        injected = true;
        failNextSync = true;
      }
    },
    openDirectory: async (path) => {
      const handle = await base.openDirectory(path);
      return {
        sync: async () => {
          if (failNextSync) {
            failNextSync = false;
            throw Object.assign(new Error("directory sync fault"), { code: "EIO" });
          }
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };
}

describe("summarize reconciliation planner", () => {
  const pre = { transcript: "t0", summary: "s0" };
  const intended = { transcript: "t1", summary: "s1" };

  it.each([
    ["completed", intended, true, "summary_published", "completed"],
    ["old pair with staged output", pre, true, "preimage_durable", "resume"],
    ["mixed pair with staged output", { transcript: "t1", summary: "s0" }, true, "transcript_published", "resume"],
    ["old pair without recoverable stage", pre, false, null, "interrupt"],
    ["mixed pair without recoverable stage", { transcript: "t1", summary: "s0" }, false, "transcript_published", "restore"],
    ["contradictory summary", { transcript: "t0", summary: "s1" }, true, "summary_published", "ambiguous"],
  ] as const)("plans %s as %s", (_name, current, staged, phase, expected) => {
    expect(planSummarizeReconciliation({ pre, intended, current, staged, phase })).toBe(expected);
  });
});

describe("durable summarize pair publisher", () => {
  it("publishes both staged artifacts, clears only the matching attempt, then removes staging", async () => {
    const id = "meeting-publish";
    const attempt = await seed(id, "resummarize");
    const operation = await acquireMeetingOperation(id, "summarize");
    const result = await publishSummarizeAttempt({
      id,
      ownerToken: operation.ownerToken,
      attempt,
      transcript: NEW_TRANSCRIPT,
      summary: NEW_SUMMARY,
    });
    operation.release();

    const paths = meetingPaths(id);
    expect(await readFile(paths.transcript, "utf8")).toBe(NEW_TRANSCRIPT);
    expect(await readFile(paths.summary, "utf8")).toBe(NEW_SUMMARY);
    expect((await readStatus(id))?.summarizeAttempt).toBeUndefined();
    expect((await readStatus(id))?.status).toBe("summarized");
    expect(result.state).toBe("published");
    expect(existsSync(summarizeAttemptPaths(id, attempt.attemptId).dir)).toBe(false);
  });

  it("restores the old transcript when summary publication fails", async () => {
    const id = "meeting-restore";
    const attempt = await seed(id, "resummarize");
    const operation = await acquireMeetingOperation(id, "summarize");
    const barrier: SummarizePublisherBarrier = async (point) => {
      if (point === "before_summary_publish") throw new Error("fault");
    };
    await expect(publishSummarizeAttempt({
      id,
      ownerToken: operation.ownerToken,
      attempt,
      transcript: NEW_TRANSCRIPT,
      summary: NEW_SUMMARY,
    }, { barrier })).rejects.toMatchObject({ code: "summarize_publication_failed", restored: true });
    operation.release();

    const paths = meetingPaths(id);
    expect(await readFile(paths.transcript, "utf8")).toBe(OLD_TRANSCRIPT);
    expect(await readFile(paths.summary, "utf8")).toBe(OLD_SUMMARY);
    expect((await readStatus(id))?.summarizeAttempt?.attemptId).toBe(attempt.attemptId);
  });

  it("reconciles a crash after transcript publication without exposing a mixed generation", async () => {
    const id = "meeting-reconcile";
    const attempt = await seed(id, "resummarize");
    const operation = await acquireMeetingOperation(id, "summarize");
    const crash: SummarizePublisherBarrier = async (point) => {
      if (point === "after_transcript_publish") {
        throw Object.assign(new Error("crash"), { simulateCrash: true });
      }
    };
    await expect(publishSummarizeAttempt({
      id,
      ownerToken: operation.ownerToken,
      attempt,
      transcript: NEW_TRANSCRIPT,
      summary: NEW_SUMMARY,
    }, { barrier: crash })).rejects.toThrowError("crash");
    operation.release();

    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(NEW_TRANSCRIPT);
    expect(await readFile(meetingPaths(id).summary, "utf8")).toBe(OLD_SUMMARY);

    const reconcileOperation = await acquireMeetingOperation(id, "summarize_reconcile");
    const result = await reconcileSummarizeAttempt(id, reconcileOperation.ownerToken);
    reconcileOperation.release();
    expect(result).toMatchObject({ state: "completed" });
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(NEW_TRANSCRIPT);
    expect(await readFile(meetingPaths(id).summary, "utf8")).toBe(NEW_SUMMARY);
    expect((await readStatus(id))?.summarizeAttempt).toBeUndefined();
  });

  it("restores the old pair when transcript rename commits but its directory sync is pending", async () => {
    const id = "meeting-transcript-sync";
    const attempt = await seed(id, "resummarize");
    const operation = await acquireMeetingOperation(id, "summarize");
    const fileOps = failDirectorySyncAfterCanonicalRename(meetingPaths(id).transcript);
    await expect(publishSummarizeAttempt({
      id,
      ownerToken: operation.ownerToken,
      attempt,
      transcript: NEW_TRANSCRIPT,
      summary: NEW_SUMMARY,
    }, {
      fileOps,
      capability: createDirectorySyncCapability("supported"),
    })).rejects.toMatchObject({
      code: "summarize_publication_failed",
      restored: true,
    });
    operation.release();
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(OLD_TRANSCRIPT);
    expect(await readFile(meetingPaths(id).summary, "utf8")).toBe(OLD_SUMMARY);
  });

  it("keeps the committed new pair together when summary rename sync is pending", async () => {
    const id = "meeting-summary-sync";
    const attempt = await seed(id, "resummarize");
    const operation = await acquireMeetingOperation(id, "summarize");
    const fileOps = failDirectorySyncAfterCanonicalRename(meetingPaths(id).summary);
    await expect(publishSummarizeAttempt({
      id,
      ownerToken: operation.ownerToken,
      attempt,
      transcript: NEW_TRANSCRIPT,
      summary: NEW_SUMMARY,
    }, {
      fileOps,
      capability: createDirectorySyncCapability("supported"),
    })).rejects.toMatchObject({ code: "summarize_publication_failed" });
    operation.release();
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(NEW_TRANSCRIPT);
    expect(await readFile(meetingPaths(id).summary, "utf8")).toBe(NEW_SUMMARY);

    const reconcileOperation = await acquireMeetingOperation(id, "summarize_reconcile");
    await expect(reconcileSummarizeAttempt(
      id,
      reconcileOperation.ownerToken,
    )).resolves.toMatchObject({ state: "completed" });
    reconcileOperation.release();
    expect((await readStatus(id))?.summarizeAttempt).toBeUndefined();
  });
});
