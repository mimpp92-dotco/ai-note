// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dynamic,
  POST as reindexKnowledge,
  runtime,
} from "@/app/api/knowledge/reindex/route";
import type { StatusJson } from "@/domain/meeting";
import { resetArtifactLeaseStateForTests } from "@/lib/artifactLease";
import { resetKnowledgeIndexRepositoryStateForTests } from "@/lib/knowledgeIndexRepository";
import { resetMeetingLifecycleForTests } from "@/lib/meetingLifecycle";
import {
  createMeetingTombstoneStore,
  resetMeetingTombstoneStateForTests,
} from "@/lib/meetingTombstone";
import {
  corpusMapPath,
  dataRoot,
  knowledgeCardPath,
  meetingPaths,
  meetingsRoot,
} from "@/lib/paths";

const ORIGIN = "http://127.0.0.1:3000";
const SUMMARY = {
  title: "기존 검색 회의",
  topicSlug: "existing-search",
  oneLine: "기존 회의를 재색인했다",
  purpose: "재색인 검증",
  participants: [],
  highlights: ["검색 데이터 갱신"],
  discussion: ["논의"],
  decisions: ["결정"],
  actionItems: [{ owner: "민수", task: "검증", due: "오늘" }],
  risks: [],
  followups: [],
};

let originalCwd: string;
let workDir: string;

