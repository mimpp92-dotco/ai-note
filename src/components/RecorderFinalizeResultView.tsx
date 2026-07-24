"use client";

import { useState } from "react";

import { GuardedLink } from "@/components/RecorderNavigation";
import { useOptionalLibrary } from "@/components/LibraryProvider";
import type { RecorderFinalizeResult } from "@/components/RecorderSessionProvider";
import {
  describeRecorderFinalizeResult,
  type RecorderResultLocation,
} from "@/lib/recorderFinalizeResult";
import { formatLocationBreadcrumb } from "@/lib/libraryClient";

export function RecorderFinalizeResultView({
  meetingId,
  result,
  onRefresh,
}: {
  meetingId: string;
  result: RecorderFinalizeResult;
  onRefresh: () => void | Promise<void>;
}) {
  const libraryState = useOptionalLibrary();
  const [transcriptionRetrying, setTranscriptionRetrying] = useState(false);
  const [transcriptionRetryStatus, setTranscriptionRetryStatus] = useState<string | null>(null);
  const description = describeRecorderFinalizeResult(result);
  const locationLabel = (location: RecorderResultLocation | null) => {
    if (!location) return "위치 없음";
    if (libraryState?.library) {
      const parts = formatLocationBreadcrumb(
        libraryState.library,
        location.workspaceId,
        location.folderId,
      );
      if (parts.length > 0) return parts.join(" / ");
    }
    return location.folderId ? "선택한 폴더" : "선택한 워크스페이스 / 미분류";
  };
  const actualHref = result.placement.actual
    ? `/?workspace=${result.placement.actual.workspaceId}${
        result.placement.actual.folderId ? `&folder=${result.placement.actual.folderId}` : "&view=unfiled"
      }`
    : null;
  const defaultWorkspaceId = libraryState?.library?.defaultWorkspaceId;
  const reveal = async () => {
    await fetch("/api/library/reveal", { method: "POST" }).catch(() => {});
  };
  const retryTranscription = async (trigger: HTMLButtonElement) => {
    if (transcriptionRetrying) return;
    setTranscriptionRetrying(true);
    setTranscriptionRetryStatus("전사 요청을 보내는 중…");
    try {
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: meetingId }),
      });
      if (!response.ok && response.status !== 409) {
        setTranscriptionRetryStatus(
          "전사 요청을 보내지 못했습니다. 녹음 원본은 보존됐습니다. 잠시 후 다시 시도하세요.",
        );
        return;
      }
      setTranscriptionRetryStatus("전사 요청을 접수했습니다. 최신 전사 상태를 확인합니다.");
      await onRefresh();
      setTranscriptionRetryStatus("최신 전사 상태를 확인했습니다.");
    } catch {
      setTranscriptionRetryStatus(
        "전사 요청을 보내지 못했습니다. 녹음 원본은 보존됐습니다. 잠시 후 다시 시도하세요.",
      );
    } finally {
      setTranscriptionRetrying(false);
      window.setTimeout(() => {
        if (trigger.isConnected) trigger.focus();
      }, 0);
    }
  };
  return (
    <section className="mt-4 space-y-3 rounded-[14px] border border-line bg-bg p-4" aria-live="polite">
      <div>
        <h3 className="text-[14px] font-bold text-ink">원본 저장</h3>
        <p className={`mt-1 text-[13px] ${description.artifactTone === "success" ? "text-success" : "text-warn"}`}>
          {description.artifactMessage}
        </p>
      </div>
      <div>
        <h3 className="text-[14px] font-bold text-ink">회의 위치</h3>
        <p className="mt-1 text-[13px] text-inkSoft">{description.placementMessage}</p>
        {result.placement.requested && (
          <p className="mt-1 text-[12px] text-inkSoft">요청: {locationLabel(result.placement.requested)}</p>
        )}
        {result.placement.actual && (
          <p className="mt-1 text-[12px] text-inkSoft">실제: {locationLabel(result.placement.actual)}</p>
        )}
      </div>
      {result.playback === "failed" && (
        <div>
          <h3 className="text-[14px] font-bold text-ink">재생 준비</h3>
          <p className="mt-1 text-[13px] text-warn">원본은 보존됐지만 브라우저 재생 파일을 아직 준비하지 못했습니다.</p>
        </div>
      )}
      {result.transcription === "failed" && (
        <div>
          <h3 className="text-[14px] font-bold text-ink">전사</h3>
          <p className="mt-1 text-[13px] text-warn">녹음은 저장됐지만 로컬 전사 요청을 완료하지 못했습니다.</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {description.actions.includes("retry_playback") && (
          <button type="button" onClick={onRefresh} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent">재생 준비 다시 확인</button>
        )}
        {description.actions.includes("retry_transcription") && (
          <button
            type="button"
            disabled={transcriptionRetrying}
            onClick={(event) => void retryTranscription(event.currentTarget)}
            className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
          >
            {transcriptionRetrying ? "전사 요청 중…" : "전사 다시 시도"}
          </button>
        )}
        {description.actions.includes("retry_placement") && (
          <button type="button" onClick={onRefresh} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent">위치 저장 다시 확인</button>
        )}
        {description.actions.includes("refresh_actual") && (
          <button type="button" onClick={onRefresh} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent">저장 상태 새로고침</button>
        )}
        {actualHref && (
          <GuardedLink
            href={actualHref}
            onClick={() => window.sessionStorage.setItem("ai-note-focus-scope", "1")}
            className="inline-flex min-h-11 items-center rounded-full bg-ink px-4 text-[13px] font-semibold text-bg"
          >
            실제 위치 열기
          </GuardedLink>
        )}
        {description.actions.includes("open_organization_pending") && defaultWorkspaceId && (
          <GuardedLink href={`/?workspace=${defaultWorkspaceId}#organization-pending`} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] font-semibold text-accent">위치 저장 대기 회의 보기</GuardedLink>
        )}
        {result.placement.outcome === "unavailable" && (
          <button type="button" onClick={() => void reveal()} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent">데이터 폴더 열기</button>
        )}
      </div>
      {description.actions.includes("retry_transcription") && (
        <p
          role="status"
          aria-label="전사 다시 시도 상태"
          aria-live="polite"
          className={`min-h-5 text-[13px] ${
            transcriptionRetryStatus?.startsWith("전사 요청을 보내지 못했습니다")
              ? "text-error"
              : "text-inkSoft"
          }`}
        >
          {transcriptionRetryStatus ?? ""}
        </p>
      )}
    </section>
  );
}
