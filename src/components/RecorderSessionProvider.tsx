"use client";

import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useOptionalLibrary } from "@/components/LibraryProvider";
import { formatDuration, pickAudioMime, rms } from "@/lib/recorder";
import type {
  RecorderFinalizeResultContract,
  RecorderResultLocation,
} from "@/lib/recorderFinalizeResult";
import { isScopeOnlyNavigation } from "@/lib/recorderNavigation";

export type RecorderSessionPhase =
  | "idle"
  | "requesting_permission"
  | "recording"
  | "stopping"
  | "captured"
  | "uploading"
  | "finalize_ambiguous"
  | "saved"
  | "failed";

export type RecorderRequestedLocation = RecorderResultLocation;
export type RecorderFinalizeResult = RecorderFinalizeResultContract;
export type RecorderRetryDisposition = "probe_required" | "body_required" | "blocked" | null;

type ServerStatus = { status: string; error?: { message: string } | null };

interface CapturedRecording {
  id: string;
  blob: Blob;
  mimeType: string;
  startedAt: string;
  durationMs: number;
  requestedLocation?: RecorderRequestedLocation;
}

type FinalizeMetadata = Omit<CapturedRecording, "blob">;

interface PendingNavigation {
  destination: string;
  commit: () => void;
  trigger: HTMLElement | null;
}

export interface RecorderSessionValue {
  phase: RecorderSessionPhase;
  elapsedMs: number;
  level: number;
  error: string | null;
  meetingId: string | null;
  serverStatus: ServerStatus | null;
  finalizeResult: RecorderFinalizeResult | null;
  retryDisposition: RecorderRetryDisposition;
  hasRetainedBlob: boolean;
  hasUnsavedAudio: boolean;
  start(options?: { requestedLocation?: RecorderRequestedLocation }): Promise<void>;
  stop(): void;
  save(): Promise<void>;
  retry(): Promise<void>;
  probe(): Promise<void>;
  discard(): void;
  dismiss(): void;
  requestNavigation(
    destination: string,
    commit: () => void,
    trigger?: HTMLElement | null,
  ): boolean;
}

const RecorderSessionContext = createContext<RecorderSessionValue | null>(null);

function resolveAudioContext(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function messageForFailure(status: number): string {
  if (status === 410) return "삭제된 회의 ID라 저장할 수 없습니다.";
  if (status === 409) return "같은 회의의 다른 저장 작업과 충돌했습니다.";
  if (status >= 400 && status < 500) return "녹음 저장 요청을 확인해 주세요.";
  return "저장 결과를 확인하지 못했습니다. 같은 녹음으로 다시 확인할 수 있습니다.";
}

function finalizeQuery(metadata: FinalizeMetadata, probe = false): URLSearchParams {
  const query = new URLSearchParams({
    mime: metadata.mimeType,
    durationMs: String(metadata.durationMs),
    startedAt: metadata.startedAt,
  });
  if (metadata.requestedLocation) {
    query.set("workspaceId", metadata.requestedLocation.workspaceId);
    if (metadata.requestedLocation.folderId) {
      query.set("folderId", metadata.requestedLocation.folderId);
    }
  }
  if (probe) query.set("probe", "1");
  return query;
}

function finalizeMetadata(capture: CapturedRecording): FinalizeMetadata {
  return {
    id: capture.id,
    mimeType: capture.mimeType,
    startedAt: capture.startedAt,
    durationMs: capture.durationMs,
    requestedLocation: capture.requestedLocation,
  };
}

function isFinalizeResult(value: unknown): value is RecorderFinalizeResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (
    (result.artifact !== "published" && result.artifact !== "already_published")
    || !["durable", "best_effort", "pending"].includes(String(result.durability))
    || !["ready", "failed", "unchanged"].includes(String(result.playback))
    || !["accepted", "failed", "unchanged"].includes(String(result.transcription))
    || typeof result.placement !== "object"
    || result.placement === null
  ) return false;
  const placement = result.placement as Record<string, unknown>;
  return ["saved", "fallback", "unavailable"].includes(String(placement.outcome));
}

