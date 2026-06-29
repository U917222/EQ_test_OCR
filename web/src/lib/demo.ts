// デモ表示モード。VITE_DEMO=1 のときだけ有効。
// 裏側(Functions/GAS)に接続せず、サンプルデータで完成イメージを見るための仕組み。
// 本番ビルドや実バックエンド接続時は VITE_DEMO を外す(または 0)。
import {
  Candidate,
  CellKey,
  DashboardResponse,
  GetCellsResponse,
  Me,
  PdfResponse,
  ScoreCell,
} from "@/lib/types";

export const DEMO = import.meta.env.VITE_DEMO === "1";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEMO_USER: Me = { email: "tanaka@goseikai.jp", role: "admin" };

const candidates: Candidate[] = [
  {
    candidateId: "C-1001",
    name: "佐藤 花子",
    testDate: "2026-01-18",
    gender: "female",
    role: "総合職",
    postalCode: "100-0001",
    prefecture: "東京都",
    city: "千代田区",
    addressLine: "千代田1-1 サンプルハイツ101",
    status: "needs_review",
    uploadedAt: "2026-01-18T09:12:00+09:00",
    updatedAt: "2026-01-18T09:20:00+09:00",
    memo: "第一志望",
  },
  {
    candidateId: "C-1002",
    name: "鈴木 一郎",
    testDate: "2026-02-17",
    gender: "male",
    role: "一般職",
    postalCode: "930-0002",
    prefecture: "富山県",
    city: "富山市",
    addressLine: "新富町1-2-3",
    status: "finalized",
    decision: "hire",
    employeeNumber: "E-2026-014",
    decisionBy: "tanaka@goseikai.jp",
    decisionAt: "2026-06-19T14:05:00+09:00",
    uploadedAt: "2026-02-17T10:02:00+09:00",
    updatedAt: "2026-02-19T14:05:00+09:00",
  },
  {
    candidateId: "C-1003",
    name: "高橋 美咲",
    testDate: "2026-03-17",
    gender: "female",
    role: "技術職",
    postalCode: "933-0000",
    prefecture: "富山県",
    city: "高岡市",
    addressLine: "末広町2-5",
    status: "scored",
    uploadedAt: "2026-03-17T11:30:00+09:00",
    updatedAt: "2026-03-18T16:40:00+09:00",
  },
  {
    candidateId: "C-1004",
    name: "田中 健太",
    testDate: "2026-04-16",
    gender: "male",
    role: "総合職",
    postalCode: "530-0001",
    prefecture: "大阪府",
    city: "大阪市北区",
    addressLine: "梅田1-1",
    status: "finalized",
    decision: "reject",
    decisionBy: "tanaka@goseikai.jp",
    decisionAt: "2026-06-18T18:20:00+09:00",
    uploadedAt: "2026-04-16T08:50:00+09:00",
    updatedAt: "2026-04-18T18:20:00+09:00",
  },
  {
    candidateId: "C-1005",
    name: "伊藤 さくら",
    testDate: "2026-05-16",
    gender: "female",
    role: "一般職",
    postalCode: "939-8201",
    prefecture: "富山県",
    city: "富山市",
    addressLine: "山室1-10",
    status: "finalized",
    decision: "hire",
    decisionBy: "tanaka@goseikai.jp",
    decisionAt: "2026-06-18T13:00:00+09:00",
    uploadedAt: "2026-05-16T09:15:00+09:00",
    updatedAt: "2026-05-18T13:00:00+09:00",
  },
  {
    candidateId: "C-1006",
    name: "渡辺 大輔",
    testDate: "2026-06-19",
    gender: "male",
    role: "技術職",
    postalCode: "920-0001",
    prefecture: "石川県",
    city: "金沢市",
    addressLine: "千木町1-1",
    status: "uploaded",
    uploadedAt: "2026-06-19T08:05:00+09:00",
    updatedAt: "2026-06-19T08:05:00+09:00",
  },
];

const ITEM_LETTERS = "ABCDEFGHIJ";

function buildCells(): ScoreCell[] {
  const cells: ScoreCell[] = [];
  for (let i = 0; i < 80; i += 1) {
    const key = `s${String(i + 1).padStart(2, "0")}` as CellKey;
    const block = Math.floor(i / 40); // 0=上, 1=下
    const letterIndex = Math.floor((i % 40) / 4);
    const pos = (i % 4) + 1;
    const detected = (i * 3) % 4; // 0..3 を擬似的に
    const lowConfidence = i % 11 === 0; // 一部だけ低信頼にする
    const confidence = lowConfidence
      ? 0.42 + (i % 3) * 0.06
      : Math.min(0.99, 0.88 + (i % 10) * 0.012);
    cells.push({
      key,
      label: `${ITEM_LETTERS[letterIndex]}${block + 1}-${pos}`,
      row: block * 10 + letterIndex + 1,
      col: pos,
      detectedValue: detected,
      value: detected,
      confidence: Number(confidence.toFixed(2)),
      resolved: !lowConfidence,
    });
  }
  return cells;
}

