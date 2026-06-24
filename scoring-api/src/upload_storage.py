"""Durable storage for directly uploaded scoring sheets."""

from __future__ import annotations

import io
import os
import re
from typing import Any

import google.auth
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

from src.upload_recognition import decode_upload_file
from src.wire import ApiError


SCOPES = ["https://www.googleapis.com/auth/drive.file"]
UPLOAD_FOLDER_ENV = "SCORING_UPLOAD_DRIVE_FOLDER_ID"


def save_upload_file(file_payload: Any, candidate_id: str) -> dict[str, str]:
    if not isinstance(file_payload, dict):
        raise ApiError("validation", "file must be an object")

    upload = decode_upload_file(file_payload)
    name = _stored_filename(candidate_id, upload["name"], upload["mime_type"])
    media = MediaIoBaseUpload(io.BytesIO(upload["bytes"]), mimetype=upload["mime_type"], resumable=False)
    body: dict[str, Any] = {"name": name, "mimeType": upload["mime_type"]}
    folder_id = os.environ.get(UPLOAD_FOLDER_ENV, "").strip()
    if not folder_id:
        raise ApiError("validation", f"{UPLOAD_FOLDER_ENV} is required for direct upload storage")
    body["parents"] = [folder_id]

    try:
        created = (
            _service()
            .files()
            .create(body=body, media_body=media, fields="id,webViewLink", supportsAllDrives=True)
            .execute()
        )
    except Exception as error:
        raise ApiError("upstream", f"Upload file storage failed: {error}") from error

    file_id = str(created.get("id") or "").strip()
    if not file_id:
        raise ApiError("upstream", "Upload file storage did not return a file id")

    return {
        "sourceUrl": str(created.get("webViewLink") or f"https://drive.google.com/file/d/{file_id}/view"),
        "mimeType": upload["mime_type"],
    }


def _service():
    credentials, _ = google.auth.default(scopes=SCOPES)
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def _stored_filename(candidate_id: str, original_name: str, mime_type: str) -> str:
    safe_candidate = re.sub(r"[^A-Za-z0-9_-]+", "-", candidate_id).strip("-") or "candidate"
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", original_name).strip(".-")
    if not safe_name:
        safe_name = f"scoresheet{_extension_for_mime_type(mime_type)}"
    return f"{safe_candidate}_{safe_name}"


def _extension_for_mime_type(mime_type: str) -> str:
    return {
        "application/pdf": ".pdf",
        "image/jpeg": ".jpg",
        "image/png": ".png",
    }.get(mime_type, "")
