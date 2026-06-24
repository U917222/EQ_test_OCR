import type {
  Evaluation,
  EvaluationItemKey,
  EvaluationItemMaster,
  EvaluationScore,
  EvaluationSummary,
} from "@/lib/types";

// 評価要素（マスタが無いときのフォールバック。migration 0007 の seed と一致させる）
export const EVAL_ITEMS: EvaluationItemMaster[] = [
  { key: "knowledge", label: "①知識・能力", description: "募集職種に対する、技術・能力・知識は十分か", displayOrder: 1 },
  { key: "adaptability", label: "②対応力", description: "対人対応力（コミュニケーション能力・接遇力・表現力）は十分か", displayOrder: 2 },
  { key: "personality", label: "③性格・人格", description: "本人の人柄や人格的特徴をつかむ（社交性・リーダーシップ・ストレス耐性など）", displayOrder: 3 },
  { key: "interest", label: "④関心・意欲", description: "当法人（当該業務）への関心の度合いを確認し、意欲を読み取る", displayOrder: 4 },
  { key: "potential", label: "⑤期待値・付加価値・将来性", description: "上記①〜④で評価できない、潜在能力に対する期待値", displayOrder: 5 },
  { key: "aptitude", label: "⑥適性", description: "人物の全体像を観察し、適性を総合的に判断する", displayOrder: 6 },
];

export const EVAL_ITEM_KEYS: EvaluationItemKey[] = EVAL_ITEMS.map((item) => item.key);

// 点数の選択肢（5..1）。参考ラベルは元エクセルの評価基準に対応。
export const EVAL_SCORE_OPTIONS: Array<{ value: EvaluationScore; label: string; note: string }> = [
  { value: 5, label: "5", note: "秀（非常に優れている）" },
  { value: 4, label: "4", note: "優（優れている）" },
  { value: 3, label: "3", note: "良（過不足なし）" },
  { value: 2, label: "2", note: "可（やや劣っている）" },
  { value: 1, label: "1", note: "不可（かなり劣っている）" },
];

// 6 項目 × 最大 5 点 = 30 点満点
export const EVAL_MAX_TOTAL = EVAL_ITEM_KEYS.length * 5;

export function totalScore(items: Array<{ score: number }>): number {
  return items.reduce((sum, item) => {
    const value = Number(item.score);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

export function summarize(evaluations: Evaluation[]): EvaluationSummary {
  const count = evaluations.length;
  const itemAverages = EVAL_ITEMS.map((item) => {
    const scores = evaluations
      .map((evaluation) => evaluation.items.find((it) => it.key === item.key)?.score)
      .filter((value): value is EvaluationScore => typeof value === "number" && Number.isFinite(value));
    return { key: item.key, label: item.label, average: average(scores) };
  });

  if (count === 0) {
    return { count: 0, averageTotal: null, itemAverages };
  }

  const totals = evaluations.map((evaluation) =>
    Number.isFinite(evaluation.totalScore) ? evaluation.totalScore : totalScore(evaluation.items),
  );
  return { count, averageTotal: average(totals), itemAverages };
}

export function itemLabel(key: EvaluationItemKey): string {
  return EVAL_ITEMS.find((item) => item.key === key)?.label ?? key;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
