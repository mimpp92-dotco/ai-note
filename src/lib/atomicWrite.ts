import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createDirectorySyncCapability,
  durableAtomicReplace,
  type DurableCommitResult,
} from "@/lib/durableFileOps";

// Compatibility wrapper: temp → file fsync → rename → parent-directory fsync.
// Callers that need to coordinate a durability-pending result use
// durableFileOps directly; legacy callers still receive the typed result.

const capabilities = new Map<string, ReturnType<typeof createDirectorySyncCapability>>();

export class AtomicWriteError extends Error {
  readonly code = "atomic_write_not_committed";

  constructor() {
    super("atomic_write_not_committed");
    this.name = "AtomicWriteError";
  }
}

export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<DurableCommitResult> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });
  const capability = capabilities.get(parent) ?? createDirectorySyncCapability();
  capabilities.set(parent, capability);
  const result = await durableAtomicReplace({
    rootPath: parent,
    targetPath: filePath,
    data,
    capability,
  });
  if (result.state === "not_committed") throw new AtomicWriteError();
  return result;
}
