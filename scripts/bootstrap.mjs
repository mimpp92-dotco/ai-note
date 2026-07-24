#!/usr/bin/env node
// AI NOTE end-user bootstrap and repository-owned background runtime.
// Imports are side-effect free. Tests inject every process/network/browser
// boundary; real effects run only through the CLI guard at the bottom.
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  createWriteStream,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INTERNAL_SUPERVISOR_COMMAND = "__supervisor";

const RUNTIME_DIRECTORY_NAME = ".ai-note-runtime";
const APP_START_PORT = 3000;
const WHISPER_START_PORT = 8123;
const PORT_CANDIDATE_COUNT = 20;
const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_MAX_AGE_MS = 15_000;
const STARTUP_TIMEOUT_MS = 10 * 60_000;
const ENDPOINT_TIMEOUT_MS = 3 * 60_000;
const SECURE_JSON_MAX_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export function parseBootstrapCommand(args) {
  if (!Array.isArray(args) || args.length !== 1) {
    throw new Error("지원하지 않는 bootstrap 명령입니다.");
  }
  const [arg] = args;
  if (arg === "--launch") return "launch";
  if (arg === "start") return "start";
  if (arg === "status") return "status";
  if (arg === "stop") return "stop";
  if (arg === INTERNAL_SUPERVISOR_COMMAND) return "supervisor";
  throw new Error(`지원하지 않는 bootstrap 명령입니다: ${arg}`);
}

export function repositoryRootFromScriptUrl(scriptUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(scriptUrl)), "..");
}

export function resolveRuntimePaths(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const directory = join(root, RUNTIME_DIRECTORY_NAME);
  return {
    directory,
    state: join(directory, "state.json"),
    heartbeat: join(directory, "heartbeat.json"),
    appLog: join(directory, "app.log"),
    whisperLog: join(directory, "whisper.log"),
    supervisorLog: join(directory, "supervisor.log"),
  };
}

export function buildBootstrapCommandPlan({
  repositoryRoot,
  nodeExecutable = process.execPath,
  npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm",
}) {
  const root = resolve(repositoryRoot);
  return [
    {
      name: "doctor",
      command: nodeExecutable,
      args: [join(root, "scripts", "setup.mjs")],
      env: {},
    },
    {
      name: "dependencies",
      command: npmExecutable,
      args: ["ci"],
      env: { HUSKY: "0" },
    },
    {
      name: "build",
      command: npmExecutable,
      args: ["run", "build"],
      env: {},
    },
  ];
}

