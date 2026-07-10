import {
  compareLibraryOrder,
  libraryNameKey,
  parseLibraryDocument,
  type LibraryColor,
  type LibraryDocument,
} from "@/domain/library";

export class LibraryMutationError extends Error {
  readonly code:
    | "workspace_not_found"
    | "folder_not_found"
    | "invalid_library_mutation"
    | "folder_move_noop"
    | "folder_move_self"
    | "folder_move_descendant"
    | "folder_move_cross_workspace"
    | "folder_move_depth"
    | "folder_name_conflict";

  constructor(code: LibraryMutationError["code"]) {
    super(code);
    this.name = "LibraryMutationError";
    this.code = code;
  }
}

function nextOrder(items: readonly { order: number }[]): number {
  return items.length === 0 ? 0 : Math.max(...items.map((item) => item.order)) + 1;
}

function validateResult(candidate: unknown): LibraryDocument {
  try {
    return parseLibraryDocument(candidate);
  } catch {
    throw new LibraryMutationError("invalid_library_mutation");
  }
}

export function createWorkspace(
  document: LibraryDocument,
  input: { id: string; name: string; now: string },
): LibraryDocument {
  const current = parseLibraryDocument(document);
  return validateResult({
    ...current,
    workspaces: [
      ...current.workspaces,
      {
        id: input.id,
        name: input.name,
        order: nextOrder(current.workspaces),
        createdAt: input.now,
        updatedAt: input.now,
      },
    ],
  });
}

export function renameWorkspace(
  document: LibraryDocument,
  input: { workspaceId: string; name: string; now: string },
): LibraryDocument {
  const current = parseLibraryDocument(document);
  if (!current.workspaces.some((workspace) => workspace.id === input.workspaceId)) {
    throw new LibraryMutationError("workspace_not_found");
  }
  return validateResult({
    ...current,
    workspaces: current.workspaces.map((workspace) =>
      workspace.id === input.workspaceId
        ? { ...workspace, name: input.name, updatedAt: input.now }
        : workspace),
  });
}

export function createFolder(
  document: LibraryDocument,
  input: {
    id: string;
    workspaceId: string;
    parentFolderId: string | null;
    name: string;
    color?: LibraryColor;
    now: string;
  },
): LibraryDocument {
  const current = parseLibraryDocument(document);
  if (!current.workspaces.some((workspace) => workspace.id === input.workspaceId)) {
    throw new LibraryMutationError("workspace_not_found");
  }
  if (
    input.parentFolderId !== null
    && !current.folders.some((folder) => folder.id === input.parentFolderId)
  ) {
    throw new LibraryMutationError("folder_not_found");
  }
  const siblings = current.folders.filter((folder) =>
    folder.workspaceId === input.workspaceId
    && folder.parentFolderId === input.parentFolderId);
  return validateResult({
    ...current,
    folders: [
      ...current.folders,
      {
        id: input.id,
        workspaceId: input.workspaceId,
        parentFolderId: input.parentFolderId,
        name: input.name,
        color: input.color ?? "brown",
        order: nextOrder(siblings),
        createdAt: input.now,
        updatedAt: input.now,
      },
    ],
  });
}

export function editFolder(
  document: LibraryDocument,
  input: {
    folderId: string;
    name?: string;
    color?: LibraryColor;
    now: string;
  },
): LibraryDocument {
  const current = parseLibraryDocument(document);
  if (!current.folders.some((folder) => folder.id === input.folderId)) {
    throw new LibraryMutationError("folder_not_found");
  }
  if (input.name === undefined && input.color === undefined) {
    throw new LibraryMutationError("invalid_library_mutation");
  }
  return validateResult({
    ...current,
    folders: current.folders.map((folder) =>
      folder.id === input.folderId
        ? {
            ...folder,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.color !== undefined ? { color: input.color } : {}),
            updatedAt: input.now,
          }
        : folder),
  });
}

export function moveMeetingPlacement(
  document: LibraryDocument,
  input: { meetingId: string; workspaceId: string; folderId: string | null },
): LibraryDocument {
  const current = parseLibraryDocument(document);
  if (!current.workspaces.some((workspace) => workspace.id === input.workspaceId)) {
    throw new LibraryMutationError("workspace_not_found");
  }
  if (input.folderId !== null && !current.folders.some((folder) => (
    folder.id === input.folderId && folder.workspaceId === input.workspaceId
  ))) {
    throw new LibraryMutationError("folder_not_found");
  }
  const existing = current.placements.find((placement) => placement.meetingId === input.meetingId);
  if (
    existing
    && existing.workspaceId === input.workspaceId
    && existing.folderId === input.folderId
  ) return current;
  const placement = {
    meetingId: input.meetingId,
    workspaceId: input.workspaceId,
    folderId: input.folderId,
  };
  return validateResult({
    ...current,
    placements: existing
      ? current.placements.map((candidate) => candidate.meetingId === input.meetingId
        ? placement
        : candidate)
      : [...current.placements, placement],
  });
}

