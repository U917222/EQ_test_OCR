"""Google Driveとのやり取り。

Cloud Run実行サービスアカウントのADC (Application Default Credentials) を使う。
対象のDriveフォルダは、サービスアカウントのメールアドレスへ事前に共有しておくこと。
"""

import io
import logging
import os
import re

import google.auth
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload

logger = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/drive"]
DEFAULT_ALLOWED_DOWNLOAD_MIME_TYPES = frozenset(
    {
        "application/pdf",
        "image/jpeg",
        "image/png",
    }
)
DEFAULT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
ALLOWED_MIME_TYPES_ENV = "RECOGNITION_ALLOWED_MIME_TYPES"
MAX_FILE_BYTES_ENV = "RECOGNITION_MAX_FILE_BYTES"

_FILE_ID_PATTERNS = (
    re.compile(r"/d/([\w-]{20,})"),       # https://drive.google.com/file/d/<id>/view
    re.compile(r"[?&]id=([\w-]{20,})"),   # https://drive.google.com/open?id=<id>
)


class DriveFileRejectedError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def extract_file_id(url: str) -> str:
    for pattern in _FILE_ID_PATTERNS:
        match = pattern.search(url)
        if match:
            return match.group(1)
    raise ValueError(f"could not extract Drive file id from url: {url}")


def _service():
    credentials, _ = google.auth.default(scopes=SCOPES)
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def _allowed_mime_types() -> set[str]:
    configured = os.environ.get(ALLOWED_MIME_TYPES_ENV, "")
    if not configured.strip():
        return set(DEFAULT_ALLOWED_DOWNLOAD_MIME_TYPES)
    return {item.strip() for item in configured.split(",") if item.strip()}


def _max_download_bytes() -> int:
    configured = os.environ.get(MAX_FILE_BYTES_ENV, "")
    if not configured.strip():
        return DEFAULT_MAX_DOWNLOAD_BYTES
    try:
        value = int(configured)
    except ValueError as error:
        raise DriveFileRejectedError(
            "invalid_max_file_bytes", f"{MAX_FILE_BYTES_ENV} must be an integer"
        ) from error
    if value <= 0:
        raise DriveFileRejectedError(
            "invalid_max_file_bytes", f"{MAX_FILE_BYTES_ENV} must be greater than zero"
        )
    return value


def validate_drive_file_metadata(metadata: dict) -> tuple[str, int]:
    """Validate Drive metadata before downloading file bytes."""
    mime_type = metadata.get("mimeType", "")
    allowed_mime_types = _allowed_mime_types()
    if mime_type not in allowed_mime_types:
        raise DriveFileRejectedError("unsupported_mime_type", f"unsupported MIME type: {mime_type}")

    size_raw = metadata.get("size")
    if size_raw in (None, ""):
        raise DriveFileRejectedError(
            "missing_file_size", "Drive file size is required before download"
        )
    try:
        size = int(size_raw)
    except (TypeError, ValueError) as error:
        raise DriveFileRejectedError("invalid_file_size", f"invalid Drive file size: {size_raw}") from error
    if size < 0:
        raise DriveFileRejectedError("invalid_file_size", f"invalid Drive file size: {size}")

    max_bytes = _max_download_bytes()
    if size > max_bytes:
        raise DriveFileRejectedError(
            "file_too_large", f"Drive file is too large: {size} bytes > {max_bytes} bytes"
        )
    return mime_type, size


def download_drive_file(source_url: str) -> tuple[bytes, str]:
    """Drive URLからファイル本体を取得し、(バイト列, mimeType) を返す。"""
    file_id = extract_file_id(source_url)
    service = _service()

    metadata = (
        service.files()
        .get(fileId=file_id, fields="mimeType,name,size", supportsAllDrives=True)
        .execute()
    )
    mime_type, size = validate_drive_file_metadata(metadata)
    max_bytes = _max_download_bytes()
    logger.info(
        "downloading drive file: id=%s name=%s mime=%s size=%s",
        file_id, metadata.get("name"), mime_type, size,
    )

    request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
        if buffer.tell() > max_bytes:
            raise DriveFileRejectedError(
                "file_too_large", f"Drive download exceeded {max_bytes} bytes"
            )
    return buffer.getvalue(), mime_type


def upload_review_image(folder_id: str, name: str, png_bytes: bytes) -> str:
    """レビュー用の切り出し画像をDriveへ保存し、閲覧URLを返す。"""
    service = _service()
    media = MediaIoBaseUpload(io.BytesIO(png_bytes), mimetype="image/png", resumable=False)
    created = (
        service.files()
        .create(
            body={"name": name, "parents": [folder_id]},
            media_body=media,
            fields="id,webViewLink",
            supportsAllDrives=True,
        )
        .execute()
    )
    return created.get("webViewLink", f"https://drive.google.com/file/d/{created['id']}/view")
