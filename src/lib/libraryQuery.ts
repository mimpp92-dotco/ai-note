import {
  compareLibraryOrder,
  countMeetingRecords,
  type ClassifiedMeetingRecord,
  type LibraryDocument,
  type LibraryFolder,
  type LibraryPlacement,
  type LibraryVersion,
  type LibraryWorkspace,
} from "@/domain/library";
import {
  toPublicMeetingListItem,
  type PublicMeetingListItem,
} from "@/lib/publicApi";

export interface PublicLibraryCounts {
  visibleMeetingCount: number;
  hiddenInvalidStatusCount: number;
  organizationPendingCount: number;
  workspaces: Array<{ workspaceId: string; total: number; unfiled: number }>;
  folders: Array<{ folderId: string; direct: number }>;
}

export interface PublicLibraryView {
  defaultWorkspaceId: string;
  workspaces: LibraryWorkspace[];
  folders: LibraryFolder[];
  counts: PublicLibraryCounts;
}

export type LibraryMeetingScope =
  | { kind: "global" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "unfiled"; workspaceId: string }
  | { kind: "folder"; workspaceId: string; folderId: string };

export interface PublicMeetingLocation {
  workspaceId: string;
  folderId: string | null;
  breadcrumb: string[];
}

export interface ScopedMeetingRow extends PublicMeetingListItem {
  location?: PublicMeetingLocation;
}

export interface ScopedMeetingPage {
  version: LibraryVersion;
  meetings: ScopedMeetingRow[];
  nextCursor: string | null;
}

interface GlobalFallbackCursor {
  startedAt: string;
  id: string;
}

function encodeGlobalFallbackCursor(payload: GlobalFallbackCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeGlobalFallbackCursor(cursor: string): GlobalFallbackCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "id,startedAt"
    ) throw new Error("shape");
    const value = parsed as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.startedAt !== "string") throw new Error("fields");
    return value as unknown as GlobalFallbackCursor;
  } catch {
    throw new LibraryQueryError("invalid_meeting_cursor");
  }
}

export function paginateGlobalFallbackMeetings(input: {
  records: readonly ClassifiedMeetingRecord[];
  cursor?: string | null;
  limit?: number;
}): Omit<ScopedMeetingPage, "version"> {
  const cursor = input.cursor ? decodeGlobalFallbackCursor(input.cursor) : null;
  const rows = [...visibleRecordMap(input.records).values()]
    .flatMap((record) => record.status ? [toPublicMeetingListItem(record.status)] : [])
    .sort((left, right) => (
      right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id, "en")
    ));
  const remaining = cursor ? rows.filter((row) => afterCursor(row, cursor)) : rows;
  const requestedLimit = input.limit ?? 50;
  const limit = Math.min(100, Math.max(1, Number.isSafeInteger(requestedLimit) ? requestedLimit : 50));
  const meetings = remaining.slice(0, limit);
  const last = meetings.at(-1);
  return {
    meetings,
    nextCursor: remaining.length > meetings.length && last
      ? encodeGlobalFallbackCursor({ startedAt: last.startedAt, id: last.id })
      : null,
  };
}

export class LibraryQueryError extends Error {
  readonly code: "invalid_scope" | "invalid_meeting_cursor" | "stale_meeting_cursor";

  constructor(code: LibraryQueryError["code"]) {
    super(code);
    this.name = "LibraryQueryError";
    this.code = code;
  }
}

function visibleRecordMap(records: readonly ClassifiedMeetingRecord[]) {
  return new Map(records
    .filter((record) => record.kind === "live" && record.meetingId !== null && record.status !== null)
    .map((record) => [record.meetingId as string, record]));
}

export function buildLibraryPublicView(
  document: LibraryDocument,
  records: readonly ClassifiedMeetingRecord[],
  placements: readonly LibraryPlacement[],
): PublicLibraryView {
  const visible = visibleRecordMap(records);
  const workspaceCounts = new Map(document.workspaces.map((workspace) => [
    workspace.id,
    { workspaceId: workspace.id, total: 0, unfiled: 0 },
  ]));
  const folderCounts = new Map(document.folders.map((folder) => [
    folder.id,
    { folderId: folder.id, direct: 0 },
  ]));
  for (const placement of placements) {
    if (!visible.has(placement.meetingId)) continue;
    const workspace = workspaceCounts.get(placement.workspaceId);
    if (!workspace) continue;
    workspace.total += 1;
    if (placement.folderId === null) workspace.unfiled += 1;
    else {
      const folder = folderCounts.get(placement.folderId);
      if (folder) folder.direct += 1;
    }
  }
  const rawCounts = countMeetingRecords(records);
  const canonicalMeetingIds = new Set(placements.map((placement) => placement.meetingId));
  const organizationPendingCount = [...visible.values()].filter((record) => (
    record.meetingId !== null
    && !canonicalMeetingIds.has(record.meetingId)
    && (record.status?.placementResolution?.state === "pending"
      || record.status?.placementResolution?.state === "unavailable")
  )).length;
  return {
    defaultWorkspaceId: document.defaultWorkspaceId,
    workspaces: [...document.workspaces].sort(compareLibraryOrder).map((workspace) => ({ ...workspace })),
    folders: [...document.folders].sort(compareLibraryOrder).map((folder) => ({ ...folder })),
    counts: {
      visibleMeetingCount: visible.size,
      hiddenInvalidStatusCount: rawCounts.hiddenInvalidStatusCount,
      organizationPendingCount,
      workspaces: [...workspaceCounts.values()],
      folders: [...folderCounts.values()],
    },
  };
}