function buildAppCommand({
  repositoryRoot,
  appPort,
  whisperPort,
  nodeExecutable = process.execPath,
}) {
  const root = resolve(repositoryRoot);
  return {
    command: nodeExecutable,
    args: [
      join(root, "node_modules", "next", "dist", "bin", "next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    env: {
      HOSTNAME: "127.0.0.1",
      PORT: String(appPort),
      LOCAL_STT_HOST: "127.0.0.1",
      LOCAL_STT_PORT: String(whisperPort),
    },
  };
}

function buildWhisperCommand({
  repositoryRoot,
  whisperPort,
  uvExecutable = process.platform === "win32" ? "uv.exe" : "uv",
}) {
  const root = resolve(repositoryRoot);
  return {
    command: uvExecutable,
    args: [
      "run",
      "--project",
      join(root, "whisper"),
      "python",
      join(root, "whisper", "server.py"),
    ],
    env: {
      LOCAL_STT_HOST: "127.0.0.1",
      LOCAL_STT_PORT: String(whisperPort),
    },
  };
}

export function buildRuntimeCommandPlan({
  repositoryRoot,
  appPort,
  whisperPort,
  nodeExecutable = process.execPath,
  uvExecutable = process.platform === "win32" ? "uv.exe" : "uv",
}) {
  return {
    app: buildAppCommand({
      repositoryRoot,
      appPort,
      whisperPort,
      nodeExecutable,
    }),
    whisper: buildWhisperCommand({
      repositoryRoot,
      whisperPort,
      uvExecutable,
    }),
  };
}

function assertPortRange(startPort, candidateCount) {
  if (
    !Number.isInteger(startPort) ||
    !Number.isInteger(candidateCount) ||
    startPort < 1 ||
    candidateCount < 1 ||
    startPort + candidateCount - 1 > 65_535
  ) {
    throw new Error("유효하지 않은 bounded loopback port 범위입니다.");
  }
}

export async function startOnAvailablePort({
  startPort,
  candidateCount = PORT_CANDIDATE_COUNT,
  probePort,
  launchCandidate,
}) {
  assertPortRange(startPort, candidateCount);
  const endPort = startPort + candidateCount - 1;
  for (let port = startPort; port <= endPort; port += 1) {
    if (!(await probePort(port))) continue;
    const outcome = await launchCandidate(port);
    if (outcome?.kind === "bind-conflict") continue;
    if (outcome?.kind === "started") return { port, ...outcome };
    throw new Error(`port ${port} 시작 결과가 유효하지 않습니다.`);
  }
  throw new Error(
    `${startPort}-${endPort} 범위에서 사용 가능한 loopback port를 찾지 못했습니다.`,
  );
}

export async function waitForHealth({
  name,
  url,
  timeoutMs,
  intervalMs,
  probe,
  isReady = (value) => value === true,
  now = Date.now,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  retryError = () => true,
}) {
  if (!(timeoutMs > 0) || !(intervalMs > 0)) {
    throw new Error("health timeout과 interval은 양수여야 합니다.");
  }
  const deadline = now() + timeoutMs;
  let lastError;
  while (true) {
    try {
      const result = await probe(url);
      if (isReady(result)) return result;
    } catch (error) {
      if (!retryError(error)) throw error;
      lastError = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      const suffix = lastError instanceof Error ? ` (${lastError.message})` : "";
      throw new Error(`${name} health timeout after ${timeoutMs}ms: ${url}${suffix}`);
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

export function isWhisperHealthReady(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.connected === true &&
    value.ok === true &&
    value.ready === true
  );
}

export function canonicalAppUrl(port) {
  assertPortRange(port, 1);
  return `http://localhost:${port}`;
}

function browserFallbackMessage(url) {
  return (
    `브라우저를 자동으로 열지 못했습니다. ${url}\n` +
    `에이전트에서는 사용 가능한 에이전트 browser surface로 ${url} 을 여세요.`
  );
}

export function browserOpenSpec({
  platform = process.platform,
  env = process.env,
  url,
}) {
  if (env.CI || env.AI_NOTE_HEADLESS === "1") return null;
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (platform === "linux") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    return { command: "xdg-open", args: [url] };
  }
  return null;
}

export async function openBrowserWithFallback({
  platform = process.platform,
  env = process.env,
  url,
  open,
}) {
  const spec = browserOpenSpec({ platform, env, url });
  if (spec === null) {
    return { opened: false, message: browserFallbackMessage(url) };
  }
  try {
    await open(spec);
    return { opened: true };
  } catch {
    return { opened: false, message: browserFallbackMessage(url) };
  }
}

function isPositivePid(value) {
  return Number.isInteger(value) && value > 0;
}

function isRuntimeState(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.schemaVersion === 1 &&
    typeof value.repositoryRoot === "string" &&
    isPositivePid(value.supervisorPid) &&
    TOKEN_PATTERN.test(value.token) &&
    Number.isInteger(value.appPort) &&
    value.appPort >= 1 &&
    value.appPort <= 65_535 &&
    Number.isInteger(value.whisperPort) &&
    value.whisperPort >= 1 &&
    value.whisperPort <= 65_535 &&
    isPositivePid(value.appPid) &&
    isPositivePid(value.whisperPid) &&
    Number.isFinite(value.startedAt)
  );
}

function isRuntimeHeartbeat(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.schemaVersion === 1 &&
    typeof value.repositoryRoot === "string" &&
    isPositivePid(value.supervisorPid) &&
    TOKEN_PATTERN.test(value.token) &&
    Number.isFinite(value.updatedAt)
  );
}

