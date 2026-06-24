from io import BytesIO

import pytest
from pypdf import PdfReader

from src.pdf import build_result_pdf, build_result_pdf_html


def _sample_candidate():
    return {
        "candidate_id": "cand-1",
        "name": "テストやろう",
        "test_date": "2026-06-24",
        "role": "看護師",
    }


def _sample_result():
    return {
        "total_rank": "B",
        "response_attitude_stage": 3,
        "job_requirement_minus_points": 0,
        "attitude_minus_points": 0,
        "item_stages": {
            "①セルフコントロール": 4,
            "②コミュニケーション": 3,
            "③状況認識力": 2,
        },
        "item_totals": {
            "①セルフコントロール": 14,
            "②コミュニケーション": 11,
            "③状況認識力": 8,
        },
        "job_requirement_low_items": [],
        "cross_check": [],
    }


def test_result_pdf_html_prefers_japanese_pdf_fonts():
    html = build_result_pdf_html(_sample_candidate(), _sample_result(), {"unresolved_count": 0})

    assert '<meta charset="utf-8">' in html
    assert '"Noto Sans CJK JP"' in html
    assert "CHEQ 採点結果" in html
    assert "テストやろう" in html
    assert "候補者ID: cand-1" in html
    assert "検査日: 2026-06-24" in html
    assert "応募職種" not in html
    assert "総合判定</span><strong>B" in html
    assert "①セルフコントロール" in html
    assert "②コミュニケーション" in html
    assert "③状況認識力" in html


def test_result_pdf_embeds_extractable_japanese_text():
    try:
        pdf = build_result_pdf(_sample_candidate(), _sample_result(), {"unresolved_count": 0})
    except OSError as error:
        pytest.skip(f"WeasyPrint system dependency is unavailable: {error}")

    text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(pdf)).pages)

    assert "CHEQ 採点結果" in text
    assert "テストやろう" in text
    assert "カテゴリ別結果" in text
