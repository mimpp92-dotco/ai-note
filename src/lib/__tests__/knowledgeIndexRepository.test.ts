// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StatusJson } from "@/domain/meeting";
import type { ClassifiedMeetingRecord } from "@/domain/library";
import {
  acquireArtifactReadLease,
  resetArtifactLeaseStateForTests,
  type ArtifactGenerationLease,
} from "@/lib/artifactLease";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  type FileOps,
} from "@/lib/durableFileOps";
import {
  createKnowledgeIndexRepository,
  KnowledgeIndexRepositoryError,
  resetKnowledgeIndexRepositoryStateForTests,
} from "@/lib/knowledgeIndexRepository";
import {
  acquireMeetingOperation,
  resetMeetingLifecycleForTests,
} from "@/lib/meetingLifecycle";
import { resetMeetingTombstoneStateForTests } from "@/lib/meetingTombstone";
import {
  corpusMapPath,
  dataRoot,
  knowledgeCardPath,
  knowledgeRoot,
  meetingPaths,
} from "@/lib/paths";

const summary = {
  title: "검색 회의",
  topicSlug: "search",
  oneLine: "검색 범위를 결정했다",
  purpose: "검색 범위 결정",
  participants: [],
  highlights: ["단순 검색 우선"],
  discussion: ["논의"],
  decisions: ["결정"],
  actionItems: [{ owner: "민수", task: "명세 작성", due: "금요일" }],
  risks: [],
  followups: [],
};

let originalCwd: string;
let workDir: string;

function makeStatus(id: string, overrides: Partial<StatusJson> = {}): StatusJson {
  const paths = meetingPaths(id);
  return {
    id,
    title: "검색 회의",
    status: "summarized",
    error: null,
    startedAt: "2026-07-12T00:00:00.000Z",
    endedAt: "2026-07-12T00:30:00.000Z",
    durationMs: 1_800_000,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 1 },
    paths: {
      audio: paths.audio,
      play: paths.play,
      raw: paths.raw,
      transcript: paths.transcript,
      summary: paths.summary,
      segments: paths.segments,
    },
    review: { participants: ["딜런"] },
    updatedAt: "2026-07-12T00:31:00.000Z",
    ...overrides,
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedMeeting(
  id: string,
  options: { transcript?: string; summaryText?: string; status?: Partial<StatusJson> } = {},
): Promise<StatusJson> {
  const paths = meetingPaths(id);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.transcript, options.transcript ?? "회의 전사\n");
  await writeFile(paths.summary, options.summaryText ?? `${JSON.stringify(summary)}\n`);
  const current = makeStatus(id, options.status);
  await writeFile(paths.status, `${JSON.stringify(current)}\n`);
  return current;
}

function liveRecord(id: string, current: StatusJson): ClassifiedMeetingRecord {
  return {
    kind: "live",
    meetingId: id,
    hasPlacement: false,
    visible: true,
    preservePlacement: true,
    status: current,
  };
}

function hiddenRecord(
  id: string,
  kind: "hidden_deleted" | "corrupt_status" | "unsafe_record",
): ClassifiedMeetingRecord {
  return {
    kind,
    meetingId: id,
    hasPlacement: false,
    visible: false,
    preservePlacement: kind !== "hidden_deleted",
    status: null,
  };
}

beforeEach(async () => {
  originalCwd = process.cwd();
  workDir = await mkdtemp(join(tmpdir(), "knowledge-index-"));
  process.chdir(workDir);
  await mkdir(dataRoot(), { recursive: true });
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
  resetKnowledgeIndexRepositoryStateForTests();
});

afterEach(async () => {
  process.chdir(originalCwd);
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
  resetKnowledgeIndexRepositoryStateForTests();
  await rm(workDir, { recursive: true, force: true });
});

