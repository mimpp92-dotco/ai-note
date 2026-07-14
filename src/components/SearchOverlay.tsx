"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AppDialog } from "@/components/AppDialog";
import { useOptionalLibrary } from "@/components/LibraryProvider";
import { SearchResults } from "@/components/SearchResults";
import type { ChatResponse, ChatSearchFilters } from "@/domain/chat";
import type { LibraryFolder, LibraryWorkspace } from "@/domain/library";
import type { MeetingStatus } from "@/domain/meeting";
import type { MeetingSearchResponse } from "@/lib/meetingSearch";

interface SearchFilterDraft {
  dateFrom: string;
  dateTo: string;
  workspaceId: string;
  folderId: string;
  status: "" | MeetingStatus;
  hasActionItem: boolean;
}

const EMPTY_FILTERS: SearchFilterDraft = {
  dateFrom: "",
  dateTo: "",
  workspaceId: "",
  folderId: "",
  status: "",
  hasActionItem: false,
};

const STATUS_OPTIONS: Array<{ value: MeetingStatus; label: string }> = [
  { value: "recording", label: "녹음 중" },
  { value: "recorded", label: "녹음 완료" },
  { value: "transcribing", label: "전사 중" },
  { value: "transcribed", label: "요약 대기" },
  { value: "summarizing", label: "요약 중" },
  { value: "summarized", label: "요약 완료" },
];

type RequestPhase = "initial" | "loading" | "ready" | "request_error";
type ReindexPhase = "idle" | "running" | "success" | "error";

function activeFilterCount(filters: SearchFilterDraft): number {
  return [
    filters.dateFrom,
    filters.dateTo,
    filters.workspaceId,
    filters.folderId,
    filters.status,
    filters.hasActionItem ? "true" : "",
  ].filter(Boolean).length;
}

function searchUrl(query: string, filters: SearchFilterDraft): string {
  const search = new URLSearchParams({ q: query });
  if (filters.dateFrom) search.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) search.set("dateTo", filters.dateTo);
  if (filters.workspaceId) search.set("workspaceId", filters.workspaceId);
  if (filters.folderId) search.set("folderId", filters.folderId);
  if (filters.status) search.set("status", filters.status);
  if (filters.hasActionItem) search.set("hasActionItem", "true");
  return `/api/search?${search.toString()}`;
}

