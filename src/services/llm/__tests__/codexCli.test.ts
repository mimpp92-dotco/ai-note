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

  it("passes an exact custom model only when configured and never runs a model catalog command", async () => {
    await new CodexCliAdapter({ provider: "codex-cli", model: "custom-codex-model" }).run("p");
    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual([
      "-m",
      "custom-codex-model",
    ]);
    expect(args.join(" ")).not.toMatch(/debug models|models list/);

    runProcessMock.mockClear();
    await new CodexCliAdapter({ provider: "codex-cli" }).run("p");
    expect(runProcessMock.mock.calls[0]?.[1]).not.toContain("-m");
  });
});

describe("CodexCliAdapter.health — binary detection only", () => {
  beforeEach(() => runProcessMock.mockClear());

  it("uses only codex --version and reports detection without claiming authentication", async () => {
    runProcessMock.mockResolvedValueOnce({ stdout: "codex 1.0", stderr: "" });
    const health = await new CodexCliAdapter({ provider: "codex-cli" }).health();
    expect(runProcessMock).toHaveBeenCalledWith(
      "codex",
      ["--version"],
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
    expect(health).toEqual({
      ok: true,
      detail: "Codex CLI가 감지되었습니다. 인증과 실제 요약 가능 여부는 첫 요약에서 확인합니다.",
    });
  });

  it("returns an actionable static message for a missing binary", async () => {
    runProcessMock.mockRejectedValueOnce(
      Object.assign(new Error("private spawn output"), { code: "ENOENT" }),
    );
    await expect(new CodexCliAdapter({ provider: "codex-cli" }).health()).resolves.toEqual({
      ok: false,
      detail: "Codex CLI를 찾을 수 없습니다. 설치 후 PATH를 확인하세요.",
    });
  });
});
