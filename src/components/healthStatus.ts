import type { LlmProvider } from "@/services/llm/types";

export type StatusTone = "neutral" | "success" | "warn" | "error";

export interface StatusDisplay {
  label: string;
  shortLabel: string;
  title: string;
  tone: StatusTone;
  dotClass: string;
  textClass: string;
}

export interface WhisperHealthState {
  connected: boolean;
  ok?: boolean;
  ready?: boolean;
  model?: string | null;
  message?: string | null;
  modelPreparation?: Array<{
    model: "large-v3" | "large-v3-turbo";
    status: "idle" | "preparing" | "ready" | "error";
  }>;
}

export type LlmHealthState =
  | { configured: false }
  | { configured: true; provider: LlmProvider | string; ok: boolean; detail: string; model?: string | null };

export type LlmReadiness = "loading" | "ready" | "unconfigured" | "unavailable";

const TONE_CLASS: Record<StatusTone, Pick<StatusDisplay, "dotClass" | "textClass">> = {
  neutral: { dotClass: "bg-inkSoft", textClass: "text-inkSoft" },
  success: { dotClass: "bg-success", textClass: "text-success" },
  warn: { dotClass: "bg-warn", textClass: "text-warn" },
  error: { dotClass: "bg-error", textClass: "text-error" },
};

function withTone(base: Omit<StatusDisplay, "dotClass" | "textClass">): StatusDisplay {
  return { ...base, ...TONE_CLASS[base.tone] };
}

function compact(parts: Array<string | null | undefined>): string {
  return parts.map((p) => p?.trim()).filter(Boolean).join(" ");
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case "claude-cli":
      return "Claude CLI";
    case "codex-cli":
      return "Codex CLI";
    case "ollama":
      return "Ollama";
    default:
      return provider;
  }
}

export function formatWhisperStatus(health: WhisperHealthState | null): StatusDisplay {
  if (health === null) {
    return withTone({
      label: "Whisper · 확인 중",
      shortLabel: "확인 중",
      title: "전사 서버 상태 확인 중",
      tone: "neutral",
    });
  }

  const model = health.model?.trim() || null;
  const name = compact(["Whisper", model]);

  if (!health.connected) {
    return withTone({
      label: "Whisper · 연결 안 됨",
      shortLabel: "연결 안 됨",
      title: health.message || "전사 서버에 연결할 수 없습니다.",
      tone: "error",
    });
  }

  const ready = health.ready === true || (health.ready === undefined && health.ok !== false);
  if (!ready) {
    return withTone({
      label: `${name} · 준비 중`,
      shortLabel: "준비 중",
      title: health.message || `${name} 준비 중`,
      tone: "warn",
    });
  }

  return withTone({
    label: `${name} · 준비됨`,
    shortLabel: "준비됨",
    title: `${name} 사용 가능`,
    tone: "success",
  });
}

export function getLlmReadiness(health: LlmHealthState | null): LlmReadiness {
  if (health === null) return "loading";
  if (!health.configured) return "unconfigured";
  return health.ok ? "ready" : "unavailable";
}

export function formatLlmStatus(health: LlmHealthState | null): StatusDisplay {
  if (health === null) {
    return withTone({
      label: "요약 모델 · 확인 중",
      shortLabel: "확인 중",
      title: "요약 모델 상태 확인 중",
      tone: "neutral",
    });
  }

  if (!health.configured) {
    return withTone({
      label: "요약 모델 미설정",
      shortLabel: "미설정",
      title: "요약 모델을 설정해야 회의록 요약을 생성할 수 있습니다.",
      tone: "warn",
    });
  }

  const provider = providerLabel(health.provider);
  const model = health.model?.trim() || null;
  const name = compact([provider, model]);

  if (!health.ok) {
    return withTone({
      label: `${name} · 실패`,
      shortLabel: "실패",
      title: health.detail,
      tone: "error",
    });
  }

  // CLI backends (codex/claude) do binary-only detection: `ok` means "detected",
  // not "authenticated". Show "감지됨" (optimistic) — real auth is confirmed on the
  // first summary. Non-CLI backends (ollama) keep the verified "연결됨" below.
  if (health.provider === "codex-cli" || health.provider === "claude-cli") {
    return withTone({
      label: `${name} · 감지됨`,
      shortLabel: "감지됨",
      title: `${name}가 감지되었습니다. 인증과 실제 요약 가능 여부는 첫 요약에서 확인됩니다.`,
      tone: "success",
    });
  }

  return withTone({
    label: `${name} · 연결됨`,
    shortLabel: "연결됨",
    title: health.detail,
    tone: "success",
  });
}
