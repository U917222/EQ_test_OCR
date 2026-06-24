type CellValue = { value: number | null; confidence?: number; reason?: string };

export const CELL_KEYS = Array.from({ length: 80 }, (_, index) => `s${String(index + 1).padStart(2, "0")}`);

const LETTERS = "ABCDEFGHIJ";
const DEFAULT_ITEM_MASTER = [
  { key: "self_control", label: "①セルフコントロール", letter: "B", isAttitude: false },
  { key: "communication", label: "②コミュニケーション", letter: "A", isAttitude: false },
  { key: "situation", label: "③状況認識力", letter: "I", isAttitude: false },
  { key: "stress", label: "④ストレス対処力", letter: "G", isAttitude: false },
  { key: "proactivity", label: "⑤積極性", letter: "E", isAttitude: false },
  { key: "goal", label: "⑥目標達成力", letter: "H", isAttitude: false },
  { key: "positive", label: "⑦ポジティブ思考力", letter: "C", isAttitude: false },
  { key: "teamwork", label: "⑧チームワーク", letter: "F", isAttitude: false },
  { key: "hospitality", label: "⑨ホスピタリティー", letter: "D", isAttitude: false },
  { key: "attitude", label: "応答態度", letter: "J", isAttitude: true },
];

const DEFAULT_BANDS: Record<string, Array<{ min: number; max: number; stage: number }>> = {
  self_control: [[0, 8, 1], [9, 10, 2], [11, 12, 3], [13, 14, 4], [15, 24, 5]].map(band),
  communication: [[0, 9, 1], [10, 12, 2], [13, 14, 3], [15, 16, 4], [17, 24, 5]].map(band),
  situation: [[0, 9, 1], [10, 12, 2], [13, 15, 3], [16, 17, 4], [18, 24, 5]].map(band),
  stress: [[0, 12, 1], [13, 14, 2], [15, 16, 3], [17, 18, 4], [19, 24, 5]].map(band),
  proactivity: [[0, 11, 1], [12, 13, 2], [14, 15, 3], [16, 17, 4], [18, 24, 5]].map(band),
  goal: [[0, 9, 1], [10, 12, 2], [13, 14, 3], [15, 16, 4], [17, 24, 5]].map(band),
  positive: [[0, 8, 1], [9, 11, 2], [12, 13, 3], [14, 16, 4], [17, 24, 5]].map(band),
  teamwork: [[0, 8, 1], [9, 10, 2], [11, 13, 3], [14, 16, 4], [17, 24, 5]].map(band),
  hospitality: [[0, 12, 1], [13, 15, 2], [16, 17, 3], [18, 20, 4], [21, 24, 5]].map(band),
  attitude: [[0, 3, 1], [4, 7, 2], [8, 11, 3], [12, 15, 4], [16, 24, 5]].map(band),
};

export interface MasterRows {
  itemMaster: Array<Record<string, unknown>>;
  scoreBands: Array<Record<string, unknown>>;
  rankRules: Array<Record<string, unknown>>;
  handwrittenTotals: Array<Record<string, unknown>>;
}

export interface ScoreResult {
  rowScores: Record<string, number>;
  issues: Array<{ cell: string; row: string; reason: string }>;
  itemTotals: Record<string, number>;
  itemStages: Record<string, number | null>;
  responseAttitudeStage: number | null;
  attitudeMinusPoints: number;
  jobRequirementMinusPoints: number;
  jobRequirementLowItems: Array<{ key: string; label: string; stage: number }>;
  crossCheck: Array<{ item: string; computed: number; handwritten: number }>;
  totalRank: string;
  minusPoints: number;
  notes: string;
  resultRow: Record<string, unknown>;
}

export function scoreCandidate(
  cells: Record<string, CellValue>,
  masters: MasterRows,
  candidateId: string,
  actor: string,
): ScoreResult {
  const itemMaster = buildItemMaster(masters.itemMaster);
  const bands = buildBands(masters.scoreBands);
  const handwritten = buildHandwritten(masters.handwrittenTotals);
  const row = computeRowScores(cells);
  const itemTotals = Object.fromEntries(
    itemMaster.map((item) => [item.key, (row.scores[`${item.letter}1`] ?? 0) + (row.scores[`${item.letter}2`] ?? 0)]),
  );
  const itemStages = Object.fromEntries(
    Object.entries(itemTotals).map(([key, total]) => [key, (bands[key] ?? []).find((entry) => total >= entry.min && total <= entry.max)?.stage ?? null]),
  );
  const attitudeKey = itemMaster.find((item) => item.isAttitude)?.key ?? "";
  const responseAttitudeStage = attitudeKey ? itemStages[attitudeKey] ?? null : null;
  const attitudeMinusPoints = responseAttitudeStage === 5 ? -2 : responseAttitudeStage === 4 ? -1 : 0;
  const jobRequirementLowItems = itemMaster
    .filter((item) => !item.isAttitude && ["⑤", "⑥", "⑦", "⑧", "⑨"].includes(item.label.slice(0, 1)))
    .filter((item) => itemStages[item.key] === 1 || itemStages[item.key] === 2)
    .map((item) => ({ key: item.key, label: item.label, stage: Number(itemStages[item.key]) }));
  const jobRequirementMinusPoints = jobRequirementLowItems.length ? -jobRequirementLowItems.length : 0;
  const crossCheck = Object.entries(itemTotals)
    .filter(([key, total]) => handwritten[key] !== undefined && handwritten[key] !== total)
    .map(([key, total]) => ({ item: key, computed: total, handwritten: Number(handwritten[key]) }));
  const rank = calculateFallbackRank(itemStages, attitudeMinusPoints);
  const labels = Object.fromEntries(itemMaster.map((item) => [item.key, item.label]));
  const itemTotalsByLabel = labelKeyed(itemTotals, labels);
  const itemStagesByLabel = labelKeyed(itemStages, labels);
  const notes = buildNotes(rank.note, crossCheck.length, jobRequirementLowItems.length);
  const resultRow = {
    candidate_id: candidateId,
    total_rank: rank.rank,
    response_attitude_stage: responseAttitudeStage,
    minus_points: jobRequirementMinusPoints,
    attitude_minus_points: attitudeMinusPoints,
    job_requirement_minus_points: jobRequirementMinusPoints,
    job_requirement_low_items_json: JSON.stringify(jobRequirementLowItems.map(({ label, stage }) => ({ label, stage }))),
    row_scores_json: JSON.stringify(row.scores),
    item_totals_json: JSON.stringify(itemTotalsByLabel),
    item_stages_json: JSON.stringify(itemStagesByLabel),
    cross_check_json: JSON.stringify(crossCheck),
    notes,
    finalized_by: actor,
    finalized_at: new Date().toISOString(),
    status: "FINALIZED",
  };
  return {
    rowScores: row.scores,
    issues: row.issues,
    itemTotals,
    itemStages,
    responseAttitudeStage,
    attitudeMinusPoints,
    jobRequirementMinusPoints,
    jobRequirementLowItems,
    crossCheck,
    totalRank: rank.rank,
    minusPoints: jobRequirementMinusPoints,
    notes,
    resultRow,
  };
}

