import { z } from "zod";

import type { LibraryVersion } from "@/domain/library";
import type {
  LibraryMeetingScope,
  PublicLibraryView,
  ScopedMeetingRow,
} from "@/lib/libraryQuery";

const clientTimestamp = z.string().datetime({ offset: true });
const clientVersion = z.object({ libraryId: z.string().uuid(), revision: z.number().int().nonnegative() }).strict();
const clientWorkspace = z.object({
  id: z.string().uuid(),
  name: z.string(),
  order: z.number().int().nonnegative(),
  createdAt: clientTimestamp,
  updatedAt: clientTimestamp,
}).strict();
const clientFolder = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  parentFolderId: z.string().uuid().nullable(),
  name: z.string(),
  color: z.enum(["brown", "sand", "amber", "olive", "sage"]),
  order: z.number().int().nonnegative(),
  createdAt: clientTimestamp,
  updatedAt: clientTimestamp,
}).strict();
const clientCounts = z.object({
  visibleMeetingCount: z.number().int().nonnegative(),
  hiddenInvalidStatusCount: z.number().int().nonnegative(),
  organizationPendingCount: z.number().int().nonnegative(),
  workspaces: z.array(z.object({
    workspaceId: z.string().uuid(),
    total: z.number().int().nonnegative(),
    unfiled: z.number().int().nonnegative(),
  }).strict()),
  folders: z.array(z.object({
    folderId: z.string().uuid(),
    direct: z.number().int().nonnegative(),
  }).strict()),
}).strict();
export const publicLibraryClientSchema = z.object({
  mode: z.enum(["ready", "degraded_last_good", "degraded_fallback"]),
  version: clientVersion.nullable(),
  library: z.object({
    defaultWorkspaceId: z.string().uuid(),
    workspaces: z.array(clientWorkspace),
    folders: z.array(clientFolder),
    counts: clientCounts,
  }).strict().nullable(),
  degradedReason: z.enum([
    "corrupt",
    "unsupported_version",
    "io_error",
    "recovery_conflict",
    "recovery_not_supported",
  ]).optional(),
  recovery: z.object({
    canRebuild: z.boolean(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().nullable().optional(),
}).passthrough();

const clientStatusError = z.object({
  code: z.string(),
  message: z.string(),
  action: z.enum([
    "retry_transcription",
    "retry_transcript_generation",
    "retry_summary",
  ]),
}).passthrough().nullable();
export const scopedMeetingPageClientSchema = z.object({
  mode: z.enum(["ready", "degraded_last_good", "degraded_fallback"]),
  version: clientVersion.nullable(),
  meetings: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["recording", "recorded", "transcribing", "transcribed", "summarizing", "summarized"]),
    startedAt: clientTimestamp,
    error: clientStatusError,
    contentOperation: z.enum(["initial", "transcript", "summary"]).nullable().optional(),
    // Legacy payloads may still carry the summary-only boolean. New payloads use
    // contentOperation so transcript generation is not rendered as summary work.
    resummarizeInflight: z.boolean().optional(),
    location: z.object({
      workspaceId: z.string().uuid(),
      folderId: z.string().uuid().nullable(),
      breadcrumb: z.array(z.string()),
    }).strict().optional(),
  }).strict()),
  nextCursor: z.string().nullable(),
}).strict();

export const summaryWorkClientSchema = z.object({
  summaryWork: z.object({
    processing: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
    attention: z.object({
      meetingId: z.string(),
      cursor: z.string(),
      action: z.enum(["retry_transcript_generation", "retry_summary"]).optional(),
    }).strict().nullable(),
  }).strict(),
  observedAt: clientTimestamp,
}).strict();

export const organizationPendingClientSchema = z.object({
  count: z.number().int().nonnegative(),
  rows: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["recording", "recorded", "transcribing", "transcribed", "summarizing", "summarized"]),
    startedAt: clientTimestamp,
    error: clientStatusError,
    contentOperation: z.enum(["initial", "transcript", "summary"]).nullable().optional(),
    resummarizeInflight: z.boolean().optional(),
    organizationPending: z.literal(true),
    resolution: z.enum(["pending", "unavailable"]),
    requested: z.object({
      workspaceId: z.string().uuid(),
      folderId: z.string().uuid().nullable(),
    }).strict().nullable(),
    locationSource: z.enum(["explicit", "legacy_default", "unavailable"]).nullable(),
    actual: z.null(),
    action: z.literal("detail_probe"),
  }).strict()),
  nextCursor: z.string().nullable(),
  observedAt: clientTimestamp,
  sequence: z.string().regex(/^[a-f0-9]{64}$/u),
  version: clientVersion.nullable(),
}).strict();

