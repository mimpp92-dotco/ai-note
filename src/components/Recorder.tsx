"use client";

import { useRecorder } from "@/components/useRecorder";
import { formatDuration } from "@/lib/recorder";

// Human labels for the server-derived lifecycle polled after upload.
const STATUS_LABELS: Record<string, string> = {
  recorded: "저장됨 · 전사 대기",
  transcribing: "전사 중…",
  transcribed: "전사 완료",
  summarizing: "요약 생성 중…",
  summarized: "요약 완료",
};

export function Recorder() {
  const { phase, elapsedMs, level, error, serverStatus, start, stop } = useRecorder();

  const recording = phase === "recording";
  // Speech RMS rarely exceeds ~0.3, so scale up for a readable meter fill.
  const meterPct = Math.min(100, Math.round(level * 300));
  const statusLabel = serverStatus
    ? (STATUS_LABELS[serverStatus.status] ?? serverStatus.status)
    : null;

  return (
    <section className="w-full min-w-0 rounded-[16px] border border-line bg-panel p-6 shadow-[0_1px_2px_rgba(42,36,32,.04),0_8px_28px_-12px_rgba(42,36,32,.18)]">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <h2 className="text-[18px] font-bold text-ink">회의 녹음</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-inkSoft">
            마이크로 회의를 녹음합니다. 종료하면 자동으로 전사가 시작됩니다.
          </p>
        </div>
        <button
          type="button"
          onClick={recording ? stop : () => void start()}
          disabled={phase === "uploading"}
          className="w-full shrink-0 rounded-full bg-ink px-5 py-2.5 text-[14px] font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-50 sm:w-auto"
        >
          {recording ? "기록 중지" : phase === "uploading" ? "저장 중…" : "실시간 기록 시작"}
        </button>
      </div>

      <div className="mt-5" aria-live="polite">
        {recording && (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
              <span
                className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-error motion-reduce:animate-none"
                aria-hidden="true"
              />
              기록 중
            </span>
            <span className="font-mono text-[15px] tabular-nums text-ink">
              {formatDuration(elapsedMs)}
            </span>
            <div
              className="ml-1 h-2 flex-1 overflow-hidden rounded-full bg-soft"
              role="meter"
              aria-label="입력 레벨"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={meterPct}
            >
              <div
                className="h-full rounded-full bg-success transition-[width] duration-75"
                style={{ width: `${meterPct}%` }}
              />
            </div>
          </div>
        )}

        {phase === "idle" && (
          <p className="text-[13px] text-inkSoft">
            버튼을 눌러 녹음을 시작하세요. 마이크 권한이 필요합니다.
          </p>
        )}

        {(phase === "uploading" || phase === "done") && (
          <p className="text-[14px] text-inkSoft">
            {phase === "uploading"
              ? "녹음을 저장하는 중…"
              : `저장 완료${statusLabel ? ` · ${statusLabel}` : ""}`}
          </p>
        )}

        {phase === "error" && error && <p className="text-[14px] text-error">{error}</p>}
      </div>
    </section>
  );
}
