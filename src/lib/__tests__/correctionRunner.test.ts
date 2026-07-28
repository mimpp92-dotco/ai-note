// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CORRECTION_CHUNK_TARGET_CHARS,
  createCorrectionChunkPlan,
} from "@/lib/correctionChunks";
import {
  CorrectionRunnerError,
  runCorrectionChunks,
} from "@/lib/correctionRunner";

const EMPTY_GLOSSARY = { terms: [], corrections: [] };

function multiChunkRaw(count = 4): string {
  return Array.from({ length: count }, (_, index) => (
    `${String.fromCharCode(65 + index)}${"가".repeat(
      Math.floor(CORRECTION_CHUNK_TARGET_CHARS * 0.58),
    )}\n`
  )).join("");
}

describe("bounded correction runner", () => {
  it("merges out-of-order completions only in source order and keeps paragraph separators", async () => {
    const raw = multiChunkRaw(4);
    const plan = createCorrectionChunkPlan(raw);
    const completionOrder: number[] = [];

    const result = await runCorrectionChunks({
      plan,
      provider: "claude-cli",
      glossary: EMPTY_GLOSSARY,
      runChunk: async (_prompt, chunk) => {
        await new Promise((resolve) => setTimeout(resolve, (plan.chunks.length - chunk.index) * 3));
        completionOrder.push(chunk.index);
        return chunk.target.replace("가", "나").trim();
      },
    });

    expect(completionOrder).not.toEqual([...completionOrder].sort((a, b) => a - b));
    expect(result.chunks.map((chunk) => chunk.index)).toEqual(
      plan.chunks.map((chunk) => chunk.index),
    );
    expect(result.transcript).toBe(
      plan.chunks.map((chunk) => chunk.target.replace("가", "나")).join(""),
    );
    expect(result.transcript.endsWith("\n")).toBe(true);
  });

  it.each(["claude-cli", "codex-cli"] as const)(
    "never exceeds two concurrent %s calls",
    async (provider) => {
      const plan = createCorrectionChunkPlan(multiChunkRaw(6));
      let active = 0;
      let maximum = 0;

      await runCorrectionChunks({
        plan,
        provider,
        glossary: EMPTY_GLOSSARY,
        runChunk: async (_prompt, chunk) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 4));
          active -= 1;
          return chunk.target;
        },
      });

      expect(maximum).toBe(2);
    },
  );

  it("serializes Ollama correction calls", async () => {
    const plan = createCorrectionChunkPlan(multiChunkRaw(4));
    let active = 0;
    let maximum = 0;

    await runCorrectionChunks({
      plan,
      provider: "ollama",
      glossary: EMPTY_GLOSSARY,
      runChunk: async (_prompt, chunk) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return chunk.target;
      },
    });

    expect(maximum).toBe(1);
  });

  it("stops scheduling new chunks after the first failure while preserving an in-flight success", async () => {
    const plan = createCorrectionChunkPlan(multiChunkRaw(5));
    const launched: number[] = [];
    const committed: number[][] = [];

    await expect(runCorrectionChunks({
      plan,
      provider: "claude-cli",
      glossary: EMPTY_GLOSSARY,
      runChunk: async (_prompt, chunk) => {
        launched.push(chunk.index);
        if (chunk.index === 0) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          throw new Error("private provider failure");
        }
        await new Promise((resolve) => setTimeout(resolve, 8));
        return chunk.target;
      },
      onChunkCompleted: async (_chunk, completed) => {
        committed.push(completed.map((item) => item.index));
      },
    })).rejects.toBeInstanceOf(CorrectionRunnerError);

    expect(launched).toEqual([0, 1]);
    expect(committed).toEqual([[1]]);
  });

  it("reuses only exact completed chunk identities and does not call the provider for them", async () => {
    const plan = createCorrectionChunkPlan(multiChunkRaw(3));
    const first = await runCorrectionChunks({
      plan,
      provider: "claude-cli",
      glossary: EMPTY_GLOSSARY,
      runChunk: async (_prompt, chunk) => chunk.target,
    });
    const launched: number[] = [];

    const resumed = await runCorrectionChunks({
      plan,
      provider: "claude-cli",
      glossary: EMPTY_GLOSSARY,
      completedChunks: [first.chunks[0]!],
      runChunk: async (_prompt, chunk) => {
        launched.push(chunk.index);
        return chunk.target;
      },
    });

    expect(launched).toEqual([1, 2]);
    expect(resumed.transcript).toBe(plan.chunks.map((chunk) => chunk.target).join(""));
  });

  it("separates read-only context from the target and never merges copied overlap", async () => {
    const plan = createCorrectionChunkPlan(multiChunkRaw(3));
    const middle = plan.chunks[1]!;
    let observedPrompt = "";

    await expect(runCorrectionChunks({
      plan,
      provider: "ollama",
      glossary: EMPTY_GLOSSARY,
      runChunk: async (prompt, chunk) => {
        if (chunk.index !== middle.index) return chunk.target;
        observedPrompt = prompt;
        return `${middle.precedingContext}${middle.target}`;
      },
    })).rejects.toMatchObject({ code: "chunk_context_contamination" });

    expect(observedPrompt).toContain("[읽기 전용 앞 문맥]");
    expect(observedPrompt).toContain("[읽기 전용 뒤 문맥]");
    expect(observedPrompt).toContain("[원문]");
  });

  it.each([
    ["empty", (_target: string) => ""],
    ["collapsed", (_target: string) => "짧음"],
    ["script contamination", (target: string) => (
      target.replace(/[가-힣]/gu, "This is unrelated English reasoning ")
    )],
  ])("rejects %s output instead of silently substituting raw text", async (_label, output) => {
    const plan = createCorrectionChunkPlan(multiChunkRaw(1));

    await expect(runCorrectionChunks({
      plan,
      provider: "ollama",
      glossary: EMPTY_GLOSSARY,
      runChunk: async (_prompt, chunk) => output(chunk.target),
    })).rejects.toBeInstanceOf(CorrectionRunnerError);
  });
});
