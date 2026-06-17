"""テスト・動作確認用の合成マークシート画像を生成する。

実物の用紙がなくても認識処理を試せるようにするためのヘルパー。
"""

import cv2
import numpy as np

from src.sheet_layout import CANVAS_HEIGHT, CANVAS_WIDTH, build_layout


def make_synthetic_sheet(marks: dict[str, str], blank: set[str] = frozenset()) -> bytes:
    """指定した回答を塗りつぶした用紙画像(PNGバイト列)を生成する。

    グレー背景の上に少し小さい白い用紙を置くことで、輪郭検出と台形補正も通る。

    Args:
        marks: 設問キー(q001など) -> 塗る選択肢(a/b/c/d)。未指定の設問は "a" を塗る。
        blank: 無回答にする設問キーの集合。
    """
    margin = 60
    background = np.full((CANVAS_HEIGHT + margin * 2, CANVAS_WIDTH + margin * 2), 90, dtype=np.uint8)
    page = np.full((CANVAS_HEIGHT, CANVAS_WIDTH), 250, dtype=np.uint8)

    for qkey, boxes in build_layout().items():
        if qkey in blank:
            # 枠線だけ描いて塗らない
            for box in boxes:
                x, y, w, h = box.to_pixels()
                cv2.rectangle(page, (x, y), (x + w, y + h), 180, 1)
            continue
        target = marks.get(qkey, "a")
        for box in boxes:
            x, y, w, h = box.to_pixels()
            cv2.rectangle(page, (x, y), (x + w, y + h), 180, 1)
            if box.choice == target:
                cv2.rectangle(page, (x + 2, y + 2), (x + w - 2, y + h - 2), 20, -1)

    background[margin : margin + CANVAS_HEIGHT, margin : margin + CANVAS_WIDTH] = page
    ok, encoded = cv2.imencode(".png", background)
    if not ok:
        raise RuntimeError("failed to encode synthetic sheet")
    return encoded.tobytes()