export function defaultCells(): Record<string, CellValue> {
  return Object.fromEntries(CELL_KEYS.map((key) => [key, { value: null, reason: "manual_entry_required" }]));
}

function band(values: number[]) {
  return { min: values[0], max: values[1], stage: values[2] };
}

function buildItemMaster(rows: Array<Record<string, unknown>>) {
  const source = rows.length ? rows : DEFAULT_ITEM_MASTER.map((item, index) => ({
    item_key: item.key,
    label: item.label,
    letter: item.letter,
    is_attitude: item.isAttitude ? "TRUE" : "",
    display_order: index + 1,
  }));
  return source
    .slice()
    .sort((a, b) => Number(a.display_order ?? 0) - Number(b.display_order ?? 0))
    .map((row) => ({
      key: String(row.item_key ?? "").trim(),
      label: String(row.label ?? "").trim(),
      letter: String(row.letter ?? "").trim().toUpperCase(),
      isAttitude: parseBool(row.is_attitude),
    }));
}

function buildBands(rows: Array<Record<string, unknown>>) {
  if (!rows.length) return DEFAULT_BANDS;
  const result: Record<string, Array<{ min: number; max: number; stage: number }>> = {};
  for (const row of rows) {
    const key = String(row.item_key ?? "").trim();
    if (!key) continue;
    result[key] ??= [];
    result[key].push({ min: Number(row.min_score), max: Number(row.max_score), stage: Number(row.stage) });
  }
  for (const entries of Object.values(result)) entries.sort((a, b) => a.min - b.min);
  return result;
}

function buildHandwritten(rows: Array<Record<string, unknown>>) {
  return Object.fromEntries(
    rows
      .map((row) => [String(row.item_key ?? "").trim(), Number(row.total)] as const)
      .filter(([key, total]) => key && Number.isFinite(total)),
  );
}

function computeRowScores(cells: Record<string, CellValue>) {
  const scores: Record<string, number> = {};
  const issues: Array<{ cell: string; row: string; reason: string }> = [];
  for (let block = 0; block < 2; block += 1) {
    for (const letter of LETTERS) {
      const row = `${letter}${block + 1}`;
      let sum = 0;
      for (let pos = 1; pos <= 4; pos += 1) {
        const key = `s${String(block * 40 + LETTERS.indexOf(letter) * 4 + pos).padStart(2, "0")}`;
        const cell = cells[key];
        if (!cell || cell.value === null || cell.value === undefined) {
          issues.push({ cell: key, row, reason: cell?.reason ?? "blank" });
        } else {
          sum += Number(cell.value);
        }
      }
      scores[row] = sum;
    }
  }
  return { scores, issues };
}

function calculateFallbackRank(stages: Record<string, number | null>, attitudeMinusPoints: number) {
  const values = Object.entries(stages)
    .filter(([key]) => key !== "attitude")
    .map(([, value]) => value)
    .filter((value): value is number => typeof value === "number");
  if (!values.length) return { rank: "", note: "段階得点がありません" };
  const min = Math.min(...values);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const low = values.filter((value) => value <= 2).length;
  if (min <= 1 || low >= 3) return { rank: "D", note: "低段階項目が複数あります" };
  if (low >= 1 || attitudeMinusPoints < 0 || average < 3) return { rank: "C", note: "注意項目があります" };
  if (average < 4) return { rank: "B", note: "標準範囲です" };
  return { rank: "A", note: "良好です" };
}

function labelKeyed<T>(values: Record<string, T>, labels: Record<string, string>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [labels[key] ?? key, value]));
}

function buildNotes(rankNote: string, mismatchCount: number, lowCount: number) {
  const notes = [rankNote];
  if (lowCount) notes.push(`職務必要要件(⑤〜⑨)で段階2以下が ${lowCount} 件`);
  if (mismatchCount) notes.push(`手書き合計と${mismatchCount}件不一致`);
  return notes.filter(Boolean).join(" / ");
}

function parseBool(value: unknown) {
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}