export async function classifyRuntimeOwnership({
  state,
  heartbeat,
  repositoryRoot,
  nowMs = Date.now(),
  heartbeatMaxAgeMs = HEARTBEAT_MAX_AGE_MS,
  isProcessAlive,
}) {
  const root = resolve(repositoryRoot);
  if (!isRuntimeState(state)) {
    return { kind: "unsafe", reason: "state_invalid" };
  }
  if (!isRuntimeHeartbeat(heartbeat)) {
    return { kind: "unsafe", reason: "heartbeat_invalid" };
  }
  if (resolve(state.repositoryRoot) !== root || resolve(heartbeat.repositoryRoot) !== root) {
    return { kind: "unsafe", reason: "repository_root_mismatch" };
  }
  if (state.supervisorPid !== heartbeat.supervisorPid) {
    return { kind: "unsafe", reason: "supervisor_pid_mismatch" };
  }
  if (state.token !== heartbeat.token) {
    return { kind: "unsafe", reason: "ownership_token_mismatch" };
  }
  if (heartbeat.updatedAt > nowMs + HEARTBEAT_INTERVAL_MS) {
    return { kind: "unsafe", reason: "heartbeat_from_future" };
  }
  if (nowMs - heartbeat.updatedAt > heartbeatMaxAgeMs) {
    return { kind: "stale", reason: "heartbeat_stale" };
  }
  try {
    if (!(await isProcessAlive(state.supervisorPid))) {
      return { kind: "stale", reason: "supervisor_not_live" };
    }
  } catch {
    return { kind: "unsafe", reason: "supervisor_liveness_unverifiable" };
  }
  return { kind: "owned", state, heartbeat };
}

async function readSecureJson(path, label) {
  let pathInfo;
  try {
    pathInfo = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "unsafe", reason: `${label}_unreadable` };
  }
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    return { kind: "unsafe", reason: `${label}_not_regular` };
  }
  if (pathInfo.size > SECURE_JSON_MAX_BYTES) {
    return { kind: "unsafe", reason: `${label}_unreadable` };
  }

  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.size > SECURE_JSON_MAX_BYTES) {
      return { kind: "unsafe", reason: `${label}_not_regular` };
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    return { kind: "value", value: JSON.parse(raw) };
  } catch {
    return { kind: "unsafe", reason: `${label}_unreadable` };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function launchLockPath(paths) {
  return join(paths.directory, "launch.lock");
}

function pathsMatchRepository(paths, repositoryRoot) {
  const expected = resolveRuntimePaths(repositoryRoot);
  return Object.keys(expected).every(
    (key) => resolve(paths[key]) === expected[key],
  );
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readRuntimeOwnership({
  paths,
  repositoryRoot,
  nowMs = Date.now(),
  heartbeatMaxAgeMs = HEARTBEAT_MAX_AGE_MS,
  isProcessAlive,
}) {
  if (!pathsMatchRepository(paths, repositoryRoot)) {
    return { kind: "unsafe", reason: "runtime_path_mismatch" };
  }

  let directoryInfo;
  try {
    directoryInfo = await lstat(paths.directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { kind: "absent", reason: "state_missing" };
    }
    return { kind: "unsafe", reason: "runtime_directory_unreadable" };
  }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    return { kind: "unsafe", reason: "runtime_directory_not_safe" };
  }

  const stateRecord = await readSecureJson(paths.state, "state");
  if (stateRecord.kind === "unsafe") return stateRecord;
  if (stateRecord.kind === "missing") {
    try {
      if (await pathExists(paths.heartbeat)) {
        return { kind: "unsafe", reason: "orphan_heartbeat" };
      }
      if (await pathExists(launchLockPath(paths))) {
        return { kind: "unsafe", reason: "launch_in_progress_or_stale" };
      }
    } catch {
      return { kind: "unsafe", reason: "runtime_directory_unreadable" };
    }
    return { kind: "absent", reason: "state_missing" };
  }

  const heartbeatRecord = await readSecureJson(paths.heartbeat, "heartbeat");
  if (heartbeatRecord.kind === "unsafe") return heartbeatRecord;
  if (heartbeatRecord.kind === "missing") {
    return { kind: "stale", reason: "heartbeat_missing" };
  }
  return classifyRuntimeOwnership({
    state: stateRecord.value,
    heartbeat: heartbeatRecord.value,
    repositoryRoot,
    nowMs,
    heartbeatMaxAgeMs,
    isProcessAlive,
  });
}

export async function stopOwnedRuntime({
  readOwnership,
  signal,
}) {
  const ownership = await readOwnership();
  if (ownership.kind !== "owned") {
    throw new Error(
      `runtime ownership 확인 실패(${ownership.reason ?? ownership.kind}); signal을 보내지 않았습니다.`,
    );
  }
  await signal(ownership.state.supervisorPid, "SIGTERM");
  return { stoppedPid: ownership.state.supervisorPid };
}

export async function runLaunchFlow({
  repositoryRoot,
  commandPlan,
  runCommand,
  startRuntime,
  waitForEndpoint,
  openBrowser,
  writeLine,
}) {
  for (const spec of commandPlan) {
    await runCommand(spec);
  }
  const runtime = await startRuntime();
  const loopbackBaseUrl = `http://127.0.0.1:${runtime.appPort}`;
  await waitForEndpoint({
    name: "app",
    url: `${loopbackBaseUrl}/`,
    isReady: (value) => value?.ready === true,
  });
  await waitForEndpoint({
    name: "whisper",
    url: `${loopbackBaseUrl}/api/whisper/health`,
    isReady: isWhisperHealthReady,
  });
  const url = canonicalAppUrl(runtime.appPort);
  writeLine(`AI_NOTE_URL=${url}`);
  const browser = await openBrowser({ url });
  if (!browser.opened && browser.message) writeLine(browser.message);
  return { url, runtime, browser };
}

async function ensureRuntimeDirectory(paths) {
  try {
    const info = await lstat(paths.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`unsafe runtime directory: ${paths.directory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(paths.directory, { mode: 0o700 });
  }
  await chmod(paths.directory, 0o700);
}

async function assertSafeWritableFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`unsafe runtime file: ${path}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeSecureJson(path, value) {
  await assertSafeWritableFile(path);
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(
      temp,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temp).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function acquireLaunchLock(paths, token) {
  const path = launchLockPath(paths);
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(`${token}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    return path;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      throw new Error(
        `runtime launch lock이 이미 존재합니다: ${path}. 실행 중이거나 stale일 수 있어 덮어쓰지 않습니다.`,
      );
    }
    throw error;
  }
}

async function releaseLaunchLock(path, token) {
  const record = await readSecureText(path);
  if (record.kind === "value" && record.value.trim() === token) {
    await unlink(path).catch(() => {});
  }
}

async function readSecureText(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "unsafe" };
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > SECURE_JSON_MAX_BYTES) {
    return { kind: "unsafe" };
  }
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    return { kind: "value", value: await handle.readFile({ encoding: "utf8" }) };
  } catch {
    return { kind: "unsafe" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function realIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function runProcess(spec, { repositoryRoot, stdio = "inherit" } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = nodeSpawn(spec.command, spec.args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...spec.env },
      shell: false,
      stdio,
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${spec.name ?? spec.command} 실패(exit=${code ?? "null"}, signal=${signal ?? "none"})`,
        ),
      );
    });
  });
}

