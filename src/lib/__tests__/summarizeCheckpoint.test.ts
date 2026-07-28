// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetArtifactLeaseStateForTests } from "@/lib/artifactLease";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  type FileOps,
} from "@/lib/durableFileOps";
import {
  CORRECTION_CHUNK_TARGET_CHARS,
  createCorrectionChunkPlan,
} from "@/lib/correctionChunks";
import {
  acquireMeetingOperation,
  resetMeetingLifecycleForTests,
} from "@/lib/meetingLifecycle";
import {
  createMeetingTombstoneStore,
  resetMeetingTombstoneStateForTests,
} from "@/lib/meetingTombstone";
import {
  CORRECTION_CHECKPOINT_SCHEMA_VERSION,
  correctionCheckpointMatches,
  correctionCheckpointPath,
  createCorrectionCheckpoint,
  createCorrectionCheckpointStore,
  createFastCorrectionCheckpoint,
  type CorrectionCheckpoint,
  type CorrectionCheckpointKey,
} from "@/lib/summarizeCheckpoint";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const ID = "meeting-checkpoint";
const KEY: CorrectionCheckpointKey = {
  rawSha256: sha256("raw"),
  glossarySha256: sha256("glossary"),
  provider: "claude-cli",
  model: "sonnet",
  providerEndpointIdentitySha256: sha256("local-cli:claude-cli"),
  correctionPromptVersion: "correction-v1",
  correctionMode: "full",
  chunkPlanSha256: sha256("full-context-plan"),
};
const CHECKPOINT: CorrectionCheckpoint = {
  schemaVersion: CORRECTION_CHECKPOINT_SCHEMA_VERSION,
  meetingId: ID,
  ...KEY,
  correctedTranscript: "안녕하세요. 교정된 회의 전사입니다.\n",
  completedChunks: [{
    index: 0,
    inputSha256: KEY.rawSha256,
    outputSha256: sha256("안녕하세요. 교정된 회의 전사입니다.\n"),
  }],
  committedAt: "2026-07-28T07:00:00.000Z",
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summarize-checkpoint-"));
  await mkdir(join(root, "meetings", ID), { recursive: true });
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
});

afterEach(async () => {
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
  await rm(root, { recursive: true, force: true });
});

async function withSummarizeOperation<T>(
  task: (ownerToken: string) => Promise<T>,
): Promise<T> {
  const operation = await acquireMeetingOperation(ID, "summarize");
  try {
    return await task(operation.ownerToken);
  } finally {
    operation.release();
  }
}

