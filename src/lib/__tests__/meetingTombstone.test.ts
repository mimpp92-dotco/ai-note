// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDirectorySyncCapability,
  createNodeFileOps,
  type FileOps,
} from "@/lib/durableFileOps";
import {
  createMeetingTombstoneStore,
  resetMeetingTombstoneStateForTests,
} from "@/lib/meetingTombstone";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "meeting-tombstone-"));
  resetMeetingTombstoneStateForTests();
});

afterEach(async () => {
  resetMeetingTombstoneStateForTests();
  await rm(root, { recursive: true, force: true });
});

describe("durable meeting tombstone store", () => {
  it("creates a strict marker and preserves the original deletedAt on retry", async () => {
    let now = "2026-07-10T00:00:00.000Z";
    const store = createMeetingTombstoneStore({ dataRoot: root, now: () => now });
    const first = await store.create("meeting-1");
    expect(first).toMatchObject({
      state: "deleted",
      tombstone: { id: "meeting-1", deletedAt: now },
      durability: "durable",
      created: true,
    });
    now = "2026-07-11T00:00:00.000Z";
    const retry = await store.create("meeting-1");
    expect(retry).toMatchObject({
      state: "deleted",
      tombstone: { deletedAt: "2026-07-10T00:00:00.000Z" },
      created: false,
    });
    const bytes = await readFile(join(root, "meeting-tombstones", "meeting-1.json"), "utf8");
    expect(JSON.parse(bytes)).toEqual({ id: "meeting-1", deletedAt: "2026-07-10T00:00:00.000Z" });
  });

  it.each(["malformed", "symlink"])("fails closed on an %s marker", async (kind) => {
    const dir = join(root, "meeting-tombstones");
    await mkdir(dir, { recursive: true });
    const marker = join(dir, "meeting-1.json");
    if (kind === "malformed") await writeFile(marker, "{bad");
    else {
      const outside = join(root, "outside.json");
      await writeFile(outside, JSON.stringify({ id: "meeting-1", deletedAt: "2026-07-10T00:00:00.000Z" }));
      await symlink(outside, marker);
    }
    const store = createMeetingTombstoneStore({ dataRoot: root });
    await expect(store.inspect("meeting-1")).resolves.toEqual({ state: "ambiguous" });
    await expect(store.create("meeting-1")).rejects.toThrowError("delete_state_ambiguous");
  });

  it("keeps the fence after post-rename sync pending and retries only namespace durability", async () => {
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
    const store = createMeetingTombstoneStore({
      dataRoot: root,
      fileOps,
      capability: createDirectorySyncCapability("supported"),
    });
    const created = await store.create("meeting-1");
    expect(created).toMatchObject({ state: "deleted", durability: "pending", created: true });
    await expect(store.inspect("meeting-1")).resolves.toMatchObject({ state: "deleted" });
    failSync = false;
    await expect(store.retryDurability("meeting-1")).resolves.toBe("durable");
  });

  it("reports known unsupported directory sync as best-effort", async () => {
    const store = createMeetingTombstoneStore({
      dataRoot: root,
      capability: createDirectorySyncCapability("unsupported"),
    });
    await expect(store.create("meeting-1")).resolves.toMatchObject({
      state: "deleted",
      durability: "best_effort",
    });
  });
});
