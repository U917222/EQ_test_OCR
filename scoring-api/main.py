"""CHEQ scoring API (Cloud Run entrypoint)."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from src.config import Settings
from src.handlers import dispatch
from src.repository import ScoringRepository, now_iso
from src.security import append_audit, execute_with_idempotency, verify_context
from src.wire import WRITE_ACTIONS, normalize_error, parse_envelope, success_response


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


@app.get("/healthz")
@app.get("/readyz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.post("/")
@app.post("/api")
async def api_root(request: Request) -> JSONResponse:
    return await _handle_api(request)


async def _handle_api(request: Request) -> JSONResponse:
    started_at = now_iso()
    context = None
    repo = None
    try:
        body = await request.json()
        claims, payload = parse_envelope(body)
        settings = Settings.from_env()
        repo = ScoringRepository.from_spreadsheet_id(settings.scoring_spreadsheet_id)
        context = verify_context(
            repo,
            settings,
            claims,
            payload,
            dict(request.headers),
            dict(request.query_params),
        )
        result = execute_with_idempotency(repo, context, lambda: dispatch(context, repo))
        # 監査ログは書き込み系のみ記録する。読み取り(me/listCandidates/getDashboard 等)では
        # AuditLog への Sheets 追記を省き、応答を高速化する。
        if context.action in WRITE_ACTIONS:
            append_audit(repo, context, result, started_at)
        return _json(success_response(result))
    except Exception as error:
        api_error = normalize_error(error)
        logger.exception("API request failed")
        body = {"ok": False, "error": {"code": api_error.code, "message": api_error.message}}
        if repo is not None:
            append_audit(repo, context, {"error": body["error"]["code"]}, started_at)
        return _json(body, ERROR_STATUS.get(api_error.code, 500))


def _json(body: dict, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        content=body,
        status_code=status_code,
        media_type="application/json; charset=utf-8",
    )
