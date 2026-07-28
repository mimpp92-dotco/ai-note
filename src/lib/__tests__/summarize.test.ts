// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GENERATED_SUMMARY_JSON_SCHEMA } from "@/domain/generatedSummaryJsonSchema";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  type FileOps,
} from "@/lib/durableFileOps";
import {
  CORRECTION_CHUNK_TARGET_CHARS,
  createCorrectionChunkPlan,
} from "@/lib/correctionChunks";
import { readArtifactPair, type ArtifactPairRevision } from "@/lib/artifactPair";
import {
  correctionCheckpointPath,
  createCorrectionCheckpointStore,
} from "@/lib/summarizeCheckpoint";
import { resetKnowledgeIndexRepositoryStateForTests } from "@/lib/knowledgeIndexRepository";
import { acquireMeetingOperation } from "@/lib/meetingLifecycle";
import {
  corpusMapPath,
  dataRoot,
  knowledgeCardPath,
  meetingPaths,
} from "@/lib/paths";
import { writePipelineSettings } from "@/lib/pipelineSettings";
import { writeSettings } from "@/lib/settings";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import {
  acceptSummaryRegenerate,
  acceptSummarize,
  acceptTranscriptRegenerate,
  isSummarizeInflight,
  runSummaryRegenerate,
  runSummarize,
  runTranscriptRegenerate,
  setSummarizeCorrectionCheckpointStoreForTests,
  setSummarizeKnowledgeIndexRepositoryForTests,
} from "@/lib/summarize";
import {
  createStatusUpdater,
  resetStatusUpdaterStateForTests,
  setStatusUpdaterForTests,
} from "@/lib/statusUpdater";
import { FakeAdapter } from "@/services/llm/fake";

// Exercises the summarize orchestration end-to-end with the offline FakeAdapter.
// cwd-isolated (meetingsRoot()/settingsPath() are cwd-relative) like the app-api
// integration test. FAKE_LLM is saved/restored per test since some cases need it off.

const RAW = [
  "안녕하세요, 오늘 데일리 스크럼 시작하겠습니다.",
  "지난주 스프린트에서 딜러십 재고 견적 기능을 마무리했습니다.",
  "이번 주는 RIDE 온보딩 플로우를 개선할 예정입니다.",
].join("\n");

function fastRaw(count = 3): string {
  return Array.from({ length: count }, (_, index) => (
    `${String.fromCharCode(65 + index)}${"가".repeat(
      Math.floor(CORRECTION_CHUNK_TARGET_CHARS * 0.58),
    )}\n`
  )).join("");
}

function correctionTarget(prompt: string): string {
  return prompt.slice(prompt.lastIndexOf("[원문]") + "[원문]".length).trim();
}

const BASE_SUMMARY = {
  title: "기존 회의 요약",
  topicSlug: "existing-meeting",
  oneLine: "기존 한 줄 요약",
  purpose: "기존 목적",
  participants: ["기존 내부 참석자"],
  highlights: ["기존 핵심"],
  discussion: ["기존 논의"],
  decisions: ["기존 결정"],
  actionItems: [{ owner: "담당자", task: "기존 할 일", due: "미정" }],
  risks: [],
  followups: [],
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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
  setSummarizeCorrectionCheckpointStoreForTests(null);
  setSummarizeKnowledgeIndexRepositoryForTests(null);
});

