// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
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
const DISPATCH_A = "20000000-0000-4000-8000-000000000001";
const DISPATCH_B = "20000000-0000-4000-8000-000000000002";

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
    await expect(ok.json()).resolves.toMatchObject({ ok: true, ready: true, model: "fake" });

    const rejected = await rawGetWithHost("localhost.evil");
    expect(rejected.status).toBe(403);
    expect(rejected.body).toMatchObject({ error: { code: "invalid_host" } });
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
      schemaVersion: 1,
      meetingId,
      dispatchId: DISPATCH_A,
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
});
