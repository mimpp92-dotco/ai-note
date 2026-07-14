"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { GuardedLink, useGuardedRouter } from "@/components/RecorderNavigation";
import { AppDrawer } from "@/components/AppDialog";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  KebabVerticalIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
} from "@/components/InlineIcons";
import { SearchOverlay } from "@/components/SearchOverlay";
import {
  ContainerDeleteDialog,
  type ContainerDeleteCommitResult,
} from "@/components/ContainerDeleteDialog";
import { LibraryDialogShell } from "@/components/LibraryPrimitives";
import { LibraryLocationPicker } from "@/components/LibraryLocationPicker";
import { useLibrary } from "@/components/LibraryProvider";
import {
  formatLlmStatus,
  formatWhisperStatus,
  type LlmHealthState,
  type WhisperHealthState,
} from "@/components/healthStatus";
import { useHealth } from "@/components/useHealth";
import type { LibraryColor, LibraryFolder, LibraryWorkspace } from "@/domain/library";
import { folderFormSchema, workspaceFormSchema } from "@/lib/libraryClient";

type Editor =
  | { kind: "workspace-create"; trigger: HTMLElement | null }
  | { kind: "workspace-edit"; workspace: LibraryWorkspace; trigger: HTMLElement | null }
  | { kind: "folder-create"; workspaceId: string; parent: LibraryFolder | null; trigger: HTMLElement | null }
  | { kind: "folder-edit"; folder: LibraryFolder; trigger: HTMLElement | null }
  | { kind: "folder-move"; folder: LibraryFolder; trigger: HTMLElement | null }
  | { kind: "folder-delete"; folder: LibraryFolder; trigger: HTMLElement | null }
  | { kind: "workspace-delete"; workspace: LibraryWorkspace; trigger: HTMLElement | null };

const COLORS: Array<{ value: LibraryColor; label: string; className: string }> = [
  { value: "brown", label: "브라운", className: "bg-[#8a6f5a]" },
  { value: "sand", label: "샌드", className: "bg-[#c5a97f]" },
  { value: "amber", label: "앰버", className: "bg-[#b4791f]" },
  { value: "olive", label: "올리브", className: "bg-[#7c7a43]" },
  { value: "sage", label: "세이지", className: "bg-[#718774]" },
];

