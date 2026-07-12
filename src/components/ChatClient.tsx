"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { ChatAnswer, type ChatDeepError } from "@/components/ChatAnswer";
import { ChatStatus, type ChatBusyKind } from "@/components/ChatStatus";
import { GuardedLink } from "@/components/RecorderNavigation";
import {
  CHAT_REQUEST_LIMITS,
  chatResponseSchema,
  type ChatHistoryItem,
  type ChatMode,
  type ChatResponse,
} from "@/domain/chat";

const MAX_TURNS = CHAT_REQUEST_LIMITS.historyItems / 2;

interface ChatTurn {
  question: string;
  answer: ChatResponse;
  answerKey: string;
  historyBefore: ChatHistoryItem[];
  mode: ChatMode;
  deepCompleted: boolean;
}

type ChatFailureKind =
  | "invalid_response"
  | "model_unconfigured"
  | "model_unavailable"
  | "search_unavailable"
  | "request_failed"
  | "reindex_failed";

interface ChatFailure {
  kind: ChatFailureKind;
  message: string;
}

interface BusyState {
  kind: Exclude<ChatBusyKind, null>;
  answerKey?: string;
}

export interface ChatController {
  draft: string;
  setDraft(value: string): void;
  turns: ChatTurn[];
  busy: BusyState | null;
  announcement: string;
  failure: ChatFailure | null;
  deepErrors: Record<string, ChatDeepError>;
  submit(): Promise<void>;
  rerunDeep(answerKey: string): Promise<void>;
  clear(): void;
  updateSearchData(answerKey?: string): Promise<void>;
}

type ChatRequestResult =
  | { ok: true; answer: ChatResponse }
  | { ok: false; failure: ChatFailure };

function characterSlice(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function historyAnswerText(answer: ChatResponse): string {
  const rendered = answer.answerSegments.map((segment) => {
    const markers = segment.kind === "claim"
      ? segment.referenceNumbers.map((number) => `[${number}]`).join("")
      : "";
    return `${segment.format === "bullet" ? "- " : ""}${segment.text}${markers}`;
  }).join("\n");
  return characterSlice(rendered, CHAT_REQUEST_LIMITS.historyItemChars);
}

function historyForTurns(turns: ChatTurn[]): ChatHistoryItem[] {
  const pairs = turns.slice(-MAX_TURNS).map((turn): ChatHistoryItem[] => {
    const referenceMap = turn.answer.references.map((reference) => ({
      number: reference.number,
      meetingId: reference.meetingId,
    }));
    return [
      { role: "user", content: characterSlice(turn.question, CHAT_REQUEST_LIMITS.historyItemChars) },
      {
        role: "assistant",
        content: historyAnswerText(turn.answer),
        ...(referenceMap.length > 0 ? { referenceMap } : {}),
      },
    ];
  });
  const length = (items: ChatHistoryItem[]) => items.reduce(
    (sum, item) => sum + Array.from(item.content).length,
    0,
  );
  while (pairs.length > 1 && length(pairs.flat()) > CHAT_REQUEST_LIMITS.historyTotalChars) {
    pairs.shift();
  }
  return pairs.flat();
}

function failureForCode(code: unknown): ChatFailure {
  if (code === "chat_llm_unconfigured") {
    return {
      kind: "model_unconfigured",
      message: "요약 모델 설정이 필요합니다. 질문과 이전 대화는 그대로 두었습니다. 설정을 확인한 뒤 다시 시도해 주세요.",
    };
  }
  if (code === "chat_llm_unavailable" || code === "chat_timeout") {
    return {
      kind: "model_unavailable",
      message: "답변을 만들지 못했습니다. 질문과 이전 대화는 그대로 두었습니다. 요약 모델 상태를 확인한 뒤 다시 시도해 주세요.",
    };
  }
  if (code === "chat_index_unavailable") {
    return {
      kind: "search_unavailable",
      message: "검색 데이터를 사용할 수 없어 답변을 만들지 못했습니다. 질문과 이전 대화는 그대로 두었습니다. 검색 데이터를 업데이트한 뒤 다시 시도해 주세요.",
    };
  }
  return {
    kind: "request_failed",
    message: "답변 요청을 완료하지 못했습니다. 질문과 이전 대화는 그대로 두었습니다. 잠시 후 다시 시도해 주세요.",
  };
}

async function requestChat(
  message: string,
  mode: ChatMode,
  history: ChatHistoryItem[],
): Promise<ChatRequestResult> {
  try {
    const result = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        mode,
        ...(history.length > 0 ? { history } : {}),
      }),
    });
    if (!result.ok) {
      let code: unknown;
      try {
        const body: unknown = await result.json();
        code = typeof body === "object" && body !== null && "error" in body
          && typeof body.error === "object" && body.error !== null && "code" in body.error
          ? body.error.code
          : undefined;
      } catch {
        // User-facing recovery below never exposes raw response text.
      }
      return { ok: false, failure: failureForCode(code) };
    }
    const body: unknown = await result.json();
    const parsed = chatResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        failure: {
          kind: "invalid_response",
          message: "답변 형식을 확인하지 못했습니다. 질문과 이전 답변은 그대로 두었습니다. 다시 시도해 주세요.",
        },
      };
    }
    return { ok: true, answer: parsed.data };
  } catch {
    return { ok: false, failure: failureForCode(undefined) };
  }
}

