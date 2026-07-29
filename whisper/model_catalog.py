from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any


MODEL_CATALOG: dict[str, dict[str, str]] = {
    "large-v3": {
        "source": "catalog",
        "id": "large-v3",
        "mlxRepo": "mlx-community/whisper-large-v3-mlx",
        "fasterWhisperModel": "large-v3",
    },
    "large-v3-turbo": {
        "source": "catalog",
        "id": "large-v3-turbo",
        "mlxRepo": "mlx-community/whisper-large-v3-turbo",
        "fasterWhisperModel": "large-v3-turbo",
    },
}
DEFAULT_MODEL = "large-v3"
PIPELINE_SETTINGS_BASENAME = "pipeline-settings.json"
MAX_PIPELINE_SETTINGS_BYTES = 16 * 1024


class ModelCatalogError(Exception):
    pass


def _safe_identity(value: object, max_length: int = 512) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= max_length
        and "\x00" not in value
        and "\r" not in value
        and "\n" not in value
    )


def snapshot_for_catalog_model(model: object) -> dict[str, str]:
    if not isinstance(model, str):
        raise ModelCatalogError("unknown_model")
    try:
        return dict(MODEL_CATALOG[model])
    except KeyError:
        raise ModelCatalogError("unknown_model") from None


def legacy_model_snapshot(model: str, mlx_repo: str | None) -> dict[str, str]:
    if not _safe_identity(model, 128):
        raise ModelCatalogError("invalid_legacy_model")
    resolved_repo = mlx_repo or f"mlx-community/whisper-{model}-mlx"
    if not _safe_identity(resolved_repo):
        raise ModelCatalogError("invalid_legacy_model")
    return {
        "source": "legacy",
        "id": model,
        "mlxRepo": resolved_repo,
        "fasterWhisperModel": model,
    }


def validate_model_snapshot(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {
        "source",
        "id",
        "mlxRepo",
        "fasterWhisperModel",
    }:
        raise ModelCatalogError("invalid_model_snapshot")
    if value.get("source") == "catalog":
        expected = snapshot_for_catalog_model(value.get("id"))
        if value != expected:
            raise ModelCatalogError("invalid_model_snapshot")
        return expected
    if value.get("source") != "legacy":
        raise ModelCatalogError("invalid_model_snapshot")
    for key, max_length in (
        ("id", 128),
        ("mlxRepo", 512),
        ("fasterWhisperModel", 128),
    ):
        if not _safe_identity(value.get(key), max_length):
            raise ModelCatalogError("invalid_model_snapshot")
    if value["id"] != value["fasterWhisperModel"]:
        raise ModelCatalogError("invalid_model_snapshot")
    return {
        "source": "legacy",
        "id": value["id"],
        "mlxRepo": value["mlxRepo"],
        "fasterWhisperModel": value["fasterWhisperModel"],
    }


def _no_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ModelCatalogError("invalid_pipeline_settings")
        value[key] = item
    return value


def _read_bounded_no_follow(path: Path) -> bytes | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ModelCatalogError("invalid_pipeline_settings")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        raise ModelCatalogError("invalid_pipeline_settings") from None
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_PIPELINE_SETTINGS_BYTES:
            raise ModelCatalogError("invalid_pipeline_settings")
        data = os.read(fd, MAX_PIPELINE_SETTINGS_BYTES + 1)
        if len(data) > MAX_PIPELINE_SETTINGS_BYTES:
            raise ModelCatalogError("invalid_pipeline_settings")
        return data
    finally:
        os.close(fd)


def read_stored_pipeline_model(data_root: Path) -> str | None:
    raw = _read_bounded_no_follow(data_root / PIPELINE_SETTINGS_BASENAME)
    if raw is None:
        return None
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicate_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ModelCatalogError):
        raise ModelCatalogError("invalid_pipeline_settings") from None
    if (
        not isinstance(value, dict)
        or set(value) != {"schemaVersion", "transcription", "correction"}
        or value.get("schemaVersion") != 1
    ):
        raise ModelCatalogError("invalid_pipeline_settings")
    transcription = value.get("transcription")
    correction = value.get("correction")
    if (
        not isinstance(transcription, dict)
        or set(transcription) != {"model"}
        or transcription.get("model") not in MODEL_CATALOG
        or not isinstance(correction, dict)
        or set(correction) != {"mode"}
        or correction.get("mode") not in {"full", "fast"}
    ):
        raise ModelCatalogError("invalid_pipeline_settings")
    return transcription["model"]


def effective_model_snapshot(
    data_root: Path,
    legacy_model: str,
    legacy_mlx_repo: str | None,
    legacy_configured: bool = False,
) -> dict[str, str]:
    stored = read_stored_pipeline_model(data_root)
    if stored is not None:
        return snapshot_for_catalog_model(stored)
    if legacy_configured:
        return legacy_model_snapshot(legacy_model, legacy_mlx_repo)
    return snapshot_for_catalog_model(DEFAULT_MODEL)
