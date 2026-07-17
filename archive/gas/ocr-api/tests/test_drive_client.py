import pytest

from src import drive_client


def _clear_drive_env(monkeypatch):
    for name in ("RECOGNITION_ALLOWED_MIME_TYPES", "RECOGNITION_MAX_FILE_BYTES"):
        monkeypatch.delenv(name, raising=False)


def test_drive_metadata_rejects_unsupported_mime_type(monkeypatch):
    _clear_drive_env(monkeypatch)

    with pytest.raises(drive_client.DriveFileRejectedError) as excinfo:
        drive_client.validate_drive_file_metadata({"mimeType": "text/html", "size": "100"})

    assert excinfo.value.code == "unsupported_mime_type"


def test_drive_metadata_rejects_missing_size(monkeypatch):
    _clear_drive_env(monkeypatch)

    with pytest.raises(drive_client.DriveFileRejectedError) as excinfo:
        drive_client.validate_drive_file_metadata({"mimeType": "image/png"})

    assert excinfo.value.code == "missing_file_size"


def test_drive_metadata_rejects_file_over_byte_limit(monkeypatch):
    _clear_drive_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_MAX_FILE_BYTES", "10")

    with pytest.raises(drive_client.DriveFileRejectedError) as excinfo:
        drive_client.validate_drive_file_metadata({"mimeType": "image/png", "size": "11"})

    assert excinfo.value.code == "file_too_large"


def test_download_rejects_before_media_request(monkeypatch):
    _clear_drive_env(monkeypatch)
    monkeypatch.setenv("RECOGNITION_MAX_FILE_BYTES", "10")

    class FakeExecuteRequest:
        def execute(self):
            return {"mimeType": "image/png", "name": "large.png", "size": "11"}

    class FakeFiles:
        media_requested = False

        def get(self, **kwargs):
            return FakeExecuteRequest()

        def get_media(self, **kwargs):
            self.media_requested = True
            raise AssertionError("get_media should not be called for rejected files")

    class FakeService:
        def __init__(self):
            self.files_obj = FakeFiles()

        def files(self):
            return self.files_obj

    service = FakeService()
    fake_files = service.files_obj
    monkeypatch.setattr(drive_client, "_service", lambda: service)

    with pytest.raises(drive_client.DriveFileRejectedError) as excinfo:
        drive_client.download_drive_file("https://drive.google.com/file/d/" + "a" * 20 + "/view")

    assert excinfo.value.code == "file_too_large"
    assert fake_files.media_requested is False
