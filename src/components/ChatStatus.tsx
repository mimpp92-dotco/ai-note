"use client";

import type { ChatMode, ChatResponse } from "@/domain/chat";

export type ChatBusyKind = "answer" | "deep" | "reindex" | null;

export function ChatStatus({
  busy = null,
  announcement = "",
  checkedScope,
  mode = "normal",
}: {
  busy?: ChatBusyKind;
  announcement?: string;
  checkedScope?: ChatResponse["checkedScope"];
  mode?: ChatMode;
}) {
  const busyLabel = busy === "answer"
    ? "답변을 준비하고 있습니다"
    : busy === "deep"
      ? "답변을 더 깊게 확인하고 있습니다"
      : busy === "reindex"
        ? "검색 데이터를 업데이트하고 있습니다"
        : null;

  return (
    <>
      {busyLabel && (
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="rounded-[12px] border border-line bg-soft px-4 py-3 text-[13px] text-ink"
        >
          {busyLabel}
        </p>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {checkedScope && (
        <details className="border-t border-line pt-3 text-[13px] text-inkSoft">
          <summary className="flex min-h-11 cursor-pointer list-none items-center font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            확인한 범위
          </summary>
          <dl className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-2 pb-2 pt-1 min-[420px]:grid-cols-2">
            <ScopeRow label="탐색 수준" value={mode === "deep" ? "더 깊게" : "기본"} />
            <ScopeRow label="검색 결과" value={`${checkedScope.searchResults}개`} />
            <ScopeRow label="회의 정보" value={`${checkedScope.knowledgeCards}개`} />
            <ScopeRow label="요약" value={`${checkedScope.summaries}개`} />
            <ScopeRow label="원문 일부" value={`${checkedScope.transcriptWindows}곳`} />
            <ScopeRow label="전체 원문" value={`${checkedScope.fullTranscripts}개`} />
            <ScopeRow label="서로 다른 회의" value={`${checkedScope.distinctMeetings}개`} />
          </dl>
        </details>
      )}
    </>
  );
}

function ScopeRow({ label, value }: { label: string; value: string }) {
  if (label === "탐색 수준") {
    return <div className="min-w-0 break-words text-ink">{label} · {value}</div>;
  }
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="min-w-0 break-words">{label}</dt>
      <dd className="shrink-0 font-medium text-ink">{value}</dd>
    </div>
  );
}
