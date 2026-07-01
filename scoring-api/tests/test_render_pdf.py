import base64

import pytest
from fastapi.testclient import TestClient

from main import app


def _candidate():
    return {
        "name": "テストやろう",
        "candidate_id": "cand-1",
        "test_date": "2026-06-24",
    }


def _result():
    return {
        "total_rank": "B",
        "response_attitude_stage": 3,
        "attitude_minus_points": 0,
        "minus_points": 0,
        "job_requirement_minus_points": 0,
        "item_stages": {
            "①セルフコントロール": 4,
            "②コミュニケーション": 3,
            "③状況認識力": 2,
        },
        "item_totals": {
            "①セルフコントロール": 14,
            "②コミュニケーション": 11,
            "③状況認識力": 8,
        },
        "job_requirement_low_items": [],
        "cross_check": [],
    }


def _payload():
    return {"candidate": _candidate(), "result": _result(), "rawCellSummary": {"unresolved_count": 0}}


def test_render_pdf_returns_503_when_key_unset(monkeypatch):
    monkeypatch.delenv("PDF_RENDER_KEY", raising=False)
    monkeypatch.delenv("ALLOW_INSECURE_DEV_AUTH", raising=False)

    response = TestClient(app).post("/render-pdf", json=_payload())

    assert response.status_code == 503
    assert response.json()["ok"] is False


def test_render_pdf_rejects_missing_or_bad_bearer(monkeypatch):
    monkeypatch.setenv("PDF_RENDER_KEY", "secret-key")
    monkeypatch.delenv("ALLOW_INSECURE_DEV_AUTH", raising=False)
    client = TestClient(app)

    missing = client.post("/render-pdf", json=_payload())
    assert missing.status_code == 401

    wrong = client.post(
        "/render-pdf",
        headers={"Authorization": "Bearer nope"},
        json=_payload(),
    )
    assert wrong.status_code == 401


def test_render_pdf_happy_path(monkeypatch):
    monkeypatch.setenv("PDF_RENDER_KEY", "secret-key")
    monkeypatch.delenv("ALLOW_INSECURE_DEV_AUTH", raising=False)

    # WeasyPrint needs system libraries that may be absent in CI; skip if so.
    try:
        from src.pdf import build_result_pdf

        build_result_pdf(_candidate(), _result(), {"unresolved_count": 0})
    except OSError as error:
        pytest.skip(f"WeasyPrint system dependency is unavailable: {error}")

    response = TestClient(app).post(
        "/render-pdf",
        headers={"Authorization": "Bearer secret-key"},
        json=_payload(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["mimeType"] == "application/pdf"
    assert body["filename"] == "CHEQ_テストやろう.pdf"
    assert body["base64"]
    decoded = base64.b64decode(body["base64"])
    assert decoded[:4] == b"%PDF"
