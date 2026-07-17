import pytest

from src.upload_validation import allowed_mime_types, max_file_bytes


def test_allowed_mime_types_uses_safe_defaults(monkeypatch):
    monkeypatch.delenv("RECOGNITION_ALLOWED_MIME_TYPES", raising=False)

    assert allowed_mime_types() == {
        "application/pdf",
        "image/jpeg",
        "image/png",
    }


def test_allowed_mime_types_reads_comma_separated_override(monkeypatch):
    monkeypatch.setenv("RECOGNITION_ALLOWED_MIME_TYPES", " image/png, application/pdf ")

    assert allowed_mime_types() == {"image/png", "application/pdf"}


@pytest.mark.parametrize("value", ["invalid", "0", "-1"])
def test_max_file_bytes_rejects_invalid_configuration(monkeypatch, value):
    monkeypatch.setenv("RECOGNITION_MAX_FILE_BYTES", value)

    with pytest.raises(ValueError):
        max_file_bytes()
