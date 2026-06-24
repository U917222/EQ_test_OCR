from types import SimpleNamespace

from src.handlers import (
    handle_delete_candidate,
    handle_get_dashboard,
    handle_get_cells,
    handle_get_result_pdf,
    handle_register_candidate,
)
from src.repository import CELL_KEYS
from src.wire import ApiContext


class FakeRepo:
    def __init__(self):
        self.candidate = {
            "candidate_id": "cand-1",
            "name": "Example",
            "test_date": "2026-06-24",
            "role": "",
            "status": "REGISTERED",
            "uploaded_at": "2026-06-24T00:00:00+00:00",
            "source_url": "",
            "memo": "",
            "updated_at": "2026-06-24T00:00:00+00:00",
        }
        self.raw_cells = {"candidate_id": "cand-1", "unresolved_count": 0}
        self.result = None

    def create_candidate(self, payload):
        self.candidate["status"] = "PROCESSING"
        return self.candidate

    def import_recognition_result(self, candidate_id, recognition):
        assert candidate_id == "cand-1"
        self.raw_cells.update({key: cell["value"] for key, cell in recognition["cells"].items()})
        self.raw_cells["unresolved_count"] = recognition["unresolvedCount"]
        self.candidate["status"] = "REVIEW_REQUIRED" if recognition["unresolvedCount"] else "READY_TO_FINALIZE"
        return recognition["unresolvedCount"]

    def get_candidate(self, candidate_id):
        assert candidate_id == "cand-1"
        return self.candidate

    def update_candidate_source_url(self, candidate_id, source_url):
        assert candidate_id == "cand-1"
        self.candidate["source_url"] = source_url

    def delete_candidate(self, candidate_id):
        assert candidate_id == "cand-1"
        self.candidate = None
        return {
            "reviewQueue": 2,
            "rawCells": 1,
            "results": 1,
            "handwrittenTotals": 0,
            "candidates": 1,
        }

    def get_raw_cells(self, candidate_id):
        assert candidate_id == "cand-1"
        return self.raw_cells

    def get_review_queue(self, candidate_id):
        assert candidate_id == "cand-1"
        return []

    def read_masters(self, candidate_id):
        item_master = [
            {"item_key": f"cat{index}", "label": label, "letter": letter, "is_attitude": "", "display_order": index}
            for index, (label, letter) in enumerate(
                [
                    ("①セルフコントロール", "A"),
                    ("②コミュニケーション", "B"),
                    ("③状況認識力", "C"),
                    ("④ストレス対処力", "D"),
                    ("⑤積極性", "E"),
                    ("⑥目標達成力", "F"),
                    ("⑦ポジティブ思考力", "G"),
                    ("⑧チームワーク", "H"),
                    ("⑨ホスピタリティー", "I"),
                ],
                start=1,
            )
        ]
        item_master.append({"item_key": "attitude", "label": "応答態度", "letter": "J", "is_attitude": "TRUE", "display_order": 10})
        score_bands = [
            {"item_key": item["item_key"], "min_score": 0, "max_score": 24, "stage": 3}
            for item in item_master
        ]
        return {"item_master": item_master, "score_bands": score_bands, "rank_rules": [], "handwritten_totals": []}

    def upsert_result(self, row):
        self.result = row

    def update_candidate_status(self, candidate_id, status):
        self.candidate["status"] = status
        if self.result:
            self.result["status"] = status

    def get_dashboard_data(self, candidate_id):
        return {"candidate": self.candidate, "result": self.result, "rawCellSummary": self.raw_cells}


def test_register_candidate_with_clean_upload_auto_finalizes(monkeypatch):
    def fake_recognize_upload_file(file_payload):
        return {
            "cells": {key: {"value": 1, "confidence": 0.99} for key in CELL_KEYS},
            "confidenceAvg": 0.99,
            "unresolvedCount": 0,
            "pageIndex": 0,
            "imageLinks": {},
        }

    monkeypatch.setattr("src.upload_recognition.recognize_upload_file", fake_recognize_upload_file)
    monkeypatch.setattr(
        "src.upload_storage.save_upload_file",
        lambda file_payload, candidate_id: {
            "sourceUrl": "https://drive.google.com/file/d/uploaded/view",
            "mimeType": "application/pdf",
        },
    )
    context = ApiContext(
        claims={},
        payload={
            "name": "Example",
            "testDate": "2026-06-24",
            "file": {"name": "scoresheet.pdf", "mimeType": "application/pdf", "base64": "JVBERi0="},
        },
        action="registerCandidate",
        operator="operator@example.com",
        role="operator",
        operation_id="op-1",
    )

    response = handle_register_candidate(context, FakeRepo())

    assert response["candidate"]["candidateId"] == "cand-1"
    assert response["candidate"]["status"] == "finalized"
    assert response["result"]["candidateId"] == "cand-1"


