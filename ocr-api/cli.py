"""ローカル動作確認用CLI（Google Cloud認証なしで認識処理だけ試せる）。

使い方:
  # CHEQ採点表(page.5)を読む（スキャンPDF/PNG/JPG。HEICは事前にJPEGへ変換:
  #   sips -s format jpeg input.HEIC --out input.jpg ）
  uv run python cli.py scoresheet scan.pdf
  uv run python cli.py scoresheet scan.pdf --dump-review ./review_out

  # (旧200問モデル) 合成サンプル生成と認識
  uv run python cli.py sample sample_sheet.png
  uv run python cli.py recognize sample_sheet.png
"""

import argparse
import sys
from pathlib import Path

from src.recognizer import REVIEW_CONFIDENCE, RecognitionError, recognize_sheet
from src.sample import make_synthetic_sheet
from src.sheet_layout import QUESTION_COUNT, question_key

MIME_BY_SUFFIX = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}


def cmd_sample(args: argparse.Namespace) -> int:
    # 設問番号に応じて a/b/c/d を循環させたサンプル（読み取りの当たり外れを見やすくする）
    choices = ("a", "b", "c", "d")
    marks = {question_key(n): choices[n % 4] for n in range(1, QUESTION_COUNT + 1)}
    blank = {question_key(7), question_key(99)}  # 無回答のサンプルも混ぜる
    Path(args.output).write_bytes(make_synthetic_sheet(marks, blank=blank))
    print(f"サンプル画像を書き出しました: {args.output}")
    print(f"  - 全{QUESTION_COUNT}問に a/b/c/d を循環で配置")
    print(f"  - 無回答サンプル: {sorted(blank)}")
    return 0


def cmd_recognize(args: argparse.Namespace) -> int:
    path = Path(args.image)
    if not path.exists():
        print(f"ファイルが見つかりません: {path}", file=sys.stderr)
        return 1

    mime = MIME_BY_SUFFIX.get(path.suffix.lower(), "")
    try:
        result = recognize_sheet(path.read_bytes(), mime)
    except RecognitionError as error:
        print(f"読み取り不能: {error}", file=sys.stderr)
        return 1

    answered = sum(1 for v in result.answers.values() if v)
    low_conf = [k for k, c in result.confidence_by_question.items() if c < REVIEW_CONFIDENCE]
    confidences = list(result.confidence_by_question.values())

    print("=== 認識結果 ===")
    print(f"回答あり        : {answered}/{QUESTION_COUNT}")
    print(f"要確認(低信頼)  : {len(low_conf)}問")
    print(f"信頼度 平均/最小: {sum(confidences) / len(confidences):.3f} / {min(confidences):.3f}")

    print("\n--- 先頭10問 ---")
    for n in range(1, 11):
        qkey = question_key(n)
        ans = result.answers[qkey] or "(空欄)"
        print(f"  {qkey}: {ans:<6} conf={result.confidence_by_question[qkey]:.3f}")

    if low_conf:
        print(f"\n--- 要確認の設問 (先頭20件) ---\n  {', '.join(sorted(low_conf)[:20])}")

    if args.dump_review and result.review_images:
        out_dir = Path(args.dump_review)
        out_dir.mkdir(parents=True, exist_ok=True)
        for qkey, png in result.review_images.items():
            if png:
                (out_dir / f"{qkey}.png").write_bytes(png)
        print(f"\n要確認設問の切り出し画像を保存: {out_dir} ({len(result.review_images)}件)")

    return 0


def cmd_scoresheet(args: argparse.Namespace) -> int:
    from src.scoresheet_layout import ALL_CELL_KEYS, LETTERS, grid_for_cell
    from src.scoresheet_recognizer import (
        REVIEW_CONFIDENCE as SS_REVIEW_CONFIDENCE,
        recognize_scoresheet,
    )

    path = Path(args.image)
    if not path.exists():
        print(f"ファイルが見つかりません: {path}", file=sys.stderr)
        return 1
    if path.suffix.lower() in (".heic", ".heif"):
        print("HEICは未対応です。先にJPEGへ変換してください:", file=sys.stderr)
        print(f"  sips -s format jpeg '{path}' --out '{path.with_suffix('.jpg')}'", file=sys.stderr)
        return 1

    mime = MIME_BY_SUFFIX.get(path.suffix.lower(), "")
    try:
        result = recognize_scoresheet(path.read_bytes(), mime, args.page)
    except RecognitionError as error:
        print(f"読み取り不能: {error}", file=sys.stderr)
        return 1

    rows: dict[str, int] = {}
    unresolved = []
    for key in ALL_CELL_KEYS:
        row, _ = grid_for_cell(key)
        row_name = f"{LETTERS[row % 10]}{row // 10 + 1}"
        value = result.values[key]
        if value is None:
            unresolved.append((key, row_name, result.reasons.get(key, "")))
        else:
            rows[row_name] = rows.get(row_name, 0) + value

    confidences = list(result.confidence_by_cell.values())
    print("=== 採点表 認識結果 ===")
    if result.page_index is not None:
        print(f"PDFページ        : {result.page_index + 1}ページ目")
    print(f"確定セル        : {80 - len(unresolved)}/80")
    print(f"信頼度 平均/最小: {sum(confidences) / len(confidences):.3f} / {min(confidences):.3f}")
    print("\n--- 行得点 (上ブロック/下ブロック) ---")
    for block in (1, 2):
        line = "  " + "  ".join(
            f"{letter}{block}={rows.get(f'{letter}{block}', '?'):>2}" for letter in LETTERS
        )
        print(line)
    if unresolved:
        print("\n--- 要確認セル ---")
        for key, row_name, reason in unresolved:
            print(f"  {key} ({row_name}): {reason}")
    low = [k for k in ALL_CELL_KEYS
           if result.values[k] is not None and result.confidence_by_cell[k] < SS_REVIEW_CONFIDENCE]
    if low:
        print(f"\n低信頼(確定済): {', '.join(low)}")

    if args.dump_review and result.review_images:
        out_dir = Path(args.dump_review)
        out_dir.mkdir(parents=True, exist_ok=True)
        for key, png in result.review_images.items():
            if png:
                (out_dir / f"{key}.png").write_bytes(png)
        print(f"\n要確認セルの切り出し画像を保存: {out_dir} ({len(result.review_images)}件)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="CHEQ OCR ローカル確認用CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_scoresheet = sub.add_parser("scoresheet", help="CHEQ採点表(page.5)の○を読み取る")
    p_scoresheet.add_argument("image", help="入力 (png/jpg/pdf)")
    p_scoresheet.add_argument("--page", type=int, help="PDFページ番号 (0始まり)。省略時は自動選択")
    p_scoresheet.add_argument("--dump-review", help="要確認セルの切り出し画像を保存するディレクトリ")
    p_scoresheet.set_defaults(func=cmd_scoresheet)

    p_sample = sub.add_parser("sample", help="(旧モデル) 合成サンプル画像を生成する")
    p_sample.add_argument("output", help="出力PNGパス")
    p_sample.set_defaults(func=cmd_sample)

    p_recognize = sub.add_parser("recognize", help="(旧モデル) 画像を認識して結果を表示する")
    p_recognize.add_argument("image", help="入力画像 (png/jpg/pdf)")
    p_recognize.add_argument("--dump-review", help="要確認設問の切り出し画像を保存するディレクトリ")
    p_recognize.set_defaults(func=cmd_recognize)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
