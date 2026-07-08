// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Hermetic contract test: boots the whisper service with FAKE_WHISPER=1 via pure
// `python3 whisper/server.py` (never `uv run`) — no venv, model, real audio, or network.
// Uses LOCAL_STT_PORT=0 for an ephemeral port to avoid collisions; the server prints
// the bound address so we can discover it.

const SERVER = join(process.cwd(), "whisper", "server.py");

let proc: ChildProcess;
let base: string;
let workDir: string;

function waitForListening(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start in ${timeoutMs}ms:\n${out}`)), timeoutMs);
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
      reject(new Error(`server exited early (code=${code})\n${out}`));
    });
  });
}

async function pollJob(jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/jobs/${jobId}`);
    const body = await res.json();
    if (body.status === "done") return body;
    if (body.status === "error") throw new Error(`job failed: ${body.error}`);
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("job did not finish in time");
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "whisper-contract-"));
  proc = spawn("python3", [SERVER], {
    env: { ...process.env, FAKE_WHISPER: "1", LOCAL_STT_HOST: "127.0.0.1", LOCAL_STT_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await waitForListening(proc, 15000);
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  proc?.kill("SIGKILL");
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("whisper FAKE_WHISPER contract", () => {
  it("GET /health returns 200 {ok, model, ready}", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(true);
    expect(typeof body.model).toBe("string");
  });

  it("POST /transcribe → 202 {jobId}, polls to done, writes raw.md + segments.json", async () => {
    const rawPath = join(workDir, "raw.md");
    const segmentsPath = join(workDir, "segments.json");

    const post = await fetch(`${base}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioPath: join(workDir, "audio.webm"), rawPath, segmentsPath }),
    });
    expect(post.status).toBe(202);
    const { jobId } = await post.json();
    expect(typeof jobId).toBe("string");
    expect(jobId.length).toBeGreaterThan(0);

    const done = await pollJob(jobId, 15000);
    expect(done.status).toBe("done");

    expect(existsSync(rawPath)).toBe(true);
    expect(existsSync(segmentsPath)).toBe(true);

    const segments = JSON.parse(readFileSync(segmentsPath, "utf-8"));
    expect(Array.isArray(segments)).toBe(true);
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(typeof seg.start).toBe("number");
      expect(typeof seg.end).toBe("number");
      expect(typeof seg.text).toBe("string");
    }

    // raw.md is segment-per-line: one non-empty line per segment.
    const lines = readFileSync(rawPath, "utf-8").trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(segments.length);
  });

  it("POST /transcribe without required paths → 400", async () => {
    const res = await fetch(`${base}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioPath: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /jobs/{unknown} → 404 error", async () => {
    const res = await fetch(`${base}/jobs/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("error");
  });
});
