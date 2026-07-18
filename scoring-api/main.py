"""CHEQ scoring API (Cloud Run entrypoint)."""

from __future__ import annotations

import hmac
import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from src.config import env_flag
from src.pdf import build_pdf_response
from src.wire import normalize_error, success_response


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="CHEQ Scoring API", version="0.1.0")

ERROR_STATUS = {
    "unauthorized": 401,
    "forbidden": 403,
    "validation": 400,
    "not_found": 404,
    "conflict": 409,
    "rate_limited": 429,
    "internal": 500,
}


@app.get("/readyz")
def readyz() -> dict[str, bool]:
    return {"ok": True}


@app.post("/render-pdf")
async def render_pdf(request: Request) -> JSONResponse:
    return await _handle_render_pdf(request)


async def _handle_render_pdf(request: Request) -> JSONResponse:
    """Bearer-authenticated PDF renderer for the D1 backend.

    This is the only POST endpoint exposed by this service. Authentication uses the
    dedicated PDF_RENDER_KEY bearer token.
    """
    render_key = os.environ.get("PDF_RENDER_KEY", "").strip()
    if not render_key:
        if not env_flag("ALLOW_INSECURE_DEV_AUTH"):
            return _json(
                {"ok": False, "error": {"code": "unavailable", "message": "PDF_RENDER_KEY is not configured"}},
                503,
            )
    else:
        provided = _bearer_token(request.headers.get("Authorization"))
        if not provided or not hmac.compare_digest(provided, render_key):
            return _json(
                {"ok": False, "error": {"code": "unauthorized", "message": "Invalid or missing bearer token"}},
                401,
            )

    try:
        body = await request.json()
    except Exception:
        return _json(
            {"ok": False, "error": {"code": "validation", "message": "Request body must be valid JSON"}},
            400,
        )
    if not isinstance(body, dict):
        return _json(
            {"ok": False, "error": {"code": "validation", "message": "Request body must be a JSON object"}},
            400,
        )

    try:
        response = build_pdf_response(
            body.get("candidate") or {},
            body.get("result") or {},
            body.get("rawCellSummary"),
        )
        return _json(success_response(response))
    except Exception as error:
        api_error = normalize_error(error)
        logger.exception("PDF render failed")
        return _json(
            {"ok": False, "error": {"code": api_error.code, "message": api_error.message}},
            ERROR_STATUS.get(api_error.code, 500),
        )


def _bearer_token(header_value: str | None) -> str:
    if not header_value:
        return ""
    parts = header_value.split(" ", 1)
    if len(parts) != 2 or parts[0].strip().lower() != "bearer":
        return ""
    return parts[1].strip()


def _json(body: dict, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        content=body,
        status_code=status_code,
        media_type="application/json; charset=utf-8",
    )
