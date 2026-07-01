#!/usr/bin/env python3
"""Sheets → Cloudflare D1 の一回限り移行（オフライン ETL）。

本番 Google Sheets を `src.sheets.SheetsClient` で読み込み、D1 に流し込むための
SQL ファイル群を生成する。**D1 自体には触れない**（生成した SQL を
`wrangler d1 execute cheq-eqtest-db --remote --file=<file>.sql` で別途適用する）。

実行例（scoring-api ディレクトリから）:
    uv run python scripts/migrate_sheets_to_d1.py            # out/ に SQL 生成
    uv run python scripts/migrate_sheets_to_d1.py --dry-run  # 件数・問題だけ確認
    uv run python scripts/migrate_sheets_to_d1.py --include-masters

前提: 実行する ADC が対象スプレッドシートを読める権限（spreadsheets スコープ）を持つこと。
    gcloud auth application-default login \
      --scopes=https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/cloud-platform

設計上の安全策（Codex レビュー反映）:
- 親(candidates)は `INSERT OR REPLACE` を使わない。REPLACE は delete→insert で
  ON DELETE CASCADE により子(raw_cells/results/review_queue/candidate_files)を消す。
  代わりに `ON CONFLICT(pk) DO UPDATE`（upsert）で再実行安全にする。
- セル値は採点系と同じく {0,1,2,3} のみ採用（それ以外/NaN は None）。
- 必須キー(PK)が空、子の candidate_id が親に無い行は既定で fail-fast（--skip-invalid で除外）。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Callable

# `from src.xxx import ...` を cwd に依存せず解決できるよう scoring-api/ を sys.path へ。
SCRIPT_DIR = Path(__file__).resolve().parent
SCORING_API_DIR = SCRIPT_DIR.parent  # scoring-api/
if str(SCORING_API_DIR) not in sys.path:
    sys.path.insert(0, str(SCORING_API_DIR))

from src.config import DEFAULT_SPREADSHEET_ID  # noqa: E402
from src.repository import (  # noqa: E402
    CELL_KEYS,
    SHEETS,
    normalize_candidate_gender,
    normalize_email,
    number_or_null,
    parse_bool,
)
from src.sheets import SheetsClient, values_to_table  # noqa: E402

VALID_ROLES = {"operator", "reviewer", "admin"}
VALID_CELL_VALUES = {0, 1, 2, 3}  # repository._normalize_recognition_cells と同じ

Formatter = Callable[[dict[str, Any]], str]


# ---------------------------------------------------------------------------
# 数値ユーティリティ（NaN/Inf を None 扱いにする）
# ---------------------------------------------------------------------------
def finite_number(value: Any) -> int | float | None:
    n = number_or_null(value)
    if n is None or not math.isfinite(n):
        return None
    return n


# ---------------------------------------------------------------------------
# SQL 値フォーマッタ（D1/SQLite）
# ---------------------------------------------------------------------------
def q(value: Any) -> str:
    """文字列を SQLite のリテラルに（シングルクオートを二重化）。"""
    return "'" + str(value).replace("'", "''") + "'"


def text_notnull(value: Any) -> str:
    """NOT NULL な TEXT 列。空/None は '' を入れる（D1 の DEFAULT '' と整合）。"""
    return q("" if value is None else str(value))


def int_nullable(value: Any) -> str:
    n = finite_number(value)
    return "NULL" if n is None else str(int(n))


def int_notnull(value: Any, default: int = 0) -> str:
    n = finite_number(value)
    return str(int(default if n is None else n))


def real_nullable(value: Any) -> str:
    n = finite_number(value)
    return "NULL" if n is None else repr(float(n))


# ---------------------------------------------------------------------------
# 列マッピング
# ---------------------------------------------------------------------------
def text_col(name: str) -> tuple[str, Formatter]:
    return name, (lambda row, n=name: text_notnull(row.get(n, "")))


def int_null_col(name: str) -> tuple[str, Formatter]:
    return name, (lambda row, n=name: int_nullable(row.get(n, "")))


def int_notnull_col(name: str) -> tuple[str, Formatter]:
    return name, (lambda row, n=name: int_notnull(row.get(n, ""), 0))


def real_null_col(name: str) -> tuple[str, Formatter]:
    return name, (lambda row, n=name: real_nullable(row.get(n, "")))


def _cells_json(row: dict[str, Any]) -> str:
    obj: dict[str, dict[str, Any]] = {}
    for key in CELL_KEYS:
        value = finite_number(row.get(key, ""))
        if value not in VALID_CELL_VALUES:  # {0,1,2,3} 以外は None（採点系と一致）
            value = None
        obj[key] = {"value": value, "confidence": 1, "reason": ""}
    return q(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def candidates_columns() -> list[tuple[str, Formatter]]:
    text_cols = [
        "candidate_id", "name", "test_date", "role", "uploaded_at", "status",
        "source_url", "memo", "hiring_decision", "employee_number",
        "decision_by", "decision_at", "updated_at",
        "postal_code", "prefecture", "city", "address_line",
    ]
    cols = [text_col(c) for c in text_cols]
    # gender は本番では書き込み時に male/female/other へ正規化済み。防御的に再正規化して通す。
    cols.append(("gender", lambda row: q(normalize_candidate_gender(row.get("gender", "")))))
    return cols


def results_columns() -> list[tuple[str, Formatter]]:
    text_cols = [
        "candidate_id", "total_rank",
        "job_requirement_low_items_json", "row_scores_json", "item_totals_json",
        "item_stages_json", "cross_check_json", "notes",
        "finalized_by", "finalized_at", "status",
    ]
    int_cols = [
        "response_attitude_stage", "minus_points",
        "attitude_minus_points", "job_requirement_minus_points",
    ]
    return [text_col(c) for c in text_cols] + [int_null_col(c) for c in int_cols]


def review_queue_columns() -> list[tuple[str, Formatter]]:
    text_cols = [
        "review_id", "candidate_id", "cell_key", "detected", "reason",
        "image_link", "corrected_value", "status", "resolved_by", "resolved_at",
    ]
    return [text_col(c) for c in text_cols] + [real_null_col("confidence")]


def handwritten_totals_columns() -> list[tuple[str, Formatter]]:
    return [text_col("candidate_id"), text_col("item_key"), int_notnull_col("total")]


def rank_rules_columns() -> list[tuple[str, Formatter]]:
    # D1 では minus_points も TEXT NOT NULL DEFAULT ''
    return [text_col(c) for c in ["rule_id", "label", "condition_json", "rank", "minus_points", "note"]]


def users_columns() -> list[tuple[str, Formatter]]:
    return [
        ("email", lambda row: q(normalize_email(row.get("email", "")))),
        ("role", lambda row: q(str(row.get("role", "")).strip().lower())),
        ("active", lambda row: "1" if parse_bool(row.get("active", "")) else "0"),
    ]


def raw_cells_columns() -> list[tuple[str, Formatter]]:
    return [
        text_col("candidate_id"),
        ("cells_json", _cells_json),
        real_null_col("confidence_avg"),
        int_notnull_col("unresolved_count"),
        int_null_col("page_index"),
        ("image_links_json", lambda row: q("{}")),
        text_col("updated_at"),
    ]


def item_master_columns() -> list[tuple[str, Formatter]]:
    return [text_col("item_key"), text_col("label"), text_col("letter"),
            text_col("is_attitude"), int_notnull_col("display_order")]


def score_bands_columns() -> list[tuple[str, Formatter]]:
    return [text_col("item_key"), int_notnull_col("min_score"),
            int_notnull_col("max_score"), int_notnull_col("stage")]


# ---------------------------------------------------------------------------
# テーブル定義
# ---------------------------------------------------------------------------
class TableSpec:
    def __init__(
        self,
        file_prefix: str,
        d1_table: str,
        sheet_key: str,
        columns_fn: Callable[[], list[tuple[str, Formatter]]],
        mode: str,            # "UPSERT" | "IGNORE"
        pk: list[str],
        required: list[str] | None = None,   # 非空必須列（既定 = pk）
        parent_fk: str | None = None,         # candidate_id 等、親 candidates を参照する列
        value_in: dict[str, set[str]] | None = None,  # 列値の許可集合（小文字比較）
        master: bool = False,
    ) -> None:
        self.file_prefix = file_prefix
        self.d1_table = d1_table
        self.sheet_key = sheet_key
        self.columns_fn = columns_fn
        self.mode = mode
        self.pk = pk
        self.required = required if required is not None else list(pk)
        self.parent_fk = parent_fk
        self.value_in = value_in or {}
        self.master = master


TABLES: list[TableSpec] = [
    TableSpec("00", "users", "users", users_columns, "IGNORE", pk=["email"], required=["email", "role"],
              value_in={"role": VALID_ROLES}),
    TableSpec("01", "rank_rules", "rankRules", rank_rules_columns, "UPSERT", pk=["rule_id"]),
    TableSpec("02", "item_master", "itemMaster", item_master_columns, "IGNORE", pk=["item_key"], master=True),
    TableSpec("03", "score_bands", "scoreBands", score_bands_columns, "IGNORE",
              pk=["item_key", "min_score", "max_score"], master=True),
    TableSpec("10", "candidates", "candidates", candidates_columns, "UPSERT",
              pk=["candidate_id"], required=["candidate_id", "name", "test_date", "uploaded_at", "status", "updated_at"]),
    TableSpec("20", "raw_cells", "rawCells", raw_cells_columns, "UPSERT",
              pk=["candidate_id"], required=["candidate_id", "updated_at"], parent_fk="candidate_id"),
    TableSpec("21", "results", "results", results_columns, "UPSERT",
              pk=["candidate_id"], parent_fk="candidate_id"),
    TableSpec("22", "review_queue", "reviewQueue", review_queue_columns, "UPSERT",
              pk=["review_id"], required=["review_id", "candidate_id", "status"], parent_fk="candidate_id"),
    TableSpec("23", "handwritten_totals", "handwrittenTotals", handwritten_totals_columns, "UPSERT",
              pk=["candidate_id", "item_key"], parent_fk="candidate_id"),
]


# ---------------------------------------------------------------------------
# 検証
# ---------------------------------------------------------------------------
class Problem(Exception):
    pass


def validate_rows(
    spec: TableSpec, rows: list[dict[str, Any]], candidate_ids: set[str]
) -> tuple[list[dict[str, Any]], list[str]]:
    """有効行と問題メッセージを返す。"""
    good: list[dict[str, Any]] = []
    problems: list[str] = []
    for row in rows:
        rn = row.get("_row_number", "?")
        missing = [c for c in spec.required if str(row.get(c, "")).strip() == ""]
        if missing:
            problems.append(f"{spec.d1_table} row {rn}: 必須列が空 {missing}")
            continue
        if spec.parent_fk:
            cid = str(row.get(spec.parent_fk, "")).strip()
            if cid not in candidate_ids:
                problems.append(f"{spec.d1_table} row {rn}: candidate_id={cid!r} が candidates に存在しない")
                continue
        bad = next(((c, str(row.get(c, "")).strip().lower())
                    for c, allowed in spec.value_in.items()
                    if str(row.get(c, "")).strip().lower() not in allowed), None)
        if bad:
            problems.append(f"{spec.d1_table} row {rn}: {bad[0]}={bad[1]!r} は不正値（許可: {sorted(spec.value_in[bad[0]])}）")
            continue
        good.append(row)
    return good, problems


# ---------------------------------------------------------------------------
# SQL 生成
# ---------------------------------------------------------------------------
def build_sql(spec: TableSpec, rows: list[dict[str, Any]], batch_size: int) -> str:
    columns = spec.columns_fn()
    col_names = [name for name, _ in columns]
    header = (
        f"-- {spec.d1_table}: {len(rows)} rows  (mode={spec.mode})\n"
        "PRAGMA foreign_keys=ON;\n"
    )
    if not rows:
        return header + f"-- (no rows for {spec.d1_table})\n"

    if spec.mode == "IGNORE":
        insert_head = f"INSERT OR IGNORE INTO {spec.d1_table} ({', '.join(col_names)}) VALUES"
        suffix = ";"
    else:  # UPSERT
        insert_head = f"INSERT INTO {spec.d1_table} ({', '.join(col_names)}) VALUES"
        update_cols = [c for c in col_names if c not in spec.pk]
        set_clause = ", ".join(f"{c}=excluded.{c}" for c in update_cols)
        conflict = ", ".join(spec.pk)
        suffix = f"\nON CONFLICT({conflict}) DO UPDATE SET {set_clause};" if update_cols else \
                 f"\nON CONFLICT({conflict}) DO NOTHING;"

    parts = [header]
    for start in range(0, len(rows), batch_size):
        chunk = rows[start:start + batch_size]
        value_rows = ["(" + ", ".join(fmt(row) for _, fmt in columns) + ")" for row in chunk]
        parts.append(insert_head + "\n" + ",\n".join(value_rows) + suffix + "\n")
    return "\n".join(parts)


def read_rows(client: SheetsClient, sheet_key: str) -> list[dict[str, Any]]:
    return values_to_table(client.get_values(SHEETS[sheet_key])).rows


# ---------------------------------------------------------------------------
# 警告（データ品質）
# ---------------------------------------------------------------------------
def quality_warnings(table: str, rows: list[dict[str, Any]]) -> list[str]:
    warnings: list[str] = []
    if table == "candidates":
        lossy = [row.get("_row_number") for row in rows
                 if str(row.get("gender", "")).strip() and not normalize_candidate_gender(row.get("gender"))]
        if lossy:
            warnings.append(f"candidates: gender が male/female/other 以外で空に正規化される行 {lossy}")
    if table == "users":
        blank = [row.get("_row_number") for row in rows if str(row.get("active", "")).strip() == ""]
        if blank:
            warnings.append(f"users: active 空欄→0(無効) 扱いの行 {blank}（意図を確認）")
    return warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Sheets → D1 一回限り移行 SQL ジェネレータ")
    parser.add_argument("--spreadsheet-id", default=None)
    parser.add_argument("--out-dir", default=str(SCRIPT_DIR / "out"))
    parser.add_argument("--include-masters", action="store_true")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--dry-run", action="store_true", help="読み込み件数・問題のみ表示")
    parser.add_argument("--skip-invalid", action="store_true", help="無効行を中断せず除外")
    args = parser.parse_args()

    spreadsheet_id = args.spreadsheet_id or os.environ.get("SCORING_SPREADSHEET_ID", DEFAULT_SPREADSHEET_ID)
    client = SheetsClient(spreadsheet_id)
    out_dir = Path(args.out_dir)

    specs = [t for t in TABLES if args.include_masters or not t.master]

    print(f"spreadsheet_id = {spreadsheet_id}")
    print(f"out_dir        = {out_dir}{'  (dry-run)' if args.dry_run else ''}")

    raw: dict[str, list[dict[str, Any]]] = {spec.d1_table: read_rows(client, spec.sheet_key) for spec in specs}

    # candidate_id 集合は「検証済み candidates」から作る。raw から作ると --skip-invalid 時に
    # 親を除外しても子が通って適用時 FK 失敗になる（candidates は specs 内で子より前に処理される）。
    candidate_ids: set[str] = set()
    all_problems: list[str] = []
    all_warnings: list[str] = []
    validated: dict[str, list[dict[str, Any]]] = {}
    for spec in specs:
        good, problems = validate_rows(spec, raw[spec.d1_table], candidate_ids)
        validated[spec.d1_table] = good
        all_problems += problems
        all_warnings += quality_warnings(spec.d1_table, raw[spec.d1_table])
        if spec.d1_table == "candidates":
            candidate_ids = {str(r.get("candidate_id", "")).strip() for r in good}
            candidate_ids.discard("")

    print("-" * 70)
    print(f"{'table':22} {'read':>8} {'valid':>8}")
    print("-" * 70)
    for spec in specs:
        print(f"{spec.d1_table:22} {len(raw[spec.d1_table]):>8} {len(validated[spec.d1_table]):>8}")
    print("-" * 70)

    if all_warnings:
        print("\n[WARN]")
        for w in all_warnings:
            print("  - " + w)
    if all_problems:
        print(f"\n[PROBLEM] {len(all_problems)} 件")
        for p in all_problems[:50]:
            print("  - " + p)
        if len(all_problems) > 50:
            print(f"  ... 他 {len(all_problems) - 50} 件")
        if not args.skip_invalid and not args.dry_run:
            print("\n中断: 問題を解消するか --skip-invalid で除外して再実行してください。")
            return 2

    if args.dry_run:
        print("\n(dry-run: ファイルは書き込みません)")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    for spec in specs:
        sql = build_sql(spec, validated[spec.d1_table], args.batch_size)
        (out_dir / f"{spec.file_prefix}_{spec.d1_table}.sql").write_text(sql, encoding="utf-8")

    print(f"\n生成完了: {out_dir}/*.sql")
    print("適用（親→子順にファイル名で整列済み）:")
    print(f'  for f in $(ls -1 "{out_dir}"/*.sql | sort); do')
    print('    pnpm exec wrangler d1 execute cheq-eqtest-db --remote --file="$f"; done')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
