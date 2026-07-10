"use client";

import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent,
  useRef,
  useState,
} from "react";

import { LibraryDialogShell } from "@/components/LibraryPrimitives";
import { useLibrary } from "@/components/LibraryProvider";
import { useOptionalRecorderSession } from "@/components/RecorderSessionProvider";

export type LibraryRecoveryReason =
  | "corrupt"
  | "unsupported_version"
  | "io_error"
  | "recovery_conflict"
  | "recovery_not_supported";

export interface LibraryRecoveryHint {
  canRebuild: boolean;
  fingerprint: string;
}

interface RebuildSuccess {
  version: { libraryId: string; revision: number };
  defaultWorkspaceId: string;
  result: {
    discoveredVisibleMeetingCount: number;
    organizationReset: boolean;
    archivePreserved: boolean;
  };
}

function parseRebuildSuccess(value: unknown): RebuildSuccess | null {
  if (typeof value !== "object" || value === null) return null;
  const payload = value as Record<string, unknown>;
  const version = payload.version;
  const result = payload.result;
  if (
    payload.mode !== "ready"
    || typeof version !== "object"
    || version === null
    || typeof payload.defaultWorkspaceId !== "string"
    || typeof result !== "object"
    || result === null
  ) return null;
  const versionRecord = version as Record<string, unknown>;
  const resultRecord = result as Record<string, unknown>;
  if (
    typeof versionRecord.libraryId !== "string"
    || typeof versionRecord.revision !== "number"
    || !Number.isSafeInteger(versionRecord.revision)
    || versionRecord.revision < 0
    || typeof resultRecord.discoveredVisibleMeetingCount !== "number"
    || !Number.isSafeInteger(resultRecord.discoveredVisibleMeetingCount)
    || resultRecord.discoveredVisibleMeetingCount < 0
    || resultRecord.organizationReset !== true
    || resultRecord.archivePreserved !== true
  ) return null;
  return {
    version: {
      libraryId: versionRecord.libraryId,
      revision: versionRecord.revision,
    },
    defaultWorkspaceId: payload.defaultWorkspaceId,
    result: {
      discoveredVisibleMeetingCount: resultRecord.discoveredVisibleMeetingCount,
      organizationReset: true,
      archivePreserved: true,
    },
  };
}

function detailFor(reason: LibraryRecoveryReason | undefined): string {
  if (reason === "unsupported_version") {
    return "현재 앱보다 새로운 형식입니다. 앱을 업데이트한 뒤 다시 시도하세요. 이 상태에서는 재구축하지 않습니다.";
  }
  if (reason === "io_error") {
    return "저장소 권한이나 디스크 상태를 확인해 주세요. 읽기 오류가 해결되기 전에는 재구축하지 않습니다.";
  }
  if (reason === "recovery_conflict") {
    return "복구 파일 상태를 하나로 확정할 수 없습니다. 데이터를 바꾸지 않았으니 폴더를 확인한 뒤 다시 시도하세요.";
  }
  if (reason === "recovery_not_supported") {
    return "현재 파일 시스템에서는 원본을 안전하게 보존하는 재구축을 지원하지 않습니다. 읽기 전용 목록은 계속 사용할 수 있습니다.";
  }
  return "조직 정보가 손상되었습니다. 마지막으로 확인된 구조 또는 조직 위치 없이 발견한 회의를 읽기 전용으로 표시합니다.";
}

