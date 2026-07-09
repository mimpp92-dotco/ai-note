// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as glossaryGET, POST as glossaryPOST } from "@/app/api/glossary/route";
import { GET as exportGET } from "@/app/api/meetings/[id]/export/route";
import { POST as finalizePOST } from "@/app/api/meetings/[id]/finalize/route";
import { DELETE as deleteMeeting, GET as getMeeting } from "@/app/api/meetings/[id]/route";
import { POST as reviewPOST } from "@/app/api/meetings/[id]/review/route";
import { POST as titlePOST } from "@/app/api/meetings/[id]/title/route";
import { GET as listMeetings } from "@/app/api/meetings/route";
import { POST as transcribePOST } from "@/app/api/transcribe/route";
import { GET as whisperHealth } from "@/app/api/whisper/health/route";
import { meetingPaths } from "@/lib/paths";
import { initialStatus, writeStatus } from "@/lib/status";

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

const INIT = {
  startedAt: "2026-07-05T13:30:00.000Z",
  endedAt: "2026-07-05T14:00:00.000Z",
  durationMs: 1_800_000,
  audioMime: "audio/webm;codecs=opus",
};

// Seed a meeting whose status.json lags at "transcribed" while summary.json exists
// (the shape a manual /meeting-summarize leaves) → derived state is "summarized".
async function seedSummarized(id: string) {
  const p = meetingPaths(id);
  mkdirSync(p.dir, { recursive: true });
  await writeStatus(id, { ...initialStatus(id, INIT), status: "transcribed" });
  writeFileSync(p.transcript, "교정된 전사\n");
  writeFileSync(p.summary, readFileSync(join(originalCwd, "fixtures", "summary.happy.json"), "utf-8"));
}

const titleReq = (id: string, body: unknown) =>
  new Request(`http://t/api/meetings/${id}/title`, { method: "POST", body: JSON.stringify(body) });
const deleteReq = (id: string) => new Request(`http://t/api/meetings/${id}`, { method: "DELETE" });

describe("title edit / delete / export overlay", () => {
  it("POST title on a summarized meeting sets titleOverride and it survives re-derive", async () => {
    const id = "m-title-ok";
    await seedSummarized(id);
    const res = await titlePOST(titleReq(id, { title: "내가 고친 제목" }), ctx(id));
    expect(res.status).toBe(200);

    const got = await (await getMeeting(new Request(`http://t/api/meetings/${id}`), ctx(id))).json();
    expect(got.title).toBe("내가 고친 제목"); // not re-promoted from summary.title
    expect(got.titleOverride).toBe("내가 고친 제목");
    expect(got.status).toBe("summarized");
  });

  it("POST title on a not-yet-summarized meeting returns 409", async () => {
    const id = "m-title-409";
    const p = meetingPaths(id);
    mkdirSync(p.dir, { recursive: true });
    await writeStatus(id, { ...initialStatus(id, INIT), status: "transcribed" });
    writeFileSync(p.raw, "raw only, no summary\n"); // transcribed, NOT summarized
    const res = await titlePOST(titleReq(id, { title: "x" }), ctx(id));
    expect(res.status).toBe(409);
  });

  it("POST title rejects an empty/whitespace title (400) and a bad id (400)", async () => {
    const id = "m-title-bad";
    await seedSummarized(id);
    expect((await titlePOST(titleReq(id, { title: "   " }), ctx(id))).status).toBe(400);
    expect((await titlePOST(titleReq("x", { title: "x" }), ctx("../escape"))).status).toBe(400);
  });

  it("export md reflects titleOverride while json stays the raw summary contract", async () => {
    const id = "m-export";
    await seedSummarized(id);
    await titlePOST(titleReq(id, { title: "내보내기 제목" }), ctx(id));

    const md = await (await exportGET(new Request(`http://t/api/meetings/${id}/export?fmt=md`), ctx(id))).text();
    expect(md).toContain("# 내보내기 제목");

    const jsonText = await (await exportGET(new Request(`http://t/api/meetings/${id}/export?fmt=json`), ctx(id))).text();
    expect(JSON.parse(jsonText).title).toBe("데일리 스크럼 2026-07-05"); // raw summary.title, not overridden
  });

  it("export md uses summary.title (not the stale auto title) when there is no titleOverride", async () => {
    const id = "m-export-nooverride";
    await seedSummarized(id); // status.title stays the auto placeholder; no titleOverride
    const md = await (await exportGET(new Request(`http://t/api/meetings/${id}/export?fmt=md`), ctx(id))).text();
    expect(md).toContain("# 데일리 스크럼 2026-07-05"); // the AI title shown in the UI
    expect(md).not.toMatch(/^# 회의 /m); // never the "회의 YYYY-MM-DD HH:MM" placeholder
  });

  it("DELETE removes the folder (200), is idempotent (404), and 400s a bad id", async () => {
    const id = "m-delete";
    await seedSummarized(id);
    const p = meetingPaths(id);
    expect(existsSync(p.dir)).toBe(true);

    expect((await deleteMeeting(deleteReq(id), ctx(id))).status).toBe(200);
    expect(existsSync(p.dir)).toBe(false);
    expect((await deleteMeeting(deleteReq(id), ctx(id))).status).toBe(404);
    expect((await deleteMeeting(deleteReq("x"), ctx("../escape"))).status).toBe(400);
  });

  it("DELETE is refused with 409 while a summarize is in-flight", async () => {
    const id = "m-delete-inflight";
    await seedSummarized(id);
    const g = globalThis as typeof globalThis & { __aiNoteSummarizeInflight?: Set<string> };
    (g.__aiNoteSummarizeInflight ??= new Set<string>()).add(id);
    try {
      const res = await deleteMeeting(deleteReq(id), ctx(id));
      expect(res.status).toBe(409);
      expect(existsSync(meetingPaths(id).dir)).toBe(true); // not removed
    } finally {
      g.__aiNoteSummarizeInflight?.delete(id); // don't leak the lock into later tests
    }
  });
});

describe("glossary route", () => {
  it("POST normalizes and GET round-trips the {terms, corrections} object", async () => {
    const post = await glossaryPOST(
      new Request("http://t/api/glossary", {
        method: "POST",
        body: JSON.stringify({
          terms: ["  OKR ", "OKR", ""],
          corrections: [
            { from: " 김민중 ", to: "김민준" },
            { from: "x", to: "x" }, // no-op → dropped
          ],
        }),
      }),
    );
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ terms: ["OKR"], corrections: [{ from: "김민중", to: "김민준" }] });

    expect(await (await glossaryGET()).json()).toEqual({
      terms: ["OKR"],
      corrections: [{ from: "김민중", to: "김민준" }],
    });
  });

  it("rejects a non-object body with 400", async () => {
    const res = await glossaryPOST(
      new Request("http://t/api/glossary", { method: "POST", body: JSON.stringify("nope") }),
    );
    expect(res.status).toBe(400);
  });
});
