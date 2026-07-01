"""migrate_sheets_to_d1 の生成 SQL を実マイグレーションスキーマの SQLite に流して検証する。"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from scripts.migrate_sheets_to_d1 import (
    TABLES,
    build_sql,
    validate_rows,
)

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "web" / "migrations"
# 候補者系テーブルに必要な migration のみ適用（評定/ファイルは不要）。
SCHEMA_FILES = ["0001_initial.sql", "0005_candidate_gender.sql",
                "0006_candidate_list_indexes.sql", "0009_candidate_address.sql"]


def spec(table: str):
    return next(t for t in TABLES if t.d1_table == table)


def make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    for name in SCHEMA_FILES:
        conn.executescript((MIGRATIONS_DIR / name).read_text(encoding="utf-8"))
    return conn


def row(**kw):
    kw.setdefault("_row_number", 2)
    return kw


def apply(conn, table, rows, candidate_ids=None):
    good, problems = validate_rows(spec(table), rows, candidate_ids or set())
    conn.executescript(build_sql(spec(table), good, batch_size=50))
    return good, problems


def cand(cid="c1", **over):
    base = dict(candidate_id=cid, name="山田", test_date="2026-06-01", role="",
                uploaded_at="2026-06-01T00:00:00Z", status="FINALIZED",
                source_url="", memo="", hiring_decision="PASSED", employee_number="",
                decision_by="", decision_at="", updated_at="2026-06-01T00:00:00Z",
                gender="male", postal_code="", prefecture="富山県", city="富山市", address_line="")
    base.update(over)
    return row(**base)


def rawcell(cid="c1", **over):
    cells = {f"s{i:02d}": "" for i in range(1, 81)}
    cells.update(over.pop("cells", {}))
    base = dict(candidate_id=cid, confidence_avg="0.9", unresolved_count="0",
                page_index="0", updated_at="2026-06-01T00:00:00Z", **cells)
    base.update(over)
    return row(**base)


def test_schema_loads():
    conn = make_db()
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"candidates", "raw_cells", "results", "review_queue", "users"} <= names


def test_candidate_quote_and_japanese_roundtrip():
    conn = make_db()
    apply(conn, "candidates", [cand(name="O'Brien 太郎", city="高岡市")])
    got = conn.execute("SELECT name, city, prefecture FROM candidates WHERE candidate_id='c1'").fetchone()
    assert got == ("O'Brien 太郎", "高岡市", "富山県")


def test_raw_cells_value_clamped_to_0_3():
    conn = make_db()
    apply(conn, "candidates", [cand()])
    # s01=2 (valid), s02=4 (out of range -> null), s03=1.5 (non-int -> null), s04='' (null)
    apply(conn, "raw_cells", [rawcell(cells={"s01": "2", "s02": "4", "s03": "1.5", "s04": ""})],
          candidate_ids={"c1"})
    cells = json.loads(conn.execute("SELECT cells_json FROM raw_cells WHERE candidate_id='c1'").fetchone()[0])
    assert cells["s01"]["value"] == 2
    assert cells["s02"]["value"] is None
    assert cells["s03"]["value"] is None
    assert cells["s04"]["value"] is None
    assert cells["s01"]["confidence"] == 1


def test_upsert_does_not_cascade_delete_children():
    """親 candidates の再適用で子 raw_cells が消えないこと（REPLACE 回帰防止）。"""
    conn = make_db()
    apply(conn, "candidates", [cand()])
    apply(conn, "raw_cells", [rawcell(cells={"s01": "3"})], candidate_ids={"c1"})
    assert conn.execute("SELECT COUNT(*) FROM raw_cells").fetchone()[0] == 1
    # 親を再適用（名前変更）。upsert なので子は残る。
    apply(conn, "candidates", [cand(name="更新後")])
    assert conn.execute("SELECT COUNT(*) FROM raw_cells").fetchone()[0] == 1
    assert conn.execute("SELECT name FROM candidates WHERE candidate_id='c1'").fetchone()[0] == "更新後"


def test_results_nullable_ints_and_json_verbatim():
    conn = make_db()
    apply(conn, "candidates", [cand()])
    r = row(candidate_id="c1", total_rank="A", response_attitude_stage="", minus_points="3",
            attitude_minus_points="", job_requirement_minus_points="1",
            job_requirement_low_items_json='["x"]', row_scores_json="{}", item_totals_json="{}",
            item_stages_json="{}", cross_check_json="[]", notes="", finalized_by="", finalized_at="",
            status="FINALIZED")
    apply(conn, "results", [r], candidate_ids={"c1"})
    got = conn.execute(
        "SELECT response_attitude_stage, minus_points, job_requirement_low_items_json FROM results WHERE candidate_id='c1'"
    ).fetchone()
    assert got[0] is None and got[1] == 3 and got[2] == '["x"]'


def test_child_with_unknown_candidate_is_flagged():
    good, problems = validate_rows(spec("raw_cells"), [rawcell(cid="ghost")], candidate_ids={"c1"})
    assert good == [] and any("存在しない" in p for p in problems)


def test_empty_pk_is_flagged():
    good, problems = validate_rows(spec("candidates"), [cand(candidate_id="")], candidate_ids=set())
    assert good == [] and any("必須列が空" in p for p in problems)


def test_users_invalid_role_is_failfast_not_silent():
    """不正 role は黙って落とさず problem として検出（権限行のサイレント欠落防止）。"""
    rows = [row(email="OP@x.com", role="operator", active="true"),
            row(email="bad@x.com", role="manager", active="1")]  # manager は不正
    good, problems = validate_rows(spec("users"), rows, set())
    assert len(good) == 1
    assert any("manager" in p for p in problems)
    # 有効ユーザーは lower 正規化 + active=1 で投入される
    conn = make_db()
    conn.executescript(build_sql(spec("users"), good, batch_size=50))
    assert conn.execute("SELECT active FROM users WHERE email='op@x.com'").fetchone()[0] == 1


def test_nan_inf_in_cells_and_numeric_columns_become_null():
    conn = make_db()
    apply(conn, "candidates", [cand()])
    apply(conn, "raw_cells",
          [rawcell(cells={"s01": "nan", "s02": "inf", "s03": "3"}, confidence_avg="nan", page_index="inf")],
          candidate_ids={"c1"})
    r = conn.execute("SELECT cells_json, confidence_avg, page_index FROM raw_cells WHERE candidate_id='c1'").fetchone()
    cells = json.loads(r[0])
    assert cells["s01"]["value"] is None  # nan -> null
    assert cells["s02"]["value"] is None  # inf -> null
    assert cells["s03"]["value"] == 3
    assert r[1] is None and r[2] is None  # NaN/Inf 数値列も NULL


def test_handwritten_composite_pk_upsert():
    conn = make_db()
    apply(conn, "candidates", [cand()])
    apply(conn, "handwritten_totals", [row(candidate_id="c1", item_key="goal", total="12")], candidate_ids={"c1"})
    apply(conn, "handwritten_totals", [row(candidate_id="c1", item_key="goal", total="15")], candidate_ids={"c1"})
    total = conn.execute("SELECT total FROM handwritten_totals WHERE candidate_id='c1' AND item_key='goal'").fetchone()[0]
    assert total == 15
    assert conn.execute("SELECT COUNT(*) FROM handwritten_totals").fetchone()[0] == 1