export function LibraryRecoveryPanel({
  mode,
  reason,
  recovery,
  onRetry,
}: {
  mode: "degraded_last_good" | "degraded_fallback";
  reason?: LibraryRecoveryReason;
  recovery?: LibraryRecoveryHint | null;
  onRetry: () => void;
}) {
  const library = useLibrary();
  const recorder = useOptionalRecorderSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);
  const recorderBlocksRebuild = recorder?.hasUnsavedAudio === true
    || recorder?.hasRetainedBlob === true;
  const canOfferRebuild = reason === "corrupt"
    && recovery?.canRebuild === true
    && /^[a-f0-9]{64}$/u.test(recovery.fingerprint);

  const reveal = async () => {
    await fetch("/api/library/reveal", { method: "POST" }).catch(() => {});
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !canOfferRebuild
      || recorderBlocksRebuild
      || confirmation !== "재구축"
      || composingRef.current
      || busy
    ) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/library/rebuild", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedMode: "corrupt",
          recoveryFingerprint: recovery.fingerprint,
        }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const code = typeof body === "object" && body !== null
          && typeof (body as { error?: { code?: unknown } }).error?.code === "string"
          ? (body as { error: { code: string } }).error.code
          : null;
        if (code === "fingerprint_changed") {
          setError("조직 정보가 바뀌었습니다. 최신 상태를 다시 확인해 주세요.");
          onRetry();
        } else if (code === "recovery_not_supported") {
          setError("현재 파일 시스템에서는 원본을 안전하게 보존하며 재구축할 수 없습니다.");
        } else if (code === "recovery_conflict") {
          setError("복구 상태가 충돌해 데이터를 바꾸지 않았습니다. 데이터 폴더를 확인해 주세요.");
        } else {
          setError("재구축을 완료하지 못했습니다. 원본은 덮어쓰지 않았습니다.");
        }
        return;
      }
      const success = parseRebuildSuccess(body);
      if (!success) {
        setError("재구축 결과를 안전하게 확인하지 못했습니다. 다시 시도해 주세요.");
        return;
      }
      window.sessionStorage.setItem("ai-note-focus-scope", "1");
      library.resetForGeneration(success.result);
      router.replace(`/?workspace=${encodeURIComponent(success.defaultWorkspaceId)}`);
      setOpen(false);
    } catch {
      setError("재구축 요청에 연결하지 못했습니다. 원본은 덮어쓰지 않았습니다.");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    setConfirmation("");
    setError(null);
  };

  return (
    <section className="rounded-[14px] border border-warn/40 bg-warnBg px-5 py-4" aria-live="polite">
      <h2 className="text-[14px] font-bold text-ink">
        {mode === "degraded_fallback" ? "조직 정보를 사용할 수 없습니다" : "조직 정보를 읽는 데 문제가 있습니다"}
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-inkSoft">{detailFor(reason)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className="min-h-11 rounded-full border border-line bg-panel px-4 text-[13px] font-semibold text-accent">
          다시 시도
        </button>
        <button type="button" onClick={() => void reveal()} className="min-h-11 rounded-full border border-line bg-panel px-4 text-[13px] font-semibold text-accent">
          데이터 폴더 열기
        </button>
        {canOfferRebuild && (
          <button
            ref={triggerRef}
            type="button"
            disabled={recorderBlocksRebuild}
            onClick={() => {
              setConfirmation("");
              setError(null);
              setOpen(true);
            }}
            className="min-h-11 rounded-full border border-error/40 bg-panel px-4 text-[13px] font-semibold text-error disabled:cursor-not-allowed disabled:opacity-45"
          >
            조직 정보 재구축
          </button>
        )}
      </div>
      {canOfferRebuild && recorderBlocksRebuild && (
        <p className="mt-2 text-[13px] text-inkSoft">
          보존 중인 녹음을 먼저 저장하거나 명시적으로 버린 뒤 재구축할 수 있습니다.
        </p>
      )}

      <LibraryDialogShell
        open={open}
        title="조직 정보 재구축"
        onClose={close}
        trigger={triggerRef.current}
        busy={busy}
      >
        <form onSubmit={(event) => void submit(event)}>
          <p className="text-[14px] leading-relaxed text-inkSoft">
            손상된 조직 정보 원본을 로컬 보관본으로 남기고 새 기본 워크스페이스를 만듭니다.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-inkSoft">
            <li>워크스페이스 이름과 순서가 초기화됩니다.</li>
            <li>폴더 이름·색상·순서와 폴더 구조가 초기화됩니다.</li>
            <li>발견한 회의의 위치는 새 기본 워크스페이스의 미분류로 초기화됩니다.</li>
            <li>회의 오디오·전사·요약 artifact 디렉터리는 삭제하지 않습니다.</li>
            <li>상태 파일까지 손상된 회의는 목록에 나타나지 않을 수 있습니다.</li>
          </ul>
          <label className="mt-4 block text-[13px] font-semibold text-ink" htmlFor="library-rebuild-confirmation">
            계속하려면 <span className="font-mono">재구축</span>을 정확히 입력하세요
          </label>
          <input
            id="library-rebuild-confirmation"
            value={confirmation}
            autoComplete="off"
            onChange={(event) => setConfirmation(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === "Enter" && (
                event.nativeEvent.isComposing
                || event.keyCode === 229
                || composingRef.current
              )) {
                event.preventDefault();
              }
            }}
            className="mt-2 min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[14px] text-ink"
          />
          {error && <p role="alert" className="mt-3 text-[13px] text-error">{error}</p>}
          <div className="mt-5 flex justify-end">
            <button
              type="submit"
              disabled={busy || recorderBlocksRebuild || confirmation !== "재구축"}
              className="min-h-11 rounded-full bg-error px-4 text-[13px] font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? "재구축 중…" : "재구축"}
            </button>
          </div>
        </form>
      </LibraryDialogShell>
    </section>
  );
}
