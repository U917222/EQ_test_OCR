from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any


CHEQ_LETTERS = "ABCDEFGHIJ"
CELLS_PER_ROW = 4
BLOCKS = 2


def cell_key(block: int, letter: str, pos: int) -> str:
    letter_index = CHEQ_LETTERS.find(letter)
    if block < 0 or block >= BLOCKS or letter_index < 0 or pos < 1 or pos > CELLS_PER_ROW:
        raise ValueError(f"invalid cell: block={block} letter={letter} pos={pos}")
    index = block * 40 + letter_index * CELLS_PER_ROW + (pos - 1)
    return f"s{index + 1:02d}"


def row_key(block: int, letter: str) -> str:
    return f"{letter}{block + 1}"


@dataclass
class ScoreResult:
    row_scores: dict[str, int]
    issues: list[dict[str, Any]]
    item_totals: dict[str, int]
    item_stages: dict[str, int | None]
    response_attitude_stage: int | None
    attitude_minus_points: int
    job_requirement_minus_points: int
    job_requirement_low_items: list[dict[str, Any]]
    cross_check: list[dict[str, Any]]
    total_rank: str
    minus_points: int
    notes: str
    _item_labels: dict[str, str] = field(default_factory=dict, repr=False)

    def to_results_row(self) -> dict[str, Any]:
        stages_for_row = _label_keyed(self.item_stages, self._item_labels)
        totals_for_row = _label_keyed(self.item_totals, self._item_labels)
        low_items = [
            {"label": item.get("label"), "stage": item.get("stage")}
            for item in self.job_requirement_low_items
        ]
        return {
            "total_rank": self.total_rank,
            "response_attitude_stage": "" if self.response_attitude_stage is None else self.response_attitude_stage,
            "minus_points": self.minus_points,
            "attitude_minus_points": self.attitude_minus_points,
            "job_requirement_minus_points": self.job_requirement_minus_points,
            "job_requirement_low_items_json": _json_dumps(low_items),
            "row_scores_json": _json_dumps(self.row_scores),
            "item_totals_json": _json_dumps(totals_for_row),
            "item_stages_json": _json_dumps(stages_for_row),
            "cross_check_json": _json_dumps(self.cross_check),
            "notes": self.notes,
        }


def score_candidate(
    cells: dict,
    item_master: list[dict],
    score_bands: list[dict],
    rank_rules: list[dict],
    handwritten_totals: list[dict] | None = None,
) -> ScoreResult:
    normalized_items = _build_item_master(item_master)
    bands = _build_bands(score_bands)
    handwritten = _build_handwritten_totals(handwritten_totals)

    row_result = compute_row_scores(cells)
    item_totals = compute_item_totals(row_result["scores"], normalized_items)
    item_stages = compute_stages(item_totals, bands)

    attitude_key = _find_attitude_key(normalized_items)
    attitude_stage = item_stages.get(attitude_key) if attitude_key else None
    score_attitude_minus = minus_points_for_attitude_stage(attitude_stage)
    job_low_items = job_requirement_low_stage_items(item_stages, normalized_items)
    job_requirement_minus = 0 if not job_low_items else -len(job_low_items)
    mismatches = cross_check(item_totals, handwritten)

    labels_by_key = {item["key"]: item["label"] for item in normalized_items}
    stages_by_label = _label_keyed(item_stages, labels_by_key)
    # GAS evaluates RankRules against labels, but accepting item_key conditions is harmless.
    category_stages = {**item_stages, **stages_by_label}
    rank_result = calculate_rank(category_stages, rank_rules)
    rank_attitude_minus = _to_number(rank_result.get("minusPoints"), score_attitude_minus)

    notes = _build_result_notes(
        rank_result=rank_result,
        mismatches=mismatches,
        labels_by_key=labels_by_key,
        job_req_minus=job_requirement_minus,
        job_requirement_low_items=job_low_items,
    )

    return ScoreResult(
        row_scores=row_result["scores"],
        issues=row_result["issues"],
        item_totals=item_totals,
        item_stages=item_stages,
        response_attitude_stage=attitude_stage,
        attitude_minus_points=int(rank_attitude_minus),
        job_requirement_minus_points=job_requirement_minus,
        job_requirement_low_items=job_low_items,
        cross_check=mismatches,
        total_rank=str(rank_result.get("rank") or ""),
        minus_points=job_requirement_minus,
        notes=notes,
        _item_labels=labels_by_key,
    )


def compute_row_scores(cells: dict) -> dict[str, Any]:
    scores: dict[str, int] = {}
    issues: list[dict[str, Any]] = []
    for block in range(BLOCKS):
        for letter in CHEQ_LETTERS:
            row = row_key(block, letter)
            total = 0
            for pos in range(1, CELLS_PER_ROW + 1):
                key = cell_key(block, letter, pos)
                cell = cells.get(key) if isinstance(cells, dict) else None
                if not cell or cell.get("value") is None:
                    issues.append({"cell": key, "row": row, "reason": (cell or {}).get("reason") or "blank"})
                else:
                    total += cell.get("value")
            scores[row] = total
    return {"scores": scores, "issues": issues}


