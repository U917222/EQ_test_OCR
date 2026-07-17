import hashlib

import pytest

from src import upload_storage


class FakeR2Client:
    def __init__(self):
        self.put_calls = []
        self.list_calls = []
        self.delete_calls = []
        self.list_responses = []
        self.delete_failures = set()

    def put_object(self, **kwargs):
        self.put_calls.append(kwargs)

    def list_objects_v2(self, **kwargs):
        self.list_calls.append(kwargs)
        return self.list_responses.pop(0) if self.list_responses else {"Contents": []}

    def delete_object(self, **kwargs):
        self.delete_calls.append(kwargs)
        if kwargs["Key"] in self.delete_failures:
            raise RuntimeError("temporary delete failure")


class FakeDriveService:
    def __init__(self):
        self.create_kwargs = None

    def files(self):
        return self

    def create(self, **kwargs):
        self.create_kwargs = kwargs
        return self

    def execute(self):
        return {
            "id": "drive-file-1",
            "webViewLink": "https://drive.google.com/file/d/drive-file-1/view",
        }


def configure_r2(monkeypatch):
    monkeypatch.setenv("SCORING_UPLOAD_BACKEND", "r2")
    monkeypatch.setenv("R2_ACCOUNT_ID", "account-123")
    monkeypatch.setenv("R2_BUCKET_NAME", "cheq-eqtest-files")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "access-key")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret-key")


def test_drive_remains_the_default_upload_backend(monkeypatch):
    monkeypatch.delenv("SCORING_UPLOAD_BACKEND", raising=False)
    monkeypatch.setenv("SCORING_UPLOAD_DRIVE_FOLDER_ID", "drive-folder-1")
    service = FakeDriveService()
    monkeypatch.setattr(upload_storage, "_service", lambda: service)

    result = upload_storage.save_upload_file(
        {"name": "sheet.pdf", "mimeType": "application/pdf", "base64": "SGVsbG8="},
        "cand-1",
    )

    assert result == {
        "sourceUrl": "https://drive.google.com/file/d/drive-file-1/view",
        "mimeType": "application/pdf",
    }
    assert service.create_kwargs["body"] == {
        "name": "cand-1_sheet.pdf",
        "mimeType": "application/pdf",
        "parents": ["drive-folder-1"],
    }


