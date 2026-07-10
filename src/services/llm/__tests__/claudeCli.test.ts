// @vitest-environment node
import { tmpdir } from "node:os";

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

describe("ClaudeCliAdapter.run — isolated invocation", () => {
  beforeEach(() => runProcessMock.mockClear());

  it("passes the 10-minute LLM generation timeout (not the 120s default)", async () => {
    expect(LLM_GENERATION_TIMEOUT_MS).toBe(600_000);

    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("프롬프트");

    const opts = runProcessMock.mock.calls[0]?.[2];
    expect(opts?.stdin).toBe("프롬프트");
    expect(opts?.timeoutMs).toBe(LLM_GENERATION_TIMEOUT_MS);
  });

  it("runs with MCP off + slash off (self-contained, clean teardown)", async () => {
    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p");

    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(runProcessMock.mock.calls[0]?.[0]).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");
    expect(args).toContain('{"mcpServers":{}}');
    expect(args).toContain("--disable-slash-commands");
  });

  it("runs in an isolated temp cwd, NOT the project directory", async () => {
    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p");

    const cwd = runProcessMock.mock.calls[0]?.[2]?.cwd;
    expect(cwd).toBeDefined();
    expect(cwd?.startsWith(tmpdir())).toBe(true);
    expect(cwd).not.toBe(process.cwd()); // regression guard: no workspace context
  });

  it("scrubs paid API keys from the child env but keeps HOME/PATH ($0 guard)", async () => {
    const prevA = process.env.ANTHROPIC_API_KEY;
    const prevO = process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.OPENAI_API_KEY = "sk-openai-should-not-leak";
    try {
      await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p");

      const env = runProcessMock.mock.calls[0]?.[2]?.env;
      expect(env).toBeDefined();
      expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env?.OPENAI_API_KEY).toBeUndefined();
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env?.HOME).toBe(process.env.HOME);
    } finally {
      if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevA;
      if (prevO === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevO;
    }
  });

  it("passes the transcript via stdin only, never in argv (PII / ARG_MAX)", async () => {
    const transcript = "민감한 전사 내용 — 홍길동 010-1234-5678";
    await new ClaudeCliAdapter({ provider: "claude-cli" }).run(transcript);

    const [, args, opts] = runProcessMock.mock.calls[0] ?? [];
    expect(opts?.stdin).toBe(transcript);
    expect((args ?? []).some((a) => a.includes(transcript))).toBe(false);
  });

  it("wires --model when a model is configured", async () => {
    await new ClaudeCliAdapter({ provider: "claude-cli", model: "sonnet" }).run("p");

    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
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
