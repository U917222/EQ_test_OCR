from datetime import date, datetime, timezone
from decimal import Decimal

from src.wire import ApiError, error_response, normalize_error, serialize_for_api, success_response


def test_serialize_for_api_converts_supported_values():
    value = {
        "date": date(2026, 7, 1),
        "timestamp": datetime(2026, 7, 1, 12, 30, tzinfo=timezone.utc),
        "whole": Decimal("3"),
        "fraction": Decimal("2.5"),
    }

    assert serialize_for_api(value) == {
        "date": "2026-07-01",
        "timestamp": "2026-07-01T12:30:00+00:00",
        "whole": 3,
        "fraction": 2.5,
    }


def test_response_helpers_preserve_api_error_contract():
    error = ApiError("validation", "candidate is required")

    assert success_response({"value": Decimal("4")}) == {"ok": True, "value": 4}
    assert error_response(error) == {
        "ok": False,
        "error": {"code": "validation", "message": "candidate is required"},
    }
    assert normalize_error(error) is error
