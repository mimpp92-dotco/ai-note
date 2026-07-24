// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverOllamaModels,
  OllamaAdapter,
  parseOllamaTags,
} from "@/services/llm/ollama";

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

  it("parses only bounded exact model names with stable de-duplication", () => {
    expect(parseOllamaTags({
      models: [
        { name: "llama3.2:latest" },
        { name: "qwen2.5:7b" },
        { name: "llama3.2:latest" },
        { name: " leading" },
        { name: "" },
        { name: "x".repeat(300) },
        { nope: "ignored" },
      ],
    })).toEqual(["llama3.2:latest", "qwen2.5:7b"]);
    expect(parseOllamaTags({
      models: Array.from({ length: 140 }, (_, index) => ({ name: `model-${index}` })),
    })).toHaveLength(100);
    expect(() => parseOllamaTags({ models: "not-an-array" })).toThrowError("invalid_ollama_tags");
  });

  it("discovers through the canonical tags endpoint with redirect refusal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: "llama3.2:latest" }],
    })));
    await expect(discoverOllamaModels("http://localhost:11434/", {
      fetchImpl: fetchMock,
    })).resolves.toEqual(["llama3.2:latest"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
  });

  it("health requires exact model membership without alias or fuzzy matching", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: "llama3:latest" }],
    }))));
    const health = await new OllamaAdapter({
      provider: "ollama",
      model: "llama3",
    }).health();
    expect(health).toEqual({
      ok: false,
      detail: "선택한 Ollama 모델이 설치되어 있지 않습니다. 모델을 준비한 뒤 다시 검사하세요.",
    });
  });
});
