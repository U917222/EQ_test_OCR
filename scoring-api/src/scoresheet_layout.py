"""CHEQ採点表(page.5) のセル契約と数字配列マスタ。

セル契約は docs/cell-contract.md を正とする:
  - セルキー: s{NN} (NN=01..80)。index = block*40 + letterIndex*4 + (pos-1)
  - block: 0=上ブロック, 1=下ブロック / letter: A〜J / pos: 行内の小問位置 1〜4
  - 1小問 = 印字された 0〜3 のうち回答の数字を○で囲む

座標は固定値を持たない。格子は実行時に検出する (scoresheet_grid.py)。
印字数字の並び（設問ごとに昇順/降順が異なる）は scoresheet_digit_map.json が正。
"""

import json
from functools import lru_cache
from pathlib import Path

LETTERS = "ABCDEFGHIJ"
POSITIONS_PER_ROW = 4
BLOCKS = 2
CELL_COUNT = BLOCKS * len(LETTERS) * POSITIONS_PER_ROW  # 80

DIGIT_MAP_PATH = Path(__file__).with_name("scoresheet_digit_map.json")


def cell_key(block: int, letter: str, pos: int) -> str:
    """契約どおりのセルキーを返す。block: 0=上,1=下 / pos: 1〜4"""
    letter_index = LETTERS.index(letter)
    if not (0 <= block < BLOCKS) or not (1 <= pos <= POSITIONS_PER_ROW):
        raise ValueError(f"invalid cell: block={block} letter={letter} pos={pos}")
    index = block * 40 + letter_index * POSITIONS_PER_ROW + (pos - 1)
    return f"s{index + 1:02d}"


def row_key(block: int, letter: str) -> str:
    """行キー (A1=上A行, A2=下A行)。"""
    return f"{letter}{block + 1}"


ALL_CELL_KEYS = tuple(
    cell_key(block, letter, pos)
    for block in range(BLOCKS)
    for letter in LETTERS
    for pos in range(1, POSITIONS_PER_ROW + 1)
)


def cell_for_grid(row: int, group: int) -> str:
    """格子位置 (行0〜19, グループ0〜3) → セルキー。"""
    return cell_key(row // 10, LETTERS[row % 10], group + 1)


def grid_for_cell(key: str) -> tuple[int, int]:
    """セルキー → 格子位置 (行0〜19, グループ0〜3)。"""
    index = int(key[1:]) - 1
    block, rest = divmod(index, 40)
    letter_index, group = divmod(rest, POSITIONS_PER_ROW)
    return block * 10 + letter_index, group


@lru_cache(maxsize=1)
def load_digit_map() -> dict[str, list[int]]:
    """セルキー → 印字数字の並び（スロット左→右）。"""
    data = json.loads(DIGIT_MAP_PATH.read_text())
    return {key: entry["digits"] for key, entry in data["cells"].items()}


@lru_cache(maxsize=1)
def load_question_numbers() -> dict[str, int]:
    """セルキー → 元の設問番号（レビュー表示用）。"""
    data = json.loads(DIGIT_MAP_PATH.read_text())
    return {key: entry["question"] for key, entry in data["cells"].items()}