function filtersFromReplay(filters: ChatSearchFilters): SearchFilterDraft {
  return {
    dateFrom: filters.dateFrom ?? "",
    dateTo: filters.dateTo ?? "",
    workspaceId: filters.workspaceId ?? "",
    folderId: filters.folderId === null ? "unfiled" : filters.folderId ?? "",
    status: filters.status ?? "",
    hasActionItem: filters.hasActionItem ?? false,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSearchResponse(value: unknown): value is MeetingSearchResponse {
  if (!isObject(value) || typeof value.query !== "string" || !Array.isArray(value.results)) return false;
  if (typeof value.hasMore !== "boolean" || typeof value.summaryPendingCount !== "number") return false;
  if (!isObject(value.index)
    || !["ready", "partial", "unavailable"].includes(String(value.index.status))
    || !Array.isArray(value.index.reasons)
    || typeof value.index.reindexable !== "boolean") return false;
  return value.results.every((result) => (
    isObject(result)
    && typeof result.meetingId === "string"
    && typeof result.title === "string"
    && typeof result.status === "string"
    && typeof result.startedAt === "string"
    && typeof result.href === "string"
    && Array.isArray(result.matches)
  ));
}

export interface MeetingSearch {
  query: string;
  filters: SearchFilterDraft;
  count: number;
  phase: RequestPhase;
  response: MeetingSearchResponse | null;
  requestError: string | null;
  reindexPhase: ReindexPhase;
  showDataUpdate: boolean;
  workspaces: LibraryWorkspace[];
  availableFolders: LibraryFolder[];
  compositionRef: MutableRefObject<boolean>;
  onQueryChange(value: string): void;
  onCompositionEnd(value: string): void;
  updateFilter<Key extends keyof SearchFilterDraft>(key: Key, value: SearchFilterDraft[Key]): void;
  setWorkspaceFilter(workspaceId: string): void;
  submitSearch(): void;
  onQueryKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  resetFilters(): void;
  reindex(): Promise<void>;
  replay(replay: NonNullable<ChatResponse["searchReplay"]>): void;
}

export function useMeetingSearch(): MeetingSearch {
  const libraryState = useOptionalLibrary();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilterDraft>(EMPTY_FILTERS);
  const [phase, setPhase] = useState<RequestPhase>("initial");
  const [response, setResponse] = useState<MeetingSearchResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [reindexPhase, setReindexPhase] = useState<ReindexPhase>("idle");
  const compositionRef = useRef(false);
  const requestSequenceRef = useRef(0);

  const count = activeFilterCount(filters);
  const availableFolders = useMemo(() => {
    if (!libraryState?.library || !filters.workspaceId) return [];
    return libraryState.library.folders.filter((folder) => (
      folder.workspaceId === filters.workspaceId
    ));
  }, [filters.workspaceId, libraryState?.library]);

  const updateFilter = <Key extends keyof SearchFilterDraft>(
    key: Key,
    value: SearchFilterDraft[Key],
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setReindexPhase("idle");
  };

  const runSearch = async (
    querySnapshot: string,
    filterSnapshot: SearchFilterDraft,
  ): Promise<boolean> => {
    const trimmedQuery = querySnapshot.trim();
    if (!trimmedQuery) return false;
    const sequence = ++requestSequenceRef.current;
    setPhase("loading");
    setRequestError(null);
    try {
      const result = await fetch(searchUrl(trimmedQuery, filterSnapshot), { cache: "no-store" });
      if (!result.ok) throw new Error("search_request_failed");
      const payload: unknown = await result.json();
      if (!isSearchResponse(payload)) throw new Error("invalid_search_response");
      if (sequence !== requestSequenceRef.current) return false;
      setResponse(payload);
      setPhase("ready");
      return true;
    } catch {
      if (sequence !== requestSequenceRef.current) return false;
      setPhase("request_error");
      setRequestError("검색 요청을 완료하지 못했습니다. 입력과 이전 결과를 유지했습니다.");
      return false;
    }
  };

  const submitSearch = () => {
    if (compositionRef.current || !query.trim() || phase === "loading") return;
    setReindexPhase("idle");
    void runSearch(query, { ...filters });
  };

  const onQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (
      event.nativeEvent.isComposing
      || event.keyCode === 229
      || compositionRef.current
    ) return;
    submitSearch();
  };

  const resetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setReindexPhase("idle");
  };

  const reindex = async () => {
    if (reindexPhase === "running") return;
    const querySnapshot = query.trim() || response?.query || "";
    const filterSnapshot = { ...filters };
    setReindexPhase("running");
    try {
      const result = await fetch("/api/knowledge/reindex", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "all" }),
      });
      if (!result.ok) throw new Error("reindex_failed");
      const searched = await runSearch(querySnapshot, filterSnapshot);
      setReindexPhase(searched ? "success" : "error");
    } catch {
      setReindexPhase("error");
    }
  };

  const replay = (replay: NonNullable<ChatResponse["searchReplay"]>) => {
    const replayFilters = filtersFromReplay(replay.filters);
    setQuery(replay.query);
    setFilters(replayFilters);
    setReindexPhase("idle");
    void runSearch(replay.query, replayFilters);
  };

  const showDataUpdate = response?.index.status !== "ready" && !!response?.index.reindexable;

  return {
    query,
    filters,
    count,
    phase,
    response,
    requestError,
    reindexPhase,
    showDataUpdate,
    workspaces: libraryState?.library?.workspaces ?? [],
    availableFolders,
    compositionRef,
    onQueryChange: (value) => { setQuery(value); setReindexPhase("idle"); },
    onCompositionEnd: (value) => { compositionRef.current = false; setQuery(value); },
    updateFilter,
    setWorkspaceFilter: (workspaceId) => {
      setFilters((current) => ({ ...current, workspaceId, folderId: "" }));
      setReindexPhase("idle");
    },
    submitSearch,
    onQueryKeyDown,
    resetFilters,
    reindex,
    replay,
  };
}

