// @vitest-environment node
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER = join(process.cwd(), "whisper", "server.py");
const BENCHMARK_HELPER = join(process.cwd(), "whisper", "benchmark.py");
const DISPATCH_A = "20000000-0000-4000-8000-000000000001";
const DISPATCH_B = "20000000-0000-4000-8000-000000000002";
const CATALOG = {
  "large-v3": {
    source: "catalog",
    id: "large-v3",
    mlxRepo: "mlx-community/whisper-large-v3-mlx",
    fasterWhisperModel: "large-v3",
  },
  "large-v3-turbo": {
    source: "catalog",
    id: "large-v3-turbo",
    mlxRepo: "mlx-community/whisper-large-v3-turbo",
    fasterWhisperModel: "large-v3-turbo",
  },
} as const;

let proc: ChildProcess;
let base: string;
let workDir: string;
let dataRoot: string;

function serviceFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-ai-note-service", "app-api-v1");
  return fetch(input, { ...init, headers });
}

function rawGetWithHost(host: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/health`, {
      headers: { host, "x-ai-note-service": "app-api-v1" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

function waitForListening(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start in ${timeoutMs}ms`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(/WHISPER_LISTENING http:\/\/[\d.]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code=${code})`));
    });
  });
}

function seedMeeting(id: string, audio = new Uint8Array([1, 2, 3])) {
  const dir = join(dataRoot, "meetings", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "audio.webm"), audio);
  return dir;
}

async function dispatch(meetingId: string, dispatchId: string, extra: Record<string, unknown> = {}) {
  return serviceFetch(`${base}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ meetingId, dispatchId, ...extra }),
  });
}

