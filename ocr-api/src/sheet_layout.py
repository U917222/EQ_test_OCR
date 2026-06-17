"""CHEQ採点用紙の設問欄レイアウト定義。

座標はすべて補正後キャンバスに対する正規化座標 (0.0〜1.0)。
実物の用紙に合わせて GRID のパラメータを調整する。
"""

from dataclasses import dataclass

CHOICES = ("a", "b", "c", "d")
QUESTION_COUNT = 200

# 傾き・台形補正後のキャンバスサイズ (A4縦 200dpi相当)
CANVAS_WIDTH = 1654
CANVAS_HEIGHT = 2339

# ---------------------------------------------------------------------------
# 要調整: 実物のCHEQ用紙をスキャンして、30枚程度のテストで合わせ込むこと。
#   columns          : 設問ブロックの列数
#   rows_per_column  : 1列あたりの設問数 (columns * rows_per_column == 200)
#   left/right/top/bottom : 設問エリア全体の外枠 (正規化座標)
#   label_width_ratio: 各設問セル内で設問番号ラベルが占める幅の割合
#   mark_inset       : 各選択肢セル内でマーク領域として使う中央部分の割合
# ---------------------------------------------------------------------------
GRID = {
    "columns": 4,
    "rows_per_column": 50,
    "left": 0.06,
    "right": 0.98,
    "top": 0.08,
    "bottom": 0.97,
    "label_width_ratio": 0.25,
    "mark_inset": 0.70,
}


@dataclass(frozen=True)
class ChoiceBox:
    """1つの選択肢マーク欄。x/y/w/h は正規化座標。"""

    question_key: str
    choice: str
    x: float
    y: float
    w: float
    h: float

    def to_pixels(self, width: int = CANVAS_WIDTH, height: int = CANVAS_HEIGHT) -> tuple[int, int, int, int]:
        return (
            int(self.x * width),
            int(self.y * height),
            max(1, int(self.w * width)),
            max(1, int(self.h * height)),
        )


def question_key(question_no: int) -> str:
    return f"q{question_no:03d}"


ALL_QUESTION_KEYS = tuple(question_key(n) for n in range(1, QUESTION_COUNT + 1))


def build_layout(grid: dict | None = None) -> dict[str, list[ChoiceBox]]:
    """設問キー -> 選択肢ボックス一覧 を返す。

    設問は列ごとに上から下へ並ぶ前提 (q001〜q050が1列目、q051〜q100が2列目…)。
    """
    g = {**GRID, **(grid or {})}
    columns = g["columns"]
    rows = g["rows_per_column"]
    if columns * rows != QUESTION_COUNT:
        raise ValueError(f"columns * rows_per_column must be {QUESTION_COUNT}")

    area_w = g["right"] - g["left"]
    area_h = g["bottom"] - g["top"]
    col_w = area_w / columns
    row_h = area_h / rows
    choice_area_w = col_w * (1.0 - g["label_width_ratio"])
    choice_w = choice_area_w / len(CHOICES)
    inset = g["mark_inset"]

    layout: dict[str, list[ChoiceBox]] = {}
    for n in range(1, QUESTION_COUNT + 1):
        col = (n - 1) // rows
        row = (n - 1) % rows
        cell_x = g["left"] + col * col_w + col_w * g["label_width_ratio"]
        cell_y = g["top"] + row * row_h

        boxes = []
        for i, choice in enumerate(CHOICES):
            # 選択肢セルの中央 inset 分だけをマーク判定に使う
            bx = cell_x + i * choice_w + choice_w * (1 - inset) / 2
            by = cell_y + row_h * (1 - inset) / 2
            boxes.append(
                ChoiceBox(
                    question_key=question_key(n),
                    choice=choice,
                    x=bx,
                    y=by,
                    w=choice_w * inset,
                    h=row_h * inset,
                )
            )
        layout[question_key(n)] = boxes
    return layout


def question_bounds(boxes: list[ChoiceBox]) -> tuple[float, float, float, float]:
    """設問1問分(選択肢全体)の外接矩形を返す。レビュー用切り出しに使う。"""
    x0 = min(b.x for b in boxes)
    y0 = min(b.y for b in boxes)
    x1 = max(b.x + b.w for b in boxes)
    y1 = max(b.y + b.h for b in boxes)
    return x0, y0, x1 - x0, y1 - y0
