import json

import pytest

from src.scoring import cell_key, score_candidate


ITEM_MASTER = [
    {"item_key": "cat1", "label": "①セルフコントロール", "letter": "A", "is_attitude": "", "display_order": 1},
    {"item_key": "cat2", "label": "②コミュニケーション", "letter": "B", "is_attitude": "", "display_order": 2},
    {"item_key": "cat3", "label": "③状況認識力", "letter": "C", "is_attitude": "", "display_order": 3},
    {"item_key": "cat4", "label": "④ストレス対処力", "letter": "D", "is_attitude": "", "display_order": 4},
    {"item_key": "cat5", "label": "⑤積極性", "letter": "E", "is_attitude": "", "display_order": 5},
    {"item_key": "cat6", "label": "⑥目標達成力", "letter": "F", "is_attitude": "", "display_order": 6},
    {"item_key": "cat7", "label": "⑦ポジティブ思考力", "letter": "G", "is_attitude": "", "display_order": 7},
    {"item_key": "cat8", "label": "⑧チームワーク", "letter": "H", "is_attitude": "", "display_order": 8},
    {"item_key": "cat9", "label": "⑨ホスピタリティー", "letter": "I", "is_attitude": "", "display_order": 9},
    {"item_key": "attitude", "label": "応答態度", "letter": "J", "is_attitude": "TRUE", "display_order": 10},
]

SCORE_BANDS = [
    {"item_key": item["item_key"], "min_score": 0, "max_score": 4, "stage": 1}
    for item in ITEM_MASTER
] + [
    {"item_key": item["item_key"], "min_score": 5, "max_score": 8, "stage": 2}
    for item in ITEM_MASTER
] + [
    {"item_key": item["item_key"], "min_score": 9, "max_score": 12, "stage": 3}
    for item in ITEM_MASTER
] + [
    {"item_key": item["item_key"], "min_score": 13, "max_score": 16, "stage": 4}
    for item in ITEM_MASTER
] + [
    {"item_key": item["item_key"], "min_score": 17, "max_score": 24, "stage": 5}
    for item in ITEM_MASTER
]


def cells_from_row_totals(row_totals):
    cells = {}
    for block in range(2):
        for letter in "ABCDEFGHIJ":
            values = split_row_total(row_totals.get(f"{letter}{block + 1}", 0))
            for pos, value in enumerate(values, start=1):
                cells[cell_key(block, letter, pos)] = {"value": value, "confidence": 1.0}
    return cells


def split_row_total(total):
    values = []
    remaining = total
    for _ in range(4):
        value = min(3, remaining)
        values.append(value)
        remaining -= value
    assert remaining == 0
    return values


def row_totals_for_item_totals(**item_totals):
    row_totals = {}
    by_key = {item["item_key"]: item for item in ITEM_MASTER}
    for key, total in item_totals.items():
        letter = by_key[key]["letter"]
        row_totals[f"{letter}1"] = min(12, total)
        row_totals[f"{letter}2"] = max(0, total - row_totals[f"{letter}1"])
    return row_totals


