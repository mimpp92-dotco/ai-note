// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDirectorySyncCapability,
  createNodeFileOps,
  type FileOps,
} from "@/lib/durableFileOps";
import { resetKnowledgeIndexRepositoryStateForTests } from "@/lib/knowledgeIndexRepository";
import { acquireMeetingOperation } from "@/lib/meetingLifecycle";
import {
  corpusMapPath,
  dataRoot,
  knowledgeCardPath,
  meetingPaths,
} from "@/lib/paths";
import { writeSettings } from "@/lib/settings";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import {
  acceptSummarize,
  isSummarizeInflight,
  runSummarize,
  setSummarizeKnowledgeIndexRepositoryForTests,
} from "@/lib/summarize";
import {
  createStatusUpdater,
  resetStatusUpdaterStateForTests,
  setStatusUpdaterForTests,
} from "@/lib/statusUpdater";

// Exercises the summarize orchestration end-to-end with the offline FakeAdapter.
// cwd-isolated (meetingsRoot()/settingsPath() are cwd-relative) like the app-api
// integration test. FAKE_LLM is saved/restored per test since some cases need it off.

const RAW = [
  "안녕하세요, 오늘 데일리 스크럼 시작하겠습니다.",
  "지난주 스프린트에서 딜러십 재고 견적 기능을 마무리했습니다.",
  "이번 주는 RIDE 온보딩 플로우를 개선할 예정입니다.",
].join("\n");

let workDir: string;
let originalCwd: string;
let savedFakeLlm: string | undefined;
let savedFakeLlmFail: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "summarize-run-"));
  process.chdir(workDir);
  savedFakeLlm = process.env.FAKE_LLM;
  savedFakeLlmFail = process.env.FAKE_LLM_FAIL;
  resetKnowledgeIndexRepositoryStateForTests();
  setSummarizeKnowledgeIndexRepositoryForTests(null);
});

