import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type Stats,
} from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export type DirectorySyncCapabilityState = "unknown" | "supported" | "unsupported";

export interface DirectorySyncCapability {
  state: DirectorySyncCapabilityState;
}

export function createDirectorySyncCapability(
  state: DirectorySyncCapabilityState = "unknown",
): DirectorySyncCapability {
  return { state };
}

export interface FileHandleOps {
  writeFile(data: string | Uint8Array): Promise<void>;
  readFile(): Promise<Uint8Array>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DirectoryHandleOps {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface FileOps {
  mkdir(path: string, options: { recursive: boolean; mode?: number }): Promise<void>;
  openFile(path: string, flags: string | number, mode?: number): Promise<FileHandleOps>;
  openDirectory(path: string): Promise<DirectoryHandleOps>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string, mode?: number): Promise<void>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  hashFile(path: string): Promise<string>;
}

export function createNodeFileOps(): FileOps {
  return {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    openFile: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return {
        writeFile: async (data) => {
          await handle.writeFile(data);
        },
        readFile: async () => new Uint8Array(await handle.readFile()),
        sync: async () => {
          await handle.sync();
        },
        close: async () => {
          await handle.close();
        },
      };
    },
    openDirectory: async (path) => {
      const handle = await open(path, "r");
      return {
        sync: async () => {
          await handle.sync();
        },
        close: async () => {
          await handle.close();
        },
      };
    },
    rename,
    unlink,
    copyFile,
    stat,
    lstat,
    realpath,
    readFile: async (path) => new Uint8Array(await readFile(path)),
    hashFile: async (path) => {
      const bytes = await readFile(path);
      return createHash("sha256").update(bytes).digest("hex");
    },
  };
}

export type DurableCommitState =
  | "not_committed"
  | "committed_durable"
  | "committed_best_effort"
  | "committed_durability_pending";

export type DurableCommitDurability = "none" | "durable" | "best_effort" | "pending";

export type DurableFileErrorCode =
  | "unsafe_path"
  | "path_check_failed"
  | "temp_open_failed"
  | "write_failed"
  | "file_sync_failed"
  | "file_close_failed"
  | "rename_failed"
  | "copy_failed"
  | "unlink_failed"
  | "directory_sync_failed"
  | "hash_failed";

export interface DurableCommitResult {
  state: DurableCommitState;
  durability: DurableCommitDurability;
  fingerprint: string | null;
  errorCode?: DurableFileErrorCode;
}

export interface DurableAtomicReplaceOptions {
  rootPath: string;
  targetPath: string;
  data: string | Uint8Array;
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
  randomId?: () => string;
  mode?: number;
}

export interface DurableRenameOptions {
  rootPath: string;
  sourcePath: string;
  destinationPath: string;
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
}

export interface DurableUnlinkOptions {
  rootPath: string;
  targetPath: string;
  fileOps?: FileOps;
  capability?: DirectorySyncCapability;
}

export interface NamespaceSyncResult {
  durability: "durable" | "best_effort" | "pending";
  errorCode?: "directory_sync_failed";
}

class UnsafePathError extends Error {}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

function isContained(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel !== "" && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && rel !== ".."
    && !isAbsolute(rel);
}

async function lstatOrNull(path: string, fileOps: FileOps): Promise<Stats | null> {
  try {
    return await fileOps.lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function assertSafePath(
  rootPathInput: string,
  targetPathInput: string,
  fileOps: FileOps,
  options: { mustExist?: boolean; allowDirectory?: boolean } = {},
): Promise<void> {
  if (!isAbsolute(rootPathInput) || !isAbsolute(targetPathInput)) {
    throw new UnsafePathError("absolute paths required");
  }
  const rootPath = resolve(rootPathInput);
  const targetPath = resolve(targetPathInput);
  if (!isContained(rootPath, targetPath)) throw new UnsafePathError("path containment failed");

  const rootStat = await fileOps.lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new UnsafePathError("unsafe root");
  }
  const realRoot = await fileOps.realpath(rootPath);

  const rel = relative(rootPath, targetPath);
  const parts = rel.split(/[\\/]+/u).filter(Boolean);
  let current = rootPath;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstatOrNull(current, fileOps);
    const isFinal = index === parts.length - 1;
    if (!info) {
      if (!isFinal || options.mustExist) throw new UnsafePathError("path component missing");
      continue;
    }
    if (info.isSymbolicLink()) throw new UnsafePathError("symlink path component");
    if (!isFinal && !info.isDirectory()) throw new UnsafePathError("non-directory path component");
    if (isFinal && !options.allowDirectory && info.isDirectory()) {
      throw new UnsafePathError("target is a directory");
    }
  }

  const realParent = await fileOps.realpath(dirname(targetPath));
  if (realParent !== realRoot && !isContained(realRoot, realParent)) {
    throw new UnsafePathError("resolved containment failed");
  }
}

function fingerprintData(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function safeTempBasename(targetPath: string, randomId: () => string): string {
  const targetKey = createHash("sha256").update(basename(targetPath)).digest("hex").slice(0, 12);
  const randomKey = randomId().replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 64);
  return `.${targetKey}.${randomKey || randomUUID()}.tmp`;
}

function notCommitted(errorCode: DurableFileErrorCode): DurableCommitResult {
  return { state: "not_committed", durability: "none", fingerprint: null, errorCode };
}

