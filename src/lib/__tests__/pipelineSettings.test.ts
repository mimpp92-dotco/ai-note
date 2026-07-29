// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PIPELINE_SETTINGS,
  pipelineSettingsPath,
  readPipelineSettings,
  writePipelineSettings,
} from "@/lib/pipelineSettings";

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "pipeline-settings-"));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

describe("pipeline settings repository", () => {
  it("treats a missing file as the quality-first full-correction default without writing", async () => {
    await expect(readPipelineSettings()).resolves.toEqual({
      state: "default",
      settings: DEFAULT_PIPELINE_SETTINGS,
    });
    await expect(readFile(pipelineSettingsPath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("atomically round-trips the strict v1 shape and reports commit durability", async () => {
    const input = {
      transcription: { model: "large-v3-turbo" as const },
      correction: { mode: "fast" as const },
    };

    await expect(writePipelineSettings(input)).resolves.toMatchObject({
      settings: input,
      durability: expect.stringMatching(/^(durable|best_effort|pending)$/u),
    });
    await expect(readPipelineSettings()).resolves.toEqual({
      state: "stored",
      settings: input,
    });
    await expect(readFile(pipelineSettingsPath(), "utf8")).resolves.toBe(
      `${JSON.stringify({ schemaVersion: 1, ...input }, null, 2)}\n`,
    );
    expect(readdirSync(dirname(pipelineSettingsPath())).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);
  });

  it.each([
    ["malformed JSON", "{not-json", "corrupt"],
    [
      "unknown field",
      JSON.stringify({
        schemaVersion: 1,
        transcription: { model: "large-v3", repo: "arbitrary/repo" },
        correction: { mode: "full" },
      }),
      "corrupt",
    ],
    [
      "unknown model",
      JSON.stringify({
        schemaVersion: 1,
        transcription: { model: "small" },
        correction: { mode: "full" },
      }),
      "corrupt",
    ],
    [
      "future version",
      JSON.stringify({
        schemaVersion: 2,
        transcription: { model: "large-v3" },
        correction: { mode: "full" },
      }),
      "unsupported_version",
    ],
  ] as const)("fails closed for %s instead of sanitizing it", async (_label, contents, reason) => {
    await mkdir(dirname(pipelineSettingsPath()), { recursive: true });
    writeFileSync(pipelineSettingsPath(), contents);
    await expect(readPipelineSettings()).resolves.toEqual({
      state: "unavailable",
      reason,
    });
  });

  it("serializes concurrent saves so the later accepted save is the canonical value", async () => {
    const first = {
      transcription: { model: "large-v3" as const },
      correction: { mode: "full" as const },
    };
    const second = {
      transcription: { model: "large-v3-turbo" as const },
      correction: { mode: "fast" as const },
    };

    await Promise.all([
      writePipelineSettings(first),
      writePipelineSettings(second),
    ]);

    await expect(readPipelineSettings()).resolves.toEqual({
      state: "stored",
      settings: second,
    });
  });
});
