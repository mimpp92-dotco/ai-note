"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/EmptyState";
import { GuardedLink } from "@/components/RecorderNavigation";
import { LibraryLocationPicker } from "@/components/LibraryLocationPicker";
import { useLibrary } from "@/components/LibraryProvider";
import { LibraryRecoveryPanel } from "@/components/LibraryRecoveryPanel";
import { MeetingList, type MeetingListItem } from "@/components/MeetingList";
import { PendingBanner } from "@/components/PendingBanner";
import { Recorder } from "@/components/Recorder";
import { getLlmReadiness } from "@/components/healthStatus";
import { useHealth } from "@/components/useHealth";
import {
  libraryScopeKey,
  formatLocationBreadcrumb,
  resolveCanonicalLibraryScope,
} from "@/lib/libraryClient";
import type { LibraryMeetingScope, ScopedMeetingRow } from "@/lib/libraryQuery";

export function splitBacklog(meetings: MeetingListItem[]): {
  pending: number;
  needsAttention: number;
} {
  const transcribed = meetings.filter((meeting) => meeting.status === "transcribed");
  return {
    pending: transcribed.filter((meeting) => meeting.error?.action !== "retry_summary").length,
    needsAttention: transcribed.filter((meeting) => meeting.error?.action === "retry_summary").length,
  };
}

function sameScope(left: LibraryMeetingScope | null, right: LibraryMeetingScope): boolean {
  return left !== null && libraryScopeKey(left) === libraryScopeKey(right);
}

function detailHref(meetingId: string, scope: LibraryMeetingScope): string {
  if (scope.kind === "global") return `/meetings/${meetingId}`;
  const query = new URLSearchParams({
    sourceWorkspace: scope.workspaceId,
    sourceView: scope.kind === "workspace" ? "all" : scope.kind,
  });
  if (scope.kind === "folder") query.set("sourceFolder", scope.folderId);
  return `/meetings/${meetingId}?${query.toString()}`;
}

function scopeTitle(scope: LibraryMeetingScope, library: NonNullable<ReturnType<typeof useLibrary>["library"]>): string {
  if (scope.kind === "global") return "모든 회의";
  const workspace = library.workspaces.find((candidate) => candidate.id === scope.workspaceId);
  if (scope.kind === "workspace") return `${workspace?.name ?? "워크스페이스"} · 모든 회의`;
  if (scope.kind === "unfiled") return `${workspace?.name ?? "워크스페이스"} · 미분류`;
  return library.folders.find((candidate) => candidate.id === scope.folderId)?.name ?? "폴더";
}

function emptyCopy(scope: LibraryMeetingScope): string {
  if (scope.kind === "folder") return "이 폴더에는 아직 회의가 없습니다.";
  if (scope.kind === "unfiled") return "미분류 회의가 없습니다.";
  if (scope.kind === "workspace") return "이 워크스페이스에는 아직 회의가 없습니다.";
  return "아직 회의록이 없습니다.";
}