function folderDepth(document: LibraryDocument, folderId: string): number {
  const byId = new Map(document.folders.map((folder) => [folder.id, folder]));
  let depth = 0;
  let current = byId.get(folderId);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) throw new LibraryMutationError("invalid_library_mutation");
    visited.add(current.id);
    depth += 1;
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return depth;
}

function subtreeHeight(document: LibraryDocument, folderId: string): number {
  const children = new Map<string, string[]>();
  for (const folder of document.folders) {
    if (!folder.parentFolderId) continue;
    const list = children.get(folder.parentFolderId) ?? [];
    list.push(folder.id);
    children.set(folder.parentFolderId, list);
  }
  const visit = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) throw new LibraryMutationError("invalid_library_mutation");
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const nested = children.get(id) ?? [];
    return 1 + Math.max(0, ...nested.map((child) => visit(child, nextSeen)));
  };
  return visit(folderId, new Set());
}

function isDescendant(
  document: LibraryDocument,
  ancestorId: string,
  candidateId: string,
): boolean {
  const byId = new Map(document.folders.map((folder) => [folder.id, folder]));
  let current = byId.get(candidateId);
  const visited = new Set<string>();
  while (current) {
    if (current.id === ancestorId) return true;
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return false;
}

export function reparentFolder(
  document: LibraryDocument,
  input: { folderId: string; parentFolderId: string | null; now: string },
): LibraryDocument {
  const current = parseLibraryDocument(document);
  const moving = current.folders.find((folder) => folder.id === input.folderId);
  if (!moving) throw new LibraryMutationError("folder_not_found");
  if (input.parentFolderId === input.folderId) {
    throw new LibraryMutationError("folder_move_self");
  }
  if (moving.parentFolderId === input.parentFolderId) {
    throw new LibraryMutationError("folder_move_noop");
  }
  const targetParent = input.parentFolderId === null
    ? null
    : current.folders.find((folder) => folder.id === input.parentFolderId);
  if (input.parentFolderId !== null && !targetParent) {
    throw new LibraryMutationError("folder_not_found");
  }
  if (targetParent && targetParent.workspaceId !== moving.workspaceId) {
    throw new LibraryMutationError("folder_move_cross_workspace");
  }
  if (targetParent && isDescendant(current, moving.id, targetParent.id)) {
    throw new LibraryMutationError("folder_move_descendant");
  }
  const targetDepth = targetParent ? folderDepth(current, targetParent.id) : 0;
  if (targetDepth + subtreeHeight(current, moving.id) > 3) {
    throw new LibraryMutationError("folder_move_depth");
  }
  if (current.folders.some((folder) => (
    folder.id !== moving.id
    && folder.workspaceId === moving.workspaceId
    && folder.parentFolderId === input.parentFolderId
    && libraryNameKey(folder.name) === libraryNameKey(moving.name)
  ))) {
    throw new LibraryMutationError("folder_name_conflict");
  }

  const sourceSiblings = current.folders
    .filter((folder) => folder.id !== moving.id
      && folder.workspaceId === moving.workspaceId
      && folder.parentFolderId === moving.parentFolderId)
    .sort(compareLibraryOrder);
  const targetSiblings = current.folders
    .filter((folder) => folder.id !== moving.id
      && folder.workspaceId === moving.workspaceId
      && folder.parentFolderId === input.parentFolderId)
    .sort(compareLibraryOrder);
  const sourceOrder = new Map(sourceSiblings.map((folder, index) => [folder.id, index]));
  const targetOrder = new Map(targetSiblings.map((folder, index) => [folder.id, index]));

  return validateResult({
    ...current,
    folders: current.folders.map((folder) => {
      if (folder.id === moving.id) {
        return {
          ...folder,
          parentFolderId: input.parentFolderId,
          order: targetSiblings.length,
          updatedAt: input.now,
        };
      }
      const nextSourceOrder = sourceOrder.get(folder.id);
      if (nextSourceOrder !== undefined) return { ...folder, order: nextSourceOrder };
      const nextTargetOrder = targetOrder.get(folder.id);
      if (nextTargetOrder !== undefined) return { ...folder, order: nextTargetOrder };
      return folder;
    }),
  });
}
