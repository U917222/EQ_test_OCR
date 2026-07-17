"""Durable storage for directly uploaded scoring sheets."""

from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import uuid
from typing import Any
from urllib.parse import unquote, urlsplit

import boto3
import google.auth
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

from src.upload_recognition import decode_upload_file
from src.wire import ApiError


LOGGER = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/drive.file"]
UPLOAD_FOLDER_ENV = "SCORING_UPLOAD_DRIVE_FOLDER_ID"
UPLOAD_BACKEND_ENV = "SCORING_UPLOAD_BACKEND"
R2_ACCOUNT_ID_ENV = "R2_ACCOUNT_ID"
R2_BUCKET_NAME_ENV = "R2_BUCKET_NAME"
R2_ACCESS_KEY_ID_ENV = "R2_ACCESS_KEY_ID"
R2_SECRET_ACCESS_KEY_ENV = "R2_SECRET_ACCESS_KEY"
R2_ENDPOINT_ENV = "R2_ENDPOINT"
R2_SOURCE_PREFIX = "/files/r2"
R2_CANDIDATE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
R2_FILE_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
R2_FILENAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,255}$")


def save_upload_file(file_payload: Any, candidate_id: str) -> dict[str, str]:
    if not isinstance(file_payload, dict):
        raise ApiError("validation", "file must be an object")

    upload = decode_upload_file(file_payload)
    backend = os.environ.get(UPLOAD_BACKEND_ENV, "drive").strip().lower() or "drive"
    if backend == "r2":
        return _save_r2_upload(upload, candidate_id)
    if backend != "drive":
        raise ApiError("validation", f"{UPLOAD_BACKEND_ENV} must be drive or r2")
    return _save_drive_upload(upload, candidate_id)


def delete_upload_file(source_url: str) -> bool:
    """Delete an R2 object referenced by a URL issued by this service.

    Existing Google Drive links and malformed/external URLs are intentionally
    ignored so legacy uploads remain untouched during the migration.
    """
    key = _r2_key_from_source_url(source_url)
    if not key:
        return False
    config = _r2_config()
    try:
        _r2_client().delete_object(Bucket=config["bucket"], Key=key)
    except Exception as error:
        raise ApiError("upstream", f"Upload file cleanup failed: {error}") from error
    return True


def delete_candidate_scoresheet_uploads(candidate_id: str) -> dict[str, int]:
    """Best-effort delete scoring-sheet objects for one candidate.

    Only the strict ``candidates/{candidateId}/{uuid}/{filename}`` shape is
    eligible. Reference documents under ``documents/`` and every other
    candidate prefix are ignored even if R2 returns an unexpected list item.
    """
    safe_candidate_id = str(candidate_id or "").strip()
    if not R2_CANDIDATE_PATTERN.fullmatch(safe_candidate_id):
        raise ApiError("validation", "candidateId is invalid for R2 upload cleanup")
    config = _r2_config()
    client = _r2_client()
    try:
        summaries = _list_candidate_upload_objects(
            client,
            config["bucket"],
            safe_candidate_id,
        )
    except ApiError:
        raise
    except Exception as error:
        raise ApiError("upstream", f"Candidate upload listing failed: {error}") from error

    deleted = 0
    failed = 0
    for summary in summaries:
        key = str(summary.get("Key") or "")
        if not _candidate_scoresheet_key(key, safe_candidate_id):
            continue
        try:
            client.delete_object(Bucket=config["bucket"], Key=key)
            deleted += 1
        except Exception as error:
            failed += 1
            LOGGER.warning(
                "Failed to clean up candidate scoring-sheet upload",
                extra={
                    "candidate_id": safe_candidate_id,
                    "key": key,
                    "cleanup_error": str(error),
                },
            )
    return {"deleted": deleted, "failed": failed}


def _save_drive_upload(upload: dict[str, Any], candidate_id: str) -> dict[str, str]:
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


def _save_r2_upload(upload: dict[str, Any], candidate_id: str) -> dict[str, str]:
    config = _r2_config()
    safe_candidate = _safe_candidate_id(candidate_id)
    file_id = str(uuid.uuid4())
    filename = _stored_filename(safe_candidate, upload["name"], upload["mime_type"])
    key = f"candidates/{safe_candidate}/{file_id}/{filename}"
    checksum = hashlib.sha256(upload["bytes"]).hexdigest()
    try:
        _r2_client().put_object(
            Bucket=config["bucket"],
            Key=key,
            Body=upload["bytes"],
            ContentType=upload["mime_type"],
            Metadata={
                "candidate-id": safe_candidate,
                "file-id": file_id,
                "checksum-sha256": checksum,
            },
            StorageClass="STANDARD",
        )
    except Exception as error:
        raise ApiError("upstream", f"Upload file storage failed: {error}") from error

    return {
        "sourceUrl": f"{R2_SOURCE_PREFIX}/{safe_candidate}/{file_id}/{filename}",
        "mimeType": upload["mime_type"],
    }


