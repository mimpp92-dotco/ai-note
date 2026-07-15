import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  assertRealDirectory,
  resolveE2eSnapshotRoot,
} from "./e2e-harness.mjs";

export const MANUAL_EDITING_FIXTURE_ID = "ai-note-synthetic-library-v1";
export const MANUAL_EDITING_PROJECTS = Object.freeze([
  Object.freeze({
    projectName: "desktop-1440",
    meetingId: "synthetic-manual-desktop-1440",
    title: "합성 데스크톱 회의 — 실제 사용자 데이터 아님",
    participant: "가상 참석자 데스크톱",
  }),
  Object.freeze({
    projectName: "mobile-390",
    meetingId: "synthetic-manual-mobile-390",
    title: "합성 모바일 390 회의 — 실제 사용자 데이터 아님",
    participant: "가상 참석자 모바일 390",
  }),
  Object.freeze({
    projectName: "mobile-320",
    meetingId: "synthetic-manual-mobile-320",
    title: "합성 모바일 320 회의 — 실제 사용자 데이터 아님",
    participant: "가상 참석자 모바일 320",
  }),
]);

const SENTINEL_NAME = ".manual-editing-fixture.json";
const LIBRARY_ID = "70000000-0000-4000-8000-000000000001";
export const MANUAL_EDITING_WORKSPACE_ID = "70000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-07-15T00:00:00.000Z";
const EXPECTED_SENTINEL = `${JSON.stringify({
  schemaVersion: 1,
  fixtureId: MANUAL_EDITING_FIXTURE_ID,
  projects: MANUAL_EDITING_PROJECTS.map(({ projectName, meetingId }) => ({
    projectName,
    meetingId,
  })),
}, null, 2)}\n`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function transcriptFor(project) {
  const longCjk = "합성데이터긴문장경계검증".repeat(18);
  const longEnglish = "SyntheticManualEditingOverflowBoundary".repeat(10);
  return [
    `# ${project.title}`,
    "이 문서는 결정적 브라우저 검증을 위해 만든 명백한 합성 스크립트입니다.",
    "첫 번째 안건은 전체 스크립트와 회의록 요약의 작업 위계를 확인하는 것입니다.\n두 번째 줄은 textarea의 개행 보존을 확인합니다.",
    `${longCjk}\n${longEnglish}`,
    "마지막 문단은 수정 전 요약이 스크립트 저장 뒤에도 보존되는지 확인하기 위한 가짜 내용입니다.",
  ].join("\n\n");
}

function summaryFor(project) {
  return {
    title: project.title,
    topicSlug: project.meetingId,
    oneLine: "합성 회의에서 수동 편집과 안전한 이탈 보호를 검증한다.",
    purpose: "실제 사용자 데이터 없이 전체 스크립트와 회의록 요약 편집 흐름을 검증한다.",
    participants: [],
    highlights: ["첫 줄 핵심\n둘째 줄 핵심"],
    discussion: ["전역 작업과 탭 전용 작업을 분리한다."],
    decisions: ["저장되지 않은 draft는 명시적 확인 없이 버리지 않는다."],
    actionItems: [{ owner: project.participant, task: "합성 시나리오 확인", due: "2026-07-31" }],
    risks: ["긴 한글과 영문 문자열이 좁은 화면에서 넘칠 수 있다."],
    followups: ["세 viewport의 결정적 증거를 확인한다."],
  };
}

function statusFor(project, meetingRoot, transcript, summaryText, index) {
  const transcriptHash = sha256(transcript);
  const summaryHash = sha256(summaryText);
  const startedAt = `2026-07-${String(12 - index).padStart(2, "0")}T0${index + 1}:00:00.000Z`;
  return {
    id: project.meetingId,
    title: project.title,
    status: "summarized",
    error: null,
    startedAt,
    endedAt: startedAt,
    durationMs: 900_000 + index * 60_000,
    audioMime: "audio/webm",
    whisper: { jobId: null, progress: 1 },
    paths: {
      audio: join(meetingRoot, "audio.webm"),
      play: join(meetingRoot, "play.webm"),
      raw: join(meetingRoot, "raw.md"),
      transcript: join(meetingRoot, "transcript.md"),
      summary: join(meetingRoot, "summary.json"),
      segments: join(meetingRoot, "segments.json"),
    },
    review: { participants: [project.participant] },
    contentRevision: {
      transcript: { source: "generated", sha256: transcriptHash, updatedAt: CREATED_AT },
      summary: {
        source: "generated",
        sha256: summaryHash,
        basedOnTranscriptSha256: transcriptHash,
        updatedAt: CREATED_AT,
      },
    },
    updatedAt: CREATED_AT,
  };
}