export type PublicLibraryClientPayload = z.infer<typeof publicLibraryClientSchema>;
export type ScopedMeetingPageClientPayload = z.infer<typeof scopedMeetingPageClientSchema>;
export type SummaryWorkClientPayload = z.infer<typeof summaryWorkClientSchema>;
export type OrganizationPendingClientPayload = z.infer<typeof organizationPendingClientSchema>;

export interface VersionedFreshness extends LibraryVersion {
  sequence: number;
  operationEpoch: number;
}

export interface FreshnessDecision {
  accept: boolean;
  resetPages: boolean;
}

export function acceptVersionedFreshness(
  current: VersionedFreshness | null,
  incoming: VersionedFreshness,
  options: { allowGenerationTransition?: boolean } = {},
): FreshnessDecision {
  if (!current) return { accept: true, resetPages: true };
  if (incoming.libraryId !== current.libraryId) {
    return options.allowGenerationTransition
      ? { accept: true, resetPages: true }
      : { accept: false, resetPages: false };
  }
  if (incoming.revision > current.revision) return { accept: true, resetPages: true };
  if (incoming.revision < current.revision) return { accept: false, resetPages: false };
  if (incoming.operationEpoch < current.operationEpoch) {
    return { accept: false, resetPages: false };
  }
  return {
    accept: incoming.sequence >= current.sequence,
    resetPages: false,
  };
}

export interface IndependentFreshness {
  sequence: number;
  operationEpoch: number;
}

export function acceptIndependentFreshness(
  current: IndependentFreshness | null,
  incoming: IndependentFreshness,
): boolean {
  if (!current) return true;
  if (incoming.operationEpoch > current.operationEpoch) return true;
  if (incoming.operationEpoch < current.operationEpoch) return false;
  return incoming.sequence >= current.sequence;
}

export interface ClientPage {
  position: number;
  cursor: string | null;
  nextCursor: string | null;
  ids: string[];
  loadedAt: number;
}

export interface PageWindow {
  versionKey: string;
  scopeKey: string;
  currentPosition: number;
  pages: Map<number, ClientPage>;
  entities: Map<string, ScopedMeetingRow>;
  cursorHistory: Map<number, string | null>;
}

export function createPageWindow(versionKey: string, scopeKey: string): PageWindow {
  return {
    versionKey,
    scopeKey,
    currentPosition: 0,
    pages: new Map(),
    entities: new Map(),
    cursorHistory: new Map(),
  };
}

function trimPageWindow(input: PageWindow): PageWindow {
  const candidates = [...input.pages.values()]
    .filter((page) => Math.abs(page.position - input.currentPosition) <= 2)
    .sort((left, right) => (
      Math.abs(left.position - input.currentPosition) - Math.abs(right.position - input.currentPosition)
      || left.position - right.position
    ));
  const kept: ClientPage[] = [];
  let entityBudget = 0;
  for (const page of candidates) {
    if (kept.length >= 5 || entityBudget + page.ids.length > 500) continue;
    kept.push(page);
    entityBudget += page.ids.length;
  }
  kept.sort((left, right) => left.position - right.position);
  const pages = new Map(kept.map((page) => [page.position, page]));
  const retainedIds = new Set(kept.flatMap((page) => page.ids));
  const entities = new Map<string, ScopedMeetingRow>();
  for (const id of retainedIds) {
    const entity = input.entities.get(id);
    if (entity) entities.set(id, entity);
  }
  return { ...input, pages, entities };
}

export function addPageToWindow(
  input: PageWindow,
  page: {
    position: number;
    cursor: string | null;
    nextCursor: string | null;
    rows: readonly ScopedMeetingRow[];
    loadedAt?: number;
  },
): PageWindow {
  const pages = new Map(input.pages);
  const entities = new Map(input.entities);
  const cursorHistory = new Map(input.cursorHistory);
  const ids = page.rows.map((row) => row.id);
  for (const row of page.rows) entities.set(row.id, structuredClone(row));
  pages.set(page.position, {
    position: page.position,
    cursor: page.cursor,
    nextCursor: page.nextCursor,
    ids,
    loadedAt: page.loadedAt ?? Date.now(),
  });
  cursorHistory.set(page.position, page.cursor);
  if (page.nextCursor !== null) cursorHistory.set(page.position + 1, page.nextCursor);
  return trimPageWindow({ ...input, pages, entities, cursorHistory });
}