export function LibraryNavigation() {
  const library = useLibrary();
  const router = useGuardedRouter();
  const { whisper, llm } = useHealth();
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [folderMoveMessage, setFolderMoveMessage] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTrigger, setSearchTrigger] = useState<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const generationEpochRef = useRef(library.generationEpoch);

  const detailPath = pathname.startsWith("/meetings/");
  const validatedDetailSource = (() => {
    if (!detailPath || !library.library) return null;
    const keys = ["sourceWorkspace", "sourceView", "sourceFolder"];
    if (keys.some((key) => search.getAll(key).length > 1)) return null;
    const workspaceId = search.get("sourceWorkspace");
    const view = search.get("sourceView");
    const folderId = search.get("sourceFolder");
    if (!workspaceId || !library.library.workspaces.some((item) => item.id === workspaceId)) {
      return null;
    }
    if ((view === "all" || view === "unfiled") && folderId === null) {
      return { workspaceId, folderId: null, view };
    }
    if (view !== "folder" || !folderId) return null;
    const folder = library.library.folders.find((item) => item.id === folderId);
    return folder?.workspaceId === workspaceId
      ? { workspaceId, folderId, view }
      : null;
  })();
  const currentWorkspaceId = detailPath
    ? validatedDetailSource?.workspaceId ?? library.library?.defaultWorkspaceId ?? null
    : (library.scope && library.scope.kind !== "global" ? library.scope.workspaceId : null)
      ?? library.library?.defaultWorkspaceId
      ?? null;
  const currentFolderId = detailPath
    ? validatedDetailSource?.folderId ?? null
    : library.scope?.kind === "folder" ? library.scope.folderId : null;
  const currentView = detailPath
    ? validatedDetailSource?.view ?? "all"
    : library.scope?.kind === "unfiled"
      ? "unfiled"
      : library.scope?.kind === "folder"
        ? "folder"
        : "all";
  const canMutate = library.mode === "ready" && library.version !== null;
  const navigationCommitted = () => {
    setDrawerOpen(false);
    window.sessionStorage.setItem("ai-note-focus-scope", "1");
  };
  const openSearch = (trigger: HTMLElement) => {
    setSearchTrigger(trigger);
    setSearchOpen(true);
  };
  const finishContainerDelete = (
    result: ContainerDeleteCommitResult,
    deleted: Editor,
  ) => {
    const destination = `/?workspace=${result.redirect.workspaceId}${
      result.redirect.folderId
        ? `&folder=${result.redirect.folderId}`
        : result.impact.kind === "folder"
          ? "&view=unfiled"
          : ""
    }`;
    let shouldNavigate = false;
    if (deleted.kind === "workspace-delete") {
      shouldNavigate = currentWorkspaceId === deleted.workspace.id;
    } else if (deleted.kind === "folder-delete") {
      shouldNavigate = currentFolderId === deleted.folder.id;
    }
    setFolderMoveMessage(
      result.impact.kind === "folder"
        ? `회의 ${result.impact.affectedPlacementCount}개를 보존하고 폴더를 삭제했습니다.`
        : `회의 ${result.impact.affectedPlacementCount}개를 보존하고 워크스페이스를 삭제했습니다.`,
    );
    setEditor(null);
    if (shouldNavigate) {
      window.sessionStorage.setItem("ai-note-focus-scope", "1");
      router.push(destination);
    } else {
      window.setTimeout(() => {
        if (deleted.trigger?.isConnected) deleted.trigger.focus();
        else document.querySelector<HTMLElement>("#main h1")?.focus();
      }, 0);
    }
  };

  useEffect(() => {
    if (generationEpochRef.current !== library.generationEpoch) {
      setDrawerOpen(false);
      setEditor(null);
      setFolderMoveMessage(null);
      setSearchOpen(false);
      window.sessionStorage.setItem("ai-note-focus-scope", "1");
      generationEpochRef.current = library.generationEpoch;
    }
  }, [library.generationEpoch]);

  useEffect(() => {
    if (!currentFolderId || !library.library) return;
    const byId = new Map(library.library.folders.map((folder) => [folder.id, folder]));
    const ancestors: string[] = [];
    let current = byId.get(currentFolderId);
    while (current?.parentFolderId) {
      ancestors.push(current.parentFolderId);
      current = byId.get(current.parentFolderId);
    }
    for (const id of ancestors) {
      if (!library.expandedFolderIds.has(id)) library.toggleFolder(id);
    }
  }, [currentFolderId, library]);

  const navigation = library.library ? (
    <NavigationContents
      library={library.library}
      currentWorkspaceId={currentWorkspaceId}
      currentFolderId={currentFolderId}
      currentView={currentView}
      pathname={pathname}
      canMutate={canMutate}
      whisper={whisper}
      llm={llm}
      expanded={library.expandedFolderIds}
      toggleFolder={library.toggleFolder}
      onEdit={setEditor}
      onNavigationCommitted={navigationCommitted}
      onOpenSearch={openSearch}
    />
  ) : (
    <FallbackNavigation
      pathname={pathname}
      whisper={whisper}
      llm={llm}
      onNavigationCommitted={navigationCommitted}
      onOpenSearch={openSearch}
    />
  );

  return (
    <nav
      aria-label="라이브러리"
      className="relative w-full shrink-0 border-b border-line bg-chrome lg:min-h-screen lg:w-[272px] lg:border-b-0 lg:border-r"
    >
      <div className="flex min-h-16 items-center justify-between gap-3 px-4 lg:hidden">
        <GuardedLink href="/" className="flex min-h-11 items-center text-[15px] font-bold text-ink">AI NOTE</GuardedLink>
        <button
          ref={menuButtonRef}
          type="button"
          aria-label="라이브러리 메뉴 열기"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-inkFaint bg-panel text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <MenuIcon />
        </button>
      </div>

      <div className="hidden h-screen flex-col lg:flex">{navigation}</div>

      {drawerOpen && (
        <AppDrawer
          open
          title="라이브러리 메뉴"
          initialFocusRef={drawerCloseRef}
          returnFocus={menuButtonRef}
          onDismiss={() => setDrawerOpen(false)}
          className="lg:hidden"
          panelClassName="flex w-[min(88vw,22rem)] flex-col border-r border-line bg-chrome shadow-xl"
        >
          {(dismiss) => (
            <>
              <div className="flex min-h-16 items-center justify-between border-b border-line px-4">
                <span className="text-[15px] font-bold text-ink">AI NOTE</span>
                <button
                  ref={drawerCloseRef}
                  type="button"
                  aria-label="라이브러리 메뉴 닫기"
                  onClick={() => dismiss("explicit_cancel")}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-inkFaint bg-panel text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <CloseIcon />
                </button>
              </div>
              {navigation}
            </>
          )}
        </AppDrawer>
      )}

      <LibraryEditorDialog
        editor={editor}
        onClose={() => setEditor(null)}
        onAction={setEditor}
        onCreateNavigation={() => setDrawerOpen(false)}
      />
      {editor?.kind === "folder-move" && (
        <LibraryLocationPicker
          kind="folder"
          folderId={editor.folder.id}
          trigger={editor.trigger}
          onClose={() => setEditor(null)}
          onMoved={() => {
            setFolderMoveMessage(`${editor.folder.name} 폴더를 이동했습니다.`);
            window.setTimeout(() => {
              if (editor.trigger?.isConnected) editor.trigger.focus();
              else document.querySelector<HTMLElement>("#main h1")?.focus();
            }, 0);
          }}
        />
      )}
      {editor?.kind === "folder-delete" && (
        <ContainerDeleteDialog
          kind="folder"
          container={{ id: editor.folder.id, name: editor.folder.name }}
          trigger={editor.trigger}
          onClose={() => setEditor(null)}
          onDeleted={(result) => finishContainerDelete(result, editor)}
        />
      )}
      {editor?.kind === "workspace-delete" && (
        <ContainerDeleteDialog
          kind="workspace"
          container={{ id: editor.workspace.id, name: editor.workspace.name }}
          trigger={editor.trigger}
          onClose={() => setEditor(null)}
          onDeleted={(result) => finishContainerDelete(result, editor)}
        />
      )}
      {folderMoveMessage && <span className="sr-only" role="status" aria-live="polite">{folderMoveMessage}</span>}
      <SearchOverlay
        open={searchOpen}
        onDismiss={() => setSearchOpen(false)}
        returnFocus={searchTrigger}
      />
    </nav>
  );
}

