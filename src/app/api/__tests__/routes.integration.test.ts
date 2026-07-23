// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET as glossaryGET, POST as glossaryPOST } from "@/app/api/glossary/route";
import { GET as audioGET } from "@/app/api/meetings/[id]/audio/route";
import { GET as contentGET } from "@/app/api/meetings/[id]/content/route";
import { GET as exportGET } from "@/app/api/meetings/[id]/export/route";
import { POST as finalizePOST } from "@/app/api/meetings/[id]/finalize/route";
import { DELETE as deleteMeeting, GET as getMeeting } from "@/app/api/meetings/[id]/route";
import { POST as reviewPOST } from "@/app/api/meetings/[id]/review/route";
import { POST as summarizePOST } from "@/app/api/meetings/[id]/summarize/route";
import { PATCH as summaryPATCH } from "@/app/api/meetings/[id]/summary/route";
import { POST as titlePOST } from "@/app/api/meetings/[id]/title/route";
import { PATCH as transcriptPATCH } from "@/app/api/meetings/[id]/transcript/route";
import { POST as transcriptRegeneratePOST } from "@/app/api/meetings/[id]/transcript/regenerate/route";
import { GET as listMeetings } from "@/app/api/meetings/route";
import { GET as llmHealthGET } from "@/app/api/settings/llm/health/route";
import { POST as llmSettingsPOST } from "@/app/api/settings/llm/route";
import { POST as transcribePOST } from "@/app/api/transcribe/route";
import { POST as globalSummarizePOST } from "@/app/api/summarize/route";
import { GET as whisperHealth } from "@/app/api/whisper/health/route";
import { meetingPaths } from "@/lib/paths";
import { acquireArtifactWriteLease } from "@/lib/artifactLease";
import { acquireMeetingOperation } from "@/lib/meetingLifecycle";
import { settingsPath, writeSettings } from "@/lib/settings";
import { initialStatus, writeStatus } from "@/lib/status";
import { isSummarizeInflight } from "@/lib/summarize";
import { FakeAdapter } from "@/services/llm/fake";

// Integration test for the app-api route handlers. Boots the whisper service with
// FAKE_WHISPER=1 (pure stdlib, no venv/model/network) and FAKE_FFMPEG=1 (byte copy,
// no ffmpeg install needed), then chdirs into a temp dir so data/meetings is isolated.
// Route handlers are plain functions — called directly with a Request + params.

const SERVER = join(process.cwd(), "whisper", "server.py");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const APP_ORIGIN = "http://127.0.0.1:3000";

function appRequest(input: string, init: RequestInit = {}): Request {
  const url = input.startsWith("http://t")
    ? `${APP_ORIGIN}${input.slice("http://t".length)}`
    : new URL(input, APP_ORIGIN).toString();
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1:3000");
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") headers.set("origin", APP_ORIGIN);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set(
      "content-type",
      url.includes("/finalize") ? "audio/webm;codecs=opus" : "application/json",
    );
  }
  return new Request(url, { ...init, headers });
}

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
    const res = await getMeeting(appRequest(`http://t/api/meetings/${id}`), ctx(id));
    const body = await res.json();
    if (body.status === want) return body;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`meeting ${id} did not reach status ${want} in ${timeoutMs}ms`);
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "app-api-"));
  proc = spawn("python3", [SERVER], {
    env: {
      ...process.env,
      AI_NOTE_DATA_ROOT: join(workDir, "data"),
      FAKE_WHISPER: "1",
      LOCAL_STT_HOST: "127.0.0.1",
      LOCAL_STT_PORT: "0",
    },
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
  return appRequest(`http://t/api/meetings/${id}/finalize?${qs}`, {
    method: "POST",
    body: bytes,
    duplex: "half",
  } as RequestInit);
}

function seedAudio(id: string, bytes: Uint8Array, target: "play" | "audio" = "play") {
  const paths = meetingPaths(id);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths[target], bytes);
}