async function writeCard(id: string, repository = createKnowledgeIndexRepository({ dataRoot: dataRoot() })) {
  const operation = await acquireMeetingOperation(id, "summarize");
  try {
    return await repository.writeKnowledgeCard({
      meetingId: id,
      meetingOperationOwnerToken: operation.ownerToken,
    });
  } finally {
    operation.release();
  }
}

describe("knowledge-card repository", () => {
  it("durably writes and reads a generation-consistent card", async () => {
    await seedMeeting("meeting-1");
    const repository = createKnowledgeIndexRepository({ dataRoot: dataRoot() });

    await expect(writeCard("meeting-1", repository)).resolves.toMatchObject({
      state: "committed",
      durability: "durable",
      card: { meetingId: "meeting-1", reviewParticipants: ["딜런"] },
    });
    await expect(repository.readKnowledgeCard("meeting-1")).resolves.toMatchObject({
      mode: "ready",
      card: { meetingId: "meeting-1", mentionedPeople: ["민수"] },
    });
    const read = await repository.readKnowledgeCard("meeting-1");
    expect(read.mode === "ready" && read.card.content).not.toHaveProperty("body");
  });

  it("round-trips a manual body through the full card and bounded corpus projection", async () => {
    const id = "meeting-manual-body";
    const body = `자유 회의록\n\n${"나".repeat(5_000)}`;
    await seedMeeting(id, {
      summaryText: `${JSON.stringify({
        ...summary,
        body,
        oneLine: "",
        purpose: "",
        highlights: [],
        discussion: [],
        decisions: [],
        actionItems: [],
        risks: [],
        followups: [],
      })}\n`,
    });
    const current = JSON.parse(await readFile(meetingPaths(id).status, "utf8")) as StatusJson;
    const repository = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      loadClassifiedMeetingRecords: async () => [liveRecord(id, current)],
    });

    await expect(writeCard(id, repository)).resolves.toMatchObject({
      card: {
        content: { body },
        actionItems: [],
        mentionedPeople: [],
      },
    });
    await expect(repository.readKnowledgeCard(id)).resolves.toMatchObject({
      mode: "ready",
      card: { content: { body } },
    });
    const rebuilt = await repository.rebuildCorpusMap();
    expect(rebuilt.corpusMap.cards[0].body).toBe(Array.from(body).slice(0, 4_000).join(""));
    await expect(repository.readCorpusMap()).resolves.toMatchObject({
      mode: "ready",
      corpusMap: { cards: [{ meetingId: id, body: Array.from(body).slice(0, 4_000).join("") }] },
    });
  });

  it("keeps a post-rename pending card committed without rollback or blind rewrite", async () => {
    await seedMeeting("meeting-pending");
    const base = createNodeFileOps();
    let renameCount = 0;
    const fileOps: FileOps = {
      ...base,
      rename: async (...args) => {
        renameCount += 1;
        await base.rename(...args);
      },
      openDirectory: async (...args) => {
        const handle = await base.openDirectory(...args);
        return {
          ...handle,
          sync: async () => { throw Object.assign(new Error("transient"), { code: "EIO" }); },
        };
      },
    };
    const repository = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      fileOps,
      capability: createDirectorySyncCapability("supported"),
    });

    const result = await writeCard("meeting-pending", repository);
    expect(result).toMatchObject({ state: "committed", durability: "pending" });
    expect(renameCount).toBe(1);
    expect(JSON.parse(await readFile(knowledgeCardPath("meeting-pending"), "utf8"))).toMatchObject({
      meetingId: "meeting-pending",
    });
    await expect(repository.readKnowledgeCard("meeting-pending")).resolves.toMatchObject({
      mode: "ready",
    });
    expect(renameCount).toBe(1);
  });

  it("reports corrupt card bytes without replacing them", async () => {
    await seedMeeting("meeting-corrupt");
    await writeFile(knowledgeCardPath("meeting-corrupt"), "{");
    const before = await readFile(knowledgeCardPath("meeting-corrupt"), "utf8");
    const repository = createKnowledgeIndexRepository({ dataRoot: dataRoot() });

    await expect(repository.readKnowledgeCard("meeting-corrupt")).resolves.toEqual({ mode: "corrupt" });
    expect(await readFile(knowledgeCardPath("meeting-corrupt"), "utf8")).toBe(before);
  });

  it("uses its explicit data root for status and source reads even when cwd differs", async () => {
    const explicitRoot = join(workDir, "alternate-data");
    const id = "meeting-alternate-root";
    const meetingDirectory = join(explicitRoot, "meetings", id);
    await mkdir(meetingDirectory, { recursive: true });
    await writeFile(join(meetingDirectory, "transcript.md"), "alternate transcript\n");
    await writeFile(join(meetingDirectory, "summary.json"), `${JSON.stringify(summary)}\n`);
    await writeFile(
      join(meetingDirectory, "status.json"),
      `${JSON.stringify(makeStatus(id))}\n`,
    );
    const repository = createKnowledgeIndexRepository({ dataRoot: explicitRoot });
    const operation = await acquireMeetingOperation(id, "summarize");
    try {
      await expect(repository.writeKnowledgeCard({
        meetingId: id,
        meetingOperationOwnerToken: operation.ownerToken,
      })).resolves.toMatchObject({ state: "committed", card: { meetingId: id } });
    } finally {
      operation.release();
    }
    expect(JSON.parse(await readFile(knowledgeCardPath(id, explicitRoot), "utf8"))).toMatchObject({
      meetingId: id,
    });
  });

  it("does not accept malformed summary bytes merely because a stored hash matches", async () => {
    await seedMeeting("meeting-malformed-source");
    const repository = createKnowledgeIndexRepository({ dataRoot: dataRoot() });
    await writeCard("meeting-malformed-source", repository);
    const malformed = new TextEncoder().encode("not-json");
    await writeFile(meetingPaths("meeting-malformed-source").summary, malformed);
    const stored = JSON.parse(
      await readFile(knowledgeCardPath("meeting-malformed-source"), "utf8"),
    ) as { sourceHashes: { summary: string } };
    stored.sourceHashes.summary = createHash("sha256").update(malformed).digest("hex");
    await writeFile(
      knowledgeCardPath("meeting-malformed-source"),
      `${JSON.stringify(stored)}\n`,
    );

    await expect(repository.readKnowledgeCard("meeting-malformed-source")).resolves.toEqual({
      mode: "corrupt",
    });
  });

  it("does not expose a valid stored card when the current status record is corrupt", async () => {
    await seedMeeting("meeting-corrupt-status");
    const repository = createKnowledgeIndexRepository({ dataRoot: dataRoot() });
    await writeCard("meeting-corrupt-status", repository);
    await writeFile(meetingPaths("meeting-corrupt-status").status, "{");

    await expect(repository.readKnowledgeCard("meeting-corrupt-status")).resolves.toEqual({
      mode: "corrupt",
    });
  });

  it("keeps a transcript-changed summary stale until the summary is rebound and refreshed", async () => {
    const id = "meeting-content-revision";
    const initialTranscript = "초기 전사\n";
    const changedTranscript = "수정된 전사\n";
    const summaryText = `${JSON.stringify(summary)}\n`;
    const initialTranscriptHash = hashText(initialTranscript);
    const changedTranscriptHash = hashText(changedTranscript);
    const summaryHash = hashText(summaryText);
    const initialStatus = await seedMeeting(id, {
      transcript: initialTranscript,
      summaryText,
      status: {
        contentRevision: {
          transcript: {
            source: "generated",
            sha256: initialTranscriptHash,
            updatedAt: "2026-07-12T00:30:00.000Z",
          },
          summary: {
            source: "generated",
            sha256: summaryHash,
            basedOnTranscriptSha256: initialTranscriptHash,
            updatedAt: "2026-07-12T00:30:00.000Z",
          },
        },
      },
    });
    const repository = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      loadClassifiedMeetingRecords: async () => [liveRecord(id, JSON.parse(
        await readFile(meetingPaths(id).status, "utf8"),
      ) as StatusJson)],
    });
    await writeCard(id, repository);
    await expect(repository.rebuildCorpusMap()).resolves.toMatchObject({
      corpusMap: { cards: [{ meetingId: id }] },
    });

    await writeFile(meetingPaths(id).transcript, changedTranscript);
    await writeFile(meetingPaths(id).status, `${JSON.stringify({
      ...initialStatus,
      contentRevision: {
        transcript: {
          source: "manual",
          sha256: changedTranscriptHash,
          updatedAt: "2026-07-12T01:00:00.000Z",
        },
        summary: initialStatus.contentRevision!.summary,
      },
      updatedAt: "2026-07-12T01:00:00.000Z",
    })}\n`);

    await expect(repository.readKnowledgeCard(id)).resolves.toMatchObject({ mode: "stale" });
    const canonicalBeforeFailedRefresh = await Promise.all([
      readFile(meetingPaths(id).transcript),
      readFile(meetingPaths(id).summary),
      readFile(meetingPaths(id).status),
    ]);
    await expect(writeCard(id, repository)).rejects.toMatchObject({ code: "source_pair_stale" });
    await expect(Promise.all([
      readFile(meetingPaths(id).transcript),
      readFile(meetingPaths(id).summary),
      readFile(meetingPaths(id).status),
    ])).resolves.toEqual(canonicalBeforeFailedRefresh);
    await expect(repository.rebuildCorpusMap()).resolves.toMatchObject({
      corpusMap: { cards: [] },
    });

    const reboundStatus = {
      ...initialStatus,
      contentRevision: {
        transcript: {
          source: "manual" as const,
          sha256: changedTranscriptHash,
          updatedAt: "2026-07-12T01:00:00.000Z",
        },
        summary: {
          ...initialStatus.contentRevision!.summary,
          basedOnTranscriptSha256: changedTranscriptHash,
          updatedAt: "2026-07-12T01:01:00.000Z",
        },
      },
      updatedAt: "2026-07-12T01:01:00.000Z",
    };
    await writeFile(meetingPaths(id).status, `${JSON.stringify(reboundStatus)}\n`);

    await expect(writeCard(id, repository)).resolves.toMatchObject({
      state: "committed",
      card: { meetingId: id },
    });
    await expect(repository.readKnowledgeCard(id)).resolves.toMatchObject({ mode: "ready" });
    await expect(repository.rebuildCorpusMap()).resolves.toMatchObject({
      corpusMap: { cards: [{ meetingId: id }] },
    });
  });

  it("fails closed for a tombstone before or after lease acquisition and for an ambiguous pair", async () => {
    const current = await seedMeeting("meeting-race");
    let inspections = 0;
    const racing = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      inspectTombstone: async () => {
        inspections += 1;
        return inspections === 1
          ? { state: "none" as const }
          : { state: "ambiguous" as const };
      },
      readStatusSnapshot: async () => current,
    });
    const operation = await acquireMeetingOperation("meeting-race", "summarize");
    await expect(racing.writeKnowledgeCard({
      meetingId: "meeting-race",
      meetingOperationOwnerToken: operation.ownerToken,
    })).rejects.toMatchObject({ code: "delete_state_ambiguous" });
    operation.release();
    expect(inspections).toBe(2);

    const deleted = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      inspectTombstone: async () => ({
        state: "deleted" as const,
        tombstone: { id: "meeting-race", deletedAt: "2026-07-12T01:00:00.000Z" },
      }),
    });
    const deletedOperation = await acquireMeetingOperation("meeting-race", "summarize");
    await expect(deleted.writeKnowledgeCard({
      meetingId: "meeting-race",
      meetingOperationOwnerToken: deletedOperation.ownerToken,
    })).rejects.toMatchObject({ code: "meeting_deleted" });
    deletedOperation.release();

    await seedMeeting("meeting-ambiguous", { summaryText: "not-json" });
    await expect(writeCard("meeting-ambiguous")).rejects.toMatchObject({
      code: "source_pair_ambiguous",
    });
    await expect(readFile(knowledgeCardPath("meeting-ambiguous"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("knowledge root durability", () => {
  it("creates the missing root safely and syncs the data namespace", async () => {
    const base = createNodeFileOps();
    const synced: string[] = [];
    const repository = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      capability: createDirectorySyncCapability("supported"),
      fileOps: {
        ...base,
        openDirectory: async (path) => {
          const handle = await base.openDirectory(path);
          return {
            ...handle,
            sync: async () => {
              synced.push(path);
              await handle.sync();
            },
          };
        },
      },
    });

    await expect(repository.ensureKnowledgeRoot()).resolves.toEqual({
      state: "ready",
      created: true,
      durability: "durable",
    });
    expect(synced).toEqual([dataRoot()]);
  });

  it("rejects symlink and non-directory roots", async () => {
    const outside = await mkdtemp(join(tmpdir(), "knowledge-outside-"));
    try {
      await symlink(outside, knowledgeRoot(), "dir");
      const repository = createKnowledgeIndexRepository({ dataRoot: dataRoot() });
      await expect(repository.ensureKnowledgeRoot()).rejects.toBeInstanceOf(KnowledgeIndexRepositoryError);
      await expect(repository.ensureKnowledgeRoot()).rejects.toMatchObject({ code: "unsafe_knowledge_root" });
      await unlink(knowledgeRoot());
      await writeFile(knowledgeRoot(), "not a directory");
      await expect(repository.ensureKnowledgeRoot()).rejects.toMatchObject({ code: "unsafe_knowledge_root" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("distinguishes transient pending from known unsupported parent sync", async () => {
    const base = createNodeFileOps();
    const pendingRoot = join(workDir, "pending-data");
    await mkdir(pendingRoot);
    const pending = createKnowledgeIndexRepository({
      dataRoot: pendingRoot,
      capability: createDirectorySyncCapability("supported"),
      fileOps: {
        ...base,
        openDirectory: async (...args) => {
          const handle = await base.openDirectory(...args);
          return {
            ...handle,
            sync: async () => { throw Object.assign(new Error("transient"), { code: "EIO" }); },
          };
        },
      },
    });
    await expect(pending.ensureKnowledgeRoot()).resolves.toMatchObject({
      created: true,
      durability: "pending",
    });

    const unsupportedRoot = join(workDir, "unsupported-data");
    await mkdir(unsupportedRoot);
    let directoryOpenCount = 0;
    const unsupported = createKnowledgeIndexRepository({
      dataRoot: unsupportedRoot,
      capability: createDirectorySyncCapability("unsupported"),
      fileOps: {
        ...base,
        openDirectory: async (...args) => {
          directoryOpenCount += 1;
          return base.openDirectory(...args);
        },
      },
    });
    await expect(unsupported.ensureKnowledgeRoot()).resolves.toMatchObject({
      created: true,
      durability: "best_effort",
    });
    expect(directoryOpenCount).toBe(0);
  });
});

describe("corpus-map rebuild and queue", () => {
  it("includes only currently live, safe, non-tombstoned, ready card snapshots", async () => {
    const current = await seedMeeting("meeting-live");
    const repositoryForCard = createKnowledgeIndexRepository({ dataRoot: dataRoot() });
    await writeCard("meeting-live", repositoryForCard);
    const records = [
      liveRecord("meeting-live", current),
      hiddenRecord("meeting-deleted", "hidden_deleted"),
      hiddenRecord("meeting-corrupt", "corrupt_status"),
      hiddenRecord("meeting-unsafe", "unsafe_record"),
      liveRecord("meeting-tombstone-race", makeStatus("meeting-tombstone-race")),
    ];
    const repository = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      loadClassifiedMeetingRecords: async () => records,
      inspectTombstone: async (meetingId) => meetingId === "meeting-tombstone-race"
        ? {
            state: "deleted" as const,
            tombstone: {
              id: meetingId,
              deletedAt: "2026-07-12T02:00:00.000Z",
            },
          }
        : { state: "none" as const },
    });

    await expect(repository.rebuildCorpusMap()).resolves.toMatchObject({
      state: "committed",
      indexedCount: 1,
      skippedCount: 4,
      corpusMap: { cards: [{ meetingId: "meeting-live" }] },
    });
    await expect(repository.readCorpusMap()).resolves.toMatchObject({
      mode: "ready",
      corpusMap: { cards: [{ meetingId: "meeting-live" }] },
    });
  });

  it("serializes concurrent corpus commits by absolute canonical path", async () => {
    let entered = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const enteredSignal = new Promise<void>((resolve) => { firstEntered = resolve; });
    const repository = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      barrier: async (point) => {
        if (point !== "inside_corpus_queue_before_commit") return;
        entered += 1;
        if (entered === 1) {
          firstEntered();
          await firstGate;
        }
      },
    });
    const first = repository.writeCorpusMap({ schemaVersion: 1, cards: [] });
    await enteredSignal;
    const second = repository.writeCorpusMap({ schemaVersion: 1, cards: [] });
    await Promise.resolve();
    expect(entered).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(entered).toBe(2);
    expect(JSON.parse(await readFile(corpusMapPath(), "utf8"))).toEqual({
      schemaVersion: 1,
      cards: [],
    });
  });

  it("collects library/artifact snapshots before waiting for the corpus queue and releases leases before commit", async () => {
    const current = await seedMeeting("meeting-order");
    await writeCard("meeting-order");
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    let queueEntered!: () => void;
    const queueEnteredSignal = new Promise<void>((resolve) => { queueEntered = resolve; });
    const blocker = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      barrier: async (point) => {
        if (point === "inside_corpus_queue_before_commit") {
          queueEntered();
          await queueGate;
        }
      },
    });
    const blockingWrite = blocker.writeCorpusMap({ schemaVersion: 1, cards: [] });
    await queueEnteredSignal;

    let libraryReadFinished = false;
    let leaseHeld = false;
    let snapshotReleased!: () => void;
    const snapshotReleasedSignal = new Promise<void>((resolve) => { snapshotReleased = resolve; });
    const repository = createKnowledgeIndexRepository({
      dataRoot: dataRoot(),
      loadClassifiedMeetingRecords: async () => {
        libraryReadFinished = true;
        return [liveRecord("meeting-order", current)];
      },
      acquireArtifactReadLease: async (meetingId): Promise<ArtifactGenerationLease> => {
        const lease = await acquireArtifactReadLease(meetingId);
        leaseHeld = true;
        return {
          ...lease,
          release(ownerToken): boolean {
            const released = lease.release(ownerToken);
            if (released) {
              leaseHeld = false;
              snapshotReleased();
            }
            return released;
          },
        };
      },
      barrier: async (point) => {
        if (point === "inside_corpus_queue_before_commit") {
          expect(libraryReadFinished).toBe(true);
          expect(leaseHeld).toBe(false);
        }
      },
    });
    const rebuild = repository.rebuildCorpusMap();
    await snapshotReleasedSignal;
    expect(libraryReadFinished).toBe(true);
    expect(leaseHeld).toBe(false);
    let rebuildFinished = false;
    void rebuild.then(() => { rebuildFinished = true; });
    await Promise.resolve();
    expect(rebuildFinished).toBe(false);

    releaseQueue();
    await Promise.all([blockingWrite, rebuild]);
  });
});