export function HomeClient() {
  const libraryState = useLibrary();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { llm } = useHealth();
  const [canonicalMessage, setCanonicalMessage] = useState<string | null>(null);
  const [moveNotice, setMoveNotice] = useState<{
    title: string;
    actual: { workspaceId: string; folderId: string | null };
  } | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    id: string;
    title: string;
    trigger: HTMLElement;
  } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastCanonicalReplaceRef = useRef<string | null>(null);
  const generationEpochRef = useRef(libraryState.generationEpoch);

  const resolution = useMemo(() => (
    libraryState.library
      ? resolveCanonicalLibraryScope(new URLSearchParams(searchParams.toString()), libraryState.library)
      : null
  ), [libraryState.library, searchParams]);

  useEffect(() => {
    if (generationEpochRef.current !== libraryState.generationEpoch) {
      setPendingMove(null);
      setMoveNotice(null);
      setCanonicalMessage(null);
      lastCanonicalReplaceRef.current = null;
      generationEpochRef.current = libraryState.generationEpoch;
    }
  }, [libraryState.generationEpoch]);

  useEffect(() => {
    if (!resolution) return;
    if (resolution.replace) {
      const destination = `/?${resolution.search}`;
      if (lastCanonicalReplaceRef.current === destination) return;
      lastCanonicalReplaceRef.current = destination;
      setCanonicalMessage("요청한 위치를 찾을 수 없어 기본 워크스페이스의 모든 회의로 이동했습니다.");
      router.replace(destination);
      return;
    }
    lastCanonicalReplaceRef.current = null;
    if (!sameScope(libraryState.scope, resolution.scope)) libraryState.setScope(resolution.scope);
  }, [libraryState, resolution, router]);

  useEffect(() => {
    if (libraryState.mode !== "degraded_fallback") return;
    if (libraryState.scope?.kind !== "global") libraryState.setScope({ kind: "global" });
  }, [libraryState]);

  const scope = resolution?.replace ? null : resolution?.scope ?? libraryState.scope;
  const currentPage = libraryState.pages.pages.get(libraryState.pages.currentPosition);
  const rows = currentPage?.ids
    .map((id) => libraryState.pages.entities.get(id))
    .filter((row): row is ScopedMeetingRow => row !== undefined) ?? [];

  useEffect(() => {
    if (!scope || window.sessionStorage.getItem("ai-note-focus-scope") !== "1") return;
    window.sessionStorage.removeItem("ai-note-focus-scope");
    window.requestAnimationFrame(() => {
      if (document.activeElement?.closest("dialog[open]")) return;
      headingRef.current?.focus();
    });
  }, [scope]);

  useEffect(() => {
    if (!scope || libraryState.mode === "loading" || resolution?.replace) return;
    const expectedScopeKey = libraryScopeKey(scope);
    if (libraryState.pages.scopeKey !== expectedScopeKey) return;
    const position = libraryState.pages.currentPosition;
    if (!libraryState.pages.pages.has(position)) {
      void libraryState.loadPage({
        position,
        cursor: libraryState.pages.cursorHistory.get(position) ?? null,
      }).catch(() => {});
    }
  }, [libraryState, resolution?.replace, scope]);

  useEffect(() => {
    if (!scope || !currentPage) return;
    const active = rows.some((row) => !["summarized"].includes(row.status));
    const delay = active ? 3_000 : 30_000;
    const timer = window.setInterval(() => {
      void libraryState.loadPage({
        position: currentPage.position,
        cursor: currentPage.cursor,
      }).catch(() => {});
    }, delay);
    return () => window.clearInterval(timer);
  }, [currentPage, libraryState, rows, scope]);

  if (libraryState.mode === "loading") {
    return (
      <main id="main" className="w-full max-w-5xl px-6 py-12" aria-busy="true">
        <div className="h-8 w-48 animate-pulse rounded bg-soft motion-reduce:animate-none" />
        <div className="mt-8 h-36 rounded-2xl bg-soft" />
      </main>
    );
  }

  if (libraryState.mode === "degraded_fallback" || !libraryState.library) {
    return (
      <main id="main" className="w-full max-w-5xl space-y-8 px-6 py-12">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-ink">모든 회의</h1>
          <p className="mt-2 text-[15px] text-inkSoft">조직 위치 없이 저장하고 전체 회의를 표시합니다.</p>
        </header>
        <LibraryRecoveryPanel
          mode={libraryState.mode === "degraded_last_good" ? "degraded_last_good" : "degraded_fallback"}
          reason={libraryState.degradedReason}
          recovery={libraryState.recovery}
          onRetry={libraryState.refreshLibrary}
        />
        <div className="rounded-[14px] border border-warn/40 bg-warnBg px-5 py-4 text-[14px] text-ink">
          새 녹음은 <span className="font-semibold">조직 위치 없이 저장</span>되며 조직 정보 없이 발견된 회의로 표시됩니다.
        </div>
        <Recorder />
        {rows.length === 0 ? (
          <EmptyState />
        ) : (
          <section className="space-y-4">
            <h2 className="text-[16px] font-bold text-ink">회의 목록</h2>
            <MeetingList
              meetings={rows}
              onRenamed={(id, title) => libraryState.updateMeetingTitle(id, title)}
              onDeleted={(id) => libraryState.removeMeeting(id)}
            />
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                disabled={libraryState.pages.currentPosition === 0}
                onClick={() => {
                  const position = libraryState.pages.currentPosition - 1;
                  libraryState.setCurrentPage(position);
                  if (!libraryState.pages.pages.has(position)) void libraryState.loadPage({
                    position,
                    cursor: libraryState.pages.cursorHistory.get(position) ?? null,
                  });
                }}
                className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent disabled:opacity-40"
              >이전</button>
              <button
                type="button"
                disabled={!currentPage?.nextCursor}
                onClick={() => {
                  const position = libraryState.pages.currentPosition + 1;
                  libraryState.setCurrentPage(position);
                  if (!libraryState.pages.pages.has(position)) void libraryState.loadPage({
                    position,
                    cursor: currentPage?.nextCursor ?? null,
                  });
                }}
                className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent disabled:opacity-40"
              >다음</button>
            </div>
          </section>
        )}
      </main>
    );
  }

  if (!scope || resolution?.replace) {
    return (
      <main id="main" className="w-full max-w-5xl px-6 py-12" aria-busy="true">
        <p className="text-[14px] text-inkSoft">회의 위치를 확인하는 중…</p>
        <span className="sr-only" aria-live="polite">{canonicalMessage}</span>
      </main>
    );
  }

  const library = libraryState.library;
  const defaultAll = scope.kind === "workspace" && scope.workspaceId === library.defaultWorkspaceId;
  const requestedRecorderLocation = scope.kind === "global"
    ? undefined
    : {
        workspaceId: scope.workspaceId,
        folderId: scope.kind === "folder" ? scope.folderId : null,
      };
  const summaryWork = libraryState.summaryWork?.summaryWork;
  const requestedWorkspaceName = (workspaceId: string) => (
    library.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "알 수 없는 워크스페이스"
  );
  const requestedFolderName = (folderId: string | null) => (
    folderId === null
      ? "미분류"
      : library.folders.find((folder) => folder.id === folderId)?.name ?? "사라진 폴더"
  );
  const movedHref = moveNotice
    ? `/?workspace=${moveNotice.actual.workspaceId}${
        moveNotice.actual.folderId ? `&folder=${moveNotice.actual.folderId}` : "&view=unfiled"
      }`
    : null;
  const movedLabel = moveNotice
    ? formatLocationBreadcrumb(
        library,
        moveNotice.actual.workspaceId,
        moveNotice.actual.folderId,
      ).join(" / ")
    : "";

  const goPage = (position: number, cursor: string | null) => {
    libraryState.setCurrentPage(position);
    if (!libraryState.pages.pages.has(position)) {
      void libraryState.loadPage({ position, cursor }).catch(() => {});
    }
  };

  return (
    <main id="main" className="w-full max-w-5xl space-y-8 px-6 py-12">
      <header>
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold tracking-tight text-ink">
          {scopeTitle(scope, library)}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-inkSoft">회의 녹음 → 로컬 전사 → 회의록 요약.</p>
      </header>
      <span className="sr-only" aria-live="polite">{canonicalMessage}</span>

      {libraryState.generationResult && (
        <section
          className="rounded-[14px] border border-success/40 bg-panel px-5 py-4"
          role="status"
          aria-live="polite"
        >
          <h2 className="text-[14px] font-bold text-ink">조직 정보 재구축 완료</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-inkSoft">
            발견한 회의 {libraryState.generationResult.discoveredVisibleMeetingCount}개를 새 기본 워크스페이스의 미분류에 배치했습니다.
            손상된 조직 정보 원본은 로컬 보관본으로 보존했습니다.
          </p>
        </section>
      )}

      {moveNotice && movedHref && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-success/40 bg-panel px-5 py-4" role="status" aria-live="polite">
          <p className="text-[13px] text-ink">
            <span className="font-semibold">{moveNotice.title}</span>을(를) {movedLabel || "선택한 위치"}(으)로 이동했습니다.
          </p>
          <div className="flex gap-2">
            <GuardedLink
              href={movedHref}
              onClick={() => window.sessionStorage.setItem("ai-note-focus-scope", "1")}
              className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] font-semibold text-accent"
            >
              이동한 위치 열기
            </GuardedLink>
            <button type="button" onClick={() => setMoveNotice(null)} className="min-h-11 rounded-full px-3 text-[13px] text-inkSoft">닫기</button>
          </div>
        </section>
      )}

      {libraryState.mode === "degraded_last_good" && (
        <LibraryRecoveryPanel
          mode={libraryState.mode}
          reason={libraryState.degradedReason}
          recovery={libraryState.recovery}
          onRetry={libraryState.refreshLibrary}
        />
      )}

      {libraryState.mode === "ready" ? (
        <section className="space-y-3">
          <p className="rounded-[12px] border border-line bg-panel px-4 py-3 text-[13px] text-inkSoft">
            새 녹음은 <span className="font-semibold text-ink">
              {scope.kind === "folder"
                ? `${scopeTitle(scope, library)} 폴더에 저장`
                : "이 워크스페이스의 미분류에 저장"}
            </span>됩니다.
          </p>
          <Recorder requestedLocation={requestedRecorderLocation} />
        </section>
      ) : (
        <section className="space-y-3">
          <p className="rounded-[14px] border border-warn/40 bg-warnBg px-5 py-4 text-[14px] text-ink">
            마지막으로 확인된 위치를 요청합니다. 조직 정보가 아직 읽기 전용이므로 실제 위치는 저장 뒤 unavailable 또는 fallback이 될 수 있습니다.
          </p>
          <Recorder requestedLocation={requestedRecorderLocation} />
        </section>
      )}

      {summaryWork && (
        <PendingBanner
          count={summaryWork.processing}
          needsAttention={summaryWork.needsAttention}
          attention={summaryWork.attention}
          readiness={getLlmReadiness(llm)}
        />
      )}

      {library.counts.organizationPendingCount > 0 && !defaultAll && (
        <GuardedLink href={`/?workspace=${library.defaultWorkspaceId}#organization-pending`} className="flex min-h-11 items-center justify-between rounded-[14px] border border-warn/40 bg-warnBg px-5 text-[13px] font-semibold text-warn">
          <span>위치 저장 대기 회의 보기</span><span>{library.counts.organizationPendingCount}</span>
        </GuardedLink>
      )}

      {rows.length === 0 ? (
        <section className="rounded-[16px] border border-line bg-panel px-6 py-10 text-center">
          <h2 className="text-[16px] font-bold text-ink">{emptyCopy(scope)}</h2>
          {defaultAll && <div className="mt-4"><EmptyState /></div>}
        </section>
      ) : (
        <section className="space-y-4">
          <h2 className="text-[16px] font-bold text-ink">회의 목록</h2>
          <MeetingList
            meetings={rows}
            detailHref={(meeting) => detailHref(meeting.id, scope)}
            onRenamed={(id, title) => libraryState.updateMeetingTitle(id, title)}
            onDeleted={(id) => libraryState.removeMeeting(id)}
            onMoved={(id, actual) => {
              setMoveNotice({
                title: rows.find((meeting) => meeting.id === id)?.title ?? "회의",
                actual,
              });
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={libraryState.pages.currentPosition === 0}
              onClick={() => {
                const position = libraryState.pages.currentPosition - 1;
                goPage(position, libraryState.pages.cursorHistory.get(position) ?? null);
              }}
              className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent disabled:opacity-40"
            >
              이전
            </button>
            <span className="text-[12px] text-inkSoft">{libraryState.pages.currentPosition + 1}페이지</span>
            <button
              type="button"
              disabled={!currentPage?.nextCursor}
              onClick={() => {
                const position = libraryState.pages.currentPosition + 1;
                goPage(position, currentPage?.nextCursor ?? null);
              }}
              className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent disabled:opacity-40"
            >
              다음
            </button>
          </div>
        </section>
      )}

      {defaultAll && libraryState.organizationPending && libraryState.organizationPending.count > 0 && (
        <section id="organization-pending" className="space-y-3 rounded-[16px] border border-warn/40 bg-warnBg p-5">
          <div>
            <h2 className="text-[16px] font-bold text-ink">조직 정보 없이 발견된 회의</h2>
            <p className="mt-1 text-[13px] text-inkSoft">위치 저장이 끝나지 않은 회의입니다. 회의 상세에서 저장 상태를 다시 확인할 수 있습니다.</p>
          </div>
          <ul className="space-y-2">
            {libraryState.organizationPending.rows.map((row) => (
              <li key={row.id} className="rounded-xl border border-warn/40 bg-panel px-4 py-3">
                <GuardedLink href={`/meetings/${row.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-ink">{row.title}</span>
                  <span className="rounded-full bg-warnBg px-3 py-1 text-[12px] font-semibold text-warn">위치 저장 안 됨</span>
                </GuardedLink>
                <p className="mt-1 text-[12px] text-inkSoft">
                  {row.requested
                    ? `요청 위치: ${requestedWorkspaceName(row.requested.workspaceId)} · ${requestedFolderName(row.requested.folderId)}`
                    : "요청 위치 없음 · 조직 정보 없이 저장됨"}
                </p>
                <button
                  type="button"
                  onClick={(event) => setPendingMove({
                    id: row.id,
                    title: row.title,
                    trigger: event.currentTarget,
                  })}
                  className="mt-2 min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent"
                >
                  위치 선택
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pendingMove && (
        <LibraryLocationPicker
          kind="meeting"
          meetingId={pendingMove.id}
          current={null}
          trigger={pendingMove.trigger}
          onClose={() => setPendingMove(null)}
          onMoved={(actual) => setMoveNotice({ title: pendingMove.title, actual })}
        />
      )}
    </main>
  );
}
