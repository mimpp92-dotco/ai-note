import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

// Streaming sibling of atomicWrite: pipe a web ReadableStream (a request body)
// straight to a temp file, fsync, then rename — so a large upload (audio.webm)
// is never fully buffered in memory and a crash mid-write leaves no partial file.

let tmpCounter = 0;

export async function atomicWriteStream(
  filePath: string,
  webStream: ReadableStream<Uint8Array>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  tmpCounter += 1;
  const tmpPath = `${filePath}.${process.pid}.${tmpCounter}.tmp`;
  try {
    // Cast bridges the DOM ReadableStream type (request.body) to node:stream/web's,
    // which Readable.fromWeb expects — they are structurally the same at runtime.
    await pipeline(
      Readable.fromWeb(webStream as unknown as NodeReadableStream<Uint8Array>),
      createWriteStream(tmpPath),
    );
    // Reopen to fsync the data to disk before the rename (durability).
    const handle = await open(tmpPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
