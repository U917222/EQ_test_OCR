"""Private R2 storage for candidate reference PDF documents.

Reference documents deliberately live outside the scoring-sheet object prefix and
are listed directly from R2. No document metadata is stored in Sheets.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Iterator

from src.repository import now_iso
from src.upload_recognition import decode_upload_file
from src.upload_storage import (
    R2_CANDIDATE_PATTERN,
    R2_FILE_ID_PATTERN,
    _r2_client,
    _r2_config,
)
from src.wire import ApiError


LOGGER = logging.getLogger(__name__)

DOCUMENT_CATEGORIES = frozenset({"resume", "essay", "other"})
DOCUMENT_MIME_TYPE = "application/pdf"
MAX_DOCUMENT_BYTES = 9 * 1024 * 1024
DOCUMENT_PREFIX_SEGMENT = "documents"
R2_SOURCE_PREFIX = "/files/r2"
SAFE_DOCUMENT_FILENAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,180}$")


def upload_candidate_document(
    candidate_id: str,
    category: str,
    file_payload: Any,
    uploaded_by: str,
    operation_id: str = "",
) -> dict[str, Any]:
    """Validate and store one reference PDF in the candidate document prefix."""
    safe_candidate_id = _validated_candidate_id(candidate_id)
    normalized_category = _validated_category(category)
    upload = _decode_document_pdf(file_payload)
    document_id = _document_id(operation_id)
    stored_filename = _safe_document_filename(upload["name"])
    key = _document_key(
        safe_candidate_id,
        normalized_category,
        document_id,
        stored_filename,
    )
    uploaded_at = now_iso()
    checksum = hashlib.sha256(upload["bytes"]).hexdigest()
    config = _r2_config()
    try:
        _r2_client().put_object(
            Bucket=config["bucket"],
            Key=key,
            Body=upload["bytes"],
            ContentType=DOCUMENT_MIME_TYPE,
            Metadata={
                "candidateId": safe_candidate_id,
                "documentId": document_id,
                "category": normalized_category,
                "originalFilenameBase64": _metadata_encode(upload["name"]),
                "uploadedByBase64": _metadata_encode(uploaded_by),
                "checksumSha256": checksum,
            },
            StorageClass="STANDARD",
        )
    except ApiError:
        raise
    except Exception as error:
        raise ApiError("upstream", f"Candidate document storage failed: {error}") from error

    return _api_document(
        candidate_id=safe_candidate_id,
        category=normalized_category,
        document_id=document_id,
        stored_filename=stored_filename,
        original_filename=upload["name"],
        mime_type=DOCUMENT_MIME_TYPE,
        size_bytes=len(upload["bytes"]),
        uploaded_at=uploaded_at,
        uploaded_by=str(uploaded_by or ""),
    )


def list_candidate_documents(candidate_id: str) -> list[dict[str, Any]]:
    """List reference documents from R2 and hydrate custom metadata with HEAD."""
    safe_candidate_id = _validated_candidate_id(candidate_id)
    config = _r2_config()
    client = _r2_client()
    documents: list[dict[str, Any]] = []
    try:
        for summary in _iter_document_summaries(client, config["bucket"], safe_candidate_id):
            key = str(summary.get("Key") or "")
            location = _parse_document_key(key, safe_candidate_id)
            if not location:
                continue
            head = client.head_object(Bucket=config["bucket"], Key=key)
            metadata = head.get("Metadata") if isinstance(head.get("Metadata"), dict) else {}
            original_filename = _metadata_decode(
                _metadata_value(metadata, "originalFilenameBase64")
            ) or location["stored_filename"]
            uploaded_by = _metadata_decode(
                _metadata_value(metadata, "uploadedByBase64")
            )
            uploaded_at = _datetime_iso(summary.get("LastModified"))
            mime_type = str(head.get("ContentType") or DOCUMENT_MIME_TYPE).split(";", 1)[0].strip().lower()
            size_bytes = _integer_or_default(head.get("ContentLength"), summary.get("Size"), 0)
            documents.append(
                _api_document(
                    candidate_id=safe_candidate_id,
                    category=location["category"],
                    document_id=location["document_id"],
                    stored_filename=location["stored_filename"],
                    original_filename=original_filename,
                    mime_type=mime_type or DOCUMENT_MIME_TYPE,
                    size_bytes=size_bytes,
                    uploaded_at=uploaded_at,
                    uploaded_by=uploaded_by,
                )
            )
    except ApiError:
        raise
    except Exception as error:
        raise ApiError("upstream", f"Candidate document listing failed: {error}") from error

    documents.sort(key=lambda document: str(document.get("uploadedAt") or ""), reverse=True)
    return documents


def delete_candidate_document(candidate_id: str, document_id: str) -> bool:
    """Delete only objects matching candidateId + documentId in the documents prefix."""
    safe_candidate_id = _validated_candidate_id(candidate_id)
    safe_document_id = _validated_document_id(document_id)
    config = _r2_config()
    client = _r2_client()
    matches: list[str] = []
    try:
        for summary in _iter_document_summaries(client, config["bucket"], safe_candidate_id):
            key = str(summary.get("Key") or "")
            location = _parse_document_key(key, safe_candidate_id)
            if location and location["document_id"] == safe_document_id:
                matches.append(key)
        for key in matches:
            client.delete_object(Bucket=config["bucket"], Key=key)
    except ApiError:
        raise
    except Exception as error:
        raise ApiError("upstream", f"Candidate document deletion failed: {error}") from error
    return bool(matches)


def delete_all_candidate_documents(candidate_id: str) -> dict[str, int]:
    """Best-effort cleanup used after the candidate rows have been deleted."""
    safe_candidate_id = _validated_candidate_id(candidate_id)
    config = _r2_config()
    client = _r2_client()
    deleted = 0
    failed = 0
    try:
        summaries = list(_iter_document_summaries(client, config["bucket"], safe_candidate_id))
    except Exception as error:
        raise ApiError("upstream", f"Candidate document listing failed: {error}") from error

    for summary in summaries:
        key = str(summary.get("Key") or "")
        if not _parse_document_key(key, safe_candidate_id):
            continue
        try:
            client.delete_object(Bucket=config["bucket"], Key=key)
            deleted += 1
        except Exception as error:
            failed += 1
            LOGGER.warning(
                "Failed to clean up candidate reference document",
                extra={"candidate_id": safe_candidate_id, "key": key, "cleanup_error": str(error)},
            )
    return {"deleted": deleted, "failed": failed}


def _decode_document_pdf(file_payload: Any) -> dict[str, Any]:
    if not isinstance(file_payload, dict):
        raise ApiError("validation", "file must be an object")
    original_name = _normalize_original_filename(file_payload.get("name"))
    if not original_name:
        raise ApiError("validation", "file.name is required")
    raw_mime_type = str(
        file_payload.get("mimeType") or file_payload.get("contentType") or ""
    ).split(";", 1)[0].strip().lower()
    if raw_mime_type != DOCUMENT_MIME_TYPE:
        raise ApiError("validation", "Only PDF documents are supported")
    upload = decode_upload_file(file_payload)
    if not upload["bytes"].startswith(b"%PDF-"):
        raise ApiError("validation", "PDF content must start with %PDF-")
    if len(upload["bytes"]) > MAX_DOCUMENT_BYTES:
        raise ApiError("validation", f"Upload exceeds {MAX_DOCUMENT_BYTES} bytes")
    upload["name"] = original_name
    return upload


def _iter_document_summaries(
    client: Any, bucket: str, candidate_id: str
) -> Iterator[dict[str, Any]]:
    prefix = f"candidates/{candidate_id}/{DOCUMENT_PREFIX_SEGMENT}/"
    continuation_token = ""
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if continuation_token:
            kwargs["ContinuationToken"] = continuation_token
        response = client.list_objects_v2(**kwargs)
        contents = response.get("Contents") if isinstance(response, dict) else []
        for item in contents if isinstance(contents, list) else []:
            if isinstance(item, dict):
                yield item
        if not bool(response.get("IsTruncated")):
            break
        next_token = str(response.get("NextContinuationToken") or "")
        if not next_token or next_token == continuation_token:
            raise ApiError("upstream", "R2 document listing returned an invalid continuation token")
        continuation_token = next_token


def _parse_document_key(key: str, candidate_id: str) -> dict[str, str] | None:
    segments = str(key or "").split("/")
    if len(segments) != 6:
        return None
    root, stored_candidate_id, marker, category, document_id, stored_filename = segments
    if (
        root != "candidates"
        or stored_candidate_id != candidate_id
        or marker != DOCUMENT_PREFIX_SEGMENT
        or category not in DOCUMENT_CATEGORIES
        or not R2_FILE_ID_PATTERN.fullmatch(document_id)
        or not SAFE_DOCUMENT_FILENAME_PATTERN.fullmatch(stored_filename)
        or ".." in stored_filename
    ):
        return None
    return {
        "category": category,
        "document_id": document_id.lower(),
        "stored_filename": stored_filename,
    }


def _api_document(
    *,
    candidate_id: str,
    category: str,
    document_id: str,
    stored_filename: str,
    original_filename: str,
    mime_type: str,
    size_bytes: int,
    uploaded_at: str,
    uploaded_by: str,
) -> dict[str, Any]:
    return {
        "documentId": document_id,
        "candidateId": candidate_id,
        "category": category,
        "filename": original_filename,
        "mimeType": mime_type,
        "sizeBytes": size_bytes,
        "uploadedAt": uploaded_at,
        "uploadedBy": uploaded_by,
        "url": (
            f"{R2_SOURCE_PREFIX}/{candidate_id}/{DOCUMENT_PREFIX_SEGMENT}/"
            f"{category}/{document_id}/{stored_filename}"
        ),
    }


def _document_key(
    candidate_id: str, category: str, document_id: str, stored_filename: str
) -> str:
    return (
        f"candidates/{candidate_id}/{DOCUMENT_PREFIX_SEGMENT}/"
        f"{category}/{document_id}/{stored_filename}"
    )


def _validated_candidate_id(candidate_id: Any) -> str:
    value = str(candidate_id or "").strip()
    if not R2_CANDIDATE_PATTERN.fullmatch(value):
        raise ApiError("validation", "candidateId is invalid for R2 document storage")
    return value


def _validated_category(category: Any) -> str:
    value = str(category or "").strip().lower()
    if value not in DOCUMENT_CATEGORIES:
        raise ApiError("validation", "category must be resume, essay, or other")
    return value


def _validated_document_id(document_id: Any) -> str:
    value = str(document_id or "").strip()
    if not R2_FILE_ID_PATTERN.fullmatch(value):
        raise ApiError("validation", "documentId must be a UUID")
    return value.lower()


def _document_id(operation_id: Any) -> str:
    value = str(operation_id or "").strip()
    if not R2_FILE_ID_PATTERN.fullmatch(value):
        raise ApiError("validation", "operationId must be a UUID")
    return value.lower()


def _safe_document_filename(original_name: str) -> str:
    stem = re.sub(r"\.pdf$", "", original_name, flags=re.IGNORECASE)
    ascii_stem = unicodedata.normalize("NFKD", stem)
    ascii_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", ascii_stem).strip(".-")[:160]
    has_ascii_letter = bool(re.search(r"[A-Za-z]", stem))
    safe_stem = ascii_stem or "document"
    if not has_ascii_letter and ascii_stem:
        safe_stem = f"document-{ascii_stem}"
    return f"{safe_stem}.pdf"


def _normalize_original_filename(value: Any) -> str:
    filename = re.sub(r"[\x00-\x1f\x7f/\\]", "-", str(value or ""))
    filename = re.sub(r"\s+", " ", filename).strip()[:180]
    if not filename:
        raise ApiError("validation", "file.name is required")
    return filename if filename.lower().endswith(".pdf") else f"{filename}.pdf"


def _metadata_encode(value: Any) -> str:
    return base64.urlsafe_b64encode(str(value or "").encode("utf-8")).decode("ascii").rstrip("=")


def _metadata_decode(value: Any) -> str:
    encoded = str(value or "").strip()
    if not encoded:
        return ""
    padding = "=" * (-len(encoded) % 4)
    try:
        return base64.b64decode(
            encoded + padding,
            altchars=b"-_",
            validate=True,
        ).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return ""


def _metadata_value(metadata: dict[str, Any], expected_key: str) -> str:
    normalized_expected = re.sub(r"[^a-z0-9]", "", expected_key.lower())
    for key, value in metadata.items():
        normalized_key = re.sub(r"[^a-z0-9]", "", str(key).lower())
        if normalized_key == normalized_expected:
            return str(value or "")
    return ""


def _datetime_iso(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    return str(value or "")


def _integer_or_default(*values: Any) -> int:
    for value in values:
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return 0
