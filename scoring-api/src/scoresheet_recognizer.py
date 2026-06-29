"""CHEQ採点表(page.5)の○検出。

塗りつぶしマークではなく「印字された 0〜3 を囲む手書きの○」を検出する。
全スロットに印字インクがあるため塗り率では判別できない。代わりに、
各選択肢セルの周縁部(環状領域)のインク率を測り、4セルの中央値を印字ノイズの
ベースラインとして差し引く。○が掛かったセルだけ差分が大きくなる。

検出した「○のスロット位置」は、設問ごとに数字の並び(昇順/降順)が異なるため、
scoresheet_digit_map.json で印字数字(=得点 0〜3)へ変換する。

処理の流れ:
  1. 画像/PDFをデコードする (PDFは採点表ページを選択)
  2. 得点表の罫線格子を検出する (scoresheet_grid.py / 固定座標なし)
  3. 各小問の4スロットの環状インク率を計測し、中央値差分で○スロットを判定
  4. 数字マスタでスロット→得点(0〜3)へ変換し、信頼度を計算する
"""

import logging
import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from src.recognizer import RecognitionError
from src.scoresheet_grid import binarize, detect_score_grid
from src.scoresheet_layout import (
    ALL_CELL_KEYS,
    cell_for_grid,
    grid_for_cell,
    load_digit_map,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 要調整: 実スキャンでのテスト結果に合わせてしきい値を見直すこと。
#   ring_delta = 環状インク率 - 4スロット中央値 (印字数字ぶんのベースラインを除去)
# ---------------------------------------------------------------------------
MIN_RING_DELTA = 0.05      # これ未満は「○なし」とみなす
TARGET_RING_DELTA = 0.13   # この差分以上で○濃度スコアを満点とする
MULTI_RING_DELTA = 0.05    # 2位の差分がこれ以上なら複数○とみなす
AMBIGUOUS_MARGIN = 0.07    # 1位と2位の差の正規化幅
REVIEW_CONFIDENCE = 0.80   # これ未満のセルはレビュー画像を切り出す
REVIEW_CROP_MAX_WIDTH = 240  # レビュー切り抜きの横幅上限 (data-URI肥大化を抑える)
ANNULUS_INNER = 0.50       # 環状領域の内縁 (スロット半径比。印字数字の中心部を除外)
ANNULUS_OUTER = 1.10       # 環状領域の外縁 (セル境界を少し越えて○の線を拾う)

BLANK_CONFIDENCE = 0.2
MULTI_CONFIDENCE = 0.3

SCORESHEET_PAGE_INDEX = 4  # 採点表は5ページ目 (0始まり)。短いPDFは最終ページ
PDF_RENDER_SCALE = 3.0     # 約216dpi。セル幅50px程度を確保する
MAX_PDF_PAGES = 20
MAX_PDF_RENDER_DIMENSION = 10_000
MAX_PDF_RENDER_PIXELS = 40_000_000


def select_scoresheet_page(page_count: int) -> int:
    """読み取るPDFページ(0始まり)を返す。短いPDFは最終ページへフォールバック。"""
    if page_count <= 0:
        raise ValueError("PDF has no pages")
    return min(SCORESHEET_PAGE_INDEX, page_count - 1)


@dataclass
class ScoresheetResult:
    values: dict[str, int | None] = field(default_factory=dict)
    confidence_by_cell: dict[str, float] = field(default_factory=dict)
    reasons: dict[str, str] = field(default_factory=dict)  # value=None のセルのみ
    review_images: dict[str, bytes] = field(default_factory=dict)  # セルキー -> PNG
    page_index: int | None = None
    failure_code: str | None = None
    failure_message: str | None = None

    def to_cells_payload(self) -> dict:
        """GAS Webhook の cells 契約 (docs/cell-contract.md) に変換する。"""
        cells = {}
        for key, value in self.values.items():
            cell: dict = {"value": value, "confidence": self.confidence_by_cell[key]}
            if value is None:
                cell["reason"] = self.reasons.get(key, "low_confidence")
            cells[key] = cell
        unresolved = sum(1 for v in self.values.values() if v is None)
        avg = (
            round(sum(self.confidence_by_cell.values()) / len(self.confidence_by_cell), 3)
            if self.confidence_by_cell
            else 0.0
        )
        return {"cells": cells, "confidenceAvg": avg, "unresolvedCount": unresolved}

    def to_recognition_payload(self, image_links: dict[str, str] | None = None) -> dict:
        """GAS Webhook の recognition オブジェクト形式 (docs/cell-contract.md) に変換する。"""
        payload = self.to_cells_payload()
        payload["sheet"] = "cheq-scoresheet-p5"
        payload["pageIndex"] = self.page_index
        payload["imageLinks"] = image_links or {}
        if self.failure_code:
            payload["status"] = "failed"
            payload["error"] = {"code": self.failure_code, "message": self.failure_message or ""}
        return payload


def recognize_scoresheet(
    content: bytes, mime_type: str = "", page_index: int | None = None
) -> ScoresheetResult:
    """画像バイト列から採点表80セルの○(0〜3)を読み取る。"""
    if page_index is not None and page_index < 0:
        raise RecognitionError("PDF page index must be non-negative")
    gray, used_page = _load_scoresheet_image(content, mime_type, page_index)
    grid = detect_score_grid(gray)
    binary = binarize(gray)
    digit_map = load_digit_map()

    result = ScoresheetResult(page_index=used_page)
    for key in ALL_CELL_KEYS:
        row, group = grid_for_cell(key)
        option_boxes = [grid[(row, group * 5 + 1 + slot)] for slot in range(4)]
        ratios = [_ring_ratio(binary, box) for box in option_boxes]
        slot, confidence, reason = _decide(ratios)
        digits = digit_map.get(key)
        value = digits[slot] if slot is not None and digits else None
        if slot is not None and not digits:
            reason, confidence = "low_confidence", BLANK_CONFIDENCE
        result.values[key] = value
        result.confidence_by_cell[key] = confidence
        if reason:
            result.reasons[key] = reason
        if confidence < REVIEW_CONFIDENCE:
            qnum_box = grid[(row, group * 5)]
            result.review_images[key] = _crop_question(gray, qnum_box, option_boxes)

    decided = sum(1 for v in result.values.values() if v is not None)
    logger.info(
        "scoresheet recognized: %d/%d decided, %d for review, page=%s",
        decided, len(ALL_CELL_KEYS), len(result.review_images), used_page,
    )
    return result


def empty_scoresheet_result() -> ScoresheetResult:
    """処理失敗時の全件レビュー送りフォールバック。"""
    return ScoresheetResult(
        values={key: None for key in ALL_CELL_KEYS},
        confidence_by_cell={key: 0.0 for key in ALL_CELL_KEYS},
        reasons={key: "low_confidence" for key in ALL_CELL_KEYS},
    )


def failed_scoresheet_result(code: str, message: str) -> ScoresheetResult:
    """処理失敗時にGASへ返す構造化された全件レビュー送り結果。"""
    result = empty_scoresheet_result()
    result.failure_code = code
    result.failure_message = message
    result.reasons = {key: code for key in ALL_CELL_KEYS}
    return result


def _load_scoresheet_image(
    content: bytes, mime_type: str, page_index: int | None
) -> tuple[np.ndarray, int | None]:
    if mime_type == "application/pdf" or content[:5] == b"%PDF-":
        return _render_pdf_page(content, page_index)
    image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise RecognitionError(f"failed to decode image (mimeType={mime_type or 'unknown'})")
    return image, None


def _render_pdf_page(content: bytes, page_index: int | None) -> tuple[np.ndarray, int]:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(content)
    try:
        page_count = len(pdf)
        if page_count > MAX_PDF_PAGES:
            raise RecognitionError(f"PDF has too many pages ({page_count} > {MAX_PDF_PAGES})")
        index = page_index if page_index is not None else select_scoresheet_page(page_count)
        if not (0 <= index < page_count):
            raise RecognitionError(f"PDF page {index} out of range (pages={page_count})")
        page = pdf[index]
        _validate_pdf_render_size(page)
        array = page.render(scale=PDF_RENDER_SCALE).to_numpy()
        if array.ndim == 3 and array.shape[2] >= 3:
            array = cv2.cvtColor(array[:, :, :3], cv2.COLOR_BGR2GRAY)
        return np.ascontiguousarray(array), index
    finally:
        pdf.close()


def _validate_pdf_render_size(page) -> None:
    width, height = page.get_size()
    render_width = int(math.ceil(width * PDF_RENDER_SCALE))
    render_height = int(math.ceil(height * PDF_RENDER_SCALE))
    pixels = render_width * render_height
    if width <= 0 or height <= 0:
        raise RecognitionError(f"PDF page has invalid dimensions: {width}x{height}")
    if render_width > MAX_PDF_RENDER_DIMENSION or render_height > MAX_PDF_RENDER_DIMENSION:
        raise RecognitionError(
            "PDF page render dimensions exceed limit: "
            f"{render_width}x{render_height} > {MAX_PDF_RENDER_DIMENSION}"
        )
    if pixels > MAX_PDF_RENDER_PIXELS:
        raise RecognitionError(
            f"PDF page render is too large: {pixels} pixels > {MAX_PDF_RENDER_PIXELS}"
        )


def _ring_ratio(binary: np.ndarray, box: tuple[int, int, int, int]) -> float:
    """スロット周縁の環状領域に占めるインク率。○が掛かると上がる。"""
    x, y, w, h = box
    # ○はセル境界を越えてはみ出すことがあるため、少し外側まで見る
    pad_x, pad_y = int(w * (ANNULUS_OUTER - 1.0)), int(h * (ANNULUS_OUTER - 1.0))
    x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
    x1 = min(binary.shape[1], x + w + pad_x)
    y1 = min(binary.shape[0], y + h + pad_y)
    roi = binary[y0:y1, x0:x1]
    if roi.size == 0:
        return 0.0
    rh, rw = roi.shape
    ys, xs = np.ogrid[:rh, :rw]
    cx, cy = (x + w / 2) - x0, (y + h / 2) - y0
    rx, ry = max(w / 2.0, 1.0), max(h / 2.0, 1.0)
    r2 = ((xs - cx) / rx) ** 2 + ((ys - cy) / ry) ** 2
    mask = (r2 >= ANNULUS_INNER**2) & (r2 <= ANNULUS_OUTER**2)
    area = int(np.count_nonzero(mask))
    if area == 0:
        return 0.0
    return float(np.count_nonzero(roi[mask])) / area


def _decide(ratios: list[float]) -> tuple[int | None, float, str | None]:
    """4スロットの環状インク率から○のスロットを決める。

    印字数字・罫線のインクは4スロットに共通して乗るため、中央値を
    ベースラインとして差し引いた差分で判定する。
    """
    baseline = float(np.median(ratios))
    deltas = [r - baseline for r in ratios]
    order = sorted(range(4), key=lambda i: deltas[i], reverse=True)
    top_slot, top = order[0], deltas[order[0]]
    second = deltas[order[1]]

    if top < MIN_RING_DELTA:
        return None, BLANK_CONFIDENCE, "blank"
    if second >= MULTI_RING_DELTA:
        return None, MULTI_CONFIDENCE, "multiple"

    ring_score = min(top / TARGET_RING_DELTA, 1.0)
    margin_score = min((top - second) / AMBIGUOUS_MARGIN, 1.0)
    confidence = ring_score * (0.5 + 0.5 * margin_score)
    return top_slot, round(min(confidence, 0.99), 3), None


def _crop_question(gray: np.ndarray, qnum_box, option_boxes) -> bytes:
    boxes = [qnum_box, *option_boxes]
    x0 = max(0, min(b[0] for b in boxes) - 8)
    y0 = max(0, min(b[1] for b in boxes) - 8)
    x1 = min(gray.shape[1], max(b[0] + b[2] for b in boxes) + 8)
    y1 = min(gray.shape[0], max(b[1] + b[3] for b in boxes) + 8)
    crop = gray[y0:y1, x0:x1]
    if crop.shape[1] > REVIEW_CROP_MAX_WIDTH:
        scale = REVIEW_CROP_MAX_WIDTH / crop.shape[1]
        new_size = (REVIEW_CROP_MAX_WIDTH, max(1, int(round(crop.shape[0] * scale))))
        crop = cv2.resize(crop, new_size, interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".png", crop)
    return encoded.tobytes() if ok else b""