async function prepareModel(
  origin: string,
  model: "large-v3" | "large-v3-turbo",
  extra: Record<string, unknown> = {},
) {
  return serviceFetch(`${origin}/models/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, ...extra }),
  });
}

async function pollPreparation(
  origin: string,
  model: "large-v3" | "large-v3-turbo",
  want: "ready" | "error",
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await serviceFetch(`${origin}/health`);
    const body = await response.json() as {
      ready: boolean;
      modelPreparation: Array<{ model: string; status: string }>;
    };
    expect(body.ready).toBe(true);
    const state = body.modelPreparation.find((item) => item.model === model);
    if (state?.status === want) return body;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`model ${model} did not reach ${want}`);
}

function writePipelineSettings(
  root: string,
  model: "large-v3" | "large-v3-turbo",
  correction: "full" | "fast" = "full",
) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "pipeline-settings.json"), `${JSON.stringify({
    schemaVersion: 1,
    transcription: { model },
    correction: { mode: correction },
  })}\n`);
}

async function pollJob(meetingId: string, dispatchId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await serviceFetch(`${base}/jobs/${meetingId}/${dispatchId}`);
    const body = await res.json() as { status: string; error?: string };
    if (body.status === "done") return body;
    if (body.status === "error") throw new Error(`job failed: ${body.error}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("job did not finish in time");
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "whisper-contract-"));
  dataRoot = join(workDir, "data");
  mkdirSync(join(dataRoot, "meetings"), { recursive: true });
  proc = spawn("python3", [SERVER], {
    env: {
      ...process.env,
      AI_NOTE_DATA_ROOT: dataRoot,
      FAKE_WHISPER: "1",
      LOCAL_STT_HOST: "127.0.0.1",
      LOCAL_STT_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await waitForListening(proc, 15_000);
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  proc?.kill("SIGKILL");
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.sequential("whisper fixed-ID local service contract", () => {
  it("serves health only for the exact configured Host and emits no CORS", async () => {
    const ok = await serviceFetch(`${base}/health`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    await expect(ok.json()).resolves.toMatchObject({
      ok: true,
      ready: true,
      model: "fake",
      modelPreparation: [
        { model: "large-v3", status: "idle" },
        { model: "large-v3-turbo", status: "idle" },
      ],
    });

    const rejected = await rawGetWithHost("localhost.evil");
    expect(rejected.status).toBe(403);
    expect(rejected.body).toMatchObject({ error: { code: "invalid_host" } });
  });

  it("uses an exact fixed catalog for both MLX and faster-whisper identities", () => {
    const probe = spawnSync("python3", ["-c", [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(join(process.cwd(), "whisper"))})`,
      "import model_catalog",
      "print(json.dumps(model_catalog.MODEL_CATALOG, sort_keys=True))",
    ].join(";")], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      "large-v3": {
        id: "large-v3",
        mlxRepo: "mlx-community/whisper-large-v3-mlx",
        fasterWhisperModel: "large-v3",
        source: "catalog",
      },
      "large-v3-turbo": {
        id: "large-v3-turbo",
        mlxRepo: "mlx-community/whisper-large-v3-turbo",
        fasterWhisperModel: "large-v3-turbo",
        source: "catalog",
      },
    });
  });

  it("starts explicit preparation asynchronously without changing service readiness", async () => {
    expect((await prepareModel(base, "large-v3", { repo: "arbitrary/repo" })).status).toBe(400);
    const accepted = await prepareModel(base, "large-v3");
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({
      model: "large-v3",
      status: "preparing",
    });
    const health = await pollPreparation(base, "large-v3", "ready");
    expect(health.modelPreparation).toContainEqual({
      model: "large-v3",
      status: "ready",
    });
  });

  it("rejects browser headers, wrong content type, unknown fields, and unsafe IDs", async () => {
    seedMeeting("ingress-meeting");
    const browser = await fetch(`${base}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ meetingId: "ingress-meeting", dispatchId: DISPATCH_A }),
    });
    expect(browser.status).toBe(403);

    const contentType = await serviceFetch(`${base}/transcribe`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ meetingId: "ingress-meeting", dispatchId: DISPATCH_A }),
    });
    expect(contentType.status).toBe(415);

    expect((await dispatch("ingress-meeting", DISPATCH_A, { audioPath: "/etc/passwd" })).status).toBe(400);
    expect((await dispatch("../escape", DISPATCH_A)).status).toBe(400);
    expect((await dispatch("ingress-meeting", "not-a-uuid")).status).toBe(400);
  });

  it("accepts IDs, writes durable claim, publishes segments then raw, and polls by pair", async () => {
    const meetingId = "meeting-fixed-protocol";
    const dir = seedMeeting(meetingId);
    const post = await dispatch(meetingId, DISPATCH_A);
    expect(post.status).toBe(202);
    await expect(post.json()).resolves.toMatchObject({ dispatchId: DISPATCH_A, status: "accepted" });

    await pollJob(meetingId, DISPATCH_A, 15_000);
    const rawPath = join(dir, "raw.md");
    const segmentsPath = join(dir, "segments.json");
    const claimPath = join(dir, ".whisper-dispatch.json");
    expect(existsSync(rawPath)).toBe(true);
    expect(existsSync(segmentsPath)).toBe(true);
    expect(existsSync(claimPath)).toBe(true);
    const claim = JSON.parse(readFileSync(claimPath, "utf8"));
    expect(claim).toMatchObject({
      schemaVersion: 2,
      meetingId,
      dispatchId: DISPATCH_A,
      model: CATALOG["large-v3"],
      phase: "raw_published",
    });
    expect(claim.audioSha256).toMatch(/^[a-f0-9]{64}$/);

    const segments = JSON.parse(readFileSync(segmentsPath, "utf8"));
    const lines = readFileSync(rawPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(segments.length);
  });

  it("asks a fresh proposal to adopt the canonical existing dispatch", async () => {
    const meetingId = "meeting-adopt";
    seedMeeting(meetingId);
    expect((await dispatch(meetingId, DISPATCH_A)).status).toBe(202);
    await pollJob(meetingId, DISPATCH_A, 15_000);

    const adopt = await dispatch(meetingId, DISPATCH_B);
    expect(adopt.status).toBe(409);
    await expect(adopt.json()).resolves.toEqual({
      error: { code: "adopt_existing_dispatch" },
      dispatchId: DISPATCH_A,
    });
    const resumed = await dispatch(meetingId, DISPATCH_A);
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({ status: "done", dispatchId: DISPATCH_A });
  });

  it("deduplicates concurrent same-pair requests and adopts a concurrent alternate proposal", async () => {
    const meetingId = "meeting-concurrent";
    seedMeeting(meetingId);
    const first = await dispatch(meetingId, DISPATCH_A);
    const [duplicate, alternate] = await Promise.all([
      dispatch(meetingId, DISPATCH_A),
      dispatch(meetingId, DISPATCH_B),
    ]);
    expect([200, 202]).toContain(first.status);
    expect([200, 202]).toContain(duplicate.status);
    expect(alternate.status).toBe(409);
    await expect(alternate.json()).resolves.toMatchObject({
      error: { code: "adopt_existing_dispatch" },
      dispatchId: DISPATCH_A,
    });
    await pollJob(meetingId, DISPATCH_A, 15_000);
    const claim = JSON.parse(readFileSync(join(dataRoot, "meetings", meetingId, ".whisper-dispatch.json"), "utf8"));
    expect(claim.dispatchId).toBe(DISPATCH_A);
  });

  it("fails closed when immutable audio identity no longer matches the claim", async () => {
    const meetingId = "meeting-audio-mismatch";
    const dir = seedMeeting(meetingId, new Uint8Array([1]));
    expect((await dispatch(meetingId, DISPATCH_A)).status).toBe(202);
    await pollJob(meetingId, DISPATCH_A, 15_000);
    writeFileSync(join(dir, "audio.webm"), new Uint8Array([9]));
    const response = await dispatch(meetingId, DISPATCH_B);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "audio_identity_mismatch" } });
  });

  it("treats raw-without-claim as immutable completed legacy data", async () => {
    const meetingId = "meeting-legacy-raw";
    const dir = seedMeeting(meetingId);
    writeFileSync(join(dir, "raw.md"), "legacy immutable\n");
    const response = await dispatch(meetingId, DISPATCH_A);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "done", legacy: true });
    expect(readFileSync(join(dir, "raw.md"), "utf8")).toBe("legacy immutable\n");
    expect(existsSync(join(dir, ".whisper-dispatch.json"))).toBe(false);
  });

  it("continues to resume a strict schema-v1 accepted claim", async () => {
    const meetingId = "meeting-schema-v1";
    const audio = new Uint8Array([4, 5, 6]);
    const dir = seedMeeting(meetingId, audio);
    writeFileSync(join(dir, ".whisper-dispatch.json"), `${JSON.stringify({
      schemaVersion: 1,
      meetingId,
      dispatchId: DISPATCH_A,
      audioSha256: createHash("sha256").update(audio).digest("hex"),
      phase: "accepted",
      durability: "durable",
    })}\n`);

    expect((await dispatch(meetingId, DISPATCH_A)).status).toBe(202);
    await pollJob(meetingId, DISPATCH_A, 15_000);
    const claim = JSON.parse(readFileSync(join(dir, ".whisper-dispatch.json"), "utf8"));
    expect(claim.schemaVersion).toBe(1);
    expect(claim).not.toHaveProperty("model");
    expect(claim.phase).toBe("raw_published");
  });

  it("fails closed on a contradictory legacy schema-v2 model snapshot", async () => {
    const meetingId = "meeting-invalid-legacy-v2";
    const audio = new Uint8Array([7, 8, 9]);
    const dir = seedMeeting(meetingId, audio);
    writeFileSync(join(dir, ".whisper-dispatch.json"), `${JSON.stringify({
      schemaVersion: 2,
      meetingId,
      dispatchId: DISPATCH_A,
      audioSha256: createHash("sha256").update(audio).digest("hex"),
      model: {
        source: "legacy",
        id: "base",
        mlxRepo: "legacy/model-repo",
        fasterWhisperModel: "small",
      },
      phase: "accepted",
      durability: "durable",
    })}\n`);

    const response = await dispatch(meetingId, DISPATCH_A);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_service_state" },
    });
    expect(existsSync(join(dir, "segments.json"))).toBe(false);
    expect(existsSync(join(dir, "raw.md"))).toBe(false);
  });

  it("rejects symlink meeting records without following them", async () => {
    const outside = join(workDir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "audio.webm"), "outside");
    symlinkSync(outside, join(dataRoot, "meetings", "meeting-symlink"));
    const response = await dispatch("meeting-symlink", DISPATCH_A);
    expect(response.status).toBe(400);
    expect(existsSync(join(outside, "raw.md"))).toBe(false);
  });
});

