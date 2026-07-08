// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { meetingPaths } from "@/lib/paths";
import { writeSettings } from "@/lib/settings";
import { initialStatus, writeStatus } from "@/lib/status";
import { findSummarizeCandidates } from "@/lib/summarizeWorker";

// Candidacy is derived purely from files on disk + the attempt counter, so cwd
// isolation (meetingsRoot()/settingsPath() are cwd-relative) is all the setup needed.

let workDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "summarize-worker-"));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

async function seed(
  id: string,
  opts: { raw?: boolean; summary?: boolean; attempts?: number } = {},
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
  });
  if (opts.raw ?? true) await writeFile(p.raw, "회의 원문\n");
  if (opts.summary) await writeFile(p.summary, "{}\n");
}

describe("findSummarizeCandidates", () => {
  it("returns [] when no LLM is configured (no settings file)", async () => {
    await seed("meeting-a");
    expect(await findSummarizeCandidates()).toEqual([]);
  });

  it("includes a transcribed meeting with raw.md, no summary, and attempts < 3", async () => {
    await writeSettings({ provider: "claude-cli" });
    await seed("meeting-ready");
    expect(await findSummarizeCandidates()).toEqual(["meeting-ready"]);
  });

  it("excludes a meeting that exhausted its retries (attempts = 3)", async () => {
    await writeSettings({ provider: "claude-cli" });
    await seed("meeting-exhausted", { attempts: 3 });
    expect(await findSummarizeCandidates()).toEqual([]);
  });

  it("excludes a meeting that already has summary.json", async () => {
    await writeSettings({ provider: "claude-cli" });
    await seed("meeting-done", { summary: true });
    expect(await findSummarizeCandidates()).toEqual([]);
  });
});