export function markCurrentPage(input: PageWindow, position: number): PageWindow {
  return trimPageWindow({ ...input, currentPosition: Math.max(0, position) });
}

export function resetPageWindowForVersion(
  input: PageWindow,
  versionKey: string,
  scopeKey: string,
): PageWindow {
  if (input.versionKey === versionKey && input.scopeKey === scopeKey) return input;
  return createPageWindow(versionKey, scopeKey);
}

function scopeContainsMovedLocation(
  scope: LibraryMeetingScope,
  actual: { workspaceId: string; folderId: string | null },
): boolean {
  if (scope.kind === "global") return true;
  if (scope.workspaceId !== actual.workspaceId) return false;
  if (scope.kind === "workspace") return true;
  if (scope.kind === "unfiled") return actual.folderId === null;
  return scope.folderId === actual.folderId;
}

export function applyMeetingMoveToPageWindow(
  input: PageWindow,
  move: {
    scope: LibraryMeetingScope;
    meetingId: string;
    actual: { workspaceId: string; folderId: string | null };
    breadcrumb: string[];
    versionKey: string;
  },
): { pages: PageWindow; retained: boolean } {
  const retained = scopeContainsMovedLocation(move.scope, move.actual);
  const currentPage = input.pages.get(input.currentPosition);
  if (!currentPage) {
    return {
      retained,
      pages: {
        ...createPageWindow(move.versionKey, input.scopeKey),
        currentPosition: input.currentPosition,
        cursorHistory: new Map(input.cursorHistory),
      },
    };
  }
  const ids = retained
    ? [...currentPage.ids]
    : currentPage.ids.filter((id) => id !== move.meetingId);
  const pages = new Map([[input.currentPosition, { ...currentPage, ids }]]);
  const entities = new Map<string, ScopedMeetingRow>();
  for (const id of ids) {
    const entity = input.entities.get(id);
    if (!entity) continue;
    entities.set(id, id === move.meetingId
      ? {
          ...entity,
          location: {
            workspaceId: move.actual.workspaceId,
            folderId: move.actual.folderId,
            breadcrumb: [...move.breadcrumb],
          },
        }
      : entity);
  }
  return {
    retained,
    pages: {
      ...input,
      versionKey: move.versionKey,
      pages,
      entities,
      cursorHistory: new Map(input.cursorHistory),
    },
  };
}

export function libraryVersionKey(version: LibraryVersion | null): string {
  return version ? `${version.libraryId}:${version.revision}` : "degraded";
}

export function libraryScopeKey(scope: LibraryMeetingScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "folder") return `folder:${scope.workspaceId}:${scope.folderId}`;
  return `${scope.kind}:${scope.workspaceId}`;
}

export interface CanonicalScopeResolution {
  scope: Exclude<LibraryMeetingScope, { kind: "global" }>;
  search: string;
  replace: boolean;
  reason:
    | "missing_workspace"
    | "workspace_missing"
    | "invalid_scope_combination"
    | "folder_missing"
    | "folder_not_in_workspace"
    | null;
}

function canonicalSearch(scope: Exclude<LibraryMeetingScope, { kind: "global" }>): string {
  const search = new URLSearchParams({ workspace: scope.workspaceId });
  if (scope.kind === "unfiled") search.set("view", "unfiled");
  if (scope.kind === "folder") search.set("folder", scope.folderId);
  return search.toString();
}

export function resolveCanonicalLibraryScope(
  search: URLSearchParams,
  library: PublicLibraryView,
): CanonicalScopeResolution {
  const fallbackScope = { kind: "workspace" as const, workspaceId: library.defaultWorkspaceId };
  const fallback = (reason: Exclude<CanonicalScopeResolution["reason"], null>) => {
    const canonical = canonicalSearch(fallbackScope);
    return {
      scope: fallbackScope,
      search: canonical,
      replace: search.toString() !== canonical,
      reason,
    };
  };
  const allowed = new Set(["workspace", "view", "folder"]);
  if ([...search.keys()].some((key) => !allowed.has(key) || search.getAll(key).length !== 1)) {
    return fallback("invalid_scope_combination");
  }
  const workspaceId = search.get("workspace");
  if (!workspaceId) return fallback("missing_workspace");
  if (!library.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return fallback("workspace_missing");
  }
  const view = search.get("view");
  const folderId = search.get("folder");
  if ((view !== null && view !== "unfiled") || (view !== null && folderId !== null)) {
    const requestedFallback = { kind: "workspace" as const, workspaceId };
    const canonical = canonicalSearch(requestedFallback);
    return {
      scope: requestedFallback,
      search: canonical,
      replace: search.toString() !== canonical,
      reason: "invalid_scope_combination",
    };
  }
  let scope: CanonicalScopeResolution["scope"];
  if (folderId !== null) {
    const folder = library.folders.find((candidate) => candidate.id === folderId);
    if (!folder || folder.workspaceId !== workspaceId) {
      const requestedFallback = { kind: "workspace" as const, workspaceId };
      const canonical = canonicalSearch(requestedFallback);
      return {
        scope: requestedFallback,
        search: canonical,
        replace: search.toString() !== canonical,
        reason: !folder ? "folder_missing" : "folder_not_in_workspace",
      };
    }
    scope = { kind: "folder", workspaceId, folderId };
  } else if (view === "unfiled") {
    scope = { kind: "unfiled", workspaceId };
  } else {
    scope = { kind: "workspace", workspaceId };
  }
  const canonical = canonicalSearch(scope);
  return {
    scope,
    search: canonical,
    replace: search.toString() !== canonical,
    reason: null,
  };
}

