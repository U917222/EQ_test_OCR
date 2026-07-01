"""CHEQ採点表(page.5) 画像解析API (Cloud Run用エントリポイント)。

GASから {candidateId, sourceUrl, callbackUrl} を受け取り、
Drive上の採点表画像/PDFの○(0〜3)をOpenCVで読み取り、
セル契約 (docs/cell-contract.md) で結果をGAS WebhookへPOSTで返す。
"""

import base64
import hmac
import logging
import os
import re

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from src import drive_client
from src.callback_client import (
    CallbackValidationError,
    post_recognition_result,
    resolve_callback_url,
)
from src.recognizer import RecognitionError
from src.scoresheet_recognizer import failed_scoresheet_result, recognize_scoresheet

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="CHEQ Recognition API", version="0.1.0")


class RecognizeRequest(BaseModel):
    candidateId: str = Field(min_length=1)
    sourceUrl: str = Field(min_length=1)
    callbackUrl: str | None = Field(default=None, min_length=1)
    pageIndex: int | None = Field(default=None, ge=0)  # PDFの採点表ページ(0始まり)


class RecognizeSyncFile(BaseModel):
    base64: str = Field(min_length=1)
    mimeType: str | None = Field(default=None)
    name: str | None = Field(default=None)


class RecognizeSyncRequest(BaseModel):
    """同期版(bytes直接受け取り)。Drive/callback を経由しない D1 取込経路用。"""

    file: RecognizeSyncFile
    pageIndex: int | None = Field(default=None, ge=0)  # PDFの採点表ページ(0始まり)


# 拡張子から MIME を補完する (mimeType 欠落/不正時のフォールバック)。
_MIME_BY_EXTENSION = {
    "pdf": "application/pdf",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
}
# レビュー切り抜きを data-URI で imageLinks に載せる際の上限 (base64後の文字数)。
_REVIEW_DATA_URI_MAX_BASE64_CHARS = 30000


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _verify_bearer(authorization: str | None) -> None:
    api_key = os.environ.get("RECOGNITION_API_KEY", "")
    if not api_key:
        if _env_flag("ALLOW_INSECURE_DEV_AUTH"):
            logger.warning("ALLOW_INSECURE_DEV_AUTH=true; skipping authorization check")
            return
        raise HTTPException(status_code=503, detail="RECOGNITION_API_KEY is not configured")
    expected = f"Bearer {api_key}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="invalid bearer token")


@app.get("/healthz")
@app.get("/readyz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/recognize", status_code=202)
def recognize(
    request: RecognizeRequest,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
) -> dict:
    _verify_bearer(authorization)
    try:
        callback_url = resolve_callback_url(request.callbackUrl)
    except CallbackValidationError as error:
        raise HTTPException(
            status_code=400, detail={"code": error.code, "message": str(error)}
        ) from error
    background_tasks.add_task(_process_and_callback, request, callback_url)
    logger.info("accepted: candidateId=%s", request.candidateId)
    return {"ok": True, "accepted": True, "candidateId": request.candidateId}


def _process_and_callback(request: RecognizeRequest, callback_url: str) -> None:
    try:
        content, mime_type = drive_client.download_drive_file(request.sourceUrl)
        result = recognize_scoresheet(content, mime_type, request.pageIndex)
    except drive_client.DriveFileRejectedError as error:
        logger.warning(
            "drive file rejected: candidateId=%s code=%s error=%s",
            request.candidateId, error.code, error,
        )
        result = failed_scoresheet_result(error.code, str(error))
    except RecognitionError as error:
        logger.warning(
            "recognition rejected: candidateId=%s error=%s", request.candidateId, error
        )
        result = failed_scoresheet_result("recognition_failed", str(error))
    except ValueError as error:
        logger.warning(
            "recognition input rejected: candidateId=%s error=%s", request.candidateId, error
        )
        result = failed_scoresheet_result("invalid_input", str(error))
    except Exception:
        logger.exception("recognition failed: candidateId=%s", request.candidateId)
        # 失敗時は全セルを未確定・信頼度0で返し、ReviewQueueで人間が確認する
        result = failed_scoresheet_result("internal_error", "recognition failed")

    image_links = _upload_review_images(request.candidateId, result.review_images)
    recognition = result.to_recognition_payload(image_links)

    try:
        post_recognition_result(callback_url, request.candidateId, recognition)
    except Exception:
        logger.exception("callback failed: candidateId=%s", request.candidateId)


