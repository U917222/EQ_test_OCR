"""Wire-level JSON canonicalization, HMAC verification, and API responses."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import time
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Mapping


API_SIGNATURE_PREFIX = "sha256="
API_AUDIENCE = "scoring-api"
# Temporary compatibility for Pages deployments created before the service rename.
LEGACY_API_AUDIENCE = "gas-api"
API_AUDIENCES = frozenset({API_AUDIENCE, LEGACY_API_AUDIENCE})
API_MAX_CLOCK_SKEW_SECONDS = 300
API_NONCE_TTL_SECONDS = 600
API_OPERATION_TTL_SECONDS = 30 * 24 * 60 * 60
API_UUID_PATTERN = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
)

WRITE_ACTIONS = {
    "registerCandidate",
    "attachScoresheet",
    "uploadCandidateDocument",
    "deleteCandidateDocument",
    "updateCandidate",
    "saveCells",
    "updateStatus",
    "deleteCandidate",
    "finalize",
    "saveDecision",
}

REQUIRED_ROLES = {
    "me": "operator",
    "listCandidates": "operator",
    "getDashboard": "operator",
    "getCells": "operator",
    "saveCells": "operator",
    "registerCandidate": "operator",
    "attachScoresheet": "operator",
    "listCandidateDocuments": "operator",
    "uploadCandidateDocument": "operator",
    "deleteCandidateDocument": "operator",
    "updateCandidate": "operator",
    "getResult": "operator",
    "updateStatus": "operator",
    "deleteCandidate": "operator",
    "finalize": "reviewer",
    "saveDecision": "reviewer",
    "getResultPdf": "reviewer",
}

ROLE_RANK = {"operator": 1, "reviewer": 2, "admin": 3}


class ApiError(Exception):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


@dataclass(frozen=True)
class ApiContext:
    claims: dict[str, Any]
    payload: dict[str, Any]
    action: str
    operator: str
    role: str
    operation_id: str


def canonical_json(value: Any) -> str:
    normalized = _normalize_for_canonical_json(value)
    return _stringify_canonical(normalized)


def _normalize_for_canonical_json(value: Any) -> Any:
    if value is None or isinstance(value, str) or isinstance(value, bool):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ApiError("validation", "JSON body contains a non-finite number")
        return value
    if isinstance(value, list):
        return [_normalize_for_canonical_json(item) for item in value]
    if isinstance(value, tuple):
        return [_normalize_for_canonical_json(item) for item in value]
    if isinstance(value, Mapping):
        return {
            str(key): _normalize_for_canonical_json(child)
            for key, child in sorted(value.items(), key=lambda item: str(item[0]))
            if child is not _UNDEFINED
        }
    raise ApiError("validation", "JSON body contains an unsupported value")


class _Undefined:
    pass


_UNDEFINED = _Undefined()


def _stringify_canonical(value: Any) -> str:
    if value is None or isinstance(value, str) or isinstance(value, bool):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return _stringify_js_number(value)
    if isinstance(value, list):
        return "[" + ",".join(_stringify_canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        parts = []
        for key in sorted(value):
            encoded_key = json.dumps(str(key), ensure_ascii=False, separators=(",", ":"))
            parts.append(f"{encoded_key}:{_stringify_canonical(value[key])}")
        return "{" + ",".join(parts) + "}"
    raise ApiError("validation", "JSON body contains an unsupported value")


def _stringify_js_number(value: float) -> str:
    if not math.isfinite(value):
        raise ApiError("validation", "JSON body contains a non-finite number")
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    text = format(value, ".15g")
    if "e" in text or "E" in text:
        mantissa, exponent = re.split("[eE]", text)
        exponent_number = int(exponent)
        return f"{mantissa}e{exponent_number:+d}".replace("e+", "e")
    return text


def signing_input(claims: Mapping[str, Any], payload: Mapping[str, Any]) -> str:
    return f"{canonical_json(claims)}.{canonical_json(payload)}"


def sign_envelope(claims: Mapping[str, Any], payload: Mapping[str, Any], secret: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        signing_input(claims, payload).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{API_SIGNATURE_PREFIX}{digest}"


def verify_signature(
    claims: Mapping[str, Any],
    payload: Mapping[str, Any],
    secret: str,
    received_signature: str,
) -> None:
    if not secret:
        raise ApiError("unauthorized", "SCORING_API_SECRET is not configured")
    if not received_signature:
        raise ApiError("unauthorized", "Missing signature")
    expected = sign_envelope(claims, payload, secret)
    if not hmac.compare_digest(received_signature, expected):
        raise ApiError("unauthorized", "Invalid signature")


def parse_envelope(body: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(body, dict):
        raise ApiError("validation", "Request envelope is required")
    claims = body.get("claims")
    payload = body.get("payload") or {}
    if not isinstance(claims, dict):
        raise ApiError("validation", "claims is required")
    if not isinstance(payload, dict):
        raise ApiError("validation", "payload must be an object")
    return claims, payload


def request_param(headers: Mapping[str, Any], query: Mapping[str, Any], key: str) -> str:
    candidates = [
        key,
        key.lower(),
        key.replace("-", "_"),
        key.replace("-", "").lower(),
    ]
    for source in (query, headers):
        for candidate in candidates:
            if candidate in source:
                value = source[candidate]
                if isinstance(value, list):
                    value = value[0] if value else ""
                return str(value or "")
    return ""


def assert_timestamp(claims: Mapping[str, Any], request_ts: str, now: int | None = None) -> None:
    try:
        ts = float(claims.get("ts"))
    except (TypeError, ValueError) as error:
        raise ApiError("unauthorized", "Invalid timestamp") from error
    if not math.isfinite(ts):
        raise ApiError("unauthorized", "Invalid timestamp")
    if request_ts and str(request_ts) != str(claims.get("ts")):
        raise ApiError("unauthorized", "Timestamp mismatch")
    now_seconds = int(time.time()) if now is None else now
    if abs(now_seconds - ts) > API_MAX_CLOCK_SKEW_SECONDS:
        raise ApiError("unauthorized", "Timestamp expired")


def assert_audience_and_action(
    claims: Mapping[str, Any], payload: Mapping[str, Any], route_action: str
) -> tuple[str, str]:
    if str(claims.get("aud") or "") not in API_AUDIENCES:
        raise ApiError("unauthorized", "Invalid audience")
    action = str(claims.get("action") or "").strip()
    if not action or action not in REQUIRED_ROLES:
        raise ApiError("validation", f"Unsupported action: {action}")
    if route_action and route_action != action:
        raise ApiError("unauthorized", "Action mismatch")
    if payload.get("action") and str(payload.get("action")) != action:
        raise ApiError("unauthorized", "Action mismatch")
    operation_id = operation_id_from(claims, payload)
    if claims.get("operationId") and payload.get("operationId"):
        if str(claims.get("operationId")) != str(payload.get("operationId")):
            raise ApiError("unauthorized", "operationId mismatch")
    if action in WRITE_ACTIONS and not operation_id:
        raise ApiError("validation", "operationId is required")
    if action == "uploadCandidateDocument" and not API_UUID_PATTERN.fullmatch(operation_id):
        raise ApiError("validation", "uploadCandidateDocument operationId must be a UUID")
    return action, operation_id


def operation_id_from(claims: Mapping[str, Any], payload: Mapping[str, Any]) -> str:
    return str(claims.get("operationId") or payload.get("operationId") or "").strip()


def candidate_id_from_payload(payload: Mapping[str, Any]) -> str:
    return str(payload.get("candidateId") or "").strip()


def serialize_for_api(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        return float(value)
    if isinstance(value, list):
        return [serialize_for_api(item) for item in value]
    if isinstance(value, dict):
        return {key: serialize_for_api(child) for key, child in value.items()}
    return value


def success_response(payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
    return {"ok": True, **serialize_for_api(dict(payload or {}))}


def error_response(error: Exception) -> dict[str, Any]:
    api_error = normalize_error(error)
    return {"ok": False, "error": {"code": api_error.code, "message": api_error.message}}


def normalize_error(error: Exception) -> ApiError:
    if isinstance(error, ApiError):
        return error
    message = str(error) or "Internal error"
    if re.search("not found", message, re.IGNORECASE):
        return ApiError("not_found", message)
    if re.search("already|duplicate|conflict", message, re.IGNORECASE):
        return ApiError("conflict", message)
    if re.search(
        "required|invalid|must be|unsupported|unresolved|undecided|変更|候補者|合否|職員番号",
        message,
        re.IGNORECASE,
    ):
        return ApiError("validation", message)
    return ApiError("internal", message)
