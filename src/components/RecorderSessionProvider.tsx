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

import { AppDialog } from "@/components/AppDialog";
import { useOptionalLibrary } from "@/components/LibraryProvider";
import { formatDuration, pickAudioMime, recorderPhaseAnnouncement, rms } from "@/lib/recorder";
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
export type NavigationBlockerPhase = "dirty" | "saving" | "verifying";

export interface NavigationBlockerDescriptor {
  id: string;
  kind: "meeting_content_edit";
  phase: NavigationBlockerPhase;
  label: "전체 스크립트 수정" | "회의록 요약 수정";
  discard: () => void;
  allowNavigation: (currentUrl: string, destinationUrl: string) => boolean;
}

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
  current: string;
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
  registerNavigationBlocker(blocker: NavigationBlockerDescriptor): void;
  unregisterNavigationBlocker(id: string): void;
  requestNavigation(
    destination: string,
    commit: () => void,
    trigger?: HTMLElement | null,
  ): boolean;
}

const RecorderSessionContext = createContext<RecorderSessionValue | null>(null);
const MAX_NAVIGATION_BLOCKERS = 8;

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
  const [blockerRevision, setBlockerRevision] = useState(0);

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
  const navigationCommitInProgressRef = useRef(false);
  const cancelNavigationRef = useRef<HTMLButtonElement>(null);
  const navigationBlockersRef = useRef(new Map<string, NavigationBlockerDescriptor>());
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

  const registerNavigationBlocker = useCallback((blocker: NavigationBlockerDescriptor) => {
    if (
      !blocker.id
      || blocker.id.length > 128
      || !blocker.label
      || blocker.label.length > 80
      || blocker.kind !== "meeting_content_edit"
    ) {
      throw new Error("invalid navigation blocker");
    }
    const blockers = navigationBlockersRef.current;
    if (!blockers.has(blocker.id) && blockers.size >= MAX_NAVIGATION_BLOCKERS) {
      throw new Error("navigation blocker limit reached");
    }
    blockers.set(blocker.id, blocker);
    setBlockerRevision((value) => value + 1);
  }, []);

  const unregisterNavigationBlocker = useCallback((id: string) => {
    if (!navigationBlockersRef.current.delete(id)) return;
    setBlockerRevision((value) => value + 1);
  }, []);

  const hasUnsavedAudio = phase === "requesting_permission"
    || phase === "recording"
    || phase === "stopping"
    || phase === "captured"
    || phase === "uploading"
    || phase === "finalize_ambiguous"
    || (phase === "failed" && hasRetainedBlob);

  const blockedContentNavigation = useCallback((current: string, destination: string) => (
    [...navigationBlockersRef.current.values()].filter((blocker) => {
      try {
        return !blocker.allowNavigation(current, destination);
      } catch {
        return true;
      }
    })
  ), []);

  const requestNavigation = useCallback((
    destination: string,
    commit: () => void,
    trigger: HTMLElement | null = null,
  ): boolean => {
    const current = currentUrlRef.current
      || (typeof window !== "undefined" ? window.location.href : "http://127.0.0.1:3000/");
    const audioBlocked = hasUnsavedAudio && !isScopeOnlyNavigation(current, destination);
    const contentBlocked = blockedContentNavigation(current, destination).length > 0;
    if (!audioBlocked && !contentBlocked) {
      try {
        currentUrlRef.current = new URL(destination, current).href;
      } catch {
        // The router remains responsible for rejecting malformed destinations.
      }
      commit();
      return true;
    }
    navigationCommitInProgressRef.current = false;
    setPendingNavigation({ current, destination, commit, trigger });
    return false;
  }, [blockedContentNavigation, hasUnsavedAudio]);

  const cancelPendingNavigation = useCallback(() => {
    navigationCommitInProgressRef.current = false;
    setPendingNavigation(null);
  }, []);

  const discardAndNavigate = useCallback(() => {
    const pending = pendingNavigation;
    if (!pending || navigationCommitInProgressRef.current) return;
    const contentBlockers = blockedContentNavigation(pending.current, pending.destination);
    if (contentBlockers.some((blocker) => blocker.phase !== "dirty")) return;
    const audioBlocked = hasUnsavedAudio
      && !isScopeOnlyNavigation(pending.current, pending.destination);
    navigationCommitInProgressRef.current = true;
    let committed = false;
    try {
      for (const blocker of contentBlockers) blocker.discard();
      if (audioBlocked) discard();
      setPendingNavigation(null);
      try {
        currentUrlRef.current = new URL(pending.destination, pending.current).href;
      } catch {
        // Let the stored navigation action handle it.
      }
      pending.commit();
      committed = true;
    } finally {
      if (!committed) navigationCommitInProgressRef.current = false;
    }
  }, [blockedContentNavigation, discard, hasUnsavedAudio, pendingNavigation]);

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
    if (!hasUnsavedAudio && navigationBlockersRef.current.size === 0) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [blockerRevision, hasUnsavedAudio]);

  useEffect(() => {
    const queueBlockedNavigation = (current: string, destination: string) => {
      navigationCommitInProgressRef.current = false;
      setPendingNavigation({
        current,
        destination,
        trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        commit: () => {
          suppressNextPopRef.current = true;
          window.history.back();
        },
      });
    };
    const browserNavigation = (
      window as typeof window & { navigation?: EventTarget }
    ).navigation;
    const onNavigate = (rawEvent: Event) => {
      const event = rawEvent as Event & {
        navigationType?: unknown;
        destination?: { url?: unknown };
      };
      if (
        event.navigationType !== "traverse"
        || !event.cancelable
        || typeof event.destination?.url !== "string"
        || suppressNextPopRef.current
      ) return;
      const current = currentUrlRef.current;
      const destination = event.destination.url;
      const audioBlocked = hasUnsavedAudio && !isScopeOnlyNavigation(current, destination);
      const contentBlocked = blockedContentNavigation(current, destination).length > 0;
      if (!audioBlocked && !contentBlocked) return;
      event.preventDefault();
      queueBlockedNavigation(current, destination);
    };
    const onPopState = (event: PopStateEvent) => {
      const destination = window.location.href;
      if (suppressNextPopRef.current) {
        suppressNextPopRef.current = false;
        currentUrlRef.current = destination;
        return;
      }
      const current = currentUrlRef.current;
      const audioBlocked = hasUnsavedAudio && !isScopeOnlyNavigation(current, destination);
      const contentBlocked = blockedContentNavigation(current, destination).length > 0;
      if (!audioBlocked && !contentBlocked) {
        currentUrlRef.current = destination;
        return;
      }
      event.stopImmediatePropagation();
      const restore = current;
      window.history.pushState(window.history.state, "", restore);
      queueBlockedNavigation(current, destination);
    };
    browserNavigation?.addEventListener("navigate", onNavigate);
    window.addEventListener("popstate", onPopState, true);
    return () => {
      browserNavigation?.removeEventListener("navigate", onNavigate);
      window.removeEventListener("popstate", onPopState, true);
    };
  }, [blockedContentNavigation, blockerRevision, hasUnsavedAudio]);

  useEffect(() => {
    if (!pendingNavigation) return;
    const pending = pendingNavigation;
    const audioBlocked = hasUnsavedAudio
      && !isScopeOnlyNavigation(pending.current, pending.destination);
    if (
      audioBlocked
      || blockedContentNavigation(pending.current, pending.destination).length > 0
    ) return;
    setPendingNavigation(null);
    try {
      currentUrlRef.current = new URL(pending.destination, pending.current).href;
    } catch {
      // The stored router action remains authoritative.
    }
    pending.commit();
  }, [blockedContentNavigation, blockerRevision, hasUnsavedAudio, pendingNavigation]);

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
    registerNavigationBlocker,
    unregisterNavigationBlocker,
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
    registerNavigationBlocker,
    unregisterNavigationBlocker,
    requestNavigation,
  ]);

  const pendingContentBlockers = pendingNavigation
    ? blockedContentNavigation(pendingNavigation.current, pendingNavigation.destination)
    : [];
  const pendingAudioBlocked = Boolean(
    pendingNavigation
    && hasUnsavedAudio
    && !isScopeOnlyNavigation(pendingNavigation.current, pendingNavigation.destination),
  );

  return (
    <RecorderSessionContext.Provider value={value}>
      {children}
      <RecorderCompactControls />
      {pendingNavigation && (
        <NavigationGuardDialog
          phase={phase}
          audioBlocked={pendingAudioBlocked}
          contentBlockers={pendingContentBlockers}
          cancelRef={cancelNavigationRef}
          returnFocus={pendingNavigation.trigger}
          onCancel={cancelPendingNavigation}
          onStop={stop}
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
  const discardTriggerRef = useRef<HTMLButtonElement>(null);
  const keepRecordingRef = useRef<HTMLButtonElement>(null);
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
      className="fixed bottom-4 right-4 z-50 flex min-h-11 max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-4 py-3 shadow-[0_12px_36px_-14px_rgba(42,36,32,.35)]"
    >
      {/* The visible label carries the ticking timer for sighted users, but stays out of
          any live region. A dedicated polite status announces the phase transition only. */}
      <span className="sr-only" role="status" aria-live="polite" data-testid="compact-recorder-announce">
        {recorderPhaseAnnouncement(session.phase)}
      </span>
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
        <button ref={discardTriggerRef} type="button" onClick={() => setConfirmDiscard(true)} className="min-h-11 rounded-full border border-error/50 px-4 text-[13px] font-semibold text-error">
          녹음 버리기
        </button>
      )}
      {session.phase === "saved" && (
        <button type="button" onClick={session.dismiss} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent">
          닫기
        </button>
      )}
      {confirmDiscard && (
        <AppDialog
          open
          title="녹음을 영구히 버릴까요?"
          initialFocusRef={keepRecordingRef}
          returnFocus={discardTriggerRef}
          onDismiss={() => setConfirmDiscard(false)}
        >
          {(dismiss) => (
            <>
            <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">
              아직 게시되지 않은 원본 오디오와 저장 복구 상태가 삭제되며 되돌릴 수 없습니다.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                ref={keepRecordingRef}
                type="button"
                onClick={() => dismiss("explicit_cancel")}
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
            </>
          )}
        </AppDialog>
      )}
    </aside>
  );
}

