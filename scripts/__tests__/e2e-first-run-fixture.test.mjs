import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installManualEditingFixture,
} from "../e2e-manual-editing-fixture.mjs";
import {
  FIRST_RUN_FIXTURE_ID,
  FIRST_RUN_PROJECTS,
  firstRunMeetingForProject,
  installFirstRunFixture,
} from "../e2e-first-run-fixture.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function snapshotRoot() {
  const root = await mkdtemp(join(tmpdir(), "ai-note-e2e-"));
  roots.push(root);
  await mkdir(join(root, "data"));
  return root;
}

async function manualSnapshot() {
  const root = await snapshotRoot();
  const env = { AI_NOTE_E2E_SNAPSHOT_ROOT: root };
  await installManualEditingFixture({ env });
  return { root, env };
}

describe("installation and first-run synthetic fixture", () => {
  it("requires an absolute, existing, runner-owned real snapshot root", async () => {
    await expect(installFirstRunFixture({ env: {} })).rejects.toThrow(
      "AI_NOTE_E2E_SNAPSHOT_ROOT",
    );
    await expect(installFirstRunFixture({
      env: { AI_NOTE_E2E_SNAPSHOT_ROOT: join(tmpdir(), "ai-note-e2e-missing-first-run") },
    })).rejects.toThrow();

    const wrapper = await mkdtemp(join(tmpdir(), "first-run-fixture-wrapper-"));
    roots.push(wrapper);
    const realRoot = join(wrapper, "ai-note-e2e-real");
    const linkedRoot = join(wrapper, "ai-note-e2e-linked");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, "dir");
    await expect(installFirstRunFixture({
      env: { AI_NOTE_E2E_SNAPSHOT_ROOT: linkedRoot },
    })).rejects.toThrow("real directory");
  });

  it("requires the exact installed manual-editing fixture before adding first-run state", async () => {
    const empty = await snapshotRoot();
    await expect(installFirstRunFixture({
      env: { AI_NOTE_E2E_SNAPSHOT_ROOT: empty },
    })).rejects.toThrow("manual editing fixture");

    const { root, env } = await manualSnapshot();
    await writeFile(
      join(root, "data", ".manual-editing-fixture.json"),
      JSON.stringify({ fixtureId: "tampered" }),
    );
    await expect(installFirstRunFixture({ env })).rejects.toThrow("manual editing sentinel");
  });

  it("refuses unknown existing content and symlinks instead of resetting them", async () => {
    const unknown = await manualSnapshot();
    await writeFile(join(unknown.root, "data", "unknown.json"), "{}\n");
    await expect(installFirstRunFixture({ env: unknown.env })).rejects.toThrow(
      "unknown existing content",
    );

    const linked = await manualSnapshot();
    const meetingRoot = join(
      linked.root,
      "data",
      "meetings",
      FIRST_RUN_PROJECTS[0].meetingId,
    );
    await mkdir(meetingRoot);
    await symlink(
      join(linked.root, "data", "library.json"),
      join(meetingRoot, "status.json"),
    );
    await expect(installFirstRunFixture({ env: linked.env })).rejects.toThrow(
      "unknown existing content",
    );
  });

  it("adds one distinct transcription-failure meeting per Playwright project and preserves manual meetings", async () => {
    const { root, env } = await manualSnapshot();
    const manualLibrary = JSON.parse(
      await readFile(join(root, "data", "library.json"), "utf8"),
    );
    const manualMeetingIds = manualLibrary.placements.map((placement) => placement.meetingId);

    await installFirstRunFixture({ env });

    expect((await readdir(join(root, "data"))).sort()).toEqual([
      ".first-run-fixture.json",
      ".manual-editing-fixture.json",
      "library.json",
      "meetings",
    ]);
    const library = JSON.parse(await readFile(join(root, "data", "library.json"), "utf8"));
    expect(library.placements).toHaveLength(6);
    expect(library.placements.map((placement) => placement.meetingId)).toEqual(
      expect.arrayContaining(manualMeetingIds),
    );
    expect(new Set(FIRST_RUN_PROJECTS.map((project) => project.meetingId)).size).toBe(3);

    for (const project of FIRST_RUN_PROJECTS) {
      const rootForMeeting = join(root, "data", "meetings", project.meetingId);
      expect((await readdir(rootForMeeting)).sort()).toEqual(["status.json"]);
      expect((await lstat(join(rootForMeeting, "status.json"))).isFile()).toBe(true);
      const status = JSON.parse(
        await readFile(join(rootForMeeting, "status.json"), "utf8"),
      );
      expect(status).toMatchObject({
        id: project.meetingId,
        title: project.title,
        status: "recorded",
        error: {
          action: "retry_transcription",
          message: expect.any(String),
        },
      });
    }

    const sentinel = JSON.parse(
      await readFile(join(root, "data", ".first-run-fixture.json"), "utf8"),
    );
    expect(sentinel.fixtureId).toBe(FIRST_RUN_FIXTURE_ID);
  });

  it("is idempotent only with both exact sentinels and does not target repository data", async () => {
    const { root, env } = await manualSnapshot();
    await installFirstRunFixture({ env });
    const beforeLibrary = await readFile(join(root, "data", "library.json"), "utf8");
    const beforeStatus = await readFile(
      join(root, "data", "meetings", FIRST_RUN_PROJECTS[0].meetingId, "status.json"),
      "utf8",
    );

    await installFirstRunFixture({ env });

    expect(await readFile(join(root, "data", "library.json"), "utf8")).toBe(beforeLibrary);
    expect(await readFile(
      join(root, "data", "meetings", FIRST_RUN_PROJECTS[0].meetingId, "status.json"),
      "utf8",
    )).toBe(beforeStatus);
    expect(dirname(new URL(import.meta.url).pathname)).not.toContain("/data/");

    const sentinelPath = join(root, "data", ".first-run-fixture.json");
    const sentinel = JSON.parse(await readFile(sentinelPath, "utf8"));
    await writeFile(sentinelPath, JSON.stringify({ ...sentinel, fixtureId: "unknown" }));
    await expect(installFirstRunFixture({ env })).rejects.toThrow("first-run sentinel");
  });

  it("maps only the three configured Playwright projects to their own failure meeting", () => {
    for (const project of FIRST_RUN_PROJECTS) {
      expect(firstRunMeetingForProject(project.projectName)).toEqual(project);
    }
    expect(() => firstRunMeetingForProject("tablet-768")).toThrow("viewport fixture");
  });
});