function NavigationContents({
  library,
  currentWorkspaceId,
  currentFolderId,
  currentView,
  pathname,
  canMutate,
  whisper,
  llm,
  expanded,
  toggleFolder,
  onEdit,
  onNavigationCommitted,
  onOpenSearch,
}: {
  library: NonNullable<LibraryProviderValueLike["library"]>;
  currentWorkspaceId: string | null;
  currentFolderId: string | null;
  currentView: string | null;
  pathname: string;
  canMutate: boolean;
  whisper: WhisperHealthState | null;
  llm: LlmHealthState | null;
  expanded: Set<string>;
  toggleFolder: (id: string) => void;
  onEdit: (editor: Editor) => void;
  onNavigationCommitted: () => void;
  onOpenSearch: (trigger: HTMLElement) => void;
}) {
  const router = useGuardedRouter();
  const workspace = library.workspaces.find((candidate) => candidate.id === currentWorkspaceId)
    ?? library.workspaces.find((candidate) => candidate.id === library.defaultWorkspaceId)
    ?? library.workspaces[0];
  const workspaceCount = library.counts.workspaces.find((item) => item.workspaceId === workspace.id);
  const folders = library.folders.filter((folder) => folder.workspaceId === workspace.id);
  return (
    <>
      <div className="space-y-3 border-b border-line px-4 py-5">
        <GuardedLink href={`/?workspace=${workspace.id}`} className="flex min-h-11 flex-col justify-center text-[15px] font-bold text-ink" onNavigationCommitted={onNavigationCommitted}>
          AI NOTE
          <span className="mt-0.5 block text-[12px] font-medium text-inkSoft">로컬 회의록</span>
        </GuardedLink>
        <label className="block">
          <span className="sr-only">워크스페이스 선택</span>
          <span className="relative block">
            <select
              aria-label="워크스페이스 선택"
              value={workspace.id}
              onChange={(event) => {
                router.push(`/?workspace=${event.currentTarget.value}`, event.currentTarget);
              }}
              className="min-h-11 w-full appearance-none truncate rounded-lg border border-inkFaint bg-panel pl-3 pr-12 text-[14px] font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {library.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <span className="pointer-events-none absolute right-4 top-1/2 flex -translate-y-1/2 text-inkSoft" aria-hidden="true">
              <ChevronDownIcon className="h-4 w-4" />
            </span>
          </span>
        </label>
        {canMutate && (
          <div className="flex gap-2">
            <button type="button" onClick={(event) => onEdit({ kind: "workspace-create", trigger: event.currentTarget })} className="min-h-11 flex-1 rounded-lg border border-line bg-panel px-2 text-[12px] font-semibold text-accent">
              새 워크스페이스
            </button>
            <button type="button" aria-label={`${workspace.name} 이름 수정`} onClick={(event) => onEdit({ kind: "workspace-edit", workspace, trigger: event.currentTarget })} className="min-h-11 rounded-lg border border-line bg-panel px-3 text-[12px] font-semibold text-accent">
              이름 수정
            </button>
          </div>
        )}
      </div>

      <div className="space-y-1 px-3 py-3">
        <SearchTrigger onOpenSearch={onOpenSearch} />
        <NavigationRow
          href={`/?workspace=${workspace.id}`}
          active={pathname === "/" && currentView === "all"}
          label="모든 회의"
          count={workspaceCount?.total ?? 0}
          onNavigationCommitted={onNavigationCommitted}
        />
        <NavigationRow
          href={`/?workspace=${workspace.id}&view=unfiled`}
          active={pathname === "/" && currentView === "unfiled"}
          label="미분류"
          count={workspaceCount?.unfiled ?? 0}
          onNavigationCommitted={onNavigationCommitted}
        />
      </div>

      <div className="min-h-0 flex-1 border-y border-line px-3 py-3">
        <div className="flex min-h-11 items-center justify-between px-2">
          <p className="text-[12px] font-semibold text-inkSoft">폴더</p>
          {canMutate && (
            <button type="button" aria-label="새 폴더" onClick={(event) => onEdit({ kind: "folder-create", workspaceId: workspace.id, parent: null, trigger: event.currentTarget })} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-accent hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <PlusIcon />
            </button>
          )}
        </div>
        <div className="max-h-[calc(100vh-28rem)] overflow-y-auto overscroll-contain">
          {folders.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-inkSoft">폴더가 없습니다.</p>
          ) : (
            <FolderList
              folders={folders}
              folderCounts={new Map(library.counts.folders.map((item) => [item.folderId, item.direct]))}
              parentId={null}
              depth={1}
              activeFolderId={currentFolderId}
              expanded={expanded}
              toggleFolder={toggleFolder}
              canMutate={canMutate}
              onEdit={onEdit}
              onNavigationCommitted={onNavigationCommitted}
            />
          )}
        </div>
      </div>

      <div className="space-y-1 px-3 py-3">
        {library.counts.organizationPendingCount > 0 && (
          <GuardedLink href={`/?workspace=${library.defaultWorkspaceId}#organization-pending`} onNavigationCommitted={onNavigationCommitted} className="flex min-h-11 items-center justify-between rounded-lg px-3 text-[13px] font-medium text-accent hover:bg-panel">
            <span>위치 저장 대기</span><span>{library.counts.organizationPendingCount}</span>
          </GuardedLink>
        )}
        <NavigationRow href="/glossary" active={pathname.startsWith("/glossary")} label="단어 관리" onNavigationCommitted={onNavigationCommitted} />
        <NavigationRow href="/settings" active={pathname.startsWith("/settings")} label="설정" onNavigationCommitted={onNavigationCommitted} />
      </div>
      <SystemRows whisper={whisper} llm={llm} />
    </>
  );
}

