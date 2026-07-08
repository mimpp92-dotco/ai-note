// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSettings, settingsPath, writeSettings } from "@/lib/settings";

// settingsPath() = cwd/data/settings.json, so isolate by chdir-ing into a temp dir
// (same mechanism the app-api integration test uses to isolate data/meetings).

let workDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "settings-"));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

describe("settings", () => {
  it("returns null when settings.json is absent", async () => {
    expect(await readSettings()).toBeNull();
  });

  it("round-trips provider, model, and baseUrl", async () => {
    await writeSettings({ provider: "ollama", model: "llama3", baseUrl: "http://x" });
    expect(await readSettings()).toEqual({
      provider: "ollama",
      model: "llama3",
      baseUrl: "http://x",
    });
  });

  it("returns null when the file has an unknown provider", async () => {
    await mkdir(dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify({ provider: "gpt-9000", model: "x" }));
    expect(await readSettings()).toBeNull();
  });
});
