from fastapi.testclient import TestClient

from main import app


def test_readyz_returns_ok():
    response = TestClient(app).get("/readyz")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_removed_dispatch_routes_reject_post_requests():
    client = TestClient(app)

    assert client.post("/", json={}).status_code == 404
    assert client.post("/api", json={}).status_code == 404
