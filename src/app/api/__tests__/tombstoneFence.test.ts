// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as audioGET } from "@/app/api/meetings/[id]/audio/route";
import { GET as contentGET } from "@/app/api/meetings/[id]/content/route";
import { GET as exportGET } from "@/app/api/meetings/[id]/export/route";
import { POST as finalizePOST } from "@/app/api/meetings/[id]/finalize/route";
import { DELETE as deleteMeeting, GET as meetingGET } from "@/app/api/meetings/[id]/route";
import { POST as titlePOST } from "@/app/api/meetings/[id]/title/route";
import { PATCH as summaryPATCH } from "@/app/api/meetings/[id]/summary/route";
import { PATCH as transcriptPATCH } from "@/app/api/meetings/[id]/transcript/route";
import { classifyMeetingRecord } from "@/domain/library";
import { scanMeetingRecordObservations } from "@/lib/library";
import { resetMeetingLifecycleForTests } from "@/lib/meetingLifecycle";
import {
  getMeetingTombstoneStore,
  resetMeetingTombstoneStateForTests,
} from "@/lib/meetingTombstone";
import { dataRoot, meetingPaths } from "@/lib/paths";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import { resetStatusUpdaterStateForTests } from "@/lib/statusUpdater";

const ORIGIN = "http://127.0.0.1:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1:3000");
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") headers.set("origin", ORIGIN);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "tombstone-fence-"));
  process.chdir(workDir);
  resetMeetingTombstoneStateForTests();
  resetStatusUpdaterStateForTests();
  resetMeetingLifecycleForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  resetMeetingTombstoneStateForTests();
  resetStatusUpdaterStateForTests();
  resetMeetingLifecycleForTests();
  rmSync(workDir, { recursive: true, force: true });
});

async function seed(id: string) {
  const paths = meetingPaths(id);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.audio, "audio");
  await writeStatus(id, initialStatus(id, {
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T00:01:00.000Z",
    durationMs: 60_000,
    audioMime: "audio/webm",
  }));
}

describe("global meeting tombstone fence", () => {
  it("hides a tombstoned live directory from status, scanner, and read/write routes", async () => {
    const id = "meeting-deleted";
    await seed(id);
    await getMeetingTombstoneStore().create(id);

    await expect(readStatus(id)).resolves.toBeNull();
    const observations = await scanMeetingRecordObservations(dataRoot());
    const record = observations.find((item) => item.meetingId === id);
    expect(record && classifyMeetingRecord(record)).toMatchObject({
      kind: "hidden_deleted",
      visible: false,
      preservePlacement: false,
    });
    expect((await meetingGET(request(`/api/meetings/${id}`), ctx(id))).status).toBe(410);
    expect((await audioGET(request(`/api/meetings/${id}/audio`), ctx(id))).status).toBe(410);
    expect((await exportGET(request(`/api/meetings/${id}/export`), ctx(id))).status).toBe(410);
    expect((await titlePOST(request(`/api/meetings/${id}/title`, {
      method: "POST",
      body: JSON.stringify({ title: "resurrect" }),
    }), ctx(id))).status).toBe(410);
  });

  it("rejects finalize before consuming its body and makes delete retry idempotent", async () => {
    const id = "meeting-finalize-fenced";
    await seed(id);
    const first = await getMeetingTombstoneStore().create(id);
    let pulled = false;
    const finalizeRequest = request(
      `/api/meetings/${id}/finalize?durationMs=1&mime=audio%2Fwebm`,
      {
        method: "POST",
        headers: { "content-type": "audio/webm" },
      },
    );
    Object.defineProperty(finalizeRequest, "body", {
      get() {
        pulled = true;
        throw new Error("body must not be observed");
      },
    });
    const finalize = await finalizePOST(finalizeRequest, ctx(id));
    expect(finalize.status).toBe(410);
    expect(pulled).toBe(false);

    const retried = await deleteMeeting(request(`/api/meetings/${id}`, { method: "DELETE" }), ctx(id));
    expect(retried.status).toBe(200);
    const marker = JSON.parse(await readFile(join(dataRoot(), "meeting-tombstones", `${id}.json`), "utf8"));
    expect(marker.deletedAt).toBe(first.tombstone.deletedAt);
  });

  it("treats a malformed exact tombstone as an ambiguous permanent fence", async () => {
    const id = "meeting-delete-ambiguous";
    await seed(id);
    const directory = join(dataRoot(), "meeting-tombstones");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${id}.json`), "{broken");

    expect((await meetingGET(request(`/api/meetings/${id}`), ctx(id))).status).toBe(409);
    expect((await deleteMeeting(request(`/api/meetings/${id}`, { method: "DELETE" }), ctx(id))).status)
      .toBe(409);
    const observation = (await scanMeetingRecordObservations(dataRoot()))
      .find((item) => item.meetingId === id);
    expect(observation && classifyMeetingRecord(observation)).toMatchObject({
      kind: "unsafe_record",
      visible: false,
      preservePlacement: true,
    });
    expect(existsSync(meetingPaths(id).dir)).toBe(true);
  });

  it.each([
    ["content GET", (id: string, req: Request) => contentGET(req, ctx(id)), "GET"],
    ["transcript PATCH", (id: string, req: Request) => transcriptPATCH(req, ctx(id)), "PATCH"],
    ["summary PATCH", (id: string, req: Request) => summaryPATCH(req, ctx(id)), "PATCH"],
  ] as const)("fences %s before observing a request body", async (_name, call, method) => {
    const id = `content-fenced-${method.toLowerCase()}-${_name.split(" ")[0]}`;
    await seed(id);
    await getMeetingTombstoneStore().create(id);
    let bodyObserved = false;
    const req = request(`/api/meetings/${id}/${_name.startsWith("content") ? "content" : _name.split(" ")[0]}`, {
      method,
      ...(method === "PATCH" ? { body: "{}" } : {}),
    });
    Object.defineProperty(req, "body", {
      get() {
        bodyObserved = true;
        throw new Error("body must not be observed");
      },
    });

    expect((await call(id, req)).status).toBe(410);
    expect(bodyObserved).toBe(false);
  });

  it.each([
    ["content", (id: string, req: Request) => contentGET(req, ctx(id)), "GET"],
    ["transcript", (id: string, req: Request) => transcriptPATCH(req, ctx(id)), "PATCH"],
    ["summary", (id: string, req: Request) => summaryPATCH(req, ctx(id)), "PATCH"],
  ] as const)("fails closed on an ambiguous tombstone for %s", async (surface, call, method) => {
    const id = `content-ambiguous-${surface}`;
    await seed(id);
    const directory = join(dataRoot(), "meeting-tombstones");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${id}.json`), "{broken");
    let bodyObserved = false;
    const req = request(`/api/meetings/${id}/${surface}`, {
      method,
      ...(method === "PATCH" ? { body: "{}" } : {}),
    });
    Object.defineProperty(req, "body", {
      get() {
        bodyObserved = true;
        throw new Error("body must not be observed");
      },
    });

    expect((await call(id, req)).status).toBe(409);
    expect(bodyObserved).toBe(false);
  });
});
