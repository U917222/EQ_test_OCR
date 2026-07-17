"""合成したマークシート画像で認識処理を検証する。"""

import pytest

from src.recognizer import REVIEW_CONFIDENCE, empty_result, recognize_sheet
from src.sample import make_synthetic_sheet
from src.sheet_layout import CHOICES, QUESTION_COUNT, question_key


def test_recognizes_marked_answers():
    marks = {question_key(n): CHOICES[n % len(CHOICES)] for n in range(1, QUESTION_COUNT + 1)}
    result = recognize_sheet(make_synthetic_sheet(marks))

    assert result.answers == marks
    assert all(c >= REVIEW_CONFIDENCE for c in result.confidence_by_question.values())
    assert result.review_images == {}


def test_blank_question_goes_to_review():
    blank = {question_key(7), question_key(150)}
    marks = {question_key(n): "b" for n in range(1, QUESTION_COUNT + 1)}
    result = recognize_sheet(make_synthetic_sheet(marks, blank=blank))

    for qkey in blank:
        assert result.answers[qkey] == ""
        assert result.confidence_by_question[qkey] < REVIEW_CONFIDENCE
        assert qkey in result.review_images
        assert result.review_images[qkey]  # PNGが切り出されている


def test_payload_shape_matches_recognition_contract():
    result = empty_result()
    payload = result.to_recognition_payload({"q001": "https://example.com"})

    assert set(payload.keys()) == {"answers", "confidenceByQuestion", "imageLinks"}
    assert len(payload["answers"]) == QUESTION_COUNT
    assert payload["imageLinks"]["q001"] == "https://example.com"


def test_undecodable_image_raises():
    from src.recognizer import RecognitionError

    with pytest.raises(RecognitionError):
        recognize_sheet(b"not an image", "image/png")
