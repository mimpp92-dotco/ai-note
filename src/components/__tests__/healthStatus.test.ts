import { describe, expect, it } from "vitest";

import {
  formatLlmStatus,
  formatWhisperStatus,
  getLlmReadiness,
  providerLabel,
} from "@/components/healthStatus";

describe("healthStatus", () => {
  it("formats whisper readiness with model names", () => {
    expect(formatWhisperStatus({ connected: true, ready: true, model: "base" })).toMatchObject({
      label: "Whisper base · 준비됨",
      tone: "success",
    });
    expect(formatWhisperStatus({ connected: true, ready: false, model: "large-v3" })).toMatchObject({
      label: "Whisper large-v3 · 준비 중",
      tone: "warn",
    });
    expect(formatWhisperStatus({ connected: false, ready: false, model: null })).toMatchObject({
      label: "Whisper · 연결 안 됨",
      tone: "error",
    });
  });

  it("keeps service readiness green while a model is separately preparing", () => {
    expect(formatWhisperStatus({
      connected: true,
      ready: true,
      model: "large-v3",
      modelPreparation: [
        { model: "large-v3", status: "preparing" },
        { model: "large-v3-turbo", status: "idle" },
      ],
    })).toMatchObject({
      label: "Whisper large-v3 · 준비됨",
      tone: "success",
    });
  });

  it("formats llm provider/model labels and readiness", () => {
    expect(providerLabel("claude-cli")).toBe("Claude CLI");
    expect(providerLabel("codex-cli")).toBe("Codex CLI");
    expect(providerLabel("ollama")).toBe("Ollama");

    expect(
      formatLlmStatus({ configured: true, provider: "claude-cli", model: "sonnet", ok: true, detail: "available" }),
    ).toMatchObject({
      label: "Claude CLI sonnet · 감지됨",
      title: expect.stringContaining("첫 요약"),
      tone: "success",
    });
    expect(formatLlmStatus({ configured: true, provider: "codex-cli", ok: true, detail: "available" })).toMatchObject({
      label: "Codex CLI · 감지됨",
      title: expect.stringContaining("첫 요약"),
    });
    expect(formatLlmStatus({
      configured: true,
      provider: "ollama",
      model: "missing",
      ok: false,
      detail: "Ollama를 실행한 뒤 다시 검사하세요.",
    })).toMatchObject({
      label: "Ollama missing · 실패",
      title: "Ollama를 실행한 뒤 다시 검사하세요.",
      tone: "error",
    });
    expect(formatLlmStatus({ configured: false })).toMatchObject({
      label: "요약 모델 미설정",
      tone: "warn",
    });
  });

  it("only treats configured && ok as ready", () => {
    expect(getLlmReadiness(null)).toBe("loading");
    expect(getLlmReadiness({ configured: false })).toBe("unconfigured");
    expect(getLlmReadiness({ configured: true, provider: "ollama", ok: false, detail: "Ollama model not set" })).toBe(
      "unavailable",
    );
    expect(getLlmReadiness({ configured: true, provider: "claude-cli", ok: true, detail: "ready" })).toBe("ready");
  });
});