async function assertRegularFile(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`manual editing viewport fixture ${label} must be a regular file`);
  }
}

async function assertInstalledFixture(dataRoot) {
  await assertRegularFile(join(dataRoot, "library.json"), "library");
  await assertRealDirectory(join(dataRoot, "meetings"), "manual editing meetings");
  for (const project of MANUAL_EDITING_PROJECTS) {
    const root = join(dataRoot, "meetings", project.meetingId);
    await assertRealDirectory(root, `viewport fixture ${project.projectName}`);
    await assertRegularFile(join(root, "status.json"), `${project.projectName} status`);
    await assertRegularFile(join(root, "transcript.md"), `${project.projectName} transcript`);
    await assertRegularFile(join(root, "summary.json"), `${project.projectName} summary`);
  }
}

export function manualEditingMeetingForProject(projectName) {
  const project = MANUAL_EDITING_PROJECTS.find((candidate) => candidate.projectName === projectName);
  if (!project) throw new Error(`manual editing viewport fixture is missing: ${projectName}`);
  return project;
}

export async function installManualEditingFixture({ env = process.env } = {}) {
  const snapshotRoot = resolveE2eSnapshotRoot(env.AI_NOTE_E2E_SNAPSHOT_ROOT);
  await assertRealDirectory(snapshotRoot, "snapshot root");
  const dataRoot = join(snapshotRoot, "data");
  try {
    await assertRealDirectory(dataRoot, "manual editing data directory");
  } catch (error) {
    throw new Error("manual editing fixture requires the runner-owned data directory", {
      cause: error,
    });
  }

  const entries = await readdir(dataRoot);
  if (entries.length > 0) {
    const sentinelPath = join(dataRoot, SENTINEL_NAME);
    let sentinel;
    try {
      await assertRegularFile(sentinelPath, "sentinel");
      sentinel = await readFile(sentinelPath, "utf8");
    } catch (error) {
      throw new Error("manual editing fixture refuses unknown existing content", { cause: error });
    }
    if (sentinel !== EXPECTED_SENTINEL) {
      throw new Error("manual editing fixture sentinel does not match exactly");
    }
    await assertInstalledFixture(dataRoot);
    return;
  }

  const meetingsRoot = join(dataRoot, "meetings");
  await mkdir(meetingsRoot, { mode: 0o700 });
  const placements = [];
  for (const [index, project] of MANUAL_EDITING_PROJECTS.entries()) {
    const meetingRoot = join(meetingsRoot, project.meetingId);
    await mkdir(meetingRoot, { mode: 0o700 });
    const transcript = transcriptFor(project);
    const summaryText = jsonText(summaryFor(project));
    await writeFile(join(meetingRoot, "transcript.md"), transcript, { mode: 0o600 });
    await writeFile(join(meetingRoot, "summary.json"), summaryText, { mode: 0o600 });
    await writeFile(
      join(meetingRoot, "status.json"),
      jsonText(statusFor(project, meetingRoot, transcript, summaryText, index)),
      { mode: 0o600 },
    );
    placements.push({
      meetingId: project.meetingId,
      workspaceId: MANUAL_EDITING_WORKSPACE_ID,
      folderId: null,
    });
  }

  await writeFile(join(dataRoot, "library.json"), jsonText({
    schemaVersion: 1,
    libraryId: LIBRARY_ID,
    revision: 0,
    defaultWorkspaceId: MANUAL_EDITING_WORKSPACE_ID,
    workspaces: [{
      id: MANUAL_EDITING_WORKSPACE_ID,
      name: "합성 브라우저 검증 워크스페이스",
      order: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }],
    folders: [],
    placements,
  }), { mode: 0o600 });
  await writeFile(join(dataRoot, SENTINEL_NAME), EXPECTED_SENTINEL, { mode: 0o600 });
}
