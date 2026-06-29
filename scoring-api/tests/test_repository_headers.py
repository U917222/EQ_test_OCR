"""旧スキーマ（住所列なし）シートでも住所が永続化されることを検証する Red テスト。

`Candidates` シートのヘッダーが旧スキーマ（gender/postal_code/prefecture/city/
address_line/updated_at を含まない）でシードされた状態で、
ScoringRepository.create_candidate / update_candidate_profile が住所を
正しく保存・取得できることを確認する。

今は実装が未対応（ensure_headers が旧スキーマ列を reconcile する前に
append_object が走り、住所が落ちる）ため FAIL が正しい。
別担当が src/repository.py を修正すると green になる想定。
"""

from __future__ import annotations

import re
from typing import Any

import pytest

from src.repository import HEADERS, ScoringRepository

# ---------------------------------------------------------------------------
# ヘルパー: A1 記法パーサー
# ---------------------------------------------------------------------------

def _parse_a1(range_a1: str) -> tuple[int, int]:
    """'A1' → (col=1, row=1)、'M3' → (col=13, row=3) を返す（1-indexed）。"""
    m = re.fullmatch(r"([A-Z]+)(\d+)", range_a1.strip().upper())
    if not m:
        raise ValueError(f"A1 記法を解析できません: {range_a1!r}")
    col_str, row_str = m.group(1), m.group(2)
    col = 0
    for ch in col_str:
        col = col * 26 + (ord(ch) - ord("A") + 1)
    row = int(row_str)
    return col, row


# ---------------------------------------------------------------------------
# インメモリ Fake SheetsClient
# ---------------------------------------------------------------------------

class FakeSheetsClient:
    """ScoringRepository が呼び出す SheetsClient メソッドをインメモリで再現する Fake。

    内部状態: シート名 → グリッド (list[list[Any]])。
    グリッドは 0-indexed（row 0 = ヘッダー行）。
    """

    def __init__(self) -> None:
        # シート名 → グリッド (list[list[Any]])
        self._grids: dict[str, list[list[Any]]] = {}

    # -- セットアップ用ヘルパー -------------------------------------------------

    def seed(self, sheet_name: str, grid: list[list[Any]]) -> None:
        """テスト開始時にシートをシードする。"""
        import copy
        self._grids[sheet_name] = copy.deepcopy(grid)

    def grid(self, sheet_name: str) -> list[list[Any]]:
        """現在のグリッドを返す（テスト内でのアサート用）。"""
        return self._grids.get(sheet_name, [])

    # -- SheetsClient 互換メソッド -------------------------------------------

    def get_values(self, sheet_name: str, range_a1: str = "A:ZZ") -> list[list[Any]]:
        # range は無視し、シート全体を返す（Fake の簡略化）。
        return [list(row) for row in self._grids.get(sheet_name, [])]

    def batch_get_ordered(self, ranges: list[str]) -> list[list[list[Any]]]:
        # 各レンジ "'SheetName'!A:ZZ" からシート名を取り出して全体を返す。
        result = []
        for r in ranges:
            # "'Candidates'!A:ZZ" → "Candidates"
            name = r.split("!")[0].strip("'")
            result.append([list(row) for row in self._grids.get(name, [])])
        return result

    def update_values(
        self,
        sheet_name: str,
        values: list[list[Any]],
        range_a1: str = "A1",
        value_input_option: str = "USER_ENTERED",
    ) -> None:
        """range_a1 を A1 解析し、グリッドへ values を書き込む。

        - 'A5': 行 5 先頭（update_row 用）
        - 'M1': 行 1 の 13 列目（ensure_headers による列追記用）
        いずれの場合もグリッドを行・列方向に必要なだけ拡張する。
        """
        col0, row0 = _parse_a1(range_a1)  # 1-indexed
        grid = self._grids.setdefault(sheet_name, [])

        for r_offset, row_vals in enumerate(values):
            row_idx = row0 - 1 + r_offset  # 0-indexed
            # グリッドを行方向に拡張
            while len(grid) <= row_idx:
                grid.append([])
            row = grid[row_idx]
            # グリッドを列方向に拡張（書き込み先まで空文字で埋める）
            needed_cols = col0 - 1 + len(row_vals)
            while len(row) < needed_cols:
                row.append("")
            # 値を書き込む
            for c_offset, val in enumerate(row_vals):
                col_idx = col0 - 1 + c_offset  # 0-indexed
                row[col_idx] = val

    def append_values(
        self,
        sheet_name: str,
        values: list[list[Any]],
        value_input_option: str = "USER_ENTERED",
    ) -> None:
        """最終非空行の後ろに行を追加する。"""
        grid = self._grids.setdefault(sheet_name, [])
        for row_vals in values:
            grid.append(list(row_vals))

    def clear_values(self, sheet_name: str) -> None:
        self._grids[sheet_name] = []


# ---------------------------------------------------------------------------
# 旧ヘッダー定義
# ---------------------------------------------------------------------------