afterEach(() => {
  delete globalThis.__aiNoteFakeLlmRunHook;
  vi.restoreAllMocks();
  setSummarizeCorrectionCheckpointStoreForTests(null);
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

async function seedStablePair(
  id: string,
  options: {
    raw?: string | null;
    transcript?: string;
    transcriptSource?: "generated" | "manual";
    summarySource?: "generated" | "manual";
    summaryBasedOnTranscriptSha256?: string;
  } = {},
): Promise<{ revision: ArtifactPairRevision; transcript: string; summary: string }> {
  const transcript = options.transcript ?? "기존 교정 전사\n";
  const summary = `${JSON.stringify(BASE_SUMMARY, null, 2)}\n`;
  const revision = {
    transcriptSha256: sha256(transcript),
    summarySha256: sha256(summary),
  };
  const p = meetingPaths(id);
  await mkdir(p.dir, { recursive: true });
  await writeStatus(id, {
    ...initialStatus(id, {
      startedAt: "2026-07-05T09:00:00.000Z",
      endedAt: "2026-07-05T09:05:00.000Z",
      durationMs: 300_000,
      audioMime: "audio/webm;codecs=opus",
    }),
    titleOverride: "사용자 제목",
    status: "summarized",
    review: { participants: ["검토 참석자"] },
    placementResolution: {
      state: "resolved",
      receiptHash: "f".repeat(64),
    },
    contentRevision: {
      transcript: {
        source: options.transcriptSource ?? "generated",
        sha256: revision.transcriptSha256,
        updatedAt: "2026-07-05T09:06:00.000Z",
      },
      summary: {
        source: options.summarySource ?? "generated",
        sha256: revision.summarySha256,
        basedOnTranscriptSha256:
          options.summaryBasedOnTranscriptSha256 ?? revision.transcriptSha256,
        updatedAt: "2026-07-05T09:07:00.000Z",
      },
    },
  });
  if (options.raw !== null) await writeFile(p.raw, options.raw ?? RAW);
  await writeFile(p.transcript, transcript);
  await writeFile(p.summary, summary);
  return { revision, transcript, summary };
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

  it("initial generation calls correction then summary and publishes one fresh generated revision", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-initial-intent";
    await seedTranscribed(id);
    const run = vi.spyOn(FakeAdapter.prototype, "run");

    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toContain("[원문]");
    expect(run.mock.calls[0][1]).toBeUndefined();
    expect(run.mock.calls[1][0]).toContain("JSON 스키마");
    expect(run.mock.calls[1][1]).toEqual({
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    });
    const pair = await readArtifactPair(id);
    expect(pair.state).toBe("stable");
    expect(pair.contentRevision).toMatchObject({
      transcript: { source: "generated", sha256: pair.revision?.transcriptSha256 },
      summary: {
        source: "generated",
        sha256: pair.revision?.summarySha256,
        basedOnTranscriptSha256: pair.revision?.transcriptSha256,
      },
    });
    expect(pair.summaryOutdated).toBe(false);
  });

  it("runs explicit fast correction in deterministic chunks and summarizes the merged transcript once", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    await writePipelineSettings({
      transcription: { model: "large-v3" },
      correction: { mode: "fast" },
    });
    const id = "meeting-fast-correction";
    await seedTranscribed(id);
    const raw = fastRaw(4);
    await writeFile(meetingPaths(id).raw, raw);
    await writeFile(meetingPaths(id).segments, `${JSON.stringify(
      raw.trimEnd().split("\n").map((text, index) => ({
        start: index,
        end: index + 1,
        text,
      })),
    )}\n`);
    const plan = createCorrectionChunkPlan(raw);
    const run = vi.spyOn(FakeAdapter.prototype, "run");

    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    const correctionCalls = run.mock.calls.filter(([, options]) => options === undefined);
    const summaryCalls = run.mock.calls.filter(([, options]) => options?.jsonSchema);
    expect(correctionCalls).toHaveLength(plan.chunks.length);
    expect(correctionCalls.every(([prompt]) => (
      prompt.includes("[읽기 전용 앞 문맥]")
      && prompt.includes("[읽기 전용 뒤 문맥]")
    ))).toBe(true);
    expect(summaryCalls).toHaveLength(1);
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(raw);
  });

  it("preserves completed fast chunks after failure and resumes only unfinished chunks", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    await writePipelineSettings({
      transcription: { model: "large-v3" },
      correction: { mode: "fast" },
    });
    const id = "meeting-fast-resume";
    await seedTranscribed(id);
    const raw = fastRaw(3);
    await writeFile(meetingPaths(id).raw, raw);
    await writeFile(meetingPaths(id).segments, `${JSON.stringify(
      raw.trimEnd().split("\n").map((text, index) => ({
        start: index,
        end: index + 1,
        text,
      })),
    )}\n`);
    const plan = createCorrectionChunkPlan(raw);
    expect(plan.chunks).toHaveLength(3);
    const firstTargets: string[] = [];
    const firstRun = vi.spyOn(FakeAdapter.prototype, "run").mockImplementation(
      async (prompt, options) => {
        if (options?.jsonSchema) throw new Error("summary must not start");
        const target = correctionTarget(prompt);
        firstTargets.push(target[0]!);
        if (target.startsWith("B")) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          throw new Error("private chunk failure");
        }
        await new Promise((resolve) => setTimeout(resolve, 8));
        return target;
      },
    );

    await expect(runSummarize(id)).resolves.toMatchObject({
      ok: false,
      reason: "error",
    });

    expect(firstTargets.sort()).toEqual(["A", "B"]);
    const partial = JSON.parse(
      await readFile(correctionCheckpointPath(id), "utf8"),
    );
    expect(partial.correctedTranscript).toBe("");
    expect(partial.correctionPromptVersion).toBe("correction-fast-v1");
    expect(partial.completedChunks.map((chunk: { index: number }) => chunk.index))
      .toEqual([0]);
    expect((await readStatus(id))?.error?.action).toBe("retry_summary");
    firstRun.mockRestore();

    const retryTargets: string[] = [];
    const retryRun = vi.spyOn(FakeAdapter.prototype, "run").mockImplementation(
      async (prompt, options) => {
        if (options?.jsonSchema) return JSON.stringify(BASE_SUMMARY);
        const target = correctionTarget(prompt);
        retryTargets.push(target[0]!);
        return target;
      },
    );

    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    expect(retryTargets.sort()).toEqual(["B", "C"]);
    expect(retryRun.mock.calls.filter(([, options]) => options?.jsonSchema))
      .toHaveLength(1);
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(raw);
    expect(existsSync(correctionCheckpointPath(id))).toBe(false);
  });

  it("keeps full mode on the single full-context correction path", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    await writePipelineSettings({
      transcription: { model: "large-v3" },
      correction: { mode: "full" },
    });
    const id = "meeting-full-correction-default";
    await seedTranscribed(id);
    const run = vi.spyOn(FakeAdapter.prototype, "run");

    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).not.toContain("[읽기 전용 앞 문맥]");
    expect(run.mock.calls[1]?.[1]).toEqual({
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    });
  });

  it("retains a successful correction after summary failure and reuses it on manual retry", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-checkpoint-retry";
    await seedTranscribed(id);
    const firstRun = vi.spyOn(FakeAdapter.prototype, "run").mockImplementation(
      async (_prompt, options) => {
        if (!options?.jsonSchema) return RAW;
        throw new Error("summary unavailable");
      },
    );

    await expect(runSummarize(id)).resolves.toMatchObject({
      ok: false,
      reason: "error",
    });

    expect(firstRun).toHaveBeenCalledTimes(2);
    expect(firstRun.mock.calls[0][1]).toBeUndefined();
    expect(firstRun.mock.calls[1][1]).toEqual({
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    });
    expect(existsSync(correctionCheckpointPath(id))).toBe(true);
    expect((await readStatus(id))?.error?.action).toBe("retry_summary");
    firstRun.mockRestore();

    const retryRun = vi.spyOn(FakeAdapter.prototype, "run");
    await expect(acceptSummarize(id)).resolves.toEqual({
      accepted: true,
      durability: "durable",
    });
    await waitForSummarize(id);

    expect(retryRun).toHaveBeenCalledTimes(1);
    expect(retryRun.mock.calls[0][1]).toEqual({
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    });
    expect((await readStatus(id))?.status).toBe("summarized");
    expect((await readStatus(id))?.error).toBeNull();
    expect(existsSync(correctionCheckpointPath(id))).toBe(false);
  });

  it("does not reuse a checkpoint after the configured model identity changes", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli", model: "sonnet" });
    const id = "meeting-checkpoint-model-mismatch";
    await seedTranscribed(id);
    const firstRun = vi.spyOn(FakeAdapter.prototype, "run").mockImplementation(
      async (_prompt, options) => {
        if (!options?.jsonSchema) return RAW;
        throw new Error("summary unavailable");
      },
    );
    await expect(runSummarize(id)).resolves.toMatchObject({ ok: false });
    firstRun.mockRestore();

    await writeSettings({ provider: "claude-cli", model: "opus" });
    const retryRun = vi.spyOn(FakeAdapter.prototype, "run");
    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    expect(retryRun).toHaveBeenCalledTimes(2);
    expect(retryRun.mock.calls[0][1]).toBeUndefined();
    expect(retryRun.mock.calls[1][1]).toEqual({
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    });
  });

  it("does not start summary generation from a durability-pending checkpoint commit", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-checkpoint-pending";
    await seedTranscribed(id);
    const base = createNodeFileOps();
    const fileOps: FileOps = {
      ...base,
      openDirectory: async (...args) => {
        const handle = await base.openDirectory(...args);
        return {
          ...handle,
          sync: async () => {
            throw Object.assign(new Error("transient"), { code: "EIO" });
          },
        };
      },
    };
    setSummarizeCorrectionCheckpointStoreForTests(createCorrectionCheckpointStore({
      dataRoot: dataRoot(),
      fileOps,
      capability: createDirectorySyncCapability("supported"),
    }));
    const run = vi.spyOn(FakeAdapter.prototype, "run");

    await expect(runSummarize(id)).resolves.toMatchObject({
      ok: false,
      reason: "error",
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBeUndefined();
    expect(existsSync(correctionCheckpointPath(id))).toBe(true);
    expect(existsSync(meetingPaths(id).summary)).toBe(false);
  });

  it("does not write or reuse a checkpoint after the durable attempt identity changes", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-checkpoint-attempt-mismatch";
    await seedTranscribed(id);
    let replaced = false;
    globalThis.__aiNoteFakeLlmRunHook = async () => {
      if (replaced) return;
      replaced = true;
      const status = await readStatus(id);
      await writeStatus(id, {
        ...status!,
        summarizeAttempt: {
          ...status!.summarizeAttempt!,
          attemptId: randomUUID(),
        },
      });
    };
    const run = vi.spyOn(FakeAdapter.prototype, "run");

    await expect(runSummarize(id)).resolves.toMatchObject({
      ok: false,
      reason: "error",
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(correctionCheckpointPath(id))).toBe(false);
    expect(existsSync(meetingPaths(id).summary)).toBe(false);
  });

  it("keeps an already-published pair successful when checkpoint cleanup fails", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-checkpoint-cleanup-failure";
    await seedTranscribed(id);
    const store = createCorrectionCheckpointStore({ dataRoot: dataRoot() });
    setSummarizeCorrectionCheckpointStoreForTests({
      ...store,
      remove: async () => {
        throw new Error("cleanup failed");
      },
    });

    await expect(runSummarize(id)).resolves.toEqual({ ok: true });

    expect((await readStatus(id))?.status).toBe("summarized");
    expect(existsSync(meetingPaths(id).summary)).toBe(true);
    expect(existsSync(correctionCheckpointPath(id))).toBe(true);
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
    vi.spyOn(FakeAdapter.prototype, "run").mockResolvedValue(JSON.stringify({
      ...BASE_SUMMARY,
      title: "REGENERATED_MARKER",
    }));
    expect(await runSummarize(id, { force: true })).toEqual({ ok: true });

    const summary = JSON.parse(await readFile(p.summary, "utf-8"));
    expect(summary.title).toBe("REGENERATED_MARKER");
    expect((await readStatus(id))?.status).toBe("summarized");
  });

  it("legacy force regenerates only the summary from the current transcript", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-force-summary-only";
    const seeded = await seedStablePair(id, {
      raw: "RAW_SENTINEL_SHOULD_NOT_BE_READ",
      transcript: "직접 수정한 현재 전체 스크립트",
      transcriptSource: "manual",
    });
    const run = vi.spyOn(FakeAdapter.prototype, "run");

    await expect(runSummarize(id, { force: true })).resolves.toEqual({ ok: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("직접 수정한 현재 전체 스크립트");
    expect(run.mock.calls[0][0]).not.toContain("RAW_SENTINEL_SHOULD_NOT_BE_READ");
    expect(run.mock.calls[0][1]).toEqual({
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    });
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(seeded.transcript);
    expect((await readStatus(id))?.contentRevision?.transcript.source).toBe("manual");
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

describe("independent transcript and summary generation", () => {
  it("regenerates only the transcript, preserves summary bytes, and marks a changed transcript outdated", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-transcript-regenerate";
    const seeded = await seedStablePair(id);
    let indexRefreshes = 0;
    setSummarizeKnowledgeIndexRepositoryForTests({
      refreshAfterSummary: async () => {
        indexRefreshes += 1;
        throw new Error("transcript regeneration must not refresh the index");
      },
    });
    const run = vi.spyOn(FakeAdapter.prototype, "run").mockResolvedValue(
      `${RAW}\n교정으로 추가된 문장`,
    );

    await expect(runTranscriptRegenerate(id, {
      expectedRevision: seeded.revision,
    })).resolves.toEqual({ ok: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("[원문]");
    expect(run.mock.calls[0][1]).toBeUndefined();
    expect(await readFile(meetingPaths(id).summary, "utf8")).toBe(seeded.summary);
    const pair = await readArtifactPair(id);
    expect(pair.transcript).toContain("교정으로 추가된 문장");
    expect(pair.contentRevision?.transcript.source).toBe("generated");
    expect(pair.contentRevision?.summary).toEqual((await readStatus(id))?.contentRevision?.summary);
    expect(pair.contentRevision?.summary.sha256).toBe(seeded.revision.summarySha256);
    expect(pair.summaryOutdated).toBe(true);
    expect(indexRefreshes).toBe(0);
    expect((await readStatus(id))?.summarizeAttempt).toBeUndefined();
  });

  it("treats identical transcript generation as completed without changing freshness or indexing", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-transcript-identical";
    const seeded = await seedStablePair(id, { transcript: RAW });
    let indexRefreshes = 0;
    setSummarizeKnowledgeIndexRepositoryForTests({
      refreshAfterSummary: async () => {
        indexRefreshes += 1;
        throw new Error("unexpected index refresh");
      },
    });
    const before = (await readStatus(id))?.contentRevision;

    await expect(runTranscriptRegenerate(id, {
      expectedRevision: seeded.revision,
    })).resolves.toEqual({ ok: true });

    const after = await readStatus(id);
    expect(after?.summarizeAttempt).toBeUndefined();
    expect(after?.contentRevision?.transcript.sha256).toBe(seeded.revision.transcriptSha256);
    expect(after?.contentRevision?.summary).toEqual(before?.summary);
    expect((await readArtifactPair(id)).summaryOutdated).toBe(false);
    expect(indexRefreshes).toBe(0);
  });

  it("regenerates a summary from a manual current transcript without reading raw or changing transcript bytes/source", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-summary-regenerate";
    const seeded = await seedStablePair(id, {
      raw: null,
      transcript: "사용자가 직접 수정한 전체 스크립트",
      transcriptSource: "manual",
      summaryBasedOnTranscriptSha256: "0".repeat(64),
    });
    let observedPublished = false;
    let indexRefreshes = 0;
    setSummarizeKnowledgeIndexRepositoryForTests({
      refreshAfterSummary: async () => {
        indexRefreshes += 1;
        observedPublished = (await readStatus(id))?.summarizeAttempt === undefined;
        return {
          status: "ready",
          reasons: [],
          count: { total: 1, indexed: 1, skipped: 0 },
          durability: "durable",
        };
      },
    });
    const run = vi.spyOn(FakeAdapter.prototype, "run");

    await expect(runSummaryRegenerate(id, {
      expectedRevision: seeded.revision,
    })).resolves.toEqual({ ok: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("사용자가 직접 수정한 전체 스크립트");
    expect(run.mock.calls[0][0]).not.toContain("[원문]");
    expect(run.mock.calls[0][1]).toEqual({
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    });
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(seeded.transcript);
    const pair = await readArtifactPair(id);
    expect(pair.contentRevision?.transcript.source).toBe("manual");
    expect(pair.contentRevision?.transcript.sha256).toBe(seeded.revision.transcriptSha256);
    expect(pair.contentRevision?.summary).toMatchObject({
      source: "generated",
      basedOnTranscriptSha256: seeded.revision.transcriptSha256,
    });
    expect(JSON.parse(pair.summary ?? "{}").participants).toEqual(["기존 내부 참석자"]);
    expect(pair.summaryOutdated).toBe(false);
    expect(indexRefreshes).toBe(1);
    expect(observedPublished).toBe(true);
    const status = await readStatus(id);
    expect(status?.titleOverride).toBe("사용자 제목");
    expect(status?.review.participants).toEqual(["검토 참석자"]);
    expect(status?.placementResolution).toMatchObject({ state: "resolved" });
  });

  it("rejects a stale expected revision before any transcript adapter call", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-transcript-stale";
    const seeded = await seedStablePair(id);
    const run = vi.spyOn(FakeAdapter.prototype, "run");

    await expect(runTranscriptRegenerate(id, {
      expectedRevision: {
        ...seeded.revision,
        transcriptSha256: "0".repeat(64),
      },
    })).resolves.toEqual({ ok: false, reason: "revision_conflict" });
    expect(run).not.toHaveBeenCalled();
    expect((await readStatus(id))?.summarizeAttempt).toBeUndefined();
  });

  it("does not start transcript generation when durable acceptance is pending", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-transcript-pending";
    const seeded = await seedStablePair(id);
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
    const run = vi.spyOn(FakeAdapter.prototype, "run");

    await expect(acceptTranscriptRegenerate(id, {
      expectedRevision: seeded.revision,
    })).resolves.toEqual({ accepted: false, reason: "error" });
    expect(run).not.toHaveBeenCalled();
    expect((await readStatus(id))?.summarizeAttempt?.kind).toBe("transcript_regenerate");
    expect(isSummarizeInflight(id)).toBe(false);
  });

  it("preserves the old pair and exposes transcript-specific recovery when correction fails", async () => {
    process.env.FAKE_LLM = "1";
    process.env.FAKE_LLM_FAIL = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-transcript-failure";
    const seeded = await seedStablePair(id);
    const beforeRevision = (await readStatus(id))?.contentRevision;

    await expect(runTranscriptRegenerate(id, {
      expectedRevision: seeded.revision,
    })).resolves.toMatchObject({ ok: false, reason: "error" });

    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(seeded.transcript);
    expect(await readFile(meetingPaths(id).summary, "utf8")).toBe(seeded.summary);
    const status = await readStatus(id);
    expect(status?.contentRevision).toEqual(beforeRevision);
    expect(status?.summarizeAttempt).toBeUndefined();
    expect(status?.error?.action).toBe("retry_transcript_generation");
  });

  it("preserves the old pair and freshness when summary generation fails", async () => {
    process.env.FAKE_LLM = "1";
    process.env.FAKE_LLM_FAIL = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-summary-failure";
    const seeded = await seedStablePair(id, {
      summaryBasedOnTranscriptSha256: "0".repeat(64),
    });
    const beforeRevision = (await readStatus(id))?.contentRevision;

    await expect(runSummaryRegenerate(id, {
      expectedRevision: seeded.revision,
    })).resolves.toMatchObject({ ok: false, reason: "error" });

    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(seeded.transcript);
    expect(await readFile(meetingPaths(id).summary, "utf8")).toBe(seeded.summary);
    const status = await readStatus(id);
    expect(status?.contentRevision).toEqual(beforeRevision);
    expect(status?.summarizeAttempt).toBeUndefined();
    expect(status?.error?.action).toBe("retry_summary");
  });

  it("rejects another content operation without starting either regeneration adapter", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-regenerate-busy";
    const seeded = await seedStablePair(id);
    const run = vi.spyOn(FakeAdapter.prototype, "run");
    const lease = await acquireMeetingOperation(id, "manual_edit");
    try {
      await expect(runTranscriptRegenerate(id, {
        expectedRevision: seeded.revision,
      })).resolves.toEqual({ ok: false, reason: "in_progress" });
      await expect(runSummaryRegenerate(id, {
        expectedRevision: seeded.revision,
      })).resolves.toEqual({ ok: false, reason: "in_progress" });
      expect(run).not.toHaveBeenCalled();
    } finally {
      lease.release();
    }
  });

  it.each([
    ["source conflict", "source_conflict"],
    ["ambiguous pair", "state_ambiguous"],
  ] as const)("rejects a %s before adapter, publisher, or index work", async (
    mode,
    reason,
  ) => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = `meeting-regenerate-${reason}`;
    const seeded = await seedStablePair(id);
    if (mode === "source conflict") {
      const status = await readStatus(id);
      await writeStatus(id, {
        ...status!,
        contentRevision: {
          ...status!.contentRevision!,
          transcript: {
            ...status!.contentRevision!.transcript,
            sha256: "0".repeat(64),
          },
        },
      });
    } else {
      await rm(meetingPaths(id).summary);
    }
    const run = vi.spyOn(FakeAdapter.prototype, "run");
    let indexRefreshes = 0;
    setSummarizeKnowledgeIndexRepositoryForTests({
      refreshAfterSummary: async () => {
        indexRefreshes += 1;
        throw new Error("unexpected index refresh");
      },
    });

    await expect(runSummaryRegenerate(id, {
      expectedRevision: seeded.revision,
    })).resolves.toEqual({ ok: false, reason });
    expect(run).not.toHaveBeenCalled();
    expect(indexRefreshes).toBe(0);
    expect((await readStatus(id))?.summarizeAttempt).toBeUndefined();
  });

  it("accepts summary generation asynchronously with the durable summary_regenerate signal", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "meeting-summary-accept";
    const seeded = await seedStablePair(id);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let observedKind: string | undefined;
    let adapterStarted!: () => void;
    const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
    globalThis.__aiNoteFakeLlmRunHook = async () => {
      observedKind = (await readStatus(id))?.summarizeAttempt?.kind;
      adapterStarted();
      await blocked;
    };

    await expect(acceptSummaryRegenerate(id, {
      expectedRevision: seeded.revision,
    })).resolves.toEqual({ accepted: true, durability: "durable" });
    await started;
    expect(observedKind).toBe("summary_regenerate");
    release();
    await waitForSummarize(id);
  });
});
