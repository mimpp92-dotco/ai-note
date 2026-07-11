import {
  compareLibraryOrder,
  libraryNameKey,
  parseLibraryDocument,
  type ClassifiedMeetingRecord,
  type LibraryDocument,
} from "@/domain/library";

export class LibraryContainerDeleteError extends Error {
  readonly code:
    | "folder_not_found"
    | "folder_delete_conflict"
    | "workspace_not_found"
    | "last_workspace_delete"
    | "workspace_delete_destination_invalid";

  constructor(code: LibraryContainerDeleteError["code"]) {
    super(code);
    this.name = "LibraryContainerDeleteError";
    this.code = code;
  }
}

const hiddenInvalidKinds = new Set([
  "corrupt_status",
  "unreadable_status",
  "unsafe_record",
]);

function countPlacements(
  meetingIds: readonly string[],
  records: readonly ClassifiedMeetingRecord[],
): { visible: number; hiddenInvalid: number } {
  const recordsById = new Map(records
    .filter((record) => record.meetingId !== null)
    .map((record) => [record.meetingId as string, record]));
  let visible = 0;
  let hiddenInvalid = 0;
  for (const meetingId of meetingIds) {
    const record = recordsById.get(meetingId);
    if (record?.visible) visible += 1;
    else if (record && hiddenInvalidKinds.has(record.kind)) hiddenInvalid += 1;
  }
  return { visible, hiddenInvalid };
}

export interface FolderPromotionConflict {
  promotedFolderId: string;
  existingFolderId: string;
  targetParentFolderId: string | null;
}

export interface FolderDeleteImpact {
  kind: "folder";
  folderId: string;
  workspaceId: string;
  directVisibleMeetingCount: number;
  affectedPlacementCount: number;
  hiddenInvalidStatusPlacementCount: number;
  pendingLocationIntentCount: number;
  directChildFolderCount: number;
  target: { workspaceId: string; folderId: string | null };
  promotionConflicts: FolderPromotionConflict[];
  artifactPolicy: "meeting_artifacts_preserved";
}

export function calculateFolderDeleteImpact(
  document: LibraryDocument,
  input: {
    folderId: string;
    records: readonly ClassifiedMeetingRecord[];
    pendingLocationIntentCount: number;
  },
): FolderDeleteImpact {
  const current = parseLibraryDocument(document);
  const source = current.folders.find((folder) => folder.id === input.folderId);
  if (!source) throw new LibraryContainerDeleteError("folder_not_found");
  const directPlacements = current.placements.filter((placement) => placement.folderId === source.id);
  const counts = countPlacements(directPlacements.map((placement) => placement.meetingId), input.records);
  const children = current.folders
    .filter((folder) => folder.parentFolderId === source.id)
    .sort(compareLibraryOrder);
  const targetSiblings = current.folders.filter((folder) => (
    folder.id !== source.id
    && folder.workspaceId === source.workspaceId
    && folder.parentFolderId === source.parentFolderId
  ));
  const promotionConflicts: FolderPromotionConflict[] = [];
  for (const child of children) {
    const conflict = targetSiblings.find((sibling) => (
      libraryNameKey(sibling.name) === libraryNameKey(child.name)
    ));
    if (conflict) {
      promotionConflicts.push({
        promotedFolderId: child.id,
        existingFolderId: conflict.id,
        targetParentFolderId: source.parentFolderId,
      });
    }
  }
  return {
    kind: "folder",
    folderId: source.id,
    workspaceId: source.workspaceId,
    directVisibleMeetingCount: counts.visible,
    affectedPlacementCount: directPlacements.length,
    hiddenInvalidStatusPlacementCount: counts.hiddenInvalid,
    pendingLocationIntentCount: Math.max(0, input.pendingLocationIntentCount),
    directChildFolderCount: children.length,
    target: { workspaceId: source.workspaceId, folderId: source.parentFolderId },
    promotionConflicts,
    artifactPolicy: "meeting_artifacts_preserved",
  };
}

