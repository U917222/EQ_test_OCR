from __future__ import annotations

import base64
from datetime import datetime
from html import escape
import math
import re
from typing import Any


def build_pdf_response(
    candidate: dict[str, Any],
    result: dict[str, Any],
    raw_cell_summary: dict[str, Any] | None,
    fallback_name: str = "",
) -> dict[str, Any]:
    """Render and package a result PDF for the render endpoint."""
    pdf_bytes = build_result_pdf(candidate or {}, result or {}, raw_cell_summary)
    name = (candidate.get("name") if isinstance(candidate, dict) else "") or fallback_name or "result"
    return {
        "filename": f"CHEQ_{name}.pdf",
        "mimeType": "application/pdf",
        "base64": base64.b64encode(pdf_bytes).decode("ascii"),
    }


def build_result_pdf(candidate: dict, result: dict, raw_cell_summary: dict | None) -> bytes:
    from weasyprint import HTML

    html = build_result_pdf_html(candidate or {}, result or {}, raw_cell_summary or {})
    return HTML(string=html).write_pdf()


def build_result_pdf_html(candidate: dict, result: dict, raw_cell_summary: dict) -> str:
    stages = result.get("item_stages") or {}
    totals = result.get("item_totals") or {}
    labels = sort_dashboard_labels_for_pdf([label for label in stages.keys() if label != "応答態度"])
    attitude_minus = numeric_or_none_for_pdf(result.get("attitude_minus_points"))
    profile_minus = numeric_or_none_for_pdf(result.get("minus_points")) if attitude_minus is None else attitude_minus
    if profile_minus is None:
        profile_minus = 0
    job_req_low_items = result.get("job_requirement_low_items")
    if not isinstance(job_req_low_items, list):
        job_req_low_items = []
    cross_check = result.get("cross_check")
    if not isinstance(cross_check, list):
        cross_check = []

    cautions = [label for label in labels if 1 <= _number(stages.get(label), math.nan) <= 2]
    job_req_minus = numeric_or_none_for_pdf(result.get("job_requirement_minus_points"))
    minus_label = "-" if job_req_minus is None else ("なし" if job_req_minus == 0 else str(_format_number(job_req_minus)))
    attitude_stage = "-" if is_blank_for_pdf(result.get("response_attitude_stage")) else str(result.get("response_attitude_stage"))
    unresolved = "0" if is_blank_for_pdf(raw_cell_summary.get("unresolved_count")) else str(raw_cell_summary.get("unresolved_count"))
    generated_at = datetime.now().astimezone().strftime("%Y/%m/%d %H:%M")

    caution_html = (
        " ".join(f'<span class="badge alert">{escape(str(label))}</span>' for label in cautions)
        if cautions
        else '<span class="badge ok">なし</span>'
    )
    if job_req_low_items:
        job_minus_display = job_req_minus if job_req_minus is not None else -len(job_req_low_items)
        details = " / ".join(
            f"{escape(str(item.get('label', '')))} 段階{escape(str(item.get('stage', '')))}"
            for item in job_req_low_items
        )
        job_req_html = f"{escape(str(_format_number(job_minus_display)))}（{details}）"
    else:
        job_req_html = "なし"
    cross_check_html = (
        "、".join(
            f"{escape(str(item.get('item', '')))} 手書き{escape(str(item.get('handwritten', '')))} / "
            f"再計算{escape(str(item.get('computed', '')))}"
            for item in cross_check
        )
        if cross_check
        else "なし"
    )
    legend_html = (
        '<div class="legend"><span class="legend-item"><span class="swatch"></span>現状</span>'
        '<span class="legend-item"><span class="swatch swatch-dash"></span>'
        f"応答態度マイナス適用後 ({escape(str(_format_number(profile_minus)))})</span></div>"
        if profile_minus < 0
        else ""
    )

    return f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      @page {{ size: A4; margin: 9mm; }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        color: #1a1a1a;
        font-family: "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif;
        font-size: 10px;
      }}
      h1, h2, h3, p {{ margin: 0; }}
      .header {{
        width: 100%;
        border-collapse: collapse;
        border-bottom: 2px solid #1a1a1a;
      }}
      .header td {{ border: 0; padding: 0 0 3mm; vertical-align: top; }}
      h1 {{ font-size: 22px; line-height: 1.2; }}
      .name {{ margin-top: 4mm; font-size: 18px; font-weight: 700; }}
      .meta {{
        width: 76mm;
        border-collapse: collapse;
        color: #4d4d4d;
        line-height: 1.45;
      }}
      .meta td {{ border: 0; padding: 0 0 0 4mm; font-size: 10px; white-space: nowrap; }}
      .metrics {{
        width: 100%;
        border-collapse: separate;
        border-spacing: 3mm 0;
        margin-top: 4mm;
      }}
      .metrics td {{
        border: 1px solid #cccccc;
        border-radius: 5px;
        padding: 2.5mm;
        width: 25%;
      }}
      .metrics span {{ display: block; color: #4d4d4d; font-size: 9px; }}
      .metrics strong {{ display: block; margin-top: 1mm; font-size: 20px; line-height: 1.1; }}
      section {{ margin-top: 4mm; }}
      h2 {{ margin-bottom: 2mm; font-size: 14px; }}
      .legend {{ margin-bottom: 1mm; color: #4d4d4d; font-size: 10px; }}
      .legend-item {{ display: inline-block; margin-right: 5mm; }}
      .swatch {{
        display: inline-block;
        width: 8mm;
        height: 1mm;
        margin-right: 2mm;
        border-radius: 1mm;
        background: #0017c1;
        vertical-align: middle;
      }}
      .swatch-dash {{ background-image: repeating-linear-gradient(90deg, #e53935 0 5px, transparent 5px 9px); }}
      svg {{ width: 100%; height: 70mm; }}
      table {{ width: 100%; border-collapse: collapse; }}
      th, td {{ border-bottom: 1px solid #eeeeee; padding: 1.3mm 1.8mm; text-align: left; font-size: 9px; }}
      th {{ color: #4d4d4d; font-weight: 700; }}
      .badge {{
        display: inline-block;
        margin: 0 1mm 1mm 0;
        border-radius: 10px;
        padding: 0.6mm 1.6mm;
        font-size: 8px;
        font-weight: 700;
      }}
      .ok {{ background: #dff4e8; color: #115a36; }}
      .warn {{ background: #ffdfca; color: #ac3e00; }}
      .alert {{ background: #ffdada; color: #8b0000; }}
      .attention {{
        border: 1px solid #cccccc;
        border-radius: 5px;
        padding: 2.5mm;
        line-height: 1.6;
      }}
      .attention p + p {{ margin-top: 1mm; }}
      .footer {{ margin-top: 2mm; color: #4d4d4d; font-size: 8px; text-align: right; }}
    </style>
  </head>
  <body>
    <table class="header">
      <tr>
        <td>
          <h1>CHEQ 採点結果</h1>
          <p class="name">{escape(str(candidate.get("name") or "-"))}</p>
        </td>
        <td>
          <table class="meta">
            <tr>
              <td>候補者ID: {escape(str(candidate.get("candidate_id") or "-"))}</td>
              <td>検査日: {escape(str(candidate.get("test_date") or "-"))}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <table class="metrics">
      <tr>
        <td><span>総合判定</span><strong>{escape(str(result.get("total_rank") or "-"))}</strong></td>
        <td><span>マイナスポイント</span><strong>{escape(minus_label)}</strong></td>
        <td><span>応答態度</span><strong>{escape(attitude_stage)}</strong></td>
        <td><span>要確認</span><strong>{escape(unresolved)}</strong></td>
      </tr>
    </table>
    <section>
      <h2>カテゴリ別プロフィール</h2>
      {legend_html}
      {render_pdf_profile_chart(labels, stages, profile_minus)}
    </section>
    <section>
      <h2>カテゴリ別結果</h2>
      {render_pdf_result_table(labels, stages, totals)}
    </section>
    <section>
      <h2>注意領域・確認事項</h2>
      <div class="attention">
        <p><strong>注意領域:</strong> {caution_html}</p>
        <p><strong>職務必要要件マイナス:</strong> {job_req_html}</p>
        <p><strong>手書き不一致:</strong> {cross_check_html}</p>
      </div>
    </section>
    <p class="footer">出力日時: {escape(generated_at)} / システム再計算を正とする</p>
  </body>
</html>"""


def render_pdf_profile_chart(labels: list[str], stages: dict, minus: float) -> str:
    width = 680
    left = 30
    right = 660
    top = 16
    bottom = 190
    adjust = minus < 0

    def x_at(index: int) -> float:
        return (left + right) / 2 if len(labels) == 1 else left + ((right - left) * index) / (len(labels) - 1)

    def y_at(stage: float) -> float:
        return bottom - ((bottom - top) * stage) / 5

    def value_at(label: str, apply_minus: bool) -> float | None:
        stage = _number(stages.get(label), math.nan)
        if not (stage >= 1 and stage <= 5):
            return None
        return max(0, stage + minus) if apply_minus else stage

    def build_line(apply_minus: bool, stroke: str, dash: str) -> str:
        segment: list[str] = []
        segments: list[list[str]] = []
        for index, label in enumerate(labels):
            value = value_at(label, apply_minus)
            if value is not None:
                segment.append(f"{_fmt(x_at(index))},{_fmt(y_at(value))}")
            elif segment:
                segments.append(segment)
                segment = []
        if segment:
            segments.append(segment)
        lines = []
        for points in segments:
            if len(points) <= 1:
                continue
            dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
            lines.append(
                f'<polyline points="{" ".join(points)}" fill="none" stroke="{stroke}" '
                f'stroke-width="2"{dash_attr}/>'
            )
        return "".join(lines)

    svg = [f'<svg viewBox="0 0 {width} 232" role="img" aria-label="カテゴリ別段階の折れ線グラフ">']
    for stage in range(1, 6):
        svg.append(f'<line x1="{left}" y1="{_fmt(y_at(stage))}" x2="{right}" y2="{_fmt(y_at(stage))}" stroke="#eeeeee"/>')
        svg.append(
            f'<text x="{left - 8}" y="{_fmt(y_at(stage) + 4)}" font-size="11" fill="#4d4d4d" '
            f'text-anchor="end">{stage}</text>'
        )
    if adjust:
        svg.append(build_line(True, "#e53935", "5 4"))
    svg.append(build_line(False, "#0017c1", ""))

    if adjust:
        for index, label in enumerate(labels):
            value = value_at(label, True)
            if value is not None:
                svg.append(f'<circle cx="{_fmt(x_at(index))}" cy="{_fmt(y_at(value))}" r="4" fill="#e53935"/>')

    for index, label in enumerate(labels):
        stage = _number(stages.get(label), math.nan)
        x = x_at(index)
        if stage >= 1 and stage <= 5:
            caution = stage <= 2
            color = "#8b0000" if caution else "#0017c1"
            text_color = "#8b0000" if caution else "#1a1a1a"
            svg.append(f'<circle cx="{_fmt(x)}" cy="{_fmt(y_at(stage))}" r="5" fill="{color}"/>')
            svg.append(
                f'<text x="{_fmt(x)}" y="{_fmt(y_at(stage) - 10)}" font-size="12" font-weight="700" '
                f'fill="{text_color}" text-anchor="middle">{escape(str(_format_number(stage)))}</text>'
            )
        else:
            svg.append(f'<text x="{_fmt(x)}" y="{_fmt(y_at(2.5))}" font-size="12" fill="#4d4d4d" text-anchor="middle">-</text>')
        svg.append(
            f'<text x="{_fmt(x)}" y="220" font-size="11" fill="#4d4d4d" '
            f'text-anchor="middle">{escape(short_label_for_pdf(label))}</text>'
        )
    svg.append("</svg>")
    return "".join(svg)


def render_pdf_result_table(labels: list[str], stages: dict, totals: dict) -> str:
    rows = []
    for label in labels:
        stage = _number(stages.get(label), math.nan)
        score = "-" if is_blank_for_pdf(totals.get(label)) else str(totals.get(label))
        stage_text = str(_format_number(stage)) if stage >= 1 and stage <= 5 else "-"
        rows.append(
            "<tr>"
            f"<td>{escape(str(label))}</td>"
            f"<td>{escape(score)}</td>"
            f"<td>{escape(stage_text)}</td>"
            f"<td>{escape(evaluation_text_for_pdf(stage))}</td>"
            "</tr>"
        )
    return "<table><thead><tr><th>項目</th><th>点数</th><th>段階</th><th>評価</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table>"


def evaluation_text_for_pdf(stage: float) -> str:
    if not (stage >= 1 and stage <= 5):
        return "-"
    if stage >= 4:
        return "安定"
    if stage == 3:
        return "標準"
    return "注意"


def sort_dashboard_labels_for_pdf(labels: list[str]) -> list[str]:
    return [
        item["label"]
        for item in sorted(
            [{"label": label, "index": index, "order": dashboard_label_order_for_pdf(label)} for index, label in enumerate(labels)],
            key=lambda item: (item["order"], item["index"]),
        )
    ]


def dashboard_label_order_for_pdf(label: str) -> int:
    circled_order = {
        "①": 1,
        "②": 2,
        "③": 3,
        "④": 4,
        "⑤": 5,
        "⑥": 6,
        "⑦": 7,
        "⑧": 8,
        "⑨": 9,
        "⑩": 10,
    }
    value = str(label or "").strip()
    if value[:1] in circled_order:
        return circled_order[value[:1]]
    numbered = re.match(r"^(\d{1,2})(?:[.)、．\s]|$)", value)
    if numbered:
        return int(numbered.group(1))
    return 2**53 - 1


def short_label_for_pdf(label: str) -> str:
    value = str(label or "")
    if value[:1] in {"①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"}:
        return value[:1]
    return value[:4]


def numeric_or_none_for_pdf(value: Any) -> float | None:
    if is_blank_for_pdf(value):
        return None
    number = _number(value, math.nan)
    return number if math.isfinite(number) else None


def is_blank_for_pdf(value: Any) -> bool:
    return value == "" or value is None


def _number(value: Any, default: float) -> float:
    try:
        if value == "":
            return default
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _format_number(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value


def _fmt(value: float) -> str:
    return str(_format_number(value))
