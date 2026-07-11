import { describe, expect, it, vi } from "vitest";

import type { ClassifiedMeetingRecord } from "@/domain/library";
import type { FinalizeIntent, FinalizeReceipt } from "@/lib/finalizeRecord";
import { countPendingFinalizeLocationIntents } from "@/lib/containerDeletePreview";

const WORKSPACE = "10000000-0000-4000-8000-000000000001";
const FOLDER = "30000000-0000-4000-8000-000000000003";

function record(id: string, state: "pending" | "unavailable" | "resolved"): ClassifiedMeetingRecord {
  return {
    kind: "live",
    meetingId: id,
    hasPlacement: state === "resolved",
    visible: true,
    preservePlacement: true,
    status: {
      id,
      title: id,
      status: "recorded",
      error: null,
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: null,
      durationMs: 1,
      audioMime: "audio/webm",
      whisper: { jobId: null, progress: 0 },
      placementResolution: { state, receiptHash: "a".repeat(64) },
      paths: { audio: "", play: "", raw: "", transcript: "", summary: "", segments: "" },
      review: { participants: [] },
      updatedAt: "2026-07-10T00:00:00.000Z",
    },
  };
}

function receipt(id: string, folderId: string | null): FinalizeReceipt {
  return {
    schemaVersion: 1,
    id,
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T00:00:01.000Z",
    acceptedAt: "2026-07-10T00:00:02.000Z",
    durationMs: 1,
    mimeType: "audio/webm",
    requestedLocation: { workspaceId: WORKSPACE, folderId },
    locationSource: "explicit",
    audioSha256: "b".repeat(64),
  };
}

function intent(id: string, folderId: string | null): FinalizeIntent {
  const value = receipt(id, folderId);
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    acceptedAt: value.acceptedAt,
    durationMs: value.durationMs,
    mimeType: value.mimeType,
    requestedLocation: value.requestedLocation,
    locationSource: value.locationSource,
  };
}

describe("container delete pending intent preview", () => {
  it("counts only unresolved immutable receipts that point at the requested container", async () => {
    const receipts = new Map([
      ["folder", receipt("folder", FOLDER)],
      ["workspace", receipt("workspace", null)],
      ["resolved", receipt("resolved", FOLDER)],
    ]);
    const reader = vi.fn(async (id: string) => receipts.get(id) ?? null);
    const records = [record("folder", "pending"), record("workspace", "unavailable"), record("resolved", "resolved")];
    await expect(countPendingFinalizeLocationIntents(records, {
      kind: "folder",
      workspaceId: WORKSPACE,
      folderId: FOLDER,
    }, reader, async () => [])).resolves.toBe(1);
    await expect(countPendingFinalizeLocationIntents(records, {
      kind: "workspace",
      workspaceId: WORKSPACE,
    }, reader, async () => [])).resolves.toBe(2);
  });

  it("fails closed per unreadable receipt without leaking or aborting the preview", async () => {
    const reader = vi.fn(async (id: string) => {
      if (id === "bad") throw new Error("/private/path token@example.com");
      return receipt(id, FOLDER);
    });
    await expect(countPendingFinalizeLocationIntents([
      record("bad", "pending"),
      record("good", "pending"),
    ], {
      kind: "folder",
      workspaceId: WORKSPACE,
      folderId: FOLDER,
    }, reader, async () => [])).resolves.toBe(1);
  });

  it("also counts an in-flight finalize staging intent before status publication", async () => {
    await expect(countPendingFinalizeLocationIntents([], {
      kind: "folder",
      workspaceId: WORKSPACE,
      folderId: FOLDER,
    }, async () => null, async () => [
      intent("uploading", FOLDER),
      intent("other", null),
    ])).resolves.toBe(1);
  });
});