async function expectAudioLeaseReleased(id: string) {
  const operation = await acquireMeetingOperation(id, "delete");
  try {
    const lease = await acquireArtifactWriteLease(id, operation.ownerToken);
    lease.release();
  } finally {
    operation.release();
  }
}

describe("app-api routes", () => {
  it("GET /api/whisper/health proxies the local service (connected)", async () => {
    const res = await whisperHealth(appRequest("/api/whisper/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.ready).toBe(true);
  });

  it("POST /api/settings/llm rejects Ollama without a model", async () => {
    const res = await llmSettingsPOST(
      appRequest("http://t/api/settings/llm", {
        method: "POST",
        body: JSON.stringify({ provider: "ollama" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET /api/settings/llm/health returns provider and model without baseUrl", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli", model: "sonnet", baseUrl: "http://should-not-leak" });
    try {
      const res = await llmHealthGET(appRequest("/api/settings/llm/health"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        configured: true,
        provider: "claude-cli",
        model: "sonnet",
        ok: true,
        detail: "FAKE_LLM",
      });
      expect(JSON.stringify(body)).not.toContain("should-not-leak");
    } finally {
      delete process.env.FAKE_LLM;
    }
  });

  it("GET /api/settings/llm/health treats legacy Ollama settings without model as unavailable", async () => {
    await writeSettings({ provider: "ollama" });
    const res = await llmHealthGET(appRequest("/api/settings/llm/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      configured: true,
      provider: "ollama",
      ok: false,
      detail: "Ollama model not set",
    });
  });

  it("finalize saves audio.webm + play.webm, sets status, auto-enqueues transcription", async () => {
    const id = "meeting-alpha";
    const res = await finalizePOST(finalizeReq(id, new Uint8Array([1, 2, 3, 4, 5])), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transcription).toBe("accepted");
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
    expect(JSON.stringify(transcribed)).not.toContain("jobId");
    expect(JSON.stringify(transcribed)).not.toContain("/data/meetings");
    expect(JSON.stringify(transcribed)).not.toContain("summarizeAttempts");
    const p = meetingPaths(id);
    expect(existsSync(p.raw)).toBe(true);
    expect(existsSync(p.segments)).toBe(true);

    // stand in for /meeting-summarize: transcript.md + summary.json
    writeFileSync(p.transcript, "교정된 전사\n");
    writeFileSync(p.summary, readFileSync(join(originalCwd, "fixtures", "summary.happy.json"), "utf-8"));
    const summarized = await (await getMeeting(appRequest(`http://t/api/meetings/${id}`), ctx(id))).json();
    expect(summarized.status).toBe("summarized");
    expect(summarized.title).toBe("데일리 스크럼 2026-07-05"); // promoted from summary.title
  });

  it("POST /api/transcribe refuses a meeting that is already transcribed (raw.md immutable)", async () => {
    const res = await transcribePOST(
      appRequest("http://t/api/transcribe", {
        method: "POST",
        body: JSON.stringify({ id: "meeting-alpha" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("finalize probes an already-published meeting without overwriting immutable audio", async () => {
    const id = "meeting-alpha";
    const before = readFileSync(meetingPaths(id).audio);
    const res = await finalizePOST(finalizeReq(id, new Uint8Array([9, 9, 9])), ctx(id));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ artifact: "already_published" });
    expect(readFileSync(meetingPaths(id).audio)).toEqual(before);
  });

  it("POST review records participants into status.review", async () => {
    const id = "meeting-alpha";
    const res = await reviewPOST(
      appRequest(`http://t/api/meetings/${id}/review`, {
        method: "POST",
        body: JSON.stringify({ participants: ["딜런"] }),
      }),
      ctx(id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.review.participants).toEqual(["딜런"]);
  });

  it("GET /api/meetings lists finalized meetings through a bounded global page", async () => {
    const res = await listMeetings(appRequest("/api/meetings?view=global&limit=100"));
    const body = await res.json();
    expect(Array.isArray(body.meetings)).toBe(true);
    expect(body.meetings.some((m: { id: string }) => m.id === "meeting-alpha")).toBe(true);
    expect((await listMeetings(appRequest("/api/meetings"))).status).toBe(400);
  });

  it("rejects unsafe meeting ids (path traversal)", async () => {
    const bad = "../escape";
    const getRes = await getMeeting(appRequest("http://t/api/meetings/x"), ctx(bad));
    expect(getRes.status).toBe(400);
    const finRes = await finalizePOST(finalizeReq(bad, new Uint8Array([1])), ctx(bad));
    expect(finRes.status).toBe(400);
    const revRes = await reviewPOST(
      appRequest("http://t/api/meetings/x/review", { method: "POST", body: "{}" }),
      ctx(bad),
    );
    expect(revRes.status).toBe(400);
  });

  it("returns 404 for an unknown meeting", async () => {
    const res = await getMeeting(appRequest("http://t/api/meetings/nope"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("rejects before awaiting params or touching a params-derived path", async () => {
    let paramsObserved = false;
    const params = {
      then() {
        paramsObserved = true;
        throw new Error("params must not be observed");
      },
    } as unknown as Promise<{ id: string }>;
    const response = await getMeeting(
      new Request("http://evil.test/api/meetings/private", {
        headers: { host: "evil.test" },
      }),
      { params },
    );
    expect(response.status).toBe(403);
    expect(paramsObserved).toBe(false);
  });
});

describe("meeting audio byte-range transport", () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  it("returns the complete file with exact length and byte-range capability when Range is absent", async () => {
    const id = "audio-full";
    seedAudio(id, bytes);

    const response = await audioGET(appRequest(`/api/meetings/${id}/audio`), ctx(id));

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    await expectAudioLeaseReleased(id);
  });

  it.each([
    ["closed", "bytes=2-5", [2, 3, 4, 5], "bytes 2-5/10"],
    ["open-ended", "bytes=6-", [6, 7, 8, 9], "bytes 6-9/10"],
    ["suffix", "bytes=-3", [7, 8, 9], "bytes 7-9/10"],
  ])("normalizes a valid %s range and streams only the selected bytes", async (name, range, expected, contentRange) => {
    const id = `audio-${name}`;
    seedAudio(id, bytes);

    const response = await audioGET(
      appRequest(`/api/meetings/${id}/audio`, { headers: { range } }),
      ctx(id),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(String(expected.length));
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(expected);
    await expectAudioLeaseReleased(id);
  });

  it.each([
    ["multiple", "bytes=0-1,4-5"],
    ["malformed", "bytes=oops"],
    ["past-eof", "bytes=99-"],
  ])("returns a safe 416 for an invalid %s range without leaking the read lease", async (name, range) => {
    const id = `audio-invalid-${name}`;
    seedAudio(id, bytes);

    const response = await audioGET(
      appRequest(`/api/meetings/${id}/audio`, { headers: { range } }),
      ctx(id),
    );
    const body = await response.text();

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(body).not.toContain(range);
    expect(body).not.toContain(workDir);
    await expectAudioLeaseReleased(id);
  });

  it("returns 416 for a zero-length selected file and never creates a body stream lease", async () => {
    const id = "audio-empty";
    seedAudio(id, new Uint8Array());

    const response = await audioGET(appRequest(`/api/meetings/${id}/audio`), ctx(id));

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */0");
    await expectAudioLeaseReleased(id);
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
  writeFileSync(p.raw, "안녕하세요, 오늘 회의를 시작하겠습니다.\n"); // needed by a force re-summarize
  writeFileSync(p.transcript, "교정된 전사\n");
  writeFileSync(p.summary, readFileSync(join(originalCwd, "fixtures", "summary.happy.json"), "utf-8"));
}

const titleReq = (id: string, body: unknown) =>
  appRequest(`http://t/api/meetings/${id}/title`, { method: "POST", body: JSON.stringify(body) });
const deleteReq = (id: string) => appRequest(`http://t/api/meetings/${id}`, { method: "DELETE" });

describe("title edit / delete / export overlay", () => {
  it("POST title on a summarized meeting sets titleOverride and it survives re-derive", async () => {
    const id = "m-title-ok";
    await seedSummarized(id);
    const res = await titlePOST(titleReq(id, { title: "내가 고친 제목" }), ctx(id));
    expect(res.status).toBe(200);

    const got = await (await getMeeting(appRequest(`http://t/api/meetings/${id}`), ctx(id))).json();
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

    const md = await (await exportGET(appRequest(`http://t/api/meetings/${id}/export?fmt=md`), ctx(id))).text();
    expect(md).toContain("# 내보내기 제목");

    const jsonText = await (await exportGET(appRequest(`http://t/api/meetings/${id}/export?fmt=json`), ctx(id))).text();
    expect(JSON.parse(jsonText).title).toBe("데일리 스크럼 2026-07-05"); // raw summary.title, not overridden
  });

  it("export md uses summary.title (not the stale auto title) when there is no titleOverride", async () => {
    const id = "m-export-nooverride";
    await seedSummarized(id); // status.title stays the auto placeholder; no titleOverride
    const md = await (await exportGET(appRequest(`http://t/api/meetings/${id}/export?fmt=md`), ctx(id))).text();
    expect(md).toContain("# 데일리 스크럼 2026-07-05"); // the AI title shown in the UI
    expect(md).not.toMatch(/^# 회의 /m); // never the "회의 YYYY-MM-DD HH:MM" placeholder
    expect(md).not.toContain("현재 스크립트 변경 후 회의록 요약이 갱신되지 않음");
  });

  it("exports the current transcript with a stale-summary warning while keeping JSON schema unchanged", async () => {
    const id = "m-export-stale";
    await seedSummarized(id);
    await titlePOST(titleReq(id, { title: "현재 표시 제목" }), ctx(id));
    await reviewPOST(appRequest(`/api/meetings/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ participants: ["현재 참석자"] }),
    }), ctx(id));
    const current = await (await contentGET(
      appRequest(`/api/meetings/${id}/content`),
      ctx(id),
    )).json();
    const saved = await transcriptPATCH(appRequest(`/api/meetings/${id}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedRevision: current.revision,
        transcript: "사용자가 수정한 현재 스크립트\n",
      }),
    }), ctx(id));
    expect(saved.status).toBe(200);

    const mdResponse = await exportGET(
      appRequest(`/api/meetings/${id}/export?fmt=md`),
      ctx(id),
    );
    expect(mdResponse.status).toBe(200);
    const md = await mdResponse.text();
    expect(md).toContain("# 현재 표시 제목");
    expect(md).toContain("**참석자:** 현재 참석자");
    expect(md).toContain("사용자가 수정한 현재 스크립트");
    expect(md).toContain("현재 스크립트 변경 후 회의록 요약이 갱신되지 않음");

    const jsonResponse = await exportGET(
      appRequest(`/api/meetings/${id}/export?fmt=json`),
      ctx(id),
    );
    expect(jsonResponse.status).toBe(200);
    const exported = await jsonResponse.json();
    expect(Object.keys(exported).sort()).toEqual([
      "actionItems",
      "decisions",
      "discussion",
      "followups",
      "highlights",
      "oneLine",
      "participants",
      "purpose",
      "risks",
      "title",
      "topicSlug",
    ]);
    expect(exported).not.toHaveProperty("summaryOutdated");
  });

  it("fails closed instead of exporting ambiguous or source-conflicted pairs", async () => {
    const sourceConflictId = "m-export-source-conflict";
    await seedSummarized(sourceConflictId);
    const current = await (await contentGET(
      appRequest(`/api/meetings/${sourceConflictId}/content`),
      ctx(sourceConflictId),
    )).json();
    const sourceConflictPaths = meetingPaths(sourceConflictId);
    const sourceConflictStatus = JSON.parse(readFileSync(sourceConflictPaths.status, "utf8"));
    sourceConflictStatus.contentRevision = {
      transcript: {
        source: "manual",
        sha256: "0".repeat(64),
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
      summary: {
        source: "generated",
        sha256: current.revision.summarySha256,
        basedOnTranscriptSha256: "0".repeat(64),
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
    };
    writeFileSync(sourceConflictPaths.status, `${JSON.stringify(sourceConflictStatus)}\n`);

    const conflicted = await exportGET(
      appRequest(`/api/meetings/${sourceConflictId}/export?fmt=md`),
      ctx(sourceConflictId),
    );
    expect(conflicted.status).toBe(409);
    await expect(conflicted.json()).resolves.toMatchObject({
      error: { code: "content_source_conflict" },
    });

    const ambiguousId = "m-export-ambiguous";
    await seedSummarized(ambiguousId);
    rmSync(meetingPaths(ambiguousId).transcript);
    const ambiguous = await exportGET(
      appRequest(`/api/meetings/${ambiguousId}/export?fmt=md`),
      ctx(ambiguousId),
    );
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: { code: "content_state_ambiguous" },
    });
  });

  it("DELETE tombstones and removes the folder (200), is idempotent (200), and 400s a bad id", async () => {
    const id = "m-delete";
    await seedSummarized(id);
    const p = meetingPaths(id);
    expect(existsSync(p.dir)).toBe(true);

    expect((await deleteMeeting(deleteReq(id), ctx(id))).status).toBe(200);
    expect(existsSync(p.dir)).toBe(false);
    expect((await deleteMeeting(deleteReq(id), ctx(id))).status).toBe(200);
    expect((await deleteMeeting(deleteReq("x"), ctx("../escape"))).status).toBe(400);
  });

  it("DELETE is refused with 409 while a summarize is in-flight", async () => {
    const id = "m-delete-inflight";
    await seedSummarized(id);
    const lease = await acquireMeetingOperation(id, "summarize");
    try {
      const res = await deleteMeeting(deleteReq(id), ctx(id));
      expect(res.status).toBe(409);
      expect(existsSync(meetingPaths(id).dir)).toBe(true); // not removed
    } finally {
      lease.release();
    }
  });
});

describe("glossary route", () => {
  it("POST normalizes and GET round-trips the {terms, corrections} object", async () => {
    const post = await glossaryPOST(
      appRequest("http://t/api/glossary", {
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

    expect(await (await glossaryGET(appRequest("/api/glossary"))).json()).toEqual({
      terms: ["OKR"],
      corrections: [{ from: "김민중", to: "김민준" }],
    });
  });

  it("rejects a non-object body with 400", async () => {
    const res = await glossaryPOST(
      appRequest("http://t/api/glossary", { method: "POST", body: JSON.stringify("nope") }),
    );
    expect(res.status).toBe(400);
  });
});

describe("manual re-summarize (force)", () => {
  const summarizeReq = (id: string, body?: unknown) =>
    appRequest(`http://t/api/meetings/${id}/summarize`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    });

  // The route fires runSummarize and returns 202 without awaiting it. Drain that
  // background run so it can't outlive the test (and race the FAKE_LLM teardown).
  async function settleSummarize(id: string) {
    for (let i = 0; i < 400 && isSummarizeInflight(id); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("{resummarize:true} accepts a re-summarize (202); a plain POST still 409s", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "m-resummarize";
    await seedSummarized(id); // summary.json present (fixture: title "데일리 스크럼 2026-07-05")
    const current = await (await contentGET(
      appRequest(`/api/meetings/${id}/content`),
      ctx(id),
    )).json();
    const manualSave = await summaryPATCH(appRequest(`/api/meetings/${id}/summary`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedRevision: current.revision,
        body: "재생성 전에 저장한 수동 본문",
      }),
    }), ctx(id));
    expect(manualSave.status).toBe(200);
    const manual = await manualSave.json();
    expect(JSON.parse(readFileSync(meetingPaths(id).summary, "utf8"))).toMatchObject({
      body: "재생성 전에 저장한 수동 본문",
      oneLine: "",
      highlights: [],
    });
    const run = vi.spyOn(FakeAdapter.prototype, "run");
    try {
      // plain POST on an already-summarized meeting is refused
      expect((await summarizePOST(summarizeReq(id), ctx(id))).status).toBe(409);

      // A meeting-specific regeneration is revision-bound.
      expect((await summarizePOST(
        summarizeReq(id, { resummarize: true }),
        ctx(id),
      )).status).toBe(400);

      // forced re-summarize is accepted asynchronously (202), then runs in the
      // background via the offline FakeAdapter.
      const forced = await summarizePOST(summarizeReq(id, {
        resummarize: true,
        expectedRevision: manual.revision,
      }), ctx(id));
      expect(forced.status).toBe(202);
      await settleSummarize(id);

      // Prove the background run actually regenerated summary.json (not just that the
      // fixture still exists): the FakeAdapter writes a distinct title, and status
      // lands back on summarized with the attempt counter reset and no error.
      const regenerated = JSON.parse(readFileSync(meetingPaths(id).summary, "utf-8"));
      expect(regenerated.title).toBe("FAKE 회의 요약");
      expect(regenerated.title).not.toBe("데일리 스크럼 2026-07-05");
      expect(regenerated).not.toHaveProperty("body");
      const after = JSON.parse(readFileSync(meetingPaths(id).status, "utf-8"));
      expect(after.status).toBe("summarized");
      expect(after.error).toBeNull();
      expect(after.summarizeAttempts).toBe(0);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toContain("교정된 전사");
      expect(run.mock.calls[0][0]).not.toContain("[원문]");
      expect(run.mock.calls[0][1]).toEqual({ json: true });
    } finally {
      run.mockRestore();
      delete process.env.FAKE_LLM;
    }
  });

  it("global resummarize compatibility snapshots the current pair and runs summary-only", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "m-global-summary-only";
    await seedSummarized(id);
    const run = vi.spyOn(FakeAdapter.prototype, "run");
    try {
      const response = await globalSummarizePOST(appRequest("/api/summarize", {
        method: "POST",
        body: JSON.stringify({ id, resummarize: true }),
      }));
      expect(response.status).toBe(202);
      await settleSummarize(id);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toContain("교정된 전사");
      expect(run.mock.calls[0][0]).not.toContain("[원문]");
    } finally {
      run.mockRestore();
      delete process.env.FAKE_LLM;
    }
  });

  it("keeps the bodyless-compatible initial route as correction plus summary", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "m-initial-summarize";
    const paths = meetingPaths(id);
    mkdirSync(paths.dir, { recursive: true });
    await writeStatus(id, { ...initialStatus(id, INIT), status: "transcribed" });
    writeFileSync(paths.raw, "최초 생성 원문\n");
    const run = vi.spyOn(FakeAdapter.prototype, "run");
    try {
      const response = await summarizePOST(summarizeReq(id), ctx(id));
      expect(response.status).toBe(202);
      await settleSummarize(id);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[0][0]).toContain("[원문]");
      expect(run.mock.calls[1][0]).toContain("JSON 스키마");
      expect(existsSync(paths.transcript)).toBe(true);
      expect(existsSync(paths.summary)).toBe(true);
    } finally {
      run.mockRestore();
      delete process.env.FAKE_LLM;
    }
  });

  it("transcript regeneration requires exact confirmation and revision, then preserves summary bytes", async () => {
    process.env.FAKE_LLM = "1";
    await writeSettings({ provider: "claude-cli" });
    const id = "m-transcript-regenerate";
    await seedSummarized(id);
    const initial = await (await contentGET(
      appRequest(`/api/meetings/${id}/content`),
      ctx(id),
    )).json();
    const oldSummary = readFileSync(meetingPaths(id).summary, "utf8");
    const run = vi.spyOn(FakeAdapter.prototype, "run");
    const requestBody = (body: unknown, headers?: Record<string, string>) => appRequest(
      `/api/meetings/${id}/transcript/regenerate`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    try {
      for (const invalid of [
        { expectedRevision: initial.revision },
        { expectedRevision: initial.revision, confirmReplacement: false },
        { expectedRevision: initial.revision, confirmReplacement: true, extra: true },
      ]) {
        expect((await transcriptRegeneratePOST(requestBody(invalid), ctx(id))).status).toBe(400);
      }
      expect((await transcriptRegeneratePOST(requestBody({}, {
        "content-length": String(4 * 1024 + 1),
      }), ctx(id))).status).toBe(413);
      expect(run).not.toHaveBeenCalled();

      const accepted = await transcriptRegeneratePOST(requestBody({
        expectedRevision: initial.revision,
        confirmReplacement: true,
      }), ctx(id));
      expect(accepted.status).toBe(202);
      await settleSummarize(id);

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toContain("[원문]");
      expect(run.mock.calls[0][1]).toBeUndefined();
      expect(readFileSync(meetingPaths(id).summary, "utf8")).toBe(oldSummary);
      const changed = await (await contentGET(
        appRequest(`/api/meetings/${id}/content`),
        ctx(id),
      )).json();
      expect(changed.transcriptSource).toBe("generated");
      expect(changed.summaryOutdated).toBe(true);

      const stale = await transcriptRegeneratePOST(requestBody({
        expectedRevision: initial.revision,
        confirmReplacement: true,
      }), ctx(id));
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({
        error: { code: "content_revision_conflict" },
      });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
      delete process.env.FAKE_LLM;
    }
  });

  it("refuses (409) a re-summarize while one is already in flight", async () => {
    await writeSettings({ provider: "claude-cli" });
    const id = "m-resummarize-inflight";
    await seedSummarized(id);
    const current = await (await contentGET(
      appRequest(`/api/meetings/${id}/content`),
      ctx(id),
    )).json();
    const lease = await acquireMeetingOperation(id, "summarize");
    try {
      const res = await summarizePOST(summarizeReq(id, {
        resummarize: true,
        expectedRevision: current.revision,
      }), ctx(id));
      expect(res.status).toBe(409);
    } finally {
      lease.release();
    }
  });

  it("returns 400 when no model is configured", async () => {
    const id = "m-resummarize-nomodel";
    await seedSummarized(id);
    rmSync(settingsPath(), { force: true }); // no settings.json → getConfiguredAdapter null
    const res = await summarizePOST(summarizeReq(id, { resummarize: true }), ctx(id));
    expect(res.status).toBe(400);
  });
});

describe("manual transcript and summary content routes", () => {
  const summaryBody = "수정한 제목\r\n\r\n- 첫 줄\r둘째 줄  ";
  const normalizedSummaryBody = "수정한 제목\n\n- 첫 줄\r둘째 줄  ";

  it("GET probes a stable safe resource and PATCH saves each field with expected pair revision", async () => {
    const id = "m-manual-content";
    await seedSummarized(id);

    const initial = await contentGET(appRequest(`/api/meetings/${id}/content`), ctx(id));
    expect(initial.status).toBe(200);
    const first = await initial.json();
    expect(first).toMatchObject({
      transcript: "교정된 전사\n",
      summaryBody: expect.stringContaining("요약\n"),
      revision: {
        transcriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        summarySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      transcriptSource: "generated",
      summarySource: "generated",
      summaryOutdated: false,
      pairState: "stable",
    });
    expect(first).not.toHaveProperty("summary");
    expect(JSON.stringify(first)).not.toMatch(/topicSlug|participants|title|\/data\/meetings|attemptId/u);

    const transcript = await transcriptPATCH(appRequest(`/api/meetings/${id}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedRevision: first.revision,
        transcript: "수정한\r\n전체 스크립트\r",
      }),
    }), ctx(id));
    expect(transcript.status).toBe(200);
    const changed = await transcript.json();
    expect(changed).toMatchObject({
      transcript: "수정한\n전체 스크립트\n",
      transcriptSource: "manual",
      summaryOutdated: true,
      durability: expect.stringMatching(/^(durable|best_effort|pending)$/),
    });

    const stale = await transcriptPATCH(appRequest(`/api/meetings/${id}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: first.revision, transcript: "stale" }),
    }), ctx(id));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "content_revision_conflict" },
    });

    const summary = await summaryPATCH(appRequest(`/api/meetings/${id}/summary`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: changed.revision, body: summaryBody }),
    }), ctx(id));
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({
      summaryBody: normalizedSummaryBody,
      summarySource: "manual",
      summaryOutdated: false,
    });
    expect(JSON.parse(readFileSync(meetingPaths(id).summary, "utf8"))).toMatchObject({
      body: normalizedSummaryBody,
      oneLine: "",
      purpose: "",
      highlights: [],
      discussion: [],
      decisions: [],
      actionItems: [],
      risks: [],
      followups: [],
    });
  });

  it("enforces exact JSON bodies, route byte caps, and normalized transcript byte limits", async () => {
    const id = "m-manual-validation";
    await seedSummarized(id);
    const current = await (await contentGET(appRequest(`/api/meetings/${id}/content`), ctx(id))).json();

    const unknown = await transcriptPATCH(appRequest(`/api/meetings/${id}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedRevision: current.revision,
        transcript: "valid",
        hidden: true,
      }),
    }), ctx(id));
    expect(unknown.status).toBe(400);

    const wrongType = await summaryPATCH(appRequest(`/api/meetings/${id}/summary`, {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ expectedRevision: current.revision, body: "본문" }),
    }), ctx(id));
    expect(wrongType.status).toBe(415);

    for (const invalid of [
      { expectedRevision: current.revision, summary: { oneLine: "legacy form" } },
      { expectedRevision: current.revision, body: "본문", oneLine: "structured field" },
      { expectedRevision: current.revision, body: "본문", title: "internal title" },
      { expectedRevision: current.revision, body: "본문", participants: ["internal"] },
    ]) {
      const response = await summaryPATCH(appRequest(`/api/meetings/${id}/summary`, {
        method: "PATCH",
        body: JSON.stringify(invalid),
      }), ctx(id));
      expect(response.status).toBe(400);
    }

    const whitespace = await summaryPATCH(appRequest(`/api/meetings/${id}/summary`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: current.revision, body: " \r\n\t" }),
    }), ctx(id));
    expect(whitespace.status).toBe(400);
    await expect(whitespace.json()).resolves.toMatchObject({
      error: { code: "invalid_request", details: { field: "body" } },
    });

    const summaryTooLarge = await summaryPATCH(appRequest(`/api/meetings/${id}/summary`, {
      method: "PATCH",
      headers: { "content-length": String(512 * 1024 + 1) },
      body: "{}",
    }), ctx(id));
    expect(summaryTooLarge.status).toBe(413);

    const declaredTooLarge = await transcriptPATCH(appRequest(`/api/meetings/${id}/transcript`, {
      method: "PATCH",
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      body: "{}",
    }), ctx(id));
    expect(declaredTooLarge.status).toBe(413);

    const utf8TooLarge = await transcriptPATCH(appRequest(`/api/meetings/${id}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedRevision: current.revision,
        transcript: "한".repeat(400_000),
      }),
    }), ctx(id));
    expect(utf8TooLarge.status).toBe(400);
    await expect(utf8TooLarge.json()).resolves.toMatchObject({
      error: { code: "invalid_request", details: { field: "transcript" } },
    });
  });

  it("returns a safe missing result for an unknown content probe", async () => {
    const response = await contentGET(appRequest("/api/meetings/no-content/content"), ctx("no-content"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "meeting_not_found" } });
  });
});
