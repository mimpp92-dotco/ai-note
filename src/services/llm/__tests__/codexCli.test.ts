// @vitest-environment node
import { access, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the subprocess helper so run() never shells out; codex's structured
// contract is the `--json` JSONL event stream, from which we salvage the final
// assistant message. The orchestrator's tolerant extractor then handles any
// fences/prose left inside that message.
vi.mock("@/services/llm/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/llm/exec")>();
  return { ...actual, runProcess: vi.fn(async () => ({ stdout: "", stderr: "" })) };
});
vi.mock("@/services/llm/cliCapabilities", () => ({
  detectCliCapabilities: vi.fn(async () => new Set<string>()),
}));

import { GENERATED_SUMMARY_JSON_SCHEMA } from "@/domain/generatedSummaryJsonSchema";
import { detectCliCapabilities } from "@/services/llm/cliCapabilities";
import {
  CodexCliAdapter,
  codexHealthFailureDetail,
} from "@/services/llm/codexCli";
import { LLM_GENERATION_TIMEOUT_MS, runProcess } from "@/services/llm/exec";

const runProcessMock = vi.mocked(runProcess);
const detectCliCapabilitiesMock = vi.mocked(detectCliCapabilities);

function resetMocks(): void {
  runProcessMock.mockReset();
  runProcessMock.mockResolvedValue({ stdout: "", stderr: "" });
  detectCliCapabilitiesMock.mockReset();
  detectCliCapabilitiesMock.mockResolvedValue(new Set<string>());
}

function finalEvent(text: string): string {
  return `${JSON.stringify({ type: "item.completed", item: { text } })}\n`;
}

