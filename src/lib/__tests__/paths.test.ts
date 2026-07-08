import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { meetingDir, meetingPaths, meetingsRoot } from "@/lib/paths";

describe("meeting paths", () => {
  it("builds artifact paths under data/meetings/{id}/", () => {
    const id = "abc-123";
    const paths = meetingPaths(id);
    const dir = join(meetingsRoot(), id);
    expect(paths.dir).toBe(dir);
    expect(paths.status).toBe(join(dir, "status.json"));
    expect(paths.audio).toBe(join(dir, "audio.webm"));
    expect(paths.play).toBe(join(dir, "play.webm"));
    expect(paths.raw).toBe(join(dir, "raw.md"));
    expect(paths.transcript).toBe(join(dir, "transcript.md"));
    expect(paths.summary).toBe(join(dir, "summary.json"));
    expect(paths.segments).toBe(join(dir, "segments.json"));
  });

  it("refuses unsafe ids (path traversal defense)", () => {
    expect(() => meetingDir("../escape")).toThrow();
    expect(() => meetingPaths("/etc")).toThrow();
  });
});
