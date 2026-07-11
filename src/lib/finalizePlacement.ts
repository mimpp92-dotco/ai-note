import type {
  ClassifiedMeetingRecord,
  LibraryDocument,
  LibraryPlacement,
  LibraryVersion,
} from "@/domain/library";
import type { FinalizeLocation, FinalizeReceipt } from "@/lib/finalizeRecord";
import { readResolvedLibraryState } from "@/lib/libraryService";
import { invalidateOrganizationPending } from "@/lib/organizationPending";
import { updateStatus } from "@/lib/status";

export type FinalizePlacementFallbackReason =
  | "folder_missing"
  | "workspace_missing"
  | "library_degraded"
  | null;

export interface FinalizePlacementResult {
  requested: FinalizeLocation | null;
  actual: FinalizeLocation | null;
  outcome: "saved" | "fallback" | "unavailable";
  fallbackReason: FinalizePlacementFallbackReason;
  version: LibraryVersion | null;
}

function sameLocation(
  left: FinalizeLocation | null,
  right: FinalizeLocation | null,
): boolean {
  return left?.workspaceId === right?.workspaceId && left?.folderId === right?.folderId;
}

function deferUnresolved(record: ClassifiedMeetingRecord): "materialize" | "defer" {
  const state = record.status?.placementResolution?.state;
  return state === "pending" || state === "unavailable" ? "defer" : "materialize";
}

function requestedTarget(
  document: LibraryDocument,
  requested: FinalizeLocation,
): { target: FinalizeLocation; fallbackReason: Exclude<FinalizePlacementFallbackReason, "library_degraded"> } {
  const workspaceExists = document.workspaces.some((workspace) => workspace.id === requested.workspaceId);
  if (!workspaceExists) {
    return {
      target: { workspaceId: document.defaultWorkspaceId, folderId: null },
      fallbackReason: "workspace_missing",
    };
  }
  if (requested.folderId === null) return { target: requested, fallbackReason: null };
  const folderExists = document.folders.some((folder) => (
    folder.id === requested.folderId && folder.workspaceId === requested.workspaceId
  ));
  if (folderExists) return { target: requested, fallbackReason: null };
  return {
    target: { workspaceId: requested.workspaceId, folderId: null },
    fallbackReason: "folder_missing",
  };
}

function placementLocation(placement: LibraryPlacement): FinalizeLocation {
  return { workspaceId: placement.workspaceId, folderId: placement.folderId };
}

async function markResolution(
  meetingId: string,
  receiptHash: string,
  state: "resolved" | "unavailable",
  ownerToken?: string,
): Promise<void> {
  await updateStatus(meetingId, ownerToken, (latest) => {
    if (latest.placementResolution?.receiptHash !== receiptHash) return latest;
    if (latest.placementResolution.state === state) return latest;
    return {
      ...latest,
      placementResolution: { state, receiptHash },
    };
  });
  invalidateOrganizationPending();
}

/**
 * Resolve the immutable finalize receipt against one latest canonical registry
 * transaction. A placement already present in that transaction always wins, so
 * recovery can never move a meeting back to an old requested destination.
 */
export async function ensureFinalizePlacement(input: {
  meetingId: string;
  receipt: FinalizeReceipt;
  receiptHash: string;
  ownerToken?: string;
}): Promise<FinalizePlacementResult> {
  const requested = input.receipt.requestedLocation;
  const state = await readResolvedLibraryState();
  if (state.mode !== "ready" || !state.document || !state.version) {
    await markResolution(input.meetingId, input.receiptHash, "unavailable", input.ownerToken);
    return {
      requested,
      actual: null,
      outcome: "unavailable",
      fallbackReason: "library_degraded",
      version: null,
    };
  }

  const existing = state.document.placements.find(
    (placement) => placement.meetingId === input.meetingId,
  );
  if (existing) {
    const actual = placementLocation(existing);
    await markResolution(input.meetingId, input.receiptHash, "resolved", input.ownerToken);
    return {
      requested,
      actual,
      outcome: requested === null || sameLocation(requested, actual) ? "saved" : "fallback",
      fallbackReason: null,
      version: state.version,
    };
  }

  if (requested === null) {
    await markResolution(input.meetingId, input.receiptHash, "unavailable", input.ownerToken);
    return {
      requested: null,
      actual: null,
      outcome: "unavailable",
      fallbackReason: null,
      version: state.version,
    };
  }

  const resolution = requestedTarget(state.document, requested);
  const transaction = await state.repository.transactLatest((document) => {
    if (document.placements.some((placement) => placement.meetingId === input.meetingId)) {
      return document;
    }
    return {
      ...document,
      placements: [
        ...document.placements,
        { meetingId: input.meetingId, ...resolution.target },
      ],
    };
  }, { placementPolicy: deferUnresolved });
  const canonical = transaction.document.placements.find(
    (placement) => placement.meetingId === input.meetingId,
  );
  if (!canonical) throw new Error("finalize_placement_not_committed");
  const actual = placementLocation(canonical);
  await markResolution(input.meetingId, input.receiptHash, "resolved", input.ownerToken);
  const requestedStillExists = transaction.document.workspaces.some(
    (workspace) => workspace.id === requested.workspaceId,
  );
  const requestedFolderStillExists = requested.folderId === null || transaction.document.folders.some(
    (folder) => folder.id === requested.folderId && folder.workspaceId === requested.workspaceId,
  );
  const fallbackReason = sameLocation(requested, actual)
    ? null
    : !requestedStillExists
      ? "workspace_missing" as const
      : !requestedFolderStillExists
        ? "folder_missing" as const
        : resolution.fallbackReason;
  return {
    requested,
    actual,
    outcome: sameLocation(requested, actual) ? "saved" : "fallback",
    fallbackReason,
    version: transaction.version,
  };
}

export interface MeetingLocationResult {
  mode: "ready" | "degraded_last_good" | "degraded_fallback";
  version: LibraryVersion | null;
  location: (FinalizeLocation & { breadcrumb: string[] }) | null;
}

function breadcrumb(document: LibraryDocument, folderId: string | null): string[] {
  if (folderId === null) return [];
  const folders = new Map(document.folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  const visited = new Set<string>();
  let current = folders.get(folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parentFolderId ? folders.get(current.parentFolderId) : undefined;
  }
  return names;
}

export async function readMeetingLocation(meetingId: string): Promise<MeetingLocationResult> {
  const state = await readResolvedLibraryState();
  const placement = state.placements.find((candidate) => candidate.meetingId === meetingId);
  return {
    mode: state.mode,
    version: state.version,
    location: placement && state.document
      ? {
          workspaceId: placement.workspaceId,
          folderId: placement.folderId,
          breadcrumb: breadcrumb(state.document, placement.folderId),
        }
      : null,
  };
}