def test_register_candidate_persists_upload_before_recognition(monkeypatch):
    captured = {}

    def fake_save_upload_file(file_payload, candidate_id):
        captured["stored_candidate_id"] = candidate_id
        return {"sourceUrl": "https://drive.google.com/file/d/uploaded/view", "mimeType": "application/pdf"}

    def fake_recognize_upload_file(file_payload):
        return {
            "cells": {
                key: {
                    "value": None if key == "s01" else 1,
                    "confidence": 0.2 if key == "s01" else 0.99,
                    "reason": "low_confidence" if key == "s01" else "",
                }
                for key in CELL_KEYS
            },
            "confidenceAvg": 0.98,
            "unresolvedCount": 1,
            "pageIndex": 0,
            "imageLinks": {},
        }

    monkeypatch.setattr("src.upload_storage.save_upload_file", fake_save_upload_file)
    monkeypatch.setattr("src.upload_recognition.recognize_upload_file", fake_recognize_upload_file)
    repo = FakeRepo()
    context = ApiContext(
        claims={},
        payload={
            "name": "Example",
            "testDate": "2026-06-24",
            "file": {"name": "scoresheet.pdf", "mimeType": "application/pdf", "base64": "JVBERi0="},
        },
        action="registerCandidate",
        operator="operator@example.com",
        role="operator",
        operation_id="op-1",
    )

    response = handle_register_candidate(context, repo)

    assert captured["stored_candidate_id"] == "cand-1"
    assert repo.candidate["source_url"] == "https://drive.google.com/file/d/uploaded/view"
    assert response["candidate"]["status"] == "needs_review"


def test_delete_candidate_removes_candidate_related_rows():
    context = ApiContext(
        claims={},
        payload={"candidateId": "cand-1", "operationId": "op-delete"},
        action="deleteCandidate",
        operator="operator@example.com",
        role="operator",
        operation_id="op-delete",
    )

    response = handle_delete_candidate(context, FakeRepo())

    assert response["deleted"] is True
    assert response["candidateId"] == "cand-1"
    assert response["candidate"]["candidateId"] == "cand-1"
    assert response["rowsDeleted"]["candidates"] == 1


def test_get_cells_returns_candidate_source_url_as_document_link():
    repo = FakeRepo()
    repo.candidate["source_url"] = "https://drive.google.com/file/d/uploaded/view"
    context = ApiContext(
        claims={},
        payload={"candidateId": "cand-1"},
        action="getCells",
        operator="operator@example.com",
        role="operator",
        operation_id=None,
    )

    response = handle_get_cells(context, repo)

    assert response["imageLinks"]["preview"] == "https://drive.google.com/file/d/uploaded/view"
    assert response["imageLinks"]["original"] == "https://drive.google.com/file/d/uploaded/view"


def test_get_result_pdf_uses_raw_dashboard_data(monkeypatch):
    captured = {}

    def fake_build_result_pdf(candidate, result, raw_cell_summary):
        captured["candidate"] = candidate
        captured["result"] = result
        captured["raw_cell_summary"] = raw_cell_summary
        return b"%PDF-1.7\n%%EOF"

    monkeypatch.setattr("src.pdf.build_result_pdf", fake_build_result_pdf)
    repo = FakeRepo()
    repo.result = {
        "candidate_id": "cand-1",
        "total_rank": "B",
        "response_attitude_stage": 3,
        "job_requirement_minus_points": 0,
        "attitude_minus_points": 0,
        "item_stages": {"①セルフコントロール": 4},
        "item_totals": {"①セルフコントロール": 14},
        "job_requirement_low_items": [],
        "cross_check": [],
    }
    context = ApiContext(
        claims={},
        payload={"candidateId": "cand-1"},
        action="getResultPdf",
        operator="reviewer@example.com",
        role="reviewer",
        operation_id=None,
    )

    response = handle_get_result_pdf(context, repo)

    assert response["filename"] == "CHEQ_Example.pdf"
    assert captured["candidate"]["candidate_id"] == "cand-1"
    assert captured["candidate"]["test_date"] == "2026-06-24"
    assert captured["result"]["total_rank"] == "B"
    assert captured["result"]["item_stages"]["①セルフコントロール"] == 4
    assert captured["raw_cell_summary"]["unresolved_count"] == 0


