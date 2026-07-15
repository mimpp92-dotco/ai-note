import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { buildE2eRunnerEnv, resolveE2eNodeModules } from "./e2e-harness.mjs";

function allocateLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("failed to allocate an E2E port")));
        return;
      }
      probe.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const nodeModules = await resolveE2eNodeModules(process.cwd(), packageJson.devDependencies?.["@playwright/test"]);
const cli = join(nodeModules, "@playwright", "test", "cli.js");
const port = await allocateLoopbackPort();
const snapshotRoot = await mkdtemp(join(tmpdir(), "ai-note-e2e-"));
const child = spawn(process.execPath, [cli, "test", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: buildE2eRunnerEnv(process.env, String(port), snapshotRoot),
});

let requestedExitCode = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    requestedExitCode = signal === "SIGINT" ? 130 : 143;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

const childResult = await new Promise((resolveChild) => {
  let settled = false;
  const settle = (result) => {
    if (settled) return;
    settled = true;
    resolveChild(result);
  };
  child.once("error", (error) => {
    console.error(error);
    settle({ code: 1 });
  });
  child.once("exit", (code, signal) => {
    settle({ code: signal ? 1 : (code ?? 1) });
  });
});

await rm(snapshotRoot, { recursive: true, force: true });
process.exitCode = requestedExitCode ?? childResult.code;
