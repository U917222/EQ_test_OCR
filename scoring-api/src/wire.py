"""Response serialization and error normalization for the PDF API."""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Mapping


class ApiError(Exception):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


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