export function useChatController(): ChatController {
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [failure, setFailure] = useState<ChatFailure | null>(null);
  const [deepErrors, setDeepErrors] = useState<Record<string, ChatDeepError>>({});
  const answerSequenceRef = useRef(0);
  const announcementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = (message: string) => {
    if (announcementTimerRef.current) clearTimeout(announcementTimerRef.current);
    announcementTimerRef.current = null;
    setAnnouncement(message);
    if (message) {
      announcementTimerRef.current = setTimeout(() => {
        announcementTimerRef.current = null;
        setAnnouncement("");
      }, 2_000);
    }
  };

  useEffect(() => () => {
    if (announcementTimerRef.current) clearTimeout(announcementTimerRef.current);
  }, []);

  const submit = async () => {
    const draftSnapshot = draft;
    const question = draftSnapshot.trim();
    if (!question || busy) return;
    const history = historyForTurns(turns);
    setBusy({ kind: "answer" });
    setFailure(null);
    announce("");
    const result = await requestChat(question, "normal", history);
    if (result.ok) {
      answerSequenceRef.current += 1;
      const turn: ChatTurn = {
        question,
        answer: result.answer,
        answerKey: `answer-${answerSequenceRef.current}`,
        historyBefore: history,
        mode: "normal",
        deepCompleted: false,
      };
      setTurns((current) => [...current, turn].slice(-MAX_TURNS));
      setDraft((current) => current === draftSnapshot ? "" : current);
      announce("답변이 준비되었습니다.");
    } else {
      setFailure(result.failure);
      announce("");
    }
    setBusy(null);
  };

  const rerunDeep = async (answerKey: string) => {
    if (busy) return;
    const turn = turns.find((candidate) => candidate.answerKey === answerKey);
    if (!turn || turn.deepCompleted) return;
    setBusy({ kind: "deep", answerKey });
    setFailure(null);
    announce("");
    setDeepErrors((current) => {
      const next = { ...current };
      delete next[answerKey];
      return next;
    });
    const result = await requestChat(turn.question, "deep", turn.historyBefore);
    if (result.ok) {
      setTurns((current) => current.map((candidate) => candidate.answerKey === answerKey
        ? {
            ...candidate,
            answer: result.answer,
            mode: "deep",
            deepCompleted: true,
          }
        : candidate));
      announce("더 깊게 확인한 답변이 준비되었습니다.");
    } else {
      setDeepErrors((current) => ({
        ...current,
        [answerKey]: {
          message: "답변을 더 깊게 확인하지 못했습니다. 이전 답변은 그대로 두었습니다. 다시 시도해 주세요.",
          recovery: result.failure.kind === "model_unconfigured" || result.failure.kind === "model_unavailable"
            ? "settings"
            : result.failure.kind === "search_unavailable"
              ? "search"
              : "retry",
        },
      }));
      announce("");
    }
    setBusy(null);
  };

  const clear = () => {
    if (busy) return;
    setTurns([]);
    setFailure(null);
    setDeepErrors({});
    announce("대화를 지웠습니다.");
  };

  const updateSearchData = async (answerKey?: string) => {
    if (busy) return;
    setBusy({ kind: "reindex", ...(answerKey ? { answerKey } : {}) });
    setFailure(null);
    announce("");
    if (answerKey) {
      setDeepErrors((current) => {
        const next = { ...current };
        delete next[answerKey];
        return next;
      });
    }
    try {
      const result = await fetch("/api/knowledge/reindex", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      });
      if (!result.ok) throw new Error("reindex_failed");
      announce("검색 데이터를 업데이트했습니다. 같은 질문을 다시 실행할 수 있습니다.");
    } catch {
      const message = "검색 데이터를 업데이트하지 못했습니다. 질문과 현재 답변은 그대로 두었습니다. 다시 시도해 주세요.";
      if (answerKey) setDeepErrors((current) => ({
        ...current,
        [answerKey]: { message, recovery: "retry" },
      }));
      else setFailure({ kind: "reindex_failed", message });
      announce("");
    }
    setBusy(null);
  };

  return {
    draft,
    setDraft,
    turns,
    busy,
    announcement,
    failure,
    deepErrors,
    submit,
    rerunDeep,
    clear,
    updateSearchData,
  };
}

