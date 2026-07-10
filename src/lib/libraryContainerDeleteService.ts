import type { ClassifiedMeetingRecord, LibraryVersion } from "@/domain/library";
import {
  calculateFolderDeleteImpact,
  calculateWorkspaceDeleteImpact,
  deleteFolderPreservingMeetings,
  deleteWorkspacePreservingMeetings,
  LibraryContainerDeleteError,
  type FolderDeleteImpact,
  type WorkspaceDeleteImpact,
} from "@/domain/libraryContainerDelete";
import { countPendingFinalizeLocationIntents } from "@/lib/containerDeletePreview";
import { LibraryRepositoryError } from "@/lib/library";
import {
  readResolvedLibraryState,
  toPublicLibraryResponse,
} from "@/lib/libraryService";
import { invalidateOrganizationPending } from "@/lib/organizationPending";
import {
  jsonNoStore,
  publicErrorPayload,
  publicErrorResponse,
} from "@/lib/publicApi";

function deferUnresolved(record: ClassifiedMeetingRecord): "materialize" | "defer" {
  const state = record.status?.placementResolution?.state;
  return state === "pending" || state === "unavailable" ? "defer" : "materialize";
}

async function unavailableResponse(): Promise<Response> {
  const state = await readResolvedLibraryState();
  return jsonNoStore({
    ...publicErrorPayload("internal_error"),
    ...toPublicLibraryResponse(state),
  }, 503);
}

async function authoritativeConflict(
  code: "library_revision_conflict" | "container_delete_conflict",
): Promise<Response> {
  const state = await readResolvedLibraryState();
  return jsonNoStore({ ...publicErrorPayload(code), ...toPublicLibraryResponse(state) }, 409);
}

export async function previewFolderContainerDelete(folderId: string): Promise<Response> {
  const state = await readResolvedLibraryState();
  if (state.mode !== "ready" || !state.document) return unavailableResponse();
  const folder = state.document.folders.find((candidate) => candidate.id === folderId);
  if (!folder) return publicErrorResponse("invalid_request", 404, { folderId });
  const pendingLocationIntentCount = await countPendingFinalizeLocationIntents(state.records, {
    kind: "folder",
    workspaceId: folder.workspaceId,
    folderId,
  });
  try {
    const impact = calculateFolderDeleteImpact(state.document, {
      folderId,
      records: state.records,
      pendingLocationIntentCount,
    });
    return jsonNoStore({ ...toPublicLibraryResponse(state), impact });
  } catch {
    return publicErrorResponse("invalid_request", 404, { folderId });
  }
}

export async function commitFolderContainerDelete(
  folderId: string,
  expected: LibraryVersion,
): Promise<Response> {
  const state = await readResolvedLibraryState();
  if (state.mode !== "ready") return unavailableResponse();
  let impact: FolderDeleteImpact | null = null;
  let records: readonly ClassifiedMeetingRecord[] = [];
  let pendingLocationIntentCount = 0;
  try {
    await state.repository.transact({
      expected,
      placementPolicy: deferUnresolved,
      validate: async (document, scan) => {
        const folder = document.folders.find((candidate) => candidate.id === folderId);
        if (!folder) throw new LibraryContainerDeleteError("folder_not_found");
        records = scan.records;
        pendingLocationIntentCount = await countPendingFinalizeLocationIntents(scan.records, {
          kind: "folder",
          workspaceId: folder.workspaceId,
          folderId,
        });
        impact = calculateFolderDeleteImpact(document, {
          folderId,
          records,
          pendingLocationIntentCount,
        });
        if (impact.promotionConflicts.length > 0) {
          throw new LibraryContainerDeleteError("folder_delete_conflict");
        }
      },
      reducer: (document) => deleteFolderPreservingMeetings(document, {
        folderId,
        records,
        pendingLocationIntentCount,
      }).document,
    });
  } catch (error) {
    if (error instanceof LibraryRepositoryError && error.code === "version_conflict") {
      return authoritativeConflict("library_revision_conflict");
    }
    if (error instanceof LibraryContainerDeleteError) {
      return authoritativeConflict("container_delete_conflict");
    }
    if (error instanceof LibraryRepositoryError && error.code === "durability_pending") {
      return publicErrorResponse("internal_error", 503);
    }
    return publicErrorResponse("invalid_request", 400);
  }
  const committedImpact = impact as FolderDeleteImpact | null;
  if (!committedImpact) return publicErrorResponse("internal_error", 500);
  invalidateOrganizationPending();
  const current = await readResolvedLibraryState();
  return jsonNoStore({
    ...toPublicLibraryResponse(current),
    impact: committedImpact,
    redirect: committedImpact.target,
  });
}

