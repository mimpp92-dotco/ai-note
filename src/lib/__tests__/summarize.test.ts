// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { meetingPaths } from "@/lib/paths";
import { writeSettings } from "@/lib/settings";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import { runSummarize } from "@/lib/summarize";

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
});

afterEach(() => {
  if (savedFakeLlm === undefined) delete process.env.FAKE_LLM;
  else process.env.FAKE_LLM = savedFakeLlm;
  if (savedFakeLlmFail === undefined) delete process.env.FAKE_LLM_FAIL;
  else process.env.FAKE_LLM_FAIL = savedFakeLlmFail;
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

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
    const g = globalThis as typeof globalThis & { __aiNoteSummarizeInflight?: Set<string> };
    (g.__aiNoteSummarizeInflight ??= new Set<string>()).add(id);
    try {
      expect(await runSummarize(id, { force: true })).toEqual({ ok: false, reason: "in_progress" });
    } finally {
      g.__aiNoteSummarizeInflight?.delete(id);
    }
  });
});