export function ChatClient({
  controller,
  onSearchReplay,
  onSwitchToSearch,
}: {
  controller: ChatController;
  onSearchReplay(replay: NonNullable<ChatResponse["searchReplay"]>): void;
  onSwitchToSearch(): void;
}) {
  const compositionRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isBusy = controller.busy !== null;

  const resizeTextarea = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = "auto";
    const nextHeight = Math.max(44, Math.min(textarea.scrollHeight || 44, 136));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 136 ? "auto" : "hidden";
  };

  useEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current);
  }, [controller.draft]);

  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (compositionRef.current) return;
    void controller.submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229 || compositionRef.current) return;
    event.preventDefault();
    void controller.submit();
  };

  return (
    <section aria-label="회의 질문" className="min-w-0 max-w-3xl space-y-6">
      <form onSubmit={submit} aria-busy={isBusy ? "true" : undefined} className="min-w-0 space-y-3">
        <label htmlFor="chat-question" className="block min-w-0 text-[13px] font-semibold text-ink">
          회의에 질문
        </label>
        <textarea
          ref={textareaRef}
          id="chat-question"
          rows={1}
          data-min-rows="1"
          data-max-rows="5"
          maxLength={CHAT_REQUEST_LIMITS.messageChars}
          value={controller.draft}
          onChange={(event) => {
            controller.setDraft(event.currentTarget.value);
            resizeTextarea(event.currentTarget);
          }}
          onCompositionStart={() => { compositionRef.current = true; }}
          onCompositionEnd={(event) => {
            compositionRef.current = false;
            controller.setDraft(event.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          placeholder="예: 지난 회의들에서 다음 분기 출시일을 어떻게 결정했나요?"
          className="min-h-11 max-h-[136px] w-full min-w-0 resize-none rounded-lg border border-inkFaint bg-panel px-3 py-2.5 text-[15px] leading-6 text-ink placeholder:text-inkSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [overflow-wrap:anywhere]"
        />
        <div className="flex min-w-0 flex-col items-stretch gap-2 min-[360px]:flex-row min-[360px]:items-center">
          <button
            type="submit"
            disabled={!controller.draft.trim() || isBusy}
            className="min-h-11 w-full rounded-lg bg-ink px-6 text-[14px] font-semibold text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-45 min-[360px]:w-auto"
          >
            질문하기
          </button>
          <p className="min-w-0 text-[12px] leading-relaxed text-inkSoft">
            Enter로 질문 · Shift+Enter로 줄바꿈
          </p>
        </div>
      </form>

      <ChatStatus busy={controller.busy?.kind ?? null} announcement={controller.announcement} />

      {controller.failure && (
        <ChatFailureView
          failure={controller.failure}
          busy={isBusy}
          onUpdateSearchData={() => void controller.updateSearchData()}
        />
      )}

      {controller.turns.length > 0 && (
        <div className="min-w-0 border-t border-line">
          {controller.turns.map((turn, index) => {
            const latest = index === controller.turns.length - 1;
            const turnBusy = controller.busy?.answerKey === turn.answerKey;
            return (
              <section key={turn.answerKey} className="min-w-0 border-b border-line py-6 first:pt-5">
                <header className="min-w-0">
                  <p className="text-[12px] font-semibold text-inkSoft">질문 {index + 1}</p>
                  <h2 className="mt-1 break-words text-[16px] font-bold leading-relaxed text-ink [overflow-wrap:anywhere]">
                    {turn.question}
                  </h2>
                </header>
                <ChatAnswer
                  answer={turn.answer}
                  answerKey={turn.answerKey}
                  mode={turn.mode}
                  canDeep={latest && !turn.deepCompleted && turn.mode === "normal"}
                  busy={isBusy}
                  deepError={controller.deepErrors[turn.answerKey] ?? null}
                  onDeep={() => void controller.rerunDeep(turn.answerKey)}
                  onSearchReplay={onSearchReplay}
                  onSwitchToSearch={onSwitchToSearch}
                  onUpdateSearchData={() => void controller.updateSearchData(turn.answerKey)}
                />
                {turnBusy && <span className="sr-only">현재 답변을 처리하고 있습니다.</span>}
              </section>
            );
          })}
        </div>
      )}

      {controller.turns.length > 0 && (
        <div className="flex justify-end border-t border-line pt-3">
          <button
            type="button"
            disabled={isBusy}
            onClick={controller.clear}
            className="min-h-11 rounded-lg px-3 text-[13px] font-medium text-inkSoft underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            대화 지우기
          </button>
        </div>
      )}
    </section>
  );
}

function ChatFailureView({
  failure,
  busy,
  onUpdateSearchData,
}: {
  failure: ChatFailure;
  busy: boolean;
  onUpdateSearchData(): void;
}) {
  const showSettings = failure.kind === "model_unconfigured" || failure.kind === "model_unavailable";
  const showSearchUpdate = failure.kind === "search_unavailable" || failure.kind === "reindex_failed";
  return (
    <div className="flex min-w-0 flex-col items-start gap-3 rounded-[12px] border border-error/30 bg-panel px-4 py-3 text-[13px] leading-relaxed sm:flex-row sm:items-center sm:justify-between">
      <p role="status" className="min-w-0 break-words text-error">{failure.message}</p>
      {showSettings && (
        <GuardedLink
          href="/settings"
          className="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-lg border border-inkFaint px-4 font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-auto"
        >
          {failure.kind === "model_unconfigured" ? "요약 모델 설정" : "요약 모델 확인"}
        </GuardedLink>
      )}
      {showSearchUpdate && (
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
  );
}
