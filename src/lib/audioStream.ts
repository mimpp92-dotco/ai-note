import { Readable } from "node:stream";

export interface ResolvedByteRange {
  kind: "full" | "partial";
  start: number;
  end: number;
  length: number;
}

export type ByteRangeResolution = ResolvedByteRange | { kind: "unsatisfiable" };

// Resolve the one byte-range shape needed by HTML media controls. Multipart ranges
// and unsafe/empty file sizes fail closed instead of being approximated.
export function resolveByteRange(rangeHeader: string | null, total: number): ByteRangeResolution {
  if (!Number.isSafeInteger(total) || total <= 0) return { kind: "unsatisfiable" };
  if (rangeHeader === null) {
    return { kind: "full", start: 0, end: total - 1, length: total };
  }

  const match = /^bytes=(\d*)-(\d*)$/iu.exec(rangeHeader.trim());
  if (!match) return { kind: "unsatisfiable" };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { kind: "unsatisfiable" };

  let start: number;
  let end: number;
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "unsatisfiable" };
    start = Math.max(total - suffixLength, 0);
    end = total - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start) || start < 0 || start >= total) return { kind: "unsatisfiable" };
    if (!rawEnd) {
      end = total - 1;
    } else {
      end = Number(rawEnd);
      if (!Number.isSafeInteger(end) || end < start) return { kind: "unsatisfiable" };
      end = Math.min(end, total - 1);
    }
  }

  return { kind: "partial", start, end, length: end - start + 1 };
}

// Node's built-in adapter supplies backpressure and owns controller close/error.
// This wrapper adds request-abort and lease lifecycle without ever enqueueing or
// closing a controller itself. Every terminal signal converges on one settlement.
export function createLeasedWebStream(
  nodeStream: Readable,
  release: () => unknown,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let settled = false;

  const settle = (destroy: boolean) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    nodeStream.off("end", onEnd);
    nodeStream.off("close", onClose);
    nodeStream.off("error", onError);
    if (destroy && !nodeStream.destroyed) nodeStream.destroy();
    release();
  };
  const onAbort = () => settle(true);
  const onEnd = () => settle(false);
  const onClose = () => settle(false);
  const onError = () => settle(true);

  nodeStream.once("end", onEnd);
  nodeStream.once("close", onClose);
  nodeStream.once("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    if (signal?.aborted) onAbort();
    return webStream;
  } catch (error) {
    settle(true);
    throw error;
  }
}