class DashboardFakeRepo:
    def __init__(self):
        self._candidates = [
            {
                "candidate_id": "c1",
                "name": "合格 太郎",
                "test_date": "2026-03-10",
                "role": "看護師",
                "status": "FINALIZED",
                "uploaded_at": "2026-03-10T01:00:00+00:00",
                "hiring_decision": "PASSED",
                "updated_at": "2026-03-11T01:00:00+00:00",
            },
            {
                "candidate_id": "c2",
                "name": "レビュー 花子",
                "test_date": "2026-07-20",
                "role": "看護師",
                "status": "REVIEW_REQUIRED",
                "uploaded_at": "2026-07-20T01:00:00+00:00",
                "hiring_decision": "",
                "updated_at": "2026-07-20T02:00:00+00:00",
            },
            {
                "candidate_id": "c3",
                "name": "前年 次郎",
                "test_date": "2025-05-05",
                "role": "介護",
                "status": "FINALIZED",
                "uploaded_at": "2025-05-05T01:00:00+00:00",
                "hiring_decision": "FAILED",
                "updated_at": "2025-05-06T01:00:00+00:00",
            },
        ]
        self._results = [
            {
                "candidate_id": "c1",
                "total_rank": "C",
                "response_attitude_stage": 3,
                "job_requirement_low_items_json": '[{"label": "⑤積極性"}]',
            }
        ]
        self._reviews = [
            {"candidate_id": "c2", "cell_key": "k1", "status": "OPEN"},
            {"candidate_id": "c2", "cell_key": "k2", "status": "OPEN"},
            {"candidate_id": "c1", "cell_key": "k1", "status": "RESOLVED"},
        ]

    def list_candidates(self):
        return list(self._candidates)

    def read_table(self, sheet_name):
        assert sheet_name == "Results"
        return SimpleNamespace(rows=list(self._results))

    def get_review_queue(self, candidate_id=""):
        if candidate_id:
            return [row for row in self._reviews if row["candidate_id"] == candidate_id]
        return list(self._reviews)

    def read_tables(self, sheet_names):
        data = {
            "Candidates": self._candidates,
            "Results": self._results,
            "ReviewQueue": self._reviews,
        }
        return {name: SimpleNamespace(rows=list(data.get(name, []))) for name in sheet_names}


def _dashboard_context(payload=None):
    return ApiContext(
        claims={},
        payload=payload or {},
        action="getDashboard",
        operator="operator@example.com",
        role="operator",
        operation_id=None,
    )


def test_get_dashboard_returns_rich_shape():
    response = handle_get_dashboard(_dashboard_context(), DashboardFakeRepo())

    assert response["year"] == 2026
    assert response["availableYears"] == [2026, 2025]
    assert response["summary"]["total"] == 2
    assert response["summary"]["previousYearTotal"] == 1
    assert response["summary"]["finalized"] == 1
    assert response["summary"]["hired"] == 1
    assert response["summary"]["passRate"] == 100
    assert response["summary"]["needsReview"] == 1
    assert response["summary"]["openReviews"] == 2
    assert response["summary"]["lowRequirementCandidates"] == 1
    assert response["summary"]["averageAttitudeStage"] == 3.0

    assert len(response["monthly"]) == 12
    assert len(response["rankBreakdown"]) == 4
    rank_c = next(item for item in response["rankBreakdown"] if item["rank"] == "C")
    assert rank_c["value"] == 1

    assert len(response["recent"]) == 2
    assert response["recent"][0]["candidateId"] == "c2"  # testDate 降順
    decision_labels = {item["label"]: item["value"] for item in response["decisionBreakdown"]}
    assert decision_labels == {"合格": 1, "不合格": 0, "未判定": 1}
    assert {item["label"] for item in response["attentionItems"]} == {"⑤積極性"}


def test_get_dashboard_respects_requested_year():
    response = handle_get_dashboard(_dashboard_context({"year": 2025}), DashboardFakeRepo())

    assert response["year"] == 2025
    assert response["summary"]["total"] == 1
    assert response["summary"]["rejected"] == 1
