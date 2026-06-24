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
};

export type RegisterCandidatePayload = {
  name: string;
  testDate: string;
  gender?: Candidate["gender"];
  memo?: string;
  file: {
    name: string;
    mimeType: string;
    base64: string;
  };
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
  roleBreakdown: Array<{ label: string; value: number }>;
  decisionBreakdown: Array<{ label: string; value: number }>;
  rankBreakdown: Array<{ rank: string; value: number }>;
  attentionItems: Array<{ label: string; value: number }>;
  recent: Candidate[];
};