describe("whisper global model execution fence", () => {
  it("serializes prepare and inference through the same bounded fence", () => {
    const probe = spawnSync("python3", ["-c", `
import json
import os
import sys
import threading
import time
sys.path.insert(0, ${JSON.stringify(join(process.cwd(), "whisper"))})
os.environ["FAKE_WHISPER"] = "1"
import model_catalog
import server
active = 0
maximum = 0
guard = threading.Lock()
def work(*_args):
    global active, maximum
    with guard:
        active += 1
        maximum = max(maximum, active)
    time.sleep(0.1)
    with guard:
        active -= 1
    return []
server._prepare_model_unlocked = work
server._transcribe_unlocked = work
snapshot = model_catalog.snapshot_for_catalog_model("large-v3")
threads = [
    threading.Thread(target=server._prepare_model, args=(snapshot,)),
    threading.Thread(target=server.transcribe, args=("fake.webm", snapshot)),
]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
print(json.dumps({"maximum": maximum}))
`], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({ maximum: 1 });
  });
});

async function bootIsolatedServer(
  isolatedDataRoot: string,
  extraEnv: Record<string, string> = {},
): Promise<{ process: ChildProcess; origin: string }> {
  const process = spawn("python3", [SERVER], {
    env: {
      ...globalThis.process.env,
      AI_NOTE_DATA_ROOT: isolatedDataRoot,
      FAKE_WHISPER: "1",
      LOCAL_STT_HOST: "127.0.0.1",
      LOCAL_STT_PORT: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await waitForListening(process, 15_000);
  return { process, origin: `http://127.0.0.1:${port}` };
}

function isolatedDispatch(origin: string, meetingId: string, dispatchId: string) {
  return serviceFetch(`${origin}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ meetingId, dispatchId }),
  });
}

async function isolatedPoll(origin: string, meetingId: string, dispatchId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await serviceFetch(`${origin}/jobs/${meetingId}/${dispatchId}`);
    const body = await response.json() as { status: string };
    if (body.status === "done") return;
    if (body.status === "error") throw new Error("isolated job failed");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("isolated job timed out");
}

describe.sequential("whisper claim durability and restart", () => {
  it("does not launch model work while parent sync is transiently pending, then resumes same claim", async () => {
    const isolatedRoot = join(workDir, "pending-data");
    const meetingId = "meeting-pending";
    const dir = join(isolatedRoot, "meetings", meetingId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "audio.webm"), "audio");
    const server = await bootIsolatedServer(isolatedRoot, { WHISPER_TEST_DIRSYNC_MODE: "pending_once" });
    try {
      const pending = await isolatedDispatch(server.origin, meetingId, DISPATCH_A);
      expect(pending.status).toBe(503);
      expect(existsSync(join(dir, ".whisper-dispatch.json"))).toBe(true);
      expect(existsSync(join(dir, "segments.json"))).toBe(false);
      expect(existsSync(join(dir, "raw.md"))).toBe(false);

      const retry = await isolatedDispatch(server.origin, meetingId, DISPATCH_A);
      expect(retry.status).toBe(202);
      await isolatedPoll(server.origin, meetingId, DISPATCH_A);
      expect(existsSync(join(dir, "raw.md"))).toBe(true);
    } finally {
      server.process.kill("SIGKILL");
    }
  });

  it("continues in explicit best-effort mode when directory sync is known unsupported", async () => {
    const isolatedRoot = join(workDir, "unsupported-data");
    const meetingId = "meeting-unsupported";
    const dir = join(isolatedRoot, "meetings", meetingId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "audio.webm"), "audio");
    const server = await bootIsolatedServer(isolatedRoot, { WHISPER_TEST_DIRSYNC_MODE: "unsupported" });
    try {
      expect((await isolatedDispatch(server.origin, meetingId, DISPATCH_A)).status).toBe(202);
      await isolatedPoll(server.origin, meetingId, DISPATCH_A);
      expect(existsSync(join(dir, "raw.md"))).toBe(true);
    } finally {
      server.process.kill("SIGKILL");
    }
  });

  it("reads the durable claim after process restart without overwriting completed outputs", async () => {
    const isolatedRoot = join(workDir, "restart-data");
    const meetingId = "meeting-restart";
    const dir = join(isolatedRoot, "meetings", meetingId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "audio.webm"), "audio");
    const first = await bootIsolatedServer(isolatedRoot);
    expect((await isolatedDispatch(first.origin, meetingId, DISPATCH_A)).status).toBe(202);
    await isolatedPoll(first.origin, meetingId, DISPATCH_A);
    const rawBefore = readFileSync(join(dir, "raw.md"), "utf8");
    first.process.kill("SIGKILL");

    const restarted = await bootIsolatedServer(isolatedRoot);
    try {
      const same = await isolatedDispatch(restarted.origin, meetingId, DISPATCH_A);
      expect(same.status).toBe(200);
      const fresh = await isolatedDispatch(restarted.origin, meetingId, DISPATCH_B);
      expect(fresh.status).toBe(409);
      expect(readFileSync(join(dir, "raw.md"), "utf8")).toBe(rawBefore);
    } finally {
      restarted.process.kill("SIGKILL");
    }
  });

  it("snapshots the stored catalog model per accepted dispatch and ignores later setting changes", async () => {
    const isolatedRoot = join(workDir, "model-snapshot-data");
    writePipelineSettings(isolatedRoot, "large-v3-turbo", "fast");
    const firstId = "meeting-model-turbo";
    const secondId = "meeting-model-quality";
    const firstDir = join(isolatedRoot, "meetings", firstId);
    const secondDir = join(isolatedRoot, "meetings", secondId);
    mkdirSync(firstDir, { recursive: true });
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(join(firstDir, "audio.webm"), "first");
    writeFileSync(join(secondDir, "audio.webm"), "second");
    const server = await bootIsolatedServer(isolatedRoot, {
      LOCAL_STT_MODEL: "base",
      LOCAL_STT_MLX_REPO: "legacy/private-repo",
    });
    try {
      expect((await isolatedDispatch(server.origin, firstId, DISPATCH_A)).status).toBe(202);
      await isolatedPoll(server.origin, firstId, DISPATCH_A);
      expect(JSON.parse(readFileSync(
        join(firstDir, ".whisper-dispatch.json"),
        "utf8",
      )).model).toEqual(CATALOG["large-v3-turbo"]);

      writePipelineSettings(isolatedRoot, "large-v3");
      expect((await isolatedDispatch(server.origin, firstId, DISPATCH_A)).status).toBe(200);
      expect(JSON.parse(readFileSync(
        join(firstDir, ".whisper-dispatch.json"),
        "utf8",
      )).model).toEqual(CATALOG["large-v3-turbo"]);

      expect((await isolatedDispatch(server.origin, secondId, DISPATCH_B)).status).toBe(202);
      await isolatedPoll(server.origin, secondId, DISPATCH_B);
      expect(JSON.parse(readFileSync(
        join(secondDir, ".whisper-dispatch.json"),
        "utf8",
      )).model).toEqual(CATALOG["large-v3"]);
    } finally {
      server.process.kill("SIGKILL");
    }
  });

  it("uses legacy startup model and MLX repo only while pipeline settings are absent", async () => {
    const isolatedRoot = join(workDir, "legacy-model-data");
    const meetingId = "meeting-legacy-model";
    const dir = join(isolatedRoot, "meetings", meetingId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "audio.webm"), "audio");
    const server = await bootIsolatedServer(isolatedRoot, {
      LOCAL_STT_MODEL: "base",
      LOCAL_STT_MLX_REPO: "legacy/model-repo",
    });
    try {
      expect((await isolatedDispatch(server.origin, meetingId, DISPATCH_A)).status).toBe(202);
      await isolatedPoll(server.origin, meetingId, DISPATCH_A);
      expect(JSON.parse(readFileSync(join(dir, ".whisper-dispatch.json"), "utf8")).model)
        .toEqual({
          source: "legacy",
          id: "base",
          mlxRepo: "legacy/model-repo",
          fasterWhisperModel: "base",
        });
    } finally {
      server.process.kill("SIGKILL");
    }
  });

  it("does not advance a failed model claim and lets another model dispatch finish", async () => {
    const isolatedRoot = join(workDir, "model-failure-data");
    writePipelineSettings(isolatedRoot, "large-v3-turbo");
    const failedId = "meeting-model-failed";
    const healthyId = "meeting-model-healthy";
    const failedDir = join(isolatedRoot, "meetings", failedId);
    const healthyDir = join(isolatedRoot, "meetings", healthyId);
    mkdirSync(failedDir, { recursive: true });
    mkdirSync(healthyDir, { recursive: true });
    writeFileSync(join(failedDir, "audio.webm"), "failed");
    writeFileSync(join(healthyDir, "audio.webm"), "healthy");
    const server = await bootIsolatedServer(isolatedRoot, {
      WHISPER_TEST_FAIL_MODEL: "large-v3-turbo",
    });
    try {
      expect((await isolatedDispatch(server.origin, failedId, DISPATCH_A)).status).toBe(202);
      await expect(isolatedPoll(server.origin, failedId, DISPATCH_A)).rejects.toThrow(
        "isolated job failed",
      );
      const failedClaim = JSON.parse(readFileSync(
        join(failedDir, ".whisper-dispatch.json"),
        "utf8",
      ));
      expect(failedClaim.phase).toBe("accepted");
      expect(existsSync(join(failedDir, "segments.json"))).toBe(false);
      expect(existsSync(join(failedDir, "raw.md"))).toBe(false);

      writePipelineSettings(isolatedRoot, "large-v3");
      expect((await isolatedDispatch(server.origin, healthyId, DISPATCH_B)).status).toBe(202);
      await isolatedPoll(server.origin, healthyId, DISPATCH_B);
      expect(existsSync(join(healthyDir, "raw.md"))).toBe(true);
    } finally {
      server.process.kill("SIGKILL");
    }
  });

  it("reports prepare failures with a bounded status and no raw provider details", async () => {
    const isolatedRoot = join(workDir, "prepare-failure-data");
    mkdirSync(join(isolatedRoot, "meetings"), { recursive: true });
    const server = await bootIsolatedServer(isolatedRoot, {
      WHISPER_TEST_FAIL_PREPARE_MODEL: "large-v3-turbo",
      WHISPER_TEST_PRIVATE_ERROR: "/Users/private/model-cache token@example.com",
    });
    try {
      expect((await prepareModel(server.origin, "large-v3-turbo")).status).toBe(202);
      const health = await pollPreparation(server.origin, "large-v3-turbo", "error");
      const serialized = JSON.stringify(health);
      expect(serialized).toContain('"status":"error"');
      expect(serialized).not.toMatch(/Users|token@example|model-cache/u);
    } finally {
      server.process.kill("SIGKILL");
    }
  });
});

describe("isolated whisper benchmark helper", () => {
  it("uses the fixed catalog and writes fake outputs only below the explicit output fence", () => {
    const root = join(workDir, "benchmark-helper");
    const output = join(root, "runs", "large-v3-turbo");
    const audio = join(root, "audio.webm");
    mkdirSync(root, { recursive: true });
    writeFileSync(audio, "synthetic audio placeholder");

    const run = spawnSync("python3", [
      BENCHMARK_HELPER,
      "--audio",
      audio,
      "--output-dir",
      output,
      "--allowed-root",
      join(root, "runs"),
      "--model",
      "large-v3-turbo",
      "--fake",
    ], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "completed",
      model: "large-v3-turbo",
    });
    expect(readFileSync(audio, "utf8")).toBe("synthetic audio placeholder");
    expect(readFileSync(join(output, "raw.md"), "utf8")).toContain(
      "합성 벤치마크 전사",
    );
    expect(JSON.parse(readFileSync(join(output, "segments.json"), "utf8")))
      .toEqual(expect.any(Array));
    expect(JSON.parse(readFileSync(join(output, "metrics.json"), "utf8")))
      .toMatchObject({
        model: "large-v3-turbo",
        rawSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        segmentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
  });

  it("rejects unknown models and output directories outside the explicit fence", () => {
    const root = join(workDir, "benchmark-helper-fence");
    const audio = join(root, "audio.webm");
    mkdirSync(root, { recursive: true });
    writeFileSync(audio, "synthetic audio placeholder");

    for (const args of [
      [
        "--audio", audio,
        "--output-dir", join(root, "outside"),
        "--allowed-root", join(root, "runs"),
        "--model", "large-v3",
        "--fake",
      ],
      [
        "--audio", audio,
        "--output-dir", join(root, "runs", "unknown"),
        "--allowed-root", join(root, "runs"),
        "--model", "small",
        "--fake",
      ],
    ]) {
      const run = spawnSync("python3", [BENCHMARK_HELPER, ...args], {
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      expect(run.status).not.toBe(0);
      expect(run.stdout).not.toContain("synthetic audio placeholder");
    }
    expect(existsSync(join(root, "outside", "raw.md"))).toBe(false);
  });
});
