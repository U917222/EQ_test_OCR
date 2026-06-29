import type { CandidateResult, CheqItemKey } from "@/lib/types";

export const CHEQ_ITEMS: Array<{
  key: CheqItemKey;
  label: string;
  isJobRequirement: boolean;
  isAttitude: boolean;
}> = [
  {
    key: "self_control",
    label: "①セルフコントロール",
    isJobRequirement: false,
    isAttitude: false,
  },
  {
    key: "communication",
    label: "②コミュニケーション",
    isJobRequirement: false,
    isAttitude: false,
  },
  {
    key: "situation",
    label: "③状況認識力",
    isJobRequirement: false,
    isAttitude: false,
  },
  {
    key: "stress",
    label: "④ストレス対処力",
    isJobRequirement: false,
    isAttitude: false,
  },
  {
    key: "proactivity",
    label: "⑤積極性(職務必要要件)",
    isJobRequirement: true,
    isAttitude: false,
  },
  {
    key: "goal",
    label: "⑥目標達成力(職務必要要件)",
    isJobRequirement: true,
    isAttitude: false,
  },
  {
    key: "positive",
    label: "⑦ポジティブ思考力(職務必要要件)",
    isJobRequirement: true,
    isAttitude: false,
  },
  {
    key: "teamwork",
    label: "⑧チームワーク(職務必要要件)",
    isJobRequirement: true,
    isAttitude: false,
  },
  {
    key: "hospitality",
    label: "⑨ホスピタリティー(職務必要要件)",
    isJobRequirement: true,
    isAttitude: false,
  },
  {
    key: "attitude",
    label: "応答態度",
    isJobRequirement: false,
    isAttitude: true,
  },
];

export function buildProfileChartData(
  result: CandidateResult,
): Array<{ category: string; current: number; afterMinus: number }> {
  const attitudeMinus = Number(result.attitudeMinusPoints || 0);
  const applyMinus = attitudeMinus < 0;

  return CHEQ_ITEMS.filter((item) => !item.isAttitude).map((definition) => {
    const item = result.items.find((candidateItem) => candidateItem.key === definition.key);
    const current = Number(item?.stage || 0);
    return {
      category: definition.label.charAt(0),
      current,
      afterMinus: applyMinus ? Math.max(0, current + attitudeMinus) : current,
    };
  });
}

export function traitCopyForStage(label: string, stage: number): string {
  void stage;

  const copyByPrefix: Record<string, string> = {
    "①": "予期せぬことが起こると動転しやすい。その時の気分で行動にムラがある。不快・不安な気持ちや表情を周囲に出しやすい。",
    "②": "相手の状況や動きに気を配りにくい。言いたいことを相手に伝えるのが苦手。表情などから機嫌を読み取るのが困難。",
    "③": "新しい環境や問題への適応に時間がかかる。自分の役割理解が難しい。新しいことややり方に抵抗感を示しやすい。",
    "④": "ストレスを溜め込みやすい。困難時に立ち止まりやすく、行き詰まると踏み出しにくい。",
    "⑤": "自分で考えて行動するより他者の意見に従いやすい。指示通りに動くが創意工夫が少ない。良いと思っても実行に移しにくい。",
    "⑥": "目標が不明瞭で自信を持ちにくい。途中で諦めたり投げ出すことがある。困難が起こると妥協しやすい。",
    "⑦": "出来事や自分の行動を悲観的に捉えやすい。失敗や挫折から立ち直りにくい。気持ちの切り替えが苦手。",
    "⑧": "初対面の人に自ら積極的に関わりにくい。協働が苦手。対人トラブルが起こると逃げてしまいやすい。",
    "⑨": "人の気持ちや行動に無関心になりがち。気配りや配慮が欠けることがある。周囲に冷たい印象を与えやすい。",
  };
  const prefix = String(label || "").trim().charAt(0);
  return copyByPrefix[prefix] || "";
}