type LibraryProviderValueLike = ReturnType<typeof useLibrary>;

function FallbackNavigation({
  pathname,
  whisper,
  llm,
  onNavigationCommitted,
  onOpenSearch,
}: {
  pathname: string;
  whisper: WhisperHealthState | null;
  llm: LlmHealthState | null;
  onNavigationCommitted: () => void;
  onOpenSearch: (trigger: HTMLElement) => void;
}) {
  return (
    <div className="flex h-full flex-col p-3">
      <GuardedLink href="/" className="px-3 py-3 text-[15px] font-bold text-ink" onNavigationCommitted={onNavigationCommitted}>AI NOTE</GuardedLink>
      <SearchTrigger onOpenSearch={onOpenSearch} />
      <NavigationRow href="/" active={pathname === "/"} label="모든 회의" onNavigationCommitted={onNavigationCommitted} />
      <div className="mt-auto">
        <NavigationRow href="/glossary" active={pathname.startsWith("/glossary")} label="단어 관리" onNavigationCommitted={onNavigationCommitted} />
        <NavigationRow href="/settings" active={pathname.startsWith("/settings")} label="설정" onNavigationCommitted={onNavigationCommitted} />
        <SystemRows whisper={whisper} llm={llm} />
      </div>
    </div>
  );
}

