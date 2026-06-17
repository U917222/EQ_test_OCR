"""OpenCVによる回答マーク検出。

処理の流れ:
  1. 画像/PDFをデコードする
  2. 用紙の輪郭を検出して傾き・台形歪みを補正する
  3. 各設問・各選択肢の塗りつぶし率を計測する
  4. 最も塗られている選択肢を回答とし、信頼度を計算する
"""

import logging
from dataclasses import dataclass, field

import cv2
import numpy as np

from src.sheet_layout import (
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    ChoiceBox,
    build_layout,
    question_bounds,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 要調整: 実画像でのテスト結果に合わせてしきい値を見直すこと。
# ---------------------------------------------------------------------------
MIN_FILL_RATIO = 0.15      # これ未満は「塗られていない」とみなす
TARGET_FILL_RATIO = 0.45   # この塗りつぶし率以上で塗り量スコアを満点とする
AMBIGUOUS_MARGIN = 0.12    # 1位と2位の差がこれ未満なら複数選択疑い
REVIEW_CONFIDENCE = 0.80   # これ未満の設問はレビュー画像を切り出す
PAGE_SCORE_WARPED = 1.0    # 用紙輪郭の検出に成功した場合
PAGE_SCORE_FALLBACK = 0.7  # 輪郭検出に失敗し、リサイズのみで処理した場合

PDF_RENDER_SCALE = 2.0     # PDF 1ページ目のレンダリング倍率 (約144dpi)


class RecognitionError(Exception):
    """画像が読み取り不能な場合に送出する。"""


@dataclass
class RecognitionResult:
    answers: dict[str, str] = field(default_factory=dict)
    confidence_by_question: dict[str, float] = field(default_factory=dict)
    review_images: dict[str, bytes] = field(default_factory=dict)  # 設問キー -> PNGバイト列

    def to_recognition_payload(self, image_links: dict[str, str] | None = None) -> dict:
        """GAS Webhookの recognition オブジェクト形式に変換する。"""
        return {
            "answers": self.answers,
            "confidenceByQuestion": self.confidence_by_question,
            "imageLinks": image_links or {},
        }


def recognize_sheet(content: bytes, mime_type: str = "") -> RecognitionResult:
    """画像バイト列から200問の回答を読み取る。"""
    image = _load_image(content, mime_type)
    warped, page_score = _correct_page(image)
    binary = _binarize(warped)

    layout = build_layout()
    result = RecognitionResult()
    for qkey, boxes in layout.items():
        ratios = {box.choice: _fill_ratio(binary, box) for box in boxes}
        answer, confidence = _decide(ratios, page_score)
        result.answers[qkey] = answer
        result.confidence_by_question[qkey] = confidence
        if confidence < REVIEW_CONFIDENCE:
            result.review_images[qkey] = _crop_question(warped, boxes)

    filled = sum(1 for v in result.answers.values() if v)
    logger.info(
        "recognized: %d/%d answered, %d for review, page_score=%.2f",
        filled, len(layout), len(result.review_images), page_score,
    )
    return result


def empty_result() -> RecognitionResult:
    """処理失敗時の全件レビュー送りフォールバック。"""
    layout = build_layout()
    return RecognitionResult(
        answers={qkey: "" for qkey in layout},
        confidence_by_question={qkey: 0.0 for qkey in layout},
    )


def _load_image(content: bytes, mime_type: str) -> np.ndarray:
    if mime_type == "application/pdf" or content[:5] == b"%PDF-":
        return _render_pdf_first_page(content)
    image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RecognitionError(f"failed to decode image (mimeType={mime_type or 'unknown'})")
    return image


def _render_pdf_first_page(content: bytes) -> np.ndarray:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(content)
    try:
        if len(pdf) == 0:
            raise RecognitionError("PDF has no pages")
        # pdfium のデフォルト出力は BGR なので OpenCV へそのまま渡せる
        array = pdf[0].render(scale=PDF_RENDER_SCALE).to_numpy()
        if array.ndim == 3 and array.shape[2] == 4:
            array = array[:, :, :3]
        return np.ascontiguousarray(array)
    finally:
        pdf.close()


def _correct_page(
    image: np.ndarray, canvas_size: tuple[int, int] = (CANVAS_WIDTH, CANVAS_HEIGHT)
) -> tuple[np.ndarray, float]:
    """用紙の四隅を検出して正面化する。失敗時はリサイズのみ。

    canvas_size: 補正後キャンバス (width, height)。設問用紙は縦、採点表は横。
    """
    canvas_w, canvas_h = canvas_size
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # 輪郭検出は縮小画像で行い、座標を元解像度へ戻す
    scale = 800.0 / max(gray.shape)
    small = cv2.resize(gray, None, fx=scale, fy=scale) if scale < 1.0 else gray
    blurred = cv2.GaussianBlur(small, (5, 5), 0)
    edged = cv2.Canny(blurred, 50, 150)
    edged = cv2.dilate(edged, np.ones((3, 3), np.uint8), iterations=2)

    contours, _ = cv2.findContours(edged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    quad = _find_page_quad(contours, small.shape)

    if quad is None:
        logger.warning("page contour not found; falling back to plain resize")
        warped = cv2.resize(gray, (canvas_w, canvas_h))
        return warped, PAGE_SCORE_FALLBACK

    src = _order_corners(quad / (scale if scale < 1.0 else 1.0))
    dst = np.array(
        [[0, 0], [canvas_w - 1, 0], [canvas_w - 1, canvas_h - 1], [0, canvas_h - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(gray, matrix, (canvas_w, canvas_h))
    return warped, PAGE_SCORE_WARPED


def _find_page_quad(contours, shape) -> np.ndarray | None:
    min_area = shape[0] * shape[1] * 0.5
    best = None
    best_area = 0.0
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area or area <= best_area:
            continue
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) == 4:
            best = approx.reshape(4, 2).astype(np.float32)
            best_area = area
    return best


def _order_corners(points: np.ndarray) -> np.ndarray:
    """4点を 左上, 右上, 右下, 左下 の順に並べる。"""
    points = points.astype(np.float32)
    sums = points.sum(axis=1)
    diffs = np.diff(points, axis=1).reshape(-1)
    return np.array(
        [
            points[np.argmin(sums)],
            points[np.argmin(diffs)],
            points[np.argmax(sums)],
            points[np.argmax(diffs)],
        ],
        dtype=np.float32,
    )


def _binarize(warped: np.ndarray) -> np.ndarray:
    """マーク部分が白(255)になる二値画像を返す。照明ムラ対策に適応的しきい値を使う。"""
    return cv2.adaptiveThreshold(
        warped, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 51, 10
    )


def _fill_ratio(binary: np.ndarray, box: ChoiceBox) -> float:
    x, y, w, h = box.to_pixels(binary.shape[1], binary.shape[0])
    roi = binary[y : y + h, x : x + w]
    if roi.size == 0:
        return 0.0
    return float(np.count_nonzero(roi)) / roi.size


def _decide(ratios: dict[str, float], page_score: float) -> tuple[str, float]:
    ordered = sorted(ratios.items(), key=lambda kv: kv[1], reverse=True)
    top_choice, top = ordered[0]
    second = ordered[1][1]

    if top < MIN_FILL_RATIO:
        return "", round(0.2 * page_score, 3)  # 空欄: 低信頼でReviewQueueへ

    fill_score = min(top / TARGET_FILL_RATIO, 1.0)
    margin_score = min((top - second) / AMBIGUOUS_MARGIN, 1.0)
    confidence = fill_score * (0.5 + 0.5 * margin_score) * page_score
    return top_choice, round(min(confidence, 0.99), 3)


def _crop_question(warped: np.ndarray, boxes: list[ChoiceBox]) -> bytes:
    height, width = warped.shape[:2]
    x, y, w, h = question_bounds(boxes)
    pad = 8
    x0 = max(0, int(x * width) - pad)
    y0 = max(0, int(y * height) - pad)
    x1 = min(width, int((x + w) * width) + pad)
    y1 = min(height, int((y + h) * height) + pad)
    ok, encoded = cv2.imencode(".png", warped[y0:y1, x0:x1])
    return encoded.tobytes() if ok else b""
