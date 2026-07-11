"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { LibraryDialogShell } from "@/components/LibraryPrimitives";
import { useLibrary } from "@/components/LibraryProvider";
import type {
  FolderDeleteImpact,
  WorkspaceDeleteImpact,
} from "@/domain/libraryContainerDelete";
import { formatLocationBreadcrumb } from "@/lib/libraryClient";
import type { PublicLibraryView } from "@/lib/libraryQuery";

interface PreviewBase {
  version: { libraryId: string; revision: number };
  library: PublicLibraryView;
}

type DeletePreview = PreviewBase & {
  impact: FolderDeleteImpact | WorkspaceDeleteImpact;
};

export interface ContainerDeleteCommitResult extends DeletePreview {
  redirect: { workspaceId: string; folderId: string | null };
}

type ContainerDeleteDialogProps = {
  kind: "folder" | "workspace";
  container: { id: string; name: string };
  trigger: HTMLElement | null;
  onClose: () => void;
  onDeleted: (result: ContainerDeleteCommitResult) => void;
};

function isDeletePreview(value: unknown): value is DeletePreview {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.version === "object"
    && candidate.version !== null
    && typeof candidate.library === "object"
    && candidate.library !== null
    && typeof candidate.impact === "object"
    && candidate.impact !== null;
}

function isCommitResult(value: unknown): value is ContainerDeleteCommitResult {
  return isDeletePreview(value)
    && "redirect" in value
    && typeof (value as { redirect?: unknown }).redirect === "object"
    && (value as { redirect?: unknown }).redirect !== null;
}

