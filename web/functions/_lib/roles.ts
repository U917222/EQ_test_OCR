export type Role = "operator" | "reviewer" | "admin";

export type Action =
  | "me"
  | "listCandidates"
  | "getDashboard"
  | "getCells"
  | "getResult"
  | "listCandidateDocuments"
  | "registerCandidate"
  | "attachScoresheet"
  | "uploadCandidateDocument"
  | "deleteCandidateDocument"
  | "updateCandidate"
  | "saveCells"
  | "updateStatus"
  | "deleteCandidate"
  | "finalize"
  | "saveDecision"
  | "getResultPdf"
  | "exportBackup"
  | "listEvaluationMeta"
  | "listEvaluations"
  | "getEvaluation"
  | "registerEvaluator"
  | "saveEvaluation"
  | "deleteEvaluation";

const requiredRoles: Record<Action, Role | null> = {
  me: null,
  listCandidates: "operator",
  getDashboard: "operator",
  getCells: "operator",
  getResult: "operator",
  listCandidateDocuments: "operator",
  registerCandidate: "operator",
  attachScoresheet: "operator",
  uploadCandidateDocument: "operator",
  deleteCandidateDocument: "operator",
  updateCandidate: "operator",
  saveCells: "operator",
  updateStatus: "operator",
  deleteCandidate: "operator",
  finalize: "reviewer",
  saveDecision: "reviewer",
  getResultPdf: "reviewer",
  exportBackup: "admin",
  listEvaluationMeta: "operator",
  listEvaluations: "operator",
  getEvaluation: "operator",
  registerEvaluator: "operator",
  saveEvaluation: "operator",
  deleteEvaluation: "reviewer",
};

const roleRank: Record<Role, number> = {
  operator: 1,
  reviewer: 2,
  admin: 3,
};

const writeActions = new Set<Action>([
  "registerCandidate",
  "attachScoresheet",
  "uploadCandidateDocument",
  "deleteCandidateDocument",
  "updateCandidate",
  "saveCells",
  "updateStatus",
  "deleteCandidate",
  "finalize",
  "saveDecision",
  "registerEvaluator",
  "saveEvaluation",
  "deleteEvaluation",
]);

export function isAction(value: string): value is Action {
  return Object.prototype.hasOwnProperty.call(requiredRoles, value);
}

export function isRole(value: unknown): value is Role {
  return value === "operator" || value === "reviewer" || value === "admin";
}

export function isWriteAction(action: Action): boolean {
  return writeActions.has(action);
}

export function canPerform(action: Action, role: Role): boolean {
  const required = requiredRoles[action];
  if (required === null) {
    return true;
  }

  return roleRank[role] >= roleRank[required];
}

export function requiredRoleFor(action: Action): Role | null {
  return requiredRoles[action];
}
