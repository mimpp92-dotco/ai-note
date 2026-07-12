// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const atomicWriteFileMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/atomicWrite", () => ({
  atomicWriteFile: atomicWriteFileMock,
}));

import {
  readUserProfile,
  userProfilePath,
  writeUserProfile,
} from "@/lib/userProfile";

let originalCwd: string;
let workDir: string;

const PROFILE_INPUT = {
  schemaVersion: 1 as const,
  displayName: " Dylan ",
  aliases: [" 딜런 ", "", "딜런", "D"],
  timezone: "UTC",
  weekStartsOn: "monday" as const,
};

const NORMALIZED_PROFILE = {
  schemaVersion: 1 as const,
  displayName: "Dylan",
  aliases: ["딜런", "D"],
  timezone: "UTC",
  weekStartsOn: "monday" as const,
};

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "user-profile-"));
  process.chdir(workDir);
  atomicWriteFileMock.mockReset();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

describe("user profile repository", () => {
  it("returns local runtime defaults for a missing file without creating it", async () => {
    const runtimeTimezone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      } catch {
        return "UTC";
      }
    })();

    await expect(readUserProfile()).resolves.toEqual({
      configured: false,
      defaults: {
        timezone: runtimeTimezone,
        weekStartsOn: "monday",
      },
    });
    expect(existsSync(userProfilePath())).toBe(false);
    expect(atomicWriteFileMock).not.toHaveBeenCalled();
  });

  it("fails closed when the stored JSON is corrupt", async () => {
    await mkdir(dirname(userProfilePath()), { recursive: true });
    await writeFile(userProfilePath(), "{ broken json\n");

    await expect(readUserProfile()).rejects.toThrow();
  });

  it("reads and normalizes a valid configured profile", async () => {
    await mkdir(dirname(userProfilePath()), { recursive: true });
    await writeFile(userProfilePath(), JSON.stringify(PROFILE_INPUT));

    await expect(readUserProfile()).resolves.toEqual({
      configured: true,
      profile: NORMALIZED_PROFILE,
    });
  });

  it("normalizes before atomically replacing the dedicated profile path", async () => {
    atomicWriteFileMock.mockResolvedValue({
      state: "committed_durable",
      durability: "durable",
      fingerprint: "a".repeat(64),
    });

    await expect(writeUserProfile(PROFILE_INPUT)).resolves.toEqual({
      profile: NORMALIZED_PROFILE,
      durability: "durable",
    });
    expect(atomicWriteFileMock).toHaveBeenCalledTimes(1);
    const [path, serialized] = atomicWriteFileMock.mock.calls[0] as [string, string];
    expect(path).toBe(userProfilePath());
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toEqual(NORMALIZED_PROFILE);
  });

  it.each([
    ["committed_durable", "durable", "durable"],
    ["committed_best_effort", "best_effort", "best_effort"],
    ["committed_durability_pending", "pending", "pending"],
  ] as const)(
    "preserves the %s commit as durability %s without another write",
    async (state, atomicDurability, publicDurability) => {
      atomicWriteFileMock.mockResolvedValue({
        state,
        durability: atomicDurability,
        fingerprint: "b".repeat(64),
        ...(atomicDurability === "pending" ? { errorCode: "directory_sync_failed" } : {}),
      });

      await expect(writeUserProfile(PROFILE_INPUT)).resolves.toMatchObject({
        profile: NORMALIZED_PROFILE,
        durability: publicDurability,
      });
      expect(atomicWriteFileMock).toHaveBeenCalledTimes(1);
    },
  );
});
