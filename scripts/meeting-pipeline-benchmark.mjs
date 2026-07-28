#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SAFE_MEETING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PROCESS_OUTPUT_CAP = 64 * 1024;
const PROCESS_TIMEOUT_MS = 3 * 60 * 60 * 1_000;
const REVIEW_TEMPLATE = `# 회의 파이프라인 벤치마크 검수

원본 오디오와 각 결과를 직접 대조한 뒤 체크하세요. 체크 전 추천은 undecided입니다.

- [ ] 중요 이름: 누락·오인식 증가가 없음
- [ ] 숫자·날짜·금액: 오류 증가가 없음
- [ ] 결정사항: 누락·의미 변경이 없음
`;

class BenchmarkError extends Error {
  constructor(code) {
    super(code);
    this.name = "BenchmarkError";
    this.code = code;
  }
}

export function parseBenchmarkArgs(argv) {
  if (
    argv.length !== 2
    || argv[0] !== "--meeting-id"
    || !SAFE_MEETING_ID.test(argv[1] ?? "")
    || argv[1].toLowerCase() === "latest"
  ) {
    throw new BenchmarkError("invalid_benchmark_arguments");
  }
  return { meetingId: argv[1] };
}

export function calculateBenchmarkDecision(input) {
  const turboSpeedup = input.turboMs > 0
    ? input.largeV3Ms / input.turboMs
    : 0;
  const fastReduction = input.fullMs > 0
    ? (input.fullMs - input.fastMs) / input.fullMs
    : 0;
  const turboMeets2x = turboSpeedup >= 2;
  const fastMeets30Percent = fastReduction >= 0.3;
  const reviewValues = [
    input.review.names,
    input.review.numbers,
    input.review.decisions,
  ];
  let recommendation = "undecided";
  if (reviewValues.includes("fail")) recommendation = "rejected";
  else if (reviewValues.every((value) => value === "pass")) {
    recommendation = turboMeets2x && fastMeets30Percent
      ? "candidate"
      : "rejected";
  }
  return {
    turboSpeedup,
    turboMeets2x,
    fastReduction,
    fastMeets30Percent,
    recommendation,
  };
}

function defaultRunProcess(request) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const collect = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > PROCESS_OUTPUT_CAP) {
        exceeded = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout?.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    let abortKillTimer;
    const abort = () => {
      child.kill("SIGTERM");
      abortKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      abortKillTimer.unref?.();
    };
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), request.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(abortKillTimer);
      request.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearTimeout(abortKillTimer);
      request.signal?.removeEventListener("abort", abort);
      resolveProcess({
        code: exceeded ? null : code,
        stdout,
        stderr,
      });
    });
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (
    !rel.startsWith("..")
    && !rel.startsWith("/")
    && !rel.startsWith("\\")
  );
}

async function assertDirectory(fs, directory) {
  let info;
  try {
    info = await fs.lstat(directory);
  } catch {
    throw new BenchmarkError("unsafe_benchmark_source");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new BenchmarkError("unsafe_benchmark_source");
  }
}

async function assertRegularFile(fs, file, required = true) {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (!required && error?.code === "ENOENT") return false;
    throw new BenchmarkError("unsafe_benchmark_source");
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new BenchmarkError("unsafe_benchmark_source");
  }
  return true;
}

async function readJson(fs, file, maxBytes) {
  const info = await fs.lstat(file);
  if (info.size > maxBytes) throw new BenchmarkError("unsafe_benchmark_source");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new BenchmarkError("unsafe_benchmark_source");
  }
}

