from fastapi.testclient import TestClient

import main


DRIVE_ID = "a" * 20
REQUEST_PAYLOAD = {
    "candidateId": "cand-1",
    "sourceUrl": f"https://drive.google.com/file/d/{DRIVE_ID}/view",
    "callbackUrl": "https://script.google.com/macros/s/callback-id/exec",
}


def _clear_security_env(monkeypatch):
    for name in (
        "ALLOW_INSECURE_DEV_AUTH",
        "RECOGNITION_API_KEY",
        "RECOGNITION_CALLBACK_ALLOWED_HOSTS",
        "RECOGNITION_CALLBACK_URL",
        "RECOGNITION_WEBHOOK_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)


def test_recognize_fails_closed_when_api_key_is_missing(monkeypatch):
    _clear_security_env(monkeypatch)
    client = TestClient(main.app)

    response = client.post("/recognize", json=REQUEST_PAYLOAD)

    assert response.status_code == 503
    assert response.json()["detail"] == "RECOGNITION_API_KEY is not configured"


def test_recognize_rejects_missing_bearer_token(monkeypatch):
    _clear_security_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_API_KEY", "secret-key")
    client = TestClient(main.app)

    response = client.post("/recognize", json=REQUEST_PAYLOAD)

    assert response.status_code == 401
    assert response.json()["detail"] == "invalid bearer token"


def test_recognize_rejects_invalid_bearer_token(monkeypatch):
    _clear_security_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_API_KEY", "secret-key")
    client = TestClient(main.app)

    response = client.post(
        "/recognize",
        json=REQUEST_PAYLOAD,
        headers={"Authorization": "Bearer wrong-key"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "invalid bearer token"


def test_recognize_accepts_valid_bearer_token(monkeypatch):
    _clear_security_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_API_KEY", "secret-key")
    monkeypatch.setenv("RECOGNITION_CALLBACK_ALLOWED_HOSTS", "script.google.com")
    accepted = []
    monkeypatch.setattr(
        main,
        "_process_and_callback",
        lambda request, callback_url: accepted.append((request.candidateId, callback_url)),
    )
    client = TestClient(main.app)

    response = client.post(
        "/recognize",
        json=REQUEST_PAYLOAD,
        headers={"Authorization": "Bearer secret-key"},
    )

    assert response.status_code == 202
    assert response.json() == {"ok": True, "accepted": True, "candidateId": "cand-1"}
    assert accepted == [("cand-1", REQUEST_PAYLOAD["callbackUrl"])]


def test_recognize_allows_explicit_insecure_dev_auth(monkeypatch):
    _clear_security_env(monkeypatch)
    monkeypatch.setenv("ALLOW_INSECURE_DEV_AUTH", "true")
    monkeypatch.setenv("RECOGNITION_CALLBACK_ALLOWED_HOSTS", "script.google.com")
    monkeypatch.setattr(main, "_process_and_callback", lambda request, callback_url: None)
    client = TestClient(main.app)

    response = client.post("/recognize", json=REQUEST_PAYLOAD)

    assert response.status_code == 202


def test_recognize_rejects_negative_page_index(monkeypatch):
    _clear_security_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_API_KEY", "secret-key")
    monkeypatch.setenv("RECOGNITION_CALLBACK_ALLOWED_HOSTS", "script.google.com")
    client = TestClient(main.app)

    response = client.post(
        "/recognize",
        json={**REQUEST_PAYLOAD, "pageIndex": -1},
        headers={"Authorization": "Bearer secret-key"},
    )

    assert response.status_code == 422


def test_process_and_callback_sends_structured_failure_for_rejected_drive_file(monkeypatch):
    request = main.RecognizeRequest(**REQUEST_PAYLOAD)
    sent = {}

    def reject_drive_file(source_url):
        raise main.drive_client.DriveFileRejectedError("file_too_large", "Drive file is too large")

    def capture_callback(callback_url, candidate_id, recognition):
        sent.update(
            {
                "callback_url": callback_url,
                "candidate_id": candidate_id,
                "recognition": recognition,
            }
        )

    monkeypatch.setattr(main.drive_client, "download_drive_file", reject_drive_file)
    monkeypatch.setattr(main, "post_recognition_result", capture_callback)

    main._process_and_callback(request, REQUEST_PAYLOAD["callbackUrl"])

    assert sent["callback_url"] == REQUEST_PAYLOAD["callbackUrl"]
    assert sent["candidate_id"] == "cand-1"
    assert sent["recognition"]["status"] == "failed"
    assert sent["recognition"]["error"]["code"] == "file_too_large"
    assert sent["recognition"]["cells"]["s01"]["reason"] == "file_too_large"
