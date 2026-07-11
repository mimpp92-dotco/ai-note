// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { OllamaAdapter } from "@/services/llm/ollama";

afterEach(() => vi.unstubAllGlobals());

describe("OllamaAdapter local egress", () => {
  it("rejects an unsafe legacy URL before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => new OllamaAdapter({
      provider: "ollama",
      model: "llama3",
      baseUrl: "http://evil.test:11434",
    })).toThrowError("unsafe_local_endpoint");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses canonical loopback URL and refuses redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OllamaAdapter({
      provider: "ollama",
      model: "llama3",
      baseUrl: "http://localhost:11434/",
    });
    await expect(adapter.run("prompt")).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/generate",
      expect.objectContaining({ redirect: "error" }),
    );
  });
});
