// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentRevision } from "@/domain/meeting";
import { resetArtifactLeaseStateForTests } from "@/lib/artifactLease";
import { createNodeFileOps, type FileOps } from "@/lib/durableFileOps";
import {
  readManualMeetingContent,
  saveManualSummary,
  saveManualTranscript,
  setManualMeetingContentKnowledgeIndexRepositoryForTests,
} from "@/lib/manualMeetingContent";
import {
  acquireMeetingOperation,
  resetMeetingLifecycleForTests,
} from "@/lib/meetingLifecycle";
import { meetingPaths } from "@/lib/paths";
import { initialStatus, readStatus, writeStatus } from "@/lib/status";
import { resetStatusUpdaterStateForTests } from "@/lib/statusUpdater";

const TRANSCRIPT = "기존 교정 스크립트\n";
const RAW = "immutable raw\n";
const SEGMENTS = "[{\"text\":\"immutable\"}]\n";
const SUMMARY_VALUE = {
  title: "내부 제목",
  topicSlug: "internal-topic",
  oneLine: "기존 한 줄",
  purpose: "기존 목적",
  participants: ["authoritative-model-field"],
  highlights: ["기존 핵심"],
  discussion: ["기존 논의"],
  decisions: ["기존 결정"],
  actionItems: [{ owner: "기존", task: "작업", due: "미정" }],
  risks: ["기존 위험"],
  followups: ["기존 후속"],
};
const SUMMARY = `${JSON.stringify(SUMMARY_VALUE, null, 2)}\n`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "manual-meeting-content-"));
  process.chdir(workDir);
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetStatusUpdaterStateForTests();
  setManualMeetingContentKnowledgeIndexRepositoryForTests(null);
});

afterEach(() => {
  setManualMeetingContentKnowledgeIndexRepositoryForTests(null);
  process.chdir(originalCwd);
  resetArtifactLeaseStateForTests();
  resetMeetingLifecycleForTests();
  resetStatusUpdaterStateForTests();
  rmSync(workDir, { recursive: true, force: true });
});

function revision(
  transcriptSource: ContentRevision["transcript"]["source"] = "generated",
  summarySource: ContentRevision["summary"]["source"] = "generated",
): ContentRevision {
  return {
    transcript: {
      source: transcriptSource,
      sha256: hash(TRANSCRIPT),
      updatedAt: "2026-07-10T00:01:00.000Z",
    },
    summary: {
      source: summarySource,
      sha256: hash(SUMMARY),
      basedOnTranscriptSha256: hash(TRANSCRIPT),
      updatedAt: "2026-07-10T00:01:00.000Z",
    },
  };
}

async function seed(id: string, contentRevision?: ContentRevision): Promise<void> {
  const paths = meetingPaths(id);
  await mkdir(paths.dir, { recursive: true });
  await Promise.all([
    writeFile(paths.raw, RAW),
    writeFile(paths.segments, SEGMENTS),
    writeFile(paths.transcript, TRANSCRIPT),
    writeFile(paths.summary, SUMMARY),
  ]);
  await writeStatus(id, {
    ...initialStatus(id, {
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: "2026-07-10T00:01:00.000Z",
      durationMs: 60_000,
      audioMime: "audio/webm",
    }),
    status: "summarized",
    error: {
      code: "transcription_failed",
      message: "prior error",
      action: "retry_transcription",
    },
    summarizeAttempts: 4,
    ...(contentRevision ? { contentRevision } : {}),
  });
}

const expectedRevision = {
  transcriptSha256: hash(TRANSCRIPT),
  summarySha256: hash(SUMMARY),
};

