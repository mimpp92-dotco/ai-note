// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetArtifactLeaseStateForTests } from "@/lib/artifactLease";
import { createLibraryRepository, resetLibraryRepositoryStateForTests } from "@/lib/library";
import {
  resetMeetingCleanupStateForTests,
  sweepMeetingTombstones,
} from "@/lib/meetingCleanup";
import { resetMeetingLifecycleForTests } from "@/lib/meetingLifecycle";
import {
  getMeetingTombstoneStore,
  resetMeetingTombstoneStateForTests,
} from "@/lib/meetingTombstone";
import { dataRoot, meetingPaths } from "@/lib/paths";
import { initialStatus, writeStatus } from "@/lib/status";
import { resetStatusUpdaterStateForTests } from "@/lib/statusUpdater";

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "meeting-cleanup-"));
  process.chdir(workDir);
  resetArtifactLeaseStateForTests();
  resetMeetingCleanupStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
  resetLibraryRepositoryStateForTests();
  resetStatusUpdaterStateForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  resetArtifactLeaseStateForTests();
  resetMeetingCleanupStateForTests();
  resetMeetingLifecycleForTests();
  resetMeetingTombstoneStateForTests();
  resetLibraryRepositoryStateForTests();
  resetStatusUpdaterStateForTests();
  rmSync(workDir, { recursive: true, force: true });
});

async function seed(id: string) {
  await mkdir(meetingPaths(id).dir, { recursive: true });
  await writeFile(meetingPaths(id).audio, "late audio");
  await writeStatus(id, initialStatus(id, {
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T00:01:00.000Z",
    durationMs: 60_000,
    audioMime: "audio/webm",
  }));
}

describe("restart tombstone cleanup sweep", () => {
  it("removes a late live directory and its placement while preserving the tombstone", async () => {
    const id = "meeting-late-orphan";
    await seed(id);
    const repository = createLibraryRepository({ dataRoot: dataRoot() });
    const bootstrapped = await repository.bootstrap();
    expect(bootstrapped.mode).toBe("ready");
    await getMeetingTombstoneStore().create(id);

    const result = await sweepMeetingTombstones(dataRoot());
    expect(result).toMatchObject({ inspected: 1, cleaned: 1, pending: 0 });
    expect(existsSync(meetingPaths(id).dir)).toBe(false);
    expect(existsSync(join(dataRoot(), "meeting-tombstones", `${id}.json`))).toBe(true);
    const library = JSON.parse(await readFile(join(dataRoot(), "library.json"), "utf8"));
    expect(library.placements).toEqual([]);
  });

  it("leaves unrelated and symlink trash entries untouched", async () => {
    const meetings = join(dataRoot(), "meetings");
    await mkdir(meetings, { recursive: true });
    const unrelated = join(meetings, ".trash-not-ours-extra");
    await mkdir(unrelated);
    const outside = join(workDir, "outside");
    await mkdir(outside);
    const unsafe = join(meetings, ".trash-meeting-unsafe");
    await symlink(outside, unsafe);
    await getMeetingTombstoneStore().create("meeting-unsafe");

    const result = await sweepMeetingTombstones(dataRoot());
    expect(result.pending).toBe(1);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(unsafe)).toBe(true);
  });
});
