import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

// Contract: every artifact is written temp → fsync → rename so a crash mid-write
// never leaves a partially-written file at the real path.

let tmpCounter = 0;

export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  tmpCounter += 1;
  const tmpPath = `${filePath}.${process.pid}.${tmpCounter}.tmp`;
  try {
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(data);
      await handle.sync(); // fsync: flush to disk before the rename
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