describe("manual meeting content service", () => {
  it("reads only a stable editable projection with virtual legacy provenance", async () => {
    const id = "manual-probe";
    await seed(id);

    const result = await readManualMeetingContent(id);

    expect(result).toMatchObject({
      ok: true,
      content: {
        transcript: TRANSCRIPT,
        summary: {
          oneLine: "기존 한 줄",
          purpose: "기존 목적",
          highlights: ["기존 핵심"],
        },
        revision: expectedRevision,
        transcriptSource: "generated",
        summarySource: "generated",
        summaryOutdated: false,
        pairState: "stable",
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("internal-topic");
    expect(serialized).not.toContain("authoritative-model-field");
    expect(serialized).not.toContain(workDir);
  });

  it("publishes a manual transcript without changing immutable or summary bytes", async () => {
    const id = "manual-transcript";
    await seed(id, revision());
    const refresh = vi.fn();
    setManualMeetingContentKnowledgeIndexRepositoryForTests({ refreshAfterSummary: refresh });

    const result = await saveManualTranscript({
      id,
      expectedRevision,
      transcript: "바뀐\r\n스크립트\r",
    }, { now: () => "2026-07-10T00:05:00.000Z" });

    expect(result).toMatchObject({ ok: true, durability: "durable" });
    const paths = meetingPaths(id);
    expect(await readFile(paths.transcript, "utf8")).toBe("바뀐\n스크립트\n");
    expect(await readFile(paths.summary, "utf8")).toBe(SUMMARY);
    expect(await readFile(paths.raw, "utf8")).toBe(RAW);
    expect(await readFile(paths.segments, "utf8")).toBe(SEGMENTS);
    expect((await readStatus(id))?.contentRevision).toMatchObject({
      transcript: { source: "manual", sha256: hash("바뀐\n스크립트\n") },
      summary: revision().summary,
    });
    expect(result.ok && result.content.summaryOutdated).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps summary freshness when a manual transcript save is byte-identical", async () => {
    const id = "manual-transcript-identical";
    await seed(id, revision());

    const result = await saveManualTranscript({ id, expectedRevision, transcript: TRANSCRIPT }, {
      now: () => "2026-07-10T00:06:00.000Z",
    });

    expect(result).toMatchObject({ ok: true, content: { summaryOutdated: false } });
    expect((await readStatus(id))?.contentRevision?.summary).toEqual(revision().summary);
  });

  it("replaces only editable summary fields, preserves internal fields, and refreshes index once", async () => {
    const id = "manual-summary";
    await seed(id, revision("manual", "generated"));
    const refresh = vi.fn().mockRejectedValue(new Error("index unavailable"));
    setManualMeetingContentKnowledgeIndexRepositoryForTests({ refreshAfterSummary: refresh });

    const result = await saveManualSummary({
      id,
      expectedRevision,
      summary: {
        oneLine: " 새 한 줄 ",
        purpose: " 새 목적 ",
        highlights: [" 첫 줄\n둘째 줄 "],
        discussion: [" 새 논의 "],
        decisions: [" 새 결정 "],
        actionItems: [{ owner: "담당자", task: "새 작업", due: "내일" }],
        risks: [" 새 위험 "],
        followups: [" 새 후속 "],
      },
    }, { now: () => "2026-07-10T00:07:00.000Z" });

    expect(result).toMatchObject({
      ok: true,
      content: {
        transcript: TRANSCRIPT,
        summary: { oneLine: "새 한 줄", highlights: ["첫 줄\n둘째 줄"] },
        transcriptSource: "manual",
        summarySource: "manual",
        summaryOutdated: false,
      },
    });
    const full = JSON.parse(await readFile(meetingPaths(id).summary, "utf8"));
    expect(full).toMatchObject({
      title: SUMMARY_VALUE.title,
      topicSlug: SUMMARY_VALUE.topicSlug,
      participants: SUMMARY_VALUE.participants,
      oneLine: "새 한 줄",
    });
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(TRANSCRIPT);
    expect((await readStatus(id))?.contentRevision).toMatchObject({
      transcript: revision("manual").transcript,
      summary: {
        source: "manual",
        basedOnTranscriptSha256: hash(TRANSCRIPT),
      },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("fails stale expected revisions and provenance conflicts before writes or indexing", async () => {
    const id = "manual-conflict";
    await seed(id, revision());
    const refresh = vi.fn();
    setManualMeetingContentKnowledgeIndexRepositoryForTests({ refreshAfterSummary: refresh });
    const beforeStatus = await readFile(meetingPaths(id).status, "utf8");

    await expect(saveManualTranscript({
      id,
      expectedRevision: { ...expectedRevision, summarySha256: "f".repeat(64) },
      transcript: "should not publish",
    })).resolves.toMatchObject({ ok: false, reason: "revision_conflict" });
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(TRANSCRIPT);
    expect(await readFile(meetingPaths(id).status, "utf8")).toBe(beforeStatus);
    expect(refresh).not.toHaveBeenCalled();

    const current = await readStatus(id);
    await writeStatus(id, {
      ...current!,
      contentRevision: {
        ...revision(),
        transcript: { ...revision().transcript, sha256: "e".repeat(64) },
      },
    });
    const conflictedStatus = await readFile(meetingPaths(id).status, "utf8");
    await expect(saveManualTranscript({
      id,
      expectedRevision,
      transcript: "should not publish",
    })).resolves.toMatchObject({ ok: false, reason: "source_conflict" });
    expect(await readFile(meetingPaths(id).status, "utf8")).toBe(conflictedStatus);
  });

  it("rejects a concurrent content operation and an oversized normalized transcript", async () => {
    const id = "manual-busy";
    await seed(id, revision());
    const operation = await acquireMeetingOperation(id, "summary_regenerate");
    try {
      await expect(saveManualTranscript({
        id,
        expectedRevision,
        transcript: "busy",
      })).resolves.toMatchObject({ ok: false, reason: "operation_in_progress" });
    } finally {
      operation.release();
    }

    await expect(saveManualTranscript({
      id,
      expectedRevision,
      transcript: "한".repeat(400_000),
    })).resolves.toMatchObject({ ok: false, reason: "invalid_transcript", field: "transcript" });
  });

  it("classifies a pre-staging manual publication failure as interrupted and preserves prior status", async () => {
    const id = "manual-interrupted";
    await seed(id, revision("manual", "manual"));
    const base = createNodeFileOps();
    const fileOps: FileOps = {
      ...base,
      mkdir: async (path, options) => {
        if (path.includes(".summarize-")) throw Object.assign(new Error("fault"), { code: "EIO" });
        await base.mkdir(path, options);
      },
    };

    const result = await saveManualTranscript({
      id,
      expectedRevision,
      transcript: "new content",
    }, { publisherOptions: { fileOps } });

    expect(result).toMatchObject({ ok: false, reason: "interrupted" });
    expect(await readFile(meetingPaths(id).transcript, "utf8")).toBe(TRANSCRIPT);
    const after = await readStatus(id);
    expect(after?.summarizeAttempt).toBeUndefined();
    expect(after?.contentRevision).toEqual(revision("manual", "manual"));
    expect(after?.summarizeAttempts).toBe(4);
    expect(after?.error?.action).toBe("retry_transcription");
  });
});