function scopeKey(scope: LibraryMeetingScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "folder") return `folder:${scope.workspaceId}:${scope.folderId}`;
  return `${scope.kind}:${scope.workspaceId}`;
}

interface MeetingCursorPayload {
  libraryId: string;
  revision: number;
  scope: string;
  startedAt: string;
  id: string;
}

function encodeCursor(payload: MeetingCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): MeetingCursorPayload {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "id,libraryId,revision,scope,startedAt"
    ) throw new Error("shape");
    const payload = value as Record<string, unknown>;
    if (
      typeof payload.libraryId !== "string"
      || typeof payload.revision !== "number"
      || !Number.isSafeInteger(payload.revision)
      || typeof payload.scope !== "string"
      || typeof payload.startedAt !== "string"
      || typeof payload.id !== "string"
    ) throw new Error("fields");
    return payload as unknown as MeetingCursorPayload;
  } catch {
    throw new LibraryQueryError("invalid_meeting_cursor");
  }
}

function validateScope(document: LibraryDocument, scope: LibraryMeetingScope): void {
  if (scope.kind === "global") return;
  if (!document.workspaces.some((workspace) => workspace.id === scope.workspaceId)) {
    throw new LibraryQueryError("invalid_scope");
  }
  if (scope.kind === "folder") {
    const folder = document.folders.find((candidate) => candidate.id === scope.folderId);
    if (!folder || folder.workspaceId !== scope.workspaceId) {
      throw new LibraryQueryError("invalid_scope");
    }
  }
}

function breadcrumbFor(document: LibraryDocument, folderId: string | null): string[] {
  if (folderId === null) return [];
  const byId = new Map(document.folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  let current = byId.get(folderId);
  while (current) {
    names.unshift(current.name);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return names;
}

function afterCursor(
  item: { startedAt: string; id: string },
  cursor: { startedAt: string; id: string },
): boolean {
  return item.startedAt < cursor.startedAt
    || (item.startedAt === cursor.startedAt && item.id > cursor.id);
}

export function paginateLibraryMeetings(input: {
  document: LibraryDocument;
  records: readonly ClassifiedMeetingRecord[];
  placements: readonly LibraryPlacement[];
  scope: LibraryMeetingScope;
  cursor?: string | null;
  limit?: number;
}): ScopedMeetingPage {
  validateScope(input.document, input.scope);
  const key = scopeKey(input.scope);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor && (
    cursor.libraryId !== input.document.libraryId
    || cursor.revision !== input.document.revision
    || cursor.scope !== key
  )) {
    throw new LibraryQueryError("stale_meeting_cursor");
  }

  const recordById = visibleRecordMap(input.records);
  const placementByMeeting = new Map(input.placements.map((placement) => [placement.meetingId, placement]));
  const rows: ScopedMeetingRow[] = [];
  for (const [meetingId, record] of recordById) {
    const placement = placementByMeeting.get(meetingId);
    if (input.scope.kind !== "global" && !placement) continue;
    if (input.scope.kind === "workspace" && placement?.workspaceId !== input.scope.workspaceId) continue;
    if (input.scope.kind === "unfiled" && !(
      placement?.workspaceId === input.scope.workspaceId && placement.folderId === null
    )) continue;
    if (input.scope.kind === "folder" && !(
      placement?.workspaceId === input.scope.workspaceId && placement.folderId === input.scope.folderId
    )) continue;
    const status = record.status;
    if (!status) continue;
    rows.push({
      ...toPublicMeetingListItem(status),
      ...(placement
        ? {
            location: {
              workspaceId: placement.workspaceId,
              folderId: placement.folderId,
              breadcrumb: breadcrumbFor(input.document, placement.folderId),
            },
          }
        : {}),
    });
  }
  rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id, "en"));
  const remaining = cursor ? rows.filter((row) => afterCursor(row, cursor)) : rows;
  const requestedLimit = input.limit ?? 50;
  const limit = Math.min(100, Math.max(1, Number.isSafeInteger(requestedLimit) ? requestedLimit : 50));
  const meetings = remaining.slice(0, limit);
  const hasMore = remaining.length > meetings.length;
  const last = meetings.at(-1);
  return {
    version: { libraryId: input.document.libraryId, revision: input.document.revision },
    meetings,
    nextCursor: hasMore && last
      ? encodeCursor({
          libraryId: input.document.libraryId,
          revision: input.document.revision,
          scope: key,
          startedAt: last.startedAt,
          id: last.id,
        })
      : null,
  };
}
