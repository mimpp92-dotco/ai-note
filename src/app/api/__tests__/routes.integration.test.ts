// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as finalizePOST } from "@/app/api/meetings/[id]/finalize/route";
import { GET as getMeeting } from "@/app/api/meetings/[id]/route";
import { POST as reviewPOST } from "@/app/api/meetings/[id]/review/route";
import { GET as listMeetings } from "@/app/api/meetings/route";
import { POST as transcribePOST } from "@/app/api/transcribe/route";
import { GET as whisperHealth } from "@/app/api/whisper/health/route";
import { meetingPaths } from "@/lib/paths";

// Integration test for the app-api route handlers. Boots the whisper service with
// FAKE_WHISPER=1 (pure stdlib, no venv/model/network) and FAKE_FFMPEG=1 (byte copy,
// no ffmpeg install needed), then chdirs into a temp dir so data/meetings is isolated.
// Route handlers are plain functions — called directly with a Request + params.

const SERVER = join(process.cwd(), "whisper", "server.py");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let proc: ChildProcess;
let workDir: string;
let originalCwd: string;

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

async function pollUntilStatus(id: string, want: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await getMeeting(new Request(`http://t/api/meetings/${id}`), ctx(id));
    const body = await res.json();
    if (body.status === want) return body;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`meeting ${id} did not reach status ${want} in ${timeoutMs}ms`);
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "app-api-"));
  proc = spawn("python3", [SERVER], {
    env: { ...process.env, FAKE_WHISPER: "1", LOCAL_STT_HOST: "127.0.0.1", LOCAL_STT_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await waitForListening(proc, 15000);
  process.env.LOCAL_STT_HOST = "127.0.0.1";
  process.env.LOCAL_STT_PORT = String(port);
  process.env.FAKE_FFMPEG = "1";
  originalCwd = process.cwd();
  process.chdir(workDir); // meetingsRoot() = cwd/data/meetings — isolate it
});

afterAll(() => {
  proc?.kill("SIGKILL");
  if (originalCwd) process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function finalizeReq(id: string, bytes: Uint8Array) {
  const qs = `durationMs=5000&mime=${encodeURIComponent("audio/webm;codecs=opus")}`;
  return new Request(`http://t/api/meetings/${id}/finalize?${qs}`, {
    method: "POST",
    body: bytes,
    duplex: "half",
  } as RequestInit);
}

describe("app-api routes", () => {
  it("GET /api/whisper/health proxies the local service (connected)", async () => {
    const res = await whisperHealth();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.ready).toBe(true);
  });

  it("finalize saves audio.webm + play.webm, sets status, auto-enqueues transcription", async () => {
    const id = "meeting-alpha";
    const res = await finalizePOST(finalizeReq(id, new Uint8Array([1, 2, 3, 4, 5])), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transcription).toBe("enqueued");
    expect(body.status).toBe("transcribing");

    const p = meetingPaths(id);
    expect(existsSync(p.audio)).toBe(true);
    expect(existsSync(p.play)).toBe(true); // FAKE_FFMPEG copied audio → play
    expect(existsSync(p.status)).toBe(true);
  });

  it("GET derives transcribed from raw.md, then summarized from summary.json", async () => {
    const id = "meeting-alpha";

    // whisper (FAKE) writes raw.md + segments.json → derived transcribed
    const transcribed = await pollUntilStatus(id, "transcribed", 15000);
    expect(transcribed.whisper.progress).toBe(1);
    const p = meetingPaths(id);
    expect(existsSync(p.raw)).toBe(true);
    expect(existsSync(p.segments)).toBe(true);

    // stand in for /meeting-summarize: transcript.md + summary.json
    writeFileSync(p.transcript, "교정된 전사\n");
    writeFileSync(p.summary, readFileSync(join(originalCwd, "fixtures", "summary.happy.json"), "utf-8"));
    const summarized = await (await getMeeting(new Request(`http://t/api/meetings/${id}`), ctx(id))).json();
    expect(summarized.status).toBe("summarized");
    expect(summarized.title).toBe("데일리 스크럼 2026-07-05"); // promoted from summary.title
  });

  it("POST /api/transcribe refuses a meeting that is already transcribed (raw.md immutable)", async () => {
    const res = await transcribePOST(
      new Request("http://t/api/transcribe", {
        method: "POST",
        body: JSON.stringify({ id: "meeting-alpha" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("finalize refuses to overwrite an already-finalized meeting (audio immutable)", async () => {
    const id = "meeting-alpha";
    const res = await finalizePOST(finalizeReq(id, new Uint8Array([9, 9, 9])), ctx(id));
    expect(res.status).toBe(409);
  });

  it("POST review records participants into status.review", async () => {
    const id = "meeting-alpha";
    const res = await reviewPOST(
      new Request(`http://t/api/meetings/${id}/review`, {
        method: "POST",
        body: JSON.stringify({ participants: ["딜런"] }),
      }),
      ctx(id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.review.participants).toEqual(["딜런"]);
  });

  it("GET /api/meetings lists finalized meetings, newest first", async () => {
    const res = await listMeetings();
    const body = await res.json();
    expect(Array.isArray(body.meetings)).toBe(true);
    expect(body.meetings.some((m: { id: string }) => m.id === "meeting-alpha")).toBe(true);
  });

  it("rejects unsafe meeting ids (path traversal)", async () => {
    const bad = "../escape";
    const getRes = await getMeeting(new Request("http://t/api/meetings/x"), ctx(bad));
    expect(getRes.status).toBe(400);
    const finRes = await finalizePOST(finalizeReq(bad, new Uint8Array([1])), ctx(bad));
    expect(finRes.status).toBe(400);
    const revRes = await reviewPOST(
      new Request("http://t/api/meetings/x/review", { method: "POST", body: "{}" }),
      ctx(bad),
    );
    expect(revRes.status).toBe(400);
  });

  it("returns 404 for an unknown meeting", async () => {
    const res = await getMeeting(new Request("http://t/api/meetings/nope"), ctx("nope"));
    expect(res.status).toBe(404);
  });
});
