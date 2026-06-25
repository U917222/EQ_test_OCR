export type Role = "operator" | "reviewer" | "admin";

export type CandidateStatus =
  | "uploaded"
  | "recognizing"
  | "needs_review"
  | "scored"
  | "finalized";

export type Decision = "hire" | "reject";

export type CheqItemKey =
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

export type CheqItem = {
  key: CheqItemKey;
  label: string;
  total: number;
  stage: number;
  isJobRequirement: boolean;
  isAttitude: boolean;
};

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "validation"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "upstream"
  | "internal";

export type ApiErrorBody = {
  code: ApiErrorCode | string;
  message: string;
};

export type Me = {
  email: string;
  role: Role;
};

export type Candidate = {
  candidateId: string;
  name: string;
  testDate: string;
  gender?: "male" | "female" | "other" | "unknown" | string;
  role?: string;
  postalCode?: string;
  prefecture?: string;
  city?: string;
  addressLine?: string;
  status: CandidateStatus;
  uploadedAt: string;
  decision?: Decision;
  employeeNumber?: string;
  decisionBy?: string;
  decisionAt?: string;
  memo?: string;
  updatedAt?: string;
};

export type CellKey = `s${string}`;

export type CellRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScoreCell = {
  key: CellKey;
  label?: string;
  row: number;
  col: number;
  detectedValue: number | null;
  value: number | null;
  confidence: number;
  bbox?: CellRect;
  resolved?: boolean;
};

export type ImageLinks = {
  original?: string;
  preview?: string;
  pages?: string[];
  mimeType?: string;
};

export type GetCellsResponse = {
  cells: ScoreCell[];
  reviewQueue: CellKey[];
  imageLinks: ImageLinks;
  // 各要確認セルの手書き切り抜き画像 (URL または data:image/... )。getCells の
  // imageLinks に混在する sNN キーを分離したもの。存在しないセルは未設定。
  cellImages: Partial<Record<CellKey, string>>;
};

export type RegisterCandidatePayload = {
  name: string;
  testDate: string;
  gender?: Candidate["gender"];
  postalCode?: string;
  prefecture?: string;
  city?: string;
  addressLine?: string;
  memo?: string;
  file: {
    name: string;
    mimeType: string;
    base64: string;
  };
  operationId: string;
};

export type UpdateCandidatePayload = {
  candidateId: string;
  name: string;
  testDate: string;
  gender?: Candidate["gender"];
  postalCode?: string;
  prefecture?: string;
  city?: string;
  addressLine?: string;
  memo?: string;
  operationId: string;
};

export type SaveCellsPayload = {
  candidateId: string;
  cells: Record<CellKey, number | null>;
  operationId: string;
};

export type CandidateResult = {
  candidateId: string;
  totalRank: "A" | "B" | "C" | "D" | "";
  responseAttitudeStage: number | null;
  attitudeMinusPoints: number;
  jobRequirementMinusPoints: number;
  jobRequirementLowItems: Array<{ label: string; stage: number }>;
  items: CheqItem[];
  crossCheck: Array<{ item: string; computed: number; handwritten: number | null }>;
  notes?: string;
  finalizedBy?: string;
  finalizedAt?: string;
  status: CandidateStatus;
};

export type RawCellSummary = {
  confidenceAvg: number;
  unresolvedCount: number;
  pageIndex?: number;
  updatedAt?: string;
};

export type GetResultResponse = {
  candidate: Candidate;
  result: CandidateResult | null;
  rawCellSummary: RawCellSummary | null;
  sourceUrl?: string;
};

export type PdfResponse = {
  filename: string;
  mimeType: "application/pdf";
  base64: string;
};

export type DashboardMonth = {
  month: number;
  label: string;
  male: number;
  female: number;
  other: number;
  unknown: number;
  total: number;
  finalized: number;
  hired: number;
  rejected: number;
  needsReview: number;
  passRate: number;
};

// ---- 総合評定（面接評価） ----

export type EvaluationItemKey =
  | "knowledge"
  | "adaptability"
  | "personality"
  | "interest"
  | "potential"
  | "aptitude";

export type EvaluationScore = 1 | 2 | 3 | 4 | 5;

export type EvaluationItemMaster = {
  key: EvaluationItemKey;
  label: string;
  description: string;
  displayOrder: number;
};

export type EvaluationItem = {
  key: EvaluationItemKey;
  score: EvaluationScore;
  comment: string;
};

export type Evaluation = {
  evaluationId: string;
  candidateId: string;
  evaluatorName: string;
  evalDate: string;
  jobRole: string;
  totalScore: number;
  overallComment: string;
  items: EvaluationItem[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type EvaluatorOption = {
  evaluatorId: string;
  name: string;
};

export type EvaluationItemAverage = {
  key: EvaluationItemKey;
  label: string;
  average: number | null;
};

export type EvaluationSummary = {
  count: number;
  averageTotal: number | null;
  itemAverages: EvaluationItemAverage[];
};

export type ListEvaluationMetaResponse = {
  items: EvaluationItemMaster[];
  evaluators: EvaluatorOption[];
};

export type ListEvaluationsResponse = {
  evaluations: Evaluation[];
};

export type GetEvaluationResponse = {
  evaluation: Evaluation;
};

export type SaveEvaluationPayload = {
  candidateId: string;
  evaluationId?: string;
  evaluatorName: string;
  evalDate: string;
  jobRole: string;
  overallComment: string;
  items: Array<{ key: EvaluationItemKey; score: number; comment: string }>;
  operationId: string;
};

export type RegisterEvaluatorPayload = {
  name: string;
  operationId: string;
};

export type DashboardResponse = {
  year: number;
  availableYears: number[];
  generatedAt: string;
  updatedAt: string;
  dataSource: string;
  summary: {
    total: number;
    previousYearTotal: number;
    previousYearDiff: number;
    previousYearRate: number | null;
    finalized: number;
    finalizedRate: number;
    hired: number;
    rejected: number;
    decided: number;
    passRate: number;
    needsReview: number;
    openReviews: number;
    genderUnknown: number;
    lowRequirementCandidates: number;
    averageAttitudeStage: number | null;
  };
  monthly: DashboardMonth[];
  statusBreakdown: Array<{ status: CandidateStatus | string; value: number }>;
  regionBreakdown: Array<{ label: string; value: number }>;
  decisionBreakdown: Array<{ label: string; value: number }>;
  rankBreakdown: Array<{ rank: string; value: number }>;
  attentionItems: Array<{ label: string; value: number }>;
  recent: Candidate[];
};
