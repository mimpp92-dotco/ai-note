import type {
  LibraryDocument,
  LibraryPlacement,
} from "@/domain/library";
import type { LibraryMeetingScope } from "@/lib/libraryQuery";

export interface MeetingDetailSourceResult {
  source: Exclude<LibraryMeetingScope, { kind: "global" }>;
  backHref: string;
  canonicalDetailHref: string;
  sourceAccepted: boolean;
}

export interface PostMoveDetailSourceResult {
  source: Exclude<LibraryMeetingScope, { kind: "global" }>;
  backHref: string;
  detailHref: string;
  sourceChanged: boolean;
}

function hrefFor(scope: Exclude<LibraryMeetingScope, { kind: "global" }>): string {
  const query = new URLSearchParams({ workspace: scope.workspaceId });
  if (scope.kind === "unfiled") query.set("view", "unfiled");
  if (scope.kind === "folder") query.set("folder", scope.folderId);
  return `/?${query.toString()}`;
}

function fallbackScope(
  meetingId: string,
  document: LibraryDocument,
  placements: readonly LibraryPlacement[],
): Exclude<LibraryMeetingScope, { kind: "global" }> {
  const placement = placements.find((candidate) => candidate.meetingId === meetingId);
  if (placement && document.workspaces.some((workspace) => workspace.id === placement.workspaceId)) {
    // Workspace All always contains the current canonical placement and remains
    // valid if a folder is concurrently renamed or moved.
    return { kind: "workspace", workspaceId: placement.workspaceId };
  }
  return { kind: "workspace", workspaceId: document.defaultWorkspaceId };
}

export function resolveMeetingDetailSource(input: {
  meetingId: string;
  search: URLSearchParams;
  document: LibraryDocument;
  placements: readonly LibraryPlacement[];
}): MeetingDetailSourceResult {
  const workspaceId = input.search.get("sourceWorkspace");
  const view = input.search.get("sourceView");
  const folderId = input.search.get("sourceFolder");
  const sourceKeys = ["sourceWorkspace", "sourceView", "sourceFolder"];
  const noDuplicates = sourceKeys.every((key) => input.search.getAll(key).length <= 1);
  let source: MeetingDetailSourceResult["source"] | null = null;
  if (
    noDuplicates
    && workspaceId !== null
    && input.document.workspaces.some((workspace) => workspace.id === workspaceId)
  ) {
    if (view === "all" && folderId === null) {
      source = { kind: "workspace", workspaceId };
    } else if (view === "unfiled" && folderId === null) {
      source = { kind: "unfiled", workspaceId };
    } else if (view === "folder" && folderId !== null) {
      const folder = input.document.folders.find((candidate) => candidate.id === folderId);
      if (folder?.workspaceId === workspaceId) source = { kind: "folder", workspaceId, folderId };
    }
  }
  const resolved = source ?? fallbackScope(input.meetingId, input.document, input.placements);
  const attentionAfter = input.search.getAll("attentionAfter").length === 1
    ? input.search.get("attentionAfter")
    : null;
  return {
    source: resolved,
    backHref: hrefFor(resolved),
    canonicalDetailHref: detailHrefFor(input.meetingId, resolved, attentionAfter),
    sourceAccepted: source !== null,
  };
}

function sourceContainsLocation(
  source: Exclude<LibraryMeetingScope, { kind: "global" }>,
  actual: { workspaceId: string; folderId: string | null },
): boolean {
  if (source.workspaceId !== actual.workspaceId) return false;
  if (source.kind === "workspace") return true;
  if (source.kind === "unfiled") return actual.folderId === null;
  return source.folderId === actual.folderId;
}

function exactScopeForLocation(
  actual: { workspaceId: string; folderId: string | null },
): Exclude<LibraryMeetingScope, { kind: "global" }> {
  return actual.folderId === null
    ? { kind: "unfiled", workspaceId: actual.workspaceId }
    : { kind: "folder", workspaceId: actual.workspaceId, folderId: actual.folderId };
}

function detailHrefFor(
  meetingId: string,
  source: Exclude<LibraryMeetingScope, { kind: "global" }>,
  attentionAfter?: string | null,
): string {
  const query = new URLSearchParams({
    sourceWorkspace: source.workspaceId,
    sourceView: source.kind === "workspace" ? "all" : source.kind,
  });
  if (source.kind === "folder") query.set("sourceFolder", source.folderId);
  if (attentionAfter) query.set("attentionAfter", attentionAfter);
  return `/meetings/${meetingId}?${query.toString()}`;
}

export function resolvePostMoveDetailSource(input: {
  meetingId: string;
  source: Exclude<LibraryMeetingScope, { kind: "global" }>;
  actual: { workspaceId: string; folderId: string | null };
  attentionAfter?: string | null;
}): PostMoveDetailSourceResult {
  const sourceChanged = !sourceContainsLocation(input.source, input.actual);
  const source = sourceChanged ? exactScopeForLocation(input.actual) : input.source;
  return {
    source,
    backHref: hrefFor(source),
    detailHref: detailHrefFor(input.meetingId, source, input.attentionAfter),
    sourceChanged,
  };
}