describe("durable correction checkpoint", () => {
  it("round-trips one strict hidden meeting-local checkpoint", async () => {
    const store = createCorrectionCheckpointStore({ dataRoot: root });

    await withSummarizeOperation(async (ownerToken) => {
      await expect(store.read(ID, ownerToken)).resolves.toEqual({ state: "missing" });
      await expect(store.write(ID, ownerToken, CHECKPOINT)).resolves.toMatchObject({
        state: "committed_durable",
        durability: "durable",
      });
      await expect(store.read(ID, ownerToken)).resolves.toEqual({
        state: "valid",
        checkpoint: CHECKPOINT,
      });
    });

    const path = correctionCheckpointPath(ID, root);
    expect(path).toBe(join(root, "meetings", ID, ".correction-checkpoint.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(CHECKPOINT);
  });

  it.each([
    ["corrupt JSON", "{not-json"],
    ["unknown version", JSON.stringify({ ...CHECKPOINT, schemaVersion: 2 })],
    [
      "duplicate field",
      JSON.stringify(CHECKPOINT).replace(
        `"schemaVersion":${CORRECTION_CHECKPOINT_SCHEMA_VERSION}`,
        `"schemaVersion":${CORRECTION_CHECKPOINT_SCHEMA_VERSION},"schemaVersion":${CORRECTION_CHECKPOINT_SCHEMA_VERSION}`,
      ),
    ],
    ["oversize file", "x".repeat(2 * 1024 * 1024 + 1)],
  ])("fails closed on a %s and does not overwrite it", async (_label, bytes) => {
    const path = correctionCheckpointPath(ID, root);
    await writeFile(path, bytes);
    const store = createCorrectionCheckpointStore({ dataRoot: root });

    await withSummarizeOperation(async (ownerToken) => {
      await expect(store.read(ID, ownerToken)).resolves.toMatchObject({ state: "invalid" });
      await expect(store.write(ID, ownerToken, CHECKPOINT)).rejects.toMatchObject({
        code: "checkpoint_invalid",
      });
    });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it("fails closed on a symlink without reading or replacing its target", async () => {
    const outside = join(root, "outside.json");
    const outsideBytes = JSON.stringify(CHECKPOINT);
    await writeFile(outside, outsideBytes);
    await symlink(outside, correctionCheckpointPath(ID, root));
    const store = createCorrectionCheckpointStore({ dataRoot: root });

    await withSummarizeOperation(async (ownerToken) => {
      await expect(store.read(ID, ownerToken)).resolves.toMatchObject({
        state: "invalid",
        reason: "unsafe",
      });
      await expect(store.write(ID, ownerToken, CHECKPOINT)).rejects.toMatchObject({
        code: "checkpoint_invalid",
      });
    });
    expect(await readFile(outside, "utf8")).toBe(outsideBytes);
  });

  it("reports a post-rename namespace sync failure as committed durability pending", async () => {
    const base = createNodeFileOps();
    const fileOps: FileOps = {
      ...base,
      openDirectory: async (...args) => {
        const handle = await base.openDirectory(...args);
        return {
          ...handle,
          sync: async () => {
            throw Object.assign(new Error("transient"), { code: "EIO" });
          },
        };
      },
    };
    const store = createCorrectionCheckpointStore({
      dataRoot: root,
      fileOps,
      capability: createDirectorySyncCapability("supported"),
    });

    await withSummarizeOperation(async (ownerToken) => {
      await expect(store.write(ID, ownerToken, CHECKPOINT)).resolves.toMatchObject({
        state: "committed_durability_pending",
        durability: "pending",
      });
      await expect(store.read(ID, ownerToken)).rejects.toMatchObject({
        code: "checkpoint_durability_pending",
      });
    });
    expect(JSON.parse(await readFile(correctionCheckpointPath(ID, root), "utf8")))
      .toEqual(CHECKPOINT);
  });

  it("deletes only a valid checkpoint and distinguishes the durable unlink", async () => {
    const store = createCorrectionCheckpointStore({ dataRoot: root });

    await withSummarizeOperation(async (ownerToken) => {
      await store.write(ID, ownerToken, CHECKPOINT);
      await expect(store.remove(ID, ownerToken)).resolves.toMatchObject({
        state: "committed_durable",
        durability: "durable",
      });
      await expect(store.read(ID, ownerToken)).resolves.toEqual({ state: "missing" });
    });
  });

  it("requires an operation owner and fails read/write/delete closed after tombstoning", async () => {
    const store = createCorrectionCheckpointStore({ dataRoot: root });
    await expect(store.read(ID, "not-an-owner")).rejects.toThrow(
      "invalid_meeting_operation_owner",
    );

    await withSummarizeOperation(async (ownerToken) => {
      await store.write(ID, ownerToken, CHECKPOINT);
      await createMeetingTombstoneStore({ dataRoot: root }).create(ID);
      await expect(store.read(ID, ownerToken)).rejects.toMatchObject({
        code: "checkpoint_fenced",
      });
      await expect(store.write(ID, ownerToken, CHECKPOINT)).rejects.toMatchObject({
        code: "checkpoint_fenced",
      });
      await expect(store.remove(ID, ownerToken)).rejects.toMatchObject({
        code: "checkpoint_fenced",
      });
    });
  });

  it("fails closed while a delete operation is active even before its tombstone is committed", async () => {
    const store = createCorrectionCheckpointStore({ dataRoot: root });
    const operation = await acquireMeetingOperation(ID, "delete");
    try {
      await expect(store.read(ID, operation.ownerToken)).rejects.toMatchObject({
        code: "checkpoint_fenced",
      });
    } finally {
      operation.release();
    }
  });

  it("preserves the existing empty-transcript correction behavior", () => {
    expect(createCorrectionCheckpoint({
      meetingId: ID,
      key: KEY,
      correctedTranscript: "",
      committedAt: "2026-07-28T07:00:00.000Z",
    }).correctedTranscript).toBe("");
  });

  it("rejects a checkpoint whose serialized UTF-8 bytes exceed the read cap", async () => {
    const store = createCorrectionCheckpointStore({ dataRoot: root });
    const oversized = createCorrectionCheckpoint({
      meetingId: ID,
      key: KEY,
      correctedTranscript: "한".repeat(700_000),
      committedAt: "2026-07-28T07:00:00.000Z",
    });

    await withSummarizeOperation(async (ownerToken) => {
      await expect(store.write(ID, ownerToken, oversized)).rejects.toMatchObject({
        code: "checkpoint_invalid",
      });
    });
    await expect(readFile(correctionCheckpointPath(ID, root))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["rawSha256", sha256("different raw")],
    ["glossarySha256", sha256("different glossary")],
    ["provider", "codex-cli"],
    ["model", "opus"],
    ["providerEndpointIdentitySha256", sha256("http://127.0.0.1:11434")],
    ["correctionPromptVersion", "correction-v2"],
    ["correctionMode", "fast"],
    ["chunkPlanSha256", sha256("different plan")],
  ] as const)("does not match when %s changes", (field, value) => {
    expect(correctionCheckpointMatches(CHECKPOINT, { ...KEY, [field]: value })).toBe(false);
  });

  it("matches only the exact correction identity", () => {
    expect(correctionCheckpointMatches(CHECKPOINT, KEY)).toBe(true);
  });

  it("durably round-trips sorted partial fast chunks with their exact output identities", async () => {
    const raw = [
      `${"가".repeat(CORRECTION_CHUNK_TARGET_CHARS - 100)}\n`,
      `${"나".repeat(CORRECTION_CHUNK_TARGET_CHARS - 100)}\n`,
      `${"다".repeat(CORRECTION_CHUNK_TARGET_CHARS - 100)}\n`,
    ].join("");
    const plan = createCorrectionChunkPlan(raw);
    const key: CorrectionCheckpointKey = {
      ...KEY,
      rawSha256: sha256(raw),
      correctionMode: "fast",
      chunkPlanSha256: plan.planSha256,
    };
    const chunk = plan.chunks[1]!;
    const correctedText = chunk.target.replace("나", "너");
    const partial = createFastCorrectionCheckpoint({
      meetingId: ID,
      key,
      correctedTranscript: "",
      completedChunks: [{
        index: chunk.index,
        chunkId: chunk.id,
        inputSha256: chunk.targetSha256,
        outputSha256: sha256(correctedText),
        correctedText,
      }],
      committedAt: "2026-07-28T07:00:00.000Z",
    });
    const store = createCorrectionCheckpointStore({ dataRoot: root });

    await withSummarizeOperation(async (ownerToken) => {
      await expect(store.write(ID, ownerToken, partial)).resolves.toMatchObject({
        state: "committed_durable",
      });
      await expect(store.read(ID, ownerToken)).resolves.toEqual({
        state: "valid",
        checkpoint: partial,
      });
    });
  });

  it("rejects a fast chunk whose text does not match its output hash", () => {
    const fastKey: CorrectionCheckpointKey = {
      ...KEY,
      correctionMode: "fast",
    };

    expect(() => createFastCorrectionCheckpoint({
      meetingId: ID,
      key: fastKey,
      correctedTranscript: "",
      completedChunks: [{
        index: 0,
        chunkId: "chunk-0-deadbeef",
        inputSha256: sha256("input"),
        outputSha256: sha256("different output"),
        correctedText: "actual output",
      }],
    })).toThrow();
  });

  it("requires the completed fast merge to equal the ordered chunk outputs", () => {
    const fastKey: CorrectionCheckpointKey = {
      ...KEY,
      correctionMode: "fast",
    };
    const correctedText = "첫 번째 교정 결과\n";

    expect(() => createFastCorrectionCheckpoint({
      meetingId: ID,
      key: fastKey,
      correctedTranscript: "다른 병합 결과\n",
      completedChunks: [{
        index: 0,
        chunkId: "chunk-0-deadbeef",
        inputSha256: sha256("input"),
        outputSha256: sha256(correctedText),
        correctedText,
      }],
    })).toThrow();
  });
});
