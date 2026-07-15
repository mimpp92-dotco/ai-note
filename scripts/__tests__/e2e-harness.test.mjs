import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  E2E_SNAPSHOT_ENTRIES,
  assertRealDirectory,
  assertRegularTree,
  buildE2eRunnerEnv,
  buildE2eServerEnv,
  parseE2ePort,
  resolveE2eSnapshotRoot,
  shouldCopyE2eSource,
} from "../e2e-harness.mjs";

const roots = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "ai-note-e2e-harness-test-"));
  roots.push(root);
  return root;
}

describe("E2E harness isolation", () => {
  it("rejects symlinks in product source copied into the synthetic snapshot", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "outside.txt"), "private");
    await symlink(join(root, "outside.txt"), join(root, "src", "leak.txt"));

    await expect(assertRegularTree(join(root, "src"))).rejects.toThrow("refuses symlink input");
  });

  it("accepts a real node_modules root without traversing normal nested bin symlinks", async () => {
    const root = await tempRoot();
    const nodeModules = join(root, "node_modules");
    await mkdir(join(nodeModules, ".bin"), { recursive: true });
    await writeFile(join(nodeModules, "tool.js"), "");
    await symlink(join(nodeModules, "tool.js"), join(nodeModules, ".bin", "tool"));

    await expect(assertRealDirectory(nodeModules, "node_modules")).resolves.toBeUndefined();
  });

  it("rejects a symlinked node_modules root", async () => {
    const root = await tempRoot();
    const realModules = join(root, "real-modules");
    await mkdir(realModules);
    await symlink(realModules, join(root, "node_modules"));

    await expect(assertRealDirectory(join(root, "node_modules"), "node_modules")).rejects.toThrow(
      "must be a real directory",
    );
  });

  it("passes only the minimum environment and relocates HOME into the snapshot", () => {
    expect(buildE2eServerEnv({
      PATH: "/bin",
      HOME: "/Users/example",
      TMPDIR: "/tmp",
      LANG: "ko_KR.UTF-8",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      LOCAL_STT_GLOSSARY: "/private/glossary.json",
    }, "/tmp/synthetic-home", "43210")).toEqual({
      PATH: "/bin",
      TMPDIR: "/tmp",
      LANG: "ko_KR.UTF-8",
      HOME: "/tmp/synthetic-home",
      AI_NOTE_DISABLE_WORKER: "1",
      LOCAL_STT_HOST: "127.0.0.1",
      LOCAL_STT_PORT: "43210",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "development",
    });
  });

  it("keeps the browser runner inputs but strips unrelated credentials", () => {
    expect(buildE2eRunnerEnv({
      PATH: "/bin",
      HOME: "/Users/example",
      CI: "1",
      AI_EXECUTE_BROWSER_EVIDENCE_DIR: "/tmp/playwright-evidence",
      AI_NOTE_E2E_REQUIREMENTS: "R1,R2",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
    }, "43210", "/tmp/ai-note-e2e-owned")).toEqual({
      PATH: "/bin",
      HOME: "/Users/example",
      CI: "1",
      AI_EXECUTE_BROWSER_EVIDENCE_DIR: "/tmp/playwright-evidence",
      AI_NOTE_E2E_REQUIREMENTS: "R1,R2",
      AI_NOTE_E2E_PORT: "43210",
      AI_NOTE_E2E_SNAPSHOT_ROOT: "/tmp/ai-note-e2e-owned",
    });
  });

  it("omits only the disabled worker entrypoint from the product snapshot", () => {
    const sourceRoot = "/repo";
    expect(shouldCopyE2eSource(sourceRoot, "/repo/src/app/page.tsx")).toBe(true);
    expect(shouldCopyE2eSource(sourceRoot, "/repo/src/instrumentation.ts")).toBe(false);
  });

  it("copies only source, public assets, and build metadata into the snapshot", () => {
    expect(E2E_SNAPSHOT_ENTRIES).toEqual([
      "src",
      "public",
      "package.json",
      "package-lock.json",
      "next.config.mjs",
      "postcss.config.mjs",
      "tailwind.config.ts",
      "tsconfig.json",
      "next-env.d.ts",
    ]);
    expect(E2E_SNAPSHOT_ENTRIES).not.toEqual(expect.arrayContaining([
      "data",
      "glossary.json",
      ".env.local",
      ".git",
    ]));
  });

  it("accepts only unprivileged TCP ports", () => {
    expect(parseE2ePort("3000")).toBe(3000);
    expect(() => parseE2ePort("1023")).toThrow("AI_NOTE_E2E_PORT is required");
    expect(() => parseE2ePort("3000junk")).toThrow("AI_NOTE_E2E_PORT is required");
  });

  it("accepts only an absolute runner-owned snapshot directory name", () => {
    expect(resolveE2eSnapshotRoot("/tmp/ai-note-e2e-owned")).toBe("/tmp/ai-note-e2e-owned");
    expect(() => resolveE2eSnapshotRoot("ai-note-e2e-relative")).toThrow("snapshot root");
    expect(() => resolveE2eSnapshotRoot("/tmp/unrelated")).toThrow("snapshot root");
  });
});
