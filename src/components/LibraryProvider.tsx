"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { LibraryVersion } from "@/domain/library";
import {
  acceptIndependentFreshness,
  acceptVersionedFreshness,
  addPageToWindow,
  applyMeetingMoveToPageWindow,
  createPageWindow,
  createResourcePoller,
  libraryScopeKey,
  libraryVersionKey,
  formatLocationBreadcrumb,
  markCurrentPage,
  organizationPendingClientSchema,
  publicLibraryClientSchema,
  resetPageWindowForVersion,
  scopedMeetingPageClientSchema,
  summaryWorkClientSchema,
  type IndependentFreshness,
  type OrganizationPendingClientPayload,
  type PageWindow,
  type PublicLibraryClientPayload,
  type SummaryWorkClientPayload,
  type VersionedFreshness,
} from "@/lib/libraryClient";
import type { LibraryMeetingScope, PublicLibraryView } from "@/lib/libraryQuery";

interface LibraryProviderState {
  mode: PublicLibraryClientPayload["mode"] | "loading";
  version: LibraryVersion | null;
  library: PublicLibraryView | null;
  degradedReason?: PublicLibraryClientPayload["degradedReason"];
  recovery: { canRebuild: boolean; fingerprint: string } | null;
  scope: LibraryMeetingScope | null;
  pages: PageWindow;
  expandedFolderIds: Set<string>;
  summaryWork: SummaryWorkClientPayload | null;
  organizationPending: OrganizationPendingClientPayload | null;
  generationResult: LibraryGenerationResult | null;
  generationEpoch: number;
}

export interface LibraryGenerationResult {
  discoveredVisibleMeetingCount: number;
  organizationReset: boolean;
  archivePreserved: boolean;
}

export interface LibraryMutationResult {
  response: Response;
  payload: PublicLibraryClientPayload | null;
  accepted: boolean;
}

export interface LibraryProviderValue extends LibraryProviderState {
  setScope(scope: LibraryMeetingScope): void;
  setCurrentPage(position: number): void;
  loadPage(input: { position: number; cursor?: string | null }): Promise<void>;
  toggleFolder(folderId: string): void;
  refreshLibrary(): void;
  refreshSummaryWork(attentionAfter?: string | null): void;
  refreshOrganizationPending(cursor?: string | null): void;
  runLibraryMutation(url: string, init: RequestInit): Promise<LibraryMutationResult>;
  invalidateStatusWork(): void;
  invalidateOrganizationPending(): void;
  updateMeetingTitle(meetingId: string, title: string): void;
  removeMeeting(meetingId: string): void;
  applyMeetingMove?(
    meetingId: string,
    actual: { workspaceId: string; folderId: string | null },
  ): boolean;
  resetForGeneration(result?: LibraryGenerationResult): void;
}

const LibraryContext = createContext<LibraryProviderValue | null>(null);

const INITIAL_PAGES = createPageWindow("uninitialized", "none");

function initialState(): LibraryProviderState {
  return {
    mode: "loading",
    version: null,
    library: null,
    recovery: null,
    scope: null,
    pages: INITIAL_PAGES,
    expandedFolderIds: new Set(),
    summaryWork: null,
    organizationPending: null,
    generationResult: null,
    generationEpoch: 0,
  };
}

