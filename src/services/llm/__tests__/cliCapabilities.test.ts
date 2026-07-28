// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  CLI_HELP_MAX_BUFFER,
  CLI_HELP_TIMEOUT_MS,
  createCliCapabilityDetector,
  type CliHelpRunner,
} from "@/services/llm/cliCapabilities";

const REQUEST = {
  file: "claude",
  args: ["--help"],
  optionalFlags: [
    "--safe-mode",
    "--no-session-persistence",
    "--json-schema",
  ],
};

describe("CLI capability detection", () => {
  it("detects only exact supported flags with a bounded prompt-free help probe", async () => {
    const run = vi.fn(async () => ({
      stdout: [
        "Usage: claude [options]",
        "  --safe-mode",
        "  --json-schema <schema>",
        "  --no-session-persistence-extra",
      ].join("\n"),
      stderr: "",
    })) as CliHelpRunner;
    const detector = createCliCapabilityDetector(run);

    await expect(detector.detect(REQUEST)).resolves.toEqual(new Set([
      "--safe-mode",
      "--json-schema",
    ]));
    expect(run).toHaveBeenCalledWith("claude", ["--help"], {
      timeoutMs: CLI_HELP_TIMEOUT_MS,
      maxBuffer: CLI_HELP_MAX_BUFFER,
    });
    expect(vi.mocked(run).mock.calls[0]?.[2]?.stdin).toBeUndefined();
  });

  it("treats unsupported and malformed help output as unsupported", async () => {
    const unsupported = createCliCapabilityDetector(vi.fn(async () => ({
      stdout: "Usage: claude [options]\n  --safe-mode-ish",
      stderr: "",
    })) as CliHelpRunner);
    await expect(unsupported.detect(REQUEST)).resolves.toEqual(new Set());

    const malformed = createCliCapabilityDetector(vi.fn(async () => ({
      stdout: "Usage:\u0000 --safe-mode --json-schema",
      stderr: "",
    })) as CliHelpRunner);
    await expect(malformed.detect(REQUEST)).resolves.toEqual(new Set());
  });

  it("fails closed on timeout or probe failure", async () => {
    const run = vi.fn(async () => {
      throw new Error("process timed out after help bound");
    }) as CliHelpRunner;
    const detector = createCliCapabilityDetector(run);

    await expect(detector.detect(REQUEST)).resolves.toEqual(new Set());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("caches one help probe per command and help argument vector", async () => {
    const run = vi.fn(async () => ({
      stdout: "Usage: codex exec\n  --ephemeral\n  --output-schema <path>",
      stderr: "",
    })) as CliHelpRunner;
    const detector = createCliCapabilityDetector(run);
    const codex = {
      file: "codex",
      args: ["exec", "--help"],
      optionalFlags: ["--ephemeral", "--output-schema"],
    };

    await expect(detector.detect(codex)).resolves.toEqual(new Set([
      "--ephemeral",
      "--output-schema",
    ]));
    await expect(detector.detect({
      ...codex,
      optionalFlags: ["--output-schema"],
    })).resolves.toEqual(new Set(["--output-schema"]));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