function request(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/knowledge/reindex`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body,
    duplex: "half",
  } as RequestInit);
}

function status(id: string): StatusJson {
  const paths = meetingPaths(id);
  return {
    id,
    title: "기존 검색 회의",
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
    review: { participants: [] },
    updatedAt: "2026-07-12T00:31:00.000Z",
  };
}

async function seedMeeting(
  id: string,
  options: { summary?: string; status?: string } = {},
): Promise<void> {
  const paths = meetingPaths(id);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.transcript, "기존 회의 전사\n");
  await writeFile(paths.summary, options.summary ?? `${JSON.stringify(SUMMARY)}\n`);
  await writeFile(paths.status, options.status ?? `${JSON.stringify(status(id))}\n`);
}

interface SafeResult {
  status: "ready" | "partial" | "unavailable";
  reasons: Array<"missing" | "stale" | "corrupt" | "io_error">;
  count: { total: number; indexed: number; skipped: number };
  durability: "durable" | "best_effort" | "pending" | null;
}

function expectSafeResultShape(body: unknown): asserts body is SafeResult {
  const result = body as Partial<SafeResult>;
  expect(Object.keys(result).sort()).toEqual(["count", "durability", "reasons", "status"]);
  expect(["ready", "partial", "unavailable"]).toContain(result.status);
  expect(result.reasons).toEqual(expect.any(Array));
  expect(result.reasons?.every((reason) => (
    ["missing", "stale", "corrupt", "io_error"].includes(reason)
  ))).toBe(true);
  expect(result.count).toEqual({
    total: expect.any(Number),
    indexed: expect.any(Number),
    skipped: expect.any(Number),
  });
  expect(result.durability === null
    || ["durable", "best_effort", "pending"].includes(String(result.durability))).toBe(true);
}

beforeEach(async () => {
  originalCwd = process.cwd();
  workDir = await mkdtemp(join(tmpdir(), "knowledge-reindex-route-"));
  process.chdir(workDir);
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

describe("knowledge reindex route", () => {
  it("uses the Node dynamic contract and rejects before filesystem work when the local guard fails", async () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    const denied = await reindexKnowledge(request("{", { origin: "http://evil.example" }));

    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(existsSync(dataRoot())).toBe(false);
  });

  it("reindexes one existing meeting synchronously with a no-store safe result", async () => {
    await seedMeeting("meeting-one");
    const response = await reindexKnowledge(request(JSON.stringify({
      scope: "meeting",
      meetingId: "meeting-one",
    })));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expectSafeResultShape(body);
    expect(body).toEqual({
      status: "ready",
      reasons: [],
      count: { total: 1, indexed: 1, skipped: 0 },
      durability: "durable",
    });
    expect(JSON.parse(await readFile(knowledgeCardPath("meeting-one"), "utf8")))
      .toMatchObject({ meetingId: "meeting-one" });
  });

  it("reindexes all live meetings and commits one bounded corpus map", async () => {
    await seedMeeting("meeting-a");
    await seedMeeting("meeting-b");
    const response = await reindexKnowledge(request(JSON.stringify({ scope: "all" })));
    const body = await response.json();

    expectSafeResultShape(body);
    expect(body).toEqual({
      status: "ready",
      reasons: [],
      count: { total: 2, indexed: 2, skipped: 0 },
      durability: "durable",
    });
    expect(JSON.parse(await readFile(corpusMapPath(), "utf8")).cards.map(
      (card: { meetingId: string }) => card.meetingId,
    )).toEqual(["meeting-a", "meeting-b"]);
  });

  it("excludes tombstoned, corrupt, and unsafe records while returning only safe partial data", async () => {
    await seedMeeting("meeting-live");
    await seedMeeting("meeting-deleted");
    await createMeetingTombstoneStore({ dataRoot: dataRoot() }).create("meeting-deleted");
    await seedMeeting("meeting-corrupt", { status: "{" });
    await mkdir(meetingsRoot(), { recursive: true });
    const outside = join(workDir, "outside-record");
    await mkdir(outside);
    await symlink(outside, meetingPaths("meeting-unsafe").dir, "dir");

    const response = await reindexKnowledge(request(JSON.stringify({ scope: "all" })));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expectSafeResultShape(body);
    expect(body).toEqual({
      status: "partial",
      reasons: ["corrupt", "io_error"],
      count: { total: 4, indexed: 1, skipped: 3 },
      durability: "durable",
    });
    expect(serialized).not.toContain(workDir);
    expect(serialized).not.toContain("status.json");
    expect(existsSync(knowledgeCardPath("meeting-deleted"))).toBe(false);
    expect(existsSync(knowledgeCardPath("meeting-corrupt"))).toBe(false);
    expect(existsSync(knowledgeCardPath("meeting-unsafe"))).toBe(false);
    expect(JSON.parse(await readFile(corpusMapPath(), "utf8")).cards).toEqual([
      expect.objectContaining({ meetingId: "meeting-live" }),
    ]);
  });

  it("returns unavailable missing/corrupt reasons without raw source or filesystem details", async () => {
    await mkdir(dataRoot(), { recursive: true });
    const missing = await reindexKnowledge(request(JSON.stringify({
      scope: "meeting",
      meetingId: "meeting-missing",
    })));
    const missingBody = await missing.json();
    expectSafeResultShape(missingBody);
    expect(missingBody).toEqual({
      status: "unavailable",
      reasons: ["missing"],
      count: { total: 1, indexed: 0, skipped: 1 },
      durability: "durable",
    });

    await seedMeeting("meeting-tombstoned");
    await createMeetingTombstoneStore({ dataRoot: dataRoot() }).create("meeting-tombstoned");
    const deleted = await reindexKnowledge(request(JSON.stringify({
      scope: "meeting",
      meetingId: "meeting-tombstoned",
    })));
    await expect(deleted.json()).resolves.toEqual({
      status: "unavailable",
      reasons: ["missing"],
      count: { total: 1, indexed: 0, skipped: 1 },
      durability: "durable",
    });

    await seedMeeting("meeting-bad-source", {
      summary: "/private/secret/summary.json is not JSON",
    });
    const corrupt = await reindexKnowledge(request(JSON.stringify({
      scope: "meeting",
      meetingId: "meeting-bad-source",
    })));
    const corruptBody = await corrupt.json();
    expectSafeResultShape(corruptBody);
    expect(corruptBody).toMatchObject({
      status: "unavailable",
      reasons: ["corrupt"],
      count: { total: 1, indexed: 0, skipped: 1 },
    });
    expect(JSON.stringify(corruptBody)).not.toContain("/private/secret");
  });

  it("rejects invalid JSON, exact-content-type violations, unknown fields, and bodies over 8 KiB", async () => {
    const malformed = await reindexKnowledge(request("{"));
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");

    const contentType = await reindexKnowledge(request(
      JSON.stringify({ scope: "all" }),
      { "content-type": "text/plain" },
    ));
    expect(contentType.status).toBe(415);

    const unknown = await reindexKnowledge(request(JSON.stringify({ scope: "all", path: "/tmp" })));
    expect(unknown.status).toBe(400);

    const oversized = await reindexKnowledge(request(JSON.stringify({
      scope: "meeting",
      meetingId: "meeting-one",
      padding: "x".repeat(8 * 1024),
    })));
    expect(oversized.status).toBe(413);
  });
});