describe("CodexCliAdapter.run — structured JSONL salvage", () => {
  beforeEach(resetMocks);

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

  it("uses help-proven isolation, schema, last-message, and color-off flags in one generation", async () => {
    detectCliCapabilitiesMock.mockResolvedValueOnce(new Set([
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--output-schema",
      "--output-last-message",
      "--color",
    ]));
    const lastMessage = '{"title":"schema result"}';
    let cwd = "";
    let schemaPath = "";
    let outputPath = "";
    let cwdMode = 0;
    let schemaMode = 0;
    runProcessMock.mockImplementationOnce(async (_file, args, options) => {
      cwd = args[args.indexOf("-C") + 1];
      schemaPath = args[args.indexOf("--output-schema") + 1];
      outputPath = args[args.indexOf("--output-last-message") + 1];
      cwdMode = (await stat(cwd)).mode & 0o777;
      schemaMode = (await stat(schemaPath)).mode & 0o777;
      expect(options?.cwd).toBe(cwd);
      expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual(
        GENERATED_SUMMARY_JSON_SCHEMA,
      );
      await writeFile(outputPath, lastMessage, { mode: 0o600 });
      return { stdout: finalEvent("JSONL fallback must not win"), stderr: "" };
    });

    const out = await new CodexCliAdapter({ provider: "codex-cli" }).run(
      "민감한 프롬프트",
      { jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA },
    );

    expect(detectCliCapabilitiesMock).toHaveBeenCalledWith({
      file: "codex",
      args: ["exec", "--help"],
      optionalFlags: [
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--output-schema",
        "--output-last-message",
        "--color",
      ],
    });
    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).toEqual(expect.arrayContaining([
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--color",
      "never",
      "-s",
      "read-only",
    ]));
    expect(args).not.toContain("민감한 프롬프트");
    expect(runProcessMock.mock.calls[0]?.[2]?.stdin).toBe("민감한 프롬프트");
    if (process.platform !== "win32") {
      expect(cwdMode).toBe(0o700);
      expect(schemaMode).toBe(0o600);
    }
    expect(out).toBe(lastMessage);
    await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hands back raw stdout when no assistant message can be salvaged", async () => {
    runProcessMock.mockResolvedValueOnce({ stdout: "완전히 비정형 출력", stderr: "" });

    const out = await new CodexCliAdapter({ provider: "codex-cli" }).run("p");

    expect(out).toBe("완전히 비정형 출력");
  });

  it("falls back to the same call's JSONL output when bounded last-message read is oversized", async () => {
    detectCliCapabilitiesMock.mockResolvedValueOnce(new Set(["--output-last-message"]));
    const fallback = '{"type":"final","answerSegments":[],"limitationFlags":[]}';
    runProcessMock.mockImplementationOnce(async (_file, args) => {
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, "x".repeat(1024 * 1024 + 1));
      return { stdout: finalEvent(fallback), stderr: "" };
    });

    await expect(new CodexCliAdapter({ provider: "codex-cli" }).run("p"))
      .resolves.toBe(fallback);
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow a last-message symlink and uses the same call's JSONL fallback", async () => {
    detectCliCapabilitiesMock.mockResolvedValueOnce(new Set(["--output-last-message"]));
    const fallback = '{"safe":"jsonl"}';
    runProcessMock.mockImplementationOnce(async (_file, args) => {
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      const target = join(dirname(outputPath), "untrusted-target");
      await writeFile(target, "must not be read");
      await symlink(target, outputPath);
      return { stdout: finalEvent(fallback), stderr: "" };
    });

    await expect(new CodexCliAdapter({ provider: "codex-cli" }).run("p"))
      .resolves.toBe(fallback);
  });

  it("uses old-CLI JSONL fallback once when schema and last-message flags are unsupported", async () => {
    const fallback = '{"title":"old cli"}';
    runProcessMock.mockResolvedValueOnce({ stdout: finalEvent(fallback), stderr: "" });

    await expect(new CodexCliAdapter({ provider: "codex-cli" }).run("p", {
      jsonSchema: GENERATED_SUMMARY_JSON_SCHEMA,
    })).resolves.toBe(fallback);

    const args = runProcessMock.mock.calls[0]?.[1] ?? [];
    expect(args).not.toContain("--output-schema");
    expect(args).not.toContain("--output-last-message");
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("cleans the invocation directory and never retries after generation failure", async () => {
    detectCliCapabilitiesMock.mockResolvedValueOnce(new Set(["--ephemeral"]));
    let cwd = "";
    runProcessMock.mockImplementationOnce(async (_file, args) => {
      cwd = args[args.indexOf("-C") + 1];
      throw new Error("unsupported option --ephemeral");
    });

    await expect(new CodexCliAdapter({ provider: "codex-cli" }).run("p"))
      .rejects.toThrow("unsupported option");
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" });
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
  beforeEach(resetMocks);

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
    const error = Object.assign(new Error("private spawn output"), { code: "ENOENT" });
    runProcessMock.mockRejectedValueOnce(error);
    await expect(new CodexCliAdapter({ provider: "codex-cli" }).health()).resolves.toEqual({
      ok: false,
      detail: codexHealthFailureDetail(error),
    });
  });

  it.each(["EACCES", "EPERM"])(
    "gives Windows permission remediation for %s without alternate execution",
    (code) => {
      const detail = codexHealthFailureDetail(
        Object.assign(new Error("private provider output"), { code }),
        "win32",
      );

      expect(detail).toMatch(/권한/);
      expect(detail).toMatch(/독립 Codex CLI/);
      expect(detail).toMatch(/PATH/);
      expect(detail).toMatch(/새 PowerShell/);
      expect(detail).toContain("npm run app:stop");
      expect(detail).toContain("node scripts/bootstrap.mjs --launch");
      expect(detail).not.toContain("private provider output");
    },
  );

  it("tells Windows ENOENT users to install the independent CLI and restart shell/runtime", () => {
    const detail = codexHealthFailureDetail(
      Object.assign(new Error("private spawn output"), { code: "ENOENT" }),
      "win32",
    );

    expect(detail).toMatch(/독립 Codex CLI.*설치/);
    expect(detail).toMatch(/PATH/);
    expect(detail).toMatch(/새 PowerShell/);
    expect(detail).toContain("npm run app:stop");
    expect(detail).toContain("node scripts/bootstrap.mjs --launch");
    expect(detail).not.toContain("private spawn output");
  });

  it("preserves the existing non-Windows health wording", () => {
    expect(
      codexHealthFailureDetail(
        Object.assign(new Error("missing"), { code: "ENOENT" }),
        "linux",
      ),
    ).toBe("Codex CLI를 찾을 수 없습니다. 설치 후 PATH를 확인하세요.");
    expect(codexHealthFailureDetail(new Error("denied"), "darwin")).toBe(
      "Codex CLI 상태를 확인할 수 없습니다. 설치와 PATH를 확인하세요.",
    );
  });
});
