// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDirectorySyncCapability,
  createNodeFileOps,
  type FileOps,
} from "@/lib/durableFileOps";
import { resetMeetingLifecycleForTests } from "@/lib/meetingLifecycle";
import { dataRoot, meetingPaths } from "@/lib/paths";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import {
  createStatusUpdater,
  resetStatusUpdaterStateForTests,
  setStatusUpdaterForTests,
} from "@/lib/statusUpdater";
import { enqueueTranscription } from "@/lib/transcribe";

const CANONICAL = "30000000-0000-4000-8000-000000000002";

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "transcribe-dispatch-"));
  process.chdir(workDir);
  process.env.LOCAL_STT_HOST = "127.0.0.1";
  process.env.LOCAL_STT_PORT = "8123";
  resetStatusUpdaterStateForTests();
  resetMeetingLifecycleForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.LOCAL_STT_HOST;
  delete process.env.LOCAL_STT_PORT;
  resetStatusUpdaterStateForTests();
  resetMeetingLifecycleForTests();
  vi.unstubAllGlobals();
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

describe("durable transcription dispatch", () => {
  it("commits a proposed dispatch before the first service call", async () => {
    const id = "meeting-marker-first";
    await seed(id);
    let observedDispatch: string | undefined;
    const fetchMock = vi.fn(async () => {
      const status = await readStatus(id);
      observedDispatch = status?.transcriptionDispatch?.dispatchId;
      expect(status?.transcriptionDispatch?.state).toBe("proposed");
      return {
        status: 202,
        json: async () => ({ dispatchId: observedDispatch, status: "accepted" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await enqueueTranscription(id);
    expect(result).toMatchObject({ ok: true, dispatchId: observedDispatch, durability: "durable" });
    expect(observedDispatch).toMatch(/^[a-f0-9-]{36}$/u);
    expect((await readStatus(id))?.transcriptionDispatch).toMatchObject({
      dispatchId: observedDispatch,
      state: "sent",
    });
  });

  it("reuses the durable proposed ID after response loss and updater restart", async () => {
    const id = "meeting-response-loss";
    await seed(id);
    const bodies: Array<{ meetingId: string; dispatchId: string }> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { meetingId: string; dispatchId: string };
      bodies.push(body);
      if (bodies.length === 1) throw new Error("response lost");
      return { status: 202, json: async () => ({ dispatchId: body.dispatchId, status: "accepted" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(enqueueTranscription(id)).rejects.toThrowError();
    const proposed = (await readStatus(id))?.transcriptionDispatch?.dispatchId;
    resetStatusUpdaterStateForTests();
    await expect(enqueueTranscription(id)).resolves.toMatchObject({ ok: true, dispatchId: proposed });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.dispatchId).toBe(proposed);
    expect(bodies[1]?.dispatchId).toBe(proposed);
  });

  it("CAS-adopts the service canonical dispatch before sending it", async () => {
    const id = "meeting-adopt-canonical";
    await seed(id);
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { dispatchId: string };
      bodies.push(body.dispatchId);
      if (bodies.length === 1) {
        return {
          status: 409,
          json: async () => ({ error: { code: "adopt_existing_dispatch" }, dispatchId: CANONICAL }),
        };
      }
      expect((await readStatus(id))?.transcriptionDispatch).toMatchObject({
        dispatchId: CANONICAL,
        state: "accepted",
      });
      return { status: 202, json: async () => ({ dispatchId: CANONICAL, status: "accepted" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(enqueueTranscription(id)).resolves.toMatchObject({ ok: true, dispatchId: CANONICAL });
    expect(bodies[1]).toBe(CANONICAL);
  });

  it("does not call Whisper when proposed-marker durability is pending", async () => {
    const id = "meeting-dispatch-pending";
    await seed(id);
    const base = createNodeFileOps();
    let failSync = true;
    const fileOps: FileOps = {
      ...base,
      openDirectory: async (...args) => {
        const handle = await base.openDirectory(...args);
        return {
          ...handle,
          sync: async () => {
            if (failSync) throw Object.assign(new Error("transient"), { code: "EIO" });
            await handle.sync();
          },
        };
      },
    };
    resetStatusUpdaterStateForTests();
    setStatusUpdaterForTests(dataRoot(), createStatusUpdater({
      dataRoot: dataRoot(),
      fileOps,
      capability: createDirectorySyncCapability("supported"),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(enqueueTranscription(id)).rejects.toThrowError("status_durability_pending");
    expect(fetchMock).not.toHaveBeenCalled();
    const proposed = (await readStatus(id))?.transcriptionDispatch?.dispatchId;
    expect((await readStatus(id))?.transcriptionDispatch?.state).toBe("proposed");

    failSync = false;
    fetchMock.mockResolvedValue({
      status: 202,
      json: async () => ({ dispatchId: proposed, status: "accepted" }),
    });
    await expect(enqueueTranscription(id)).resolves.toMatchObject({
      ok: true,
      dispatchId: proposed,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
