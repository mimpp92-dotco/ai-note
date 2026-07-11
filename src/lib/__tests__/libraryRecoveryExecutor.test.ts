// @vitest-environment node
import { createHash } from "node:crypto";
import {
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveRecoveryBasenames, type LibraryRecoveryIntent } from "@/domain/libraryRecoveryIntent";
import {
  createDirectorySyncCapability,
  createNodeFileOps,
  type FileOps,
} from "@/lib/durableFileOps";
import { resetLibraryRepositoryStateForTests } from "@/lib/library";
import { createLibraryRecoveryExecutor } from "@/lib/libraryRecoveryExecutor";

const RECOVERY_ID = "10000000-0000-4000-8000-000000000001";
const NEW_LIBRARY_ID = "20000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000003";
const OLD_BYTES = "{ corrupt library bytes\n";
let root: string;

function fingerprint(bytes: string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function seedCorrupt() {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "library.json"), OLD_BYTES, { mode: 0o600 });
  return fingerprint(OLD_BYTES);
}

function ids() {
  const values = [RECOVERY_ID, NEW_LIBRARY_ID, WORKSPACE_ID];
  return () => values.shift() ?? "40000000-0000-4000-8000-000000000004";
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "library-recovery-executor-"));
  resetLibraryRepositoryStateForTests();
});

