from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from model_catalog import (
    DEFAULT_MODEL,
    MODEL_CATALOG,
    ModelCatalogError,
    effective_model_snapshot,
    legacy_model_snapshot,
    snapshot_for_catalog_model,
    validate_model_snapshot,
)


def _load_env_local() -> None:
    env_path = Path(__file__).resolve().parent.parent / ".env.local"
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


_load_env_local()

HOST = os.environ.get("LOCAL_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("LOCAL_STT_PORT", "8123"))
LEGACY_MODEL_CONFIGURED = (
    "LOCAL_STT_MODEL" in os.environ or "LOCAL_STT_MLX_REPO" in os.environ
)
MODEL = os.environ.get("LOCAL_STT_MODEL", DEFAULT_MODEL)
LEGACY_MLX_REPO = os.environ.get("LOCAL_STT_MLX_REPO")
STT_LANG = os.environ.get("LOCAL_STT_LANG", "ko")
STT_VAD = os.environ.get("LOCAL_STT_VAD", "1") != "0"
FAKE = os.environ.get("FAKE_WHISPER") == "1"
DATA_ROOT = Path(
    os.environ.get(
        "AI_NOTE_DATA_ROOT",
        str(Path(__file__).resolve().parent.parent / "data"),
    )
).absolute()
MEETINGS_ROOT = DATA_ROOT / "meetings"

MAX_JSON_BYTES = 4 * 1024
MAX_CLAIM_BYTES = 16 * 1024
CLAIM_BASENAME = ".whisper-dispatch.json"
SAFE_MEETING_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
JSON_CONTENT_TYPE = re.compile(
    r"^application/json(?:\s*;\s*charset\s*=\s*utf-8)?$",
    re.IGNORECASE,
)
CLAIM_PHASES = {"accepted", "segments_published", "raw_published"}
CLAIM_DURABILITIES = {"pending", "durable", "best_effort"}

FFMPEG_CANDIDATES = (
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
)

FAKE_SEGMENTS = [
    {"start": 0.0, "end": 2.4, "text": "안녕하세요, 오늘 회의를 시작하겠습니다."},
    {"start": 2.4, "end": 6.1, "text": "오늘 안건은 파일럿 온보딩 일정 확인입니다."},
    {"start": 6.1, "end": 9.7, "text": "액션 아이템은 다음 스프린트에 정리하겠습니다."},
]

_jobs: dict[tuple[str, str], dict[str, Any]] = {}
_jobs_lock = threading.Lock()
_meeting_locks: dict[str, threading.Lock] = {}
_meeting_locks_guard = threading.Lock()
_model_execution_fence = threading.Lock()
_model_preparation_lock = threading.Lock()
_model_preparation: dict[str, str] = {
    model: "idle" for model in MODEL_CATALOG
}
_directory_sync_capability = "unknown"
_directory_sync_guard = threading.Lock()
_test_pending_consumed = False


class ProtocolError(Exception):
    def __init__(self, code: str, status_code: int = 400):
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def ffmpeg_path() -> str | None:
    configured = os.environ.get("FFMPEG_PATH")
    if configured and Path(configured).exists():
        return configured
    found = shutil.which("ffmpeg")
    if found:
        return found
    return next((candidate for candidate in FFMPEG_CANDIDATES if Path(candidate).exists()), None)


def health() -> dict[str, Any]:
    with _model_preparation_lock:
        preparation = [
            {"model": model, "status": _model_preparation[model]}
            for model in MODEL_CATALOG
        ]
    if FAKE:
        return {
            "ok": True,
            "model": "fake",
            "ready": True,
            "modelPreparation": preparation,
        }
    ready = ffmpeg_path() is not None
    try:
        current_model = effective_model_snapshot(
            DATA_ROOT,
            MODEL,
            LEGACY_MLX_REPO,
            LEGACY_MODEL_CONFIGURED,
        )["id"]
    except ModelCatalogError:
        current_model = DEFAULT_MODEL
    payload: dict[str, Any] = {
        "ok": True,
        "model": current_model,
        "ready": ready,
        "modelPreparation": preparation,
    }
    if not ready:
        payload["message"] = "ffmpeg not found; install ffmpeg before transcribing"
    return payload


def _transcribe_real(
    audio_path: str, model_snapshot: dict[str, str]
) -> list[dict[str, Any]]:
    lang = None if STT_LANG == "auto" else STT_LANG
    try:
        import mlx_whisper  # type: ignore

        repo = model_snapshot["mlxRepo"]
        mlx_opts: dict[str, Any] = {"path_or_hf_repo": repo, "language": lang}
        if STT_VAD:
            mlx_opts.update(condition_on_previous_text=False, no_speech_threshold=0.6)
        try:
            result = mlx_whisper.transcribe(audio_path, **mlx_opts)
        except TypeError:
            result = mlx_whisper.transcribe(audio_path, path_or_hf_repo=repo, language=lang)
        return [
            {
                "start": float(segment["start"]),
                "end": float(segment["end"]),
                "text": (segment.get("text") or "").strip(),
            }
            for segment in result.get("segments", [])
        ]
    except ImportError:
        from faster_whisper import WhisperModel  # type: ignore

        model = WhisperModel(
            model_snapshot["fasterWhisperModel"],
            device="cpu",
            compute_type="int8",
        )
        options: dict[str, Any] = {"language": lang}
        if STT_VAD:
            options.update(vad_filter=True, condition_on_previous_text=False)
        segments, _info = model.transcribe(audio_path, **options)
        return [
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": (segment.text or "").strip(),
            }
            for segment in segments
        ]


