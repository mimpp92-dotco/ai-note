"use client";

import { Fragment, type MouseEvent, type ReactNode } from "react";

import { ChatStatus } from "@/components/ChatStatus";
import { CopyButton } from "@/components/CopyButton";
import { GuardedLink } from "@/components/RecorderNavigation";
import type { ChatMode, ChatResponse } from "@/domain/chat";

type AnswerSegment = ChatResponse["answerSegments"][number];

interface AnswerBlock {
  kind: "paragraph" | "bullets";
  segments: AnswerSegment[];
}

export interface ChatAnswerProps {
  answer: ChatResponse;
  answerKey: string;
  mode: ChatMode;
  canDeep: boolean;
  busy: boolean;
  deepError?: ChatDeepError | null;
  onDeep(): void;
  onSearchReplay(replay: NonNullable<ChatResponse["searchReplay"]>): void;
  onSwitchToSearch(): void;
  onUpdateSearchData(): void;
}

export interface ChatDeepError {
  message: string;
  recovery: "settings" | "search" | "retry";
}

function answerBlocks(segments: ChatResponse["answerSegments"]): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  for (const segment of segments) {
    if (segment.format === "paragraph") {
      blocks.push({ kind: "paragraph", segments: [segment] });
      continue;
    }
    const previous = blocks.at(-1);
    if (previous?.kind === "bullets") previous.segments.push(segment);
    else blocks.push({ kind: "bullets", segments: [segment] });
  }
  return blocks;
}

export function answerCopyText(answer: ChatResponse): string {
  const lines = answer.answerSegments.map((segment) => {
    const markers = segment.kind === "claim"
      ? segment.referenceNumbers.map((number) => `[${number}]`).join("")
      : "";
    return `${segment.format === "bullet" ? "- " : ""}${segment.text}${markers}`;
  });
  if (answer.references.length === 0) return lines.join("\n");
  return [
    lines.join("\n"),
    "",
    "참고 회의",
    ...answer.references.map((reference) => (
      `[${reference.number}] ${reference.currentTitle} · ${reference.startedAt.slice(0, 10)}`
    )),
  ].join("\n");
}

