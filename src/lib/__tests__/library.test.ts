// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StatusJson } from "@/domain/meeting";
import type { LibraryDocument, MeetingRecordObservation } from "@/domain/library";
import { createDirectorySyncCapability, createNodeFileOps, type FileOps } from "@/lib/durableFileOps";
import {
  createLibraryRepository,
  resetLibraryRepositoryStateForTests,
} from "@/lib/library";

const LIBRARY_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const OTHER_LIBRARY_ID = "10000000-0000-4000-8000-000000000003";
let root: string;

function status(id: string): StatusJson {
  return {
    id,
    title: id,
    status: "recorded",
    error: null,
    startedAt: "2026-07-10T01:00:00.000Z",
    endedAt: "2026-07-10T01:01:00.000Z",
    durationMs: 60_000,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 0 },
    paths: {
      audio: "/audio",
      play: "/play",
      raw: "/raw",
      transcript: "/transcript",
      summary: "/summary",
      segments: "/segments",
    },
    review: { participants: [] },
    updatedAt: "2026-07-10T01:01:00.000Z",
  };
}

function live(id: string, hasPlacement = false): MeetingRecordObservation {
  return {
    entryKind: "published",
    meetingId: id,
    safety: "safe",
    status: { kind: "valid", value: status(id) },
    hasAudio: true,
    hasPlacement,
  };
}

function readyDocument(overrides: Partial<LibraryDocument> = {}): LibraryDocument {
  return {
    schemaVersion: 1,
    libraryId: LIBRARY_ID,
    revision: 0,
    defaultWorkspaceId: WORKSPACE_ID,
    workspaces: [{
      id: WORKSPACE_ID,
      name: "내 워크스페이스",
      order: 0,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }],
    folders: [],
    placements: [],
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "library-repository-"));
  resetLibraryRepositoryStateForTests();
});

afterEach(async () => {
  resetLibraryRepositoryStateForTests();
  await rm(root, { recursive: true, force: true });
});

describe("library repository read modes", () => {
  it("distinguishes missing, ready, corrupt, unsupported, and I/O errors without rewriting", async () => {
    const repo = createLibraryRepository({ dataRoot: root });
    expect((await repo.read()).mode).toBe("missing");

    await writeFile(join(root, "library.json"), "{");
    const corruptBefore = await stat(join(root, "library.json"));
    expect((await repo.read()).mode).toBe("corrupt");
    expect((await stat(join(root, "library.json"))).mtimeMs).toBe(corruptBefore.mtimeMs);

    await writeFile(join(root, "library.json"), JSON.stringify({ schemaVersion: 99 }));
    expect((await repo.read()).mode).toBe("unsupported_version");

    await writeFile(join(root, "library.json"), JSON.stringify(readyDocument()));
    const ready = await repo.read();
    expect(ready).toMatchObject({ mode: "ready", document: { libraryId: LIBRARY_ID } });

    const base = createNodeFileOps();
    const ioRepo = createLibraryRepository({
      dataRoot: root,
      fileOps: {
        ...base,
        readFile: async () => { throw Object.assign(new Error("no access"), { code: "EACCES" }); },
      },
    });
    expect((await ioRepo.read()).mode).toBe("io_error");
  });
});

describe("bootstrap and process queue", () => {
  it("bootstraps exactly once and only materializes live records", async () => {
    let renameCount = 0;
    const base = createNodeFileOps();
    const fileOps: FileOps = {
      ...base,
      rename: async (...args) => {
        renameCount += 1;
        await base.rename(...args);
      },
    };
    const observations: MeetingRecordObservation[] = [
      live("meeting-a"),
      live("meeting-b"),
      { ...live("bad"), status: { kind: "corrupt" } },
      { ...live("stage"), entryKind: "finalize_staging" },
    ];
    const repo = createLibraryRepository({
      dataRoot: root,
      fileOps,
      idFactory: () => LIBRARY_ID,
      now: () => "2026-07-10T00:00:00.000Z",
      scanRecords: async () => observations,
    });
    const [first, second] = await Promise.all([repo.bootstrap(), repo.bootstrap()]);
    expect(first.mode).toBe("ready");
    expect(second.mode).toBe("ready");
    expect(renameCount).toBe(1);
    const ready = await repo.read();
    if (ready.mode !== "ready") throw new Error("expected ready");
    expect(ready.document.revision).toBe(0);
    expect(ready.document.placements.map((placement) => placement.meetingId).sort()).toEqual([
      "meeting-a",
      "meeting-b",
    ]);
  });

  it("recovers the queue tail after a rejected reducer", async () => {
    await writeFile(join(root, "library.json"), JSON.stringify(readyDocument()));
    const repo = createLibraryRepository({ dataRoot: root, scanRecords: async () => [] });
    await expect(repo.transactLatest(() => { throw new Error("reducer failed"); })).rejects.toThrow(
      "reducer failed",
    );
    const result = await repo.transactLatest((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => ({ ...workspace, name: "복구됨" })),
    }));
    expect(result.document.workspaces[0].name).toBe("복구됨");
  });
});