export async function previewWorkspaceContainerDelete(workspaceId: string): Promise<Response> {
  const state = await readResolvedLibraryState();
  if (state.mode !== "ready" || !state.document) return unavailableResponse();
  if (!state.document.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return publicErrorResponse("invalid_request", 404, { workspaceId });
  }
  const pendingLocationIntentCount = await countPendingFinalizeLocationIntents(state.records, {
    kind: "workspace",
    workspaceId,
  });
  try {
    const impact = calculateWorkspaceDeleteImpact(state.document, {
      workspaceId,
      records: state.records,
      pendingLocationIntentCount,
    });
    return jsonNoStore({ ...toPublicLibraryResponse(state), impact });
  } catch {
    return publicErrorResponse("invalid_request", 404, { workspaceId });
  }
}

export async function commitWorkspaceContainerDelete(
  workspaceId: string,
  destinationWorkspaceId: string,
  expected: LibraryVersion,
): Promise<Response> {
  const state = await readResolvedLibraryState();
  if (state.mode !== "ready") return unavailableResponse();
  let impact: WorkspaceDeleteImpact | null = null;
  let records: readonly ClassifiedMeetingRecord[] = [];
  let pendingLocationIntentCount = 0;
  try {
    await state.repository.transact({
      expected,
      placementPolicy: deferUnresolved,
      validate: async (document, scan) => {
        records = scan.records;
        pendingLocationIntentCount = await countPendingFinalizeLocationIntents(scan.records, {
          kind: "workspace",
          workspaceId,
        });
        impact = calculateWorkspaceDeleteImpact(document, {
          workspaceId,
          records,
          pendingLocationIntentCount,
        });
        if (
          impact.lastWorkspaceBlocked
          || destinationWorkspaceId === workspaceId
          || !impact.destinationCandidates.some((candidate) => candidate.id === destinationWorkspaceId)
        ) {
          throw new LibraryContainerDeleteError("workspace_delete_destination_invalid");
        }
      },
      reducer: (document) => deleteWorkspacePreservingMeetings(document, {
        workspaceId,
        destinationWorkspaceId,
        records,
        pendingLocationIntentCount,
      }).document,
    });
  } catch (error) {
    if (error instanceof LibraryRepositoryError && error.code === "version_conflict") {
      return authoritativeConflict("library_revision_conflict");
    }
    if (error instanceof LibraryContainerDeleteError) {
      return authoritativeConflict("container_delete_conflict");
    }
    if (error instanceof LibraryRepositoryError && error.code === "durability_pending") {
      return publicErrorResponse("internal_error", 503);
    }
    return publicErrorResponse("invalid_request", 400);
  }
  const committedImpact = impact as WorkspaceDeleteImpact | null;
  if (!committedImpact) return publicErrorResponse("internal_error", 500);
  invalidateOrganizationPending();
  const current = await readResolvedLibraryState();
  return jsonNoStore({
    ...toPublicLibraryResponse(current),
    impact: committedImpact,
    redirect: { workspaceId: destinationWorkspaceId, folderId: null },
  });
}
