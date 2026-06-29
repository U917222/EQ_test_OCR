from fastapi.testclient import TestClient

from main import app


def test_readyz_returns_ok():
    response = TestClient(app).get("/readyz")

    assert response.status_code == 200
    assert response.json() == {"ok": True}