function realProbePort(port) {
  return new Promise((resolveProbe, rejectProbe) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        resolveProbe(false);
      } else {
        rejectProbe(error);
      }
    });
    server.listen(
      {
        host: "127.0.0.1",
        port,
        exclusive: true,
      },
      () => {
        server.close((error) => {
          if (error) rejectProbe(error);
          else resolveProbe(true);
        });
      },
    );
  });
}

async function fetchEndpoint(url, { json = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "X-AI-Note-Service": "app-api-v1" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return json ? null : { ready: false };
    return json ? await response.json() : { ready: true };
  } catch {
    return json ? null : { ready: false };
  } finally {
    clearTimeout(timer);
  }
}

async function realWaitForEndpoint({ name, url, isReady }) {
  return waitForHealth({
    name,
    url,
    timeoutMs: ENDPOINT_TIMEOUT_MS,
    intervalMs: 500,
    probe: (endpoint) =>
      fetchEndpoint(endpoint, {
        json: endpoint.endsWith("/api/whisper/health"),
      }),
    isReady,
  });
}

function openBrowserProcess(spec) {
  return new Promise((resolveOpen, rejectOpen) => {
    const child = nodeSpawn(spec.command, spec.args, {
      env: process.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", rejectOpen);
    child.once("exit", (code) => {
      if (code === 0) resolveOpen();
      else rejectOpen(new Error(`browser opener exit ${code ?? "null"}`));
    });
  });
}

async function realOpenBrowser({ url }) {
  return openBrowserWithFallback({
    platform: process.platform,
    env: process.env,
    url,
    open: openBrowserProcess,
  });
}

async function createSecureLogStream(path) {
  await assertSafeWritableFile(path);
  const handle = await open(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_APPEND |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  await handle.close();
  await chmod(path, 0o600);
  const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
  await new Promise((resolveOpen, rejectOpen) => {
    stream.once("open", resolveOpen);
    stream.once("error", rejectOpen);
  });
  return stream;
}

async function spawnLoggedChild({
  spec,
  repositoryRoot,
  logPath,
}) {
  const log = await createSecureLogStream(logPath);
  let tail = "";
  let spawnError = null;
  const child = nodeSpawn(spec.command, spec.args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...spec.env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = (chunk) => {
    log.write(chunk);
    tail = `${tail}${chunk.toString("utf8")}`.slice(-SECURE_JSON_MAX_BYTES);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", () => {
    log.end();
  });
  return {
    child,
    getTail: () => tail,
    getSpawnError: () => spawnError,
    closeLog: () => log.end(),
  };
}

class ChildStoppedBeforeReady extends Error {}

async function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ]);
}

