// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetArtifactLeaseStateForTests } from "@/lib/artifactLease";
import {
  acquireMeetingOperation,
  resetMeetingLifecycleForTests,
} from "@/lib/meetingLifecycle";
import { resetMeetingTombstoneStateForTests } from "@/lib/meetingTombstone";
import { dataRoot, meetingPaths } from "@/lib/paths";
import { writeSettings } from "@/lib/settings";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import {
  CORRECTION_CHECKPOINT_SCHEMA_VERSION,
  correctionCheckpointPath,
  createCorrectionCheckpointStore,
} from "@/lib/summarizeCheckpoint";
import { findSummarizeCandidates } from "@/lib/summarizeWorker";

// Candidacy is derived from safe files on disk and persisted manual-attention
// state, so cwd isolation (meetingsRoot()/settingsPath() are cwd-relative) is
// all the setup needed.

let workDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "summarize-worker-"));
  process.chdir(workDir);
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
});

afterEach(() => {
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

async function seed(
  id: string,
  opts: {
    raw?: boolean;
    summary?: boolean;
    attempts?: number;
    outdated?: boolean;
    errorAction?: "retry_transcript_generation" | "retry_summary";
  } = {},
) {
  const p = meetingPaths(id);
  await mkdir(p.dir, { recursive: true });
  await writeStatus(id, {
    ...initialStatus(id, {
      startedAt: "2026-07-05T09:00:00.000Z",
      endedAt: "2026-07-05T09:05:00.000Z",
      durationMs: 300_000,
      audioMime: "audio/webm;codecs=opus",
    }),
    status: "transcribed",
    ...(opts.attempts !== undefined ? { summarizeAttempts: opts.attempts } : {}),
    ...(opts.errorAction
      ? { error: { message: "generation failed", action: opts.errorAction } }
      : {}),
    ...(opts.outdated
      ? {
          contentRevision: {
            transcript: {
              source: "manual" as const,
              sha256: "a".repeat(64),
              updatedAt: "2026-07-05T09:06:00.000Z",
            },
            summary: {
              source: "generated" as const,
              sha256: "b".repeat(64),
              basedOnTranscriptSha256: "c".repeat(64),
              updatedAt: "2026-07-05T09:07:00.000Z",
            },
          },
        }
      : {}),
  });
  if (opts.raw ?? true) await writeFile(p.raw, "회의 원문\n");
  if (opts.summary) await writeFile(p.summary, "{}\n");
}

describe("findSummarizeCandidates", () => {
  it("returns [] when no LLM is configured (no settings file)", async () => {
    await seed("meeting-a");
    expect(await findSummarizeCandidates()).toEqual([]);
  });

  it("includes a first transcribed meeting with raw.md, no summary, and no error", async () => {
    await writeSettings({ provider: "claude-cli" });
    await seed("meeting-ready");
    expect(await findSummarizeCandidates()).toEqual(["meeting-ready"]);
  });

  it("does not use a legacy attempt count as an automatic retry budget", async () => {
    await writeSettings({ provider: "claude-cli" });
    await seed("meeting-exhausted", { attempts: 3 });
    expect(await findSummarizeCandidates()).toEqual(["meeting-exhausted"]);
  });

  it("leaves a failed initial summary for manual retry instead of selecting it again", async () => {
    await writeSettings({ provider: "claude-cli" });
    await seed("meeting-manual-retry", {
      attempts: 1,
      errorAction: "retry_summary",
    });
    expect(await findSummarizeCandidates()).toEqual([]);
  });

  it("reconciles an interrupted live attempt once, preserves its checkpoint, and never auto-retries it", async () => {
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-interrupted-checkpoint";
    await seed(id);
    const attemptId = randomUUID();
    const status = await readStatus(id);
    await writeStatus(id, {
      ...status!,
      status: "summarizing",
      summarizeAttempt: {
        attemptId,
        kind: "initial",
        startedAt: "2026-07-28T07:00:00.000Z",
      },
    });
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const transcript = "중단 전에 완료된 안전한 교정 전사\n";
    const operation = await acquireMeetingOperation(id, "summarize");
    try {
      await createCorrectionCheckpointStore({ dataRoot: dataRoot() }).write(
        id,
        operation.ownerToken,
        {
          schemaVersion: CORRECTION_CHECKPOINT_SCHEMA_VERSION,
          meetingId: id,
          rawSha256: hash("회의 원문\n"),
          glossarySha256: hash('{"terms":[],"corrections":[]}'),
          provider: "claude-cli",
          model: "",
          providerEndpointIdentitySha256: hash("local-cli:claude-cli"),
          correctionPromptVersion: "correction-v1",
          correctionMode: "full",
          chunkPlanSha256: hash("full-context-plan"),
          correctedTranscript: transcript,
          completedChunks: [{
            index: 0,
            inputSha256: hash("회의 원문\n"),
            outputSha256: hash(transcript),
          }],
          committedAt: "2026-07-28T07:01:00.000Z",
        },
      );
    } finally {
      operation.release();
    }

    expect(await findSummarizeCandidates()).toEqual([]);
    expect((await readStatus(id))?.error).toMatchObject({
      code: "summary_interrupted",
      action: "retry_summary",
    });
    expect(existsSync(correctionCheckpointPath(id))).toBe(true);
    expect(await findSummarizeCandidates()).toEqual([]);
  });

  it("excludes a meeting that already has summary.json", async () => {
    await writeSettings({ provider: "claude-cli" });
    await seed("meeting-done", { summary: true });
    expect(await findSummarizeCandidates()).toEqual([]);
  });

  it.each([
    ["outdated summary", { summary: true, outdated: true }],
    ["transcript regeneration failure", { summary: true, errorAction: "retry_transcript_generation" }],
    ["summary regeneration failure", { summary: true, errorAction: "retry_summary" }],
  ] as const)("never auto-selects a summarized meeting with %s", async (_label, options) => {
    await writeSettings({ provider: "claude-cli" });
    await seed(`meeting-no-auto-${_label.replaceAll(" ", "-")}`, options);
    expect(await findSummarizeCandidates()).toEqual([]);
  });

  it("uses the shared no-follow classifier and skips a symlinked status record", async () => {
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-symlink-status";
    const p = meetingPaths(id);
    await mkdir(p.dir, { recursive: true });
    const outside = join(workDir, "outside-status.json");
    await writeFile(outside, JSON.stringify({
      ...initialStatus(id, {
        startedAt: "2026-07-05T09:00:00.000Z",
        endedAt: "2026-07-05T09:05:00.000Z",
        durationMs: 300_000,
        audioMime: "audio/webm",
      }),
      status: "transcribed",
    }));
    await symlink(outside, p.status);
    await writeFile(p.raw, "회의 원문\n");
    expect(await findSummarizeCandidates()).toEqual([]);
  });
});
