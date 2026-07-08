from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Local batch STT service for Meeting Recorder.
#
# Contract (docs/ARCHITECTURE.md — whisper HTTP 계약):
#   GET  /health          -> {ok, model, ready}
#   POST /transcribe      -> 202 {jobId}   body: {audioPath, rawPath, segmentsPath}
#   GET  /jobs/{jobId}     -> {status: processing|done|error, progress, error?}
# On job completion the worker writes raw.md (segment-per-line) + segments.json
# ([{start,end,text}]) atomically to the given paths.
#
# IMPORTANT: mlx_whisper / faster_whisper are NEVER imported at module top-level.
# They are lazy-imported inside the real transcription path only, so this module
# (and FAKE_WHISPER mode) loads with pure stdlib — no venv, no model, no network.

HOST = os.environ.get("LOCAL_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("LOCAL_STT_PORT", "8123"))
MODEL = os.environ.get("LOCAL_STT_MODEL", "large-v3")
FAKE = os.environ.get("FAKE_WHISPER") == "1"

FFMPEG_FALLBACK = "/opt/homebrew/bin/ffmpeg"

# Canned segments for FAKE mode (hermetic tests). Pure stdlib — no model load.
FAKE_SEGMENTS = [
    {"start": 0.0, "end": 2.4, "text": "안녕하세요, 오늘 회의를 시작하겠습니다."},
    {"start": 2.4, "end": 6.1, "text": "오늘 안건은 파일럿 온보딩 일정 확인입니다."},
    {"start": 6.1, "end": 9.7, "text": "액션 아이템은 다음 스프린트에 정리하겠습니다."},
]

_jobs: dict = {}
_jobs_lock = threading.Lock()


def ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg") or (FFMPEG_FALLBACK if Path(FFMPEG_FALLBACK).exists() else None)


def health() -> dict:
    if FAKE:
        return {"ok": True, "model": "fake", "ready": True}
    ready = ffmpeg_path() is not None
    payload = {"ok": True, "model": MODEL, "ready": ready}
    if not ready:
        payload["message"] = (
            "ffmpeg not found. Install it (`brew install ffmpeg`) before transcribing; "
            "mlx-whisper shells out to the ffmpeg CLI."
        )
    return payload


def atomic_write(path: Path, data: str) -> None:
    # temp -> fsync -> rename, mirroring src/lib/atomicWrite.ts (부분쓰기 손상 방지).
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _transcribe_real(audio_path: str) -> list:
    # Lazy imports — keep 3rd-party out of module import so FAKE mode stays pure stdlib.
    try:
        import mlx_whisper  # type: ignore

        repo = os.environ.get("LOCAL_STT_MLX_REPO", f"mlx-community/whisper-{MODEL}-mlx")
        result = mlx_whisper.transcribe(audio_path, path_or_hf_repo=repo, language="ko")
        return [
            {"start": float(seg["start"]), "end": float(seg["end"]), "text": (seg.get("text") or "").strip()}
            for seg in result.get("segments", [])
        ]
    except ImportError:
        from faster_whisper import WhisperModel  # type: ignore

        model = WhisperModel(MODEL, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(audio_path, language="ko")
        return [
            {"start": float(seg.start), "end": float(seg.end), "text": (seg.text or "").strip()}
            for seg in segments
        ]


def transcribe(audio_path: str) -> list:
    if FAKE:
        return [dict(seg) for seg in FAKE_SEGMENTS]
    return _transcribe_real(audio_path)


def _set_job(job_id: str, **fields) -> None:
    with _jobs_lock:
        _jobs.setdefault(job_id, {}).update(fields)


def _get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job is not None else None


def run_job(job_id: str, audio_path: str, raw_path: str, segments_path: str) -> None:
    try:
        segments = transcribe(audio_path)
        # raw.md: one segment per line (분할점 보장) — downstream refine merges lines.
        raw_md = "\n".join(seg["text"] for seg in segments if seg["text"]) + "\n"
        atomic_write(Path(raw_path), raw_md)
        atomic_write(Path(segments_path), json.dumps(segments, ensure_ascii=False, indent=2) + "\n")
        _set_job(job_id, status="done", progress=1.0)
    except Exception as exc:  # surface any failure as a job error, not a crash
        _set_job(job_id, status="error", progress=0.0, error=str(exc))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, health())
            return
        if self.path.startswith("/jobs/"):
            job_id = self.path[len("/jobs/"):].strip("/")
            job = _get_job(job_id)
            if job is None:
                self._send_json(404, {"status": "error", "progress": 0.0, "error": "unknown job"})
                return
            self._send_json(200, job)
            return
        self._send_json(404, {"error": "not_found", "path": self.path})

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            self._send_json(404, {"error": "not_found", "path": self.path})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "invalid_json"})
            return
        audio_path = body.get("audioPath")
        raw_path = body.get("rawPath")
        segments_path = body.get("segmentsPath")
        if not (audio_path and raw_path and segments_path):
            self._send_json(400, {"error": "audioPath, rawPath and segmentsPath are required"})
            return
        job_id = uuid.uuid4().hex
        _set_job(job_id, status="processing", progress=0.0)
        thread = threading.Thread(
            target=run_job,
            args=(job_id, str(audio_path), str(raw_path), str(segments_path)),
            daemon=True,
        )
        thread.start()
        self._send_json(202, {"jobId": job_id})

    def _send_json(self, status: int, payload: dict) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args) -> None:  # silence default per-request stderr logging
        pass


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    host, port = server.server_address[:2]
    # Machine-parseable line so callers/tests can discover the bound (possibly ephemeral) port.
    print(f"WHISPER_LISTENING http://{host}:{port}", flush=True)
    print(f"[whisper] fake={FAKE} model={MODEL} ffmpeg={ffmpeg_path()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
