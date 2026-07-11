// @vitest-environment node
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createLeasedWebStream } from "@/lib/audioStream";

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("audio stream lease cleanup", () => {
  it("destroys the node stream and releases the lease once when the web reader cancels", async () => {
    const nodeStream = new PassThrough();
    const destroy = vi.spyOn(nodeStream, "destroy");
    const release = vi.fn();
    const reader = createLeasedWebStream(nodeStream, release).getReader();

    nodeStream.write(Buffer.from("audio"));
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel();
    await nextTurn();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("destroys and releases once when the request aborts", async () => {
    const nodeStream = new PassThrough();
    const destroy = vi.spyOn(nodeStream, "destroy");
    const release = vi.fn();
    const abort = new AbortController();
    createLeasedWebStream(nodeStream, release, abort.signal);

    abort.abort();
    await nextTurn();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("settles once when end and reader cancellation race", async () => {
    const nodeStream = new PassThrough();
    const release = vi.fn();
    const reader = createLeasedWebStream(nodeStream, release).getReader();

    nodeStream.end(Buffer.from("done"));
    await reader.read();
    await reader.cancel();
    await nextTurn();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("settles once when an error, close, and reader cancellation race", async () => {
    const nodeStream = new PassThrough();
    const release = vi.fn();
    const reader = createLeasedWebStream(nodeStream, release).getReader();
    const pendingRead = reader.read();

    nodeStream.destroy(new Error("synthetic read failure"));
    await expect(pendingRead).rejects.toThrow("synthetic read failure");
    await reader.cancel().catch(() => undefined);
    await nextTurn();

    expect(release).toHaveBeenCalledTimes(1);
  });
});