def test_r2_upload_returns_authenticated_relative_url_and_metadata(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(upload_storage, "_r2_client", lambda: client)
    monkeypatch.setattr(upload_storage.uuid, "uuid4", lambda: "11111111-1111-4111-8111-111111111111")

    result = upload_storage.save_upload_file(
        {
            "name": "採点 用紙.pdf",
            "mimeType": "application/pdf",
            "base64": "SGVsbG8=",
        },
        "cand-1",
    )

    expected_name = "cand-1_scoresheet.pdf"
    expected_key = f"candidates/cand-1/11111111-1111-4111-8111-111111111111/{expected_name}"
    assert result == {
        "sourceUrl": f"/files/r2/cand-1/11111111-1111-4111-8111-111111111111/{expected_name}",
        "mimeType": "application/pdf",
    }
    assert client.put_calls == [
        {
            "Bucket": "cheq-eqtest-files",
            "Key": expected_key,
            "Body": b"Hello",
            "ContentType": "application/pdf",
            "Metadata": {
                "candidate-id": "cand-1",
                "file-id": "11111111-1111-4111-8111-111111111111",
                "checksum-sha256": hashlib.sha256(b"Hello").hexdigest(),
            },
            "StorageClass": "STANDARD",
        }
    ]


def test_r2_upload_requires_all_credentials(monkeypatch):
    configure_r2(monkeypatch)
    monkeypatch.delenv("R2_SECRET_ACCESS_KEY")

    with pytest.raises(Exception) as error:
        upload_storage.save_upload_file(
            {"name": "sheet.pdf", "mimeType": "application/pdf", "base64": "SGVsbG8="},
            "cand-1",
        )

    assert error.value.code == "validation"
    assert "R2_SECRET_ACCESS_KEY" in error.value.message


def test_unknown_upload_backend_is_rejected(monkeypatch):
    monkeypatch.setenv("SCORING_UPLOAD_BACKEND", "unknown")

    with pytest.raises(Exception) as error:
        upload_storage.save_upload_file(
            {"name": "sheet.pdf", "mimeType": "application/pdf", "base64": "SGVsbG8="},
            "cand-1",
        )

    assert error.value.code == "validation"
    assert "SCORING_UPLOAD_BACKEND" in error.value.message


def test_r2_upload_truncates_long_filename_to_a_servable_length(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(upload_storage, "_r2_client", lambda: client)

    result = upload_storage.save_upload_file(
        {"name": f"{'a' * 400}.pdf", "mimeType": "application/pdf", "base64": "SGVsbG8="},
        "cand-1",
    )

    filename = result["sourceUrl"].rsplit("/", 1)[-1]
    assert len(filename) <= 255
    assert filename.endswith(".pdf")
    assert client.put_calls[0]["Key"].endswith(filename)


def test_delete_r2_upload_uses_key_from_issued_source_url(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(upload_storage, "_r2_client", lambda: client)

    deleted = upload_storage.delete_upload_file(
        "/files/r2/cand-1/11111111-1111-4111-8111-111111111111/cand-1_scoresheet.pdf"
    )

    assert deleted is True
    assert client.delete_calls == [
        {
            "Bucket": "cheq-eqtest-files",
            "Key": "candidates/cand-1/11111111-1111-4111-8111-111111111111/cand-1_scoresheet.pdf",
        }
    ]


@pytest.mark.parametrize(
    "source_url",
    [
        "https://drive.google.com/file/d/example/view",
        "/files/r2/cand-1/not-a-uuid/sheet.pdf",
        "/files/r2/cand-1/11111111-1111-4111-8111-111111111111/../secret.pdf",
        "https://example.com/files/r2/cand-1/11111111-1111-4111-8111-111111111111/sheet.pdf",
    ],
)
def test_delete_upload_ignores_non_r2_or_invalid_urls(monkeypatch, source_url):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(upload_storage, "_r2_client", lambda: client)

    assert upload_storage.delete_upload_file(source_url) is False
    assert client.delete_calls == []


def test_delete_candidate_scoresheet_uploads_pages_and_excludes_documents_and_other_candidates(
    monkeypatch,
):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(upload_storage, "_r2_client", lambda: client)
    first_id = "11111111-1111-4111-8111-111111111111"
    second_id = "22222222-2222-4222-8222-222222222222"
    first_key = f"candidates/cand-1/{first_id}/cand-1_scoresheet.pdf"
    second_key = f"candidates/cand-1/{second_id}/cand-1_scoresheet-2.pdf"
    document_key = f"candidates/cand-1/documents/resume/{first_id}/resume.pdf"
    other_candidate_key = f"candidates/cand-2/{first_id}/cand-2_scoresheet.pdf"
    client.list_responses = [
        {
            "Contents": [
                {"Key": first_key},
                {"Key": document_key},
                {"Key": other_candidate_key},
                {"Key": "candidates/cand-1/not-a-uuid/invalid.pdf"},
                {"Key": f"candidates/cand-1/{first_id}/../secret.pdf"},
            ],
            "IsTruncated": True,
            "NextContinuationToken": "page-2",
        },
        {"Contents": [{"Key": second_key}], "IsTruncated": False},
    ]
    client.delete_failures.add(second_key)

    result = upload_storage.delete_candidate_scoresheet_uploads("cand-1")

    assert result == {"deleted": 1, "failed": 1}
    assert client.list_calls == [
        {"Bucket": "cheq-eqtest-files", "Prefix": "candidates/cand-1/"},
        {
            "Bucket": "cheq-eqtest-files",
            "Prefix": "candidates/cand-1/",
            "ContinuationToken": "page-2",
        },
    ]
    assert client.delete_calls == [
        {"Bucket": "cheq-eqtest-files", "Key": first_key},
        {"Bucket": "cheq-eqtest-files", "Key": second_key},
    ]


def test_delete_candidate_scoresheet_uploads_rejects_unsafe_candidate_id(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(upload_storage, "_r2_client", lambda: client)

    with pytest.raises(Exception) as error:
        upload_storage.delete_candidate_scoresheet_uploads("../cand-1")

    assert error.value.code == "validation"
    assert client.list_calls == []
    assert client.delete_calls == []
