// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { meetingPaths } from "@/lib/paths";
import { inspectTranscriptionPublication } from "@/lib/transcriptionArtifacts";

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "transcription-artifacts-"));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

async function seedNewProtocol(id: string, options: {
  phase?: "accepted" | "segments_published" | "raw_published";
  durability?: "pending" | "durable" | "best_effort";
  raw?: boolean;
  segments?: boolean;
} = {}) {
  const paths = meetingPaths(id);
  await mkdir(paths.dir, { recursive: true });
  const audio = Buffer.from("audio");
  await writeFile(paths.audio, audio);
  if (options.segments ?? true) await writeFile(paths.segments, "[]\n");
  if (options.raw ?? true) await writeFile(paths.raw, "transcript\n");
  const dispatchId = randomUUID();
  await writeFile(join(paths.dir, ".whisper-dispatch.json"), `${JSON.stringify({
    schemaVersion: 1,
    meetingId: id,
    dispatchId,
    audioSha256: createHash("sha256").update(audio).digest("hex"),
    phase: options.phase ?? "raw_published",
    durability: options.durability ?? "durable",
  })}\n`);
  return dispatchId;
}

describe("Whisper raw completion marker", () => {
  it("accepts a matching raw_published claim only when raw and segments are complete", async () => {
    const id = "meeting-complete";
    const dispatchId = await seedNewProtocol(id);
    expect(inspectTranscriptionPublication(id, dispatchId)).toMatchObject({
      state: "complete",
      legacy: false,
      dispatchId,
      durability: "durable",
    });
  });

  it.each([
    ["segments barrier", { phase: "segments_published", raw: false }],
    ["pending raw claim", { durability: "pending" }],
    ["missing segments", { segments: false }],
  ] as const)("keeps %s invisible", async (_name, options) => {
    const id = `meeting-incomplete-${_name.replaceAll(" ", "-")}`;
    const dispatchId = await seedNewProtocol(id, options);
    expect(inspectTranscriptionPublication(id, dispatchId).state).toBe("incomplete");
  });

  it("fails closed on dispatch/audio contradictions", async () => {
    const id = "meeting-contradictory";
    const dispatchId = await seedNewProtocol(id);
    expect(inspectTranscriptionPublication(id, randomUUID()).state).toBe("ambiguous");
    await writeFile(meetingPaths(id).audio, "different audio");
    expect(inspectTranscriptionPublication(id, dispatchId).state).toBe("ambiguous");
  });

  it("keeps claim-less raw as a legacy completion marker", async () => {
    const id = "meeting-legacy";
    await mkdir(meetingPaths(id).dir, { recursive: true });
    await writeFile(meetingPaths(id).raw, "legacy\n");
    expect(inspectTranscriptionPublication(id)).toEqual({
      state: "complete",
      legacy: true,
      dispatchId: null,
      durability: "best_effort",
    });
  });
});
