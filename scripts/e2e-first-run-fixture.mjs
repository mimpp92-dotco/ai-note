import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  MANUAL_EDITING_FIXTURE_ID,
  MANUAL_EDITING_PROJECTS,
  MANUAL_EDITING_WORKSPACE_ID,
} from "./e2e-manual-editing-fixture.mjs";
import {
  assertRealDirectory,
  resolveE2eSnapshotRoot,
} from "./e2e-harness.mjs";

export const FIRST_RUN_FIXTURE_ID = "ai-note-synthetic-first-run-v1";
export const FIRST_RUN_PROJECTS = Object.freeze([
  Object.freeze({
    projectName: "desktop-1440",
    meetingId: "synthetic-first-run-desktop-1440",
    title: "합성 전사 실패 데스크톱 회의 — 실제 사용자 데이터 아님",
  }),
  Object.freeze({
    projectName: "mobile-390",
    meetingId: "synthetic-first-run-mobile-390",
    title: "합성 전사 실패 모바일 390 회의 — 실제 사용자 데이터 아님",
  }),
  Object.freeze({
    projectName: "mobile-320",
    meetingId: "synthetic-first-run-mobile-320",
    title: "합성 전사 실패 모바일 320 회의 — 실제 사용자 데이터 아님",
  }),
]);

const MANUAL_SENTINEL_NAME = ".manual-editing-fixture.json";
const FIRST_RUN_SENTINEL_NAME = ".first-run-fixture.json";
const CREATED_AT = "2026-07-15T00:00:00.000Z";
const EXPECTED_MANUAL_SENTINEL = jsonText({
  schemaVersion: 1,
  fixtureId: MANUAL_EDITING_FIXTURE_ID,
  projects: MANUAL_EDITING_PROJECTS.map(({ projectName, meetingId }) => ({
    projectName,
    meetingId,
  })),
});
const EXPECTED_FIRST_RUN_SENTINEL = jsonText({
  schemaVersion: 1,
  fixtureId: FIRST_RUN_FIXTURE_ID,
  projects: FIRST_RUN_PROJECTS.map(({ projectName, meetingId }) => ({
    projectName,
    meetingId,
  })),
});

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sorted(values) {
  return [...values].sort();
}

function sameEntries(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

async function assertRegularFile(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`first-run viewport fixture ${label} must be a regular file`);
  }
}

async function readExactSentinel(path, expected, label) {
  try {
    await assertRegularFile(path, `${label} sentinel`);
    if (await readFile(path, "utf8") !== expected) {
      throw new Error(`${label} sentinel does not match exactly`);
    }
  } catch (error) {
    throw new Error(`first-run fixture ${label} sentinel does not match exactly`, {
      cause: error,
    });
  }
}

async function readLibrary(dataRoot) {
  const path = join(dataRoot, "library.json");
  try {
    await assertRegularFile(path, "library");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object"
      || value === null
      || !Array.isArray(value.placements)
      || !Array.isArray(value.workspaces)
      || !Array.isArray(value.folders)
      || value.defaultWorkspaceId !== MANUAL_EDITING_WORKSPACE_ID
    ) {
      throw new Error("invalid library");
    }
    return value;
  } catch (error) {
    throw new Error("first-run fixture requires the manual editing library", {
      cause: error,
    });
  }
}

async function assertManualFixture(dataRoot, library) {
  await readExactSentinel(
    join(dataRoot, MANUAL_SENTINEL_NAME),
    EXPECTED_MANUAL_SENTINEL,
    "manual editing",
  );
  const meetingsRoot = join(dataRoot, "meetings");
  await assertRealDirectory(meetingsRoot, "manual editing meetings");
  const placementIds = new Set(library.placements.map((placement) => placement?.meetingId));
  for (const project of MANUAL_EDITING_PROJECTS) {
    if (!placementIds.has(project.meetingId)) {
      throw new Error(`first-run fixture manual editing placement is missing: ${project.projectName}`);
    }
    const root = join(meetingsRoot, project.meetingId);
    await assertRealDirectory(root, `manual editing viewport ${project.projectName}`);
    await assertRegularFile(join(root, "status.json"), `${project.projectName} manual status`);
    await assertRegularFile(join(root, "transcript.md"), `${project.projectName} manual transcript`);
    await assertRegularFile(join(root, "summary.json"), `${project.projectName} manual summary`);
  }
}