export function SearchPanel({
  search,
  inputRef,
}: {
  search: MeetingSearch;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const {
    query,
    filters,
    count,
    phase,
    response,
    requestError,
    reindexPhase,
    showDataUpdate,
    workspaces,
    availableFolders,
    compositionRef,
  } = search;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    search.submitSearch();
  };

  return (
    <>
      <form onSubmit={onSubmit} aria-busy={phase === "loading"} className="max-w-3xl space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-[13px] font-semibold text-ink">
            회의 검색
            <input
              ref={inputRef}
              type="search"
              value={query}
              maxLength={500}
              onChange={(event) => search.onQueryChange(event.currentTarget.value)}
              onCompositionStart={() => { compositionRef.current = true; }}
              onCompositionEnd={(event) => search.onCompositionEnd(event.currentTarget.value)}
              onKeyDown={search.onQueryKeyDown}
              placeholder="예: 다음 분기 로드맵"
              className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-inkFaint bg-panel px-3 text-[15px] text-ink placeholder:text-inkSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
          <button
            type="submit"
            disabled={!query.trim() || phase === "loading"}
            className="min-h-11 w-full rounded-lg bg-ink px-6 text-[14px] font-semibold text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-45 sm:w-auto"
          >
            {phase === "loading" ? "검색 중…" : "검색"}
          </button>
        </div>

        <details className="rounded-[12px] border border-line bg-panel">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-[13px] font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
            <span>필터</span>
            <span className="text-inkSoft">활성 필터 {count}개</span>
          </summary>
          <div data-testid="search-filter-fields" className="flex flex-col gap-4 border-t border-line p-4 sm:grid sm:grid-cols-2">
            <label className="block min-w-0 text-[13px] font-medium text-ink">
              시작 날짜
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(event) => search.updateFilter("dateFrom", event.currentTarget.value)}
                className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-inkFaint bg-bg px-3 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
            <label className="block min-w-0 text-[13px] font-medium text-ink">
              종료 날짜
              <input
                type="date"
                value={filters.dateTo}
                onChange={(event) => search.updateFilter("dateTo", event.currentTarget.value)}
                className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-inkFaint bg-bg px-3 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
            <label className="block min-w-0 text-[13px] font-medium text-ink">
              워크스페이스
              <select
                value={filters.workspaceId}
                onChange={(event) => search.setWorkspaceFilter(event.currentTarget.value)}
                className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-inkFaint bg-bg px-3 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <option value="">전체 워크스페이스</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </label>
            <label className="block min-w-0 text-[13px] font-medium text-ink">
              폴더
              <select
                value={filters.folderId}
                disabled={!filters.workspaceId}
                onChange={(event) => search.updateFilter("folderId", event.currentTarget.value)}
                className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-inkFaint bg-bg px-3 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                <option value="">전체 폴더</option>
                <option value="unfiled">미분류</option>
                {availableFolders.map((folder) => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
            </label>
            <label className="block min-w-0 text-[13px] font-medium text-ink">
              상태
              <select
                value={filters.status}
                onChange={(event) => search.updateFilter("status", event.currentTarget.value as SearchFilterDraft["status"])}
                className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-inkFaint bg-bg px-3 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <option value="">전체 상태</option>
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="flex min-h-11 min-w-0 items-center gap-3 self-end text-[13px] font-medium text-ink">
              <input
                type="checkbox"
                checked={filters.hasActionItem}
                onChange={(event) => search.updateFilter("hasActionItem", event.currentTarget.checked)}
                className="h-4 w-4 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              할 일이 있는 회의만
            </label>
          </div>
        </details>
        <button
          type="button"
          disabled={count === 0}
          onClick={search.resetFilters}
          className="min-h-11 rounded-lg px-3 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:text-inkSoft disabled:opacity-50"
        >
          필터 초기화
        </button>
      </form>

      <div className="min-h-[12rem] space-y-4" aria-live="polite">
        {phase === "initial" && !response && (
          <section className="border-y border-line py-8">
            <h2 className="text-[17px] font-bold text-ink">회의를 찾아보세요</h2>
            <p className="mt-2 text-[14px] text-inkSoft">검색어를 입력하고 검색을 선택하면 결과가 여기에 표시됩니다.</p>
          </section>
        )}

        {phase === "loading" && (
          <p role="status" className="rounded-[12px] border border-line bg-soft px-4 py-3 text-[13px] text-ink">
            검색 중입니다…
          </p>
        )}

        {requestError && (
          <p role="status" className="rounded-[12px] border border-error/30 bg-panel px-4 py-3 text-[13px] text-error">
            {requestError}
          </p>
        )}

        {response?.index.status === "partial" && (
          <section className="rounded-[12px] border border-warn/40 bg-warnBg px-4 py-3 text-[13px] text-ink">
            <p className="font-semibold">일부 회의의 검색 데이터가 아직 최신 상태가 아닙니다.</p>
            <p className="mt-1 text-inkSoft">현재 확인할 수 있는 결과는 그대로 표시합니다.</p>
          </section>
        )}

        {response && response.summaryPendingCount > 0 && (
          <p className="rounded-[12px] border border-line bg-panel px-4 py-3 text-[13px] text-inkSoft">
            요약 대기 회의 {response.summaryPendingCount}개는 제목·날짜·위치·참석자만 검색될 수 있습니다.
          </p>
        )}

        {showDataUpdate && (
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              aria-disabled={reindexPhase === "running"}
              onClick={() => void search.reindex()}
              className="min-h-11 rounded-lg border border-inkFaint bg-panel px-4 text-[13px] font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-disabled:opacity-50"
            >
              {reindexPhase === "running" ? "업데이트 중…" : "검색 데이터 업데이트"}
            </button>
            {reindexPhase === "success" && (
              <span role="status" className="text-[13px] text-success">같은 조건으로 다시 검색했습니다.</span>
            )}
            {reindexPhase === "error" && (
              <span role="status" className="text-[13px] text-error">검색 데이터를 업데이트하지 못했습니다. 다시 시도해 주세요.</span>
            )}
          </div>
        )}

        {response && (
          <SearchResults
            response={response}
            activeFilterCount={count}
            onResetFilters={search.resetFilters}
          />
        )}
      </div>
    </>
  );
}

export function SearchOverlay({
  open,
  onDismiss,
  returnFocus = null,
  initialReplay = null,
}: {
  open: boolean;
  onDismiss: () => void;
  returnFocus?: HTMLElement | null;
  initialReplay?: NonNullable<ChatResponse["searchReplay"]> | null;
}) {
  const search = useMeetingSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  // Replay a chatbot-provided search exactly once per open. The ref resets when
  // the overlay closes so a later open with a fresh replay runs again.
  const replayRef = useRef(search.replay);
  replayRef.current = search.replay;
  const replayedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      replayedRef.current = false;
      return;
    }
    if (replayedRef.current || !initialReplay) return;
    replayedRef.current = true;
    replayRef.current(initialReplay);
  }, [open, initialReplay]);
  return (
    <AppDialog
      open={open}
      title="회의 검색"
      onDismiss={onDismiss}
      initialFocusRef={inputRef}
      returnFocus={returnFocus}
      className="max-w-2xl"
      panelClassName="max-h-[calc(100dvh-2rem)] overflow-y-auto space-y-6 p-6"
    >
      <SearchPanel search={search} inputRef={inputRef} />
    </AppDialog>
  );
}