afterEach(() => {
  resetLibraryRepositoryStateForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("library recovery executor", () => {
  it("fails before creating artifacts when required namespace durability is known unsupported", async () => {
    const oldHash = seedCorrupt();
    const executor = createLibraryRecoveryExecutor({
      dataRoot: root,
      capability: createDirectorySyncCapability("unsupported"),
      idFactory: ids(),
    });
    await expect(executor.rebuild({ fingerprint: oldHash })).resolves.toMatchObject({
      state: "recovery_not_supported",
    });
    expect(readdirSync(root)).toEqual(["library.json"]);
    expect(readFileSync(join(root, "library.json"), "utf8")).toBe(OLD_BYTES);
  });

  it("fails closed on a symlinked recovery directory", async () => {
    const oldHash = seedCorrupt();
    const outside = mkdtempSync(join(tmpdir(), "library-recovery-outside-"));
    symlinkSync(outside, join(root, "library-recovery"));
    try {
      const executor = createLibraryRecoveryExecutor({ dataRoot: root, idFactory: ids() });
      await expect(executor.rebuild({ fingerprint: oldHash })).resolves.toMatchObject({
        state: "recovery_conflict",
      });
      expect(readFileSync(join(root, "library.json"), "utf8")).toBe(OLD_BYTES);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each([1, 2])("resumes after a crash at recovery rename %s without losing original bytes", async (failedRename) => {
    const oldHash = seedCorrupt();
    const base = createNodeFileOps();
    let renameCount = 0;
    const faulting: FileOps = {
      ...base,
      rename: async (sourcePath, destinationPath) => {
        if (
          basename(destinationPath).startsWith("library.archive-")
          || basename(destinationPath) === "library.json"
        ) {
          renameCount += 1;
          if (renameCount === failedRename) throw Object.assign(new Error("fault"), { code: "EIO" });
        }
        await base.rename(sourcePath, destinationPath);
      },
    };
    const first = createLibraryRecoveryExecutor({
      dataRoot: root,
      fileOps: faulting,
      capability: createDirectorySyncCapability("supported"),
      idFactory: ids(),
    });
    await expect(first.rebuild({ fingerprint: oldHash })).resolves.toMatchObject({ state: "recovery_io" });

    const resumed = createLibraryRecoveryExecutor({
      dataRoot: root,
      capability: createDirectorySyncCapability("supported"),
    });
    await expect(resumed.resume()).resolves.toMatchObject({ state: "ready" });
    const canonical = JSON.parse(readFileSync(join(root, "library.json"), "utf8"));
    expect(canonical.libraryId).toBe(NEW_LIBRARY_ID);
    const archives = readdirSync(join(root, "library-recovery"))
      .filter((name) => name.startsWith("library.archive-"));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(root, "library-recovery", archives[0]), "utf8")).toBe(OLD_BYTES);
  });

  it("retries marker cleanup after new canonical publication without replaying the upload", async () => {
    const oldHash = seedCorrupt();
    const base = createNodeFileOps();
    let failed = false;
    const faulting: FileOps = {
      ...base,
      unlink: async (path) => {
        if (!failed && basename(path).endsWith(".intent.json")) {
          failed = true;
          throw Object.assign(new Error("fault"), { code: "EIO" });
        }
        await base.unlink(path);
      },
    };
    const first = createLibraryRecoveryExecutor({
      dataRoot: root,
      fileOps: faulting,
      capability: createDirectorySyncCapability("supported"),
      idFactory: ids(),
    });
    const result = await first.rebuild({ fingerprint: oldHash });
    expect(["ready", "recovery_io"]).toContain(result.state);
    const newHash = fingerprint(readFileSync(join(root, "library.json"), "utf8"));

    const resumed = createLibraryRecoveryExecutor({
      dataRoot: root,
      capability: createDirectorySyncCapability("supported"),
    });
    await expect(resumed.resume()).resolves.toMatchObject({ state: "ready" });
    expect(fingerprint(readFileSync(join(root, "library.json"), "utf8"))).toBe(newHash);
  });

  it("advances the active intent by atomic replacement instead of truncating it in place", async () => {
    const oldHash = seedCorrupt();
    const base = createNodeFileOps();
    let truncateAttempts = 0;
    const guarded: FileOps = {
      ...base,
      openFile: async (path, flags, mode) => {
        if (
          basename(path).endsWith(".intent.json")
          && typeof flags === "number"
          && (flags & constants.O_TRUNC) !== 0
        ) {
          truncateAttempts += 1;
          throw Object.assign(new Error("intent must not be truncated"), { code: "EIO" });
        }
        return base.openFile(path, flags, mode);
      },
    };
    const executor = createLibraryRecoveryExecutor({
      dataRoot: root,
      fileOps: guarded,
      capability: createDirectorySyncCapability("supported"),
      idFactory: ids(),
    });
    await expect(executor.rebuild({ fingerprint: oldHash })).resolves.toMatchObject({
      state: "ready",
    });
    expect(truncateAttempts).toBe(0);
  });

  it("restores the corrupt canonical from a preserved archive when the new publish source is gone", async () => {
    const recoveryDir = join(root, "library-recovery");
    mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    const names = deriveRecoveryBasenames(RECOVERY_ID);
    writeFileSync(join(recoveryDir, names.archive), OLD_BYTES, { mode: 0o600 });
    const intent: LibraryRecoveryIntent = {
      schemaVersion: 1,
      recoveryId: RECOVERY_ID,
      oldCanonicalSha256: fingerprint(OLD_BYTES),
      newLibraryId: NEW_LIBRARY_ID,
      newDocumentSha256: "b".repeat(64),
      phase: "archive_published",
    };
    writeFileSync(join(recoveryDir, names.intent), `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    const executor = createLibraryRecoveryExecutor({
      dataRoot: root,
      capability: createDirectorySyncCapability("supported"),
    });
    await expect(executor.resume()).resolves.toMatchObject({ state: "corrupt" });
    expect(readFileSync(join(root, "library.json"), "utf8")).toBe(OLD_BYTES);
    expect(readFileSync(join(recoveryDir, names.archive), "utf8")).toBe(OLD_BYTES);
    expect(existsSync(join(recoveryDir, names.intent))).toBe(false);
  });

  it("keeps historical archives out of active recovery discovery", async () => {
    const ready = `${JSON.stringify({
      schemaVersion: 1,
      libraryId: NEW_LIBRARY_ID,
      revision: 0,
      defaultWorkspaceId: WORKSPACE_ID,
      workspaces: [{ id: WORKSPACE_ID, name: "내 워크스페이스", order: 0, createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }],
      folders: [],
      placements: [],
    }, null, 2)}\n`;
    writeFileSync(join(root, "library.json"), ready);
    const recoveryDir = join(root, "library-recovery");
    mkdirSync(recoveryDir);
    const archive = deriveRecoveryBasenames(RECOVERY_ID).archive;
    writeFileSync(join(recoveryDir, archive), OLD_BYTES);
    const executor = createLibraryRecoveryExecutor({ dataRoot: root });
    await expect(executor.resume()).resolves.toMatchObject({ state: "ready" });
    expect(readFileSync(join(recoveryDir, archive), "utf8")).toBe(OLD_BYTES);
  });
});
