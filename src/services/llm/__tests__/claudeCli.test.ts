// @vitest-environment node
import { access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the subprocess helper so run() never shells out; we only assert the args it
// hands to runProcess. The real LLM_GENERATION_TIMEOUT_MS constant is kept.
vi.mock("@/services/llm/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/llm/exec")>();
  return { ...actual, runProcess: vi.fn(async () => ({ stdout: "요약 결과", stderr: "" })) };
});
vi.mock("@/services/llm/cliCapabilities", () => ({
  detectCliCapabilities: vi.fn(async () => new Set<string>()),
}));

import { GENERATED_SUMMARY_JSON_SCHEMA } from "@/domain/generatedSummaryJsonSchema";
import { ClaudeCliAdapter } from "@/services/llm/claudeCli";
import { detectCliCapabilities } from "@/services/llm/cliCapabilities";
import { LLM_GENERATION_TIMEOUT_MS, runProcess } from "@/services/llm/exec";

const runProcessMock = vi.mocked(runProcess);
const detectCliCapabilitiesMock = vi.mocked(detectCliCapabilities);

function resetMocks(): void {
  runProcessMock.mockReset();
  runProcessMock.mockResolvedValue({ stdout: "요약 결과", stderr: "" });
  detectCliCapabilitiesMock.mockReset();
  detectCliCapabilitiesMock.mockResolvedValue(new Set<string>());
}

describe("ClaudeCliAdapter.run — isolated invocation", () => {
  beforeEach(resetMocks);

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

  it("uses only help-proven OAuth-safe isolation flags and never --bare", async () => {
    detectCliCapabilitiesMock.mockResolvedValueOnce(new Set([
      "--safe-mode",
      "--no-session-persistence",
      "--tools",
      "--no-chrome",
    ]));

    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p");

    expect(detectCliCapabilitiesMock).toHaveBeenCalledWith({
      file: "claude",
      args: ["--help"],
      optionalFlags: [
        "--safe-mode",
        "--no-session-persistence",
        "--tools",
        "--no-chrome",
        "--json-schema",
      ],
    });
    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).toEqual(expect.arrayContaining([
      "--safe-mode",
      "--no-session-persistence",
      "--tools",
      "",
      "--no-chrome",
    ]));
    expect(args).not.toContain("--bare");
  });

  it("runs in an isolated temp cwd, NOT the project directory", async () => {
    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p");

    const cwd = runProcessMock.mock.calls[0]?.[2]?.cwd;
    expect(cwd).toBeDefined();
    expect(cwd?.startsWith(tmpdir())).toBe(true);
    expect(cwd).not.toBe(process.cwd()); // regression guard: no workspace context
  });

  it("uses a mode-0700 temp cwd and cleans it after generation", async () => {
    let observedCwd = "";
    let observedMode = 0;
    runProcessMock.mockImplementationOnce(async (_file, _args, options) => {
      observedCwd = options?.cwd ?? "";
      observedMode = (await stat(observedCwd)).mode & 0o777;
      return { stdout: "완료", stderr: "" };
    });

    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p");

    expect(observedMode).toBe(0o700);
    await expect(access(observedCwd)).rejects.toMatchObject({ code: "ENOENT" });
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
  beforeEach(resetMocks);

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

  it("passes the generated-summary schema only when --json-schema is supported", async () => {
    detectCliCapabilitiesMock.mockResolvedValueOnce(new Set(["--json-schema"]));
    const answer = JSON.stringify({
      title: "회의",
      topicSlug: "meeting",
      oneLine: "요약",
      purpose: "목적",
      participants: [],
      highlights: [],
      discussion: [],
      decisions: [],
      actionItems: [],
      risks: [],
      followups: [],
    });
    runProcessMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ type: "result", result: answer }),
      stderr: "",
    });

    await expect(new ClaudeCliAdapter({ provider: "claude-cli" }).run("민감한 프롬프트", {
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    })).resolves.toBe(answer);

    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--json-schema");
    expect(args[args.indexOf("--json-schema") + 1]).toBe(
      JSON.stringify(GENERATED_SUMMARY_JSON_SCHEMA),
    );
    expect(args).toContain("--output-format");
    expect(args).not.toContain("민감한 프롬프트");
    expect(runProcessMock.mock.calls[0]?.[2]?.stdin).toBe("민감한 프롬프트");
  });

  it("returns the schema-validated structured_output object instead of envelope prose", async () => {
    detectCliCapabilitiesMock.mockResolvedValueOnce(new Set(["--json-schema"]));
    const structured = {
      title: "회의",
      topicSlug: "meeting",
      oneLine: "요약",
      purpose: "목적",
      participants: [],
      highlights: [],
      discussion: [],
      decisions: [],
      actionItems: [],
      risks: [],
      followups: [],
    };
    runProcessMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        type: "result",
        result: "설명 텍스트",
        structured_output: structured,
      }),
      stderr: "",
    });

    await expect(new ClaudeCliAdapter({ provider: "claude-cli" }).run("p", {
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    })).resolves.toBe(JSON.stringify(structured));
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("uses the existing generic JSON hint once when schema support is unavailable", async () => {
    const answer = '{"title":"fallback-compatible"}';
    runProcessMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ type: "result", result: answer }),
      stderr: "",
    });

    await expect(new ClaudeCliAdapter({ provider: "claude-cli" }).run("p", {
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    })).resolves.toBe(answer);

    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).not.toContain("--json-schema");
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2))
      .toEqual(["--output-format", "json"]);
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry generation when a help-proven optional flag fails", async () => {
    detectCliCapabilitiesMock.mockResolvedValueOnce(new Set(["--safe-mode"]));
    runProcessMock.mockRejectedValueOnce(new Error("unsupported option --safe-mode"));

    await expect(new ClaudeCliAdapter({ provider: "claude-cli" }).run("p"))
      .rejects.toThrow("unsupported option");
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("does not request json output for a plain (correction) call", async () => {
    await new ClaudeCliAdapter({ provider: "claude-cli" }).run("p");

    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).not.toContain("--output-format");
  });
});

describe("ClaudeCliAdapter.health — lightweight detection", () => {
  beforeEach(resetMocks);

  it("detects the binary via `claude --version` (no auth-probing summary call)", async () => {
    runProcessMock.mockResolvedValueOnce({ stdout: "1.2.3 (Claude Code)", stderr: "" });

    const health = await new ClaudeCliAdapter({ provider: "claude-cli" }).health();

    expect(runProcessMock).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
    expect(health.ok).toBe(true);
    expect(health.detail).toBe("Claude CLI가 감지되었습니다. 인증과 실제 요약 가능 여부는 첫 요약에서 확인합니다.");
  });

  it("reports not-found on ENOENT", async () => {
    runProcessMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    );

    const health = await new ClaudeCliAdapter({ provider: "claude-cli" }).health();

    expect(health.ok).toBe(false);
    expect(health.detail).toBe("Claude CLI를 찾을 수 없습니다. 설치 후 PATH를 확인하세요.");
  });

  it("never returns the misleading 'check login' catch-all for a generic error", async () => {
    runProcessMock.mockRejectedValueOnce(new Error("some transient failure"));

    const health = await new ClaudeCliAdapter({ provider: "claude-cli" }).health();

    expect(health.ok).toBe(false);
    expect(health.detail).toBe("Claude CLI 상태를 확인할 수 없습니다. 설치와 PATH를 확인하세요.");
  });
});
