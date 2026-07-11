// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  enqueueWhisperJob,
  fetchWhisperHealth,
  fetchWhisperJob,
} from "@/services/whisperClient";

const PROPOSED = "30000000-0000-4000-8000-000000000001";
const CANONICAL = "30000000-0000-4000-8000-000000000002";

beforeEach(() => {
  process.env.LOCAL_STT_HOST = "127.0.0.1";
  process.env.LOCAL_STT_PORT = "8123";
});

afterEach(() => {
  delete process.env.LOCAL_STT_HOST;
  delete process.env.LOCAL_STT_PORT;
  vi.unstubAllGlobals();
});

describe("whisper fixed-ID client", () => {
  it("sends only meetingId/dispatchId and adopts a canonical dispatch immediately", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 409,
        json: async () => ({
          error: { code: "adopt_existing_dispatch" },
          dispatchId: CANONICAL,
        }),
      })
      .mockResolvedValueOnce({
        status: 202,
        json: async () => ({ dispatchId: CANONICAL, status: "accepted" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(enqueueWhisperJob({ meetingId: "meeting-1", dispatchId: PROPOSED }))
      .resolves.toEqual({ dispatchId: CANONICAL, status: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0];
    expect(JSON.parse(first?.[1]?.body as string)).toEqual({ meetingId: "meeting-1", dispatchId: PROPOSED });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      meetingId: "meeting-1",
      dispatchId: CANONICAL,
    });
    expect(first?.[1]).toMatchObject({ redirect: "error", cache: "no-store" });
  });

  it("polls by protocol pair and rejects redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "processing", progress: 0.5 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchWhisperJob("meeting-1", PROPOSED);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8123/jobs/meeting-1/${PROPOSED}`,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("fails closed on unsafe config before network", async () => {
    process.env.LOCAL_STT_HOST = "evil.test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWhisperHealth()).rejects.toThrowError("unsafe_local_endpoint");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid IDs before network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(enqueueWhisperJob({ meetingId: "../escape", dispatchId: PROPOSED }))
      .rejects.toThrowError("invalid_whisper_protocol");
    await expect(enqueueWhisperJob({ meetingId: "meeting-1", dispatchId: "bad" }))
      .rejects.toThrowError("invalid_whisper_protocol");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
