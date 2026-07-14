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

  it("passes the 30-minute LLM generation timeout (not the 120s default)", async () => {
    expect(LLM_GENERATION_TIMEOUT_MS).toBe(1_800_000);

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

  it("uses a distinct per-invocation temp directory for concurrent runs", async () => {
    await Promise.all([
      new ClaudeCliAdapter({ provider: "claude-cli" }).run("a"),
      new ClaudeCliAdapter({ provider: "claude-cli" }).run("b"),
    ]);
    const cwdA = runProcessMock.mock.calls[0]?.[2]?.cwd;
    const cwdB = runProcessMock.mock.calls[1]?.[2]?.cwd;
    expect(cwdA).toBeDefined();
    expect(cwdB).toBeDefined();
    expect(cwdA).not.toBe(cwdB);
  });

  it("scrubs paid-billing env vars from the child env but keeps HOME/PATH ($0 guard)", async () => {
    const scrubbed = {
      ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
      ANTHROPIC_AUTH_TOKEN: "bearer-should-not-leak",
      ANTHROPIC_BASE_URL: "https://paid.example/api",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      OPENAI_API_KEY: "sk-openai-should-not-leak",
    };
    const prev = Object.fromEntries(
      Object.keys(scrubbed).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, scrubbed);
    try {
      await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p");

      const env = runProcessMock.mock.calls[0]?.[2]?.env;
      expect(env).toBeDefined();
      for (const key of Object.keys(scrubbed)) {
        expect(env?.[key]).toBeUndefined();
      }
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env?.HOME).toBe(process.env.HOME);
      // The global env is untouched — we scrub a copy, not process.env itself.
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-should-not-leak");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
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

describe("ClaudeCliAdapter.run — json output contract", () => {
  beforeEach(() => runProcessMock.mockClear());

  it("requests structured output and unwraps the result envelope when json:true", async () => {
    const answer = '{"type":"final","answerSegments":[],"limitationFlags":[]}';
    runProcessMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer }),
      stderr: "",
    });

    const out = await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p", { json: true });

    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    // The wrapper's `result` field is the model's actual answer text.
    expect(out).toBe(answer);
  });

  it("falls back to raw stdout when json output is not the result envelope (safety net)", async () => {
    const fenced = '```json\n{"type":"final","answerSegments":[],"limitationFlags":[]}\n```';
    runProcessMock.mockResolvedValueOnce({ stdout: fenced, stderr: "" });

    const out = await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p", { json: true });

    // The orchestrator's tolerant extractor still receives the fenced payload intact.
    expect(out).toBe(fenced);
  });

  it("does not request json output for a plain (correction) call", async () => {
    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p");

    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).not.toContain("--output-format");
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
