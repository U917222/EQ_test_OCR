"""CHEQ採点表(page.5) 得点表の格子検出。

固定座標ではなく、入力画像から得点表の罫線格子を毎回検出する。
スキャン・写真の位置ズレや多少の歪みに対して頑健。

得点表の構造（ブランク原本 4.HEIC / 実スキャンで確認済み）:
  - 20行 (上ブロック A〜J + 下ブロック A〜J)
  - データ列 20列 = 4小問グループ × [設問番号セル + 選択肢セル4つ]
  - 選択肢セルには 0〜3 の数字が印字され、回答の数字を○で囲む
  - 数字の並びは設問ごとに昇順/降順が異なる → scoresheet_digit_map.json が正
"""

import cv2
import numpy as np

from src.recognizer import RecognitionError

GRID_ROWS = 20
GRID_DATA_COLS = 20  # 4グループ × (設問番号1 + 選択肢4)
GROUPS_PER_ROW = 4
COLS_PER_GROUP = 5

# ---------------------------------------------------------------------------
# 要調整: スキャン品質に応じて見直す。
# ---------------------------------------------------------------------------
HORIZ_KERNEL_RATIO = 0.02   # 水平罫線抽出カーネル幅 (画像幅比)
VERT_KERNEL_RATIO = 0.015   # 垂直罫線抽出カーネル高 (画像高比)
TABLE_MIN_X_RATIO = 0.30    # 得点表は用紙の右側にある前提
TABLE_MIN_W_RATIO = 0.25
TABLE_MIN_H_RATIO = 0.35


def binarize(gray: np.ndarray) -> np.ndarray:
    """インクが白(255)になる二値画像。照明ムラ対策に適応的しきい値。"""
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 51, 10
    )


def detect_score_grid(gray: np.ndarray) -> dict[tuple[int, int], tuple[int, int, int, int]]:
    """得点表のセル格子を検出する。

    Returns:
        {(row, col): (x, y, w, h)} 絶対ピクセル座標。
        row: 0〜19 (上A〜J, 下A〜J) / col: 0〜19 (グループg: g*5=設問番号, +1..+4=選択肢)
    Raises:
        RecognitionError: 格子が 20×20 で検出できない場合。
    """
    h, w = gray.shape
    binary = binarize(gray)
    horiz = cv2.morphologyEx(
        binary, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (max(8, int(w * HORIZ_KERNEL_RATIO)), 1)),
    )
    vert = cv2.morphologyEx(
        binary, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(8, int(h * VERT_KERNEL_RATIO)))),
    )
    lines = cv2.dilate(cv2.bitwise_or(horiz, vert), np.ones((3, 3), np.uint8))

    table = _find_table_bbox(lines, w, h)
    if table is None:
        raise RecognitionError("score table not found (no large grid on the right side)")
    x0, y0, tw, th = table

    cells_mask = cv2.bitwise_not(lines[y0 : y0 + th, x0 : x0 + tw])
    count, _, stats, _ = cv2.connectedComponentsWithStats(cells_mask, connectivity=4)
    exp_w, exp_h = tw / 22.0, th / GRID_ROWS  # 22 = ラベル列+記入列+データ20列の想定
    boxes = [
        tuple(int(v) for v in stats[i][:4])
        for i in range(1, count)
        if 0.3 * exp_w < stats[i][2] < 2.0 * exp_w
        and 0.3 * exp_h < stats[i][3] < 1.6 * exp_h
        and stats[i][4] > 0.2 * exp_w * exp_h
    ]
    if len(boxes) < GRID_ROWS * GRID_DATA_COLS:
        raise RecognitionError(f"score cells not detected: {len(boxes)} boxes")

    rows = _cluster(sorted(b[1] + b[3] / 2 for b in boxes), exp_h * 0.4)
    cols = _cluster(sorted(b[0] + b[2] / 2 for b in boxes), exp_w * 0.35)
    # ラベル列・記入列が混入した場合は右側のデータ20列だけ使う
    if len(cols) > GRID_DATA_COLS:
        cols = cols[len(cols) - GRID_DATA_COLS :]
    if len(rows) != GRID_ROWS or len(cols) != GRID_DATA_COLS:
        raise RecognitionError(f"unexpected grid shape: rows={len(rows)} cols={len(cols)}")

    grid: dict[tuple[int, int], tuple[int, int, int, int]] = {}
    for bx, by, bw, bh in boxes:
        cx, cy = bx + bw / 2, by + bh / 2
        r = min(range(len(rows)), key=lambda i: abs(rows[i] - cy))
        c_dists = [abs(c - cx) for c in cols]
        c = int(np.argmin(c_dists))
        if c_dists[c] > exp_w * 0.6:
            continue  # データ20列の外（ラベル列など）
        grid[(r, c)] = (x0 + bx, y0 + by, bw, bh)

    missing = [(r, c) for r in range(GRID_ROWS) for c in range(GRID_DATA_COLS) if (r, c) not in grid]
    if missing:
        raise RecognitionError(f"grid cells missing: {missing[:8]} (+{max(0, len(missing) - 8)})")
    return grid


def _find_table_bbox(lines: np.ndarray, w: int, h: int) -> tuple[int, int, int, int] | None:
    contours, _ = cv2.findContours(lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best, best_area = None, 0.0
    for contour in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        if x > w * TABLE_MIN_X_RATIO and cw > w * TABLE_MIN_W_RATIO and ch > h * TABLE_MIN_H_RATIO:
            area = cv2.contourArea(contour)
            if area > best_area:
                best, best_area = (x, y, cw, ch), area
    return best


def _cluster(values: list[float], gap: float) -> list[float]:
    groups: list[list[float]] = [[values[0]]]
    for value in values[1:]:
        if value - groups[-1][-1] <= gap:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [float(np.mean(g)) for g in groups]
