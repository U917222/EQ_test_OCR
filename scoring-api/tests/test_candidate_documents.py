import base64
import hashlib
from datetime import datetime, timezone

import pytest

from src import candidate_documents


DOCUMENT_ID = "11111111-1111-4111-8111-111111111111"


def pdf_payload(name: str = "resume.pdf", content: bytes = b"%PDF-1.7\ndocument") -> dict[str, str]:
    return {
        "name": name,
        "mimeType": "application/pdf",
        "base64": base64.b64encode(content).decode("ascii"),
    }


def encoded_metadata(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def configure_r2(monkeypatch) -> None:
    monkeypatch.setenv("R2_ACCOUNT_ID", "account-123")
    monkeypatch.setenv("R2_BUCKET_NAME", "cheq-eqtest-files")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "access-key")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret-key")


class FakeR2Client:
    def __init__(self) -> None:
        self.put_calls: list[dict] = []
        self.list_calls: list[dict] = []
        self.head_calls: list[dict] = []
        self.delete_calls: list[dict] = []
        self.list_responses: list[dict] = []
        self.head_responses: dict[str, dict] = {}
        self.delete_failures: set[str] = set()

    def put_object(self, **kwargs):
        self.put_calls.append(kwargs)

    def list_objects_v2(self, **kwargs):
        self.list_calls.append(kwargs)
        return self.list_responses.pop(0) if self.list_responses else {"Contents": []}

    def head_object(self, **kwargs):
        self.head_calls.append(kwargs)
        return self.head_responses[kwargs["Key"]]

    def delete_object(self, **kwargs):
        self.delete_calls.append(kwargs)
        if kwargs["Key"] in self.delete_failures:
            raise RuntimeError("temporary delete failure")


