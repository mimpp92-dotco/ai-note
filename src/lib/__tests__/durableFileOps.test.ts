// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDirectorySyncCapability,
  createNodeFileOps,
  durableAtomicReplace,
  durableRename,
  type FileOps,
} from "@/lib/durableFileOps";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "durable-file-ops-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("sanitized test failure"), { code });
}

function faultingOps(
  stage: "write" | "file_sync" | "rename" | "directory_open" | "directory_sync",
  code = "EIO",
): FileOps {
  const base = createNodeFileOps();
  return {
    ...base,
    openFile: async (...args) => {
      const handle = await base.openFile(...args);
      return {
        ...handle,
        writeFile: stage === "write" ? async () => { throw errno(code); } : handle.writeFile,
        sync: stage === "file_sync" ? async () => { throw errno(code); } : handle.sync,
      };
    },
    rename: stage === "rename" ? async () => { throw errno(code); } : base.rename,
    openDirectory: stage === "directory_open"
      ? async () => { throw errno(code); }
      : async (...args) => {
          const handle = await base.openDirectory(...args);
          return {
            ...handle,
            sync: stage === "directory_sync" ? async () => { throw errno(code); } : handle.sync,
          };
        },
  };
}

describe("durableAtomicReplace", () => {
  it("returns committed_durable after file and parent namespace sync", async () => {
    const targetPath = join(root, "library.json");
    const result = await durableAtomicReplace({
      rootPath: root,
      targetPath,
      data: "new bytes",
      fileOps: createNodeFileOps(),
      capability: createDirectorySyncCapability(),
    });
    expect(result.state).toBe("committed_durable");
    expect(result.durability).toBe("durable");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(targetPath, "utf8")).toBe("new bytes");
    expect(await readdir(root)).toEqual(["library.json"]);
  });

  it.each(["write", "file_sync", "rename"] as const)(
    "keeps original bytes and reports not_committed on %s failure",
    async (stage) => {
      const targetPath = join(root, "library.json");
      await writeFile(targetPath, "old bytes");
      const result = await durableAtomicReplace({
        rootPath: root,
        targetPath,
        data: "new bytes",
        fileOps: faultingOps(stage),
        capability: createDirectorySyncCapability(),
      });
      expect(result.state).toBe("not_committed");
      expect(await readFile(targetPath, "utf8")).toBe("old bytes");
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it.each(["directory_open", "directory_sync"] as const)(
    "reports committed_durability_pending without rolling back after %s failure",
    async (stage) => {
      const targetPath = join(root, "library.json");
      await writeFile(targetPath, "old bytes");
      const result = await durableAtomicReplace({
        rootPath: root,
        targetPath,
        data: "new bytes",
        fileOps: faultingOps(stage),
        capability: createDirectorySyncCapability("supported"),
      });
      expect(result.state).toBe("committed_durability_pending");
      expect(result.durability).toBe("pending");
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(await readFile(targetPath, "utf8")).toBe("new bytes");
    },
  );

  it("uses best-effort on a known unsupported directory-sync platform", async () => {
    let directoryOpenCount = 0;
    const base = createNodeFileOps();
    const result = await durableAtomicReplace({
      rootPath: root,
      targetPath: join(root, "library.json"),
      data: "bytes",
      fileOps: {
        ...base,
        openDirectory: async (...args) => {
          directoryOpenCount += 1;
          return base.openDirectory(...args);
        },
      },
      capability: createDirectorySyncCapability("unsupported"),
    });
    expect(result.state).toBe("committed_best_effort");
    expect(result.durability).toBe("best_effort");
    expect(directoryOpenCount).toBe(0);
  });

  it("learns a first-observed unsupported capability after rename", async () => {
    const capability = createDirectorySyncCapability();
    const result = await durableAtomicReplace({
      rootPath: root,
      targetPath: join(root, "library.json"),
      data: "bytes",
      fileOps: faultingOps("directory_sync", "ENOTSUP"),
      capability,
    });
    expect(result.state).toBe("committed_best_effort");
    expect(capability.state).toBe("unsupported");
  });

  it("fails before creating a temp for containment escape", async () => {
    const outside = join(root, "..", "outside-library.json");
    const result = await durableAtomicReplace({
      rootPath: root,
      targetPath: outside,
      data: "secret",
      fileOps: createNodeFileOps(),
      capability: createDirectorySyncCapability(),
    });
    expect(result).toMatchObject({ state: "not_committed", errorCode: "unsafe_path" });
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("linearizes concurrent replacements without partial bytes or temp leaks", async () => {
    const targetPath = join(root, "library.json");
    const [a, b] = await Promise.all([
      durableAtomicReplace({
        rootPath: root,
        targetPath,
        data: "a".repeat(10_000),
        fileOps: createNodeFileOps(),
        capability: createDirectorySyncCapability(),
      }),
      durableAtomicReplace({
        rootPath: root,
        targetPath,
        data: "b".repeat(10_000),
        fileOps: createNodeFileOps(),
        capability: createDirectorySyncCapability(),
      }),
    ]);
    expect([a.state, b.state]).toEqual(["committed_durable", "committed_durable"]);
    expect(["a".repeat(10_000), "b".repeat(10_000)]).toContain(await readFile(targetPath, "utf8"));
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("durableRename", () => {
  it("syncs one namespace for same-parent and both namespaces for cross-parent", async () => {
    const sourceDir = join(root, "source");
    const destinationDir = join(root, "destination");
    await createNodeFileOps().mkdir(sourceDir, { recursive: true });
    await createNodeFileOps().mkdir(destinationDir, { recursive: true });

    const base = createNodeFileOps();
    const synced: string[] = [];
    const ops: FileOps = {
      ...base,
      openDirectory: async (path) => {
        const handle = await base.openDirectory(path);
        return {
          ...handle,
          sync: async () => {
            synced.push(path);
            await handle.sync();
          },
        };
      },
    };

    await writeFile(join(sourceDir, "a"), "a");
    const same = await durableRename({
      rootPath: root,
      sourcePath: join(sourceDir, "a"),
      destinationPath: join(sourceDir, "b"),
      fileOps: ops,
      capability: createDirectorySyncCapability("supported"),
    });
    expect(same.state).toBe("committed_durable");
    expect(synced).toEqual([sourceDir]);

    synced.length = 0;
    const cross = await durableRename({
      rootPath: root,
      sourcePath: join(sourceDir, "b"),
      destinationPath: join(destinationDir, "b"),
      fileOps: ops,
      capability: createDirectorySyncCapability("supported"),
    });
    expect(cross.state).toBe("committed_durable");
    expect(synced).toEqual([sourceDir, destinationDir]);
  });
});
