"""Action handlers for the scoring API."""

from __future__ import annotations

import base64
import json
import logging
from datetime import datetime, timezone
from typing import Any

from src.repository import (
    API_TO_STATUS,
    CELL_KEYS,
    SHEETS,
    ScoringRepository,
    api_candidate_from_row,
    api_normalize_candidate_status,
    json_parse,
    now_iso,
    number_or_default,
    number_or_null,
    serialize_date_like,
)
from src.wire import ApiContext, ApiError, candidate_id_from_payload


LOGGER = logging.getLogger(__name__)


def dispatch(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    handlers = {
        "me": handle_me,
        "listCandidates": handle_list_candidates,
        "getDashboard": handle_get_dashboard,
        "getCells": handle_get_cells,
        "getResult": handle_get_result,
        "registerCandidate": handle_register_candidate,
        "attachScoresheet": handle_attach_scoresheet,
        "listCandidateDocuments": handle_list_candidate_documents,
        "uploadCandidateDocument": handle_upload_candidate_document,
        "deleteCandidateDocument": handle_delete_candidate_document,
        "updateCandidate": handle_update_candidate,
        "saveCells": handle_save_cells,
        "updateStatus": handle_update_status,
        "deleteCandidate": handle_delete_candidate,
        "finalize": handle_finalize,
        "getResultPdf": handle_get_result_pdf,
        "saveDecision": handle_save_decision,
    }
    handler = handlers.get(context.action)
    if not handler:
        raise ApiError("validation", f"Unsupported action: {context.action}")
    return handler(context, repo)


def handle_me(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    return {"email": context.operator, "role": context.role}


def handle_list_candidates(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    search = str(context.payload.get("search") or "").strip().lower()
    status = str(context.payload.get("status") or "").strip().lower()
    candidates = [api_candidate_from_row(row) for row in repo.list_candidates()]
    if search:
        candidates = [
            candidate
            for candidate in candidates
            if search in str(candidate.get("name") or "").lower()
            or search in str(candidate.get("candidateId") or "").lower()
        ]
    if status:
        candidates = [candidate for candidate in candidates if candidate.get("status") == status]
    return {"candidates": candidates}


def _dashboard_to_datetime(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    candidate = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(candidate)
    except ValueError:
        pass
    try:
        return datetime.fromisoformat(text[:10])
    except ValueError:
        return None


def _dashboard_year(candidate: dict[str, Any]) -> int | None:
    dt = _dashboard_to_datetime(
        candidate.get("testDate") or candidate.get("uploadedAt") or candidate.get("updatedAt")
    )
    return dt.year if dt else None


def _dashboard_month(candidate: dict[str, Any]) -> int | None:
    dt = _dashboard_to_datetime(
        candidate.get("testDate") or candidate.get("uploadedAt") or candidate.get("updatedAt")
    )
    return dt.month if dt else None


def _round_half_up(value: float) -> int:
    # Mirror JavaScript Math.round (round half toward +Infinity).
    import math

    return int(math.floor(value + 0.5))


# 富山県だけは市町村粒度で見たいので市区町村ラベル、それ以外は都道府県でまとめる。
TOYAMA_PREFECTURE = "富山県"


def _dashboard_region(prefecture: str, city: str) -> str:
    if not prefecture:
        return "未設定"
    if prefecture == TOYAMA_PREFECTURE:
        return city or "富山県（市町村未設定）"
    return prefecture


def handle_get_dashboard(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    requested_year = number_or_null(context.payload.get("year"))
    # Candidates / Results / ReviewQueue を1回の batchGet でまとめて読む（往復を3→1に削減）。
    tables = repo.read_tables([SHEETS["candidates"], SHEETS["results"], SHEETS["reviewQueue"]])
    candidates = [api_candidate_from_row(row) for row in tables[SHEETS["candidates"]].rows]

    results_by_id: dict[str, dict[str, Any]] = {}
    for row in tables[SHEETS["results"]].rows:
        cid = str(row.get("candidate_id") or "")
        if cid:
            results_by_id[cid] = row

    open_by_candidate: dict[str, int] = {}
    for row in tables[SHEETS["reviewQueue"]].rows:
        if str(row.get("status") or "") == "OPEN":
            cid = str(row.get("candidate_id") or "")
            open_by_candidate[cid] = open_by_candidate.get(cid, 0) + 1

    available_years = sorted(
        {year for year in (_dashboard_year(candidate) for candidate in candidates) if year},
        reverse=True,
    )
    current_year = datetime.now(timezone.utc).year
    selected_year = (
        int(requested_year)
        if requested_year is not None and requested_year > 1900
        else (available_years[0] if available_years else current_year)
    )

    selected = [c for c in candidates if _dashboard_year(c) == selected_year]
    previous_year_total = sum(1 for c in candidates if _dashboard_year(c) == selected_year - 1)

    monthly = [
        {
            "month": index + 1,
            "label": f"{index + 1}月",
            "male": 0,
            "female": 0,
            "other": 0,
            "unknown": 0,
            "total": 0,
            "finalized": 0,
            "hired": 0,
            "rejected": 0,
            "needsReview": 0,
            "passRate": 0,
        }
        for index in range(12)
    ]
    by_status: dict[str, int] = {}
    by_region: dict[str, int] = {}
    by_rank: dict[str, int] = {}
    attention_items: dict[str, int] = {}

    hired = 0
    rejected = 0
    finalized = 0
    gender_unknown = 0
    open_reviews = 0
    total_attitude_stage = 0.0
    attitude_stage_count = 0
    low_requirement_candidates = 0

    for candidate in selected:
        status = str(candidate.get("status") or "uploaded")
        by_status[status] = by_status.get(status, 0) + 1

        region = _dashboard_region(
            str(candidate.get("prefecture") or "").strip(),
            str(candidate.get("city") or "").strip(),
        )
        by_region[region] = by_region.get(region, 0) + 1

        decision = candidate.get("decision")
        if decision == "hire":
            hired += 1
        if decision == "reject":
            rejected += 1
        if status == "finalized":
            finalized += 1

        result = results_by_id.get(str(candidate.get("candidateId") or ""))
        if result:
            total_rank = str(result.get("total_rank") or "")
            if total_rank:
                by_rank[total_rank] = by_rank.get(total_rank, 0) + 1
            attitude_stage = number_or_null(result.get("response_attitude_stage"))
            if attitude_stage is not None:
                total_attitude_stage += attitude_stage
                attitude_stage_count += 1
            low_items = json_parse(str(result.get("job_requirement_low_items_json") or "[]"), [])
            if isinstance(low_items, list) and low_items:
                low_requirement_candidates += 1
                for item in low_items:
                    label = str((item.get("label") if isinstance(item, dict) else "") or "").strip() or "未分類"
                    attention_items[label] = attention_items.get(label, 0) + 1

        open_reviews += open_by_candidate.get(str(candidate.get("candidateId") or ""), 0)

        month = _dashboard_month(candidate)
        if month:
            row = monthly[month - 1]
            gender = dashboard_gender(candidate.get("gender"))
            row[gender] += 1
            row["total"] += 1
            if gender == "unknown":
                gender_unknown += 1
            if status == "finalized":
                row["finalized"] += 1
            if status == "needs_review":
                row["needsReview"] += 1
            if decision == "hire":
                row["hired"] += 1
            if decision == "reject":
                row["rejected"] += 1

    for row in monthly:
        decided_month = row["hired"] + row["rejected"]
        row["passRate"] = _round_half_up(row["hired"] / decided_month * 100) if decided_month else 0

    total = len(selected)
    decided = hired + rejected
    updated_at = ""
    updated_candidates = [
        str(c.get("updatedAt") or c.get("uploadedAt") or c.get("testDate") or "")
        for c in selected
    ]
    updated_candidates = [value for value in updated_candidates if value]
    if updated_candidates:
        updated_at = max(
            updated_candidates,
            key=lambda value: (_dashboard_to_datetime(value) or datetime.min.replace(tzinfo=timezone.utc)),
        )

    recent = sorted(
        selected,
        key=lambda c: (str(c.get("testDate") or ""), str(c.get("uploadedAt") or "")),
        reverse=True,
    )[:10]

    return {
        "year": selected_year,
        "availableYears": available_years if available_years else [selected_year],
        "generatedAt": now_iso(),
        "updatedAt": updated_at,
        "dataSource": "scoring-api sheets:Candidates/Results/ReviewQueue",
        "summary": {
            "total": total,
            "previousYearTotal": previous_year_total,
            "previousYearDiff": total - previous_year_total,
            "previousYearRate": _round_half_up((total - previous_year_total) / previous_year_total * 100)
            if previous_year_total
            else None,
            "finalized": finalized,
            "finalizedRate": _round_half_up(finalized / total * 100) if total else 0,
            "hired": hired,
            "rejected": rejected,
            "decided": decided,
            "passRate": _round_half_up(hired / decided * 100) if decided else 0,
            "needsReview": by_status.get("needs_review", 0),
            "openReviews": open_reviews,
            "genderUnknown": gender_unknown,
            "lowRequirementCandidates": low_requirement_candidates,
            "averageAttitudeStage": (_round_half_up(total_attitude_stage / attitude_stage_count * 10) / 10)
            if attitude_stage_count
            else None,
        },
        "monthly": monthly,
        "statusBreakdown": [{"status": status, "value": value} for status, value in by_status.items()],
        "regionBreakdown": [
            {"label": label, "value": value}
            for label, value in sorted(by_region.items(), key=lambda kv: (-kv[1], kv[0]))
        ][:10],
        "decisionBreakdown": [
            {"label": "合格", "value": hired},
            {"label": "不合格", "value": rejected},
            {"label": "未判定", "value": max(0, total - decided)},
        ],
        "rankBreakdown": [{"rank": rank, "value": by_rank.get(rank, 0)} for rank in ("A", "B", "C", "D")],
        "attentionItems": [
            {"label": label, "value": value}
            for label, value in sorted(attention_items.items(), key=lambda kv: (-kv[1], kv[0]))
        ][:8],
        "recent": recent,
    }


def handle_get_cells(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    raw_cells = repo.get_raw_cells(candidate_id)
    if not raw_cells:
        raise ApiError("not_found", f"Raw cells not found: {candidate_id}")
    candidate = repo.get_candidate(candidate_id) or {}
    review_queue = repo.get_review_queue(candidate_id)
    flagged = {
        item.get("cell_key"): item.get("reason") or ""
        for item in review_queue
        if item.get("cell_key") and item.get("status") == "OPEN"
    }
    image_links = {
        str(item.get("cell_key")): item.get("image_link")
        for item in review_queue
        if item.get("cell_key") and item.get("image_link")
    }
    source_url = str(candidate.get("source_url") or "").strip()
    if source_url:
        image_links = {"original": source_url, "preview": source_url, "pages": [source_url], **image_links}
    cells = {}
    for key in CELL_KEYS:
        raw = raw_cells.get(key)
        cells[key] = {
            "value": "" if raw in ("", None) else number_or_null(raw),
            "flagged": key in flagged,
            "reason": flagged.get(key, ""),
        }
    return {"cells": cells, "reviewQueue": review_queue, "imageLinks": image_links}


def handle_get_result(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    dashboard = repo.get_dashboard_data(candidate_id)
    if not dashboard.get("candidate"):
        raise ApiError("not_found", f"Candidate not found: {candidate_id}")
    return get_result_response_from_dashboard(dashboard)


def handle_register_candidate(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    for key in ("name", "testDate"):
        if not context.payload.get(key):
            raise ApiError("validation", f"{key} is required")
    candidate = repo.create_candidate(context.payload)
    result = None
    if context.payload.get("file"):
        candidate, result = process_scoresheet_upload(candidate, context.payload.get("file"), context.operator, repo)

    response = {"candidate": api_candidate_from_row(candidate)}
    if result:
        response["result"] = result
    return response


def handle_attach_scoresheet(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    file_payload = context.payload.get("file")
    if not file_payload:
        raise ApiError("validation", "file is required")
    candidate = repo.get_candidate(candidate_id)
    if not candidate:
        raise ApiError("not_found", f"Candidate not found: {candidate_id}")
    if api_normalize_candidate_status(candidate.get("status")) == "finalized":
        raise ApiError("validation", "既に採点が確定しているため採点用紙を添付できません。")

    candidate, result = process_scoresheet_upload(candidate, file_payload, context.operator, repo)
    response = {"candidate": api_candidate_from_row(candidate)}
    if result:
        response["result"] = result
    return response


def process_scoresheet_upload(
    candidate: dict[str, Any],
    file_payload: Any,
    operator: str,
    repo: ScoringRepository,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    result = None
    candidate_id = str(candidate["candidate_id"])
    source_url = str(candidate.get("source_url") or "").strip()
    file_info = file_payload if isinstance(file_payload, dict) else {}
    stored_mime_type = str(file_info.get("mimeType") or file_info.get("contentType") or "").split(";")[0].strip().lower()
    if not source_url:
        try:
            from src.upload_storage import delete_upload_file, save_upload_file
        except ImportError as error:
            raise ApiError("internal", "src.upload_storage.save_upload_file is not available") from error

        stored_upload = save_upload_file(file_payload, candidate_id)
        source_url = stored_upload["sourceUrl"]
        stored_mime_type = stored_upload["mimeType"]
        try:
            repo.update_candidate_source_url(candidate_id, source_url)
        except Exception:
            try:
                delete_upload_file(source_url)
            except Exception as cleanup_error:
                LOGGER.warning(
                    "Failed to clean up upload after source URL update error",
                    extra={"candidate_id": candidate_id, "cleanup_error": str(cleanup_error)},
                )
            raise
        candidate = repo.get_candidate(candidate_id) or candidate

    try:
        from src.upload_recognition import recognize_upload_file
    except ImportError as error:
        raise ApiError("internal", "src.upload_recognition.recognize_upload_file is not available") from error

    recognition = recognize_upload_file(file_payload)
    if recognition:
        if source_url:
            image_links = recognition.get("imageLinks") if isinstance(recognition.get("imageLinks"), dict) else {}
            recognition["imageLinks"] = {
                "original": source_url,
                "preview": source_url,
                "pages": [source_url],
                "mimeType": stored_mime_type,
                **image_links,
            }
        unresolved_count = repo.import_recognition_result(candidate_id, recognition)
        if unresolved_count == 0:
            result = finalize_candidate(candidate_id, operator, repo)["result"]
        candidate = repo.get_candidate(candidate_id) or candidate
    return candidate, result


def handle_update_candidate(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    validate_candidate_profile_payload(context.payload)
    try:
        candidate = repo.update_candidate_profile(candidate_id, context.payload)
    except RuntimeError as error:
        raise ApiError("not_found", str(error)) from error
    return {"candidate": api_candidate_from_row(candidate)}

def handle_save_cells(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    cells = normalize_api_cells(context.payload.get("cells"))
    unresolved_count = repo.save_cells(candidate_id, cells, context.operator)
    return {"saved": True, "unresolvedCount": unresolved_count}


def handle_update_status(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    requested = str(context.payload.get("status") or "").strip().lower()
    if requested not in API_TO_STATUS:
        raise ApiError("validation", "status must be one of uploaded, recognizing, needs_review, scored, finalized")
    repo.update_candidate_status(candidate_id, API_TO_STATUS[requested])
    candidate = repo.get_candidate(candidate_id)
    if not candidate:
        raise ApiError("not_found", f"Candidate not found: {candidate_id}")
    return {"candidate": api_candidate_from_row(candidate)}


def handle_delete_candidate(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    candidate = repo.get_candidate(candidate_id)
    if not candidate:
        scoresheets_deleted, scoresheets_failed = _cleanup_candidate_scoresheet_uploads(candidate_id)
        documents_deleted, documents_failed = _cleanup_candidate_reference_documents(candidate_id)
        return {
            "deleted": True,
            "candidateId": candidate_id,
            "alreadyDeleted": True,
            "rowsDeleted": {},
            "filesDeleted": scoresheets_deleted + documents_deleted,
            "filesFailed": scoresheets_failed + documents_failed,
        }
    rows_deleted = repo.delete_candidate(candidate_id)
    files_deleted, files_failed = _cleanup_candidate_scoresheet_uploads(candidate_id)
    documents_deleted, documents_failed = _cleanup_candidate_reference_documents(candidate_id)
    files_deleted += documents_deleted
    files_failed += documents_failed
    return {
        "deleted": True,
        "candidateId": candidate_id,
        "candidate": api_candidate_from_row(candidate),
        "rowsDeleted": rows_deleted,
        "filesDeleted": files_deleted,
        "filesFailed": files_failed,
    }


def _cleanup_candidate_reference_documents(candidate_id: str) -> tuple[int, int]:
    try:
        from src.candidate_documents import delete_all_candidate_documents

        document_cleanup = delete_all_candidate_documents(candidate_id)
        return (
            int(document_cleanup.get("deleted") or 0),
            int(document_cleanup.get("failed") or 0),
        )
    except Exception as cleanup_error:
        # Reference documents are ancillary. Candidate row deletion remains the
        # source-of-truth operation even when R2 cleanup is temporarily unavailable.
        LOGGER.warning(
            "Failed to clean up candidate reference documents after candidate deletion",
            extra={"candidate_id": candidate_id, "cleanup_error": str(cleanup_error)},
        )
        return 0, 1


def _cleanup_candidate_scoresheet_uploads(candidate_id: str) -> tuple[int, int]:
    try:
        from src.upload_storage import delete_candidate_scoresheet_uploads

        upload_cleanup = delete_candidate_scoresheet_uploads(candidate_id)
        return (
            int(upload_cleanup.get("deleted") or 0),
            int(upload_cleanup.get("failed") or 0),
        )
    except Exception as cleanup_error:
        LOGGER.warning(
            "Failed to clean up candidate scoring-sheet uploads after candidate deletion",
            extra={"candidate_id": candidate_id, "cleanup_error": str(cleanup_error)},
        )
        return 0, 1


def handle_list_candidate_documents(
    context: ApiContext, repo: ScoringRepository
) -> dict[str, Any]:
    candidate_id = _require_candidate_for_documents(context, repo)
    from src.candidate_documents import list_candidate_documents

    return {"documents": list_candidate_documents(candidate_id)}


def handle_upload_candidate_document(
    context: ApiContext, repo: ScoringRepository
) -> dict[str, Any]:
    candidate_id = _require_candidate_for_documents(context, repo)
    from src.candidate_documents import (
        delete_candidate_document,
        upload_candidate_document,
    )

    document = upload_candidate_document(
        candidate_id,
        str(context.payload.get("category") or ""),
        context.payload.get("file"),
        context.operator,
        context.operation_id,
    )
    try:
        candidate_still_exists = repo.get_candidate(candidate_id)
    except Exception:
        _compensate_candidate_document_upload(
            candidate_id,
            str(document.get("documentId") or ""),
            delete_candidate_document,
        )
        raise
    if not candidate_still_exists:
        _compensate_candidate_document_upload(
            candidate_id,
            str(document.get("documentId") or ""),
            delete_candidate_document,
        )
        raise ApiError("not_found", f"Candidate not found after document upload: {candidate_id}")
    return {"document": document}


def _compensate_candidate_document_upload(
    candidate_id: str,
    document_id: str,
    delete_document: Any,
) -> None:
    try:
        deleted = delete_document(candidate_id, document_id)
        if not deleted:
            LOGGER.warning(
                "Candidate document compensation found no uploaded object",
                extra={"candidate_id": candidate_id, "document_id": document_id},
            )
    except Exception as cleanup_error:
        LOGGER.warning(
            "Failed to compensate candidate document upload",
            extra={
                "candidate_id": candidate_id,
                "document_id": document_id,
                "cleanup_error": str(cleanup_error),
            },
        )


def handle_delete_candidate_document(
    context: ApiContext, repo: ScoringRepository
) -> dict[str, Any]:
    candidate_id = _require_candidate_for_documents(context, repo)
    document_id = str(context.payload.get("documentId") or "").strip()
    if not document_id:
        raise ApiError("validation", "documentId is required")
    from src.candidate_documents import delete_candidate_document

    if not delete_candidate_document(candidate_id, document_id):
        raise ApiError("not_found", f"Candidate document not found: {document_id}")
    return {
        "deleted": True,
        "candidateId": candidate_id,
        "documentId": document_id,
    }


def _require_candidate_for_documents(
    context: ApiContext, repo: ScoringRepository
) -> str:
    candidate_id = candidate_id_from_payload(context.payload)
    if not candidate_id:
        raise ApiError("validation", "candidateId is required")
    if not repo.get_candidate(candidate_id):
        raise ApiError("not_found", f"Candidate not found: {candidate_id}")
    return candidate_id


def handle_save_decision(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    api_decision = str(context.payload.get("decision") or "").strip().lower()
    decision_map = {"hire": "PASSED", "reject": "FAILED", "hold": ""}
    if api_decision not in decision_map:
        raise ApiError("validation", "decision must be hire, reject, or hold")
    employee_number = str(context.payload.get("employeeNumber") or "").strip()
    if decision_map[api_decision] != "PASSED" and employee_number:
        raise ApiError("validation", "職員番号は合格時のみ登録できます")
    candidate = repo.save_decision(candidate_id, decision_map[api_decision], employee_number, context.operator)
    return {"candidate": api_candidate_from_row(candidate)}


def handle_finalize(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    return finalize_candidate(candidate_id, context.operator, repo)


def finalize_candidate(candidate_id: str, actor: str, repo: ScoringRepository) -> dict[str, Any]:
    raw_cells = repo.get_raw_cells(candidate_id)
    if not raw_cells:
        raise ApiError("not_found", f"Raw cells not found: {candidate_id}")
    unresolved = int(number_or_default(raw_cells.get("unresolved_count"), 0))
    if unresolved > 0:
        raise ApiError("validation", f"Unresolved review items remain: {unresolved}")
    cells = extract_cells(raw_cells)
    if not any(cell.get("value") is not None for cell in cells.values()):
        raise ApiError("validation", "テスト結果が未入力です。先に採点用紙のアップロードまたはセル入力を行ってください。")
    masters = repo.read_masters(candidate_id)

    try:
        from src.scoring import score_candidate
    except ImportError as error:
        raise ApiError("internal", "src.scoring.score_candidate is not available") from error

    scored = score_candidate(
        cells,
        masters["item_master"],
        masters["score_bands"],
        masters["rank_rules"],
        masters["handwritten_totals"] or None,
    )
    issues = getattr(scored, "issues", []) or []
    if issues:
        labels = [str(item.get("cell") or item.get("key") or "") for item in issues]
        raise ApiError("validation", f"Undecided cells remain: {', '.join(filter(None, labels))}")

    result_row = score_result_to_row(scored, candidate_id, actor, masters["item_master"])
    repo.upsert_result(result_row)
    repo.update_candidate_status(candidate_id, "FINALIZED")
    dashboard = repo.get_dashboard_data(candidate_id)
    return {"result": api_result_from_dashboard(dashboard)}


def handle_get_result_pdf(context: ApiContext, repo: ScoringRepository) -> dict[str, Any]:
    candidate_id = require_candidate_id(context.payload)
    dashboard = repo.get_dashboard_data(candidate_id)
    if not dashboard.get("candidate"):
        raise ApiError("not_found", f"Candidate not found: {candidate_id}")
    if not dashboard.get("result"):
        raise ApiError("validation", "採点結果がまだ確定していません。先に「結果を表示」または「採点確定」を実行してください。")
    return build_pdf_response(
        dashboard["candidate"],
        dashboard["result"],
        dashboard.get("rawCellSummary"),
        candidate_id,
    )


def build_pdf_response(
    candidate: dict[str, Any],
    result: dict[str, Any],
    raw_cell_summary: dict[str, Any] | None,
    fallback_name: str = "",
) -> dict[str, Any]:
    """Render the result PDF and package it as the {filename, mimeType, base64} contract.

    Shared by the Sheets-backed handle_get_result_pdf and the D1-only /render-pdf route,
    so both paths return an identical response shape.
    """
    try:
        from src.pdf import build_result_pdf
    except ImportError as error:
        raise ApiError("internal", "src.pdf.build_result_pdf is not available") from error

    pdf_bytes = build_result_pdf(candidate or {}, result or {}, raw_cell_summary)
    name = (candidate.get("name") if isinstance(candidate, dict) else "") or fallback_name or "result"
    return {
        "filename": f"CHEQ_{name}.pdf",
        "mimeType": "application/pdf",
        "base64": base64.b64encode(pdf_bytes).decode("ascii"),
    }


def validate_candidate_profile_payload(payload: dict[str, Any]) -> None:
    name = str(payload.get("name") or "").strip()
    test_date = str(payload.get("testDate") or "").strip()
    if not name:
        raise ApiError("validation", "name is required")
    if not test_date:
        raise ApiError("validation", "testDate is required")
    import re
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", test_date):
        raise ApiError("validation", "testDate must be YYYY-MM-DD")


def dashboard_gender(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"male", "m", "man", "men", "男性", "男"}:
        return "male"
    if normalized in {"female", "f", "woman", "women", "女性", "女"}:
        return "female"
    if normalized in {"other", "その他", "回答しない", "非回答"}:
        return "other"
    return "unknown"

def require_candidate_id(payload: dict[str, Any]) -> str:
    candidate_id = candidate_id_from_payload(payload)
    if not candidate_id:
        raise ApiError("validation", "candidateId is required")
    return candidate_id


def normalize_api_cells(cells: Any) -> dict[str, int]:
    if not isinstance(cells, dict):
        raise ApiError("validation", "cells must be an object")
    normalized: dict[str, int] = {}
    for key, raw in cells.items():
        if key not in CELL_KEYS:
            raise ApiError("validation", f"Invalid cell key: {key}")
        value_raw = raw.get("value") if isinstance(raw, dict) else raw
        try:
            value = int(value_raw)
        except (TypeError, ValueError) as error:
            raise ApiError("validation", f"{key} must be one of 0/1/2/3") from error
        if value not in {0, 1, 2, 3}:
            raise ApiError("validation", f"{key} must be one of 0/1/2/3")
        normalized[str(key)] = value
    if not normalized:
        raise ApiError("validation", "cells must include at least one cell")
    return normalized


def extract_cells(raw_cells: dict[str, Any]) -> dict[str, dict[str, Any]]:
    cells = {}
    for key in CELL_KEYS:
        value = number_or_null(raw_cells.get(key))
        cells[key] = {"value": value if value in {0, 1, 2, 3} else None, "confidence": 1}
    return cells


def score_result_to_row(
    scored: Any, candidate_id: str, actor: str, item_master: list[dict[str, Any]]
) -> dict[str, Any]:
    to_row = getattr(scored, "to_results_row", None)
    if callable(to_row):
        row = dict(to_row())
    else:
        row = {
            "row_scores_json": json.dumps(getattr(scored, "row_scores", {}), ensure_ascii=False),
            "item_totals_json": json.dumps(getattr(scored, "item_totals", {}), ensure_ascii=False),
            "item_stages_json": json.dumps(getattr(scored, "item_stages", {}), ensure_ascii=False),
            "cross_check_json": json.dumps(getattr(scored, "cross_check", []), ensure_ascii=False),
            "job_requirement_low_items_json": json.dumps(
                getattr(scored, "job_requirement_low_items", []), ensure_ascii=False
            ),
            "total_rank": getattr(scored, "total_rank", ""),
            "response_attitude_stage": getattr(scored, "response_attitude_stage", "") or "",
            "minus_points": getattr(scored, "minus_points", 0),
            "attitude_minus_points": getattr(scored, "attitude_minus_points", 0),
            "job_requirement_minus_points": getattr(scored, "job_requirement_minus_points", 0),
            "notes": getattr(scored, "notes", ""),
        }
    row["candidate_id"] = candidate_id
    row["finalized_by"] = actor
    row["finalized_at"] = now_iso()
    row["status"] = "FINALIZED"
    return row


def get_result_response_from_dashboard(dashboard: dict[str, Any]) -> dict[str, Any]:
    candidate_row = dashboard.get("candidate") or {}
    candidate = api_candidate_from_row(candidate_row)
    if candidate.get("decision") == "hold":
        candidate["decision"] = None
    return {
        "candidate": candidate,
        "result": detailed_result_from_dashboard(dashboard) if dashboard.get("result") else None,
        "rawCellSummary": raw_cell_summary_from_dashboard(dashboard.get("rawCellSummary")),
        "sourceUrl": candidate_row.get("source_url") or "",
    }


def detailed_result_from_dashboard(dashboard: dict[str, Any]) -> dict[str, Any]:
    candidate = dashboard.get("candidate") or {}
    result = dashboard.get("result") or {}
    job_source = (
        result.get("minus_points")
        if result.get("job_requirement_minus_points") in ("", None)
        else result.get("job_requirement_minus_points")
    )
    return {
        "candidateId": candidate.get("candidate_id") or result.get("candidate_id") or "",
        "totalRank": result.get("total_rank") or "",
        "responseAttitudeStage": number_or_null(result.get("response_attitude_stage")),
        "attitudeMinusPoints": number_or_default(result.get("attitude_minus_points"), 0),
        "jobRequirementMinusPoints": number_or_default(job_source, 0),
        "jobRequirementLowItems": job_requirement_low_items(result.get("job_requirement_low_items")),
        "items": result_items(result.get("item_totals") or {}, result.get("item_stages") or {}),
        "crossCheck": cross_check_items(result.get("cross_check")),
        "notes": result.get("notes") or "",
        "finalizedBy": result.get("finalized_by") or "",
        "finalizedAt": serialize_date_like(result.get("finalized_at")),
        "status": api_normalize_candidate_status(result.get("status") or candidate.get("status")),
    }


def result_items(item_totals: dict[str, Any], item_stages: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "key": item["key"],
            "label": item["label"],
            "total": number_or_null(value_by_item(item_totals, item)),
            "stage": number_or_null(value_by_item(item_stages, item)),
            "isJobRequirement": is_job_requirement_item(item),
            "isAttitude": bool(item.get("isAttitude")),
        }
        for item in default_item_master()
    ]


def default_item_master() -> list[dict[str, Any]]:
    return [
        {"key": "self_control", "label": "①セルフコントロール", "isAttitude": False},
        {"key": "communication", "label": "②コミュニケーション", "isAttitude": False},
        {"key": "situation", "label": "③状況認識力", "isAttitude": False},
        {"key": "stress", "label": "④ストレス対処力", "isAttitude": False},
        {"key": "proactivity", "label": "⑤積極性", "isAttitude": False},
        {"key": "goal", "label": "⑥目標達成力", "isAttitude": False},
        {"key": "positive", "label": "⑦ポジティブ思考力", "isAttitude": False},
        {"key": "teamwork", "label": "⑧チームワーク", "isAttitude": False},
        {"key": "hospitality", "label": "⑨ホスピタリティー", "isAttitude": False},
        {"key": "attitude", "label": "応答態度", "isAttitude": True},
    ]


def value_by_item(values: dict[str, Any], item: dict[str, Any]) -> Any:
    if item["label"] in values:
        return values[item["label"]]
    return values.get(item["key"], "")


def is_job_requirement_item(item: dict[str, Any]) -> bool:
    if item.get("isAttitude"):
        return False
    return str(item.get("label") or "")[:1] in {"⑤", "⑥", "⑦", "⑧", "⑨"}


def job_requirement_low_items(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [{"label": item.get("label") or "", "stage": number_or_null(item.get("stage"))} for item in items]


def cross_check_items(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [
        {
            "item": item.get("item") or "",
            "computed": number_or_null(item.get("computed")),
            "handwritten": number_or_null(item.get("handwritten")),
        }
        for item in items
    ]


def raw_cell_summary_from_dashboard(summary: Any) -> dict[str, Any] | None:
    if not summary:
        return None
    return {
        "confidenceAvg": number_or_null(summary.get("confidence_avg")),
        "unresolvedCount": number_or_null(summary.get("unresolved_count")),
        "pageIndex": number_or_null(summary.get("page_index")),
        "updatedAt": serialize_date_like(summary.get("updated_at")),
    }


def api_result_from_dashboard(dashboard: dict[str, Any]) -> dict[str, Any]:
    candidate = dashboard.get("candidate") or {}
    result = dashboard.get("result") or {}
    return {
        "candidateId": candidate.get("candidate_id") or result.get("candidate_id") or "",
        "totalRank": result.get("total_rank") or "",
        "responseAttitudeStage": None
        if result.get("response_attitude_stage") == ""
        else result.get("response_attitude_stage"),
        "minusPoints": None if result.get("minus_points") == "" else number_or_null(result.get("minus_points")),
        "attitudeMinusPoints": None
        if result.get("attitude_minus_points") == ""
        else number_or_null(result.get("attitude_minus_points")),
        "jobRequirementMinusPoints": None
        if result.get("job_requirement_minus_points") == ""
        else number_or_null(result.get("job_requirement_minus_points")),
        "finalizedBy": result.get("finalized_by") or "",
        "finalizedAt": serialize_date_like(result.get("finalized_at")),
        "notes": result.get("notes") or "",
    }
