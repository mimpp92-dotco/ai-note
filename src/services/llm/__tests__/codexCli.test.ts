// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the subprocess helper so run() never shells out; codex's structured
// contract is the `--json` JSONL event stream, from which we salvage the final
// assistant message. The orchestrator's tolerant extractor then handles any
// fences/prose left inside that message.
vi.mock("@/services/llm/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/llm/exec")>();
  return { ...actual, runProcess: vi.fn(async () => ({ stdout: "", stderr: "" })) };
});

import { CodexCliAdapter } from "@/services/llm/codexCli";
import { LLM_GENERATION_TIMEOUT_MS, runProcess } from "@/services/llm/exec";

const runProcessMock = vi.mocked(runProcess);

describe("CodexCliAdapter.run — structured JSONL salvage", () => {
  beforeEach(() => runProcessMock.mockClear());

  it("emits the --json event stream and salvages the final assistant message", async () => {
    const envelope = '{"type":"final","answerSegments":[],"limitationFlags":[]}';
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ msg: { type: "agent_message", text: "검색을 진행합니다" } }),
      JSON.stringify({ type: "item.completed", item: { text: envelope } }),
      "",
    ].join("\n");
    runProcessMock.mockResolvedValueOnce({ stdout, stderr: "" });

    const out = await new CodexCliAdapter({ provider: "codex-cli" }).run("p");

    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--json");
    const opts = runProcessMock.mock.calls[0]?.[2];
    expect(opts?.stdin).toBe("p");
    expect(opts?.timeoutMs).toBe(LLM_GENERATION_TIMEOUT_MS);
    // The salvaged final message is handed on verbatim for tolerant parsing.
    expect(out).toBe(envelope);
  });

  it("hands back raw stdout when no assistant message can be salvaged", async () => {
    runProcessMock.mockResolvedValueOnce({ stdout: "완전히 비정형 출력", stderr: "" });

    const out = await new CodexCliAdapter({ provider: "codex-cli" }).run("p");

    expect(out).toBe("완전히 비정형 출력");
  });
});