def _upload_review_images(candidate_id: str, review_images: dict[str, bytes]) -> dict[str, str]:
    folder_id = os.environ.get("REVIEW_IMAGE_FOLDER_ID", "")
    if not folder_id or not review_images:
        return {}

    links: dict[str, str] = {}
    for cell_key, png_bytes in review_images.items():
        if not png_bytes:
            continue
        try:
            links[cell_key] = drive_client.upload_review_image(
                folder_id, f"{candidate_id}_{cell_key}.png", png_bytes
            )
        except Exception:
            logger.exception("review image upload failed: %s %s", candidate_id, cell_key)
    return links


@app.post("/recognize-sync")
def recognize_sync(
    request: RecognizeSyncRequest,
    authorization: str | None = Header(default=None),
) -> dict:
    """base64 の画像/PDF を同期で解析し recognition ペイロードを直接返す。

    Drive/callback を使わない D1 取込経路(Pages Functions)向け。認証は /recognize と同じ
    Bearer スキーム。解析に失敗しても全セル未確定の failure ペイロードを 200 で返し、
    どのセルも黙って欠落させない (ReviewQueue で人間が確認する)。
    """
    _verify_bearer(authorization)
    try:
        content, mime_type = _decode_sync_upload(request.file)
        result = recognize_scoresheet(content, mime_type, request.pageIndex)
    except RecognitionError as error:
        logger.warning("recognize-sync recognition rejected: error=%s", error)
        result = failed_scoresheet_result("recognition_failed", str(error))
    except ValueError as error:
        logger.warning("recognize-sync input rejected: error=%s", error)
        result = failed_scoresheet_result("invalid_input", str(error))
    except Exception:
        logger.exception("recognize-sync failed")
        result = failed_scoresheet_result("internal_error", "recognition failed")

    recognition = result.to_recognition_payload(_review_images_to_data_uris(result.review_images))
    return {"ok": True, "recognition": recognition}


def _decode_sync_upload(file: RecognizeSyncFile) -> tuple[bytes, str]:
    """file.base64 をデコードし、MIME/サイズを検証して (bytes, mime_type) を返す。

    不正な base64・非対応 MIME・サイズ超過はいずれも ValueError を送出し、
    呼び出し側で failure ペイロードへ縮退させる。
    """
    raw_base64 = (file.base64 or "").strip()
    if not raw_base64:
        raise ValueError("file.base64 is required")
    normalized_base64 = re.sub(r"\s+", "", raw_base64)
    if len(normalized_base64) % 4 == 1 or not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", normalized_base64):
        raise ValueError("file.base64 is invalid")
    try:
        content = base64.b64decode(normalized_base64, validate=True)
    except Exception as error:
        raise ValueError("file.base64 is invalid") from error
    if not content:
        raise ValueError("file is empty")
    max_bytes = drive_client._max_download_bytes()
    if len(content) > max_bytes:
        raise ValueError(f"file exceeds {max_bytes} bytes")
    mime_type = _normalize_sync_mime(file.mimeType, file.name or "")
    return content, mime_type


def _normalize_sync_mime(raw_mime_type: str | None, name: str) -> str:
    mime_type = str(raw_mime_type or "").split(";")[0].strip().lower()
    allowed = drive_client._allowed_mime_types()
    if mime_type in allowed:
        return mime_type
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    guessed = _MIME_BY_EXTENSION.get(extension)
    if guessed and guessed in allowed:
        return guessed
    raise ValueError(f"Unsupported upload MIME type: {raw_mime_type or ''}")


def _review_images_to_data_uris(images: dict[str, bytes]) -> dict[str, str]:
    """要確認セルのPNG切り抜き(bytes)を per-cell の data-URI 文字列に変換する。

    空 bytes と、base64化後に上限を超えるものは落とす (degrade)。
    """
    data_uris: dict[str, str] = {}
    for key, png_bytes in images.items():
        if not png_bytes:
            continue
        encoded = base64.b64encode(png_bytes).decode("ascii")
        if len(encoded) > _REVIEW_DATA_URI_MAX_BASE64_CHARS:
            continue
        data_uris[key] = f"data:image/png;base64,{encoded}"
    return data_uris