const demoCells = buildCells();

// 採点用紙のプレビュー(SVGのダミー画像)。外部通信不要のデータURI。
const scoresheetSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560" viewBox="0 0 420 560">
  <rect width="420" height="560" fill="#ffffff" stroke="#e2e8f0"/>
  <text x="20" y="34" font-family="sans-serif" font-size="18" fill="#0f172a">CHEQ 採点用紙 (サンプル)</text>
  <text x="20" y="56" font-family="sans-serif" font-size="12" fill="#64748b">page.5 / 採点表</text>
  ${Array.from({ length: 10 })
    .map((_, r) => {
      const y = 90 + r * 44;
      return `<text x="20" y="${y + 16}" font-family="sans-serif" font-size="13" fill="#334155">${ITEM_LETTERS[r]}</text>
      ${Array.from({ length: 8 })
        .map((__, c) => `<rect x="${52 + c * 44}" y="${y}" width="38" height="30" rx="4" fill="#f8fafc" stroke="#cbd5e1"/><text x="${52 + c * 44 + 14}" y="${y + 20}" font-family="sans-serif" font-size="13" fill="#0f172a">${(r * 8 + c) % 4}</text>`)
        .join("")}`;
    })
    .join("")}
</svg>`;
const scoresheetImage = `data:image/svg+xml,${encodeURIComponent(scoresheetSvg)}`;

// 要確認セルの手書き切り抜き(デモ用ダミー)。確認カードに画像を出すため。
function buildCellImages(): Partial<Record<CellKey, string>> {
  const images: Partial<Record<CellKey, string>> = {};
  for (const cell of demoCells) {
    if (cell.resolved) continue;
    const digit = cell.detectedValue ?? "?";
    const cropSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="80" viewBox="0 0 180 80"><rect width="180" height="80" fill="#ffffff" stroke="#cbd5e1"/><text x="16" y="54" font-family="sans-serif" font-size="34" fill="#94a3b8">${digit}</text><circle cx="126" cy="40" r="24" fill="none" stroke="#0f172a" stroke-width="3"/><text x="115" y="52" font-family="serif" font-size="30" fill="#0f172a">${digit}</text></svg>`;
    images[cell.key] = `data:image/svg+xml,${encodeURIComponent(cropSvg)}`;
  }
  return images;
}

const cellsResponse: GetCellsResponse = {
  cells: demoCells,
  reviewQueue: demoCells.filter((cell) => !cell.resolved).map((cell) => cell.key),
  imageLinks: { preview: scoresheetImage, original: scoresheetImage, pages: [scoresheetImage] },
  cellImages: buildCellImages(),
};

type DemoDecision = "hire" | "reject";
type CheqItemKey =
  | "self_control"
  | "communication"
  | "situation"
  | "stress"
  | "proactivity"
  | "goal"
  | "positive"
  | "teamwork"
  | "hospitality"
  | "attitude";

type CheqItem = {
  key: CheqItemKey;
  label: string;
  total: number;
  stage: number;
  isJobRequirement: boolean;
  isAttitude: boolean;
};

type CandidateResult = {
  candidateId: string;
  totalRank: "A" | "B" | "C" | "D" | "";
  responseAttitudeStage: number | null;
  attitudeMinusPoints: number;
  jobRequirementMinusPoints: number;
  jobRequirementLowItems: { label: string; stage: number }[];
  items: CheqItem[];
  crossCheck: { item: string; computed: number; handwritten: number | null }[];
  notes?: string;
  finalizedBy?: string;
  finalizedAt?: string;
  status: Candidate["status"];
};

type RawCellSummary = {
  confidenceAvg: number;
  unresolvedCount: number;
  pageIndex?: number;
  updatedAt?: string;
};

type DemoGetResultResponse = {
  candidate: Candidate;
  result: CandidateResult | null;
  rawCellSummary: RawCellSummary | null;
  sourceUrl?: string;
};

