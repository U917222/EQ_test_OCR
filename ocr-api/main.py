"""CHEQ採点表(page.5) 画像解析API (Cloud Run用エントリポイント)。

GASから {candidateId, sourceUrl, callbackUrl} を受け取り、
Drive上の採点表画像/PDFの○(0〜3)をOpenCVで読み取り、
セル契約 (docs/cell-contract.md) で結果をGAS WebhookへPOSTで返す。
"""

import hmac
import logging
import os

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