function SearchTrigger({ onOpenSearch }: { onOpenSearch: (trigger: HTMLElement) => void }) {
  return (
    <button
      type="button"
      aria-label="회의 검색"
      onClick={(event) => onOpenSearch(event.currentTarget)}
      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-[14px] font-medium text-inkSoft hover:bg-panel hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <SearchIcon className="h-[18px] w-[18px] shrink-0" />
      <span>검색</span>
    </button>
  );
}

function NavigationRow({
  href,
  active,
  label,
  count,
  onNavigationCommitted,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
  onNavigationCommitted: () => void;
}) {
  return (
    <GuardedLink
      href={href}
      aria-current={active ? "page" : undefined}
      onNavigationCommitted={onNavigationCommitted}
      className={`flex min-h-11 items-center justify-between rounded-lg px-3 text-[14px] font-medium ${active ? "bg-soft font-semibold text-ink" : "text-inkSoft hover:bg-panel hover:text-ink"}`}
    >
      <span>{label}</span>{count !== undefined && <span className="text-[12px]">{count}</span>}
    </GuardedLink>
  );
}

function FolderList({
  folders,
  folderCounts,
  parentId,
  depth,
  activeFolderId,
  expanded,
  toggleFolder,
  canMutate,
  onEdit,
  onNavigationCommitted,
}: {
  folders: LibraryFolder[];
  folderCounts: Map<string, number>;
  parentId: string | null;
  depth: number;
  activeFolderId: string | null;
  expanded: Set<string>;
  toggleFolder: (id: string) => void;
  canMutate: boolean;
  onEdit: (editor: Editor) => void;
  onNavigationCommitted: () => void;
}) {
  const children = folders
    .filter((folder) => folder.parentFolderId === parentId)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id, "en"));
  if (children.length === 0) return null;
  return (
    <ul className={depth > 1 ? "ml-2 border-l border-line pl-1 sm:ml-3 sm:pl-1.5" : "space-y-1"}>
      {children.map((folder) => {
        const nested = folders.some((candidate) => candidate.parentFolderId === folder.id);
        const isExpanded = expanded.has(folder.id) || activeFolderId === folder.id;
        const count = folderCounts.get(folder.id) ?? 0;
        return (
          <li key={folder.id}>
            <div className="flex min-h-11 min-w-0 items-center gap-0.5">
              {nested ? (
                <button type="button" aria-label={`${folder.name} 하위 폴더 ${isExpanded ? "접기" : "펼치기"}`} aria-expanded={isExpanded} onClick={() => toggleFolder(folder.id)} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-inkSoft hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                </button>
              ) : <span className="inline-block w-11 shrink-0" />}
              <GuardedLink title={folder.name} href={`/?workspace=${folder.workspaceId}&folder=${folder.id}`} onNavigationCommitted={onNavigationCommitted} aria-current={activeFolderId === folder.id ? "page" : undefined} className={`flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-[13px] ${activeFolderId === folder.id ? "bg-soft font-semibold text-ink" : "text-inkSoft hover:bg-panel"}`}>
                <ColorDot color={folder.color} />
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                {count > 0 && <span className="shrink-0 text-[11px] tabular-nums">{count}</span>}
              </GuardedLink>
              {canMutate && (
                <button type="button" aria-label={`${folder.name} 폴더 편집`} onClick={(event) => onEdit({ kind: "folder-edit", folder, trigger: event.currentTarget })} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-inkSoft hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <KebabVerticalIcon />
                </button>
              )}
              {canMutate && depth < 3 && (
                <button type="button" aria-label={`${folder.name}에 새 하위 폴더`} onClick={(event) => onEdit({ kind: "folder-create", workspaceId: folder.workspaceId, parent: folder, trigger: event.currentTarget })} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-accent hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <PlusIcon />
                </button>
              )}
            </div>
            {depth === 3 && canMutate && (
              <p className="sr-only" id={`folder-depth-${folder.id}`}>폴더는 최대 3단계까지 만들 수 있습니다.</p>
            )}
            {nested && isExpanded && (
              <FolderList
                folders={folders}
                folderCounts={folderCounts}
                parentId={folder.id}
                depth={depth + 1}
                activeFolderId={activeFolderId}
                expanded={expanded}
                toggleFolder={toggleFolder}
                canMutate={canMutate}
                onEdit={onEdit}
                onNavigationCommitted={onNavigationCommitted}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ColorDot({ color }: { color: LibraryColor }) {
  const option = COLORS.find((candidate) => candidate.value === color) ?? COLORS[0];
  return <span title={option.label} aria-label={option.label} className={`h-2.5 w-2.5 shrink-0 rounded-full ${option.className}`} />;
}

function SystemRows({ whisper, llm }: { whisper: WhisperHealthState | null; llm: LlmHealthState | null }) {
  const whisperStatus = formatWhisperStatus(whisper);
  const llmStatus = formatLlmStatus(llm);
  return (
    <div className="border-t border-line p-3">
      <p className="px-2 text-[11px] font-semibold text-inkSoft">시스템</p>
      <SystemRow label="전사" status={whisperStatus} />
      <SystemRow label="요약" status={llmStatus} />
    </div>
  );
}

function SystemRow({ label, status }: { label: string; status: ReturnType<typeof formatWhisperStatus> }) {
  return (
    <div className="mt-1 flex min-h-11 items-center gap-2 rounded-md px-2" title={status.title} aria-live="polite">
      <span className="w-8 text-[11px] font-semibold text-inkSoft">{label}</span>
      <span className={`h-2 w-2 rounded-full ${status.dotClass}`} aria-hidden="true" />
      <span className="truncate text-[11px] font-medium text-inkSoft">{status.label}</span>
    </div>
  );
}

function LibraryEditorDialog({
  editor,
  onClose,
  onAction,
  onCreateNavigation,
}: {
  editor: Editor | null;
  onClose: () => void;
  onAction: (editor: Editor) => void;
  onCreateNavigation: () => void;
}) {
  const library = useLibrary();
  const router = useGuardedRouter();
  const [name, setName] = useState("");
  const [color, setColor] = useState<LibraryColor>("brown");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const composingRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editor) return;
    setName(editor.kind === "workspace-edit"
      ? editor.workspace.name
      : editor.kind === "folder-edit"
        ? editor.folder.name
        : "");
    setColor(editor.kind === "folder-edit" ? editor.folder.color : "brown");
    setError(null);
    setSaving(false);
  }, [editor]);

  if (
    !editor
    || editor.kind === "folder-move"
    || editor.kind === "folder-delete"
    || editor.kind === "workspace-delete"
    || !library.version
    || !library.library
  ) return null;
  const currentVersion = library.version;
  const currentLibrary = library.library;
  const workspace = editor.kind === "workspace-edit" ? true : editor.kind === "workspace-create";
  const title = editor.kind === "workspace-create"
    ? "새 워크스페이스"
    : editor.kind === "workspace-edit"
      ? "워크스페이스 이름 수정"
      : editor.kind === "folder-create"
        ? editor.parent ? `${editor.parent.name}에 폴더 만들기` : "새 폴더"
        : "폴더 편집";
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (composingRef.current || saving) return;
    const parsed = workspace
      ? workspaceFormSchema.safeParse({ name })
      : editor.kind === "folder-create"
        ? folderFormSchema.safeParse({
            workspaceId: editor.workspaceId,
            parentFolderId: editor.parent?.id ?? null,
            name,
            color,
          })
        : editor.kind === "folder-edit"
          ? folderFormSchema.safeParse({
              workspaceId: editor.folder.workspaceId,
              parentFolderId: editor.folder.parentFolderId,
              name,
              color,
            })
          : { success: false as const };
    if (!parsed.success) {
      setError("이름을 1~80자로 입력해 주세요.");
      window.setTimeout(() => nameInputRef.current?.focus(), 0);
      return;
    }
    setSaving(true);
    setError(null);
    const token = {
      expectedLibraryId: currentVersion.libraryId,
      expectedRevision: currentVersion.revision,
    };
    const beforeWorkspaces = new Set(currentLibrary.workspaces.map((item) => item.id));
    const beforeFolders = new Set(currentLibrary.folders.map((item) => item.id));
    let url: string;
    let method: "POST" | "PATCH";
    let body: Record<string, unknown>;
    if (editor.kind === "workspace-create") {
      url = "/api/workspaces";
      method = "POST";
      body = { ...token, name: name.trim() };
    } else if (editor.kind === "workspace-edit") {
      url = `/api/workspaces/${editor.workspace.id}`;
      method = "PATCH";
      body = { ...token, name: name.trim() };
    } else if (editor.kind === "folder-create") {
      url = "/api/folders";
      method = "POST";
      body = {
        ...token,
        workspaceId: editor.workspaceId,
        parentFolderId: editor.parent?.id ?? null,
        name: name.trim(),
        color,
      };
    } else {
      url = `/api/folders/${editor.folder.id}`;
      method = "PATCH";
      body = { ...token, name: name.trim(), color };
    }
    try {
      const result = await library.runLibraryMutation(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!result?.response?.ok) {
        setError(result?.response?.status === 409
          ? "다른 변경이 먼저 저장되었습니다. 최신 상태를 확인하고 다시 시도해 주세요."
          : "저장하지 못했습니다. 이름 중복과 입력값을 확인해 주세요.");
        window.setTimeout(() => nameInputRef.current?.focus(), 0);
        return;
      }
      if (!result.accepted) return;
      const next = result.payload?.library;
      let navigated = false;
      if (editor.kind === "workspace-create") {
        const created = next?.workspaces.find((item) => !beforeWorkspaces.has(item.id));
        if (created) {
          onCreateNavigation();
          window.sessionStorage.setItem("ai-note-focus-scope", "1");
          router.push(`/?workspace=${created.id}`);
          navigated = true;
        }
      } else if (editor.kind === "folder-create") {
        const created = next?.folders.find((item) => !beforeFolders.has(item.id));
        if (created) {
          onCreateNavigation();
          window.sessionStorage.setItem("ai-note-focus-scope", "1");
          router.push(`/?workspace=${created.workspaceId}&folder=${created.id}`);
          navigated = true;
        }
      }
      onClose();
      if (!navigated) {
        window.setTimeout(() => {
          if (editor.trigger?.isConnected) editor.trigger.focus();
          else document.querySelector<HTMLElement>("#main h1")?.focus();
        }, 0);
      }
    } catch {
      setError("저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      window.setTimeout(() => nameInputRef.current?.focus(), 0);
    } finally {
      setSaving(false);
    }
  };
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229 || composingRef.current) return;
    event.preventDefault();
    void submit();
  };
  return (
    <LibraryDialogShell
      open
      title={title}
      onClose={onClose}
      trigger={editor.trigger}
      initialFocusRef={nameInputRef}
      busy={saving}
    >
      <form onSubmit={(event) => void submit(event)}>
        <label className="block text-[13px] font-medium text-ink">
          {workspace ? "워크스페이스 이름" : "폴더 이름"}
          <input
            ref={nameInputRef}
            aria-label={workspace ? "워크스페이스 이름" : "폴더 이름"}
            value={name}
            onChange={(event) => { setName(event.currentTarget.value); setError(null); }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(event) => { composingRef.current = false; setName(event.currentTarget.value); }}
            onKeyDown={onInputKeyDown}
            className="mt-1 min-h-11 w-full rounded-lg border border-inkFaint bg-bg px-3 text-[14px] text-ink focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        {!workspace && (
          <fieldset className="mt-4">
            <legend className="text-[13px] font-medium text-ink">색상</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {COLORS.map((option) => (
                <label key={option.value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-[12px] ${color === option.value ? "border-accent bg-soft font-semibold" : "border-line"}`}>
                  <input type="radio" name="folder-color" value={option.value} checked={color === option.value} onChange={() => setColor(option.value)} className="sr-only" />
                  <span className={`h-3 w-3 rounded-full ${option.className}`} aria-hidden="true" />
                  {option.label}{color === option.value && <span className="sr-only"> 선택됨</span>}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {error && <p role="status" aria-live="polite" className="mt-3 text-[13px] text-error">{error}</p>}
        <button type="submit" disabled={saving || name.trim().length === 0} className="mt-5 min-h-11 rounded-full bg-ink px-5 text-[13px] font-semibold text-bg disabled:opacity-50">
          {saving ? "저장 중…" : editor.kind.endsWith("create") ? "만들기" : "저장"}
        </button>
        {editor.kind === "folder-edit" && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            <button
              type="button"
              disabled={saving}
              onClick={() => onAction({ kind: "folder-move", folder: editor.folder, trigger: editor.trigger })}
              className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent"
            >
              폴더 이동
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => onAction({ kind: "folder-delete", folder: editor.folder, trigger: editor.trigger })}
              className="min-h-11 rounded-full border border-warn/50 px-4 text-[13px] font-semibold text-accent"
            >
              폴더 삭제 후 보존
            </button>
          </div>
        )}
        {editor.kind === "workspace-edit" && (
          <div className="mt-4 border-t border-line pt-4">
            <button
              type="button"
              disabled={saving || currentLibrary.workspaces.length === 1}
              onClick={() => onAction({ kind: "workspace-delete", workspace: editor.workspace, trigger: editor.trigger })}
              className="min-h-11 rounded-full border border-warn/50 px-4 text-[13px] font-semibold text-accent disabled:opacity-40"
            >
              워크스페이스 삭제 후 보존
            </button>
            {currentLibrary.workspaces.length === 1 && (
              <p className="mt-2 text-[12px] text-inkSoft">마지막 워크스페이스는 삭제할 수 없습니다.</p>
            )}
          </div>
        )}
      </form>
    </LibraryDialogShell>
  );
}
