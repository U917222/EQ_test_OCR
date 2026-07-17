"""合成した採点表(page.5)画像で○検出を検証する。

セル契約は docs/cell-contract.md を正とする:
  - セルキー s01〜s80、値は 0〜3 の整数、判定不能は None + reason。
"""

import pytest

from src.recognizer import RecognitionError
from src.scoresheet_layout import ALL_CELL_KEYS, cell_key
from src.scoresheet_recognizer import (
    MAX_PDF_RENDER_DIMENSION,
    PDF_RENDER_SCALE,
    REVIEW_CONFIDENCE,
    _validate_pdf_render_size,
    failed_scoresheet_result,
    recognize_scoresheet,
    select_scoresheet_page,
)
from src.scoresheet_sample import make_synthetic_scoresheet


def _all_values() -> dict[str, int]:
    """80セルに決定的に 0..3 を割り当てる。"""
    return {key: (i * 7) % 4 for i, key in enumerate(ALL_CELL_KEYS)}


def test_cell_keys_follow_contract():
    assert cell_key(0, "A", 1) == "s01"
    assert cell_key(0, "B", 1) == "s05"
    assert cell_key(0, "J", 4) == "s40"
    assert cell_key(1, "A", 1) == "s41"
    assert cell_key(1, "J", 4) == "s80"
    assert len(ALL_CELL_KEYS) == 80


def test_recognizes_circled_values():
    values = _all_values()
    result = recognize_scoresheet(make_synthetic_scoresheet(values))

    assert result.values == values
    assert all(c >= REVIEW_CONFIDENCE for c in result.confidence_by_cell.values())
    assert result.review_images == {}


def test_blank_cell_goes_to_review():
    values = _all_values()
    blank = {"s01", "s44"}
    result = recognize_scoresheet(make_synthetic_scoresheet(values, blank=blank))

    for key in blank:
        assert result.values[key] is None
        assert result.reasons[key] == "blank"
        assert result.confidence_by_cell[key] < REVIEW_CONFIDENCE
        assert result.review_images[key]  # PNGが切り出されている
    # 他のセルは影響を受けない
    others = {k: v for k, v in result.values.items() if k not in blank}
    assert others == {k: v for k, v in values.items() if k not in blank}


def test_double_circle_goes_to_review():
    values = _all_values()
    result = recognize_scoresheet(
        make_synthetic_scoresheet(values, extra_circles={"s10": 1})
    )

    assert result.values["s10"] is None
    assert result.reasons["s10"] == "multiple"
    assert result.confidence_by_cell["s10"] < REVIEW_CONFIDENCE
    assert result.review_images["s10"]


def test_payload_matches_cell_contract():
    values = _all_values()
    result = recognize_scoresheet(make_synthetic_scoresheet(values, blank={"s03"}))
    payload = result.to_cells_payload()

    assert set(payload.keys()) == {"cells", "confidenceAvg", "unresolvedCount"}
    assert len(payload["cells"]) == 80
    assert payload["cells"]["s01"]["value"] == values["s01"]
    assert 0.0 <= payload["cells"]["s01"]["confidence"] <= 1.0
    assert "reason" not in payload["cells"]["s01"]
    assert payload["cells"]["s03"]["value"] is None
    assert payload["cells"]["s03"]["reason"] == "blank"
    assert payload["unresolvedCount"] == 1


def test_recognition_payload_matches_api_contract():
    values = _all_values()
    result = recognize_scoresheet(make_synthetic_scoresheet(values))
    payload = result.to_recognition_payload({"s01": "https://example.com/s01.png"})

    assert set(payload.keys()) == {
        "sheet", "cells", "confidenceAvg", "unresolvedCount", "pageIndex", "imageLinks",
    }
    assert payload["sheet"] == "cheq-scoresheet-p5"
    assert payload["imageLinks"]["s01"] == "https://example.com/s01.png"
    assert payload["pageIndex"] is None  # PNG入力はページ概念なし


def test_select_scoresheet_page():
    # 採点表は5ページ目(0始まりで4)。短いPDFは最終ページへフォールバック。
    assert select_scoresheet_page(5) == 4
    assert select_scoresheet_page(6) == 4
    assert select_scoresheet_page(3) == 2
    assert select_scoresheet_page(1) == 0
    with pytest.raises(ValueError):
        select_scoresheet_page(0)


def test_negative_page_index_is_rejected_before_decoding():
    with pytest.raises(RecognitionError):
        recognize_scoresheet(b"not an image", "image/png", -1)


def test_pdf_render_size_is_capped():
    class HugePage:
        def get_size(self):
            width = MAX_PDF_RENDER_DIMENSION / PDF_RENDER_SCALE + 1
            return width, 100

    with pytest.raises(RecognitionError):
        _validate_pdf_render_size(HugePage())


def test_failed_scoresheet_result_returns_structured_failure_payload():
    result = failed_scoresheet_result("file_too_large", "Uploaded file is too large")
    payload = result.to_recognition_payload()

    assert payload["status"] == "failed"
    assert payload["error"] == {
        "code": "file_too_large",
        "message": "Uploaded file is too large",
    }
    assert payload["unresolvedCount"] == len(ALL_CELL_KEYS)
    assert payload["cells"]["s01"]["reason"] == "file_too_large"