def _r2_config() -> dict[str, str]:
    names = (
        R2_ACCOUNT_ID_ENV,
        R2_BUCKET_NAME_ENV,
        R2_ACCESS_KEY_ID_ENV,
        R2_SECRET_ACCESS_KEY_ENV,
    )
    values = {name: os.environ.get(name, "").strip() for name in names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise ApiError("validation", f"{', '.join(missing)} required for R2 upload storage")
    endpoint = os.environ.get(R2_ENDPOINT_ENV, "").strip()
    return {
        "account_id": values[R2_ACCOUNT_ID_ENV],
        "bucket": values[R2_BUCKET_NAME_ENV],
        "access_key_id": values[R2_ACCESS_KEY_ID_ENV],
        "secret_access_key": values[R2_SECRET_ACCESS_KEY_ENV],
        "endpoint": endpoint or f"https://{values[R2_ACCOUNT_ID_ENV]}.r2.cloudflarestorage.com",
    }


def _r2_client():
    config = _r2_config()
    return boto3.client(
        "s3",
        endpoint_url=config["endpoint"],
        aws_access_key_id=config["access_key_id"],
        aws_secret_access_key=config["secret_access_key"],
        region_name="auto",
    )


def _r2_key_from_source_url(source_url: str) -> str | None:
    parsed = urlsplit(str(source_url or "").strip())
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        return None
    raw_segments = parsed.path.split("/")
    if len(raw_segments) != 6 or raw_segments[:3] != ["", "files", "r2"]:
        return None
    try:
        candidate_id, file_id, filename = (unquote(segment) for segment in raw_segments[3:])
    except Exception:
        return None
    if not _valid_r2_parts(candidate_id, file_id, filename):
        return None
    return f"candidates/{candidate_id}/{file_id}/{filename}"


def _list_candidate_upload_objects(
    client: Any,
    bucket: str,
    candidate_id: str,
) -> list[dict[str, Any]]:
    prefix = f"candidates/{candidate_id}/"
    continuation_token = ""
    objects: list[dict[str, Any]] = []
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if continuation_token:
            kwargs["ContinuationToken"] = continuation_token
        response = client.list_objects_v2(**kwargs)
        if not isinstance(response, dict):
            raise ApiError("upstream", "R2 upload listing returned an invalid response")
        contents = response.get("Contents")
        if isinstance(contents, list):
            objects.extend(item for item in contents if isinstance(item, dict))
        if not bool(response.get("IsTruncated")):
            return objects
        next_token = str(response.get("NextContinuationToken") or "")
        if not next_token or next_token == continuation_token:
            raise ApiError("upstream", "R2 upload listing returned an invalid continuation token")
        continuation_token = next_token


def _candidate_scoresheet_key(key: str, candidate_id: str) -> bool:
    segments = str(key or "").split("/")
    if len(segments) != 4:
        return False
    root, stored_candidate_id, file_id, filename = segments
    return bool(
        root == "candidates"
        and stored_candidate_id == candidate_id
        and _valid_r2_parts(stored_candidate_id, file_id, filename)
    )


def _valid_r2_parts(candidate_id: str, file_id: str, filename: str) -> bool:
    return bool(
        R2_CANDIDATE_PATTERN.fullmatch(candidate_id)
        and R2_FILE_ID_PATTERN.fullmatch(file_id)
        and R2_FILENAME_PATTERN.fullmatch(filename)
        and ".." not in filename
    )


def _service():
    credentials, _ = google.auth.default(scopes=SCOPES)
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def _stored_filename(candidate_id: str, original_name: str, mime_type: str) -> str:
    safe_candidate = _safe_candidate_id(candidate_id)
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", original_name).strip(".-")
    expected_extension = _extension_for_mime_type(mime_type)
    if not safe_name or safe_name.lower() == expected_extension.lstrip("."):
        safe_name = f"scoresheet{_extension_for_mime_type(mime_type)}"
    prefix = f"{safe_candidate}_"
    max_name_length = 255 - len(prefix)
    if len(safe_name) > max_name_length:
        extension = expected_extension if safe_name.lower().endswith(expected_extension) else ""
        stem = safe_name[: -len(extension)] if extension else safe_name
        stem = stem[: max_name_length - len(extension)].rstrip(".-") or "scoresheet"
        safe_name = f"{stem}{extension}"
    return f"{prefix}{safe_name}"


def _safe_candidate_id(candidate_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", candidate_id).strip("-")[:128] or "candidate"


def _extension_for_mime_type(mime_type: str) -> str:
    return {
        "application/pdf": ".pdf",
        "image/jpeg": ".jpg",
        "image/png": ".png",
    }.get(mime_type, "")
