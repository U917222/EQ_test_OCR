import base64

from fastapi.testclient import TestClient

import main
from src.scoresheet_recognizer import ScoresheetResult


VALID_BASE64 = base64.b64encode(b"fake-image-bytes").decode("ascii")
SYNC_PAYLOAD = {
    "file": {"base64": VALID_BASE64, "mimeType": "image/png", "name": "sheet.png"},
    "pageIndex": 4,
}


def _clear_security_env(monkeypatch):
    for name in (
        "ALLOW_INSECURE_DEV_AUTH",
        "RECOGNITION_API_KEY",
        "RECOGNITION_ALLOWED_MIME_TYPES",
        "RECOGNITION_MAX_FILE_BYTES",
    ):
        monkeypatch.delenv(name, raising=False)


def test_recognize_sync_fails_closed_when_api_key_is_missing(monkeypatch):
    _clear_security_env(monkeypatch)
    client = TestClient(main.app)

    response = client.post("/recognize-sync", json=SYNC_PAYLOAD)

    assert response.status_code == 503
    assert response.json()["detail"] == "RECOGNITION_API_KEY is not configured"


def test_recognize_sync_rejects_missing_bearer_token(monkeypatch):
    _clear_security_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_API_KEY", "secret-key")
    client = TestClient(main.app)

    response = client.post("/recognize-sync", json=SYNC_PAYLOAD)

    assert response.status_code in (401, 403)


def test_recognize_sync_rejects_invalid_bearer_token(monkeypatch):
    _clear_security_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_API_KEY", "secret-key")
    client = TestClient(main.app)

    response = client.post(
        "/recognize-sync",
        json=SYNC_PAYLOAD,
        headers={"Authorization": "Bearer wrong-key"},
    )

    assert response.status_code in (401, 403)


def test_recognize_sync_returns_recognition_on_success(monkeypatch):
    _clear_security_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_API_KEY", "secret-key")
    captured: dict = {}

    def fake_recognize(content, mime_type, page_index):
        captured["mime_type"] = mime_type
        captured["page_index"] = page_index
        return ScoresheetResult(
            values={"s01": 2, "s02": None},
            confidence_by_cell={"s01": 0.95, "s02": 0.1},
            reasons={"s02": "blank"},
            page_index=4,
        )

    monkeypatch.setattr(main, "recognize_scoresheet", fake_recognize)
    client = TestClient(main.app)

    response = client.post(
        "/recognize-sync",
        json=SYNC_PAYLOAD,
        headers={"Authorization": "Bearer secret-key"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    recognition = body["recognition"]
    assert recognition["cells"]["s01"]["value"] == 2
    assert recognition["cells"]["s02"]["value"] is None
    assert recognition["cells"]["s02"]["reason"] == "blank"
    assert recognition["sheet"] == "cheq-scoresheet-p5"
    assert recognition["pageIndex"] == 4
    assert "status" not in recognition  # 成功時は failure マーカーが付かない
    assert captured["mime_type"] == "image/png"
    assert captured["page_index"] == 4


def test_recognize_sync_degrades_to_failure_payload_on_recognizer_error(monkeypatch):
    _clear_security_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_API_KEY", "secret-key")

    def boom(content, mime_type, page_index):
        raise RuntimeError("unexpected failure")

    monkeypatch.setattr(main, "recognize_scoresheet", boom)
    client = TestClient(main.app)

    response = client.post(
        "/recognize-sync",
        json=SYNC_PAYLOAD,
        headers={"Authorization": "Bearer secret-key"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    recognition = body["recognition"]
    assert recognition["status"] == "failed"
    # どのセルも黙って欠落させず、全80セルを未確定で返す。
    assert len(recognition["cells"]) == 80
    assert recognition["cells"]["s01"]["value"] is None
