// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StatusJson } from "@/domain/meeting";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  type FileOps,
} from "@/lib/durableFileOps";
import { resetMeetingLifecycleForTests } from "@/lib/meetingLifecycle";
import {
  createMeetingTombstoneStore,
  resetMeetingTombstoneStateForTests,
} from "@/lib/meetingTombstone";
import {
  createStatusUpdater,
  resetStatusUpdaterStateForTests,
} from "@/lib/statusUpdater";

let root: string;

function status(id = "meeting-1"): StatusJson & Record<string, unknown> {
  return {
    id,
    title: "회의",
    status: "recorded",
    error: null,
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T01:00:00.000Z",
    durationMs: 1,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 0 },
    paths: { audio: "/a", play: "/p", raw: "/r", transcript: "/t", summary: "/s", segments: "/g" },
    review: { participants: [] },
    updatedAt: "2026-07-10T01:00:00.000Z",
    futureField: { keep: true },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "status-updater-"));
  resetStatusUpdaterStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
});

afterEach(async () => {
  resetStatusUpdaterStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
  await rm(root, { recursive: true, force: true });
});

describe("reducer-form status updater", () => {
  it("serializes stale-intent reducers without losing fields or unknown future data", async () => {
    const updater = createStatusUpdater({ dataRoot: root, now: () => "2026-07-10T02:00:00.000Z" });
    await updater.create("meeting-1", status());
    await Promise.all([
      updater.update("meeting-1", (latest) => ({ ...latest, titleOverride: "새 제목", title: "새 제목" })),
      updater.update("meeting-1", (latest) => ({ ...latest, review: { participants: ["딜런"] } })),
    ]);
    const latest = await updater.read("meeting-1");
    expect(latest).toMatchObject({
      titleOverride: "새 제목",
      review: { participants: ["딜런"] },
      futureField: { keep: true },
      updatedAt: "2026-07-10T02:00:00.000Z",
    });
  });

  it("rejects an invalid reducer without changing canonical bytes and recovers its queue", async () => {
    const updater = createStatusUpdater({ dataRoot: root });
    await updater.create("meeting-1", status());
    const path = join(root, "meetings", "meeting-1", "status.json");
    const before = await readFile(path, "utf8");
    await expect(updater.update("meeting-1", (latest) => ({ ...latest, durationMs: -1 })))
      .rejects.toThrowError("invalid_status_update");
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(updater.update("meeting-1", (latest) => ({ ...latest, title: "복구" })))
      .resolves.toMatchObject({ status: { title: "복구" } });
  });

  it("keeps authoritative bytes but blocks further writes after transient parent-sync failure", async () => {
    const base = createNodeFileOps();
    let failSync = false;
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
    const updater = createStatusUpdater({
      dataRoot: root,
      fileOps,
      capability: createDirectorySyncCapability("supported"),
    });
    await updater.create("meeting-1", status());
    failSync = true;
    const pending = await updater.update("meeting-1", (latest) => ({ ...latest, title: "committed" }));
    expect(pending.commit.durability).toBe("pending");
    expect((await updater.read("meeting-1"))?.title).toBe("committed");
    await expect(updater.update("meeting-1", (latest) => latest)).rejects.toThrowError(
      "status_durability_pending",
    );
    failSync = false;
    await expect(updater.retryPending("meeting-1")).resolves.toBe("durable");
  });

  it("does not block ordinary follow-up writes in known best-effort mode", async () => {
    const updater = createStatusUpdater({
      dataRoot: root,
      capability: createDirectorySyncCapability("unsupported"),
    });
    expect((await updater.create("meeting-1", status())).commit.durability).toBe("best_effort");
    await expect(updater.update("meeting-1", (latest) => ({ ...latest, title: "next" })))
      .resolves.toMatchObject({ commit: { durability: "best_effort" } });
  });

  it("fences create and update once a tombstone exists", async () => {
    const updater = createStatusUpdater({ dataRoot: root });
    await updater.create("meeting-1", status());
    await createMeetingTombstoneStore({ dataRoot: root }).create("meeting-1");
    await expect(updater.read("meeting-1")).resolves.toBeNull();
    await expect(updater.update("meeting-1", (latest) => latest))
      .rejects.toThrowError("meeting_deleted");
    await expect(updater.create("meeting-2", status("meeting-2"))).resolves.toBeDefined();
    await createMeetingTombstoneStore({ dataRoot: root }).create("meeting-3");
    await expect(updater.create("meeting-3", status("meeting-3")))
      .rejects.toThrowError("meeting_deleted");
  });
});