export function deleteFolderPreservingMeetings(
  document: LibraryDocument,
  input: {
    folderId: string;
    records: readonly ClassifiedMeetingRecord[];
    pendingLocationIntentCount: number;
  },
): { document: LibraryDocument; impact: FolderDeleteImpact } {
  const current = parseLibraryDocument(document);
  const impact = calculateFolderDeleteImpact(current, input);
  if (impact.promotionConflicts.length > 0) {
    throw new LibraryContainerDeleteError("folder_delete_conflict");
  }
  const source = current.folders.find((folder) => folder.id === input.folderId)!;
  const promoted = current.folders
    .filter((folder) => folder.parentFolderId === source.id)
    .sort(compareLibraryOrder);
  const targetWithSource = current.folders
    .filter((folder) => (
      folder.workspaceId === source.workspaceId
      && folder.parentFolderId === source.parentFolderId
    ))
    .sort(compareLibraryOrder);
  const sourceIndex = Math.max(0, targetWithSource.findIndex((folder) => folder.id === source.id));
  const targetWithoutSource = targetWithSource.filter((folder) => folder.id !== source.id);
  const orderedTarget = [
    ...targetWithoutSource.slice(0, sourceIndex),
    ...promoted,
    ...targetWithoutSource.slice(sourceIndex),
  ];
  const targetOrder = new Map(orderedTarget.map((folder, index) => [folder.id, index]));
  const next = parseLibraryDocument({
    ...current,
    folders: current.folders
      .filter((folder) => folder.id !== source.id)
      .map((folder) => {
        if (folder.parentFolderId === source.id) {
          return {
            ...folder,
            parentFolderId: source.parentFolderId,
            order: targetOrder.get(folder.id) ?? folder.order,
          };
        }
        const order = targetOrder.get(folder.id);
        return order === undefined ? folder : { ...folder, order };
      }),
    placements: current.placements.map((placement) => placement.folderId === source.id
      ? { ...placement, folderId: source.parentFolderId }
      : placement),
  });
  return { document: next, impact };
}

export interface WorkspaceDeleteImpact {
  kind: "workspace";
  workspaceId: string;
  visibleMeetingCount: number;
  affectedPlacementCount: number;
  hiddenInvalidStatusPlacementCount: number;
  folderCount: number;
  pendingLocationIntentCount: number;
  destinationCandidates: Array<{ id: string; name: string }>;
  lastWorkspaceBlocked: boolean;
  blockedReason: "last_workspace" | null;
  artifactPolicy: "meeting_artifacts_preserved";
}

export function calculateWorkspaceDeleteImpact(
  document: LibraryDocument,
  input: {
    workspaceId: string;
    records: readonly ClassifiedMeetingRecord[];
    pendingLocationIntentCount: number;
  },
): WorkspaceDeleteImpact {
  const current = parseLibraryDocument(document);
  if (!current.workspaces.some((workspace) => workspace.id === input.workspaceId)) {
    throw new LibraryContainerDeleteError("workspace_not_found");
  }
  const placements = current.placements.filter((placement) => placement.workspaceId === input.workspaceId);
  const counts = countPlacements(placements.map((placement) => placement.meetingId), input.records);
  const lastWorkspaceBlocked = current.workspaces.length === 1;
  return {
    kind: "workspace",
    workspaceId: input.workspaceId,
    visibleMeetingCount: counts.visible,
    affectedPlacementCount: placements.length,
    hiddenInvalidStatusPlacementCount: counts.hiddenInvalid,
    folderCount: current.folders.filter((folder) => folder.workspaceId === input.workspaceId).length,
    pendingLocationIntentCount: Math.max(0, input.pendingLocationIntentCount),
    destinationCandidates: current.workspaces
      .filter((workspace) => workspace.id !== input.workspaceId)
      .sort(compareLibraryOrder)
      .map((workspace) => ({ id: workspace.id, name: workspace.name })),
    lastWorkspaceBlocked,
    blockedReason: lastWorkspaceBlocked ? "last_workspace" : null,
    artifactPolicy: "meeting_artifacts_preserved",
  };
}

export function deleteWorkspacePreservingMeetings(
  document: LibraryDocument,
  input: {
    workspaceId: string;
    destinationWorkspaceId: string;
    records: readonly ClassifiedMeetingRecord[];
    pendingLocationIntentCount: number;
  },
): { document: LibraryDocument; impact: WorkspaceDeleteImpact } {
  const current = parseLibraryDocument(document);
  const impact = calculateWorkspaceDeleteImpact(current, input);
  if (impact.lastWorkspaceBlocked) {
    throw new LibraryContainerDeleteError("last_workspace_delete");
  }
  if (
    input.destinationWorkspaceId === input.workspaceId
    || !current.workspaces.some((workspace) => workspace.id === input.destinationWorkspaceId)
  ) {
    throw new LibraryContainerDeleteError("workspace_delete_destination_invalid");
  }
  const remainingWorkspaces = current.workspaces
    .filter((workspace) => workspace.id !== input.workspaceId)
    .sort(compareLibraryOrder)
    .map((workspace, order) => ({ ...workspace, order }));
  const next = parseLibraryDocument({
    ...current,
    defaultWorkspaceId: current.defaultWorkspaceId === input.workspaceId
      ? input.destinationWorkspaceId
      : current.defaultWorkspaceId,
    workspaces: remainingWorkspaces,
    folders: current.folders.filter((folder) => folder.workspaceId !== input.workspaceId),
    placements: current.placements.map((placement) => placement.workspaceId === input.workspaceId
      ? {
          ...placement,
          workspaceId: input.destinationWorkspaceId,
          folderId: null,
        }
      : placement),
  });
  return { document: next, impact };
}