describe("transactions and reconcile", () => {
  it("rejects stale generation/revision before write and lets one concurrent token win", async () => {
    await writeFile(join(root, "library.json"), JSON.stringify(readyDocument()));
    let renameCount = 0;
    const base = createNodeFileOps();
    const repo = createLibraryRepository({
      dataRoot: root,
      scanRecords: async () => [],
      fileOps: {
        ...base,
        rename: async (...args) => {
          renameCount += 1;
          await base.rename(...args);
        },
      },
    });
    await expect(repo.transact({
      expected: { libraryId: OTHER_LIBRARY_ID, revision: 0 },
      reducer: (current) => current,
    })).rejects.toMatchObject({ code: "version_conflict" });
    expect(renameCount).toBe(0);

    const mutate = (name: string) => repo.transact({
      expected: { libraryId: LIBRARY_ID, revision: 0 },
      reducer: (current: LibraryDocument) => ({
        ...current,
        workspaces: current.workspaces.map((workspace) => ({ ...workspace, name })),
      }),
    });
    const settled = await Promise.allSettled([mutate("A"), mutate("B")]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(renameCount).toBe(1);
  });

  it("materializes unplaced live records, cleans missing records, and preserves invalid-status placements", async () => {
    const initial = readyDocument({
      placements: [
        { meetingId: "missing", workspaceId: WORKSPACE_ID, folderId: null },
        { meetingId: "corrupt", workspaceId: WORKSPACE_ID, folderId: null },
      ],
    });
    await writeFile(join(root, "library.json"), JSON.stringify(initial));
    const repo = createLibraryRepository({
      dataRoot: root,
      scanRecords: async () => [
        live("new-live"),
        { ...live("corrupt", true), status: { kind: "corrupt" } },
      ],
    });
    const result = await repo.transact({
      expected: { libraryId: LIBRARY_ID, revision: 0 },
      reducer: (current) => current,
    });
    expect(result.document.revision).toBe(1);
    expect(result.document.placements.map((placement) => placement.meetingId).sort()).toEqual([
      "corrupt",
      "new-live",
    ]);
  });

  it("supports a defer policy without writing a default placement", async () => {
    await writeFile(join(root, "library.json"), JSON.stringify(readyDocument()));
    const repo = createLibraryRepository({ dataRoot: root, scanRecords: async () => [live("pending")] });
    const result = await repo.transact({
      expected: { libraryId: LIBRARY_ID, revision: 0 },
      placementPolicy: () => "defer",
      reducer: (current) => current,
    });
    expect(result.committed).toBe(false);
    expect(result.document.placements).toEqual([]);
    expect(result.document.revision).toBe(0);
  });

  it("does not commit a true no-op", async () => {
    await writeFile(join(root, "library.json"), JSON.stringify(readyDocument()));
    const before = await readFile(join(root, "library.json"), "utf8");
    const repo = createLibraryRepository({ dataRoot: root, scanRecords: async () => [] });
    const result = await repo.transactLatest((current) => current);
    expect(result.committed).toBe(false);
    expect(await readFile(join(root, "library.json"), "utf8")).toBe(before);
  });
});

describe("durability and last-good", () => {
  it("continues after best-effort commits but blocks after transient durability pending until retry", async () => {
    await writeFile(join(root, "library.json"), JSON.stringify(readyDocument()));
    const bestEffort = createLibraryRepository({
      dataRoot: root,
      scanRecords: async () => [],
      capability: createDirectorySyncCapability("unsupported"),
    });
    const first = await bestEffort.transactLatest((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => ({ ...workspace, name: "A" })),
    }));
    expect(first.durability).toBe("best_effort");
    await expect(bestEffort.transactLatest((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => ({ ...workspace, name: "B" })),
    }))).resolves.toMatchObject({ document: { revision: 2 } });

    let shouldFail = true;
    const base = createNodeFileOps();
    const pendingRepo = createLibraryRepository({
      dataRoot: root,
      scanRecords: async () => [],
      capability: createDirectorySyncCapability("supported"),
      fileOps: {
        ...base,
        openDirectory: async (...args) => {
          const handle = await base.openDirectory(...args);
          return {
            ...handle,
            sync: async () => {
              if (shouldFail) throw Object.assign(new Error("transient"), { code: "EIO" });
              await handle.sync();
            },
          };
        },
      },
    });
    const pending = await pendingRepo.transactLatest((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => ({ ...workspace, name: "C" })),
    }));
    expect(pending.durability).toBe("pending");
    await expect(pendingRepo.transactLatest((current) => current)).rejects.toMatchObject({
      code: "durability_pending",
    });
    shouldFail = false;
    await expect(pendingRepo.retryPendingDurability()).resolves.toBe("durable");
    await expect(pendingRepo.transactLatest((current) => current)).resolves.toBeDefined();
  });

  it("keeps immutable last-good snapshots isolated by absolute root", async () => {
    await writeFile(join(root, "library.json"), JSON.stringify(readyDocument()));
    const repo = createLibraryRepository({ dataRoot: root });
    await repo.read();
    const first = repo.getLastGood();
    expect(first?.workspaces[0].name).toBe("내 워크스페이스");
    expect(() => {
      if (first) (first.workspaces[0] as { name: string }).name = "변조";
    }).toThrow();
    expect(repo.getLastGood()?.workspaces[0].name).toBe("내 워크스페이스");

    const otherRoot = await mkdtemp(join(tmpdir(), "library-repository-other-"));
    try {
      expect(createLibraryRepository({ dataRoot: otherRoot }).getLastGood()).toBeNull();
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});
