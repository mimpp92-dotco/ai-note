"use client";

import { useEffect, useMemo, useState } from "react";

import { LibraryDialogShell } from "@/components/LibraryPrimitives";
import { useLibrary } from "@/components/LibraryProvider";
import {
  buildFolderParentOptions,
  buildMeetingLocationOptions,
  filterLocationOptions,
  type LibraryLocationOption,
  type PickerLocation,
} from "@/lib/libraryLocationPicker";

type MeetingPickerProps = {
  kind: "meeting";
  meetingId: string;
  current: PickerLocation | null;
  trigger: HTMLElement | null;
  onClose: () => void;
  onMoved: (actual: PickerLocation) => void;
};

type FolderPickerProps = {
  kind: "folder";
  folderId: string;
  trigger: HTMLElement | null;
  onClose: () => void;
  onMoved: (parent: PickerLocation) => void;
};

export type LibraryLocationPickerProps = MeetingPickerProps | FolderPickerProps;

function isLocation(value: unknown): value is PickerLocation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.workspaceId === "string"
    && (candidate.folderId === null || typeof candidate.folderId === "string");
}

export function LibraryLocationPicker(props: LibraryLocationPickerProps) {
  const library = useLibrary();
  const document = library.library;
  const initialWorkspaceId = props.kind === "meeting"
    ? props.current?.workspaceId ?? document?.defaultWorkspaceId ?? ""
    : document?.folders.find((folder) => folder.id === props.folderId)?.workspaceId ?? "";
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWorkspaceId(initialWorkspaceId);
    setQuery("");
    setSelectedKey(null);
    setSaving(false);
    setError(null);
  }, [initialWorkspaceId, props.kind, props.kind === "meeting" ? props.meetingId : props.folderId]);

  const options = useMemo(() => {
    if (!document) return [];
    return props.kind === "meeting"
      ? buildMeetingLocationOptions(document, props.current)
      : buildFolderParentOptions(document, props.folderId);
  }, [document, props]);
  const visibleOptions = filterLocationOptions(
    options.filter((option) => option.workspaceId === workspaceId),
    query,
  );
  const selected = options.find((option) => option.key === selectedKey) ?? null;
  const currentLabel = props.kind === "meeting"
    ? options.find((option) => (
        option.workspaceId === props.current?.workspaceId
        && option.folderId === props.current?.folderId
      ))?.label ?? "위치 없음"
    : options.find((option) => option.disabledReason === "현재 위치")?.label ?? "현재 상위 위치";

  const submit = async () => {
    if (!selected || selected.disabledReason || !library.version || saving) return;
    setSaving(true);
    setError(null);
    const token = {
      expectedLibraryId: library.version.libraryId,
      expectedRevision: library.version.revision,
    };
    const url = props.kind === "meeting"
      ? `/api/meetings/${props.meetingId}/location`
      : `/api/folders/${props.folderId}/parent`;
    const body = props.kind === "meeting"
      ? { ...token, workspaceId: selected.workspaceId, folderId: selected.folderId }
      : { ...token, parentFolderId: selected.folderId };
    try {
      const result = await library.runLibraryMutation(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!result.response.ok) {
        if (result.response.status === 409) {
          setSelectedKey(null);
          setError("위치가 변경되었습니다. 최신 위치를 다시 선택해 주세요.");
        } else {
          setError("이동하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        }
        return;
      }
      if (!result.accepted) return;
      let responseBody: unknown = null;
      try {
        responseBody = await result.response.clone().json();
      } catch {
        // The selected IDs remain the safe fallback for a successful folder move.
      }
      const actual = props.kind === "meeting"
        && typeof responseBody === "object"
        && responseBody !== null
        && "location" in responseBody
        && isLocation((responseBody as { location?: unknown }).location)
        ? (responseBody as { location: PickerLocation }).location
        : { workspaceId: selected.workspaceId, folderId: selected.folderId };
      if (props.kind === "meeting") library.applyMeetingMove?.(props.meetingId, actual);
      props.onMoved(actual);
      props.onClose();
    } catch {
      setError("이동하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  };

  if (!document || !library.version) return null;
  const fixedWorkspace = document.workspaces.find((workspace) => workspace.id === workspaceId);
  return (
    <LibraryDialogShell
      open
      title={props.kind === "meeting" ? "회의 이동" : "폴더 이동"}
      onClose={props.onClose}
      trigger={props.trigger}
    >
      {props.kind === "meeting" ? (
        <label className="block text-[13px] font-medium text-ink">
          이동할 워크스페이스
          <select
            aria-label="이동할 워크스페이스"
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.currentTarget.value);
              setSelectedKey(null);
              setQuery("");
              setError(null);
            }}
            className="mt-1 min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-[14px] text-ink"
          >
            {[...document.workspaces]
              .sort((left, right) => left.order - right.order)
              .map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </label>
      ) : (
        <div className="rounded-[12px] border border-line bg-soft px-4 py-3 text-[13px] text-ink">
          <p className="font-semibold">{fixedWorkspace?.name ?? "워크스페이스"} 안에서 이동</p>
          <p className="mt-1 text-inkSoft">다른 워크스페이스로 폴더 이동은 지원하지 않습니다.</p>
        </div>
      )}

      <label className="mt-4 block text-[13px] font-medium text-ink">
        폴더 검색
        <input
          type="search"
          aria-label="폴더 검색"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          className="mt-1 min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-[14px] text-ink"
          placeholder="워크스페이스 또는 상위 폴더 이름"
        />
      </label>

      <fieldset className="mt-3">
        <legend className="sr-only">이동할 위치</legend>
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-[12px] border border-line p-2">
          {visibleOptions.length === 0 ? (
            <p className="px-2 py-3 text-[13px] text-inkSoft">검색 결과가 없습니다.</p>
          ) : visibleOptions.map((option: LibraryLocationOption) => (
            <label
              key={option.key}
              className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-[13px] ${
                option.disabledReason ? "cursor-not-allowed text-inkSoft opacity-60" : "cursor-pointer text-ink hover:bg-soft"
              }`}
            >
              <input
                type="radio"
                name="library-location"
                aria-label={`${option.label}${option.disabledReason ? ` — ${option.disabledReason}` : ""}`}
                checked={selectedKey === option.key}
                disabled={option.disabledReason !== null}
                onChange={() => { setSelectedKey(option.key); setError(null); }}
              />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.disabledReason && <span className="text-[11px]">{option.disabledReason}</span>}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 rounded-[12px] border border-line bg-bg px-4 py-3 text-[13px] text-ink">
        <span className="text-inkSoft">이동 확인: </span>
        {selected ? `${currentLabel} → ${selected.label}` : "새 위치를 선택하세요."}
      </div>
      {error && <p role="status" aria-live="polite" className="mt-3 text-[13px] text-error">{error}</p>}
      <button
        type="button"
        disabled={!selected || selected.disabledReason !== null || saving}
        onClick={() => void submit()}
        className="mt-4 min-h-11 rounded-full bg-ink px-5 text-[13px] font-semibold text-bg disabled:opacity-50"
      >
        {saving ? "이동 중…" : "이 위치로 이동"}
      </button>
    </LibraryDialogShell>
  );
}
