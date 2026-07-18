import pytest

from src.config import env_flag


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on", " On "])
def test_env_flag_accepts_enabled_values(monkeypatch, value):
    monkeypatch.setenv("FEATURE_FLAG", value)

    assert env_flag("FEATURE_FLAG") is True


@pytest.mark.parametrize("value", ["", "0", "false", "no", "disabled"])
def test_env_flag_rejects_disabled_values(monkeypatch, value):
    monkeypatch.setenv("FEATURE_FLAG", value)

    assert env_flag("FEATURE_FLAG") is False