def _transcribe_unlocked(
    audio_path: str, model_snapshot: dict[str, str]
) -> list[dict[str, Any]]:
    if FAKE:
        delay_ms = os.environ.get("WHISPER_TEST_MODEL_DELAY_MS")
        if delay_ms and delay_ms.isdigit():
            time.sleep(int(delay_ms) / 1000)
        if os.environ.get("WHISPER_TEST_FAIL_MODEL") == model_snapshot["id"]:
            raise RuntimeError(
                os.environ.get("WHISPER_TEST_PRIVATE_ERROR", "fake model failure")
            )
        return [dict(segment) for segment in FAKE_SEGMENTS]
    return _transcribe_real(audio_path, model_snapshot)


def transcribe(
    audio_path: str, model_snapshot: dict[str, str]
) -> list[dict[str, Any]]:
    with _model_execution_fence:
        return _transcribe_unlocked(audio_path, model_snapshot)


def _prepare_model_unlocked(model_snapshot: dict[str, str]) -> None:
    if FAKE:
        delay_ms = os.environ.get("WHISPER_TEST_MODEL_DELAY_MS")
        if delay_ms and delay_ms.isdigit():
            time.sleep(int(delay_ms) / 1000)
        if (
            os.environ.get("WHISPER_TEST_FAIL_PREPARE_MODEL")
            == model_snapshot["id"]
        ):
            raise RuntimeError(
                os.environ.get("WHISPER_TEST_PRIVATE_ERROR", "fake prepare failure")
            )
        return

    try:
        import mlx_whisper  # type: ignore  # noqa: F401
    except ImportError:
        from faster_whisper import WhisperModel  # type: ignore

        WhisperModel(
            model_snapshot["fasterWhisperModel"],
            device="cpu",
            compute_type="int8",
        )
        return

    repo = model_snapshot["mlxRepo"]
    if Path(repo).exists():
        return
    from huggingface_hub import snapshot_download  # type: ignore

    snapshot_download(repo_id=repo)


def _prepare_model(model_snapshot: dict[str, str]) -> None:
    with _model_execution_fence:
        _prepare_model_unlocked(model_snapshot)


def _prepare_model_worker(model: str) -> None:
    try:
        _prepare_model(snapshot_for_catalog_model(model))
    except Exception:
        status = "error"
    else:
        status = "ready"
    with _model_preparation_lock:
        _model_preparation[model] = status