const cheqItemDefs: Array<Pick<CheqItem, "key" | "label" | "isJobRequirement" | "isAttitude">> = [
  { key: "self_control", label: "①セルフコントロール", isJobRequirement: false, isAttitude: false },
  { key: "communication", label: "②コミュニケーション", isJobRequirement: false, isAttitude: false },
  { key: "situation", label: "③状況認識力", isJobRequirement: false, isAttitude: false },
  { key: "stress", label: "④ストレス対処力", isJobRequirement: false, isAttitude: false },
  { key: "proactivity", label: "⑤積極性", isJobRequirement: true, isAttitude: false },
  { key: "goal", label: "⑥目標達成力", isJobRequirement: true, isAttitude: false },
  { key: "positive", label: "⑦ポジティブ思考力", isJobRequirement: true, isAttitude: false },
  { key: "teamwork", label: "⑧チームワーク", isJobRequirement: true, isAttitude: false },
  { key: "hospitality", label: "⑨ホスピタリティー", isJobRequirement: true, isAttitude: false },
  { key: "attitude", label: "応答態度", isJobRequirement: false, isAttitude: true },
];

function seedFor(candidateId: string): number {
  return Array.from(candidateId).reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(24, score));
}

function stageFor(total: number): number {
  if (total >= 21) return 5;
  if (total >= 17) return 4;
  if (total >= 13) return 3;
  if (total >= 9) return 2;
  return 1;
}

function rankFor(items: CheqItem[]): CandidateResult["totalRank"] {
  const lowCount = items
    .filter((item) => !item.isAttitude && ["①", "②", "③", "④"].includes(item.label.slice(0, 1)))
    .filter((item) => item.stage <= 2).length;
  if (lowCount <= 0) return "A";
  if (lowCount === 1) return "B";
  if (lowCount === 2) return "C";
  return "D";
}

function decisionFromPayload(value: unknown): DemoDecision {
  return value === "reject" ? "reject" : "hire";
}

function resultFor(candidateId: string): CandidateResult {
  const seed = seedFor(candidateId);
  const baseTotals = [19, 17, 16, 18, 14, 15, 18, 17, 15, 20];
  const lowRequirementIndex = 4 + (seed % 5);
  const items = cheqItemDefs.map((definition, index) => {
    const variation = ((seed + index * 2) % 5) - 2;
    const total = index === lowRequirementIndex
      ? clampScore(10 + (seed % 3))
      : clampScore(baseTotals[index] + variation);
    return {
      ...definition,
      total,
      stage: stageFor(total),
    };
  });
  const attitudeItem = items.find((item) => item.isAttitude);
  const jobRequirementLowItems = items
    .filter((item) => item.isJobRequirement && item.stage <= 2)
    .map((item) => ({ label: item.label, stage: item.stage }));
  const goalItem = items.find((item) => item.key === "goal");

  return {
    candidateId,
    totalRank: rankFor(items),
    responseAttitudeStage: attitudeItem?.stage ?? null,
    attitudeMinusPoints: (attitudeItem?.stage ?? 0) >= 4 ? -1 : -2,
    jobRequirementMinusPoints: jobRequirementLowItems.length * 2,
    jobRequirementLowItems,
    items,
    crossCheck: seed % 3 === 0 || !goalItem
      ? []
      : [{ item: goalItem.label, computed: goalItem.total, handwritten: Math.max(0, goalItem.total - 2) }],
    notes: "旧GAS版のCHEQ個票確認用デモデータです。",
    finalizedBy: DEMO_USER.email,
    finalizedAt: "2026-06-23T09:30:00+09:00",
    status: "scored",
  };
}

function getResultResponse(candidateId: string): DemoGetResultResponse {
  const candidate = candidates.find((c) => c.candidateId === candidateId) ?? candidates[0];
  const pendingStatuses: Array<Candidate["status"]> = ["uploaded", "recognizing", "needs_review"];
  return {
    candidate,
    result: pendingStatuses.includes(candidate.status) ? null : resultFor(candidate.candidateId),
    rawCellSummary: {
      confidenceAvg: 0.93,
      unresolvedCount: 2,
      pageIndex: 5,
      updatedAt: candidate.updatedAt ?? "2026-06-23T09:30:00+09:00",
    },
    sourceUrl: scoresheetImage,
  };
}

const MINIMAL_PDF =
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