def test_upload_candidate_document_uses_isolated_key_and_ascii_metadata(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(candidate_documents, "_r2_client", lambda: client)
    monkeypatch.setattr(candidate_documents, "now_iso", lambda: "2026-07-17T01:02:03+00:00")

    document = candidate_documents.upload_candidate_document(
        "cand-1",
        "resume",
        pdf_payload("履歴書 2026.pdf"),
        "operator@example.test",
        DOCUMENT_ID,
    )

    expected_key = (
        f"candidates/cand-1/documents/resume/{DOCUMENT_ID}/document-2026.pdf"
    )
    assert document == {
        "documentId": DOCUMENT_ID,
        "candidateId": "cand-1",
        "category": "resume",
        "filename": "履歴書 2026.pdf",
        "mimeType": "application/pdf",
        "sizeBytes": 17,
        "uploadedAt": "2026-07-17T01:02:03+00:00",
        "uploadedBy": "operator@example.test",
        "url": f"/files/r2/cand-1/documents/resume/{DOCUMENT_ID}/document-2026.pdf",
    }
    assert client.put_calls == [
        {
            "Bucket": "cheq-eqtest-files",
            "Key": expected_key,
            "Body": b"%PDF-1.7\ndocument",
            "ContentType": "application/pdf",
            "Metadata": {
                "candidateId": "cand-1",
                "documentId": DOCUMENT_ID,
                "category": "resume",
                "originalFilenameBase64": encoded_metadata("履歴書 2026.pdf"),
                "uploadedByBase64": encoded_metadata("operator@example.test"),
                "checksumSha256": hashlib.sha256(b"%PDF-1.7\ndocument").hexdigest(),
            },
            "StorageClass": "STANDARD",
        }
    ]


def test_upload_candidate_document_rejects_non_uuid_operation_id(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(candidate_documents, "_r2_client", lambda: client)

    with pytest.raises(Exception) as error:
        candidate_documents.upload_candidate_document(
            "cand-1", "other", pdf_payload(), "operator@example.test", "operation-not-a-uuid"
        )

    assert error.value.code == "validation"
    assert error.value.message == "operationId must be a UUID"
    assert client.put_calls == []


@pytest.mark.parametrize(
    ("category", "payload", "message"),
    [
        ("invalid", pdf_payload(), "category"),
        (
            "essay",
            {**pdf_payload(), "mimeType": "image/png"},
            "PDF",
        ),
        (
            "essay",
            pdf_payload(content=b"not a real PDF"),
            "%PDF-",
        ),
    ],
)
def test_upload_candidate_document_rejects_invalid_category_or_pdf(
    monkeypatch, category, payload, message
):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(candidate_documents, "_r2_client", lambda: client)

    with pytest.raises(Exception) as error:
        candidate_documents.upload_candidate_document(
            "cand-1", category, payload, "operator@example.test", DOCUMENT_ID
        )

    assert error.value.code == "validation"
    assert message in error.value.message
    assert client.put_calls == []


def test_upload_candidate_document_uses_the_existing_nine_mib_limit(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(candidate_documents, "_r2_client", lambda: client)
    monkeypatch.setattr(
        candidate_documents,
        "decode_upload_file",
        lambda payload: {
            "name": "large.pdf",
            "mime_type": "application/pdf",
            "bytes": b"%PDF-" + b"x" * (9 * 1024 * 1024 - 4),
        },
    )

    with pytest.raises(Exception) as error:
        candidate_documents.upload_candidate_document(
            "cand-1", "other", pdf_payload("large.pdf"), "operator@example.test", DOCUMENT_ID
        )

    assert error.value.code == "validation"
    assert str(9 * 1024 * 1024) in error.value.message
    assert client.put_calls == []


def test_list_candidate_documents_reads_all_pages_and_restores_metadata(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(candidate_documents, "_r2_client", lambda: client)
    essay_key = f"candidates/cand-1/documents/essay/{DOCUMENT_ID}/essay.pdf"
    other_id = "22222222-2222-4222-8222-222222222222"
    other_key = f"candidates/cand-1/documents/other/{other_id}/certificate.pdf"
    client.list_responses = [
        {
            "Contents": [
                {
                    "Key": essay_key,
                    "Size": 1200,
                    "LastModified": datetime(2026, 7, 16, 1, tzinfo=timezone.utc),
                }
            ],
            "IsTruncated": True,
            "NextContinuationToken": "page-2",
        },
        {
            "Contents": [
                {
                    "Key": other_key,
                    "Size": 2400,
                    "LastModified": datetime(2026, 7, 17, 1, tzinfo=timezone.utc),
                },
                {"Key": "candidates/cand-1/documents/bad/not-a-document"},
            ],
            "IsTruncated": False,
        },
    ]
    # S3-compatible APIs return custom metadata keys lower-cased.
    client.head_responses = {
        essay_key: {
            "ContentLength": 1200,
            "ContentType": "application/pdf",
            "Metadata": {
                "originalfilenamebase64": encoded_metadata("作文.pdf"),
                "uploadedbybase64": encoded_metadata("writer@example.test"),
            },
        },
        other_key: {
            "ContentLength": 2400,
            "ContentType": "application/pdf",
            "Metadata": {
                "originalFilenameBase64": encoded_metadata("資格証明.pdf"),
            },
        },
    }

    documents = candidate_documents.list_candidate_documents("cand-1")

    assert [document["filename"] for document in documents] == ["資格証明.pdf", "作文.pdf"]
    assert documents[1] == {
        "documentId": DOCUMENT_ID,
        "candidateId": "cand-1",
        "category": "essay",
        "filename": "作文.pdf",
        "mimeType": "application/pdf",
        "sizeBytes": 1200,
        "uploadedAt": "2026-07-16T01:00:00+00:00",
        "uploadedBy": "writer@example.test",
        "url": f"/files/r2/cand-1/documents/essay/{DOCUMENT_ID}/essay.pdf",
    }
    assert client.list_calls == [
        {"Bucket": "cheq-eqtest-files", "Prefix": "candidates/cand-1/documents/"},
        {
            "Bucket": "cheq-eqtest-files",
            "Prefix": "candidates/cand-1/documents/",
            "ContinuationToken": "page-2",
        },
    ]
    assert [call["Key"] for call in client.head_calls] == [essay_key, other_key]


def test_delete_candidate_document_is_scoped_by_candidate_and_document_id(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(candidate_documents, "_r2_client", lambda: client)
    target = f"candidates/cand-1/documents/resume/{DOCUMENT_ID}/resume.pdf"
    other = (
        "candidates/cand-1/documents/resume/"
        "22222222-2222-4222-8222-222222222222/other.pdf"
    )
    client.list_responses = [
        {
            "Contents": [
                {"Key": target},
                {"Key": other},
                {"Key": f"candidates/cand-1/{DOCUMENT_ID}/scoresheet.pdf"},
            ],
            "IsTruncated": False,
        }
    ]

    deleted = candidate_documents.delete_candidate_document("cand-1", DOCUMENT_ID)

    assert deleted is True
    assert client.delete_calls == [{"Bucket": "cheq-eqtest-files", "Key": target}]


def test_delete_all_candidate_documents_is_best_effort_per_object(monkeypatch):
    configure_r2(monkeypatch)
    client = FakeR2Client()
    monkeypatch.setattr(candidate_documents, "_r2_client", lambda: client)
    first = f"candidates/cand-1/documents/resume/{DOCUMENT_ID}/resume.pdf"
    second = (
        "candidates/cand-1/documents/other/"
        "22222222-2222-4222-8222-222222222222/other.pdf"
    )
    client.list_responses = [
        {"Contents": [{"Key": first}, {"Key": second}], "IsTruncated": False}
    ]
    client.delete_failures.add(second)

    result = candidate_documents.delete_all_candidate_documents("cand-1")

    assert result == {"deleted": 1, "failed": 1}
    assert [call["Key"] for call in client.delete_calls] == [first, second]