async function terminateSpawnedChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForChildExit(child);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForChildExit(child);
  }
}

function containsBindConflict(output) {
  return /EADDRINUSE|address already in use|errno\s+(?:48|98)/iu.test(output);
}

async function launchServiceCandidate({
  name,
  spec,
  repositoryRoot,
  logPath,
  readinessUrl,
  readinessMarker,
  isReady,
}) {
  const record = await spawnLoggedChild({ spec, repositoryRoot, logPath });
  try {
    await waitForHealth({
      name,
      url: readinessUrl,
      timeoutMs: ENDPOINT_TIMEOUT_MS,
      intervalMs: 250,
      probe: async (url) => {
        const spawnError = record.getSpawnError();
        if (spawnError) throw new ChildStoppedBeforeReady(spawnError.message);
        if (
          record.child.exitCode !== null ||
          record.child.signalCode !== null
        ) {
          throw new ChildStoppedBeforeReady(`${name} child exited`);
        }
        if (!readinessMarker(record.getTail())) return null;
        return fetchEndpoint(url, { json: name === "whisper" });
      },
      isReady,
      retryError: (error) => !(error instanceof ChildStoppedBeforeReady),
    });
    return {
      kind: "started",
      child: record.child,
      closeLog: record.closeLog,
    };
  } catch (error) {
    const output = record.getTail();
    await terminateSpawnedChild(record.child);
    record.closeLog();
    if (containsBindConflict(output)) return { kind: "bind-conflict" };
    throw error;
  }
}

async function removeOwnedRuntimeState(paths, token) {
  const stateRecord = await readSecureJson(paths.state, "state");
  const heartbeatRecord = await readSecureJson(paths.heartbeat, "heartbeat");
  if (
    stateRecord.kind !== "value" ||
    heartbeatRecord.kind !== "value" ||
    stateRecord.value?.token !== token ||
    heartbeatRecord.value?.token !== token
  ) {
    return false;
  }
  await unlink(paths.heartbeat).catch(() => {});
  await unlink(paths.state).catch(() => {});
  return true;
}