export function ContainerDeleteDialog(props: ContainerDeleteDialogProps) {
  const library = useLibrary();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destinationWorkspaceId, setDestinationWorkspaceId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const composingRef = useRef(false);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/${props.kind === "folder" ? "folders" : "workspaces"}/${props.container.id}/delete-preview`,
        { cache: "no-store" },
      );
      const payload = await response.json() as unknown;
      if (!response.ok || !isDeletePreview(payload)) throw new Error("preview_failed");
      setPreview(payload);
      if (payload.impact.kind === "workspace") {
        setDestinationWorkspaceId(payload.impact.destinationCandidates[0]?.id ?? "");
      }
    } catch {
      setPreview(null);
      setError("삭제 영향을 확인하지 못했습니다. 최신 상태에서 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }, [props.container.id, props.kind]);

  useEffect(() => {
    setConfirmation("");
    setDestinationWorkspaceId("");
    void loadPreview();
  }, [loadPreview]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!preview || saving || composingRef.current) return;
    const impact = preview.impact;
    if (impact.kind === "folder" && impact.promotionConflicts.length > 0) return;
    if (impact.kind === "workspace" && (
      impact.lastWorkspaceBlocked
      || !destinationWorkspaceId
      || confirmation !== props.container.name
    )) return;
    setSaving(true);
    setError(null);
    const body = {
      expectedLibraryId: preview.version.libraryId,
      expectedRevision: preview.version.revision,
      ...(impact.kind === "workspace" ? { destinationWorkspaceId } : {}),
    };
    try {
      const result = await library.runLibraryMutation(
        `/api/${impact.kind === "folder" ? "folders" : "workspaces"}/${props.container.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!result.response.ok) {
        if (result.response.status === 409) {
          setError("미리보기 뒤 조직 정보가 바뀌었습니다. 최신 영향을 다시 확인해 주세요.");
          await loadPreview();
        } else {
          setError("컨테이너를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        }
        return;
      }
      if (!result.accepted) return;
      const payload = await result.response.clone().json() as unknown;
      if (!isCommitResult(payload)) {
        setError("삭제 결과를 확인하지 못했습니다. 라이브러리를 새로고침해 주세요.");
        return;
      }
      props.onDeleted(payload);
      props.onClose();
    } catch {
      setError("컨테이너를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  };

  const impact = preview?.impact ?? null;
  const folderTarget = preview && impact?.kind === "folder"
    ? formatLocationBreadcrumb(preview.library, impact.target.workspaceId, impact.target.folderId).join(" / ")
    : "";
  const workspaceBlocked = impact?.kind === "workspace" && impact.lastWorkspaceBlocked;
  const submitDisabled = loading
    || saving
    || !impact
    || (impact.kind === "folder" && impact.promotionConflicts.length > 0)
    || (impact.kind === "workspace" && (
      impact.lastWorkspaceBlocked
      || !destinationWorkspaceId
      || confirmation !== props.container.name
    ));

  const onConfirmationKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      event.key !== "Enter"
      || event.nativeEvent.isComposing
      || event.keyCode === 229
      || composingRef.current
    ) return;
    event.preventDefault();
    void submit();
  };

  return (
    <LibraryDialogShell
      open
      title={props.kind === "folder" ? "폴더 삭제 후 보존" : "워크스페이스 삭제 후 보존"}
      onClose={props.onClose}
      trigger={props.trigger}
      busy={saving}
    >
      <form onSubmit={(event) => void submit(event)}>
        {loading && <p className="text-[13px] text-inkSoft">최신 영향을 계산하는 중…</p>}

        {impact?.kind === "folder" && (
          <div className="space-y-3">
            <p className="text-[14px] font-semibold text-ink">
              회의 {impact.directVisibleMeetingCount}개를 {folderTarget || "보존 위치"}로 이동하고, 하위 폴더 {impact.directChildFolderCount}개를 한 단계 올립니다.
            </p>
            <ul className="space-y-1 text-[13px] text-inkSoft">
              <li>영향받는 배치 {impact.affectedPlacementCount}개 · 숨겨진 잘못된 상태 {impact.hiddenInvalidStatusPlacementCount}개</li>
              <li>저장 대기 위치 요청 {impact.pendingLocationIntentCount}개는 immutable 요청을 유지하며 이후 fallback될 수 있습니다.</li>
            </ul>
            {impact.promotionConflicts.length > 0 && (
              <div className="rounded-[12px] border border-error/40 bg-error/10 px-4 py-3 text-[13px] text-error">
                <p>승격 위치에 같은 이름의 폴더가 있습니다. 같은 이름의 폴더를 먼저 이름 변경하거나 이동해 주세요.</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {impact.promotionConflicts.map((conflict) => {
                    const promoted = preview?.library.folders.find((folder) => folder.id === conflict.promotedFolderId);
                    const existing = preview?.library.folders.find((folder) => folder.id === conflict.existingFolderId);
                    return (
                      <li key={`${conflict.promotedFolderId}:${conflict.existingFolderId}`}>
                        {promoted?.name ?? "승격 폴더"} ↔ {existing?.name ?? "기존 폴더"}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}

        {impact?.kind === "workspace" && (
          <div className="space-y-4">
            <p className="text-[14px] font-semibold text-ink">
              회의 {impact.visibleMeetingCount}개를 선택한 워크스페이스의 미분류로 이동하고 폴더 {impact.folderCount}개를 조직 정보에서 제거합니다.
            </p>
            <p className="text-[13px] text-inkSoft">
              영향받는 배치 {impact.affectedPlacementCount}개 · 숨겨진 잘못된 상태 {impact.hiddenInvalidStatusPlacementCount}개 · 저장 대기 위치 요청 {impact.pendingLocationIntentCount}개
            </p>
            {workspaceBlocked ? (
              <p className="rounded-[12px] border border-warn/40 bg-warnBg px-4 py-3 text-[13px] text-ink">
                마지막 워크스페이스는 삭제할 수 없습니다.
              </p>
            ) : (
              <>
                <label className="block text-[13px] font-medium text-ink">
                  보존할 워크스페이스
                  <select
                    aria-label="보존할 워크스페이스"
                    value={destinationWorkspaceId}
                    onChange={(event) => setDestinationWorkspaceId(event.currentTarget.value)}
                    className="mt-1 min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-[14px] text-ink"
                  >
                    <option value="">선택하세요</option>
                    {impact.destinationCandidates.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-[13px] font-medium text-ink">
                  워크스페이스 이름 확인
                  <span className="mt-1 block text-[12px] font-normal text-inkSoft">삭제를 확인하려면 “{props.container.name}”을 입력하세요.</span>
                  <input
                    aria-label="워크스페이스 이름 확인"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.currentTarget.value)}
                    onCompositionStart={() => { composingRef.current = true; }}
                    onCompositionEnd={(event) => {
                      composingRef.current = false;
                      setConfirmation(event.currentTarget.value);
                    }}
                    onKeyDown={onConfirmationKeyDown}
                    className="mt-1 min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-[14px] text-ink"
                  />
                </label>
              </>
            )}
          </div>
        )}

        {impact && (
          <p className="mt-4 rounded-[12px] border border-success/30 bg-soft px-4 py-3 text-[13px] text-ink">
            회의 원본과 전사·요약 파일은 삭제하지 않습니다. 조직 컨테이너 정보만 변경합니다.
          </p>
        )}
        {error && <p role="status" aria-live="polite" className="mt-3 text-[13px] text-error">{error}</p>}
        <button
          type="submit"
          disabled={submitDisabled}
          className="mt-5 min-h-11 rounded-full bg-warn px-5 text-[13px] font-semibold text-bg disabled:opacity-50"
        >
          {saving
            ? "보존하며 삭제 중…"
            : props.kind === "folder"
              ? "폴더만 삭제하고 보존"
              : "워크스페이스만 삭제하고 보존"}
        </button>
      </form>
    </LibraryDialogShell>
  );
}
