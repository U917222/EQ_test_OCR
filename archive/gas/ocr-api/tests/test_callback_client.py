import hashlib
import hmac
import json
from urllib.parse import parse_qs, urlparse

import pytest

from src import callback_client


def _clear_callback_env(monkeypatch):
    for name in (
        "RECOGNITION_CALLBACK_ALLOWED_HOSTS",
        "RECOGNITION_CALLBACK_URL",
        "RECOGNITION_WEBHOOK_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)


def test_request_supplied_callback_requires_allowlist(monkeypatch):
    _clear_callback_env(monkeypatch)

    with pytest.raises(callback_client.CallbackValidationError) as excinfo:
        callback_client.resolve_callback_url("https://script.google.com/macros/s/id/exec")

    assert excinfo.value.code == "callback_allowlist_missing"


def test_callback_url_must_be_https(monkeypatch):
    _clear_callback_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_CALLBACK_ALLOWED_HOSTS", "script.google.com")

    with pytest.raises(callback_client.CallbackValidationError) as excinfo:
        callback_client.resolve_callback_url("http://script.google.com/macros/s/id/exec")

    assert excinfo.value.code == "callback_url_not_https"


def test_callback_host_allowlist_is_exact(monkeypatch):
    _clear_callback_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_CALLBACK_ALLOWED_HOSTS", "script.google.com")

    assert (
        callback_client.resolve_callback_url("https://script.google.com/macros/s/id/exec")
        == "https://script.google.com/macros/s/id/exec"
    )
    with pytest.raises(callback_client.CallbackValidationError) as excinfo:
        callback_client.resolve_callback_url("https://evil.script.google.com/macros/s/id/exec")

    assert excinfo.value.code == "callback_host_not_allowed"


def test_server_configured_callback_url_overrides_request(monkeypatch):
    _clear_callback_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_CALLBACK_URL", "https://script.google.com/macros/s/server/exec")

    assert (
        callback_client.resolve_callback_url("https://example.com/request/exec")
        == "https://script.google.com/macros/s/server/exec"
    )


def test_post_recognition_result_uses_hmac_query_signature_not_body_secret(monkeypatch):
    _clear_callback_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_CALLBACK_ALLOWED_HOSTS", "script.google.com")
    monkeypatch.setenv("RECOGNITION_WEBHOOK_SECRET", "webhook-secret")
    captured = {}

    class FakeResponse:
        text = '{"ok":true}'

        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True}

    def fake_post(url, data, headers, timeout):
        captured.update({"url": url, "data": data, "headers": headers, "timeout": timeout})
        return FakeResponse()

    monkeypatch.setattr(callback_client.requests, "post", fake_post)

    body = callback_client.post_recognition_result(
        "https://script.google.com/macros/s/id/exec",
        "cand-1",
        {"status": "failed", "error": {"code": "file_too_large"}},
    )

    assert body == {"ok": True}
    payload = json.loads(captured["data"].decode("utf-8"))
    assert payload["action"] == "recognitionResult"
    assert payload["candidateId"] == "cand-1"
    assert "secret" not in payload
    parsed = urlparse(captured["url"])
    query = parse_qs(parsed.query)
    timestamp = query[callback_client.TIMESTAMP_QUERY_PARAM][0]
    expected = hmac.new(
        b"webhook-secret",
        timestamp.encode("ascii") + b"." + captured["data"],
        hashlib.sha256,
    ).hexdigest()
    assert query[callback_client.SIGNATURE_QUERY_PARAM] == [f"sha256={expected}"]
    assert captured["headers"]["Content-Type"] == "application/json"
