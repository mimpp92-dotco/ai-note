// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the subprocess helper so run() never shells out; we only assert the args it
// hands to runProcess. The real LLM_GENERATION_TIMEOUT_MS constant is kept.
vi.mock("@/services/llm/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/llm/exec")>();
  return { ...actual, runProcess: vi.fn(async () => ({ stdout: "요약 결과", stderr: "" })) };
});

import { ClaudeCliAdapter } from "@/services/llm/claudeCli";
import { LLM_GENERATION_TIMEOUT_MS, runProcess } from "@/services/llm/exec";

const runProcessMock = vi.mocked(runProcess);

describe("ClaudeCliAdapter.run — generation timeout", () => {
  beforeEach(() => runProcessMock.mockClear());

  it("passes the 10-minute LLM generation timeout (not the 120s default)", async () => {
    expect(LLM_GENERATION_TIMEOUT_MS).toBe(600_000);

    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("프롬프트");

    expect(runProcessMock).toHaveBeenCalledWith(
      "claude",
      ["-p"],
      expect.objectContaining({ stdin: "프롬프트", timeoutMs: LLM_GENERATION_TIMEOUT_MS }),
    );
  });
});

describe("ClaudeCliAdapter.health — lightweight detection", () => {
  beforeEach(() => runProcessMock.mockClear());

  it("detects the binary via `claude --version` (no auth-probing summary call)", async () => {
    runProcessMock.mockResolvedValueOnce({ stdout: "1.2.3 (Claude Code)", stderr: "" });

    const health = await new ClaudeCliAdapter({ provider: "claude-cli" }).health();

    expect(runProcessMock).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
    expect(health.ok).toBe(true);
    expect(health.detail).toMatch(/first summary/i);
  });

  it("reports not-found on ENOENT", async () => {
    runProcessMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    );

    const health = await new ClaudeCliAdapter({ provider: "claude-cli" }).health();

    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/not found on PATH/i);
  });

  it("never returns the misleading 'check login' catch-all for a generic error", async () => {
    runProcessMock.mockRejectedValueOnce(new Error("some transient failure"));

    const health = await new ClaudeCliAdapter({ provider: "claude-cli" }).health();

    expect(health.ok).toBe(false);
    expect(health.detail).not.toMatch(/login/i);
  });
});
