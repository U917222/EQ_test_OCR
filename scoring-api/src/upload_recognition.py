"""Direct upload recognition for the scoring API."""

from __future__ import annotations

import base64
import re
from typing import Any

from src.scoresheet_recognizer import failed_scoresheet_result, recognize_scoresheet
from src.wire import ApiError


MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# レビュー切り抜きを data-URI で imageLinks に載せる際の上限 (base64後の文字数)。
# 超過分は落とす (degrade) ことで巨大ペイロードを防ぐ。
MAX_REVIEW_DATA_URI_BASE64_CHARS = 30000
ALLOWED_UPLOAD_MIME_TYPES = {
    "application/pdf",
    "image/jpeg",
    "image/png",
}
MIME_BY_EXTENSION = {
    "pdf": "application/pdf",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
}


def review_images_to_data_uris(images: dict[str, bytes]) -> dict[str, str]:
    """要確認セルのPNG切り抜き(bytes)を per-cell の data-URI 文字列に変換する。

    空 bytes と、base64化後に上限を超えるものは落とす (degrade)。
    """
    data_uris: dict[str, str] = {}
    for key, png_bytes in images.items():
        if not png_bytes:
            continue
        encoded = base64.b64encode(png_bytes).decode("ascii")
        if len(encoded) > MAX_REVIEW_DATA_URI_BASE64_CHARS:
            continue
        data_uris[key] = f"data:image/png;base64,{encoded}"
    return data_uris


def recognize_upload_file(file_payload: Any) -> dict[str, Any] | None:
    if not file_payload:
        return None
    if not isinstance(file_payload, dict):
        raise ApiError("validation", "file must be an object")

    upload = decode_upload_file(file_payload)
    try:
        result = recognize_scoresheet(upload["bytes"], upload["mime_type"], None)
    except Exception as error:
        result = failed_scoresheet_result("recognition_failed", str(error))
    return result.to_recognition_payload(review_images_to_data_uris(result.review_images))


def decode_upload_file(file_payload: dict[str, Any]) -> dict[str, Any]:
    name = str(file_payload.get("name") or "").strip()
    mime_type = _normalize_mime_type(file_payload.get("mimeType") or file_payload.get("contentType"), name)
    raw_base64 = str(file_payload.get("base64") or "").strip()
    if not raw_base64:
        raise ApiError("validation", "file.base64 is required")
    normalized_base64 = re.sub(r"\s+", "", raw_base64)
    if len(normalized_base64) % 4 == 1 or not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", normalized_base64):
        raise ApiError("validation", "file.base64 is invalid")
    if _estimated_decoded_bytes(normalized_base64) > MAX_UPLOAD_BYTES:
        raise ApiError("validation", f"Upload exceeds {MAX_UPLOAD_BYTES} bytes")
    try:
        content = base64.b64decode(normalized_base64, validate=True)
    except Exception as error:
        raise ApiError("validation", "file.base64 is invalid") from error
    if not content:
        raise ApiError("validation", "file is empty")
    if len(content) > MAX_UPLOAD_BYTES:
        raise ApiError("validation", f"Upload exceeds {MAX_UPLOAD_BYTES} bytes")
    return {"name": name, "mime_type": mime_type, "bytes": content}


def _normalize_mime_type(raw_mime_type: Any, name: str) -> str:
    mime_type = str(raw_mime_type or "").split(";")[0].strip().lower()
    if mime_type in ALLOWED_UPLOAD_MIME_TYPES:
        return mime_type
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if extension in MIME_BY_EXTENSION:
        return MIME_BY_EXTENSION[extension]
    raise ApiError("validation", f"Unsupported upload MIME type: {raw_mime_type or ''}")


def _estimated_decoded_bytes(value: str) -> int:
    padding = 2 if value.endswith("==") else 1 if value.endswith("=") else 0
    return (len(value) * 3) // 4 - padding