afterEach(() => {
  delete globalThis.__aiNoteFakeLlmRunHook;
  vi.restoreAllMocks();
  setSummarizeKnowledgeIndexRepositoryForTests(null);
  resetKnowledgeIndexRepositoryStateForTests();
  resetStatusUpdaterStateForTests();
  if (savedFakeLlm === undefined) delete process.env.FAKE_LLM;
  else process.env.FAKE_LLM = savedFakeLlm;
  if (savedFakeLlmFail === undefined) delete process.env.FAKE_LLM_FAIL;
  else process.env.FAKE_LLM_FAIL = savedFakeLlmFail;
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

async function waitForSummarize(id: string): Promise<void> {
  for (let index = 0; index < 200 && isSummarizeInflight(id); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function seedTranscribed(id: string) {
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
  });
  await writeFile(p.raw, RAW);
}

describe("runSummarize", () => {
  it("durably records the attempt before the first adapter call and before accepting", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-durable-accept";
    await seedTranscribed(id);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let observedAttempt: string | undefined;
    let adapterStarted!: () => void;
    const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
    globalThis.__aiNoteFakeLlmRunHook = async () => {
      observedAttempt = (await readStatus(id))?.summarizeAttempt?.attemptId;
      adapterStarted();
      await blocked;
    };

    const accepted = await acceptSummarize(id);
    await started;
    expect(accepted).toEqual({ accepted: true, durability: "durable" });
    expect(observedAttempt).toMatch(/^[a-f0-9-]{36}$/u);
    expect((await readStatus(id))?.summarizeAttempt?.attemptId).toBe(observedAttempt);

    release();
    await waitForSummarize(id);
  });

  it("does not launch an adapter when attempt namespace durability is pending", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-pending-accept";
    await seedTranscribed(id);
    const base = createNodeFileOps();
    const fileOps: FileOps = {
      ...base,
      openDirectory: async (...args) => {
        const handle = await base.openDirectory(...args);
        return {
          ...handle,
          sync: async () => { throw Object.assign(new Error("transient"), { code: "EIO" }); },
        };
      },
    };
    resetStatusUpdaterStateForTests();
    setStatusUpdaterForTests(dataRoot(), createStatusUpdater({
      dataRoot: dataRoot(),
      fileOps,
      capability: createDirectorySyncCapability("supported"),
    }));
    let adapterRuns = 0;
    globalThis.__aiNoteFakeLlmRunHook = () => { adapterRuns += 1; };

    await expect(acceptSummarize(id)).resolves.toEqual({ accepted: false, reason: "error" });
    expect(adapterRuns).toBe(0);
    expect((await readStatus(id))?.summarizeAttempt).toBeDefined();
    expect(isSummarizeInflight(id)).toBe(false);
  });

  it("accepts known unsupported directory sync as explicit best-effort durability", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-best-effort-accept";
    await seedTranscribed(id);
    resetStatusUpdaterStateForTests();
    setStatusUpdaterForTests(dataRoot(), createStatusUpdater({
      dataRoot: dataRoot(),
      capability: createDirectorySyncCapability("unsupported"),
    }));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    globalThis.__aiNoteFakeLlmRunHook = () => blocked;

    await expect(acceptSummarize(id)).resolves.toEqual({
      accepted: true,
      durability: "best_effort",
    });
    expect((await readStatus(id))?.summarizeAttempt).toBeDefined();
    release();
    await waitForSummarize(id);
  });

  it("summarizes a transcribed meeting with the fake adapter", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-happy";
    await seedTranscribed(id);

    const result = await runSummarize(id);
    expect(result).toEqual({ ok: true });

    const p = meetingPaths(id);
    expect(existsSync(p.summary)).toBe(true);
    expect(existsSync(p.transcript)).toBe(true);

    const summary = JSON.parse(await readFile(p.summary, "utf-8"));
    expect(typeof summary).toBe("object");
    expect(summary.participants).toEqual([]);

    const status = await readStatus(id);
    expect(status?.status).toBe("summarized");
    expect(status?.summarizeAttempts).toBe(0);
  });

  it("creates a knowledge card and corpus map only after the summary pair is published", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-indexed";
    await seedTranscribed(id);

    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    const card = JSON.parse(await readFile(knowledgeCardPath(id), "utf8"));
    const corpus = JSON.parse(await readFile(corpusMapPath(), "utf8"));
    expect(card).toMatchObject({ meetingId: id });
    expect(corpus).toMatchObject({ cards: [{ meetingId: id }] });
    expect((await readStatus(id))?.summarizeAttempt).toBeUndefined();
  });

  it("keeps the published summary successful when knowledge indexing fails", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-index-failure";
    await seedTranscribed(id);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSummarizeKnowledgeIndexRepositoryForTests({
      refreshAfterSummary: async () => {
        throw new Error("/private/sensitive/index-path");
      },
    });

    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    expect(await readFile(meetingPaths(id).summary, "utf8")).toContain("FAKE 회의 요약");
    expect((await readStatus(id))?.status).toBe("summarized");
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      code: "knowledge_index_failed",
      operation: "summarize_index",
      meetingId: id,
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("/private/sensitive/index-path");
    warning.mockRestore();
  });

  it("treats pending index durability as committed without failing or rolling back summary", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-index-pending";
    await seedTranscribed(id);
    let observedPublishedPair = false;
    setSummarizeKnowledgeIndexRepositoryForTests({
      refreshAfterSummary: async () => {
        observedPublishedPair = (await readStatus(id))?.summarizeAttempt === undefined
          && (await readFile(meetingPaths(id).summary, "utf8")).includes("FAKE 회의 요약");
        return {
          status: "ready",
          reasons: [],
          count: { total: 1, indexed: 1, skipped: 0 },
          durability: "pending",
        };
      },
    });

    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    expect(observedPublishedPair).toBe(true);
    expect((await readStatus(id))?.status).toBe("summarized");
    expect(await readFile(meetingPaths(id).summary, "utf8")).toContain("FAKE 회의 요약");
  });

  it("refuses a meeting that is already summarized", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-again";
    await seedTranscribed(id);

    expect(await runSummarize(id)).toEqual({ ok: true });
    expect(await runSummarize(id)).toEqual({ ok: false, reason: "already_summarized" });
  });

  it("returns no_model when no LLM is configured", async () => {
    // No settings file (fresh temp dir) and FAKE_LLM off: getConfiguredAdapter → null.
    delete process.env.FAKE_LLM;
    const id = "meeting-no-model";
    await seedTranscribed(id);

    expect(await runSummarize(id)).toEqual({ ok: false, reason: "no_model" });
  });

  it("re-summarizes and overwrites the existing summary when force is passed", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-force";
    await seedTranscribed(id);
    expect(await runSummarize(id)).toEqual({ ok: true });

    const p = meetingPaths(id);
    // Stand in for a stale prior summary, then force a regeneration.
    await writeFile(p.summary, JSON.stringify({ title: "STALE_MARKER" }));
    expect(await runSummarize(id, { force: true })).toEqual({ ok: true });

    const summary = JSON.parse(await readFile(p.summary, "utf-8"));
    expect(summary.title).not.toBe("STALE_MARKER"); // regenerated, not the stale file
    expect((await readStatus(id))?.status).toBe("summarized");
  });

  it("re-summarize replaces a stale knowledge card with current source hashes", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-force-index";
    await seedTranscribed(id);
    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    const cardPath = knowledgeCardPath(id);
    const stale = JSON.parse(await readFile(cardPath, "utf8"));
    stale.sourceHashes.summary = "0".repeat(64);
    stale.content.oneLine = "STALE_INDEX_MARKER";
    await writeFile(cardPath, `${JSON.stringify(stale)}\n`);

    await expect(runSummarize(id, { force: true })).resolves.toEqual({ ok: true });

    const refreshed = JSON.parse(await readFile(cardPath, "utf8"));
    expect(refreshed.sourceHashes.summary).not.toBe("0".repeat(64));
    expect(refreshed.content.oneLine).not.toBe("STALE_INDEX_MARKER");
    expect((await stat(cardPath)).isFile()).toBe(true);
  });

  it("without force, the worker path never re-summarizes an already-summarized meeting", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-noforce";
    await seedTranscribed(id);
    expect(await runSummarize(id)).toEqual({ ok: true });
    // The background worker calls runSummarize(id) with no force → still refused.
    expect(await runSummarize(id)).toEqual({ ok: false, reason: "already_summarized" });
  });

  it("force preserves a user titleOverride", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-force-title";
    await seedTranscribed(id);
    expect(await runSummarize(id)).toEqual({ ok: true });

    const st = await readStatus(id);
    await writeStatus(id, { ...st!, titleOverride: "내가 고친 제목" });
    expect(await runSummarize(id, { force: true })).toEqual({ ok: true });
    expect((await readStatus(id))?.titleOverride).toBe("내가 고친 제목");
  });

  it("a failed re-summarize keeps status summarized and preserves the old summary", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-resummarize-fail";
    await seedTranscribed(id);
    expect(await runSummarize(id)).toEqual({ ok: true });

    const p = meetingPaths(id);
    const priorSummary = await readFile(p.summary, "utf-8");

    // Force a re-summarize that fails mid-run (FAKE_LLM_FAIL makes run() throw).
    process.env.FAKE_LLM_FAIL = "1";
    const result = await runSummarize(id, { force: true });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "error" });

    const status = await readStatus(id);
    expect(status?.status).toBe("summarized"); // NOT demoted to transcribed
    expect(status?.error?.action).toBe("retry_summary");
    expect(status?.error?.code).toBe("summary_provider_failed");
    expect(JSON.stringify(status?.error)).not.toContain("FAKE_LLM_FAIL");
    expect(status?.summarizeAttempts).toBe(1);
    // The still-valid prior summary survives the failed regeneration.
    expect(existsSync(p.summary)).toBe(true);
    expect(await readFile(p.summary, "utf-8")).toBe(priorSummary);
  });

  it("a first-time summarize failure (no prior summary) degrades to transcribed", async () => {
    process.env.FAKE_LLM = "1";
    process.env.FAKE_LLM_FAIL = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-first-fail";
    await seedTranscribed(id);

    const result = await runSummarize(id);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "error" });

    const p = meetingPaths(id);
    expect(existsSync(p.summary)).toBe(false);
    const status = await readStatus(id);
    expect(status?.status).toBe("transcribed");
    expect(status?.error?.action).toBe("retry_summary");
    expect(status?.summarizeAttempts).toBe(1);
  });

  it("refuses (in_progress) when a summarize is already in-flight, even with force", async () => {
    const id = "meeting-force-inflight";
    await seedTranscribed(id);
    const lease = await acquireMeetingOperation(id, "summarize");
    try {
      expect(await runSummarize(id, { force: true })).toEqual({ ok: false, reason: "in_progress" });
    } finally {
      lease.release();
    }
  });
});
