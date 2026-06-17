"""テスト・動作確認用の合成採点表(page.5)画像を生成する。

実物と同じ構造で得点表を描く:
  - 20行 × (ラベル列 + 記入列 + [設問番号 + 選択肢4] × 4グループ)
  - 選択肢セルには scoresheet_digit_map.json の並びで 0〜3 を印字
  - 回答の数字を手書き風の○(楕円)で囲む
格子検出(scoresheet_grid.py)がそのまま通るので、認識テストの入力に使える。
"""

import cv2
import numpy as np

from src.scoresheet_layout import (
    LETTERS,
    cell_for_grid,
    load_digit_map,
)

PAGE_W, PAGE_H = 2339, 1654  # A4横 200dpi相当
TABLE = {"left": 0.40, "top": 0.32, "right": 0.88, "bottom": 0.90}
LABEL_COLS = 2  # ラベル列 + 手書き記入列


def make_synthetic_scoresheet(
    values: dict[str, int],
    blank: set[str] = frozenset(),
    extra_circles: dict[str, int] | None = None,
) -> bytes:
    """採点表の合成画像(PNGバイト列)を生成する。

    Args:
        values: セルキー(s01〜s80) -> ○を付ける値(0〜3)。未指定セルは 0 に○。
        blank: ○を付けない(空欄にする)セルキーの集合。
        extra_circles: 二重回答を再現する。セルキー -> 追加で○を付ける値。
    """
    extra_circles = extra_circles or {}
    digit_map = load_digit_map()
    page = np.full((PAGE_H, PAGE_W), 250, dtype=np.uint8)

    x0, y0 = int(TABLE["left"] * PAGE_W), int(TABLE["top"] * PAGE_H)
    x1, y1 = int(TABLE["right"] * PAGE_W), int(TABLE["bottom"] * PAGE_H)
    total_cols = LABEL_COLS + 20
    col_w = (x1 - x0) / total_cols
    row_h = (y1 - y0) / 20

    # 罫線
    for r in range(21):
        yy = int(y0 + r * row_h)
        cv2.line(page, (x0, yy), (x1, yy), 60, 2)
    for c in range(total_cols + 1):
        xx = int(x0 + c * col_w)
        cv2.line(page, (xx, y0), (xx, y1), 60, 2)

    font = cv2.FONT_HERSHEY_SIMPLEX
    for row in range(20):
        block, li = row // 10, row % 10
        _put_center(page, LETTERS[li], _cell_rect(x0, y0, col_w, row_h, row, 0), font)
        for group in range(4):
            key = cell_for_grid(row, group)
            digits = digit_map[key]
            qno = [61, 41, 21, 1][group] + li if block == 0 else [71, 51, 31, 11][group] + li
            _put_center(page, str(qno), _cell_rect(x0, y0, col_w, row_h, row, LABEL_COLS + group * 5), font)

            circled: set[int] = set()
            if key not in blank:
                circled.add(values.get(key, 0))
            if key in extra_circles:
                circled.add(extra_circles[key])
            for slot in range(4):
                rect = _cell_rect(x0, y0, col_w, row_h, row, LABEL_COLS + group * 5 + 1 + slot)
                _put_center(page, str(digits[slot]), rect, font)
                if digits[slot] in circled:
                    cx, cy = rect[0] + rect[2] // 2, rect[1] + rect[3] // 2
                    axes = (int(rect[2] * 0.38), int(rect[3] * 0.40))
                    cv2.ellipse(page, (cx, cy), axes, 0, 0, 360, 40, 2, cv2.LINE_AA)

    ok, encoded = cv2.imencode(".png", page)
    if not ok:
        raise RuntimeError("failed to encode synthetic scoresheet")
    return encoded.tobytes()


def _cell_rect(x0: int, y0: int, col_w: float, row_h: float, row: int, col: int) -> tuple[int, int, int, int]:
    return (
        int(x0 + col * col_w) + 2,
        int(y0 + row * row_h) + 2,
        int(col_w) - 4,
        int(row_h) - 4,
    )


def _put_center(page: np.ndarray, text: str, rect: tuple[int, int, int, int], font) -> None:
    x, y, w, h = rect
    scale = h / 70.0
    thickness = 2
    (tw, th), _ = cv2.getTextSize(text, font, scale, thickness)
    org = (x + (w - tw) // 2, y + (h + th) // 2)
    cv2.putText(page, text, org, font, scale, 30, thickness, cv2.LINE_AA)
