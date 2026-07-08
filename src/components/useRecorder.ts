"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { pickAudioMime, rms } from "@/lib/recorder";

// Client-only recording lifecycle. `recording` is a transient client state; the
// server only ever sees a meeting from `recorded` onward (POST .../finalize).
export type RecorderPhase = "idle" | "recording" | "uploading" | "done" | "error";

// Minimal shape of GET /api/meetings/[id] that this screen polls after upload.
type ServerStatus = { status: string; error?: { message: string } | null };

const POLL_INTERVAL_MS = 2000;
// Lifecycle states past which auto-transcription polling has nothing new to show.
const TERMINAL_STATUSES = new Set(["summarized"]);

function resolveAudioContext(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

export function useRecorder() {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Memory buffer: chunks accumulate in RAM and are stitched into one Blob on stop.
  // We never re-POST a growing blob during recording (that would be O(n²)).
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startMsRef = useRef(0);
  const startedAtRef = useRef("");
  const mimeRef = useRef("");
  const idRef = useRef("");

  // Stop meters/timer and release the mic + audio graph. Safe to call more than once.
  const teardownCapture = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
  }, []);

  // Release everything on unmount.
  useEffect(() => {
    return () => {
      teardownCapture();
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, [teardownCapture]);

  // Warn before navigating away while recording so a half-captured meeting isn't lost.
  useEffect(() => {
    if (phase !== "recording") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  // After upload, poll app-api so the UI reflects auto-transcription progress. The
  // app never calls an LLM; status is derived from files on disk by the server.
  const startPolling = useCallback((id: string) => {
    const tick = async () => {
      try {
        const res = await fetch(`/api/meetings/${id}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as ServerStatus;
        setServerStatus(data);
        if (data.error || TERMINAL_STATUSES.has(data.status)) {
          if (pollRef.current !== null) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      } catch {
        // Transient fetch failure — keep polling.
      }
    };
    if (pollRef.current !== null) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
    void tick();
  }, []);

  const uploadRecording = useCallback(async (id: string) => {
    const mime = mimeRef.current || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mime });
    const durationMs = Math.round(performance.now() - startMsRef.current);
    const query = new URLSearchParams({
      mime,
      durationMs: String(durationMs),
      startedAt: startedAtRef.current,
    });
    // Binary stream body (never base64 JSON) — matches POST .../finalize.
    const res = await fetch(`/api/meetings/${id}/finalize?${query.toString()}`, {
      method: "POST",
      headers: { "content-type": mime },
      body: blob,
    });
    if (!res.ok) throw new Error(`finalize failed (${res.status})`);
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || phase !== "recording") return;
    // Flush the final buffered chunk before stopping (with no timeslice, some
    // browsers only emit data on requestData()/stop()).
    try {
      recorder.requestData();
    } catch {
      // Not fatal — onstop still fires with whatever is already buffered.
    }
    recorder.stop();
  }, [phase]);

  const start = useCallback(async () => {
    if (phase === "recording" || phase === "uploading") return;
    setError(null);
    setServerStatus(null);
    setMeetingId(null);
    setElapsedMs(0);
    setLevel(0);
    chunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "마이크 접근이 거부되었습니다.");
      setPhase("error");
      return;
    }
    streamRef.current = stream;

    // Level meter: mic → analyser only. Never connect the analyser to destination —
    // that routes the mic back to the speakers (feedback).
    const AudioCtx = resolveAudioContext();
    if (AudioCtx) {
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      // Resume inside the click gesture (browser autoplay policy).
      void ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;
      const buffer = new Float32Array(analyser.fftSize);
      const sample = () => {
        const node = analyserRef.current;
        if (!node) return;
        node.getFloatTimeDomainData(buffer);
        setLevel(rms(buffer));
        rafRef.current = requestAnimationFrame(sample);
      };
      rafRef.current = requestAnimationFrame(sample);
    }

    const mime = pickAudioMime((m) => MediaRecorder.isTypeSupported(m));
    mimeRef.current = mime;
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      teardownCapture();
      const id = idRef.current;
      setPhase("uploading");
      uploadRecording(id)
        .then(() => {
          setPhase("done");
          startPolling(id);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "업로드에 실패했습니다.");
          setPhase("error");
        });
    };

    const id = crypto.randomUUID();
    idRef.current = id;
    setMeetingId(id);
    startMsRef.current = performance.now();
    startedAtRef.current = new Date().toISOString();
    timerRef.current = setInterval(() => {
      setElapsedMs(Math.round(performance.now() - startMsRef.current));
    }, 250);

    recorder.start();
    setPhase("recording");
  }, [phase, startPolling, teardownCapture, uploadRecording]);

  return { phase, elapsedMs, level, error, meetingId, serverStatus, start, stop };
}
