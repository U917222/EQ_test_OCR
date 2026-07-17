from src.config import Settings


def test_scoring_api_secret_prefers_new_name(monkeypatch):
    monkeypatch.setenv("SCORING_API_SECRET", "new-secret")
    monkeypatch.setenv("FUNCTIONS_GAS_SECRET", "legacy-secret")

    assert Settings.from_env().scoring_api_secret == "new-secret"


def test_scoring_api_secret_falls_back_to_legacy_name(monkeypatch):
    monkeypatch.delenv("SCORING_API_SECRET", raising=False)
    monkeypatch.setenv("FUNCTIONS_GAS_SECRET", "legacy-secret")

    assert Settings.from_env().scoring_api_secret == "legacy-secret"
