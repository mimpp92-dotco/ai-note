"use client";

import { GuardedLink } from "@/components/RecorderNavigation";
import type { MeetingStatus } from "@/domain/meeting";
import type { MeetingSearchResponse } from "@/lib/meetingSearch";

const STATUS_LABELS: Record<MeetingStatus, string> = {
  recording: "녹음 중",
  recorded: "녹음 완료",
  transcribing: "전사 중",
  transcribed: "요약 대기",
  summarizing: "요약 중",
  summarized: "요약 완료",
};

export function SearchResults({
  response,
  activeFilterCount,
  onResetFilters,
  displayLimit = 20,
}: {
  response: MeetingSearchResponse;
  activeFilterCount: number;
  onResetFilters: () => void;
  displayLimit?: number;
}) {
  if (response.index.status === "unavailable") {
    return (
      <section aria-labelledby="search-unavailable-heading" className="border-y border-line py-8">
        <h2 id="search-unavailable-heading" className="text-[17px] font-bold text-ink">
          검색 데이터를 사용할 수 없습니다
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-inkSoft">
          회의 내용 검색을 준비하지 못했습니다. 입력한 검색어와 필터는 그대로 유지됩니다.
        </p>
      </section>
    );
  }

  if (response.results.length === 0) {
    return (
      <section aria-labelledby="search-empty-heading" className="border-y border-line py-8">
        <h2 id="search-empty-heading" className="text-[17px] font-bold text-ink">
          검색 결과가 없습니다
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-inkSoft">
          검색어를 줄이거나 다른 표현을 사용해 보세요. 적용한 필터가 있다면 초기화할 수 있습니다.
        </p>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={onResetFilters}
            className="mt-4 min-h-11 rounded-lg border border-inkFaint px-4 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            필터 초기화
          </button>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="search-results-heading">
      <div className="flex flex-col gap-1 pb-3 sm:flex-row sm:items-end sm:justify-between">
        <h2 id="search-results-heading" className="text-[17px] font-bold text-ink">
          검색 결과 {response.results.length}개
        </h2>
        {response.hasMore && (
          <p className="text-[13px] text-inkSoft">상위 {displayLimit}개 결과를 표시했습니다.</p>
        )}
      </div>
      <ul data-result-layout="divider-list" className="border-b border-line">
        {response.results.map((result) => (
          <li key={result.meetingId} className="min-w-0 border-t border-line py-5 first:border-t-2 first:border-t-ink/70">
            <article className="min-w-0">
              <h3 className="break-words text-[18px] font-bold leading-snug text-ink">
                {result.title}
              </h3>
              <p aria-label="회의 메타데이터" className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[13px] text-inkSoft">
                <span>{result.startedAt.slice(0, 10)}</span>
                <span aria-hidden="true">·</span>
                <span className="break-words">
                  {result.location?.breadcrumb.join(" / ") || "위치 확인 필요"}
                </span>
                <span aria-hidden="true">·</span>
                <span>{STATUS_LABELS[result.status]}</span>
              </p>
              <ul aria-label="일치한 내용" className="mt-3 space-y-2">
                {result.matches.map((match, index) => (
                  <li key={`${match.field}-${index}`} className="min-w-0 text-[14px] leading-relaxed text-inkSoft">
                    <span className="mr-2 inline-block font-semibold text-accent">{match.label}</span>
                    <span className="break-words">{match.excerpt}</span>
                  </li>
                ))}
              </ul>
              <GuardedLink
                href={result.href}
                className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-inkFaint px-4 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                회의 열기
              </GuardedLink>
            </article>
          </li>
        ))}
      </ul>
      {response.hasMore && (
        <p className="mt-3 text-[13px] leading-relaxed text-inkSoft">
          찾는 회의가 보이지 않으면 검색어나 필터를 좁혀 보세요.
        </p>
      )}
    </section>
  );
}