async function makePrivateDirectory(fs, directory, recursive = false) {
  await fs.mkdir(directory, { recursive, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function writePrivateFile(fs, file, value) {
  await fs.writeFile(file, value, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function copyPrivateFile(fs, source, destination) {
  await assertRegularFile(fs, source);
  await fs.copyFile(source, destination);
  await fs.chmod(destination, 0o600);
}

function safeBenchmarkEnvironment() {
  const environment = {
    ...process.env,
    AI_NOTE_BENCHMARK: "1",
  };
  delete environment.AI_NOTE_DATA_ROOT;
  delete environment.FAKE_LLM;
  delete environment.FAKE_LLM_FAIL;
  delete environment.FAKE_WHISPER;
  delete environment.LOCAL_STT_GLOSSARY;
  return environment;
}

async function validateSource(fs, repositoryRoot, meetingId) {
  const dataRoot = join(repositoryRoot, "data");
  const meetingsRoot = join(dataRoot, "meetings");
  const meetingRoot = join(meetingsRoot, meetingId);
  await assertDirectory(fs, dataRoot);
  await assertDirectory(fs, meetingsRoot);
  await assertDirectory(fs, meetingRoot);
  const realMeetingsRoot = await fs.realpath(meetingsRoot);
  const realMeetingRoot = await fs.realpath(meetingRoot);
  if (
    !contained(realMeetingsRoot, realMeetingRoot)
    || dirname(realMeetingRoot) !== realMeetingsRoot
  ) {
    throw new BenchmarkError("unsafe_benchmark_source");
  }

  const files = {
    audio: join(meetingRoot, "audio.webm"),
    raw: join(meetingRoot, "raw.md"),
    segments: join(meetingRoot, "segments.json"),
    status: join(meetingRoot, "status.json"),
    transcript: join(meetingRoot, "transcript.md"),
    summary: join(meetingRoot, "summary.json"),
    settings: join(dataRoot, "settings.json"),
    pipelineSettings: join(dataRoot, "pipeline-settings.json"),
    glossary: join(repositoryRoot, "glossary.json"),
  };
  for (const key of ["audio", "raw", "segments", "status", "settings"]) {
    await assertRegularFile(fs, files[key]);
  }
  for (const key of ["transcript", "summary", "pipelineSettings", "glossary"]) {
    await assertRegularFile(fs, files[key], false);
  }
  const status = await readJson(fs, files.status, 1024 * 1024);
  const settings = await readJson(fs, files.settings, 64 * 1024);
  if (
    status?.id !== meetingId
    || !["claude-cli", "codex-cli", "ollama"].includes(settings?.provider)
  ) {
    throw new BenchmarkError("unsafe_benchmark_source");
  }
  return { dataRoot, meetingRoot, files, status, settings };
}

function runId(now, randomId) {
  const instant = new Date(now()).toISOString().replace(/[:.]/gu, "-");
  const suffix = randomId().replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 48);
  return `${instant}-${suffix || "run"}`;
}

async function snapshotSources(fs, source, runDirectory) {
  const sourceDirectory = join(runDirectory, "source");
  await makePrivateDirectory(fs, sourceDirectory);
  const hashes = {};
  for (const key of ["audio", "raw", "segments", "status", "transcript", "summary"]) {
    if (!await assertRegularFile(fs, source.files[key], false)) continue;
    const destination = join(sourceDirectory, basename(source.files[key]));
    await copyPrivateFile(fs, source.files[key], destination);
    hashes[`${key}Sha256`] = sha256(await fs.readFile(destination));
  }
  if (await assertRegularFile(fs, source.files.glossary, false)) {
    await copyPrivateFile(
      fs,
      source.files.glossary,
      join(sourceDirectory, "glossary.json"),
    );
    hashes.glossarySha256 = sha256(
      await fs.readFile(join(sourceDirectory, "glossary.json")),
    );
  }
  return hashes;
}

async function runWhisperCases({
  fs,
  dependencies,
  repositoryRoot,
  runDirectory,
  source,
  environment,
  signal,
}) {
  const root = join(runDirectory, "transcription");
  await makePrivateDirectory(fs, root);
  const stages = {};
  for (const model of ["large-v3", "large-v3-turbo"]) {
    const outputDirectory = join(root, model);
    const processResult = await dependencies.runProcess({
      command: "python3",
      args: [
        join(repositoryRoot, "whisper", "benchmark.py"),
        "--audio",
        join(runDirectory, "source", "audio.webm"),
        "--output-dir",
        outputDirectory,
        "--allowed-root",
        root,
        "--model",
        model,
      ],
      cwd: runDirectory,
      env: environment,
      timeoutMs: PROCESS_TIMEOUT_MS,
      signal,
    });
    if (processResult.code !== 0) {
      throw new BenchmarkError("benchmark_transcription_failed");
    }
    const metrics = await readJson(
      fs,
      join(outputDirectory, "metrics.json"),
      64 * 1024,
    );
    if (
      metrics?.model !== model
      || typeof metrics.wallTimeMs !== "number"
      || !/^[a-f0-9]{64}$/u.test(metrics.rawSha256 ?? "")
      || !/^[a-f0-9]{64}$/u.test(metrics.segmentsSha256 ?? "")
    ) {
      throw new BenchmarkError("benchmark_transcription_failed");
    }
    stages[model] = metrics;
  }
  return stages;
}

async function prepareCorrectionCase({
  fs,
  mode,
  source,
  caseRoot,
}) {
  const inputRoot = join(caseRoot, "input");
  const outputRoot = join(caseRoot, "output");
  await makePrivateDirectory(fs, caseRoot);
  await makePrivateDirectory(fs, inputRoot);
  await makePrivateDirectory(fs, outputRoot);
  for (const key of ["raw", "segments", "settings"]) {
    await copyPrivateFile(
      fs,
      source.files[key],
      join(inputRoot, basename(source.files[key])),
    );
  }
  await writePrivateFile(
    fs,
    join(inputRoot, "mode.json"),
    `${JSON.stringify({ mode }, null, 2)}\n`,
  );
  if (await assertRegularFile(fs, source.files.glossary, false)) {
    await copyPrivateFile(fs, source.files.glossary, join(inputRoot, "glossary.json"));
  }
  return outputRoot;
}

function correctionRunnerSource(repositoryRoot) {
  const root = JSON.stringify(repositoryRoot);
  return `const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const Module = require("node:module");
const path = require("node:path");
const repositoryRoot = ${root};
const ts = require(require.resolve("typescript", { paths: [repositoryRoot] }));
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  const resolvedRequest = request.startsWith("@/")
    ? path.join(repositoryRoot, "src", request.slice(2))
    : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};
const compileTypeScript = function(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
require.extensions[".ts"] = compileTypeScript;
require.extensions[".tsx"] = compileTypeScript;

void (async () => {
  const { glossarySchema } = require(path.join(repositoryRoot, "src", "domain", "glossary.ts"));
  const { createCorrectionChunkPlan } = require(path.join(repositoryRoot, "src", "lib", "correctionChunks.ts"));
  const { runCorrectionChunks } = require(path.join(repositoryRoot, "src", "lib", "correctionRunner.ts"));
  const { resolveTranscript } = require(path.join(repositoryRoot, "src", "lib", "summarizeCore.ts"));
  const { buildCorrectionPrompt } = require(path.join(repositoryRoot, "src", "lib", "summarizePrompts.ts"));
  const { getAdapter } = require(path.join(repositoryRoot, "src", "services", "llm", "index.ts"));
  const inputRoot = path.join(process.cwd(), "input");
  const raw = await fsPromises.readFile(path.join(inputRoot, "raw.md"), "utf8");
  const segments = JSON.parse(await fsPromises.readFile(path.join(inputRoot, "segments.json"), "utf8"));
  const settings = JSON.parse(await fsPromises.readFile(path.join(inputRoot, "settings.json"), "utf8"));
  const mode = JSON.parse(await fsPromises.readFile(path.join(inputRoot, "mode.json"), "utf8")).mode;
  let glossaryValue = { terms: [], corrections: [] };
  try {
    glossaryValue = JSON.parse(
      await fsPromises.readFile(path.join(inputRoot, "glossary.json"), "utf8"),
    );
  } catch {}
  const glossary = glossarySchema.parse(
    Array.isArray(glossaryValue)
      ? { terms: glossaryValue, corrections: [] }
      : glossaryValue,
  );
  const adapter = getAdapter(settings);
  let transcript;
  if (mode === "full") {
    transcript = resolveTranscript(
      raw,
      await adapter.run(buildCorrectionPrompt(raw, glossary)),
    );
  } else if (mode === "fast") {
    const plan = createCorrectionChunkPlan(raw, segments);
    transcript = (await runCorrectionChunks({
      plan,
      provider: settings.provider,
      glossary,
      runChunk: (prompt) => adapter.run(prompt),
    })).transcript;
  } else {
    throw new Error("invalid_benchmark_mode");
  }
  await fsPromises.writeFile(
    path.join(process.cwd(), "output", "transcript.md"),
    transcript,
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ status: "completed", mode }));
})();
`;
}

async function runCorrectionCases({
  fs,
  dependencies,
  repositoryRoot,
  runDirectory,
  source,
  environment,
  signal,
}) {
  const root = join(runDirectory, "correction");
  await makePrivateDirectory(fs, root);
  const internalRoot = join(runDirectory, "internal");
  await makePrivateDirectory(fs, internalRoot);
  const runnerPath = join(internalRoot, "benchmark-correction-runner.cjs");
  await writePrivateFile(
    fs,
    runnerPath,
    correctionRunnerSource(repositoryRoot),
  );
  const stages = {};
  for (const mode of ["full", "fast"]) {
    const caseRoot = join(root, mode);
    const outputRoot = await prepareCorrectionCase({
      fs,
      mode,
      source,
      caseRoot,
    });
    const started = dependencies.now();
    const processResult = await dependencies.runProcess({
      command: process.execPath,
      args: [runnerPath],
      cwd: caseRoot,
      env: environment,
      timeoutMs: PROCESS_TIMEOUT_MS,
      signal,
    });
    const wallTimeMs = Math.max(0, dependencies.now() - started);
    if (processResult.code !== 0) {
      throw new BenchmarkError("benchmark_correction_failed");
    }
    const transcriptPath = join(outputRoot, "transcript.md");
    await assertRegularFile(fs, transcriptPath);
    stages[mode] = {
      mode,
      wallTimeMs,
      transcriptSha256: sha256(await fs.readFile(transcriptPath)),
    };
  }
  return stages;
}

async function writeRunState(fs, runDirectory, value) {
  await writePrivateFile(
    fs,
    join(runDirectory, "run.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

export async function runPipelineBenchmark(input) {
  if (
    !SAFE_MEETING_ID.test(input.meetingId ?? "")
    || input.meetingId.toLowerCase() === "latest"
  ) {
    throw new BenchmarkError("invalid_benchmark_arguments");
  }
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd());
  const codeRoot = resolve(input.codeRoot ?? repositoryRoot);
  const runtimeRoot = resolve(
    input.runtimeRoot
      ?? join(repositoryRoot, ".ai-note-runtime", "benchmarks"),
  );
  const fs = input.dependencies?.fs ?? nodeFs;
  const dependencies = {
    now: input.dependencies?.now ?? (() => Date.now()),
    randomId: input.dependencies?.randomId ?? (() => randomUUID()),
    log: input.dependencies?.log ?? ((message) => console.log(message)),
    runProcess: input.dependencies?.runProcess ?? defaultRunProcess,
  };
  const source = await validateSource(
    fs,
    repositoryRoot,
    input.meetingId,
  );
  const id = runId(dependencies.now, dependencies.randomId);
  await makePrivateDirectory(fs, runtimeRoot, true);
  const runDirectory = join(runtimeRoot, id);
  await makePrivateDirectory(fs, runDirectory);
  dependencies.log(`benchmark started: ${basename(runDirectory)}`);
  const environment = safeBenchmarkEnvironment();
  await writeRunState(fs, runDirectory, {
    schemaVersion: 1,
    status: "running",
    meetingId: input.meetingId,
  });

  try {
    const sourceHashes = await snapshotSources(fs, source, runDirectory);
    const transcription = await runWhisperCases({
      fs,
      dependencies,
      repositoryRoot: codeRoot,
      runDirectory,
      source,
      environment,
      signal: input.signal,
    });
    const correction = await runCorrectionCases({
      fs,
      dependencies,
      repositoryRoot: codeRoot,
      runDirectory,
      source,
      environment,
      signal: input.signal,
    });
    const review = {
      names: "unreviewed",
      numbers: "unreviewed",
      decisions: "unreviewed",
    };
    const decision = calculateBenchmarkDecision({
      largeV3Ms: transcription["large-v3"].wallTimeMs,
      turboMs: transcription["large-v3-turbo"].wallTimeMs,
      fullMs: correction.full.wallTimeMs,
      fastMs: correction.fast.wallTimeMs,
      review,
    });
    const report = {
      schemaVersion: 1,
      status: "completed",
      meetingId: input.meetingId,
      source: sourceHashes,
      provider: {
        provider: source.settings.provider,
        ...(source.settings.model ? { model: source.settings.model } : {}),
      },
      stages: { transcription, correction },
      review,
      ...decision,
    };
    await writePrivateFile(
      fs,
      join(runDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writePrivateFile(fs, join(runDirectory, "review.md"), REVIEW_TEMPLATE);
    await writeRunState(fs, runDirectory, {
      schemaVersion: 1,
      status: "completed",
      meetingId: input.meetingId,
    });
    dependencies.log(`benchmark completed: ${basename(runDirectory)}`);
    return { runDirectory, report };
  } catch {
    await writeRunState(fs, runDirectory, {
      schemaVersion: 1,
      status: "failed",
      meetingId: input.meetingId,
    }).catch(() => {});
    throw new BenchmarkError("benchmark_failed");
  }
}

async function main() {
  let controller;
  try {
    const { meetingId } = parseBenchmarkArgs(process.argv.slice(2));
    controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const result = await runPipelineBenchmark({
        meetingId,
        signal: controller.signal,
      });
      console.log(`benchmark run directory: ${result.runDirectory}`);
      console.log("benchmark status: completed");
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  } catch {
    console.error("benchmark status: failed");
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
