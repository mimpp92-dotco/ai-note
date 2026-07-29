// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  enqueueWhisperJob,
  fetchWhisperHealth,
  fetchWhisperJob,
  prepareWhisperModel,
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

  it("parses bounded model-preparation health separately from service readiness", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      model: "large-v3",
      ready: true,
      modelPreparation: [
        { model: "large-v3", status: "ready" },
        { model: "large-v3-turbo", status: "preparing" },
      ],
    }))));

    await expect(fetchWhisperHealth()).resolves.toEqual({
      ok: true,
      model: "large-v3",
      ready: true,
      modelPreparation: [
        { model: "large-v3", status: "ready" },
        { model: "large-v3-turbo", status: "preparing" },
      ],
    });
  });

  it("rejects malformed preparation health DTOs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      model: "large-v3",
      ready: true,
      modelPreparation: [
        { model: "../../private", status: "ready", path: "/tmp/model" },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWhisperHealth()).rejects.toThrowError("whisper_unavailable");

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      model: "large-v3",
      ready: true,
      modelPreparation: [
        { model: "large-v3", status: "ready" },
      ],
    })));
    await expect(fetchWhisperHealth()).rejects.toThrowError("whisper_unavailable");
  });

  it("prepares only a fixed logical model with redirect rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "large-v3-turbo",
      status: "preparing",
    }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(prepareWhisperModel("large-v3-turbo")).resolves.toEqual({
      model: "large-v3-turbo",
      status: "preparing",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8123/models/prepare",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "large-v3-turbo" }),
        redirect: "error",
        cache: "no-store",
      }),
    );
  });

  it("rejects unknown models and malformed prepare responses without another request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(prepareWhisperModel("arbitrary/repo" as "large-v3"))
      .rejects.toThrowError("invalid_whisper_protocol");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      model: "large-v3",
      status: "ready",
      path: "/tmp/private-cache",
    })));
    await expect(prepareWhisperModel("large-v3")).rejects.toThrowError("whisper_unavailable");

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      model: "large-v3",
      status: "preparing",
    }), { status: 200 }));
    await expect(prepareWhisperModel("large-v3")).rejects.toThrowError("whisper_unavailable");
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
