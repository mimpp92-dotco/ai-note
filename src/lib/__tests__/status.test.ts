// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StatusJson } from "@/domain/meeting";
import { meetingPaths } from "@/lib/paths";
import { deriveStatus, initialStatus } from "@/lib/status";

// deriveStatus reads artifact files under meetingsRoot() = cwd/data/meetings, so
// isolate by chdir-ing into a temp dir (same harness as settings.test.ts).

let workDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "status-"));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

function base(id: string, over: Partial<StatusJson> = {}): StatusJson {
  return {
    ...initialStatus(id, {
      startedAt: "2026-07-05T13:30:00.000Z",
      endedAt: "2026-07-05T14:00:00.000Z",
      durationMs: 1_800_000,
      audioMime: "audio/webm",
    }),
    ...over,
  };
}

async function seedSummary(id: string, title: string) {
  const p = meetingPaths(id);
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.summary, JSON.stringify({ title }) + "\n");
}

async function seedRaw(id: string) {
  const p = meetingPaths(id);
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.raw, "raw transcript\n");
}

describe("deriveStatus — titleOverride", () => {
  it("titleOverride wins over summary.title when summary.json exists", async () => {
    const id = "m-override-summary";
    await seedSummary(id, "AI가 만든 제목");
    const { status, changed } = deriveStatus(
      id,
      base(id, { status: "summarized", title: "AI가 만든 제목", titleOverride: "내가 고친 제목" }),
    );
    expect(status.title).toBe("내가 고친 제목");
    expect(status.status).toBe("summarized");
    expect(changed).toBe(true);
  });

  it("keeps titleOverride even when summary.json is absent (title survives re-derive)", async () => {
    const id = "m-override-nosummary";
    await seedRaw(id);
    const { status } = deriveStatus(
      id,
      base(id, { status: "transcribed", title: "회의 2026-07-05 13:30", titleOverride: "내가 고친 제목" }),
    );
    expect(status.title).toBe("내가 고친 제목");
    expect(status.status).toBe("transcribed");
  });

  it("does not mark changed (no write) when title already equals titleOverride", async () => {
    const id = "m-override-stable";
    await seedSummary(id, "AI가 만든 제목");
    const { status, changed } = deriveStatus(
      id,
      base(id, { status: "summarized", title: "내가 고친 제목", titleOverride: "내가 고친 제목" }),
    );
    expect(changed).toBe(false);
    expect(status.title).toBe("내가 고친 제목"); // NOT clobbered back to summary.title
  });

  it("legacy status without titleOverride still promotes summary.title", async () => {
    const id = "m-legacy-promote";
    await seedSummary(id, "AI가 만든 제목");
    const { status, changed } = deriveStatus(
      id,
      base(id, { status: "transcribed", title: "회의 2026-07-05 13:30" }),
    );
    expect(status.title).toBe("AI가 만든 제목");
    expect(status.status).toBe("summarized");
    expect(changed).toBe(true);
  });

  it("summary.json present still promotes rank to summarized even with titleOverride", async () => {
    const id = "m-override-rank";
    await seedSummary(id, "AI가 만든 제목");
    const { status } = deriveStatus(
      id,
      base(id, { status: "transcribed", title: "회의 2026-07-05 13:30", titleOverride: "내가 고친 제목" }),
    );
    expect(status.status).toBe("summarized"); // rank promotion not skipped by override
    expect(status.title).toBe("내가 고친 제목");
  });
});