function NavigationGuardDialog({
  phase,
  audioBlocked,
  contentBlockers,
  cancelRef,
  returnFocus,
  onCancel,
  onStop,
  onDiscard,
}: {
  phase: RecorderSessionPhase;
  audioBlocked: boolean;
  contentBlockers: NavigationBlockerDescriptor[];
  cancelRef: RefObject<HTMLButtonElement>;
  returnFocus: HTMLElement | null;
  onCancel: () => void;
  onStop: () => void;
  onDiscard: () => void;
}) {
  const recording = audioBlocked
    && (phase === "recording" || phase === "requesting_permission");
  const hasContent = contentBlockers.length > 0;
  const contentBusy = contentBlockers.some((blocker) => blocker.phase !== "dirty");
  const title = audioBlocked && hasContent
    ? "녹음과 수정 내용이 저장되지 않았습니다"
    : hasContent
      ? "수정 내용이 저장되지 않았습니다"
      : "녹음이 아직 저장되지 않았습니다";
  const cancelLabel = recording
    ? "계속 녹음"
    : hasContent
      ? "계속 편집"
      : "현재 화면에 머물기";
  const discardLabel = audioBlocked && hasContent
    ? "녹음과 수정 내용 버리고 이동"
    : hasContent
      ? "수정 내용 버리고 이동"
      : "녹음 버리고 이동";
  return (
    <AppDialog
      open
      title={title}
      initialFocusRef={cancelRef}
      returnFocus={returnFocus}
      onDismiss={() => onCancel()}
    >
      {(dismiss) => (
        <>
        {hasContent ? (
          <div className="mt-2 text-[14px] leading-relaxed text-inkSoft">
            <p>
              {contentBusy
                ? "아래 작업의 저장 결과를 확인하고 있습니다."
                : "아래 저장되지 않은 내용은 이동하면 사라집니다."}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-ink">
              {audioBlocked && <li>녹음 원본 또는 저장 대기 오디오</li>}
              {contentBlockers.map((blocker) => (
                <li key={blocker.id}>{blocker.label} 초안</li>
              ))}
            </ul>
            {contentBusy && (
              <p className="mt-2">
                저장 결과를 확인한 뒤 이동합니다. 결과가 확정되기 전에는 수정 내용을 버리거나 화면을 떠날 수 없습니다.
              </p>
            )}
          </div>
        ) : audioBlocked ? (
          <p className="mt-2 text-[14px] leading-relaxed text-inkSoft">
            이 화면을 떠나면 현재 녹음 또는 저장 대기 오디오를 잃을 수 있습니다.
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={() => dismiss("explicit_cancel")} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-accent">
            {cancelLabel}
          </button>
          {audioBlocked && phase === "recording" && (
            <button type="button" onClick={() => { onStop(); dismiss("explicit_cancel"); }} className="min-h-11 rounded-full border border-line px-4 text-[13px] font-semibold text-ink">
              기록 중지하고 머물기
            </button>
          )}
          {!contentBusy && (
            <button type="button" onClick={onDiscard} className="min-h-11 rounded-full bg-error px-4 text-[13px] font-semibold text-bg">
              {discardLabel}
            </button>
          )}
        </div>
        </>
      )}
    </AppDialog>
  );
}
