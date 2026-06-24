"""Domain repository over the CHEQ scoring spreadsheet."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from src.sheets import (
    SheetsClient,
    SheetTable,
    a1_quote,
    sanitize_sheet_value,
    table_to_values,
    values_to_table,
)


CELL_KEYS = [f"s{i:02d}" for i in range(1, 81)]
RECOGNITION_MIN_CONFIDENCE = 0.8

SHEETS = {
    "candidates": "Candidates",
    "rawCells": "RawCells",
    "reviewQueue": "ReviewQueue",
    "itemMaster": "ItemMaster",
    "scoreBands": "ScoreBands",
    "rankRules": "RankRules",
    "handwrittenTotals": "HandwrittenTotals",
    "results": "Results",
    "auditLog": "AuditLog",
    "users": "Users",
    "apiOperations": "ApiOperations",
    "apiNonces": "ApiNonces",
    "config": "Config",
}

HEADERS = {
    "Candidates": [
        "candidate_id",
        "name",
        "test_date",
        "role",
        "uploaded_at",
        "status",
        "source_url",
        "memo",
        "hiring_decision",
        "employee_number",
        "decision_by",
        "decision_at",
        "updated_at",
    ],
    "RawCells": [
        "candidate_id",
        *CELL_KEYS,
        "confidence_avg",
        "unresolved_count",
        "page_index",
        "updated_at",
    ],
    "ReviewQueue": [
        "review_id",
        "candidate_id",
        "cell_key",
        "detected",
        "reason",
        "confidence",
        "image_link",
        "corrected_value",
        "status",
        "resolved_by",
        "resolved_at",
    ],
    "ItemMaster": ["item_key", "label", "letter", "is_attitude", "display_order"],
    "ScoreBands": ["item_key", "min_score", "max_score", "stage"],
    "RankRules": ["rule_id", "label", "condition_json", "rank", "minus_points", "note"],
    "HandwrittenTotals": ["candidate_id", "item_key", "total"],
    "Results": [
        "candidate_id",
        "total_rank",
        "response_attitude_stage",
        "minus_points",
        "attitude_minus_points",
        "job_requirement_minus_points",
        "job_requirement_low_items_json",
        "row_scores_json",
        "item_totals_json",
        "item_stages_json",
        "cross_check_json",
        "notes",
        "finalized_by",
        "finalized_at",
        "status",
    ],
    "AuditLog": [
        "logged_at",
        "actor",
        "action",
        "candidate_id",
        "detail_json",
        "operator",
        "operation_id",
        "result",
        "at",
    ],
    "Users": ["email", "role", "active"],
    "ApiOperations": ["operation_id", "action", "candidate_id", "status", "result_json", "created_at"],
    "ApiNonces": ["nonce", "ts"],
    "Config": ["key", "value", "note"],
}

STATUS_TO_API = {
    "REGISTERED": "uploaded",
    "UPLOADED": "uploaded",
    "PROCESSING": "recognizing",
    "PROCESSING_FAILED": "needs_review",
    "REVIEW_REQUIRED": "needs_review",
    "READY_TO_FINALIZE": "scored",
    "FINALIZED": "finalized",
}

API_TO_STATUS = {
    "uploaded": "UPLOADED",
    "recognizing": "PROCESSING",
    "needs_review": "REVIEW_REQUIRED",
    "scored": "READY_TO_FINALIZE",
    "finalized": "FINALIZED",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_email(email: Any) -> str:
    return str(email or "").strip().lower()


def parse_bool(value: Any) -> bool:
    if value is True:
        return True
    return str(value or "").strip().lower() in {"true", "1", "yes", "y"}


def json_parse(value: Any, default: Any) -> Any:
    if value in ("", None):
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except json.JSONDecodeError:
        return default


def number_or_null(value: Any) -> int | float | None:
    if value in ("", None):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number.is_integer():
        return int(number)
    return number


def number_or_default(value: Any, default: int | float) -> int | float:
    number = number_or_null(value)
    return default if number is None else number


def serialize_date_like(value: Any) -> str:
    return "" if value is None else str(value)


def api_normalize_candidate_status(status: Any) -> str:
    normalized = str(status or "").strip().upper()
    return STATUS_TO_API.get(normalized, str(status or "").strip().lower())


def api_normalize_decision(decision: Any) -> str:
    normalized = str(decision or "").strip().upper()
    if normalized == "PASSED":
        return "hire"
    if normalized == "FAILED":
        return "reject"
    return normalized.lower() if normalized else "hold"


def api_candidate_from_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "candidateId": row.get("candidate_id") or "",
        "name": row.get("name") or "",
        "testDate": serialize_date_like(row.get("test_date")),
        "role": row.get("role") or "",
        "status": api_normalize_candidate_status(row.get("status")),
        "uploadedAt": serialize_date_like(row.get("uploaded_at")),
        "decision": api_normalize_decision(row.get("hiring_decision")),
        "employeeNumber": row.get("employee_number") or "",
        "decisionBy": row.get("decision_by") or "",
        "decisionAt": serialize_date_like(row.get("decision_at")),
        "memo": row.get("memo") or "",
        "updatedAt": serialize_date_like(row.get("updated_at")),
    }


class ScoringRepository:
    def __init__(self, sheets: SheetsClient):
        self.sheets = sheets

    @classmethod
    def from_spreadsheet_id(cls, spreadsheet_id: str) -> "ScoringRepository":
        return cls(SheetsClient(spreadsheet_id))

    def read_table(self, sheet_name: str) -> SheetTable:
        return values_to_table(self.sheets.get_values(sheet_name))

    def read_tables(self, sheet_names: list[str]) -> dict[str, SheetTable]:
        # 複数シートを1回の batchGet で読み、Sheets 往復回数を減らす。
        ranges = [f"{a1_quote(name)}!A:ZZ" for name in sheet_names]
        values_list = self.sheets.batch_get_ordered(ranges)
        return {name: values_to_table(values) for name, values in zip(sheet_names, values_list)}

    def rewrite_sheet(self, sheet_name: str, headers: list[str], rows: list[dict[str, Any]]) -> None:
        self.sheets.clear_values(sheet_name)
        self.sheets.update_values(sheet_name, table_to_values(headers, rows), "A1")

    def append_object(self, sheet_name: str, obj: dict[str, Any]) -> None:
        table = self.read_table(sheet_name)
        headers = table.headers or HEADERS[sheet_name]
        self.sheets.append_values(
            sheet_name,
            [[sanitize_sheet_value(obj.get(header, "")) for header in headers]],
        )

    def update_row(self, sheet_name: str, row_number: int, patch: dict[str, Any]) -> None:
        table = self.read_table(sheet_name)
        headers = table.headers or HEADERS[sheet_name]
        row = next((item for item in table.rows if item.get("_row_number") == row_number), None)
        current = {header: "" for header in headers}
        if row:
            current.update({header: row.get(header, "") for header in headers})
        current.update(patch)
        self.sheets.update_values(
            sheet_name,
            [[sanitize_sheet_value(current.get(header, "")) for header in headers]],
            f"A{row_number}",
        )

    def find_by(self, sheet_name: str, key: str, value: Any) -> dict[str, Any] | None:
        expected = str(value)
        return next(
            (row for row in self.read_table(sheet_name).rows if str(row.get(key) or "") == expected),
            None,
        )

    def list_candidates(self) -> list[dict[str, Any]]:
        return self.read_table(SHEETS["candidates"]).rows

    def get_candidate(self, candidate_id: str) -> dict[str, Any] | None:
        return self.find_by(SHEETS["candidates"], "candidate_id", candidate_id)

    def create_candidate(self, payload: dict[str, Any]) -> dict[str, Any]:
        candidate_id = str(uuid.uuid4())
        created_at = now_iso()
        source_url = str(payload.get("sourceUrl") or payload.get("source_url") or "").strip()
        status = "PROCESSING" if payload.get("file") else "UPLOADED" if source_url else "REGISTERED"
        self.append_object(
            SHEETS["candidates"],
            {
                "candidate_id": candidate_id,
                "name": payload.get("name") or "",
                "test_date": payload.get("testDate") or "",
                "role": payload.get("role") or "",
                "uploaded_at": created_at,
                "status": status,
                "source_url": source_url,
                "memo": payload.get("memo") or "",
                "updated_at": created_at,
            },
        )
        self.append_object(
            SHEETS["rawCells"],
            {"candidate_id": candidate_id, "confidence_avg": "", "unresolved_count": "", "updated_at": created_at},
        )
        candidate = self.get_candidate(candidate_id)
        if not candidate:
            raise RuntimeError(f"Candidate not found: {candidate_id}")
        return candidate

    def update_candidate_source_url(self, candidate_id: str, source_url: str) -> None:
        row = self.get_candidate(candidate_id)
        if not row:
            raise RuntimeError(f"Candidate not found: {candidate_id}")
        self.update_row(
            SHEETS["candidates"],
            int(row["_row_number"]),
            {"source_url": source_url, "updated_at": now_iso()},
        )

    def import_recognition_result(self, candidate_id: str, recognition: dict[str, Any]) -> int:
        raw_row = self.get_raw_cells(candidate_id)
        if not raw_row:
            raise RuntimeError(f"Raw cells not found: {candidate_id}")

        cells = _normalize_recognition_cells(recognition.get("cells"))
        review_items = _build_review_items(candidate_id, cells, recognition.get("imageLinks"))
        confidence_avg = _recognition_confidence_avg(recognition, cells)
        patch = {
            key: "" if cells[key]["value"] is None else cells[key]["value"]
            for key in CELL_KEYS
        }
        patch.update(
            {
                "confidence_avg": confidence_avg,
                "unresolved_count": len(review_items),
                "page_index": "" if recognition.get("pageIndex") is None else recognition.get("pageIndex"),
                "updated_at": now_iso(),
            }
        )
        self.update_row(SHEETS["rawCells"], int(raw_row["_row_number"]), patch)
        self.replace_review_items(candidate_id, review_items)
        self.update_candidate_status(candidate_id, "REVIEW_REQUIRED" if review_items else "READY_TO_FINALIZE")
        return len(review_items)

    def replace_review_items(self, candidate_id: str, review_items: list[dict[str, Any]]) -> None:
        table = self.read_table(SHEETS["reviewQueue"])
        headers = table.headers or HEADERS[SHEETS["reviewQueue"]]
        kept = [
            row
            for row in table.rows
            if row.get("candidate_id") != candidate_id or row.get("status") == "RESOLVED"
        ]
        self.rewrite_sheet(SHEETS["reviewQueue"], headers, kept)
        for item in review_items:
            self.append_object(SHEETS["reviewQueue"], item)

    def update_candidate_status(self, candidate_id: str, status: str) -> None:
        row = self.get_candidate(candidate_id)
        if not row:
            raise RuntimeError(f"Candidate not found: {candidate_id}")
        self.update_row(
            SHEETS["candidates"],
            int(row["_row_number"]),
            {"status": status, "updated_at": now_iso()},
        )

    def delete_candidate(self, candidate_id: str) -> dict[str, int]:
        rows_deleted = {
            "reviewQueue": self.delete_rows_by(SHEETS["reviewQueue"], "candidate_id", candidate_id),
            "rawCells": self.delete_rows_by(SHEETS["rawCells"], "candidate_id", candidate_id),
            "results": self.delete_rows_by(SHEETS["results"], "candidate_id", candidate_id),
            "handwrittenTotals": self.delete_rows_by(SHEETS["handwrittenTotals"], "candidate_id", candidate_id),
            "candidates": self.delete_rows_by(SHEETS["candidates"], "candidate_id", candidate_id),
        }
        return rows_deleted

    def delete_rows_by(self, sheet_name: str, key: str, value: Any) -> int:
        table = self.read_table(sheet_name)
        headers = table.headers or HEADERS[sheet_name]
        expected = str(value)
        kept = [row for row in table.rows if str(row.get(key) or "") != expected]
        deleted = len(table.rows) - len(kept)
        if deleted:
            self.rewrite_sheet(sheet_name, headers, kept)
        return deleted

    def save_decision(
        self, candidate_id: str, decision: str, employee_number: str, actor: str
    ) -> dict[str, Any]:
        table = self.read_table(SHEETS["candidates"])
        row = next((item for item in table.rows if item.get("candidate_id") == candidate_id), None)
        if not row:
            raise RuntimeError(f"Candidate not found: {candidate_id}")
        if employee_number:
            duplicate = next(
                (
                    item
                    for item in table.rows
                    if item.get("candidate_id") != candidate_id
                    and str(item.get("employee_number") or "").strip() == employee_number
                ),
                None,
            )
            if duplicate:
                raise RuntimeError(f"職員番号 {employee_number} は既に別の候補者に登録されています")
        stored_employee_number = employee_number if decision == "PASSED" else ""
        decided_at = now_iso()
        patch = {
            "hiring_decision": decision,
            "employee_number": stored_employee_number,
            "decision_by": actor,
            "decision_at": decided_at,
            "updated_at": decided_at,
        }
        if decision:
            patch["status"] = "FINALIZED"
        self.update_row(
            SHEETS["candidates"],
            int(row["_row_number"]),
            patch,
        )
        updated = self.get_candidate(candidate_id)
        if not updated:
            raise RuntimeError(f"Candidate not found: {candidate_id}")
        return updated

    def get_raw_cells(self, candidate_id: str) -> dict[str, Any] | None:
        return self.find_by(SHEETS["rawCells"], "candidate_id", candidate_id)

    def get_review_queue(self, candidate_id: str = "") -> list[dict[str, Any]]:
        rows = self.read_table(SHEETS["reviewQueue"]).rows
        return [
            strip_internal(row)
            for row in rows
            if (not candidate_id or row.get("candidate_id") == candidate_id)
            and row.get("status") != "RESOLVED"
        ]

    def save_cells(self, candidate_id: str, updates: dict[str, int], actor: str) -> int:
        raw_row = self.get_raw_cells(candidate_id)
        if not raw_row:
            raise RuntimeError(f"Raw cells not found: {candidate_id}")
        self.update_row(SHEETS["rawCells"], int(raw_row["_row_number"]), {**updates, "updated_at": now_iso()})

        review_table = self.read_table(SHEETS["reviewQueue"])
        for row in review_table.rows:
            if (
                row.get("candidate_id") == candidate_id
                and row.get("cell_key") in updates
                and row.get("status") == "OPEN"
            ):
                self.update_row(
                    SHEETS["reviewQueue"],
                    int(row["_row_number"]),
                    {
                        "corrected_value": updates[str(row.get("cell_key"))],
                        "status": "RESOLVED",
                        "resolved_by": actor,
                        "resolved_at": now_iso(),
                    },
                )

        open_count = sum(
            1
            for row in self.read_table(SHEETS["reviewQueue"]).rows
            if row.get("candidate_id") == candidate_id and row.get("status") == "OPEN"
        )
        raw_row = self.get_raw_cells(candidate_id)
        if raw_row:
            self.update_row(
                SHEETS["rawCells"],
                int(raw_row["_row_number"]),
                {"unresolved_count": open_count, "updated_at": now_iso()},
            )
        self.update_candidate_status(candidate_id, "REVIEW_REQUIRED" if open_count > 0 else "READY_TO_FINALIZE")
        return open_count

    def get_dashboard_data(self, candidate_id: str) -> dict[str, Any]:
        candidates = self.list_candidates()
        candidate = next(
            (row for row in candidates if row.get("candidate_id") == candidate_id),
            candidates[0] if candidates and not candidate_id else None,
        )
        if not candidate:
            return {"candidate": None, "result": None}
        result = self.find_by(SHEETS["results"], "candidate_id", candidate.get("candidate_id"))
        raw_cells = self.get_raw_cells(str(candidate.get("candidate_id") or ""))
        return {
            "candidate": strip_internal(candidate),
            "result": self.inflate_result(result) if result else None,
            "rawCellSummary": {
                "confidence_avg": raw_cells.get("confidence_avg"),
                "unresolved_count": raw_cells.get("unresolved_count"),
                "page_index": raw_cells.get("page_index"),
                "updated_at": raw_cells.get("updated_at"),
            }
            if raw_cells
            else None,
            "reviewQueue": self.get_review_queue(str(candidate.get("candidate_id") or "")),
        }

    def inflate_result(self, result: dict[str, Any]) -> dict[str, Any]:
        inflated = strip_internal(result)
        inflated["row_scores"] = json_parse(result.get("row_scores_json"), {})
        inflated["item_totals"] = json_parse(result.get("item_totals_json"), {})
        inflated["item_stages"] = json_parse(result.get("item_stages_json"), {})
        inflated["cross_check"] = json_parse(result.get("cross_check_json"), [])
        inflated["job_requirement_low_items"] = json_parse(result.get("job_requirement_low_items_json"), [])
        return inflated

    def read_masters(self, candidate_id: str) -> dict[str, list[dict[str, Any]]]:
        return {
            "item_master": [strip_internal(row) for row in self.read_table(SHEETS["itemMaster"]).rows],
            "score_bands": [strip_internal(row) for row in self.read_table(SHEETS["scoreBands"]).rows],
            "rank_rules": [strip_internal(row) for row in self.read_table(SHEETS["rankRules"]).rows],
            "handwritten_totals": [
                strip_internal(row)
                for row in self.read_table(SHEETS["handwrittenTotals"]).rows
                if row.get("candidate_id") == candidate_id and row.get("item_key") != "" and row.get("total") != ""
            ],
        }

    def upsert_result(self, row: dict[str, Any]) -> None:
        existing = self.find_by(SHEETS["results"], "candidate_id", row.get("candidate_id"))
        row = dict(row)
        row.setdefault("status", "FINALIZED")
        if existing:
            self.update_row(SHEETS["results"], int(existing["_row_number"]), row)
        else:
            self.append_object(SHEETS["results"], row)

    def append_review_notice(self, candidate_id: str, detail: dict[str, Any]) -> None:
        self.append_object(
            SHEETS["reviewQueue"],
            {
                "review_id": str(uuid.uuid4()),
                "candidate_id": candidate_id,
                "cell_key": "",
                "detected": detail.get("detected", ""),
                "reason": detail.get("reason", ""),
                "confidence": "",
                "image_link": "",
                "corrected_value": "",
                "status": "NOTICE",
                "resolved_by": "",
                "resolved_at": "",
            },
        )

    def users(self) -> list[dict[str, Any]]:
        return self.read_table(SHEETS["users"]).rows

    def nonces(self) -> SheetTable:
        return self.read_table(SHEETS["apiNonces"])

    def append_nonce(self, nonce: str, ts: int | float) -> None:
        self.append_object(SHEETS["apiNonces"], {"nonce": nonce, "ts": ts})

    def rewrite_nonces(self, rows: list[dict[str, Any]]) -> None:
        self.rewrite_sheet(SHEETS["apiNonces"], HEADERS[SHEETS["apiNonces"]], rows)

    def operations(self) -> SheetTable:
        return self.read_table(SHEETS["apiOperations"])

    def append_operation(self, row: dict[str, Any]) -> None:
        self.append_object(SHEETS["apiOperations"], row)

    def rewrite_operations(self, rows: list[dict[str, Any]]) -> None:
        self.rewrite_sheet(SHEETS["apiOperations"], HEADERS[SHEETS["apiOperations"]], rows)

    def append_audit(self, row: dict[str, Any]) -> None:
        self.append_object(SHEETS["auditLog"], row)


def strip_internal(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if not key.startswith("_")}


def _normalize_recognition_cells(raw_cells: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw_cells, dict):
        raise RuntimeError("recognition.cells is required")
    cells: dict[str, dict[str, Any]] = {}
    for key in CELL_KEYS:
        cell = raw_cells.get(key)
        if not isinstance(cell, dict):
            cell = {}
        value = number_or_null(cell.get("value"))
        if value not in (0, 1, 2, 3):
            value = None
        confidence = number_or_null(cell.get("confidence"))
        cells[key] = {
            "value": value,
            "confidence": 0.0 if confidence is None else float(confidence),
            "reason": str(cell.get("reason") or ""),
        }
    return cells


def _build_review_items(
    candidate_id: str,
    cells: dict[str, dict[str, Any]],
    raw_image_links: Any,
) -> list[dict[str, Any]]:
    image_links = raw_image_links if isinstance(raw_image_links, dict) else {}
    items = []
    for key in CELL_KEYS:
        cell = cells[key]
        value = cell["value"]
        confidence = float(cell["confidence"])
        reason = ""
        if value is None:
            reason = str(cell.get("reason") or "low_confidence")
        elif 0 < confidence < RECOGNITION_MIN_CONFIDENCE:
            reason = "low_confidence"
        if not reason:
            continue
        items.append(
            {
                "review_id": str(uuid.uuid4()),
                "candidate_id": candidate_id,
                "cell_key": key,
                "detected": "" if value is None else value,
                "reason": reason,
                "confidence": confidence,
                "image_link": image_links.get(key, ""),
                "corrected_value": "",
                "status": "OPEN",
                "resolved_by": "",
                "resolved_at": "",
            }
        )
    return items


def _recognition_confidence_avg(recognition: dict[str, Any], cells: dict[str, dict[str, Any]]) -> float:
    direct = number_or_null(recognition.get("confidenceAvg"))
    if direct is not None:
        return float(direct)
    values = [float(cell["confidence"]) for cell in cells.values() if float(cell["confidence"]) > 0]
    if not values:
        return 0.0
    return round(sum(values) / len(values), 3)
