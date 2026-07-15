import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export const E2E_SNAPSHOT_ENTRIES = [
  "src",
  "public",
  "package.json",
  "package-lock.json",
  "next.config.mjs",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "tsconfig.json",
  "next-env.d.ts",
];

export function parseE2ePort(raw) {
  if (!/^\d+$/.test(raw ?? "")) throw new Error("AI_NOTE_E2E_PORT is required");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("AI_NOTE_E2E_PORT is required");
  }
  return port;
}

export async function assertRegularTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`E2E snapshot refuses symlink input: ${path} -> ${await readlink(path)}`);
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) await assertRegularTree(join(path, entry));
}

export async function assertRealDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`E2E ${label} must be a real directory: ${path}`);
  }
}

export function buildE2eServerEnv(sourceEnv, syntheticHome, appPort) {
  const result = {};
  for (const name of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "COMSPEC",
    "CI",
  ]) {
    if (sourceEnv[name] !== undefined) result[name] = sourceEnv[name];
  }
  return {
    ...result,
    HOME: syntheticHome,
    AI_NOTE_DISABLE_WORKER: "1",
    LOCAL_STT_HOST: "127.0.0.1",
    LOCAL_STT_PORT: appPort,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "development",
  };
}

export function buildE2eRunnerEnv(sourceEnv, port, snapshotRoot) {
  const result = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "COMSPEC",
    "CI",
    "XDG_CACHE_HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
    "AI_EXECUTE_BROWSER_EVIDENCE_DIR",
    "AI_NOTE_E2E_REQUIREMENTS",
  ]) {
    if (sourceEnv[name] !== undefined) result[name] = sourceEnv[name];
  }
  return {
    ...result,
    AI_NOTE_E2E_PORT: port,
    AI_NOTE_E2E_SNAPSHOT_ROOT: snapshotRoot,
  };
}

export function shouldCopyE2eSource(sourceRoot, sourcePath) {
  return resolve(sourcePath) !== resolve(sourceRoot, "src", "instrumentation.ts");
}

export function resolveE2eSnapshotRoot(raw) {
  if (!raw || !isAbsolute(raw) || resolve(raw) !== raw || !basename(raw).startsWith("ai-note-e2e-")) {
    throw new Error("AI_NOTE_E2E_SNAPSHOT_ROOT must be an absolute runner-owned snapshot root");
  }
  return raw;
}