export type DegradedClientModel =
  | { kind: "ready"; canMutate: true; library: PublicLibraryView }
  | { kind: "last_good"; canMutate: false; library: PublicLibraryView }
  | { kind: "global_fallback"; canMutate: false; library: null };

export function resolveDegradedClientModel(
  mode: "ready" | "degraded_last_good" | "degraded_fallback",
  library: PublicLibraryView | null,
): DegradedClientModel {
  if (mode === "ready" && library) return { kind: "ready", canMutate: true, library };
  if (mode === "degraded_last_good" && library) {
    return { kind: "last_good", canMutate: false, library };
  }
  return { kind: "global_fallback", canMutate: false, library: null };
}

export interface ResourcePoller {
  start(): void;
  refresh(): void;
  focus(): void;
  visibilityChanged(): void;
  stop(): void;
  isInFlight(): boolean;
}

export function createResourcePoller(options: {
  load: (signal: AbortSignal) => Promise<void>;
  isVisible: () => boolean;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: unknown) => void;
  baseDelayMs: number;
  maxDelayMs: number;
}): ResourcePoller {
  const schedule = options.schedule ?? ((callback, delay) => window.setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => window.clearTimeout(handle as number));
  let active = false;
  let inFlight = false;
  let failures = 0;
  let rerunRequested = false;
  let timer: unknown = null;
  let controller: AbortController | null = null;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const arm = () => {
    clearTimer();
    if (!active || !options.isVisible()) return;
    const delay = Math.min(options.maxDelayMs, options.baseDelayMs * (2 ** failures));
    timer = schedule(() => {
      timer = null;
      run();
    }, delay);
  };
  const run = () => {
    if (!active || !options.isVisible()) return;
    if (inFlight) {
      rerunRequested = true;
      return;
    }
    clearTimer();
    inFlight = true;
    controller = new AbortController();
    void options.load(controller.signal).then(
      () => { failures = 0; },
      () => { failures = Math.min(16, failures + 1); },
    ).finally(() => {
      inFlight = false;
      controller = null;
      if (rerunRequested && active && options.isVisible()) {
        rerunRequested = false;
        run();
      } else {
        arm();
      }
    });
  };
  return {
    start() {
      if (active) return;
      active = true;
      run();
    },
    refresh: run,
    focus: run,
    visibilityChanged() {
      if (options.isVisible()) run();
      else clearTimer();
    },
    stop() {
      active = false;
      rerunRequested = false;
      clearTimer();
      controller?.abort();
      controller = null;
    },
    isInFlight: () => inFlight,
  };
}

const unsafeDisplayName = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const libraryDisplayName = z.string().trim().min(1).max(80).refine(
  (value) => !unsafeDisplayName.test(value),
  "제어 문자는 사용할 수 없습니다",
);

export const workspaceFormSchema = z.object({ name: libraryDisplayName }).strict();
export const folderFormSchema = z.object({
  workspaceId: z.string().uuid(),
  parentFolderId: z.string().uuid().nullable(),
  name: libraryDisplayName,
  color: z.enum(["brown", "sand", "amber", "olive", "sage"]),
}).strict();

export function formatLocationBreadcrumb(
  library: PublicLibraryView,
  workspaceId: string,
  folderId: string | null,
): string[] {
  const workspace = library.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return [];
  const result = [workspace.name];
  if (folderId === null) return [...result, "미분류"];
  const byId = new Map(library.folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return [...result, ...names];
}
