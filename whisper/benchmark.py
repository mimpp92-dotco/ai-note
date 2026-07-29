from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from model_catalog import ModelCatalogError, snapshot_for_catalog_model


class BenchmarkError(Exception):
    pass


def _safe_regular_file(path: Path) -> None:
    try:
        info = path.lstat()
    except OSError:
        raise BenchmarkError("invalid_audio") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise BenchmarkError("invalid_audio")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_write(path: Path, data: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".benchmark-",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def _output_directory(output: Path, allowed_root: Path) -> Path:
    allowed_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(allowed_root, 0o700)
    resolved_root = allowed_root.resolve(strict=True)
    resolved_output = output.resolve(strict=False)
    try:
        resolved_output.relative_to(resolved_root)
    except ValueError:
        raise BenchmarkError("invalid_output_fence") from None
    if resolved_output == resolved_root:
        raise BenchmarkError("invalid_output_fence")
    try:
        resolved_output.mkdir(mode=0o700, parents=False, exist_ok=False)
    except OSError:
        raise BenchmarkError("invalid_output_directory") from None
    os.chmod(resolved_output, 0o700)
    return resolved_output


def _fake_segments() -> list[dict[str, Any]]:
    return [
        {
            "start": 0.0,
            "end": 1.0,
            "text": "합성 벤치마크 전사 결과입니다.",
        }
    ]


def _real_segments(
    audio_path: Path,
    model_snapshot: dict[str, str],
) -> list[dict[str, Any]]:
    import server

    return server._transcribe_real(str(audio_path), model_snapshot)


def run_benchmark(
    *,
    audio_path: Path,
    output_dir: Path,
    allowed_root: Path,
    model: str,
    fake: bool,
) -> dict[str, Any]:
    _safe_regular_file(audio_path)
    try:
        model_snapshot = snapshot_for_catalog_model(model)
    except ModelCatalogError:
        raise BenchmarkError("invalid_model") from None
    output = _output_directory(output_dir, allowed_root)

    started = time.monotonic()
    segments = _fake_segments() if fake else _real_segments(
        audio_path,
        model_snapshot,
    )
    wall_time_ms = max(0, round((time.monotonic() - started) * 1000))
    normalized = [
        {
            "start": float(segment["start"]),
            "end": float(segment["end"]),
            "text": str(segment.get("text") or "").strip(),
        }
        for segment in segments
    ]
    segments_bytes = (
        json.dumps(normalized, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    raw_bytes = (
        "\n".join(segment["text"] for segment in normalized if segment["text"])
        + "\n"
    ).encode("utf-8")
    metrics = {
        "schemaVersion": 1,
        "model": model_snapshot["id"],
        "modelIdentity": model_snapshot,
        "wallTimeMs": wall_time_ms,
        "rawSha256": _sha256(raw_bytes),
        "segmentsSha256": _sha256(segments_bytes),
    }
    _atomic_write(output / "segments.json", segments_bytes)
    _atomic_write(output / "raw.md", raw_bytes)
    _atomic_write(
        output / "metrics.json",
        (json.dumps(metrics, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )
    return {
        "status": "completed",
        "model": model_snapshot["id"],
        "wallTimeMs": wall_time_ms,
    }


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--allowed-root", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--fake", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parse_args(sys.argv[1:] if argv is None else argv)
        result = run_benchmark(
            audio_path=Path(args.audio).absolute(),
            output_dir=Path(args.output_dir).absolute(),
            allowed_root=Path(args.allowed_root).absolute(),
            model=args.model,
            fake=bool(args.fake),
        )
    except (BenchmarkError, OSError, ValueError, KeyError, TypeError):
        print("benchmark_failed", file=sys.stderr, flush=True)
        return 1
    print(json.dumps(result, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
