"""Validation settings shared by synchronous OCR uploads."""

from __future__ import annotations

import os


DEFAULT_ALLOWED_MIME_TYPES = frozenset(
    {
        "application/pdf",
        "image/jpeg",
        "image/png",
    }
)
DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
ALLOWED_MIME_TYPES_ENV = "RECOGNITION_ALLOWED_MIME_TYPES"
MAX_FILE_BYTES_ENV = "RECOGNITION_MAX_FILE_BYTES"


def allowed_mime_types() -> set[str]:
    configured = os.environ.get(ALLOWED_MIME_TYPES_ENV, "")
    if not configured.strip():
        return set(DEFAULT_ALLOWED_MIME_TYPES)
    return {item.strip() for item in configured.split(",") if item.strip()}


def max_file_bytes() -> int:
    configured = os.environ.get(MAX_FILE_BYTES_ENV, "")
    if not configured.strip():
        return DEFAULT_MAX_FILE_BYTES
    try:
        value = int(configured)
    except ValueError as error:
        raise ValueError(f"{MAX_FILE_BYTES_ENV} must be an integer") from error
    if value <= 0:
        raise ValueError(f"{MAX_FILE_BYTES_ENV} must be greater than zero")
    return value