function committed(
  durability: NamespaceSyncResult["durability"],
  fingerprint: string | null,
  errorCode?: DurableFileErrorCode,
): DurableCommitResult {
  if (durability === "durable") {
    return { state: "committed_durable", durability, fingerprint };
  }
  if (durability === "best_effort") {
    return { state: "committed_best_effort", durability, fingerprint };
  }
  return {
    state: "committed_durability_pending",
    durability,
    fingerprint,
    errorCode: errorCode ?? "directory_sync_failed",
  };
}

export async function syncNamespaces(
  directoryPaths: readonly string[],
  options: { fileOps?: FileOps; capability?: DirectorySyncCapability } = {},
): Promise<NamespaceSyncResult> {
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  if (capability.state === "unsupported") return { durability: "best_effort" };

  const uniquePaths = [...new Set(directoryPaths.map((path) => resolve(path)))];
  for (const path of uniquePaths) {
    let handle: DirectoryHandleOps | null = null;
    try {
      handle = await fileOps.openDirectory(path);
      await handle.sync();
    } catch (error) {
      if (UNSUPPORTED_DIRECTORY_SYNC_CODES.has(errnoCode(error) ?? "")) {
        capability.state = "unsupported";
        return { durability: "best_effort" };
      }
      return { durability: "pending", errorCode: "directory_sync_failed" };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
  capability.state = "supported";
  return { durability: "durable" };
}

export async function durableAtomicReplace(
  options: DurableAtomicReplaceOptions,
): Promise<DurableCommitResult> {
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const randomId = options.randomId ?? randomUUID;
  const targetPath = resolve(options.targetPath);
  const rootPath = resolve(options.rootPath);

  try {
    await assertSafePath(rootPath, targetPath, fileOps);
  } catch (error) {
    return notCommitted(error instanceof UnsafePathError ? "unsafe_path" : "path_check_failed");
  }

  const fingerprint = fingerprintData(options.data);
  let tempPath = "";
  let handle: FileHandleOps | null = null;
  let stage: DurableFileErrorCode = "temp_open_failed";

  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      tempPath = join(dirname(targetPath), safeTempBasename(targetPath, randomId));
      try {
        handle = await fileOps.openFile(tempPath, "wx", options.mode ?? 0o600);
        break;
      } catch (error) {
        if (errnoCode(error) !== "EEXIST" || attempt === 7) throw error;
      }
    }
    if (!handle) return notCommitted("temp_open_failed");

    stage = "write_failed";
    await handle.writeFile(options.data);
    stage = "file_sync_failed";
    await handle.sync();
    stage = "file_close_failed";
    await handle.close();
    handle = null;

    stage = "rename_failed";
    await fileOps.rename(tempPath, targetPath);
    tempPath = "";
  } catch {
    if (handle) await handle.close().catch(() => {});
    if (tempPath) await fileOps.unlink(tempPath).catch(() => {});
    return notCommitted(stage);
  }

  const namespace = await syncNamespaces([dirname(targetPath)], { fileOps, capability });
  return committed(namespace.durability, fingerprint, namespace.errorCode);
}

export async function durableRename(
  options: DurableRenameOptions,
): Promise<DurableCommitResult> {
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const rootPath = resolve(options.rootPath);
  const sourcePath = resolve(options.sourcePath);
  const destinationPath = resolve(options.destinationPath);

  try {
    await assertSafePath(rootPath, sourcePath, fileOps, { mustExist: true });
    await assertSafePath(rootPath, destinationPath, fileOps);
  } catch (error) {
    return notCommitted(error instanceof UnsafePathError ? "unsafe_path" : "path_check_failed");
  }

  let fingerprint: string;
  try {
    fingerprint = await fileOps.hashFile(sourcePath);
  } catch {
    return notCommitted("hash_failed");
  }

  try {
    await fileOps.rename(sourcePath, destinationPath);
  } catch {
    return notCommitted("rename_failed");
  }

  const namespace = await syncNamespaces(
    [dirname(sourcePath), dirname(destinationPath)],
    { fileOps, capability },
  );
  return committed(namespace.durability, fingerprint, namespace.errorCode);
}

export async function durableUnlink(
  options: DurableUnlinkOptions,
): Promise<DurableCommitResult> {
  const fileOps = options.fileOps ?? createNodeFileOps();
  const capability = options.capability ?? createDirectorySyncCapability();
  const rootPath = resolve(options.rootPath);
  const targetPath = resolve(options.targetPath);
  try {
    await assertSafePath(rootPath, targetPath, fileOps, { mustExist: true });
  } catch (error) {
    return notCommitted(error instanceof UnsafePathError ? "unsafe_path" : "path_check_failed");
  }
  try {
    await fileOps.unlink(targetPath);
  } catch {
    return notCommitted("unlink_failed");
  }
  const namespace = await syncNamespaces([dirname(targetPath)], { fileOps, capability });
  return committed(namespace.durability, null, namespace.errorCode);
}

export async function retryNamespaceDurability(
  directoryPaths: readonly string[],
  options: { fileOps?: FileOps; capability?: DirectorySyncCapability } = {},
): Promise<"durable" | "best_effort" | "pending"> {
  return (await syncNamespaces(directoryPaths, options)).durability;
}

export const NO_FOLLOW_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
