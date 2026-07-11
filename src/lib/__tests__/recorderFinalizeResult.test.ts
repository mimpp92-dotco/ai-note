import { describe, expect, it } from "vitest";

import { describeRecorderFinalizeResult } from "@/lib/recorderFinalizeResult";

const base = {
  artifact: "published" as const,
  durability: "durable" as const,
  playback: "ready" as const,
  transcription: "accepted" as const,
  placement: {
    requested: { workspaceId: "10000000-0000-4000-8000-000000000001", folderId: null },
    actual: { workspaceId: "10000000-0000-4000-8000-000000000001", folderId: null },
    outcome: "saved" as const,
    fallbackReason: null,
  },
};

describe("recorder finalize result semantics", () => {
  it("never offers reupload for pending/best-effort published artifacts", () => {
    expect(describeRecorderFinalizeResult({ ...base, durability: "pending" }).actions)
      .not.toContain("retry_upload");
    expect(describeRecorderFinalizeResult({ ...base, durability: "best_effort" })).toMatchObject({
      artifactTone: "warning",
      actions: expect.not.arrayContaining(["retry_upload"]),
    });
  });

  it("separates playback, placement, and transcription recovery actions", () => {
    expect(describeRecorderFinalizeResult({
      ...base,
      playback: "failed",
      transcription: "failed",
      placement: { ...base.placement, actual: null, outcome: "unavailable" },
    }).actions).toEqual(expect.arrayContaining([
      "retry_playback",
      "retry_placement",
      "retry_transcription",
      "open_organization_pending",
    ]));
  });

  it("does not offer placement retry when the immutable receipt has no requested location", () => {
    const result = describeRecorderFinalizeResult({
      ...base,
      placement: {
        requested: null,
        actual: null,
        outcome: "unavailable",
        fallbackReason: null,
      },
    });
    expect(result.actions).not.toContain("retry_placement");
    expect(result.actions).toContain("refresh_actual");
  });
});
