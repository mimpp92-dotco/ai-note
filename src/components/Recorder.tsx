"use client";

import { useRecorder } from "@/components/useRecorder";
import type { RecorderRequestedLocation } from "@/components/RecorderSessionProvider";
import { RecorderFinalizeResultView } from "@/components/RecorderFinalizeResultView";
import { formatDuration, recorderPhaseAnnouncement } from "@/lib/recorder";

// Human labels for the server-derived lifecycle polled after upload.
const STATUS_LABELS: Record<string, string> = {
  recorded: "저장됨 · 전사 대기",
  transcribing: "전사 중…",
  transcribed: "전사 완료",
  summarizing: "요약 생성 중…",
  summarized: "요약 완료",
};

export function Recorder({
  requestedLocation,
}: {
  requestedLocation?: RecorderRequestedLocation;
} = {}) {
  const {
    phase,
    elapsedMs,
    level,
    error,
    serverStatus,
    finalizeResult,
    hasRetainedBlob,
    retryDisposition,
    start,
    stop,
    retry,
    probe,
  } = useRecorder();

  const recording = phase === "recording";
  const busy = phase === "requesting_permission" || phase === "stopping" || phase === "uploading";
  const retryable = phase === "captured" || phase === "finalize_ambiguous" || (
    phase === "failed" && hasRetainedBlob && retryDisposition === "body_required"
  );
  const blocked = phase === "failed" && hasRetainedBlob && retryDisposition === "blocked";
  // Speech RMS rarely exceeds ~0.3, so scale up for a readable meter fill.
  const meterPct = Math.min(100, Math.round(level * 300));
  const statusLabel = serverStatus
    ? (STATUS_LABELS[serverStatus.status] ?? serverStatus.status)
    : null;

  return (
    <section className="w-full min-w-0 rounded-[16px] border border-line bg-panel p-4 shadow-[0_1px_2px_rgba(42,36,32,.04),0_8px_28px_-12px_rgba(42,36,32,.18)] sm:p-6">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <h2 className="text-[18px] font-bold text-ink">회의 녹음</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-inkSoft">
            마이크로 회의를 녹음합니다. 종료하면 자동으로 전사가 시작됩니다.
          </p>
        </div>
        <button
          type="button"
          onClick={recording
            ? stop
            : phase === "finalize_ambiguous"
              ? () => void probe()
              : retryable
                ? () => void retry()
                : () => void start({ requestedLocation })}
          disabled={busy || blocked}
          className="min-h-11 w-full shrink-0 rounded-full bg-ink px-5 text-[14px] font-semibold text-bg transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 sm:w-auto"
        >
          {recording
            ? "기록 중지"
            : phase === "requesting_permission"
              ? "권한 확인 중…"
              : phase === "stopping" || phase === "captured"
                ? "녹음 정리 중…"
                : phase === "uploading"
                  ? "저장 중…"
                  : retryable
                    ? phase === "finalize_ambiguous" ? "저장 상태 확인" : "저장 다시 시도"
                    : blocked
                      ? "저장 상태 충돌"
                      : "실시간 기록 시작"}
        </button>
      </div>

      {/* Phase transitions are announced once here; the ticking timer and the rapidly
          changing meter below are deliberately kept out of any live region. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="recorder-announce">
        {recorderPhaseAnnouncement(phase)}
      </p>

      <div className="mt-5">
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

        {(phase === "idle" || phase === "saved") && (
          <p className="text-[13px] text-inkSoft">
            {phase === "saved"
              ? `저장 완료${statusLabel ? ` · ${statusLabel}` : ""}`
              : "버튼을 눌러 녹음을 시작하세요. 마이크 권한이 필요합니다."}
          </p>
        )}

        {(phase === "requesting_permission"
          || phase === "stopping"
          || phase === "captured"
          || phase === "uploading") && (
          <p className="text-[14px] text-inkSoft">
            {phase === "requesting_permission"
              ? "마이크 권한을 확인하는 중…"
              : phase === "uploading"
                ? "녹음을 저장하는 중…"
                : "녹음을 안전하게 정리하는 중…"}
          </p>
        )}

        {(phase === "failed" || phase === "finalize_ambiguous") && error && (
          <p role="status" className="text-[14px] text-error">{error}</p>
        )}
        {blocked && (
          <div className="mt-3 space-y-3 rounded-[12px] border border-warn/40 bg-warnBg px-4 py-3">
            <p className="text-[13px] leading-relaxed text-ink">
              서버 상태가 충돌하거나 삭제 경계가 모호해 원본을 덮어쓰지 않습니다. 데이터 폴더를 확인한 뒤 보존한 녹음을 유지하거나 명시적으로 버리세요.
            </p>
            <button
              type="button"
              onClick={() => {
                void fetch("/api/library/reveal", { method: "POST" }).catch(() => {});
              }}
              className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent"
            >
              데이터 폴더 열기
            </button>
          </div>
        )}
        {phase === "saved" && finalizeResult && (
          <RecorderFinalizeResultView result={finalizeResult} onRefresh={() => void probe()} />
        )}
      </div>
    </section>
  );
}