def _start_model_prepare(model: str) -> str:
    snapshot_for_catalog_model(model)
    with _model_preparation_lock:
        current = _model_preparation[model]
        if current == "ready":
            return "ready"
        if current == "preparing":
            return "preparing"
        _model_preparation[model] = "preparing"
    thread = threading.Thread(
        target=_prepare_model_worker,
        args=(model,),
        daemon=True,
    )
    thread.start()
    return "preparing"


def _meeting_lock(meeting_id: str) -> threading.Lock:
    with _meeting_locks_guard:
        return _meeting_locks.setdefault(meeting_id, threading.Lock())


def _set_job(meeting_id: str, dispatch_id: str, **fields: Any) -> None:
    with _jobs_lock:
        _jobs.setdefault((meeting_id, dispatch_id), {}).update(fields)


def _get_job(meeting_id: str, dispatch_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        job = _jobs.get((meeting_id, dispatch_id))
        return dict(job) if job is not None else None


def _is_uuid(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        return False
    return str(parsed) == value.lower() and parsed.version in {1, 2, 3, 4, 5}


def _safe_regular_file(path: Path, required: bool = True) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        if required:
            raise ProtocolError("meeting_not_found", 404)
        return False
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ProtocolError("unsafe_record")
    return True


def _meeting_paths(meeting_id: str) -> dict[str, Path]:
    if not SAFE_MEETING_ID.fullmatch(meeting_id):
        raise ProtocolError("invalid_protocol")
    try:
        root_info = MEETINGS_ROOT.lstat()
        meeting_dir = MEETINGS_ROOT / meeting_id
        meeting_info = meeting_dir.lstat()
    except FileNotFoundError:
        raise ProtocolError("meeting_not_found", 404) from None
    if (
        stat.S_ISLNK(root_info.st_mode)
        or not stat.S_ISDIR(root_info.st_mode)
        or stat.S_ISLNK(meeting_info.st_mode)
        or not stat.S_ISDIR(meeting_info.st_mode)
    ):
        raise ProtocolError("unsafe_record")
    try:
        real_root = MEETINGS_ROOT.resolve(strict=True)
        real_meeting = meeting_dir.resolve(strict=True)
    except OSError:
        raise ProtocolError("unsafe_record") from None
    if real_meeting.parent != real_root:
        raise ProtocolError("unsafe_record")

    audio = meeting_dir / "audio.webm"
    _safe_regular_file(audio)
    paths = {
        "directory": meeting_dir,
        "audio": audio,
        "raw": meeting_dir / "raw.md",
        "segments": meeting_dir / "segments.json",
        "claim": meeting_dir / CLAIM_BASENAME,
    }
    for key in ("raw", "segments", "claim"):
        path = paths[key]
        try:
            if stat.S_ISLNK(path.lstat().st_mode):
                raise ProtocolError("unsafe_record")
        except FileNotFoundError:
            pass
    return paths


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    finally:
        os.close(fd)
    return digest.hexdigest()


def _sync_directory(path: Path) -> str:
    global _directory_sync_capability, _test_pending_consumed
    with _directory_sync_guard:
        test_mode = os.environ.get("WHISPER_TEST_DIRSYNC_MODE")
        if test_mode == "unsupported":
            _directory_sync_capability = "unsupported"
        if test_mode == "pending_once" and not _test_pending_consumed:
            _test_pending_consumed = True
            return "pending"
        if _directory_sync_capability == "unsupported":
            return "best_effort"
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        try:
            fd = os.open(path, flags)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError as error:
            if error.errno in {
                errno.EINVAL,
                errno.ENOSYS,
                getattr(errno, "ENOTSUP", -1),
                getattr(errno, "EOPNOTSUPP", -1),
            }:
                _directory_sync_capability = "unsupported"
                return "best_effort"
            return "pending"
        _directory_sync_capability = "supported"
        return "durable"


def _write_temp(parent: Path, data: bytes) -> Path:
    fd, raw_temp = tempfile.mkstemp(prefix=".whisper-", suffix=".tmp", dir=str(parent))
    temp = Path(raw_temp)
    try:
        os.chmod(temp, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        return temp
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def _durable_atomic_replace(path: Path, data: bytes) -> str:
    try:
        if stat.S_ISLNK(path.lstat().st_mode):
            raise ProtocolError("unsafe_record")
    except FileNotFoundError:
        pass
    temp = _write_temp(path.parent, data)
    try:
        os.replace(temp, path)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise
    return _sync_directory(path.parent)


def _durable_create_exclusive(path: Path, data: bytes) -> str:
    temp = _write_temp(path.parent, data)
    try:
        os.link(temp, path, follow_symlinks=False)
        temp.unlink()
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise
    return _sync_directory(path.parent)


def _read_bytes_no_follow(path: Path, max_bytes: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise ProtocolError("invalid_service_state", 409)
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(fd, min(64 * 1024, max_bytes + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ProtocolError("invalid_service_state", 409)
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def _claim_bytes(claim: dict[str, Any]) -> bytes:
    return (json.dumps(claim, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _validate_claim(value: object, expected_meeting_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolError("invalid_service_state", 409)
    schema_version = value.get("schemaVersion")
    v1_shapes = ({
        "schemaVersion",
        "meetingId",
        "dispatchId",
        "audioSha256",
        "phase",
        "durability",
    }, {
        # Phase-3 claims predate the explicit durability field. A successfully
        # visible old claim is treated as best-effort and rewritten on advance.
        "schemaVersion",
        "meetingId",
        "dispatchId",
        "audioSha256",
        "phase",
    })
    v2_shape = {
        "schemaVersion",
        "meetingId",
        "dispatchId",
        "audioSha256",
        "model",
        "phase",
        "durability",
    }
    if (
        (schema_version == 1 and set(value) not in v1_shapes)
        or (schema_version == 2 and set(value) != v2_shape)
        or schema_version not in {1, 2}
    ):
        raise ProtocolError("invalid_service_state", 409)
    if "durability" not in value:
        value = {**value, "durability": "best_effort"}
    if (
        value.get("meetingId") != expected_meeting_id
        or not _is_uuid(value.get("dispatchId"))
        or not isinstance(value.get("audioSha256"), str)
        or re.fullmatch(r"[a-f0-9]{64}", value["audioSha256"]) is None
        or value.get("phase") not in CLAIM_PHASES
        or value.get("durability") not in CLAIM_DURABILITIES
    ):
        raise ProtocolError("invalid_service_state", 409)
    if schema_version == 2:
        try:
            model = validate_model_snapshot(value.get("model"))
        except ModelCatalogError:
            raise ProtocolError("invalid_service_state", 409) from None
        value = {**value, "model": model}
    return value


def _read_claim(path: Path, meeting_id: str) -> dict[str, Any] | None:
    try:
        raw = _read_bytes_no_follow(path, MAX_CLAIM_BYTES)
    except FileNotFoundError:
        return None
    except OSError:
        raise ProtocolError("unsafe_record") from None
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ProtocolError("invalid_service_state", 409) from None
    return _validate_claim(value, meeting_id)


def _write_claim(path: Path, claim: dict[str, Any]) -> str:
    return _durable_atomic_replace(path, _claim_bytes(claim))


def _finish_claim_durability(
    path: Path, claim: dict[str, Any], durability: str
) -> tuple[dict[str, Any], str]:
    if durability == "pending":
        return claim, durability
    finalized = {**claim, "durability": durability}
    final_write = _write_claim(path, finalized)
    if final_write == "pending":
        return finalized, "pending"
    if durability == "best_effort" or final_write == "best_effort":
        return finalized, "best_effort"
    return finalized, "durable"


def _resume_claim_durability(path: Path, claim: dict[str, Any]) -> dict[str, Any]:
    if claim["durability"] != "pending":
        return claim
    namespace = _sync_directory(path.parent)
    if namespace == "pending":
        raise ProtocolError("durability_pending", 503)
    finalized, durability = _finish_claim_durability(path, claim, namespace)
    if durability == "pending":
        raise ProtocolError("durability_pending", 503)
    return finalized


def _advance_claim(path: Path, claim: dict[str, Any], phase: str) -> dict[str, Any]:
    pending_claim = {**claim, "phase": phase, "durability": "pending"}
    durability = _write_claim(path, pending_claim)
    finalized, confirmed = _finish_claim_durability(path, pending_claim, durability)
    if confirmed == "pending":
        raise ProtocolError("durability_pending", 503)
    return finalized


def _parse_segments(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(_read_bytes_no_follow(path, 64 * 1024 * 1024).decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise ProtocolError("invalid_service_state", 409) from None
    if not isinstance(value, list):
        raise ProtocolError("invalid_service_state", 409)
    segments: list[dict[str, Any]] = []
    for item in value:
        if (
            not isinstance(item, dict)
            or set(item) != {"start", "end", "text"}
            or not isinstance(item["start"], (int, float))
            or not isinstance(item["end"], (int, float))
            or not isinstance(item["text"], str)
        ):
            raise ProtocolError("invalid_service_state", 409)
        segments.append(
            {"start": float(item["start"]), "end": float(item["end"]), "text": item["text"]}
        )
    return segments


def _pending(durability: str) -> bool:
    return durability == "pending"


def _resume_job(meeting_id: str, dispatch_id: str) -> None:
    paths = _meeting_paths(meeting_id)
    claim = _read_claim(paths["claim"], meeting_id)
    if claim is None or claim["dispatchId"] != dispatch_id:
        raise ProtocolError("invalid_service_state", 409)
    if _sha256_file(paths["audio"]) != claim["audioSha256"]:
        raise ProtocolError("audio_identity_mismatch", 409)

    claim = _resume_claim_durability(paths["claim"], claim)
    try:
        model_snapshot = (
            claim["model"]
            if claim["schemaVersion"] == 2
            else legacy_model_snapshot(MODEL, LEGACY_MLX_REPO)
        )
    except ModelCatalogError:
        raise ProtocolError("invalid_service_state", 409) from None

    if _pending(_sync_directory(paths["directory"])):
        raise ProtocolError("durability_pending", 503)

    segments: list[dict[str, Any]]
    if paths["segments"].exists():
        _safe_regular_file(paths["segments"])
        segments = _parse_segments(paths["segments"])
    else:
        segments = transcribe(str(paths["audio"]), model_snapshot)
        encoded_segments = (
            json.dumps(segments, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        if _pending(_durable_atomic_replace(paths["segments"], encoded_segments)):
            raise ProtocolError("durability_pending", 503)

    if claim["phase"] == "accepted":
        claim = _advance_claim(paths["claim"], claim, "segments_published")

    raw_bytes = (
        "\n".join(segment["text"] for segment in segments if segment["text"]) + "\n"
    ).encode("utf-8")
    if paths["raw"].exists():
        _safe_regular_file(paths["raw"])
        if _read_bytes_no_follow(paths["raw"], 256 * 1024 * 1024) != raw_bytes:
            raise ProtocolError("invalid_service_state", 409)
    else:
        if _pending(_durable_atomic_replace(paths["raw"], raw_bytes)):
            raise ProtocolError("durability_pending", 503)

    if claim["phase"] != "raw_published":
        claim = _advance_claim(paths["claim"], claim, "raw_published")


def run_job(meeting_id: str, dispatch_id: str) -> None:
    with _meeting_lock(meeting_id):
        try:
            _resume_job(meeting_id, dispatch_id)
            _set_job(meeting_id, dispatch_id, status="done", progress=1.0)
        except ProtocolError as error:
            safe_error = "durability_pending" if error.code == "durability_pending" else "transcription_failed"
            _set_job(meeting_id, dispatch_id, status="error", progress=0.0, error=safe_error)
        except Exception:
            _set_job(
                meeting_id,
                dispatch_id,
                status="error",
                progress=0.0,
                error="transcription_failed",
            )


def _no_duplicate_object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "AI-NOTE-STT"
    sys_version = ""

    def _validate_ingress(self) -> bool:
        host_values = self.headers.get_all("Host") or []
        actual_port = int(self.server.server_address[1])
        expected_host = f"{HOST}:{actual_port}"
        if len(host_values) != 1 or host_values[0] != expected_host:
            self._send_error(403, "invalid_host")
            return False
        has_fetch_metadata = any(
            name.lower().startswith("sec-fetch-") for name in self.headers.keys()
        )
        service_marker = self.headers.get("X-AI-Note-Service") == "app-api-v1"
        if self.headers.get("Origin") is not None or (has_fetch_metadata and not service_marker):
            self._send_error(403, "browser_request_rejected")
            return False
        return True

    def do_GET(self) -> None:
        if not self._validate_ingress():
            return
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            self._send_error(404, "not_found")
            return
        if parsed.path == "/health":
            self._send_json(200, health())
            return
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "jobs":
            meeting_id, dispatch_id = parts[1], parts[2]
            if not SAFE_MEETING_ID.fullmatch(meeting_id) or not _is_uuid(dispatch_id):
                self._send_error(400, "invalid_protocol")
                return
            try:
                paths = _meeting_paths(meeting_id)
                claim = _read_claim(paths["claim"], meeting_id)
                if claim is None:
                    if paths["raw"].exists():
                        self._send_json(200, {"status": "done", "progress": 1.0})
                    else:
                        self._send_error(404, "job_not_found")
                    return
                if claim["dispatchId"] != dispatch_id:
                    self._send_error(404, "job_not_found")
                    return
                job = _get_job(meeting_id, dispatch_id)
                if job is not None:
                    self._send_json(200, job)
                    return
                if (
                    claim["phase"] == "raw_published"
                    and claim["durability"] != "pending"
                    and paths["raw"].exists()
                    and paths["segments"].exists()
                ):
                    self._send_json(
                        200,
                        {
                            "status": "done",
                            "progress": 1.0,
                            "durability": claim["durability"],
                        },
                    )
                    return
                progress = 0.5 if claim["phase"] == "segments_published" else 0.0
                self._send_json(200, {"status": "processing", "progress": progress})
            except ProtocolError as error:
                self._send_error(error.status_code, error.code)
            return
        self._send_error(404, "not_found")

    def do_POST(self) -> None:
        if not self._validate_ingress():
            return
        parsed = urlsplit(self.path)
        if (
            parsed.query
            or parsed.fragment
            or parsed.path not in {"/transcribe", "/models/prepare"}
        ):
            self._send_error(404, "not_found")
            return
        if self.headers.get("Transfer-Encoding") is not None:
            self._send_error(400, "invalid_content_length")
            return
        content_types = self.headers.get_all("Content-Type") or []
        if len(content_types) != 1 or JSON_CONTENT_TYPE.fullmatch(content_types[0]) is None:
            self._send_error(415, "unsupported_media_type")
            return
        lengths = self.headers.get_all("Content-Length") or []
        if len(lengths) != 1 or re.fullmatch(r"(?:0|[1-9][0-9]*)", lengths[0]) is None:
            self._send_error(400, "invalid_content_length")
            return
        length = int(lengths[0])
        if length > MAX_JSON_BYTES:
            self._send_error(413, "request_body_too_large")
            return
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("short read")
            body = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicate_object_pairs)
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self._send_error(400, "invalid_json")
            return

        if parsed.path == "/models/prepare":
            if not isinstance(body, dict) or set(body) != {"model"}:
                self._send_error(400, "invalid_protocol")
                return
            model = body.get("model")
            try:
                status = _start_model_prepare(model)
            except ModelCatalogError:
                self._send_error(400, "invalid_protocol")
                return
            self._send_json(
                200 if status == "ready" else 202,
                {"model": model, "status": status},
            )
            return

        if not isinstance(body, dict) or set(body) != {"meetingId", "dispatchId"}:
            self._send_error(400, "invalid_protocol")
            return
        meeting_id = body.get("meetingId")
        proposed_dispatch_id = body.get("dispatchId")
        if (
            not isinstance(meeting_id, str)
            or not SAFE_MEETING_ID.fullmatch(meeting_id)
            or not _is_uuid(proposed_dispatch_id)
        ):
            self._send_error(400, "invalid_protocol")
            return

        with _meeting_lock(meeting_id):
            try:
                paths = _meeting_paths(meeting_id)
                claim = _read_claim(paths["claim"], meeting_id)
                if claim is None and paths["raw"].exists():
                    _safe_regular_file(paths["raw"])
                    self._send_json(
                        200,
                        {
                            "dispatchId": proposed_dispatch_id,
                            "status": "done",
                            "legacy": True,
                        },
                    )
                    return

                audio_sha256 = _sha256_file(paths["audio"])
                if claim is None:
                    try:
                        model_snapshot = effective_model_snapshot(
                            DATA_ROOT,
                            MODEL,
                            LEGACY_MLX_REPO,
                            LEGACY_MODEL_CONFIGURED,
                        )
                    except ModelCatalogError:
                        raise ProtocolError("invalid_service_state", 409) from None
                    claim = {
                        "schemaVersion": 2,
                        "meetingId": meeting_id,
                        "dispatchId": proposed_dispatch_id,
                        "audioSha256": audio_sha256,
                        "model": model_snapshot,
                        "phase": "accepted",
                        "durability": "pending",
                    }
                    try:
                        durability = _durable_create_exclusive(paths["claim"], _claim_bytes(claim))
                    except FileExistsError:
                        claim = _read_claim(paths["claim"], meeting_id)
                        if claim is None:
                            raise ProtocolError("invalid_service_state", 409) from None
                    else:
                        claim, durability = _finish_claim_durability(
                            paths["claim"], claim, durability
                        )
                        if _pending(durability):
                            _set_job(
                                meeting_id,
                                proposed_dispatch_id,
                                status="error",
                                progress=0.0,
                                error="durability_pending",
                            )
                            self._send_error(503, "durability_pending")
                            return

                claim = _resume_claim_durability(paths["claim"], claim)

                if claim["audioSha256"] != audio_sha256:
                    self._send_error(409, "audio_identity_mismatch")
                    return
                canonical_dispatch_id = claim["dispatchId"]
                if proposed_dispatch_id != canonical_dispatch_id:
                    self._send_json(
                        409,
                        {
                            "error": {"code": "adopt_existing_dispatch"},
                            "dispatchId": canonical_dispatch_id,
                        },
                    )
                    return
                if _pending(_sync_directory(paths["directory"])):
                    self._send_error(503, "durability_pending")
                    return
                if (
                    claim["phase"] == "raw_published"
                    and claim["durability"] != "pending"
                    and paths["raw"].exists()
                    and paths["segments"].exists()
                ):
                    _set_job(meeting_id, canonical_dispatch_id, status="done", progress=1.0)
                    self._send_json(
                        200,
                        {
                            "dispatchId": canonical_dispatch_id,
                            "status": "done",
                            "durability": claim["durability"],
                        },
                    )
                    return

                job = _get_job(meeting_id, canonical_dispatch_id)
                if job is None or job.get("status") != "processing":
                    _set_job(meeting_id, canonical_dispatch_id, status="processing", progress=0.0)
                    thread = threading.Thread(
                        target=run_job,
                        args=(meeting_id, canonical_dispatch_id),
                        daemon=True,
                    )
                    thread.start()
                self._send_json(
                    202,
                    {
                        "dispatchId": canonical_dispatch_id,
                        "status": "accepted",
                        "durability": claim["durability"],
                    },
                )
            except ProtocolError as error:
                self._send_error(error.status_code, error.code)
            except OSError:
                self._send_error(500, "service_io")

    def _send_error(self, status_code: int, code: str) -> None:
        self._send_json(status_code, {"error": {"code": code}})

    def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args: object) -> None:
        pass


class LocalThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True


def main() -> None:
    if HOST not in {"127.0.0.1", "localhost"}:
        raise SystemExit("LOCAL_STT_HOST must be loopback")
    if PORT < 0 or PORT > 65535:
        raise SystemExit("LOCAL_STT_PORT is invalid")
    server = LocalThreadingHTTPServer((HOST, PORT), Handler)
    host, port = server.server_address[:2]
    print(f"WHISPER_LISTENING http://{host}:{port}", flush=True)
    print(
        f"[whisper] fake={FAKE} model={MODEL} ffmpeg_ready={ffmpeg_path() is not None}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