def test_score_candidate_matches_core_flow_and_results_row():
    cells = cells_from_row_totals(
        row_totals_for_item_totals(
            cat1=18,
            cat2=14,
            cat3=12,
            cat4=10,
            cat5=8,
            cat6=4,
            cat7=9,
            cat8=13,
            cat9=17,
            attitude=16,
        )
    )
    rank_rules = [
        {
            "rule_id": "001",
            "label": "high",
            "condition_json": json.dumps(
                {
                    "all": [
                        {"category": "①セルフコントロール", "gte": 5},
                        {"any": [{"average_stage_lt": 4}, {"category": "応答態度", "gte": 4}]},
                    ]
                },
                ensure_ascii=False,
            ),
            "rank": "A",
            "minus_points": "",
            "note": "rule matched",
        }
    ]

    result = score_candidate(
        cells=cells,
        item_master=ITEM_MASTER,
        score_bands=SCORE_BANDS,
        rank_rules=rank_rules,
        handwritten_totals=[{"item_key": "cat1", "total": 19}],
    )

    assert result.row_scores["A1"] == 12
    assert result.row_scores["A2"] == 6
    assert result.item_totals["cat1"] == 18
    assert result.item_stages["cat1"] == 5
    assert result.item_stages["cat5"] == 2
    assert result.item_stages["cat6"] == 1
    assert result.response_attitude_stage == 4
    assert result.attitude_minus_points == -1
    assert result.job_requirement_minus_points == -2
    assert result.job_requirement_low_items == [
        {"key": "cat5", "label": "⑤積極性", "stage": 2},
        {"key": "cat6", "label": "⑥目標達成力", "stage": 1},
    ]
    assert result.cross_check == [{"item": "cat1", "computed": 18, "handwritten": 19}]
    assert result.total_rank == "A"
    assert result.minus_points == -2
    assert "rule matched" in result.notes
    assert "職務必要要件(⑤〜⑨)で段階2以下が 2 件" in result.notes
    assert "手書き合計と1件不一致" in result.notes

    row = result.to_results_row()
    assert row["total_rank"] == "A"
    assert row["response_attitude_stage"] == 4
    assert row["minus_points"] == -2
    assert json.loads(row["item_stages_json"])["①セルフコントロール"] == 5
    assert json.loads(row["job_requirement_low_items_json"]) == [
        {"label": "⑤積極性", "stage": 2},
        {"label": "⑥目標達成力", "stage": 1},
    ]


@pytest.mark.parametrize(
    ("total", "expected_stage"),
    [
        (4, 1),
        (5, 2),
        (8, 2),
        (9, 3),
        (16, 4),
        (17, 5),
    ],
)
def test_stage_band_boundaries_are_inclusive(total, expected_stage):
    cells = cells_from_row_totals(row_totals_for_item_totals(cat1=total))

    result = score_candidate(cells, ITEM_MASTER, SCORE_BANDS, rank_rules=[])

    assert result.item_totals["cat1"] == total
    assert result.item_stages["cat1"] == expected_stage


@pytest.mark.parametrize(
    ("attitude_total", "expected_stage", "expected_minus"),
    [
        (16, 4, -1),
        (17, 5, -2),
    ],
)
def test_response_attitude_minus_points(attitude_total, expected_stage, expected_minus):
    cells = cells_from_row_totals(row_totals_for_item_totals(cat1=13, cat2=13, cat3=13, cat4=13, attitude=attitude_total))

    result = score_candidate(cells, ITEM_MASTER, SCORE_BANDS, rank_rules=[])

    assert result.response_attitude_stage == expected_stage
    assert result.attitude_minus_points == expected_minus
    assert result.total_rank == "C"


def test_job_requirement_low_stage_minus_counts_only_labels_5_to_9():
    cells = cells_from_row_totals(
        row_totals_for_item_totals(
            cat1=4,
            cat2=4,
            cat3=13,
            cat4=13,
            cat5=8,
            cat6=9,
            cat7=0,
            cat8=9,
            cat9=9,
            attitude=0,
        )
    )

    result = score_candidate(cells, ITEM_MASTER, SCORE_BANDS, rank_rules=[])

    assert result.item_stages["cat1"] == 1
    assert result.item_stages["cat2"] == 1
    assert result.job_requirement_minus_points == -2
    assert [item["key"] for item in result.job_requirement_low_items] == ["cat5", "cat7"]


def test_null_cell_is_reported_and_excluded_from_row_score():
    cells = cells_from_row_totals(row_totals_for_item_totals(cat1=12))
    cells["s01"] = {"value": None, "confidence": 0.4, "reason": "low_confidence"}

    result = score_candidate(cells, ITEM_MASTER, SCORE_BANDS, rank_rules=[])

    assert result.row_scores["A1"] == 9
    assert {"cell": "s01", "row": "A1", "reason": "low_confidence"} in result.issues
    assert result.item_totals["cat1"] == 9