function statusFor(project, meetingRoot, index) {
  const startedAt = `2026-07-${String(8 - index).padStart(2, "0")}T0${index + 1}:00:00.000Z`;
  return {
    id: project.meetingId,
    title: project.title,
    status: "recorded",
    error: {
      message: "합성 브라우저 검증용 전사 실패입니다.",
      action: "retry_transcription",
    },
    startedAt,
    endedAt: startedAt,
    durationMs: 480_000 + index * 60_000,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 0 },
    paths: {
      audio: join(meetingRoot, "audio.webm"),
      play: join(meetingRoot, "play.webm"),
      raw: join(meetingRoot, "raw.md"),
      transcript: join(meetingRoot, "transcript.md"),
      summary: join(meetingRoot, "summary.json"),
      segments: join(meetingRoot, "segments.json"),
    },
    review: { participants: [] },
    updatedAt: CREATED_AT,
  };
}

async function assertInstalledFixture(dataRoot, library) {
  await readExactSentinel(
    join(dataRoot, FIRST_RUN_SENTINEL_NAME),
    EXPECTED_FIRST_RUN_SENTINEL,
    "first-run",
  );
  await assertManualFixture(dataRoot, library);
  const meetingsRoot = join(dataRoot, "meetings");
  const expectedMeetings = [
    ...MANUAL_EDITING_PROJECTS.map((project) => project.meetingId),
    ...FIRST_RUN_PROJECTS.map((project) => project.meetingId),
  ];
  if (!sameEntries(await readdir(meetingsRoot), expectedMeetings)) {
    throw new Error("first-run fixture refuses unknown existing content");
  }
  const placementIds = new Set(library.placements.map((placement) => placement?.meetingId));
  for (const project of FIRST_RUN_PROJECTS) {
    if (!placementIds.has(project.meetingId)) {
      throw new Error(`first-run viewport fixture placement is missing: ${project.projectName}`);
    }
    const root = join(meetingsRoot, project.meetingId);
    await assertRealDirectory(root, `first-run viewport ${project.projectName}`);
    if (!sameEntries(await readdir(root), ["status.json"])) {
      throw new Error("first-run fixture refuses unknown existing content");
    }
    await assertRegularFile(join(root, "status.json"), `${project.projectName} status`);
  }
}

export function firstRunMeetingForProject(projectName) {
  const project = FIRST_RUN_PROJECTS.find((candidate) => candidate.projectName === projectName);
  if (!project) throw new Error(`first-run viewport fixture is missing: ${projectName}`);
  return project;
}

export async function installFirstRunFixture({ env = process.env } = {}) {
  const snapshotRoot = resolveE2eSnapshotRoot(env.AI_NOTE_E2E_SNAPSHOT_ROOT);
  await assertRealDirectory(snapshotRoot, "snapshot root");
  const dataRoot = join(snapshotRoot, "data");
  try {
    await assertRealDirectory(dataRoot, "first-run data directory");
  } catch (error) {
    throw new Error("first-run fixture requires the runner-owned data directory", {
      cause: error,
    });
  }

  const dataEntries = await readdir(dataRoot);
  const freshEntries = [MANUAL_SENTINEL_NAME, "library.json", "meetings"];
  const installedEntries = [FIRST_RUN_SENTINEL_NAME, ...freshEntries];
  if (dataEntries.length === 0) {
    throw new Error("first-run fixture requires the manual editing fixture");
  }
  if (!sameEntries(dataEntries, freshEntries) && !sameEntries(dataEntries, installedEntries)) {
    throw new Error("first-run fixture refuses unknown existing content");
  }

  const library = await readLibrary(dataRoot);
  await assertManualFixture(dataRoot, library);
  if (dataEntries.includes(FIRST_RUN_SENTINEL_NAME)) {
    await assertInstalledFixture(dataRoot, library);
    return;
  }

  const meetingsRoot = join(dataRoot, "meetings");
  const manualMeetingIds = MANUAL_EDITING_PROJECTS.map((project) => project.meetingId);
  if (!sameEntries(await readdir(meetingsRoot), manualMeetingIds)) {
    throw new Error("first-run fixture refuses unknown existing content");
  }

  for (const [index, project] of FIRST_RUN_PROJECTS.entries()) {
    const meetingRoot = join(meetingsRoot, project.meetingId);
    await mkdir(meetingRoot, { mode: 0o700 });
    await writeFile(
      join(meetingRoot, "status.json"),
      jsonText(statusFor(project, meetingRoot, index)),
      { mode: 0o600 },
    );
    library.placements.push({
      meetingId: project.meetingId,
      workspaceId: MANUAL_EDITING_WORKSPACE_ID,
      folderId: null,
    });
  }

  await writeFile(join(dataRoot, "library.json"), jsonText(library), { mode: 0o600 });
  await writeFile(
    join(dataRoot, FIRST_RUN_SENTINEL_NAME),
    EXPECTED_FIRST_RUN_SENTINEL,
    { mode: 0o600 },
  );
}
