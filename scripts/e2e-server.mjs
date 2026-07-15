import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readdir,
  realpath,
  symlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  E2E_SNAPSHOT_ENTRIES,
  assertRealDirectory,
  assertRegularTree,
  buildE2eServerEnv,
  parseE2ePort,
  resolveE2eSnapshotRoot,
  shouldCopyE2eSource,
} from "./e2e-harness.mjs";

const port = parseE2ePort(process.env.AI_NOTE_E2E_PORT);

const sourceRoot = await realpath(process.cwd());
const snapshotRoot = resolveE2eSnapshotRoot(process.env.AI_NOTE_E2E_SNAPSHOT_ROOT);
await assertRealDirectory(snapshotRoot, "snapshot root");
if ((await readdir(snapshotRoot)).length > 0) {
  throw new Error(`E2E snapshot root must start empty: ${snapshotRoot}`);
}
async function copyAllowedEntry(entry) {
  const source = join(sourceRoot, entry);
  try {
    await access(source, constants.F_OK);
  } catch {
    return;
  }
  await assertRegularTree(source);
  await cp(source, join(snapshotRoot, basename(entry)), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (sourcePath) => shouldCopyE2eSource(sourceRoot, sourcePath),
  });
}

for (const entry of E2E_SNAPSHOT_ENTRIES) await copyAllowedEntry(entry);
await mkdir(join(snapshotRoot, "data"), { mode: 0o700 });

const nodeModules = resolve(sourceRoot, "node_modules");
await assertRealDirectory(nodeModules, "node_modules");
await symlink(nodeModules, join(snapshotRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");

const childEnv = buildE2eServerEnv(process.env, snapshotRoot, String(port));

const nextCli = join(nodeModules, "next", "dist", "bin", "next");
let requestedExitCode = null;
let activeChild = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    requestedExitCode = signal === "SIGINT" ? 130 : 143;
    if (activeChild?.exitCode === null && activeChild.signalCode === null) activeChild.kill(signal);
  });
}

async function runNext(args) {
  const child = spawn(process.execPath, [nextCli, ...args], {
    cwd: snapshotRoot,
    env: childEnv,
    stdio: "inherit",
  });
  activeChild = child;
  const result = await new Promise((resolveChild) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolveChild(value);
    };
    child.once("error", (error) => {
      console.error(error);
      settle({ code: 1, signal: null });
    });
    child.once("exit", (code, signal) => {
      settle({ code: signal ? 1 : (code ?? 1), signal });
    });
  });
  if (activeChild === child) activeChild = null;
  return result;
}

const result = await runNext([
  "dev",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(port),
]);
process.exitCode = requestedExitCode ?? result.code;
