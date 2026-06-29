"""Authentication, authorization, nonce, idempotency, and audit helpers."""

from __future__ import annotations

import json
import re
import time
from typing import Any, Callable

from src.config import Settings
from src.repository import ScoringRepository, normalize_email, now_iso, parse_bool
from src.wire import (
    API_OPERATION_TTL_SECONDS,
    ROLE_RANK,
    WRITE_ACTIONS,
    ApiContext,
    ApiError,
    assert_audience_and_action,
    assert_timestamp,
    candidate_id_from_payload,
    request_param,
    serialize_for_api,
    verify_signature,
)


def verify_context(
    repo: ScoringRepository,
    settings: Settings,
    claims: dict[str, Any],
    payload: dict[str, Any],
    headers: dict[str, Any],
    query: dict[str, Any],
) -> ApiContext:
    signature = request_param(headers, query, "X-Signature")
    timestamp = request_param(headers, query, "X-Timestamp")
    nonce = request_param(headers, query, "X-Nonce")
    if not settings.allow_insecure_dev_auth:
        verify_signature(claims, payload, settings.functions_gas_secret, signature)
        assert_timestamp(claims, timestamp)
        assert_nonce_unused(repo, claims, nonce)
    action, operation_id = assert_audience_and_action(
        claims, payload, request_param(headers, query, "action")
    )
    user = resolve_user(repo, claims.get("operator"))
    authorize(action, user["role"])
    return ApiContext(
        claims=claims,
        payload=payload,
        action=action,
        operator=user["email"],
        role=user["role"],
        operation_id=operation_id,
    )


def assert_nonce_unused(repo: ScoringRepository, claims: dict[str, Any], request_nonce: str) -> None:
    nonce = str(claims.get("nonce") or "").strip()
    if not nonce:
        raise ApiError("unauthorized", "Missing nonce")
    if not re.fullmatch(r"[0-9a-fA-F]+", nonce):
        raise ApiError("unauthorized", "Invalid nonce")
    if request_nonce and request_nonce != nonce:
        raise ApiError("unauthorized", "Nonce mismatch")
    try:
        ts = float(claims.get("ts"))
    except (TypeError, ValueError) as error:
        raise ApiError("unauthorized", "Invalid timestamp") from error

    now_seconds = int(time.time())
    table = repo.nonces()
    kept = []
    exists = False
    for row in table.rows:
        try:
            row_ts = float(row.get("ts"))
        except (TypeError, ValueError):
            row_ts = now_seconds
        if now_seconds - row_ts <= 600:
            kept.append(row)
            if str(row.get("nonce") or "") == nonce:
                exists = True
    # 毎リクエストでの全書き戻しは Sheets 2往復ぶんの固定コストになるため、
    # 期限切れが十分たまったときだけ整理する。リプレイ判定は kept(=未期限切れ)で正しく行われる。
    if len(table.rows) - len(kept) > 200:
        repo.rewrite_nonces(kept)
    if exists:
        raise ApiError("unauthorized", "Nonce already used")
    repo.append_nonce(nonce, ts)


def resolve_user(repo: ScoringRepository, email: Any) -> dict[str, str]:
    normalized = normalize_email(email)
    if not normalized:
        raise ApiError("forbidden", "operator is required")
    user = next((row for row in repo.users() if normalize_email(row.get("email")) == normalized), None)
    if not user or not parse_bool(user.get("active")):
        raise ApiError("forbidden", "User is not active")
    role = str(user.get("role") or "").strip().lower()
    if role not in ROLE_RANK:
        raise ApiError("forbidden", "User role is invalid")
    return {"email": normalized, "role": role}


def authorize(action: str, role: str) -> None:
    required_roles = {
        "me": "operator",
        "listCandidates": "operator",
        "getDashboard": "operator",
        "getCells": "operator",
        "getResult": "operator",
        "getResultPdf": "reviewer",
        "registerCandidate": "operator",
        "updateCandidate": "operator",
        "saveCells": "operator",
        "updateStatus": "operator",
        "deleteCandidate": "operator",
        "finalize": "reviewer",
        "saveDecision": "reviewer",
    }
    required = required_roles.get(action)
    if not required or ROLE_RANK.get(role, 0) < ROLE_RANK[required]:
        raise ApiError("forbidden", "Insufficient role")


def execute_with_idempotency(
    repo: ScoringRepository,
    context: ApiContext,
    handler: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    if context.action not in WRITE_ACTIONS:
        return handler()
    if not context.operation_id:
        raise ApiError("validation", "operationId is required")

    cleanup_operations(repo)
    existing = next(
        (
            row
            for row in repo.operations().rows
            if str(row.get("operation_id") or "") == context.operation_id
        ),
        None,
    )
    if existing:
        if str(existing.get("action") or "") != context.action:
            raise ApiError("conflict", "operationId was already used for a different action")
        requested_candidate_id = candidate_id_from_payload(context.payload)
        if (
            existing.get("candidate_id")
            and requested_candidate_id
            and str(existing.get("candidate_id")) != requested_candidate_id
        ):
            raise ApiError("conflict", "operationId was already used for a different candidate")
        replay = _json_loads(existing.get("result_json"), {})
        return {"idempotentReplay": True, **replay}

    result = handler()
    repo.append_operation(
        {
            "operation_id": context.operation_id,
            "action": context.action,
            "candidate_id": operation_candidate_id(context, result),
            "status": "SUCCEEDED",
            "result_json": json.dumps(serialize_for_api(result), ensure_ascii=False, separators=(",", ":")),
            "created_at": now_iso(),
        }
    )
    return result


def cleanup_operations(repo: ScoringRepository) -> None:
    now_seconds = int(time.time())
    table = repo.operations()
    kept = []
    for row in table.rows:
        created = row.get("created_at")
        try:
            created_seconds = int(float(created))
        except (TypeError, ValueError):
            try:
                created_seconds = int(time.mktime(time.strptime(str(created)[:19], "%Y-%m-%dT%H:%M:%S")))
            except (TypeError, ValueError):
                created_seconds = now_seconds
        if now_seconds - created_seconds <= API_OPERATION_TTL_SECONDS:
            kept.append(row)
    if len(kept) != len(table.rows):
        repo.rewrite_operations(kept)


def operation_candidate_id(context: ApiContext, result: dict[str, Any]) -> str:
    return (
        candidate_id_from_payload(context.payload)
        or str((result.get("candidate") or {}).get("candidateId") or "")
        or str((result.get("result") or {}).get("candidateId") or "")
    )


def append_audit(
    repo: ScoringRepository,
    context: ApiContext | None,
    result: dict[str, Any],
    started_at: str,
) -> None:
    try:
        candidate_id = ""
        if context:
            candidate_id = candidate_id_from_payload(context.payload) or operation_candidate_id(context, result)
        result_json = json.dumps(serialize_for_api(result), ensure_ascii=False, separators=(",", ":"))
        repo.append_audit(
            {
                "logged_at": started_at,
                "actor": context.operator if context else "",
                "action": context.action if context else "",
                "candidate_id": candidate_id,
                "detail_json": result_json,
                "operator": context.operator if context else "",
                "operation_id": context.operation_id if context else "",
                "result": result_json,
                "at": started_at,
            }
        )
    except Exception:
        return


def _json_loads(value: Any, default: Any) -> Any:
    if value in ("", None):
        return default
    try:
        return json.loads(str(value))
    except json.JSONDecodeError:
        return default