function scopeQuery(scope: LibraryMeetingScope, cursor?: string | null): string {
  const query = new URLSearchParams();
  if (scope.kind === "global") query.set("view", "global");
  else query.set("workspaceId", scope.workspaceId);
  if (scope.kind === "unfiled") query.set("view", "unfiled");
  if (scope.kind === "folder") query.set("folderId", scope.folderId);
  if (cursor) query.set("cursor", cursor);
  query.set("limit", "50");
  return query.toString();
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LibraryProviderState>(initialState);
  const mountedRef = useRef(true);
  const librarySequenceRef = useRef(0);
  const summarySequenceRef = useRef(0);
  const pendingSequenceRef = useRef(0);
  const libraryEpochRef = useRef(0);
  const statusEpochRef = useRef(0);
  const pendingEpochRef = useRef(0);
  const libraryFreshnessRef = useRef<VersionedFreshness | null>(null);
  const degradedFreshnessRef = useRef<IndependentFreshness | null>(null);
  const summaryFreshnessRef = useRef<IndependentFreshness | null>(null);
  const pendingFreshnessRef = useRef<IndependentFreshness | null>(null);
  const generationTransitionRef = useRef(false);
  const libraryPollerRef = useRef<ReturnType<typeof createResourcePoller> | null>(null);
  const summaryPollerRef = useRef<ReturnType<typeof createResourcePoller> | null>(null);
  const pendingPollerRef = useRef<ReturnType<typeof createResourcePoller> | null>(null);
  const pageAbortRef = useRef<AbortController | null>(null);
  const pageSequenceRef = useRef(0);
  const pageOperationEpochRef = useRef(0);
  const mutationPageSnapshotRef = useRef<{
    pages: PageWindow;
    scope: LibraryMeetingScope | null;
  } | null>(null);
  const lastMutationPayloadRef = useRef<PublicLibraryClientPayload | null>(null);
  const mutationControllersRef = useRef(new Set<AbortController>());

  const acceptLibrary = useCallback((
    payload: PublicLibraryClientPayload,
    sequence: number,
    operationEpoch: number,
    allowGenerationTransition = false,
  ): boolean => {
    if (!mountedRef.current) return false;
    if (operationEpoch < libraryEpochRef.current) {
      const current = libraryFreshnessRef.current;
      if (!payload.version || !current
        || payload.version.libraryId !== current.libraryId
        || payload.version.revision <= current.revision) return false;
    }
    let resetPages = false;
    let completedGenerationTransition = false;
    if (payload.version) {
      const incoming: VersionedFreshness = { ...payload.version, sequence, operationEpoch };
      const decision = acceptVersionedFreshness(libraryFreshnessRef.current, incoming, {
        allowGenerationTransition: allowGenerationTransition || generationTransitionRef.current,
      });
      if (!decision.accept) return false;
      completedGenerationTransition = generationTransitionRef.current
        && payload.version.libraryId !== libraryFreshnessRef.current?.libraryId;
      libraryFreshnessRef.current = incoming;
      degradedFreshnessRef.current = { sequence, operationEpoch };
      generationTransitionRef.current = false;
      resetPages = decision.resetPages;
    } else {
      const incoming = { sequence, operationEpoch };
      if (!acceptIndependentFreshness(degradedFreshnessRef.current, incoming)) return false;
      degradedFreshnessRef.current = incoming;
      resetPages = true;
    }
    setState((current) => {
      const versionKey = libraryVersionKey(payload.version);
      const scopeKey = current.scope ? libraryScopeKey(current.scope) : "none";
      const recovery = (payload as PublicLibraryClientPayload & {
        recovery?: { canRebuild: boolean; fingerprint: string } | null;
      }).recovery ?? null;
      return {
        ...current,
        mode: payload.mode,
        version: payload.version,
        library: payload.library as PublicLibraryView | null,
        degradedReason: payload.degradedReason,
        recovery,
        pages: resetPages
          ? resetPageWindowForVersion(current.pages, versionKey, scopeKey)
          : current.pages,
      };
    });
    if (completedGenerationTransition) pendingPollerRef.current?.refresh();
    return true;
  }, []);

  const loadLibrary = useCallback(async (signal: AbortSignal) => {
    const sequence = ++librarySequenceRef.current;
    const epoch = libraryEpochRef.current;
    const response = await fetch("/api/library", { cache: "no-store", signal });
    if (!response.ok) throw new Error("library_poll_failed");
    const payload = publicLibraryClientSchema.parse(await response.json());
    acceptLibrary(payload, sequence, epoch);
  }, [acceptLibrary]);

  const loadSummary = useCallback(async (signal: AbortSignal, attentionAfter?: string | null) => {
    const sequence = ++summarySequenceRef.current;
    const epoch = statusEpochRef.current;
    const query = attentionAfter ? `?attentionAfter=${encodeURIComponent(attentionAfter)}` : "";
    const response = await fetch(`/api/summary-work${query}`, { cache: "no-store", signal });
    if (!response.ok) throw new Error("summary_work_poll_failed");
    const payload = summaryWorkClientSchema.parse(await response.json());
    if (epoch < statusEpochRef.current) return;
    const incoming = { sequence, operationEpoch: epoch };
    if (!acceptIndependentFreshness(summaryFreshnessRef.current, incoming)) return;
    summaryFreshnessRef.current = incoming;
    if (mountedRef.current) setState((current) => ({ ...current, summaryWork: payload }));
  }, []);

  const loadPending = useCallback(async (signal: AbortSignal, cursor?: string | null) => {
    const sequence = ++pendingSequenceRef.current;
    const epoch = pendingEpochRef.current;
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`/api/organization-pending?${query.toString()}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error("organization_pending_poll_failed");
    const payload = organizationPendingClientSchema.parse(await response.json());
    if (epoch < pendingEpochRef.current) return;
    if (payload.version) {
      const currentVersion = libraryFreshnessRef.current;
      if (
        !currentVersion
        || payload.version.libraryId !== currentVersion.libraryId
        || payload.version.revision !== currentVersion.revision
      ) return;
    }
    const incoming = { sequence, operationEpoch: epoch };
    if (!acceptIndependentFreshness(pendingFreshnessRef.current, incoming)) return;
    pendingFreshnessRef.current = incoming;
    if (mountedRef.current) setState((current) => ({ ...current, organizationPending: payload }));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const isVisible = () => document.visibilityState !== "hidden";
    const libraryPoller = createResourcePoller({
      load: loadLibrary,
      isVisible,
      baseDelayMs: 30_000,
      maxDelayMs: 120_000,
    });
    const summaryPoller = createResourcePoller({
      load: (signal) => loadSummary(signal),
      isVisible,
      baseDelayMs: 3_000,
      maxDelayMs: 30_000,
    });
    const pendingPoller = createResourcePoller({
      load: (signal) => loadPending(signal),
      isVisible,
      baseDelayMs: 5_000,
      maxDelayMs: 30_000,
    });
    libraryPollerRef.current = libraryPoller;
    summaryPollerRef.current = summaryPoller;
    pendingPollerRef.current = pendingPoller;
    libraryPoller.start();
    summaryPoller.start();
    pendingPoller.start();
    const visibility = () => {
      libraryPoller.visibilityChanged();
      summaryPoller.visibilityChanged();
      pendingPoller.visibilityChanged();
    };
    const focus = () => {
      libraryPoller.focus();
      summaryPoller.focus();
      pendingPoller.focus();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      libraryPoller.stop();
      summaryPoller.stop();
      pendingPoller.stop();
      pageAbortRef.current?.abort();
      for (const controller of mutationControllersRef.current) controller.abort();
      mutationControllersRef.current.clear();
    };
  }, [loadLibrary, loadPending, loadSummary]);

  const setScope = useCallback((scope: LibraryMeetingScope) => {
    setState((current) => {
      const versionKey = libraryVersionKey(current.version);
      const scopeKey = libraryScopeKey(scope);
      return {
        ...current,
        scope,
        pages: resetPageWindowForVersion(current.pages, versionKey, scopeKey),
      };
    });
  }, []);

  const setCurrentPage = useCallback((position: number) => {
    setState((current) => ({ ...current, pages: markCurrentPage(current.pages, position) }));
  }, []);

  const loadPage = useCallback(async ({ position, cursor }: {
    position: number;
    cursor?: string | null;
  }) => {
    const scope = state.scope;
    if (!scope) return;
    pageAbortRef.current?.abort();
    const controller = new AbortController();
    pageAbortRef.current = controller;
    const sequence = ++pageSequenceRef.current;
    const operationEpoch = pageOperationEpochRef.current;
    const response = await fetch(`/api/meetings?${scopeQuery(scope, cursor)}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("meeting_page_failed");
    const payload = scopedMeetingPageClientSchema.parse(await response.json());
    if (
      sequence !== pageSequenceRef.current
      || operationEpoch !== pageOperationEpochRef.current
      || controller.signal.aborted
    ) return;
    const currentVersion = libraryFreshnessRef.current;
    if (
      !payload.version
      || !currentVersion
      || payload.version.libraryId !== currentVersion.libraryId
      || payload.version.revision !== currentVersion.revision
    ) {
      libraryPollerRef.current?.refresh();
      return;
    }
    setState((current) => ({
      ...current,
      pages: markCurrentPage(addPageToWindow(current.pages, {
        position,
        cursor: cursor ?? null,
        nextCursor: payload.nextCursor,
        rows: payload.meetings,
      }), position),
    }));
  }, [state.scope]);

  const toggleFolder = useCallback((folderId: string) => {
    setState((current) => {
      const expandedFolderIds = new Set(current.expandedFolderIds);
      if (expandedFolderIds.has(folderId)) expandedFolderIds.delete(folderId);
      else expandedFolderIds.add(folderId);
      return { ...current, expandedFolderIds };
    });
  }, []);

  const refreshSummaryWork = useCallback((attentionAfter?: string | null) => {
    if (!attentionAfter) summaryPollerRef.current?.refresh();
    else {
      const controller = new AbortController();
      void loadSummary(controller.signal, attentionAfter).catch(() => {});
    }
  }, [loadSummary]);

  const refreshOrganizationPending = useCallback((cursor?: string | null) => {
    if (!cursor) pendingPollerRef.current?.refresh();
    else {
      const controller = new AbortController();
      void loadPending(controller.signal, cursor).catch(() => {});
    }
  }, [loadPending]);

  const runLibraryMutation = useCallback(async (
    url: string,
    init: RequestInit,
  ): Promise<LibraryMutationResult> => {
    mutationPageSnapshotRef.current = { pages: state.pages, scope: state.scope };
    lastMutationPayloadRef.current = null;
    libraryEpochRef.current += 1;
    const epoch = libraryEpochRef.current;
    libraryPollerRef.current?.stop();
    const sequence = ++librarySequenceRef.current;
    const controller = new AbortController();
    mutationControllersRef.current.add(controller);
    const upstreamSignal = init.signal;
    const abortFromUpstream = () => controller.abort();
    if (upstreamSignal?.aborted) controller.abort();
    else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      let payload: PublicLibraryClientPayload | null = null;
      let accepted = false;
      try {
        const candidate = publicLibraryClientSchema.parse(await response.clone().json());
        if (epoch === libraryEpochRef.current && !controller.signal.aborted) {
          accepted = acceptLibrary(candidate, sequence, epoch);
          if (accepted) {
            payload = candidate;
            lastMutationPayloadRef.current = candidate;
          }
        }
      } catch {
        // Non-authoritative validation errors have no library payload.
      }
      return { response, payload, accepted };
    } finally {
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
      mutationControllersRef.current.delete(controller);
      if (epoch === libraryEpochRef.current) {
        libraryPollerRef.current?.start();
        libraryPollerRef.current?.refresh();
      }
    }
  }, [acceptLibrary, state.pages, state.scope]);

  const invalidateStatusWork = useCallback(() => {
    statusEpochRef.current += 1;
    summaryPollerRef.current?.refresh();
  }, []);

  const invalidatePending = useCallback(() => {
    pendingEpochRef.current += 1;
    pendingPollerRef.current?.refresh();
  }, []);

  const updateMeetingTitle = useCallback((meetingId: string, title: string) => {
    pageOperationEpochRef.current += 1;
    setState((current) => {
      const entity = current.pages.entities.get(meetingId);
      if (!entity) return current;
      const entities = new Map(current.pages.entities);
      entities.set(meetingId, { ...entity, title });
      return { ...current, pages: { ...current.pages, entities } };
    });
    invalidateStatusWork();
  }, [invalidateStatusWork]);

  const removeMeeting = useCallback((meetingId: string) => {
    pageOperationEpochRef.current += 1;
    setState((current) => {
      const entities = new Map(current.pages.entities);
      entities.delete(meetingId);
      const pages = new Map([...current.pages.pages].map(([position, page]) => [
        position,
        { ...page, ids: page.ids.filter((id) => id !== meetingId) },
      ]));
      return { ...current, pages: { ...current.pages, entities, pages } };
    });
    invalidateStatusWork();
    invalidatePending();
  }, [invalidatePending, invalidateStatusWork]);

  const applyMeetingMove = useCallback((
    meetingId: string,
    actual: { workspaceId: string; folderId: string | null },
  ): boolean => {
    const snapshot = mutationPageSnapshotRef.current;
    const payload = lastMutationPayloadRef.current;
    if (!snapshot?.scope || !payload?.version || !payload.library) return false;
    const fullBreadcrumb = formatLocationBreadcrumb(
      payload.library as PublicLibraryView,
      actual.workspaceId,
      actual.folderId,
    );
    const breadcrumb = actual.folderId === null ? [] : fullBreadcrumb.slice(1);
    const moved = applyMeetingMoveToPageWindow(snapshot.pages, {
      scope: snapshot.scope,
      meetingId,
      actual,
      breadcrumb,
      versionKey: libraryVersionKey(payload.version),
    });
    pageOperationEpochRef.current += 1;
    setState((current) => ({ ...current, pages: moved.pages }));
    mutationPageSnapshotRef.current = null;
    lastMutationPayloadRef.current = null;
    invalidatePending();
    return moved.retained;
  }, [invalidatePending]);

  const resetForGeneration = useCallback((result?: LibraryGenerationResult) => {
    generationTransitionRef.current = true;
    libraryEpochRef.current += 1;
    statusEpochRef.current += 1;
    pendingEpochRef.current += 1;
    pageOperationEpochRef.current += 1;
    pageSequenceRef.current += 1;
    libraryFreshnessRef.current = null;
    degradedFreshnessRef.current = null;
    summaryFreshnessRef.current = null;
    pendingFreshnessRef.current = null;
    pageAbortRef.current?.abort();
    pageAbortRef.current = null;
    mutationPageSnapshotRef.current = null;
    lastMutationPayloadRef.current = null;
    for (const controller of mutationControllersRef.current) controller.abort();
    mutationControllersRef.current.clear();
    setState((current) => ({
      ...current,
      mode: "loading",
      version: null,
      library: null,
      recovery: null,
      pages: createPageWindow("generation-transition", "none"),
      scope: null,
      expandedFolderIds: new Set(),
      summaryWork: null,
      organizationPending: null,
      generationResult: result ?? null,
      generationEpoch: current.generationEpoch + 1,
    }));
    libraryPollerRef.current?.start();
    libraryPollerRef.current?.refresh();
    summaryPollerRef.current?.refresh();
  }, []);

  const value = useMemo<LibraryProviderValue>(() => ({
    ...state,
    setScope,
    setCurrentPage,
    loadPage,
    toggleFolder,
    refreshLibrary: () => libraryPollerRef.current?.refresh(),
    refreshSummaryWork,
    refreshOrganizationPending,
    runLibraryMutation,
    invalidateStatusWork,
    invalidateOrganizationPending: invalidatePending,
    updateMeetingTitle,
    removeMeeting,
    applyMeetingMove,
    resetForGeneration,
  }), [
    state,
    setScope,
    setCurrentPage,
    loadPage,
    toggleFolder,
    refreshSummaryWork,
    refreshOrganizationPending,
    runLibraryMutation,
    invalidateStatusWork,
    invalidatePending,
    updateMeetingTitle,
    removeMeeting,
    applyMeetingMove,
    resetForGeneration,
  ]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryProviderValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("useLibrary must be used inside LibraryProvider");
  return value;
}

export function useOptionalLibrary(): LibraryProviderValue | null {
  return useContext(LibraryContext);
}