function getDashboardResponse(yearInput?: unknown): DashboardResponse {
  const years = Array.from(new Set(candidates.map((candidate) => new Date(candidate.testDate).getFullYear()))).sort((a, b) => b - a);
  const year = Number(yearInput) || years[0] || new Date().getFullYear();
  const selected = candidates.filter((candidate) => new Date(candidate.testDate).getFullYear() === year);
  const previousYearTotal = candidates.filter((candidate) => new Date(candidate.testDate).getFullYear() === year - 1).length;
  const monthly = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    label: `${index + 1}月`,
    male: 0,
    female: 0,
    other: 0,
    unknown: 0,
    total: 0,
    finalized: 0,
    hired: 0,
    rejected: 0,
    needsReview: 0,
    passRate: 0,
  }));
  const byStatus: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  const byRank: Record<string, number> = {};
  const attentionItems: Record<string, number> = {};
  let hired = 0;
  let rejected = 0;
  let finalized = 0;
  let genderUnknown = 0;
  let lowRequirementCandidates = 0;
  let attitudeTotal = 0;
  let attitudeCount = 0;

  for (const candidate of selected) {
    const month = new Date(candidate.testDate).getMonth();
    const row = monthly[month];
    const gender = normalizeDemoGender(candidate.gender);
    row[gender] += 1;
    row.total += 1;
    if (gender === "unknown") genderUnknown += 1;
    if (candidate.status === "needs_review") row.needsReview += 1;
    if (candidate.status === "finalized") {
      row.finalized += 1;
      finalized += 1;
    }
    if (candidate.decision === "hire") {
      row.hired += 1;
      hired += 1;
    }
    if (candidate.decision === "reject") {
      row.rejected += 1;
      rejected += 1;
    }
    byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
    const region = demoRegion(candidate.prefecture ?? "", candidate.city ?? "");
    byRegion[region] = (byRegion[region] ?? 0) + 1;

    if (!["uploaded", "recognizing", "needs_review"].includes(candidate.status)) {
      const result = resultFor(candidate.candidateId);
      byRank[result.totalRank] = (byRank[result.totalRank] ?? 0) + 1;
      if (result.responseAttitudeStage !== null) {
        attitudeTotal += result.responseAttitudeStage;
        attitudeCount += 1;
      }
      if (result.jobRequirementLowItems.length) {
        lowRequirementCandidates += 1;
        for (const item of result.jobRequirementLowItems) {
          attentionItems[item.label] = (attentionItems[item.label] ?? 0) + 1;
        }
      }
    }
  }

  for (const row of monthly) {
    const decided = row.hired + row.rejected;
    row.passRate = decided ? Math.round((row.hired / decided) * 100) : 0;
  }

  const decided = hired + rejected;
  const updatedAt = selected
    .map((candidate) => candidate.updatedAt || candidate.uploadedAt || candidate.testDate)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? "";

  return {
    year,
    availableYears: years.length ? years : [year],
    generatedAt: new Date().toISOString(),
    updatedAt,
    dataSource: "DEMO candidates/results/review_queue",
    summary: {
      total: selected.length,
      previousYearTotal,
      previousYearDiff: selected.length - previousYearTotal,
      previousYearRate: previousYearTotal ? Math.round(((selected.length - previousYearTotal) / previousYearTotal) * 100) : null,
      finalized,
      finalizedRate: selected.length ? Math.round((finalized / selected.length) * 100) : 0,
      hired,
      rejected,
      decided,
      passRate: decided ? Math.round((hired / decided) * 100) : 0,
      needsReview: byStatus.needs_review ?? 0,
      openReviews: (byStatus.needs_review ?? 0) * 8,
      genderUnknown,
      lowRequirementCandidates,
      averageAttitudeStage: attitudeCount ? Math.round((attitudeTotal / attitudeCount) * 10) / 10 : null,
    },
    monthly,
    statusBreakdown: Object.entries(byStatus).map(([status, value]) => ({ status, value })),
    regionBreakdown: Object.entries(byRegion).map(([label, value]) => ({ label, value })).sort(sortDemoBreakdown).slice(0, 10),
    decisionBreakdown: [
      { label: "合格", value: hired },
      { label: "不合格", value: rejected },
      { label: "未判定", value: Math.max(0, selected.length - decided) },
    ],
    rankBreakdown: ["A", "B", "C", "D"].map((rank) => ({ rank, value: byRank[rank] ?? 0 })),
    attentionItems: Object.entries(attentionItems).map(([label, value]) => ({ label, value })).sort(sortDemoBreakdown).slice(0, 8),
    recent: selected.slice().sort((a, b) => new Date(b.testDate).getTime() - new Date(a.testDate).getTime()).slice(0, 10),
  };
}

function normalizeDemoGender(value: Candidate["gender"]): "male" | "female" | "other" | "unknown" {
  if (value === "male" || value === "female" || value === "other") return value;
  return "unknown";
}

