import base64

from src.scoresheet_recognizer import ScoresheetResult
from src.upload_recognition import recognize_upload_file, review_images_to_data_uris


# A tiny but valid PNG (1x1) so byte content is realistic.
_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def test_review_images_to_data_uris_encodes_png_bytes():
    result = review_images_to_data_uris({"s01": _PNG_BYTES})

    assert set(result) == {"s01"}
    expected = "data:image/png;base64," + base64.b64encode(_PNG_BYTES).decode("ascii")
    assert result["s01"] == expected


def test_review_images_to_data_uris_skips_empty_bytes():
    result = review_images_to_data_uris({"s01": _PNG_BYTES, "s02": b""})

    assert set(result) == {"s01"}


def test_review_images_to_data_uris_skips_oversized():
    # base64 length above the 30000-char cap must be dropped (degrade).
    huge = b"\x89PNG" + b"\x00" * 40_000
    result = review_images_to_data_uris({"s01": _PNG_BYTES, "s02": huge})

    assert set(result) == {"s01"}
    assert len(base64.b64encode(huge).decode("ascii")) > 30000


def test_to_recognition_payload_includes_per_cell_data_uris():
    result = ScoresheetResult(
        values={"s01": None},
        confidence_by_cell={"s01": 0.2},
        reasons={"s01": "low_confidence"},
        review_images={"s01": _PNG_BYTES},
        page_index=4,
    )

    payload = result.to_recognition_payload(review_images_to_data_uris(result.review_images))

    assert payload["imageLinks"]["s01"].startswith("data:image/png;base64,")


def test_recognize_upload_file_wires_review_image_data_uris(monkeypatch):
    fake = ScoresheetResult(
        values={"s01": None},
        confidence_by_cell={"s01": 0.2},
        reasons={"s01": "low_confidence"},
        review_images={"s01": _PNG_BYTES},
        page_index=4,
    )

    monkeypatch.setattr(
        "src.upload_recognition.recognize_scoresheet",
        lambda content, mime_type, page_index: fake,
    )

    payload = recognize_upload_file(
        {"name": "scoresheet.png", "mimeType": "image/png", "base64": base64.b64encode(_PNG_BYTES).decode("ascii")}
    )

    assert payload is not None
    assert payload["imageLinks"]["s01"].startswith("data:image/png;base64,")


def test_recognize_upload_file_handles_failure_path(monkeypatch):
    def boom(content, mime_type, page_index):
        raise RuntimeError("decode error")

    monkeypatch.setattr("src.upload_recognition.recognize_scoresheet", boom)

    payload = recognize_upload_file(
        {"name": "scoresheet.png", "mimeType": "image/png", "base64": base64.b64encode(_PNG_BYTES).decode("ascii")}
    )

    assert payload is not None
    assert payload["status"] == "failed"
    assert payload["imageLinks"] == {}