async function runSupervisor({
  repositoryRoot,
  paths,
  token,
  sendMessage = (message) => process.send?.(message),
}) {
  await ensureRuntimeDirectory(paths);
  if (await pathExists(paths.state)) {
    throw new Error("기존 runtime state를 덮어쓰지 않습니다.");
  }
  if (await pathExists(paths.heartbeat)) {
    throw new Error("기존 runtime heartbeat를 덮어쓰지 않습니다.");
  }

  const whisper = await startOnAvailablePort({
    startPort: WHISPER_START_PORT,
    candidateCount: PORT_CANDIDATE_COUNT,
    probePort: realProbePort,
    launchCandidate: (whisperPort) =>
      launchServiceCandidate({
        name: "whisper",
        spec: buildWhisperCommand({ repositoryRoot, whisperPort }),
        repositoryRoot,
        logPath: paths.whisperLog,
        readinessUrl: `http://127.0.0.1:${whisperPort}/health`,
        readinessMarker: (output) =>
          output.includes(
            `WHISPER_LISTENING http://127.0.0.1:${whisperPort}`,
          ),
        isReady: (value) => value?.ok === true && value?.ready === true,
      }),
  });

  let app;
  try {
    app = await startOnAvailablePort({
      startPort: APP_START_PORT,
      candidateCount: PORT_CANDIDATE_COUNT,
      probePort: realProbePort,
      launchCandidate: (appPort) =>
        launchServiceCandidate({
          name: "app",
          spec: buildAppCommand({
            repositoryRoot,
            appPort,
            whisperPort: whisper.port,
          }),
          repositoryRoot,
          logPath: paths.appLog,
          readinessUrl: `http://127.0.0.1:${appPort}/`,
          readinessMarker: (output) =>
            output.includes(`:${appPort}`) && /\bReady in\b/iu.test(output),
          isReady: (value) => value?.ready === true,
        }),
    });
  } catch (error) {
    await terminateSpawnedChild(whisper.child);
    whisper.closeLog();
    throw error;
  }

  const state = {
    schemaVersion: 1,
    repositoryRoot,
    supervisorPid: process.pid,
    token,
    appPort: app.port,
    whisperPort: whisper.port,
    appPid: app.child.pid,
    whisperPid: whisper.child.pid,
    startedAt: Date.now(),
  };
  const heartbeatValue = () => ({
    schemaVersion: 1,
    repositoryRoot,
    supervisorPid: process.pid,
    token,
    updatedAt: Date.now(),
  });
  await writeSecureJson(paths.state, state);
  await writeSecureJson(paths.heartbeat, heartbeatValue());
  await releaseLaunchLock(launchLockPath(paths), token);

  let closing = false;
  let heartbeatWriting = false;
  let heartbeatWrite = Promise.resolve();
  let heartbeatTimer;

  const shutdown = async (exitCode) => {
    if (closing) return;
    closing = true;
    clearInterval(heartbeatTimer);
    await heartbeatWrite;
    await Promise.all([
      terminateSpawnedChild(app.child),
      terminateSpawnedChild(whisper.child),
    ]);
    app.closeLog();
    whisper.closeLog();
    await removeOwnedRuntimeState(paths, token);
    process.exit(exitCode);
  };

  heartbeatTimer = setInterval(() => {
    if (heartbeatWriting || closing) return;
    heartbeatWriting = true;
    let failed = false;
    heartbeatWrite = writeSecureJson(paths.heartbeat, heartbeatValue())
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        heartbeatWriting = false;
        if (failed) setImmediate(() => shutdown(1));
      });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  app.child.once("exit", () => shutdown(1));
  whisper.child.once("exit", () => shutdown(1));
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));

  sendMessage({ type: "ready", token, state });
}

async function spawnSupervisorProcess({ repositoryRoot, paths }) {
  await ensureRuntimeDirectory(paths);
  const existing = await readRuntimeOwnership({
    paths,
    repositoryRoot,
    isProcessAlive: realIsProcessAlive,
  });
  if (existing.kind === "owned") return existing.state;
  if (existing.kind !== "absent") {
    throw new Error(
      `기존 runtime을 안전하게 소유권 확인할 수 없습니다(${existing.reason}). 덮어쓰거나 종료하지 않습니다.`,
    );
  }

  const token = randomBytes(32).toString("hex");
  const lock = await acquireLaunchLock(paths, token);
  let supervisorLog;
  let child;
  try {
    supervisorLog = await createSecureLogStream(paths.supervisorLog);
    child = nodeSpawn(
      process.execPath,
      [join(repositoryRoot, "scripts", "bootstrap.mjs"), INTERNAL_SUPERVISOR_COMMAND],
      {
        cwd: repositoryRoot,
        detached: true,
        env: {
          ...process.env,
          AI_NOTE_RUNTIME_TOKEN: token,
        },
        shell: false,
        stdio: ["ignore", supervisorLog, supervisorLog, "ipc"],
        windowsHide: true,
      },
    );

    const state = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        rejectReady(new Error(`runtime supervisor startup timeout: ${paths.supervisorLog}`));
      }, STARTUP_TIMEOUT_MS);
      const finish = (callback, value) => {
        clearTimeout(timer);
        callback(value);
      };
      child.once("error", (error) => finish(rejectReady, error));
      child.once("exit", (code, signal) => {
        finish(
          rejectReady,
          new Error(
            `runtime supervisor 종료(exit=${code ?? "null"}, signal=${signal ?? "none"}): ${paths.supervisorLog}`,
          ),
        );
      });
      child.on("message", (message) => {
        if (
          message?.type === "ready" &&
          message.token === token &&
          isRuntimeState(message.state) &&
          message.state.supervisorPid === child.pid
        ) {
          finish(resolveReady, message.state);
        } else if (message?.type === "error" && message.token === token) {
          finish(rejectReady, new Error(String(message.error)));
        }
      });
    });

    child.disconnect();
    child.unref();
    return state;
  } catch (error) {
    if (
      child &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill("SIGTERM");
      await waitForChildExit(child);
    }
    throw error;
  } finally {
    supervisorLog?.end();
    await releaseLaunchLock(lock, token);
  }
}