// 富山県だけは市町村粒度で見たいので市区町村ラベル、それ以外は都道府県でまとめる。
function demoRegion(prefecture: string, city: string): string {
  if (!prefecture) return "未設定";
  if (prefecture === "富山県") return city || "富山県（市町村未設定）";
  return prefecture;
}

function sortDemoBreakdown(a: { label: string; value: number }, b: { label: string; value: number }) {
  return b.value - a.value || a.label.localeCompare(b.label, "ja");
}

export async function getDemoResponse(action: string, payload: Record<string, unknown>): Promise<unknown> {
  await delay(280);
  switch (action) {
    case "me":
      return DEMO_USER;
    case "listCandidates": {
      let list = candidates.slice();
      const search = typeof payload.search === "string" ? payload.search.trim() : "";
      const status = typeof payload.status === "string" ? payload.status : "";
      if (search) list = list.filter((c) => c.name.includes(search));
      if (status) list = list.filter((c) => c.status === status);
      return { candidates: list };
    }
    case "getDashboard":
      return getDashboardResponse(payload.year);
    case "getCells":
      return cellsResponse;
    case "getResult":
      return getResultResponse(String(payload.candidateId ?? "C-1003"));
    case "registerCandidate":
      return {
        candidate: {
          candidateId: "C-9001",
          name: String(payload.name ?? "新規候補者"),
          testDate: String(payload.testDate ?? "2026-06-23"),
          gender: typeof payload.gender === "string" ? payload.gender : undefined,
          role: String(payload.role ?? "総合職"),
          postalCode: typeof payload.postalCode === "string" ? payload.postalCode : undefined,
          prefecture: typeof payload.prefecture === "string" ? payload.prefecture : undefined,
          city: typeof payload.city === "string" ? payload.city : undefined,
          addressLine: typeof payload.addressLine === "string" ? payload.addressLine : undefined,
          memo: typeof payload.memo === "string" ? payload.memo : undefined,
          status: "uploaded",
          uploadedAt: "2026-06-23T09:00:00+09:00",
          updatedAt: "2026-06-23T09:00:00+09:00",
        } satisfies Candidate,
      };
    case "updateCandidate": {
      const target = candidates.find((c) => c.candidateId === payload.candidateId) ?? candidates[0];
      target.name = String(payload.name ?? target.name);
      target.testDate = String(payload.testDate ?? target.testDate);
      target.gender = typeof payload.gender === "string" ? payload.gender : undefined;
      target.postalCode = typeof payload.postalCode === "string" ? payload.postalCode : "";
      target.prefecture = typeof payload.prefecture === "string" ? payload.prefecture : "";
      target.city = typeof payload.city === "string" ? payload.city : "";
      target.addressLine = typeof payload.addressLine === "string" ? payload.addressLine : "";
      target.memo = typeof payload.memo === "string" ? payload.memo : "";
      target.updatedAt = "2026-06-23T10:15:00+09:00";
      return { candidate: { ...target } satisfies Candidate };
    }
    case "saveCells":
      return { saved: true };
    case "finalize":
      return { result: resultFor(String(payload.candidateId ?? "C-1003")) };
    case "saveDecision": {
      const base = candidates.find((c) => c.candidateId === payload.candidateId) ?? candidates[0];
      const nextDecision = decisionFromPayload(payload.decision);
      base.decision = nextDecision;
      base.employeeNumber = nextDecision === "hire" && typeof payload.employeeNumber === "string" ? payload.employeeNumber : "";
      base.decisionBy = DEMO_USER.email;
      base.decisionAt = "2026-06-23T09:30:00+09:00";
      base.status = "finalized";
      base.updatedAt = "2026-06-23T09:30:00+09:00";
      return {
        candidate: {
          ...base,
        } satisfies Candidate,
      };
    }
    case "updateStatus": {
      const target = candidates.find((c) => c.candidateId === payload.candidateId);
      if (target && typeof payload.status === "string") {
        target.status = payload.status as Candidate["status"];
        target.updatedAt = "2026-06-23T10:00:00+09:00";
      }
      return { candidate: target ?? candidates[0] };
    }
    case "deleteCandidate": {
      const index = candidates.findIndex((c) => c.candidateId === payload.candidateId);
      if (index >= 0) candidates.splice(index, 1);
      return { deleted: true, candidateId: String(payload.candidateId ?? "") };
    }
    case "getResultPdf":
      return {
        filename: "result-demo.pdf",
        mimeType: "application/pdf",
        base64: btoa(MINIMAL_PDF),
      } satisfies PdfResponse;
    default:
      return {};
  }
}
