import { libraryNameKey, type LibraryFolder } from "@/domain/library";
import { formatLocationBreadcrumb } from "@/lib/libraryClient";
import type { PublicLibraryView } from "@/lib/libraryQuery";

export interface LibraryLocationOption {
  key: string;
  workspaceId: string;
  folderId: string | null;
  label: string;
  disabledReason: string | null;
}

export interface PickerLocation {
  workspaceId: string;
  folderId: string | null;
}

function keyOf(location: PickerLocation): string {
  return `${location.workspaceId}:${location.folderId ?? "unfiled"}`;
}

function labelFor(
  library: PublicLibraryView,
  workspaceId: string,
  folderId: string | null,
  rootLabel = "미분류",
): string {
  if (folderId === null) {
    const workspace = library.workspaces.find((candidate) => candidate.id === workspaceId);
    return `${workspace?.name ?? "워크스페이스"} / ${rootLabel}`;
  }
  return formatLocationBreadcrumb(library, workspaceId, folderId).join(" / ");
}

export function buildMeetingLocationOptions(
  library: PublicLibraryView,
  current: PickerLocation | null,
): LibraryLocationOption[] {
  const options: LibraryLocationOption[] = [];
  const workspaces = [...library.workspaces]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id, "en"));
  for (const workspace of workspaces) {
    const unfiled = { workspaceId: workspace.id, folderId: null };
    options.push({
      ...unfiled,
      key: keyOf(unfiled),
      label: labelFor(library, workspace.id, null),
      disabledReason: current && keyOf(current) === keyOf(unfiled) ? "현재 위치" : null,
    });
    const folders = library.folders
      .filter((folder) => folder.workspaceId === workspace.id)
      .map((folder) => ({
        folder,
        label: labelFor(library, workspace.id, folder.id),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, "ko"));
    for (const { folder, label } of folders) {
      const location = { workspaceId: workspace.id, folderId: folder.id };
      options.push({
        ...location,
        key: keyOf(location),
        label,
        disabledReason: current && keyOf(current) === keyOf(location) ? "현재 위치" : null,
      });
    }
  }
  return options;
}

function descendantsOf(folders: readonly LibraryFolder[], folderId: string): Set<string> {
  const result = new Set<string>();
  const visit = (parentId: string) => {
    for (const folder of folders) {
      if (folder.parentFolderId !== parentId || result.has(folder.id)) continue;
      result.add(folder.id);
      visit(folder.id);
    }
  };
  visit(folderId);
  return result;
}

function depthOf(folders: readonly LibraryFolder[], folderId: string): number {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let current = byId.get(folderId);
  let depth = 0;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    depth += 1;
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return depth;
}

function heightOf(folders: readonly LibraryFolder[], folderId: string): number {
  const visit = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 4;
    const next = new Set(seen);
    next.add(id);
    const children = folders.filter((folder) => folder.parentFolderId === id);
    return 1 + Math.max(0, ...children.map((folder) => visit(folder.id, next)));
  };
  return visit(folderId, new Set());
}

export function buildFolderParentOptions(
  library: PublicLibraryView,
  movingFolderId: string,
): LibraryLocationOption[] {
  const moving = library.folders.find((folder) => folder.id === movingFolderId);
  if (!moving) return [];
  const descendants = descendantsOf(library.folders, moving.id);
  const subtreeHeight = heightOf(library.folders, moving.id);
  const candidates: Array<LibraryFolder | null> = [
    null,
    ...library.folders.filter((folder) => (
      folder.workspaceId === moving.workspaceId
      && folder.id !== moving.id
      && !descendants.has(folder.id)
    )),
  ];
  return candidates
    .map((candidate): LibraryLocationOption => {
      const folderId = candidate?.id ?? null;
      let disabledReason: string | null = null;
      if (moving.parentFolderId === folderId) {
        disabledReason = "현재 위치";
      } else if ((candidate ? depthOf(library.folders, candidate.id) : 0) + subtreeHeight > 3) {
        disabledReason = "이동하면 최대 3단계를 넘습니다";
      } else if (library.folders.some((folder) => (
        folder.id !== moving.id
        && folder.workspaceId === moving.workspaceId
        && folder.parentFolderId === folderId
        && libraryNameKey(folder.name) === libraryNameKey(moving.name)
      ))) {
        disabledReason = "같은 이름의 폴더가 있습니다";
      }
      const location = { workspaceId: moving.workspaceId, folderId };
      return {
        ...location,
        key: keyOf(location),
        label: labelFor(library, moving.workspaceId, folderId, "최상위"),
        disabledReason,
      };
    })
    .sort((left, right) => {
      if (left.folderId === null) return -1;
      if (right.folderId === null) return 1;
      return left.label.localeCompare(right.label, "ko");
    });
}

export function filterLocationOptions(
  options: readonly LibraryLocationOption[],
  query: string,
): LibraryLocationOption[] {
  const normalized = libraryNameKey(query);
  if (!normalized) return [...options];
  return options.filter((option) => libraryNameKey(option.label).includes(normalized));
}