export function RecorderSessionProvider({ children }: { children: ReactNode }) {
  const library = useOptionalLibrary();
  const [phase, setPhaseState] = useState<RecorderSessionPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [finalizeResult, setFinalizeResult] = useState<RecorderFinalizeResult | null>(null);
  const [retryDisposition, setRetryDisposition] = useState<RecorderRetryDisposition>(null);
  const [hasRetainedBlob, setHasRetainedBlob] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);

  const phaseRef = useRef<RecorderSessionPhase>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const capturedRef = useRef<CapturedRecording | null>(null);
  const finalizeMetadataRef = useRef<FinalizeMetadata | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const animationRef = useRef<number | null>(null);
  const startedAtRef = useRef("");
  const startTimeRef = useRef(0);
  const requestedLocationRef = useRef<RecorderRequestedLocation | undefined>(undefined);
  const discardInProgressRef = useRef(false);
  const mountedRef = useRef(true);
  const currentUrlRef = useRef("");
  const suppressNextPopRef = useRef(false);
  const cancelNavigationRef = useRef<HTMLButtonElement>(null);
  const refreshLibrary = library?.refreshLibrary;
  const invalidateStatusWork = library?.invalidateStatusWork;
  const invalidateOrganizationPending = library?.invalidateOrganizationPending;

  const setPhase = useCallback((next: RecorderSessionPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const teardownCapture = useCallback(() => {
    if (animationRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) clearInterval(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const startPolling = useCallback((id: string) => {
    stopPolling();
    const tick = async () => {
      try {
        const response = await fetch(`/api/meetings/${id}`, { cache: "no-store" });
        if (!response.ok) return;
        const status = (await response.json()) as ServerStatus;
        if (!mountedRef.current) return;
        setServerStatus(status);
        if (status.error || status.status === "summarized") stopPolling();
      } catch {
        // A later poll can recover a transient local request failure.
      }
    };
    pollTimerRef.current = setInterval(() => void tick(), 2_000);
    void tick();
  }, [stopPolling]);

  const acceptFinalizeResult = useCallback((
    result: RecorderFinalizeResult,
    metadata: FinalizeMetadata,
  ) => {
    capturedRef.current = null;
    finalizeMetadataRef.current = metadata;
    chunksRef.current = [];
    setHasRetainedBlob(false);
    setRetryDisposition(null);
    setFinalizeResult(result);
    setServerStatus(result.status ? { status: result.status } : null);
    setPhase("saved");
    refreshLibrary?.();
    invalidateStatusWork?.();
    invalidateOrganizationPending?.();
    startPolling(metadata.id);
  }, [
    invalidateOrganizationPending,
    invalidateStatusWork,
    refreshLibrary,
    setPhase,
    startPolling,
  ]);

  const uploadCapture = useCallback(async (capture: CapturedRecording) => {
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setPhase("uploading");
    setError(null);
    setRetryDisposition(null);
    const metadata = finalizeMetadata(capture);
    finalizeMetadataRef.current = metadata;
    const query = finalizeQuery(metadata);
    try {
      const response = await fetch(`/api/meetings/${capture.id}/finalize?${query.toString()}`, {
        method: "POST",
        headers: { "content-type": capture.mimeType },
        body: capture.blob,
        signal: controller.signal,
      });
      if (!response.ok) {
        setError(messageForFailure(response.status));
        if (response.status >= 500) {
          setRetryDisposition("probe_required");
          setPhase("finalize_ambiguous");
        } else {
          setRetryDisposition("blocked");
          setPhase("failed");
        }
        return;
      }
      const result = await response.json() as unknown;
      if (!mountedRef.current || controller.signal.aborted) return;
      if (!isFinalizeResult(result)) {
        setError("저장 응답을 확인하지 못했습니다. 같은 ID로 저장 상태를 확인해 주세요.");
        setRetryDisposition("probe_required");
        setPhase("finalize_ambiguous");
        return;
      }
      acceptFinalizeResult(result, metadata);
    } catch (uploadError) {
      if (controller.signal.aborted || discardInProgressRef.current) return;
      setError(
        uploadError instanceof Error && uploadError.message
          ? "저장 결과를 확인하지 못했습니다. 같은 녹음으로 다시 확인할 수 있습니다."
          : "녹음 저장 상태를 확인할 수 없습니다.",
      );
      setRetryDisposition("probe_required");
      setPhase("finalize_ambiguous");
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
    }
  }, [acceptFinalizeResult, setPhase]);

  const probe = useCallback(async () => {
    const metadata = finalizeMetadataRef.current
      ?? (capturedRef.current ? finalizeMetadata(capturedRef.current) : null);
    if (!metadata || phaseRef.current === "uploading") return;
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setPhase("uploading");
    setError(null);
    try {
      const response = await fetch(
        `/api/meetings/${metadata.id}/finalize?${finalizeQuery(metadata, true).toString()}`,
        {
          method: "POST",
          headers: { "x-ai-note-finalize-probe": "1" },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        setError(messageForFailure(response.status));
        if (response.status === 409 || response.status === 410) {
          setRetryDisposition("blocked");
          setPhase("failed");
        } else {
          setRetryDisposition("probe_required");
          setPhase("finalize_ambiguous");
        }
        return;
      }
      const result = await response.json() as unknown;
      if (isFinalizeResult(result)) {
        acceptFinalizeResult(result, metadata);
        return;
      }
      const probeState = typeof result === "object" && result !== null && "probe" in result
        ? String((result as { probe?: unknown }).probe)
        : "";
      if (probeState === "not_committed" || probeState === "body_required") {
        setError("서버에 원본 오디오가 아직 게시되지 않았습니다. 같은 녹음으로 다시 저장할 수 있습니다.");
        setRetryDisposition("body_required");
        setPhase("failed");
        return;
      }
      setError("저장 상태를 확정하지 못했습니다. 데이터 폴더를 확인해 주세요.");
      setRetryDisposition("blocked");
      setPhase("failed");
    } catch {
      if (controller.signal.aborted || discardInProgressRef.current) return;
      setError("저장 상태 확인 요청에 실패했습니다. 같은 ID로 다시 확인할 수 있습니다.");
      setRetryDisposition("probe_required");
      setPhase("finalize_ambiguous");
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
    }
  }, [acceptFinalizeResult, setPhase]);

  const save = useCallback(async () => {
    const capture = capturedRef.current;
    if (!capture || phaseRef.current === "uploading") return;
    await uploadCapture(capture);
  }, [uploadCapture]);

  const retry = useCallback(async () => {
    if (phaseRef.current === "finalize_ambiguous" || phaseRef.current === "saved") {
      await probe();
      return;
    }
    if (
      phaseRef.current === "captured"
      || (phaseRef.current === "failed" && retryDisposition === "body_required")
    ) {
      await save();
    }
  }, [probe, retryDisposition, save]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || phaseRef.current !== "recording") return;
    setPhase("stopping");
    try {
      recorder.requestData();
    } catch {
      // stop() still yields every chunk the browser has buffered.
    }
    recorder.stop();
  }, [setPhase]);

  const start = useCallback(async (
    options: { requestedLocation?: RecorderRequestedLocation } = {},
  ) => {
    if (!["idle", "saved", "failed"].includes(phaseRef.current) || capturedRef.current) return;
    discardInProgressRef.current = false;
    stopPolling();
    setError(null);
    setServerStatus(null);
    setFinalizeResult(null);
    setRetryDisposition(null);
    setElapsedMs(0);
    setLevel(0);
    chunksRef.current = [];
    requestedLocationRef.current = options.requestedLocation;
    finalizeMetadataRef.current = null;
    const id = crypto.randomUUID();
    setMeetingId(id);
    setPhase("requesting_permission");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (permissionError) {
      setError(permissionError instanceof Error ? permissionError.message : "마이크 접근이 거부되었습니다.");
      setPhase("failed");
      return;
    }
    if (discardInProgressRef.current || phaseRef.current !== "requesting_permission") {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;

    const AudioContextConstructor = resolveAudioContext();
    if (AudioContextConstructor) {
      const context = new AudioContextConstructor();
      audioContextRef.current = context;
      void context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;
      const values = new Float32Array(analyser.fftSize);
      const sample = () => {
        const current = analyserRef.current;
        if (!current) return;
        current.getFloatTimeDomainData(values);
        setLevel(rms(values));
        animationRef.current = requestAnimationFrame(sample);
      };
      animationRef.current = requestAnimationFrame(sample);
    }

    const mimeType = pickAudioMime((candidate) => MediaRecorder.isTypeSupported(candidate)) || "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && !discardInProgressRef.current) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      teardownCapture();
      recorderRef.current = null;
      if (discardInProgressRef.current) return;
      const durationMs = Math.max(0, Math.round(performance.now() - startTimeRef.current));
      const capture: CapturedRecording = {
        id,
        blob: new Blob(chunksRef.current, { type: mimeType }),
        mimeType,
        startedAt: startedAtRef.current,
        durationMs,
        requestedLocation: requestedLocationRef.current,
      };
      capturedRef.current = capture;
      finalizeMetadataRef.current = finalizeMetadata(capture);
      setHasRetainedBlob(true);
      setElapsedMs(durationMs);
      setPhase("captured");
      window.setTimeout(() => {
        if (capturedRef.current === capture && phaseRef.current === "captured") void uploadCapture(capture);
      }, 0);
    };

    startedAtRef.current = new Date().toISOString();
    startTimeRef.current = performance.now();
    timerRef.current = setInterval(() => {
      setElapsedMs(Math.max(0, Math.round(performance.now() - startTimeRef.current)));
    }, 250);
    recorder.start();
    setPhase("recording");
  }, [setPhase, stopPolling, teardownCapture, uploadCapture]);

  const discard = useCallback(() => {
    discardInProgressRef.current = true;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // Capture teardown below is authoritative.
      }
    }
    teardownCapture();
    stopPolling();
    chunksRef.current = [];
    capturedRef.current = null;
    finalizeMetadataRef.current = null;
    requestedLocationRef.current = undefined;
    setHasRetainedBlob(false);
    setMeetingId(null);
    setServerStatus(null);
    setFinalizeResult(null);
    setRetryDisposition(null);
    setError(null);
    setElapsedMs(0);
    setLevel(0);
    setPhase("idle");
  }, [setPhase, stopPolling, teardownCapture]);

  const dismiss = useCallback(() => {
    if (phaseRef.current === "saved" || (phaseRef.current === "failed" && !capturedRef.current)) {
      discard();
    }
  }, [discard]);

  const hasUnsavedAudio = phase === "requesting_permission"
    || phase === "recording"
    || phase === "stopping"
    || phase === "captured"
    || phase === "uploading"
    || phase === "finalize_ambiguous"
    || (phase === "failed" && hasRetainedBlob);

  const requestNavigation = useCallback((
    destination: string,
    commit: () => void,
    trigger: HTMLElement | null = null,
  ): boolean => {
    const current = currentUrlRef.current
      || (typeof window !== "undefined" ? window.location.href : "http://127.0.0.1:3000/");
    if (!hasUnsavedAudio || isScopeOnlyNavigation(current, destination)) {
      try {
        currentUrlRef.current = new URL(destination, current).href;
      } catch {
        // The router remains responsible for rejecting malformed destinations.
      }
      commit();
      return true;
    }
    setPendingNavigation({ destination, commit, trigger });
    return false;
  }, [hasUnsavedAudio]);

  const cancelPendingNavigation = useCallback(() => {
    const trigger = pendingNavigation?.trigger;
    setPendingNavigation(null);
    window.setTimeout(() => trigger?.focus(), 0);
  }, [pendingNavigation]);

  const discardAndNavigate = useCallback(() => {
    const pending = pendingNavigation;
    if (!pending) return;
    setPendingNavigation(null);
    discard();
    try {
      currentUrlRef.current = new URL(pending.destination, currentUrlRef.current).href;
    } catch {
      // Let the stored navigation action handle it.
    }
    pending.commit();
  }, [discard, pendingNavigation]);

  useEffect(() => {
    mountedRef.current = true;
    currentUrlRef.current = window.location.href;
    return () => {
      mountedRef.current = false;
      uploadAbortRef.current?.abort();
      teardownCapture();
      stopPolling();
    };
  }, [stopPolling, teardownCapture]);

  useEffect(() => {
    if (!hasUnsavedAudio) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasUnsavedAudio]);

  useEffect(() => {
    const onPopState = () => {
      const destination = window.location.href;
      if (suppressNextPopRef.current) {
        suppressNextPopRef.current = false;
        currentUrlRef.current = destination;
        return;
      }
      if (!hasUnsavedAudio || isScopeOnlyNavigation(currentUrlRef.current, destination)) {
        currentUrlRef.current = destination;
        return;
      }
      const restore = currentUrlRef.current;
      window.history.pushState(window.history.state, "", restore);
      setPendingNavigation({
        destination,
        trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        commit: () => {
          suppressNextPopRef.current = true;
          window.history.back();
        },
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [hasUnsavedAudio]);

  useEffect(() => {
    if (!pendingNavigation) return;
    cancelNavigationRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelPendingNavigation();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [cancelPendingNavigation, pendingNavigation]);

  useEffect(() => {
    if (!pendingNavigation || hasUnsavedAudio) return;
    const pending = pendingNavigation;
    setPendingNavigation(null);
    try {
      currentUrlRef.current = new URL(pending.destination, currentUrlRef.current).href;
    } catch {
      // The stored router action remains authoritative.
    }
    pending.commit();
  }, [hasUnsavedAudio, pendingNavigation]);

  const value = useMemo<RecorderSessionValue>(() => ({
    phase,
    elapsedMs,
    level,
    error,
    meetingId,
    serverStatus,
    finalizeResult,
    retryDisposition,
    hasRetainedBlob,
    hasUnsavedAudio,
    start,
    stop,
    save,
    retry,
    probe,
    discard,
    dismiss,
    requestNavigation,
  }), [
    phase,
    elapsedMs,
    level,
    error,
    meetingId,
    serverStatus,
    finalizeResult,
    retryDisposition,
    hasRetainedBlob,
    hasUnsavedAudio,
    start,
    stop,
    save,
    retry,
    probe,
    discard,
    dismiss,
    requestNavigation,
  ]);

  return (
    <RecorderSessionContext.Provider value={value}>
      {children}
      <RecorderCompactControls />
      {pendingNavigation && (
        <RecorderNavigationDialog
          phase={phase}
          cancelRef={cancelNavigationRef}
          onCancel={cancelPendingNavigation}
          onStop={() => {
            stop();
            cancelPendingNavigation();
          }}
          onDiscard={discardAndNavigate}
        />
      )}
    </RecorderSessionContext.Provider>
  );
}

export function useRecorderSession(): RecorderSessionValue {
  const value = useContext(RecorderSessionContext);
  if (!value) throw new Error("useRecorderSession must be used inside RecorderSessionProvider");
  return value;
}

export function useOptionalRecorderSession(): RecorderSessionValue | null {
  return useContext(RecorderSessionContext);
}

function RecorderCompactControls() {
  const session = useRecorderSession();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  if (session.phase === "idle") return null;
  const label = session.phase === "recording"
    ? `기록 중 · ${formatDuration(session.elapsedMs)}`
    : session.phase === "requesting_permission"
      ? "마이크 권한 확인 중…"
      : session.phase === "stopping" || session.phase === "captured"
        ? "녹음 정리 중…"
        : session.phase === "uploading"
          ? "녹음을 저장하는 중…"
          : session.phase === "finalize_ambiguous"
            ? "저장 결과 확인 필요"
            : session.phase === "saved"
              ? "녹음 저장 완료"
              : session.error ?? "녹음 작업 확인 필요";
  return (
    <aside
      aria-label="진행 중인 녹음"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex min-h-11 max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-4 py-3 shadow-[0_12px_36px_-14px_rgba(42,36,32,.35)]"
    >
      <span className="text-[13px] font-semibold text-ink">{label}</span>
      {session.phase === "recording" && (
        <button type="button" onClick={session.stop} className="min-h-11 rounded-full bg-ink px-4 text-[13px] font-semibold text-bg">
          기록 중지
        </button>
      )}
      {session.phase === "captured" && (
        <button type="button" onClick={() => void session.save()} className="min-h-11 rounded-full bg-ink px-4 text-[13px] font-semibold text-bg">저장</button>
      )}
      {session.phase === "finalize_ambiguous" && (
        <button type="button" onClick={() => void session.probe()} className="min-h-11 rounded-full bg-ink px-4 text-[13px] font-semibold text-bg">저장 상태 확인</button>
      )}
      {session.phase === "failed" && session.hasRetainedBlob && session.retryDisposition === "body_required" && (
        <button type="button" onClick={() => void session.retry()} className="min-h-11 rounded-full bg-ink px-4 text-[13px] font-semibold text-bg">저장 다시 시도</button>
      )}
      {session.phase !== "saved" && (
        <button type="button" onClick={() => setConfirmDiscard(true)} className="min-h-11 rounded-full border border-error/50 px-4 text-[13px] font-semibold text-error">
          녹음 버리기
        </button>
      )}
      {session.phase === "saved" && (
        <button type="button" onClick={session.dismiss} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent">
          닫기
        </button>
      )}
      {confirmDiscard && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/35 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="recorder-discard-title"
            className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-xl"
          >
            <h2 id="recorder-discard-title" className="text-[18px] font-bold text-ink">
              녹음을 영구히 버릴까요?
            </h2>
            <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">
              아직 게시되지 않은 원본 오디오와 저장 복구 상태가 삭제되며 되돌릴 수 없습니다.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                autoFocus
                type="button"
                onClick={() => setConfirmDiscard(false)}
                className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent"
              >
                유지하기
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDiscard(false);
                  session.discard();
                }}
                className="min-h-11 rounded-full bg-error px-4 text-[13px] font-semibold text-bg"
              >
                녹음 영구히 버리기
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function RecorderNavigationDialog({
  phase,
  cancelRef,
  onCancel,
  onStop,
  onDiscard,
}: {
  phase: RecorderSessionPhase;
  cancelRef: RefObject<HTMLButtonElement>;
  onCancel: () => void;
  onStop: () => void;
  onDiscard: () => void;
}) {
  const recording = phase === "recording" || phase === "requesting_permission";
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/35 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="recorder-navigation-title" className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-xl">
        <h2 id="recorder-navigation-title" className="text-[18px] font-bold text-ink">
          녹음이 아직 저장되지 않았습니다
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">
          이 화면을 떠나면 현재 녹음 또는 저장 대기 오디오를 잃을 수 있습니다.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent">
            {recording ? "계속 녹음" : "현재 화면에 머물기"}
          </button>
          {phase === "recording" && (
            <button type="button" onClick={onStop} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-ink">
              기록 중지하고 머물기
            </button>
          )}
          <button type="button" onClick={onDiscard} className="min-h-11 rounded-full bg-error px-4 text-[13px] font-semibold text-bg">
            녹음 버리고 이동
          </button>
        </div>
      </div>
    </div>
  );
}
