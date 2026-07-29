import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  normalizeAppBaseUrl,
  triggerMeetingSummarize,
} from "../meeting-summarize.mjs";

describe("meeting-summarize API-only client", () => {
  it.each([
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://localhost:4312/", "http://localhost:4312"],
  ])("accepts explicit loopback base %s", (input, expected) => {
    expect(normalizeAppBaseUrl(input)).toBe(expected);
  });

  it.each([
    "https://localhost:3000",
    "http://localhost",
    "http://evil.test:3000",
    "http://user@localhost:3000",
    "http://localhost:3000/api",
    "http://localhost:3000?x=1",
    "http://localhost:3000#x",
  ])("rejects unsafe base %s", (input) => {
    expect(() => normalizeAppBaseUrl(input)).toThrowError("unsafe_app_base_url");
  });

  it("posts explicit ID/latest to the guarded endpoint with exact Origin and no redirect", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({ ok: true }),
    });
    await expect(triggerMeetingSummarize({
      id: "meeting-1",
      baseUrl: "http://127.0.0.1:3000",
      fetchImpl,
    })).resolves.toEqual({ accepted: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/summarize",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ origin: "http://127.0.0.1:3000" }),
        body: JSON.stringify({ id: "meeting-1" }),
      }),
    );
  });

  it("returns only safe result codes and never raw response text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({ error: { code: "meeting_conflict", detail: "/Users/private token" } }),
    });
    await expect(triggerMeetingSummarize({ id: "latest", fetchImpl }))
      .resolves.toEqual({ accepted: false, code: "meeting_conflict" });
    const unavailable = vi.fn().mockRejectedValue(new Error("connect /Users/private"));
    await expect(triggerMeetingSummarize({ id: "latest", fetchImpl: unavailable }))
      .rejects.toThrowError("app_unavailable");
  });

  it("rejects unsafe IDs before network", async () => {
    const fetchImpl = vi.fn();
    await expect(triggerMeetingSummarize({ id: "../escape", fetchImpl }))
      .rejects.toThrowError("invalid_meeting_id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("final artifact producer inventory", () => {
  it("keeps the command API-only and the app summarize path as the sole production parser caller", () => {
    const command = readFileSync(join(process.cwd(), ".claude/commands/meeting-summarize.md"), "utf8");
    for (const forbidden of ["data/meetings", "summarizeCore", "transcriptPath", "summaryPath", ".correction.txt"] ) {
      expect(command).not.toContain(forbidden);
    }
    expect(command).toContain("scripts/meeting-summarize.mjs");

    const sourceRoot = join(process.cwd(), "src");
    const productionFiles = (readdirSync(sourceRoot, { recursive: true, encoding: "utf8" }))
      .filter((file) => (file.endsWith(".ts") || file.endsWith(".tsx")) && !file.includes("__tests__"))
      .filter((file) => file !== "lib/summarizeCore.ts");
    for (const helper of ["resolveTranscript", "summarizeTranscript"]) {
      const callers = productionFiles
        .filter((file) => readFileSync(join(sourceRoot, file), "utf8").includes(`${helper}(`));
      expect(callers, helper).toEqual(["lib/summarize.ts"]);
    }
  });

  it("keeps canonical publication and pair consumption behind their lease-owning boundaries", () => {
    const sourceRoot = join(process.cwd(), "src");
    const productionFiles = (readdirSync(sourceRoot, { recursive: true, encoding: "utf8" }))
      .filter((file) => (file.endsWith(".ts") || file.endsWith(".tsx")) && !file.includes("__tests__"));
    const publisherCallers = productionFiles
      .filter((file) => file !== "lib/summarizePublisher.ts")
      .filter((file) => readFileSync(join(sourceRoot, file), "utf8").includes("publishSummarizeAttempt("));
    expect(publisherCallers).toEqual(["lib/summarize.ts"]);

    const core = readFileSync(join(sourceRoot, "lib/summarizeCore.ts"), "utf8");
    expect(core).not.toContain("atomicWriteFile");
    expect(core).not.toContain("transcriptPath");
    expect(core).not.toContain("summaryPath");
    for (const consumer of [
      "app/meetings/[id]/page.tsx",
      "app/api/meetings/[id]/export/route.ts",
    ]) {
      expect(readFileSync(join(sourceRoot, consumer), "utf8")).toContain("readArtifactPair(");
    }
    expect(readFileSync(join(sourceRoot, "app/api/meetings/[id]/route.ts"), "utf8"))
      .toContain("acquireArtifactWriteLease(");
  });
});
