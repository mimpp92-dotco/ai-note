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
  MANUAL_EDITING_FIXTURE_ID,
  MANUAL_EDITING_PROJECTS,
  installManualEditingFixture,
  manualEditingMeetingForProject,
} from "../e2e-manual-editing-fixture.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function snapshotRoot({ data = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ai-note-e2e-"));
  roots.push(root);
  if (data) await mkdir(join(root, "data"));
  return root;
}

describe("manual editing synthetic fixture", () => {
  it("requires an absolute, existing, runner-owned real snapshot root", async () => {
    await expect(installManualEditingFixture({ env: {} })).rejects.toThrow(
      "AI_NOTE_E2E_SNAPSHOT_ROOT",
    );
    await expect(installManualEditingFixture({
      env: { AI_NOTE_E2E_SNAPSHOT_ROOT: join(tmpdir(), "ai-note-e2e-missing-root") },
    })).rejects.toThrow();

    const wrapper = await mkdtemp(join(tmpdir(), "manual-fixture-wrapper-"));
    roots.push(wrapper);
    const realRoot = join(wrapper, "ai-note-e2e-real");
    const linkedRoot = join(wrapper, "ai-note-e2e-linked");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, "dir");
    await expect(installManualEditingFixture({
      env: { AI_NOTE_E2E_SNAPSHOT_ROOT: linkedRoot },
    })).rejects.toThrow("real directory");
  });

  it("refuses a missing data directory and unknown pre-existing content", async () => {
    const missingData = await snapshotRoot({ data: false });
    await expect(installManualEditingFixture({
      env: { AI_NOTE_E2E_SNAPSHOT_ROOT: missingData },
    })).rejects.toThrow("data directory");

    const unknown = await snapshotRoot();
    await writeFile(join(unknown, "data", "unknown.json"), "{}\n");
    await expect(installManualEditingFixture({
      env: { AI_NOTE_E2E_SNAPSHOT_ROOT: unknown },
    })).rejects.toThrow("unknown existing content");
  });

  it("creates exactly three isolated viewport meetings and is idempotent only with its exact sentinel", async () => {
    const root = await snapshotRoot();
    const env = { AI_NOTE_E2E_SNAPSHOT_ROOT: root };

    await installManualEditingFixture({ env });

    expect((await readdir(join(root, "data"))).sort()).toEqual([
      ".manual-editing-fixture.json",
      "library.json",
      "meetings",
    ]);
    const library = JSON.parse(await readFile(join(root, "data", "library.json"), "utf8"));
    expect(library.placements).toHaveLength(3);
    expect(library.placements.map((placement) => placement.meetingId).sort()).toEqual(
      MANUAL_EDITING_PROJECTS.map((project) => project.meetingId).sort(),
    );
    expect(new Set(MANUAL_EDITING_PROJECTS.map((project) => project.meetingId)).size).toBe(3);

    for (const project of MANUAL_EDITING_PROJECTS) {
      const meetingRoot = join(root, "data", "meetings", project.meetingId);
      expect((await lstat(meetingRoot)).isDirectory()).toBe(true);
      expect((await lstat(join(meetingRoot, "status.json"))).isFile()).toBe(true);
      expect((await lstat(join(meetingRoot, "transcript.md"))).isFile()).toBe(true);
      expect((await lstat(join(meetingRoot, "summary.json"))).isFile()).toBe(true);
    }

    const before = await readFile(join(root, "data", "library.json"), "utf8");
    await installManualEditingFixture({ env });
    expect(await readFile(join(root, "data", "library.json"), "utf8")).toBe(before);

    const sentinelPath = join(root, "data", ".manual-editing-fixture.json");
    const sentinel = JSON.parse(await readFile(sentinelPath, "utf8"));
    expect(sentinel.fixtureId).toBe(MANUAL_EDITING_FIXTURE_ID);
    await writeFile(sentinelPath, JSON.stringify({ ...sentinel, fixtureId: "unknown" }));
    await expect(installManualEditingFixture({ env })).rejects.toThrow("sentinel");
  });

  it("maps only the three configured Playwright projects to their own meeting", () => {
    for (const project of MANUAL_EDITING_PROJECTS) {
      expect(manualEditingMeetingForProject(project.projectName)).toEqual(project);
    }
    expect(() => manualEditingMeetingForProject("tablet-768")).toThrow("viewport fixture");
    expect(dirname(new URL(import.meta.url).pathname)).not.toContain("/data/");
  });
});
