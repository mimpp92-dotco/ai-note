// @vitest-environment node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  calculateBenchmarkDecision,
  parseBenchmarkArgs,
  runPipelineBenchmark,
} from "../meeting-pipeline-benchmark.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

let roots = [];

async function syntheticRepository() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pipeline-benchmark-repo-"));
  roots.push(repositoryRoot);
  const meetingId = "meeting-benchmark-1";
  const meetingRoot = join(repositoryRoot, "data", "meetings", meetingId);
  await mkdir(meetingRoot, { recursive: true });
  const audio = Buffer.from("synthetic audio placeholder");
  const raw = "김민수님이 2026년 8월 1일 배포를 결정했습니다.\n";
  const segments = [{
    start: 0,
    end: 1,
    text: raw.trim(),
  }];
  await writeFile(join(meetingRoot, "audio.webm"), audio);
  await writeFile(join(meetingRoot, "raw.md"), raw);
  await writeFile(join(meetingRoot, "segments.json"), `${JSON.stringify(segments)}\n`);
  await writeFile(join(meetingRoot, "transcript.md"), raw);
  await writeFile(join(meetingRoot, "summary.json"), "{}\n");
  await writeFile(join(meetingRoot, "status.json"), `${JSON.stringify({
    id: meetingId,
    title: "합성 벤치마크",
    status: "summarized",
    error: null,
    startedAt: "2026-07-28T00:00:00.000Z",
    endedAt: "2026-07-28T00:01:00.000Z",
    durationMs: 60_000,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 1 },
    paths: {
      audio: join(meetingRoot, "audio.webm"),
      play: join(meetingRoot, "play.webm"),
      raw: join(meetingRoot, "raw.md"),
      transcript: join(meetingRoot, "transcript.md"),
      summary: join(meetingRoot, "summary.json"),
      segments: join(meetingRoot, "segments.json"),
    },
    review: { participants: [] },
    updatedAt: "2026-07-28T00:02:00.000Z",
  })}\n`);
  await writeFile(join(repositoryRoot, "data", "settings.json"), `${JSON.stringify({
    provider: "claude-cli",
    model: "sonnet",
  })}\n`);
  await writeFile(join(repositoryRoot, "glossary.json"), `${JSON.stringify({
    terms: ["김민수"],
    corrections: [],
  })}\n`);
  return { repositoryRoot, meetingId, meetingRoot, audio, raw };
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("meeting pipeline benchmark", () => {
  it("requires one exact safe meeting ID and rejects latest or path guessing", () => {
    expect(parseBenchmarkArgs(["--meeting-id", "meeting-123"])).toEqual({
      meetingId: "meeting-123",
    });
    for (const argv of [
      [],
      ["--meeting-id", "latest"],
      ["--meeting-id", "../meeting-123"],
      ["--meeting-id", "/tmp/meeting-123"],
      ["--meeting-id", "meeting-123", "--extra"],
    ]) {
      expect(() => parseBenchmarkArgs(argv)).toThrow("invalid_benchmark_arguments");
    }
  });

  it("keeps recommendations undecided until every human quality review is present", () => {
    expect(calculateBenchmarkDecision({
      largeV3Ms: 200,
      turboMs: 90,
      fullMs: 100,
      fastMs: 65,
      review: { names: "unreviewed", numbers: "unreviewed", decisions: "unreviewed" },
    })).toMatchObject({
      turboSpeedup: 200 / 90,
      turboMeets2x: true,
      fastReduction: 0.35,
      fastMeets30Percent: true,
      recommendation: "undecided",
    });
    expect(calculateBenchmarkDecision({
      largeV3Ms: 200,
      turboMs: 90,
      fullMs: 100,
      fastMs: 65,
      review: { names: "pass", numbers: "pass", decisions: "pass" },
    }).recommendation).toBe("candidate");
    expect(calculateBenchmarkDecision({
      largeV3Ms: 200,
      turboMs: 90,
      fullMs: 100,
      fastMs: 65,
      review: { names: "pass", numbers: "fail", decisions: "pass" },
    }).recommendation).toBe("rejected");
  });

  it("uses only isolated snapshot cwd/process targets and leaves the source meeting unchanged", async () => {
    const source = await syntheticRepository();
    const runtimeRoot = join(source.repositoryRoot, "runtime-for-test");
    const sourceBefore = new Map();
    for (const name of await readdir(source.meetingRoot)) {
      sourceBefore.set(name, await readFile(join(source.meetingRoot, name)));
    }
    const calls = [];
    const safeLogs = [];
    let clock = 1_000;

    const result = await runPipelineBenchmark({
      meetingId: source.meetingId,
      repositoryRoot: source.repositoryRoot,
      runtimeRoot,
      dependencies: {
        now: () => {
          clock += 100;
          return clock;
        },
        randomId: () => "run-fixed",
        log: (message) => safeLogs.push(message),
        runProcess: async (request) => {
          calls.push(request);
          expect(resolve(request.cwd).startsWith(resolve(runtimeRoot))).toBe(true);
          expect(request.env.AI_NOTE_BENCHMARK).toBe("1");
          if (request.args.some((arg) => arg.endsWith("benchmark.py"))) {
            const outputDir = request.args[request.args.indexOf("--output-dir") + 1];
            const model = request.args[request.args.indexOf("--model") + 1];
            await mkdir(outputDir, { recursive: true });
            const modelRaw = `${model} synthetic transcription\n`;
            await writeFile(join(outputDir, "raw.md"), modelRaw);
            await writeFile(join(outputDir, "segments.json"), "[]\n");
            await writeFile(join(outputDir, "metrics.json"), `${JSON.stringify({
              model,
              wallTimeMs: model === "large-v3" ? 200 : 90,
              rawSha256: sha256(modelRaw),
              segmentsSha256: sha256("[]\n"),
            })}\n`);
          } else {
            const mode = JSON.parse(await readFile(
              join(request.cwd, "input", "mode.json"),
              "utf8",
            )).mode;
            const transcript = `${mode} corrected synthetic transcript\n`;
            await writeFile(join(request.cwd, "output", "transcript.md"), transcript);
          }
          return { code: 0, stdout: "safe child status", stderr: "" };
        },
      },
    });

    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => (
      call.args.some((arg) => arg.endsWith("benchmark.py"))
    ))).toHaveLength(2);
    expect(calls.filter((call) => (
      call.args.some((arg) => arg.endsWith("benchmark-correction-runner.cjs"))
    ))).toHaveLength(2);
    expect(calls.some((call) => (
      call.args.some((arg) => arg.endsWith("meeting-summarize.mjs"))
    ))).toBe(false);
    expect((await stat(result.runDirectory)).mode & 0o777).toBe(0o700);
    expect(result.report.recommendation).toBe("undecided");
    expect(await readFile(join(result.runDirectory, "review.md"), "utf8"))
      .toContain("- [ ] 중요 이름");

    expect(await readdir(source.meetingRoot)).toEqual([...sourceBefore.keys()]);
    for (const [name, bytes] of sourceBefore) {
      expect(await readFile(join(source.meetingRoot, name))).toEqual(bytes);
    }
    expect(JSON.stringify(safeLogs)).not.toContain(source.raw.trim());
    expect(safeLogs).toEqual([
      `benchmark started: ${basename(result.runDirectory)}`,
      `benchmark completed: ${basename(result.runDirectory)}`,
    ]);
  });

  it("rejects a symlinked source record without creating a run", async () => {
    const source = await syntheticRepository();
    const runtimeRoot = join(source.repositoryRoot, "runtime-for-test");
    await chmod(source.meetingRoot, 0o700);
    await rm(join(source.meetingRoot, "raw.md"));
    const { symlink } = await import("node:fs/promises");
    await symlink(join(source.repositoryRoot, "glossary.json"), join(source.meetingRoot, "raw.md"));

    await expect(runPipelineBenchmark({
      meetingId: source.meetingId,
      repositoryRoot: source.repositoryRoot,
      runtimeRoot,
      dependencies: {
        now: () => 1,
        randomId: () => "unsafe",
        log: () => {},
        runProcess: async () => {
          throw new Error("process must not start");
        },
      },
    })).rejects.toThrow("unsafe_benchmark_source");
    await expect(readdir(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the isolated correction worker with the offline fake adapter and no app writers", async () => {
    const source = await syntheticRepository();
    const runtimeRoot = join(source.repositoryRoot, "runtime-worker-test");

    const result = await runPipelineBenchmark({
      meetingId: source.meetingId,
      repositoryRoot: source.repositoryRoot,
      codeRoot: PROJECT_ROOT,
      runtimeRoot,
      dependencies: {
        now: (() => {
          let value = 10_000;
          return () => ++value;
        })(),
        randomId: () => "worker",
        log: () => {},
        runProcess: async (request) => {
          if (request.args.some((arg) => arg.endsWith("benchmark.py"))) {
            const outputDir = request.args[request.args.indexOf("--output-dir") + 1];
            const model = request.args[request.args.indexOf("--model") + 1];
            await mkdir(outputDir, { recursive: true });
            await writeFile(join(outputDir, "raw.md"), "synthetic\n");
            await writeFile(join(outputDir, "segments.json"), "[]\n");
            await writeFile(join(outputDir, "metrics.json"), `${JSON.stringify({
              model,
              wallTimeMs: 10,
              rawSha256: sha256("synthetic\n"),
              segmentsSha256: sha256("[]\n"),
            })}\n`);
            return { code: 0, stdout: "", stderr: "" };
          }
          return new Promise((resolveProcess, reject) => {
            const child = spawn(request.command, request.args, {
              cwd: request.cwd,
              env: { ...request.env, FAKE_LLM: "1" },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
            child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
            child.on("error", reject);
            child.on("exit", (code) => resolveProcess({ code, stdout, stderr }));
          });
        },
      },
    });

    expect(result.report.stages.correction.full.transcriptSha256).toBe(
      sha256(source.raw.trim()),
    );
    expect(result.report.stages.correction.fast.transcriptSha256).toBe(
      sha256(source.raw),
    );
    for (const mode of ["full", "fast"]) {
      const caseRoot = join(result.runDirectory, "correction", mode);
      expect((await readdir(caseRoot)).sort()).toEqual(["input", "output"]);
      expect(await readFile(join(caseRoot, "output", "transcript.md"), "utf8"))
        .toBe(mode === "full" ? source.raw.trim() : source.raw);
    }
  });
});