async function waitForRuntimeStateRemoval(paths, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pathExists(paths.state)) && !(await pathExists(paths.heartbeat))) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  }
  throw new Error("owned supervisor가 종료되었지만 runtime state 정리를 확인하지 못했습니다.");
}

async function runStatus({ repositoryRoot, paths }) {
  const ownership = await readRuntimeOwnership({
    paths,
    repositoryRoot,
    isProcessAlive: realIsProcessAlive,
  });
  if (ownership.kind !== "owned") {
    throw new Error(
      `AI NOTE runtime 상태를 안전하게 확인할 수 없습니다(${ownership.reason ?? ownership.kind}).`,
    );
  }
  const { state } = ownership;
  const appUrl = canonicalAppUrl(state.appPort);
  const app = await fetchEndpoint(`http://127.0.0.1:${state.appPort}/`);
  const whisper = await fetchEndpoint(
    `http://127.0.0.1:${state.appPort}/api/whisper/health`,
    { json: true },
  );
  console.log(`AI_NOTE_URL=${appUrl}`);
  console.log(`supervisor=owned pid=${state.supervisorPid}`);
  console.log(`app=${app?.ready === true ? "ready" : "not_ready"} log=${paths.appLog}`);
  console.log(
    `whisper=${isWhisperHealthReady(whisper) ? "ready" : "not_ready"} log=${paths.whisperLog}`,
  );
  console.log(`supervisor_log=${paths.supervisorLog}`);
}

async function runStop({ repositoryRoot, paths }) {
  const readOwnership = () =>
    readRuntimeOwnership({
      paths,
      repositoryRoot,
      isProcessAlive: realIsProcessAlive,
    });
  const result = await stopOwnedRuntime({
    readOwnership,
    signal: (pid, signal) => process.kill(pid, signal),
  });
  await waitForRuntimeStateRemoval(paths);
  console.log(`AI NOTE runtime stopped (supervisor pid=${result.stoppedPid}).`);
}

async function runStart({ repositoryRoot, paths, install }) {
  const commandPlan = install
    ? buildBootstrapCommandPlan({ repositoryRoot })
    : [];
  return runLaunchFlow({
    repositoryRoot,
    commandPlan,
    runCommand: (spec) => runProcess(spec, { repositoryRoot }),
    startRuntime: () => spawnSupervisorProcess({ repositoryRoot, paths }),
    waitForEndpoint: realWaitForEndpoint,
    openBrowser: realOpenBrowser,
    writeLine: (line) => console.log(line),
  });
}

async function main() {
  const command = parseBootstrapCommand(process.argv.slice(2));
  const lexicalRoot = repositoryRootFromScriptUrl(import.meta.url);
  const repositoryRoot = await realpath(lexicalRoot);
  const paths = resolveRuntimePaths(repositoryRoot);

  if (command === "supervisor") {
    const token = process.env.AI_NOTE_RUNTIME_TOKEN;
    delete process.env.AI_NOTE_RUNTIME_TOKEN;
    if (!TOKEN_PATTERN.test(token ?? "") || typeof process.send !== "function") {
      throw new Error("internal supervisor ownership token/IPC가 유효하지 않습니다.");
    }
    try {
      await runSupervisor({ repositoryRoot, paths, token });
    } catch (error) {
      process.send?.({
        type: "error",
        token,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return;
  }
  if (command === "launch") {
    await runStart({ repositoryRoot, paths, install: true });
    return;
  }
  if (command === "start") {
    await runStart({ repositoryRoot, paths, install: false });
    return;
  }
  if (command === "status") {
    await runStatus({ repositoryRoot, paths });
    return;
  }
  await runStop({ repositoryRoot, paths });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? `✗ ${error.message}` : "✗ bootstrap failed");
    process.exitCode = 1;
  });
}