OLD_CANDIDATES_HEADERS: list[str] = [
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
]
# gender/postal_code/prefecture/city/address_line/updated_at は**入れない**


# ---------------------------------------------------------------------------
# フィクスチャ
# ---------------------------------------------------------------------------

@pytest.fixture()
def fake_sheets() -> FakeSheetsClient:
    """旧スキーマ（住所列なし）でシードした Fake を返す。"""
    fs = FakeSheetsClient()
    # Candidates: 旧ヘッダーのみ
    fs.seed("Candidates", [OLD_CANDIDATES_HEADERS])
    # RawCells: 現行 HEADERS 通りにシード
    fs.seed("RawCells", [HEADERS["RawCells"]])
    return fs


@pytest.fixture()
def repo(fake_sheets: FakeSheetsClient) -> ScoringRepository:
    return ScoringRepository(sheets=fake_sheets)


# ---------------------------------------------------------------------------
# テストケース 1: create_candidate が住所を永続化する
# ---------------------------------------------------------------------------

def test_create_candidate_persists_address(repo: ScoringRepository, fake_sheets: FakeSheetsClient) -> None:
    """旧スキーマの Candidates シートへ住所付きで登録し、get_candidate で取得できること。"""
    candidate = repo.create_candidate(
        {
            "name": "テスト",
            "testDate": "2026-06-24",
            "prefecture": "富山県",
            "city": "富山市",
            "postalCode": "930-0001",
            "addressLine": "X1-2",
        }
    )

    candidate_id: str = candidate["candidate_id"]
    fetched = repo.get_candidate(candidate_id)

    assert fetched is not None, "create_candidate 後に get_candidate が None を返した"
    assert fetched.get("prefecture") == "富山県", (
        f"prefecture が保存されていない: {fetched.get('prefecture')!r}"
    )
    assert fetched.get("city") == "富山市", (
        f"city が保存されていない: {fetched.get('city')!r}"
    )
    assert fetched.get("postal_code") == "930-0001", (
        f"postal_code が保存されていない: {fetched.get('postal_code')!r}"
    )
    assert fetched.get("address_line") == "X1-2", (
        f"address_line が保存されていない: {fetched.get('address_line')!r}"
    )


# ---------------------------------------------------------------------------
# テストケース 2: update_candidate_profile が住所を永続化する
# ---------------------------------------------------------------------------

def test_update_profile_persists_address(repo: ScoringRepository, fake_sheets: FakeSheetsClient) -> None:
    """旧スキーマで候補者をシードし、update_candidate_profile 後に住所が取得できること。"""
    # 旧スキーマ形式（住所列なし）で既存候補者を手動シード
    existing_row = [
        "existing-id-001",  # candidate_id
        "初期 太郎",         # name
        "2026-01-10",       # test_date
        "看護師",            # role
        "2026-01-10T00:00:00+00:00",  # uploaded_at
        "REGISTERED",       # status
        "",                 # source_url
        "",                 # memo
        "",                 # hiring_decision
        "",                 # employee_number
        "",                 # decision_by
        "",                 # decision_at
    ]
    # 既存 fake_sheets に直接行を追加（旧スキーマ列のみ）
    fake_sheets.grid("Candidates").append(existing_row)

    # update_candidate_profile で住所を設定
    updated = repo.update_candidate_profile(
        "existing-id-001",
        {
            "name": "花子",
            "testDate": "2026-06-24",
            "prefecture": "東京都",
            "city": "千代田区",
            "postalCode": "100-0001",
            "addressLine": "Y3-4",
        },
    )

    assert updated.get("prefecture") == "東京都", (
        f"prefecture が保存されていない: {updated.get('prefecture')!r}"
    )
    assert updated.get("city") == "千代田区", (
        f"city が保存されていない: {updated.get('city')!r}"
    )
    assert updated.get("postal_code") == "100-0001", (
        f"postal_code が保存されていない: {updated.get('postal_code')!r}"
    )
    assert updated.get("address_line") == "Y3-4", (
        f"address_line が保存されていない: {updated.get('address_line')!r}"
    )


# ---------------------------------------------------------------------------
# テストケース 3: Candidates ヘッダー行に住所列が reconcile されていること
# ---------------------------------------------------------------------------

def test_headers_reconciled_after_create(repo: ScoringRepository, fake_sheets: FakeSheetsClient) -> None:
    """create_candidate 後、Candidates のヘッダー行（row 0）に住所列が追記されていること。"""
    repo.create_candidate(
        {
            "name": "ヘッダー確認",
            "testDate": "2026-06-24",
            "prefecture": "神奈川県",
            "city": "横浜市",
            "postalCode": "220-0001",
            "addressLine": "Z9-0",
        }
    )

    grid = fake_sheets.grid("Candidates")
    assert len(grid) >= 1, "グリッドが空"
    header_row: list[str] = [str(v) for v in grid[0]]

    for col in ("prefecture", "city", "postal_code", "address_line"):
        assert col in header_row, (
            f"ヘッダー行に '{col}' が含まれていない。現在のヘッダー: {header_row}"
        )