export function ChatAnswer({
  answer,
  answerKey,
  mode,
  canDeep,
  busy,
  deepError,
  onDeep,
  onSearchReplay,
  onSwitchToSearch,
  onUpdateSearchData,
}: ChatAnswerProps) {
  const references = new Map(answer.references.map((reference) => [reference.number, reference]));
  const partialSearchData = answer.warnings.includes("index_partial");
  const scopeLimited = answer.warnings.some((warning) => [
    "candidate_limit_reached",
    "stale_evidence",
    "truncated_evidence",
    "budget_exhausted",
    "unsupported_claim_omitted",
  ].includes(warning));
  const personalizationNeeded = answer.warnings.includes("personalization_needed")
    || answer.warnings.includes("profile_unavailable");
  const blocks = answerBlocks(answer.answerSegments);
  const searchAction = answer.searchReplay
    ? () => onSearchReplay(answer.searchReplay as NonNullable<ChatResponse["searchReplay"]>)
    : onSwitchToSearch;
  const searchActionLabel = answer.searchReplay ? "검색 결과로 보기" : "검색에서 찾아보기";

  const focusReference = (event: MouseEvent<HTMLAnchorElement>, number: number) => {
    event.preventDefault();
    const target = document.getElementById(`chat-${answerKey}-reference-${number}`);
    target?.scrollIntoView?.({ block: "nearest" });
    target?.focus();
  };

  const renderSegment = (segment: AnswerSegment, key: string): ReactNode => (
    <Fragment key={key}>
      {segment.text}
      {segment.kind === "claim" && segment.referenceNumbers.map((number) => {
        const reference = references.get(number);
        if (!reference) return null;
        return (
          <a
            key={number}
            href={`#chat-${answerKey}-reference-${number}`}
            aria-label={`출처 ${number}: ${reference.currentTitle}`}
            onClick={(event) => focusReference(event, number)}
            className="ml-0.5 inline rounded-[2px] font-semibold text-accent underline decoration-line underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            [{number}]
          </a>
        );
      })}
    </Fragment>
  );

  return (
    <article aria-label="질문 답변" className="min-w-0 space-y-5 pt-4">
      <p className={`text-[13px] font-semibold ${
        answer.evidenceStatus === "sufficient"
          ? "text-inkSoft"
          : answer.evidenceStatus === "partial"
            ? "text-accent"
            : "text-inkSoft"
      }`}>
        {answer.evidenceStatus === "sufficient"
          ? "출처 확인됨"
          : answer.evidenceStatus === "partial"
            ? "일부 출처만 확인"
            : "확인된 출처 없음"}
      </p>

      <div className="max-w-[72ch] space-y-3 break-words text-[16px] leading-[1.7] text-ink [overflow-wrap:anywhere]">
        {blocks.map((block, blockIndex) => block.kind === "paragraph" ? (
          <p key={`paragraph-${blockIndex}`}>
            {renderSegment(block.segments[0], `paragraph-segment-${blockIndex}`)}
          </p>
        ) : (
          <ul key={`bullets-${blockIndex}`} className="list-disc space-y-2 pl-5 marker:text-inkSoft">
            {block.segments.map((segment, segmentIndex) => (
              <li key={`bullet-${blockIndex}-${segmentIndex}`}>
                {renderSegment(segment, `bullet-segment-${blockIndex}-${segmentIndex}`)}
              </li>
            ))}
          </ul>
        ))}
      </div>

      {answer.evidenceStatus === "partial" && (
        <div className="space-y-2 border-l-2 border-warn/50 pl-3 text-[13px] leading-relaxed text-inkSoft">
          <p>확인할 수 있는 회의만 바탕으로 답했습니다. 중요한 내용은 참고 회의를 열어 확인해 주세요.</p>
          {scopeLimited && <p>확인할 범위가 커서 일부만 살펴봤습니다.</p>}
        </div>
      )}

      {answer.evidenceStatus === "none" && (
        <div className="space-y-1 rounded-[12px] border border-line bg-soft px-4 py-3 text-[13px] leading-relaxed text-ink">
          <p className="font-semibold">회의에서 확인할 수 있는 출처를 찾지 못했습니다.</p>
          <p className="text-inkSoft">질문의 범위를 줄이거나 검색에서 관련 회의를 먼저 찾아보세요.</p>
        </div>
      )}

      {partialSearchData && (
        <div className="flex min-w-0 flex-col items-start gap-2 rounded-[12px] border border-warn/40 bg-warnBg px-4 py-3 text-[13px] leading-relaxed text-ink sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 break-words">일부 회의의 검색 데이터가 아직 최신 상태가 아닙니다. 현재 답변과 출처는 그대로 유지됩니다.</p>
          <button
            type="button"
            aria-disabled={busy}
            onClick={onUpdateSearchData}
            className="min-h-11 w-full shrink-0 rounded-lg border border-inkFaint bg-panel px-4 font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-disabled:opacity-50 sm:w-auto"
          >
            검색 데이터 업데이트
          </button>
        </div>
      )}

      {personalizationNeeded && (
        <div className="flex min-w-0 flex-col items-start gap-2 border-l-2 border-line pl-3 text-[13px] leading-relaxed text-inkSoft sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 break-words">내 정보를 설정하면 ‘내 할 일’ 같은 자기 지칭 질문을 더 정확히 해석할 수 있습니다.</p>
          <GuardedLink
            href="/settings"
            className="inline-flex min-h-11 shrink-0 items-center font-semibold text-accent underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            내 정보 설정
          </GuardedLink>
        </div>
      )}

      {answer.references.length > 0 && (
        <section aria-labelledby={`chat-${answerKey}-references-heading`} className="min-w-0 pt-1">
          <h3 id={`chat-${answerKey}-references-heading`} className="text-[15px] font-bold text-ink">
            참고 회의
          </h3>
          <ol className="mt-2 border-b border-line">
            {answer.references.map((reference) => (
              <li
                key={reference.number}
                id={`chat-${answerKey}-reference-${reference.number}`}
                tabIndex={-1}
                className="min-w-0 border-t border-line py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              >
                <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="shrink-0 text-[13px] font-bold text-accent">[{reference.number}]</span>
                    <div className="min-w-0">
                      <p className="break-words text-[14px] font-semibold leading-relaxed text-ink [overflow-wrap:anywhere]">
                        {reference.currentTitle}
                      </p>
                      <p className="mt-0.5 text-[13px] text-inkSoft">{reference.startedAt.slice(0, 10)}</p>
                    </div>
                  </div>
                  <GuardedLink
                    href={reference.href}
                    className="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-lg border border-inkFaint px-4 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-auto"
                  >
                    회의 열기
                  </GuardedLink>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {deepError && (
        <div className="flex min-w-0 flex-col items-start gap-2 rounded-[12px] border border-error/30 bg-panel px-4 py-3 text-[13px] leading-relaxed sm:flex-row sm:items-center sm:justify-between">
          <p role="status" className="min-w-0 break-words text-error">{deepError.message}</p>
          {deepError.recovery === "settings" && (
            <GuardedLink
              href="/settings"
              className="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-lg border border-inkFaint px-4 font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-auto"
            >
              요약 모델 확인
            </GuardedLink>
          )}
          {deepError.recovery === "search" && (
            <button
              type="button"
              aria-disabled={busy}
              onClick={onUpdateSearchData}
              className="min-h-11 w-full shrink-0 rounded-lg border border-inkFaint px-4 font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-disabled:opacity-50 sm:w-auto"
            >
              검색 데이터 업데이트
            </button>
          )}
        </div>
      )}

      <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {canDeep && (
          <button
            type="button"
            aria-disabled={busy}
            onClick={onDeep}
            className={`min-h-11 w-full rounded-lg px-4 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-disabled:opacity-50 sm:w-auto ${
              answer.evidenceStatus === "sufficient"
                ? "text-accent underline underline-offset-4"
                : "border border-accent/50 bg-panel text-accent"
            }`}
          >
            더 깊게 찾기
          </button>
        )}
        {(answer.searchReplay || answer.evidenceStatus === "none") && (
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) searchAction();
            }}
            className="min-h-11 w-full rounded-lg border border-inkFaint bg-panel px-4 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-disabled:opacity-50 sm:w-auto"
          >
            {searchActionLabel}
          </button>
        )}
        <CopyButton text={answerCopyText(answer)} label="답변 복사" className="w-full rounded-lg sm:w-auto" />
      </div>

      <ChatStatus checkedScope={answer.checkedScope} mode={mode} />
    </article>
  );
}