def compute_item_totals(row_scores: dict[str, int], item_master: list[dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for item in item_master:
        totals[item["key"]] = row_scores.get(f"{item['letter']}1", 0) + row_scores.get(f"{item['letter']}2", 0)
    return totals


def compute_stages(item_totals: dict[str, int], bands: dict[str, list[dict[str, int]]]) -> dict[str, int | None]:
    stages: dict[str, int | None] = {}
    for key, total in item_totals.items():
        stages[key] = None
        for band in bands.get(key, []):
            if total >= band["min"] and total <= band["max"]:
                stages[key] = band["stage"]
                break
    return stages


def minus_points_for_attitude_stage(stage: int | None) -> int:
    if stage == 5:
        return -2
    if stage == 4:
        return -1
    return 0


def job_requirement_low_stage_items(
    stages: dict[str, int | None],
    item_master: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in item_master:
        if not _is_job_requirement_item(item):
            continue
        stage = stages.get(item["key"])
        if stage == 1 or stage == 2:
            items.append({"key": item["key"], "label": item["label"], "stage": stage})
    return items


def cross_check(item_totals: dict[str, int], handwritten_totals: dict[str, int] | None) -> list[dict[str, Any]]:
    mismatches: list[dict[str, Any]] = []
    if handwritten_totals is None:
        return mismatches
    for key, computed in item_totals.items():
        if key not in handwritten_totals:
            continue
        handwritten = handwritten_totals[key]
        if computed != handwritten:
            mismatches.append({"item": key, "computed": computed, "handwritten": handwritten})
    return mismatches


def calculate_rank(category_stages: dict[str, Any], rank_rules: list[dict] | None) -> dict[str, Any]:
    sorted_rules = sorted(
        [
            row
            for row in (rank_rules or [])
            if row.get("condition_json") not in ("", None) and row.get("rank") not in ("", None)
        ],
        key=lambda row: str(row.get("rule_id", "")),
    )

    for rule in sorted_rules:
        condition = _safe_json_parse(rule.get("condition_json"))
        if condition and evaluate_rank_condition(condition, category_stages):
            minus_points = (
                rule.get("minus_points")
                if rule.get("minus_points") not in ("", None)
                else calculate_response_attitude_minus_points(category_stages)
            )
            return {
                "rank": rule.get("rank"),
                "minusPoints": minus_points,
                "note": rule.get("note") or rule.get("label") or "",
            }
    return calculate_fallback_rank(category_stages)


def evaluate_rank_condition(condition: dict[str, Any], category_stages: dict[str, Any]) -> bool:
    if condition.get("all") is not None:
        return all(evaluate_rank_condition(item, category_stages) for item in condition["all"])
    if condition.get("any") is not None:
        return any(evaluate_rank_condition(item, category_stages) for item in condition["any"])
    if condition.get("category") is not None:
        stage = _to_number(category_stages.get(condition["category"]) or 0, 0)
        if "eq" in condition:
            return stage == _to_number(condition["eq"], math.nan)
        if "lte" in condition:
            return stage <= _to_number(condition["lte"], math.nan)
        if "gte" in condition:
            return stage >= _to_number(condition["gte"], math.nan)
        if "lt" in condition:
            return stage < _to_number(condition["lt"], math.nan)
        if "gt" in condition:
            return stage > _to_number(condition["gt"], math.nan)
    if condition.get("min_stage_lte") is not None:
        stages = _rank_stage_values(category_stages)
        return bool(stages) and min(stages) <= _to_number(condition["min_stage_lte"], math.nan)
    if condition.get("low_stage_count_gte") is not None:
        threshold = _to_number(condition.get("threshold") or 2, 2)
        count = len([value for value in _rank_stage_values(category_stages) if value <= threshold])
        return count >= _to_number(condition["low_stage_count_gte"], math.nan)
    if condition.get("average_stage_lt") is not None:
        stages = _rank_stage_values(category_stages)
        if not stages:
            return False
        average = sum(stages) / len(stages)
        return average < _to_number(condition["average_stage_lt"], math.nan)
    return False


def calculate_fallback_rank(category_stages: dict[str, Any]) -> dict[str, Any]:
    stages = _rank_stage_values(category_stages)
    if not stages:
        return {"rank": "", "minusPoints": "", "note": "段階得点がありません"}

    min_stage = min(stages)
    average = sum(stages) / len(stages)
    low_stage_count = len([value for value in stages if value <= 2])
    minus_points = calculate_response_attitude_minus_points(category_stages)

    if min_stage <= 1 or low_stage_count >= 3:
        return {"rank": "D", "minusPoints": minus_points, "note": "低段階項目が複数あります"}
    if low_stage_count >= 1 or minus_points < 0 or average < 3:
        return {"rank": "C", "minusPoints": minus_points, "note": "面接で注意項目を確認してください"}
    if average >= 4:
        return {"rank": "A", "minusPoints": minus_points, "note": "全体的に安定しています"}
    return {"rank": "B", "minusPoints": minus_points, "note": "概ね標準範囲です"}


def calculate_response_attitude_minus_points(category_stages: dict[str, Any]) -> int:
    response_attitude = _to_number(category_stages.get("応答態度") or 0, 0)
    if response_attitude >= 5:
        return -2
    if response_attitude >= 4:
        return -1
    return 0


def _build_item_master(rows: list[dict]) -> list[dict[str, Any]]:
    def order(row: dict) -> float:
        return _to_number(row.get("display_order") or 0, 0)

    items: list[dict[str, Any]] = []
    for row in sorted(rows or [], key=order):
        key = str(row.get("key") or row.get("item_key") or "").strip()
        if not key:
            continue
        items.append(
            {
                "key": key,
                "label": str(row.get("label") or "").strip(),
                "letter": str(row.get("letter") or "").strip().upper(),
                "isAttitude": _parse_boolean(row.get("isAttitude", row.get("is_attitude"))),
            }
        )
    return items


def _build_bands(rows: list[dict] | dict) -> dict[str, list[dict[str, int]]]:
    if isinstance(rows, dict):
        source_rows = []
        for key, bands in rows.items():
            for band in bands or []:
                source_rows.append({"item_key": key, **band})
    else:
        source_rows = rows or []

    bands_by_key: dict[str, list[dict[str, int]]] = {}
    for row in source_rows:
        key = str(row.get("item_key") or row.get("key") or "").strip()
        if not key:
            continue
        bands_by_key.setdefault(key, []).append(
            {
                "min": int(_to_number(row.get("min_score", row.get("min")), math.nan)),
                "max": int(_to_number(row.get("max_score", row.get("max")), math.nan)),
                "stage": int(_to_number(row.get("stage"), math.nan)),
            }
        )
    for key in bands_by_key:
        bands_by_key[key].sort(key=lambda band: band["min"])
    return bands_by_key


def _build_handwritten_totals(rows: list[dict] | dict | None) -> dict[str, int] | None:
    if rows is None:
        return None
    if isinstance(rows, dict):
        return {str(key): int(_to_number(value, math.nan)) for key, value in rows.items()}
    totals: dict[str, int] = {}
    for row in rows:
        key = str(row.get("item_key") or row.get("key") or "").strip()
        total = row.get("total")
        if not key or total == "":
            continue
        totals[key] = int(_to_number(total, math.nan))
    return totals


def _find_attitude_key(item_master: list[dict[str, Any]]) -> str | None:
    for item in item_master:
        if item.get("isAttitude"):
            return item["key"]
    return None


def _is_job_requirement_item(item: dict[str, Any]) -> bool:
    if not item or item.get("isAttitude"):
        return False
    return str(item.get("label") or "")[:1] in {"⑤", "⑥", "⑦", "⑧", "⑨"}


def _rank_stage_values(category_stages: dict[str, Any]) -> list[float]:
    values: list[float] = []
    for label, value in category_stages.items():
        if str(label)[:1] not in {"①", "②", "③", "④"}:
            continue
        number = _to_number(value, math.nan)
        if number > 0 and math.isfinite(number):
            values.append(number)
    return values


def _build_result_notes(
    rank_result: dict[str, Any],
    mismatches: list[dict[str, Any]],
    labels_by_key: dict[str, str],
    job_req_minus: int,
    job_requirement_low_items: list[dict[str, Any]],
) -> str:
    notes = [str(rank_result.get("note") or "")]
    if job_req_minus < 0:
        labels = [str(item.get("label") or "") for item in job_requirement_low_items if item.get("label")]
        notes.append(f"職務必要要件(⑤〜⑨)で段階2以下が {abs(job_req_minus)} 件: {', '.join(labels)}")
    if mismatches:
        labels = [labels_by_key.get(mismatch["item"], mismatch["item"]) for mismatch in mismatches]
        notes.append(f"手書き合計と{len(mismatches)}件不一致 ({', '.join(labels)})。システム再計算を正とする")
    return " / ".join([note for note in notes if note])


def _label_keyed(values: dict[str, Any], labels_by_key: dict[str, str]) -> dict[str, Any]:
    return {labels_by_key.get(key, key): value for key, value in values.items()}


def _safe_json_parse(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _parse_boolean(value: Any) -> bool:
    if value is True:
        return True
    return str(value or "").strip().lower() in {"true", "1", "yes"}


def _to_number(value: Any, default: float) -> float:
    try:
        if value == "":
            return default
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
