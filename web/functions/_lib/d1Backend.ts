import { HttpError } from "./errors";
import { isWriteAction, type Action, type Role } from "./roles";
import { CELL_KEYS, defaultCells, scoreCandidate, type MasterRows } from "./cheqScoring";
import { exportD1ToSpreadsheetBackup } from "./spreadsheetBackup";
import { postToGas, readJsonResponse, type GasEnv } from "./gasClient";
import { createEnvelope } from "./sign";

interface Env {
  CHEQ_DB: D1Database;
  CHEQ_FILES?: R2Bucket;
  GAS_API_URL?: string;
  FUNCTIONS_GAS_SECRET?: string;
}

interface Context {
  action: Action;
  operator: string;
  role: Role;
  operationId: string | null;
  payload: Record<string, unknown>;
}

const ROLE_RANK: Record<Role, number> = { operator: 1, reviewer: 2, admin: 3 };
const REQUIRED_ROLES: Record<Action, Role> = {
  me: "operator",
  listCandidates: "operator",
  getDashboard: "operator",
  getCells: "operator",
  getResult: "operator",
  getResultPdf: "reviewer",
  registerCandidate: "operator",
  saveCells: "operator",
  updateStatus: "operator",
  deleteCandidate: "operator",
  finalize: "reviewer",
  saveDecision: "reviewer",
  exportBackup: "admin",
  listEvaluationMeta: "operator",
  listEvaluations: "operator",
  getEvaluation: "operator",
  registerEvaluator: "operator",
  saveEvaluation: "operator",
  deleteEvaluation: "reviewer",
};

const STATUS_TO_API: Record<string, string> = {
  REGISTERED: "uploaded",
  UPLOADED: "uploaded",
  PROCESSING: "recognizing",
  PROCESSING_FAILED: "needs_review",
  REVIEW_REQUIRED: "needs_review",
  READY_TO_FINALIZE: "scored",
  FINALIZED: "finalized",
};

const API_TO_STATUS: Record<string, string> = {
  uploaded: "UPLOADED",
  recognizing: "PROCESSING",
  needs_review: "REVIEW_REQUIRED",
  scored: "READY_TO_FINALIZE",
  finalized: "FINALIZED",
};

export async function dispatchD1(
  env: Env,
  action: Action,
  email: string,
  payload: Record<string, unknown>,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (!env.CHEQ_DB) throw new HttpError(500, "internal", "Missing CHEQ_DB binding");
  const user = await resolveUser(env.CHEQ_DB, email);
  authorize(action, user.role);
  const context: Context = {
    action,
    operator: user.email,
    role: user.role,
    operationId: operationIdFrom(payload),
    payload,
  };
  if (isWriteAction(action) && !context.operationId) {
    throw new HttpError(400, "validation", "operationId is required for write actions");
  }
  const result = await executeWithIdempotency(env.CHEQ_DB, context, () => handleAction(env, context, waitUntil));
  const auditPromise = appendAudit(env.CHEQ_DB, context, result);
  if (waitUntil) waitUntil(auditPromise.catch(() => undefined));
  else await auditPromise;
  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function handleAction(
  env: Env,
  context: Context,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Record<string, unknown>> {
  const db = env.CHEQ_DB;
  switch (context.action) {
    case "me":
      return { email: context.operator, role: context.role };
    case "listCandidates":
      return { candidates: await listCandidates(db, context.payload) };
    case "getDashboard":
      return getDashboard(db, context.payload);
    case "getCells":
      return getCells(db, requireCandidateId(context.payload));
    case "getResult":
      return getResult(db, requireCandidateId(context.payload));
    case "registerCandidate":
      return registerCandidate(env, context);
    case "saveCells":
      return saveCells(db, requireCandidateId(context.payload), context.payload.cells);
    case "updateStatus":
      return updateStatus(db, requireCandidateId(context.payload), String(context.payload.status ?? ""));
    case "deleteCandidate":
      return deleteCandidate(env, requireCandidateId(context.payload), waitUntil);
    case "finalize":
      return finalizeCandidate(db, requireCandidateId(context.payload), context.operator);
    case "saveDecision":
      return saveDecision(db, requireCandidateId(context.payload), context.payload, context.operator);
    case "getResultPdf":
      throw new HttpError(400, "validation", "D1 backend does not generate result PDFs yet");
    case "exportBackup":
      return { backup: await exportD1ToSpreadsheetBackup(db, { bindingName: "CHEQ_DB" }) };
    case "listEvaluationMeta":
      return listEvaluationMeta(db);
    case "listEvaluations":
      return listEvaluations(db, requireCandidateId(context.payload));
    case "getEvaluation":
      return getEvaluation(db, requireEvaluationId(context.payload));
    case "registerEvaluator":
      return registerEvaluator(db, context.payload);
    case "saveEvaluation":
      return saveEvaluation(db, context);
    case "deleteEvaluation":
      return deleteEvaluation(db, context.payload);
    default:
      throw new HttpError(400, "validation", `Unsupported action: ${context.action}`);
  }
}

async function resolveUser(db: D1Database, email: string): Promise<{ email: string; role: Role }> {
  const normalized = normalizeEmail(email);
  const user = await db
    .prepare("SELECT email, role, active FROM users WHERE email = ?")
    .bind(normalized)
    .first<{ email: string; role: Role; active: number }>();
  if (!user || !user.active) throw new HttpError(403, "forbidden", "User is not active");
  if (!["operator", "reviewer", "admin"].includes(user.role)) {
    throw new HttpError(403, "forbidden", "User role is invalid");
  }
  return { email: normalized, role: user.role };
}

function authorize(action: Action, role: Role): void {
  if (ROLE_RANK[role] < ROLE_RANK[REQUIRED_ROLES[action]]) {
    throw new HttpError(403, "forbidden", "Insufficient role");
  }
}

async function executeWithIdempotency(
  db: D1Database,
  context: Context,
  handler: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (!isWriteAction(context.action)) return handler();
  const existing = await db
    .prepare("SELECT action, candidate_id, status, result_json FROM api_operations WHERE operation_id = ?")
    .bind(context.operationId)
    .first<{ action: string; candidate_id: string; status: string; result_json: string }>();
  if (existing) {
    if (existing.action !== context.action) throw new HttpError(409, "conflict", "operationId was already used");
    if (existing.status !== "SUCCEEDED") {
      const saved = jsonParse(existing.result_json, {}) as { error?: unknown };
      const message = typeof saved.error === "string" && saved.error ? saved.error : "operationId is not replayable";
      throw new HttpError(existing.status === "FAILED" ? 500 : 409, existing.status === "FAILED" ? "internal" : "conflict", message);
    }
    return { idempotentReplay: true, ...jsonParse(existing.result_json, {}) };
  }
  await db
    .prepare("INSERT INTO api_operations (operation_id, action, candidate_id, status, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(context.operationId, context.action, candidateIdFromPayload(context.payload), "PROCESSING", "{}", nowIso())
    .run();
  try {
    const result = await handler();
    await db
      .prepare("UPDATE api_operations SET candidate_id = ?, status = ?, result_json = ? WHERE operation_id = ?")
      .bind(candidateIdFromResult(context.payload, result), "SUCCEEDED", JSON.stringify(result), context.operationId)
      .run();
    return result;
  } catch (error) {
    await db
      .prepare("UPDATE api_operations SET status = ?, result_json = ? WHERE operation_id = ?")
      .bind("FAILED", JSON.stringify({ error: error instanceof Error ? error.message : "failed" }), context.operationId)
      .run();
    throw error;
  }
}

async function listCandidates(db: D1Database, payload: Record<string, unknown>) {
  const search = String(payload.search ?? "").trim();
  const status = apiStatusToStoredStatus(payload.status);
  const where: string[] = [];
  const bindings: string[] = [];
  if (search) {
    where.push("(LOWER(name) LIKE ? OR LOWER(candidate_id) LIKE ?)");
    const term = `%${search.toLowerCase()}%`;
    bindings.push(term, term);
  }
  if (status !== null) {
    where.push("status = ?");
    bindings.push(status);
  }
  const sql = `
    SELECT
      candidate_id,
      name,
      test_date,
      gender,
      role,
      status,
      uploaded_at,
      hiring_decision,
      employee_number,
      decision_by,
      decision_at,
      updated_at
    FROM candidates
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY uploaded_at DESC
  `;
  const statement = db.prepare(sql);
  const rows = bindings.length
    ? await statement.bind(...bindings).all<Record<string, unknown>>()
    : await statement.all<Record<string, unknown>>();
  const candidates = rows.results.map(apiCandidate);
  return candidates;
}

function apiStatusToStoredStatus(value: unknown): string | null {
  const status = String(value ?? "").trim().toLowerCase();
  if (!status || status === "all") return null;
  return API_TO_STATUS[status] ?? "__INVALID_STATUS__";
}

async function getDashboard(db: D1Database, payload: Record<string, unknown>) {
  const requestedYear = Number(payload.year);
  const rows = await db
    .prepare(
      `SELECT
        c.*,
        r.total_rank,
        r.response_attitude_stage,
        r.job_requirement_low_items_json,
        r.finalized_at,
        COALESCE(open_reviews.open_review_count, 0) AS open_review_count
      FROM candidates c
      LEFT JOIN results r ON r.candidate_id = c.candidate_id
      LEFT JOIN (
        SELECT candidate_id, COUNT(*) AS open_review_count
        FROM review_queue
        WHERE status = 'OPEN'
        GROUP BY candidate_id
      ) open_reviews ON open_reviews.candidate_id = c.candidate_id
      ORDER BY c.test_date DESC, c.uploaded_at DESC`,
    )
    .all<Record<string, unknown>>();

  const allCandidates = rows.results;
  const availableYears = Array.from(
    new Set(
      allCandidates
        .map((row) => yearFromDate(row.test_date ?? row.uploaded_at ?? row.updated_at))
        .filter((year): year is number => Boolean(year)),
    ),
  ).sort((a, b) => b - a);
  const currentYear = new Date().getFullYear();
  const selectedYear = Number.isFinite(requestedYear) && requestedYear > 1900
    ? requestedYear
    : availableYears[0] ?? currentYear;

  const selected = allCandidates.filter((row) => yearFromDate(row.test_date ?? row.uploaded_at ?? row.updated_at) === selectedYear);
  const previousYearTotal = allCandidates.filter((row) => yearFromDate(row.test_date ?? row.uploaded_at ?? row.updated_at) === selectedYear - 1).length;

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
  const byRole: Record<string, number> = {};
  const byRank: Record<string, number> = {};
  const attentionItems: Record<string, number> = {};

  let hired = 0;
  let rejected = 0;
  let finalized = 0;
  let genderUnknown = 0;
  let openReviews = 0;
  let totalAttitudeStage = 0;
  let attitudeStageCount = 0;
  let lowRequirementCandidates = 0;

  for (const row of selected) {
    const candidate = apiCandidate(row);
    const month = monthFromDate(candidate.testDate || candidate.uploadedAt || candidate.updatedAt);
    const status = String(candidate.status || "uploaded");
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    const role = String(candidate.role ?? "").trim() || "未設定";
    byRole[role] = (byRole[role] ?? 0) + 1;

    const decision = normalizeDecision(row.hiring_decision);
    if (decision === "hire") hired += 1;
    if (decision === "reject") rejected += 1;
    if (status === "finalized") finalized += 1;
    if (row.total_rank) {
      const rank = String(row.total_rank);
      byRank[rank] = (byRank[rank] ?? 0) + 1;
    }
    openReviews += Number(row.open_review_count ?? 0);

    const attitudeStage = numberOrNull(row.response_attitude_stage);
    if (attitudeStage !== null) {
      totalAttitudeStage += attitudeStage;
      attitudeStageCount += 1;
    }

    const lowItems = jsonParse(String(row.job_requirement_low_items_json ?? "[]"), []);
    if (Array.isArray(lowItems) && lowItems.length > 0) {
      lowRequirementCandidates += 1;
      for (const item of lowItems) {
        const label = String(asRecord(item).label ?? "").trim() || "未分類";
        attentionItems[label] = (attentionItems[label] ?? 0) + 1;
      }
    }

    if (month) {
      const monthlyRow = monthly[month - 1];
      const gender = normalizeGenderForDashboard(candidate.gender);
      monthlyRow[gender] += 1;
      monthlyRow.total += 1;
      if (gender === "unknown") genderUnknown += 1;
      if (status === "finalized") monthlyRow.finalized += 1;
      if (status === "needs_review") monthlyRow.needsReview += 1;
      if (decision === "hire") monthlyRow.hired += 1;
      if (decision === "reject") monthlyRow.rejected += 1;
    }
  }

  for (const row of monthly) {
    const decided = row.hired + row.rejected;
    row.passRate = decided ? Math.round((row.hired / decided) * 100) : 0;
  }

  const total = selected.length;
  const decided = hired + rejected;
  const updatedAt = selected
    .map((row) => String(row.updated_at || row.uploaded_at || row.test_date || ""))
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? "";

  return {
    year: selectedYear,
    availableYears: availableYears.length ? availableYears : [selectedYear],
    generatedAt: nowIso(),
    updatedAt,
    dataSource: "CHEQ_DB candidates/results/review_queue",
    summary: {
      total,
      previousYearTotal,
      previousYearDiff: total - previousYearTotal,
      previousYearRate: previousYearTotal ? Math.round(((total - previousYearTotal) / previousYearTotal) * 100) : null,
      finalized,
      finalizedRate: total ? Math.round((finalized / total) * 100) : 0,
      hired,
      rejected,
      decided,
      passRate: decided ? Math.round((hired / decided) * 100) : 0,
      needsReview: byStatus.needs_review ?? 0,
      openReviews,
      genderUnknown,
      lowRequirementCandidates,
      averageAttitudeStage: attitudeStageCount ? Math.round((totalAttitudeStage / attitudeStageCount) * 10) / 10 : null,
    },
    monthly,
    statusBreakdown: Object.entries(byStatus).map(([status, value]) => ({ status, value })),
    roleBreakdown: Object.entries(byRole).map(([label, value]) => ({ label, value })).sort(sortBreakdown).slice(0, 8),
    decisionBreakdown: [
      { label: "合格", value: hired },
      { label: "不合格", value: rejected },
      { label: "未判定", value: Math.max(0, total - decided) },
    ],
    rankBreakdown: ["A", "B", "C", "D"].map((rank) => ({ rank, value: byRank[rank] ?? 0 })),
    attentionItems: Object.entries(attentionItems).map(([label, value]) => ({ label, value })).sort(sortBreakdown).slice(0, 8),
    recent: selected.slice(0, 10).map(apiCandidate),
  };
}

async function getCells(db: D1Database, candidateId: string) {
  const raw = await db.prepare("SELECT * FROM raw_cells WHERE candidate_id = ?").bind(candidateId).first<Record<string, unknown>>();
  if (!raw) throw new HttpError(404, "not_found", `Raw cells not found: ${candidateId}`);
  const reviewRows = await db
    .prepare("SELECT * FROM review_queue WHERE candidate_id = ? AND status != 'RESOLVED' ORDER BY cell_key")
    .bind(candidateId)
    .all<Record<string, unknown>>();
  const file = await db
    .prepare("SELECT content_type FROM candidate_files WHERE candidate_id = ? ORDER BY uploaded_at DESC LIMIT 1")
    .bind(candidateId)
    .first<Record<string, unknown>>();
  const storedCells = jsonParse(String(raw.cells_json ?? "{}"), defaultCells());
  const cells = Object.fromEntries(
    CELL_KEYS.map((key) => {
      const cell = asRecord(storedCells[key]);
      return [key, { value: numberOrNull(cell.value), confidence: numberOrNull(cell.confidence) ?? 1, reason: cell.reason ?? "" }];
    }),
  );
  const imageLinks = asRecord(jsonParse(String(raw.image_links_json ?? "{}"), {}));
  const mimeType = String(imageLinks.mimeType ?? imageLinks.contentType ?? file?.content_type ?? "").trim();
  return {
    cells,
    reviewQueue: reviewRows.results.map(stripInternal),
    imageLinks: mimeType ? { ...imageLinks, mimeType } : imageLinks,
  };
}

async function getResult(db: D1Database, candidateId: string) {
  const candidate = await getCandidate(db, candidateId);
  if (!candidate) throw new HttpError(404, "not_found", `Candidate not found: ${candidateId}`);
  const result = await db.prepare("SELECT * FROM results WHERE candidate_id = ?").bind(candidateId).first<Record<string, unknown>>();
  const raw = await db.prepare("SELECT * FROM raw_cells WHERE candidate_id = ?").bind(candidateId).first<Record<string, unknown>>();
  return {
    candidate: apiCandidate(candidate),
    result: result ? detailedResult(candidate, result) : null,
    rawCellSummary: raw ? {
      confidenceAvg: numberOrNull(raw.confidence_avg),
      unresolvedCount: numberOrNull(raw.unresolved_count),
      pageIndex: numberOrNull(raw.page_index),
      updatedAt: raw.updated_at,
    } : null,
    sourceUrl: candidate.source_url ?? "",
  };
}

const D1_FILE_MAX_BYTES = 1 * 1024 * 1024;
const GAS_DRIVE_FILE_MAX_BYTES = 9 * 1024 * 1024;
const D1_CHUNKED_FILE_MAX_BYTES = 9 * 1024 * 1024;
const FILE_CHUNK_BASE64_LENGTH = 256 * 1024;

async function registerCandidate(env: Env, context: Context) {
  const db = env.CHEQ_DB;
  const payload = context.payload;
  if (!payload.name) throw new HttpError(400, "validation", "name is required");
  if (!payload.testDate) throw new HttpError(400, "validation", "testDate is required");
  const candidateId = crypto.randomUUID();
  const createdAt = nowIso();
  const file = asRecord(payload.file);
  const preparedFile = await prepareCandidateFile(file, uploadMaxBytes(env));

  let storedFile: StoredFile | null = null;
  await db
    .prepare(
      "INSERT INTO candidates (candidate_id, name, test_date, gender, role, uploaded_at, status, source_url, memo, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(candidateId, payload.name, payload.testDate, normalizeGenderInput(payload.gender), payload.role ?? "", createdAt, "REVIEW_REQUIRED", "", payload.memo ?? "", createdAt)
    .run();
  try {
    storedFile = preparedFile
      ? await storeCandidateFile(env, candidateId, preparedFile, context.operator, createdAt, context.operationId)
      : null;
    const sourceUrl = storedFile ? storedFile.publicUrl || fileUrl(storedFile.fileId, storedFile.filename) : "";
    if (sourceUrl) {
      await db.prepare("UPDATE candidates SET source_url = ?, updated_at = ? WHERE candidate_id = ?").bind(sourceUrl, createdAt, candidateId).run();
    }
    await db
      .prepare("INSERT INTO raw_cells (candidate_id, cells_json, confidence_avg, unresolved_count, page_index, image_links_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(candidateId, JSON.stringify(defaultCells()), "", 80, "", storedFile ? JSON.stringify(imageLinksForFile(sourceUrl, storedFile.contentType)) : "{}", createdAt)
      .run();
    await insertOpenReviews(db, candidateId);
    const candidate = await getCandidate(db, candidateId);
    return { candidate: apiCandidate(candidate ?? {}) };
  } catch (error) {
    if (storedFile && env.CHEQ_FILES && storedFile.r2Key.startsWith("candidates/")) {
      await env.CHEQ_FILES.delete(storedFile.r2Key).catch(() => undefined);
    }
    await db.prepare("DELETE FROM candidates WHERE candidate_id = ?").bind(candidateId).run().catch(() => undefined);
    throw error;
  }
}

async function registerCandidateWithGasDrive(
  env: Env,
  context: Context,
  file: PreparedFile,
  createdAt: string,
) {
  if (!env.GAS_API_URL || !env.FUNCTIONS_GAS_SECRET) {
    throw new HttpError(400, "validation", "このサイズのファイル保存にはGoogle Drive連携が必要です");
  }

  const envelope = createEnvelope({
    action: "registerCandidate",
    operator: context.operator,
    role: context.role,
    operationId: context.operationId,
    payload: context.payload,
  });
  const gasResponse = await postToGas(env as GasEnv, envelope);
  const gasJson = await readJsonResponse(gasResponse);
  if (!gasResponse.ok || !isRecord(gasJson) || gasJson.ok === false) {
    const message = gasErrorMessage(gasJson) || `Google Drive保存に失敗しました: HTTP ${gasResponse.status}`;
    throw new HttpError(502, "upstream", message);
  }

  const gasCandidate = asRecord(asRecord(gasJson).candidate);
  const candidateId = String(gasCandidate.candidateId ?? "").trim();
  if (!candidateId) throw new HttpError(502, "upstream", "Google Drive保存結果にcandidateIdがありません");
  const sourceUrl = String(gasCandidate.sourceUrl ?? "").trim()
    || await fetchGasSourceUrl(env, context, candidateId);
  const db = env.CHEQ_DB;

  await db
    .prepare(
      "INSERT INTO candidates (candidate_id, name, test_date, gender, role, uploaded_at, status, source_url, memo, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      candidateId,
      context.payload.name,
      context.payload.testDate,
      normalizeGenderInput(context.payload.gender ?? gasCandidate.gender),
      context.payload.role ?? "",
      gasCandidate.uploadedAt ?? createdAt,
      "REVIEW_REQUIRED",
      sourceUrl,
      context.payload.memo ?? "",
      createdAt,
    )
    .run();

  await db
    .prepare(
      `INSERT INTO candidate_files (
        file_id, candidate_id, r2_key, filename, content_type, size_bytes,
        checksum_sha256, uploaded_by, uploaded_at, storage_kind, body_base64
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      candidateId,
      sourceUrl || `google-drive:${candidateId}`,
      file.filename,
      file.contentType,
      file.bytes.byteLength,
      await sha256Hex(file.bytes),
      context.operator,
      createdAt,
      "google_drive",
      "",
    )
    .run();

  await db
    .prepare("INSERT INTO raw_cells (candidate_id, cells_json, confidence_avg, unresolved_count, page_index, image_links_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(candidateId, JSON.stringify(defaultCells()), "", 80, "", sourceUrl ? JSON.stringify(imageLinksForFile(sourceUrl, file.contentType)) : "{}", createdAt)
    .run();
  await insertOpenReviews(db, candidateId);
  const candidate = await getCandidate(db, candidateId);
  return { candidate: apiCandidate(candidate ?? {}) };
}

async function fetchGasSourceUrl(env: Env, context: Context, candidateId: string): Promise<string> {
  if (!env.GAS_API_URL || !env.FUNCTIONS_GAS_SECRET) return "";
  const envelope = createEnvelope({
    action: "getResult",
    operator: context.operator,
    role: context.role,
    operationId: null,
    payload: { candidateId },
  });
  const response = await postToGas(env as GasEnv, envelope);
  if (!response.ok) return "";
  const body = await readJsonResponse(response);
  return typeof asRecord(body).sourceUrl === "string" ? String(asRecord(body).sourceUrl) : "";
}

type StoredFile = {
  fileId: string;
  filename: string;
  r2Key: string;
  contentType: string;
  size: number;
  checksumSha256: string;
  publicUrl?: string;
};

async function storeCandidateFile(
  env: Env,
  candidateId: string,
  file: PreparedFile,
  actor: string,
  createdAt: string,
  operationId: string | null,
): Promise<StoredFile | null> {
  const db = env.CHEQ_DB;
  const fileId = crypto.randomUUID();
  const checksumSha256 = await sha256Hex(file.bytes);
  if (shouldUseGasDrive(env, file)) {
    const sourceUrl = await saveFileToGasDrive(env, candidateId, file, actor, operationId);
    await db
      .prepare(
        `INSERT INTO candidate_files (
          file_id, candidate_id, r2_key, filename, content_type, size_bytes,
          checksum_sha256, uploaded_by, uploaded_at, storage_kind, body_base64
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        fileId,
        candidateId,
        sourceUrl,
        file.filename,
        file.contentType,
        file.bytes.byteLength,
        checksumSha256,
        actor,
        createdAt,
        "google_drive",
        "",
      )
      .run();
    return {
      fileId,
      filename: file.filename,
      r2Key: sourceUrl,
      contentType: file.contentType,
      size: file.bytes.byteLength,
      checksumSha256,
      publicUrl: sourceUrl,
    };
  }
  const r2Key = env.CHEQ_FILES
    ? `candidates/${candidateId}/${fileId}/${file.filename}`
    : `d1/${candidateId}/${fileId}/${file.filename}`;
  const bodyBase64 = env.CHEQ_FILES ? "" : bytesToBase64(file.bytes);
  const storageKind = env.CHEQ_FILES ? "r2" : bodyBase64.length > FILE_CHUNK_BASE64_LENGTH ? "d1_chunks" : "d1";
  if (env.CHEQ_FILES) {
    await env.CHEQ_FILES.put(r2Key, file.bytes, {
      httpMetadata: { contentType: file.contentType },
      customMetadata: {
        candidateId,
        fileId,
        checksumSha256,
        uploadedBy: actor,
      },
    });
  }

  await db
    .prepare(
      `INSERT INTO candidate_files (
        file_id, candidate_id, r2_key, filename, content_type, size_bytes,
        checksum_sha256, uploaded_by, uploaded_at, storage_kind, body_base64
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fileId,
      candidateId,
      r2Key,
      file.filename,
      file.contentType,
      file.bytes.byteLength,
      checksumSha256,
      actor,
      createdAt,
      storageKind,
      storageKind === "d1" ? bodyBase64 : "",
    )
    .run();
  if (storageKind === "d1_chunks") {
    await insertFileChunks(db, fileId, bodyBase64);
  }

  return {
    fileId,
    filename: file.filename,
    r2Key,
    contentType: file.contentType,
    size: file.bytes.byteLength,
    checksumSha256,
  };
}

async function saveFileToGasDrive(
  env: Env,
  candidateId: string,
  file: PreparedFile,
  actor: string,
  operationId: string | null,
): Promise<string> {
  if (!env.GAS_API_URL || !env.FUNCTIONS_GAS_SECRET) {
    throw new HttpError(400, "validation", "Google Drive連携が設定されていません");
  }
  const envelope = createEnvelope({
    action: "saveCandidateFile",
    operator: actor,
    role: "operator",
    operationId: `${operationId ?? candidateId}:drive-file`,
    payload: {
      candidateId,
      file: {
        name: file.filename,
        mimeType: file.contentType,
        size: file.bytes.byteLength,
        base64: bytesToBase64(file.bytes),
      },
    },
  });
  const response = await postToGas(env as GasEnv, envelope);
  const body = await readJsonResponse(response);
  if (!response.ok || !isRecord(body) || body.ok === false) {
    const message = gasErrorMessage(body) || `Google Drive保存に失敗しました: HTTP ${response.status}`;
    throw new HttpError(502, "upstream", message);
  }
  const sourceUrl = String(asRecord(body).sourceUrl ?? "").trim();
  if (!sourceUrl) throw new HttpError(502, "upstream", "Google Drive保存結果にURLがありません");
  return sourceUrl;
}

async function insertFileChunks(db: D1Database, fileId: string, bodyBase64: string) {
  const statements = [];
  for (let offset = 0, index = 0; offset < bodyBase64.length; offset += FILE_CHUNK_BASE64_LENGTH, index += 1) {
    statements.push(
      db
        .prepare("INSERT INTO candidate_file_chunks (file_id, chunk_index, body_base64) VALUES (?, ?, ?)")
        .bind(fileId, index, bodyBase64.slice(offset, offset + FILE_CHUNK_BASE64_LENGTH)),
    );
  }
  for (let index = 0; index < statements.length; index += 25) {
    await db.batch(statements.slice(index, index + 25));
  }
}

type PreparedFile = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
};

async function prepareCandidateFile(file: Record<string, unknown>, maxBytes: number): Promise<PreparedFile | null> {
  const filename = safeFilename(String(file.name ?? "").trim());
  const contentType = String(file.mimeType ?? file.contentType ?? "").trim();
  const base64 = String(file.base64 ?? "").trim();

  if (!filename && !base64) return null;
  if (!filename) throw new HttpError(400, "validation", "file.name is required");
  if (!base64) throw new HttpError(400, "validation", "file.base64 is required");
  if (!isAllowedUploadType(contentType)) {
    throw new HttpError(400, "validation", "file must be an image or PDF");
  }

  const bytes = base64ToBytes(base64);
  if (bytes.byteLength === 0) throw new HttpError(400, "validation", "file is empty");
  if (bytes.byteLength > maxBytes) {
    throw new HttpError(400, "validation", `file is too large; maximum is ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }

  return { filename, contentType, bytes };
}

async function saveCells(db: D1Database, candidateId: string, rawCells: unknown) {
  const current = await db.prepare("SELECT cells_json FROM raw_cells WHERE candidate_id = ?").bind(candidateId).first<{ cells_json: string }>();
  if (!current) throw new HttpError(404, "not_found", `Raw cells not found: ${candidateId}`);
  const nextCells = jsonParse(current.cells_json, defaultCells());
  const updates = asRecord(rawCells);
  for (const key of CELL_KEYS) {
    if (!(key in updates)) continue;
    const value = numberOrNull(updates[key]);
    nextCells[key] = { value, confidence: value === null ? 0 : 1, reason: value === null ? "blank" : "" };
    if (value !== null) {
      await db
        .prepare("UPDATE review_queue SET corrected_value = ?, status = 'RESOLVED', resolved_at = ? WHERE candidate_id = ? AND cell_key = ? AND status = 'OPEN'")
        .bind(value, nowIso(), candidateId, key)
        .run();
    }
  }
  const open = await db
    .prepare("SELECT COUNT(*) AS count FROM review_queue WHERE candidate_id = ? AND status = 'OPEN'")
    .bind(candidateId)
    .first<{ count: number }>();
  const unresolved = open?.count ?? 0;
  await db
    .prepare("UPDATE raw_cells SET cells_json = ?, unresolved_count = ?, updated_at = ? WHERE candidate_id = ?")
    .bind(JSON.stringify(nextCells), unresolved, nowIso(), candidateId)
    .run();
  await updateCandidateStatusValue(db, candidateId, unresolved > 0 ? "REVIEW_REQUIRED" : "READY_TO_FINALIZE");
  return { saved: true, unresolvedCount: unresolved };
}

async function updateStatus(db: D1Database, candidateId: string, status: string) {
  const stored = API_TO_STATUS[status];
  if (!stored) throw new HttpError(400, "validation", "status must be one of uploaded, recognizing, needs_review, scored, finalized");
  await updateCandidateStatusValue(db, candidateId, stored);
  const candidate = await getCandidate(db, candidateId);
  if (!candidate) throw new HttpError(404, "not_found", `Candidate not found: ${candidateId}`);
  return { candidate: apiCandidate(candidate) };
}

async function deleteCandidate(env: Env, candidateId: string, waitUntil?: (promise: Promise<unknown>) => void) {
  const db = env.CHEQ_DB;
  const candidate = await getCandidate(db, candidateId);
  if (!candidate) {
    return {
      deleted: true,
      candidateId,
      alreadyDeleted: true,
      filesDeleted: 0,
      filesFailed: 0,
    };
  }
  const files = await db
    .prepare("SELECT file_id, r2_key, storage_kind FROM candidate_files WHERE candidate_id = ?")
    .bind(candidateId)
    .all<{ file_id: string; r2_key: string; storage_kind?: string }>();
  await db.batch([
    db.prepare("DELETE FROM handwritten_totals WHERE candidate_id = ?").bind(candidateId),
    db.prepare("DELETE FROM candidates WHERE candidate_id = ?").bind(candidateId),
  ]);

  const r2Keys = files.results
    .filter((file) => (file.storage_kind ?? "r2") === "r2" && file.r2_key.startsWith("candidates/"))
    .map((file) => file.r2_key);
  if (env.CHEQ_FILES) {
    const cleanup = deleteR2Objects(env.CHEQ_FILES, r2Keys);
    if (waitUntil) waitUntil(cleanup);
    else await cleanup;
  }

  return {
    deleted: true,
    candidateId,
    candidate: apiCandidate(candidate),
    filesScheduledForDeletion: env.CHEQ_FILES ? r2Keys.length : 0,
  };
}

async function deleteR2Objects(bucket: R2Bucket, keys: string[]): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      try {
        await bucket.delete(key);
      } catch {
        // The DB row is already removed; stale R2 objects should not block the user-facing delete.
      }
    }),
  );
}

async function finalizeCandidate(db: D1Database, candidateId: string, actor: string) {
  const raw = await db.prepare("SELECT * FROM raw_cells WHERE candidate_id = ?").bind(candidateId).first<Record<string, unknown>>();
  if (!raw) throw new HttpError(404, "not_found", `Raw cells not found: ${candidateId}`);
  if (Number(raw.unresolved_count ?? 0) > 0) throw new HttpError(400, "validation", `Unresolved review items remain: ${raw.unresolved_count}`);
  const storedCells = jsonParse<Record<string, Record<string, unknown>>>(String(raw.cells_json ?? "{}"), {});
  const cells = Object.fromEntries(
    CELL_KEYS.map((key) => {
      const cell = asRecord(storedCells[key]);
      return [key, { value: numberOrNull(cell.value), confidence: numberOrNull(cell.confidence) ?? 1, reason: String(cell.reason ?? "") }];
    }),
  );
  const missing = CELL_KEYS.filter((key) => cells[key].value === null);
  if (missing.length) throw new HttpError(400, "validation", `Undecided cells remain: ${missing.slice(0, 10).join(", ")}`);
  const masters = await readMasters(db, candidateId);
  const scored = scoreCandidate(cells, masters, candidateId, actor);
  await upsertResult(db, scored.resultRow);
  await updateCandidateStatusValue(db, candidateId, "FINALIZED");
  return { result: apiResultFromRow(scored.resultRow) };
}

async function saveDecision(db: D1Database, candidateId: string, payload: Record<string, unknown>, actor: string) {
  const decisionMap: Record<string, string> = { hire: "PASSED", reject: "FAILED", hold: "" };
  const decision = decisionMap[String(payload.decision ?? "").trim().toLowerCase()];
  if (decision === undefined) throw new HttpError(400, "validation", "decision must be hire, reject, or hold");
  const employeeNumber = String(payload.employeeNumber ?? "").trim();
  if (decision !== "PASSED" && employeeNumber) throw new HttpError(400, "validation", "職員番号は合格時のみ登録できます");
  if (employeeNumber) {
    const duplicate = await db
      .prepare("SELECT candidate_id FROM candidates WHERE employee_number = ? AND candidate_id != ?")
      .bind(employeeNumber, candidateId)
      .first();
    if (duplicate) throw new HttpError(409, "conflict", `職員番号 ${employeeNumber} は既に別の候補者に登録されています`);
  }
  const decidedAt = nowIso();
  await db
    .prepare(
      "UPDATE candidates SET hiring_decision = ?, employee_number = ?, decision_by = ?, decision_at = ?, updated_at = ?, status = CASE WHEN ? = '' THEN status ELSE 'FINALIZED' END WHERE candidate_id = ?",
    )
    .bind(decision, decision === "PASSED" ? employeeNumber : "", actor, decidedAt, decidedAt, decision, candidateId)
    .run();
  const candidate = await getCandidate(db, candidateId);
  if (!candidate) throw new HttpError(404, "not_found", `Candidate not found: ${candidateId}`);
  return { candidate: apiCandidate(candidate) };
}

// ---- 総合評定（面接評価） ----

const EVALUATION_ITEM_KEYS = ["knowledge", "adaptability", "personality", "interest", "potential", "aptitude"];

type EvaluationItemRow = { key: string; score: number; comment: string };

async function listEvaluationMeta(db: D1Database) {
  const [items, evaluators] = await Promise.all([
    db.prepare("SELECT item_key, label, description, display_order FROM evaluation_item_master ORDER BY display_order").all<Record<string, unknown>>(),
    db.prepare("SELECT evaluator_id, name FROM evaluators WHERE active = 1 ORDER BY name").all<Record<string, unknown>>(),
  ]);
  return {
    items: items.results.map((row) => ({
      key: row.item_key ?? "",
      label: row.label ?? "",
      description: row.description ?? "",
      displayOrder: numberOrNull(row.display_order) ?? 0,
    })),
    evaluators: evaluators.results.map((row) => ({ evaluatorId: row.evaluator_id ?? "", name: row.name ?? "" })),
  };
}

async function listEvaluations(db: D1Database, candidateId: string) {
  // 候補者は本番では Sheets(scoring-api)管理で D1 には存在しない。candidate_id は参照キー
  // としてのみ扱い、D1 候補者行の存在は要求しない(無ければ空配列を返す)。
  const rows = await db
    .prepare("SELECT * FROM evaluations WHERE candidate_id = ? ORDER BY created_at DESC")
    .bind(candidateId)
    .all<Record<string, unknown>>();
  const itemsByEvaluation = await fetchEvaluationItems(db, rows.results.map((row) => String(row.evaluation_id)));
  return { evaluations: rows.results.map((row) => apiEvaluation(row, itemsByEvaluation[String(row.evaluation_id)] ?? [])) };
}

async function getEvaluation(db: D1Database, evaluationId: string) {
  const row = await db.prepare("SELECT * FROM evaluations WHERE evaluation_id = ?").bind(evaluationId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not_found", `Evaluation not found: ${evaluationId}`);
  const itemsByEvaluation = await fetchEvaluationItems(db, [evaluationId]);
  return { evaluation: apiEvaluation(row, itemsByEvaluation[evaluationId] ?? []) };
}

async function fetchEvaluationItems(db: D1Database, evaluationIds: string[]): Promise<Record<string, EvaluationItemRow[]>> {
  if (evaluationIds.length === 0) return {};
  const placeholders = evaluationIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(`SELECT evaluation_id, item_key, score, comment FROM evaluation_items WHERE evaluation_id IN (${placeholders})`)
    .bind(...evaluationIds)
    .all<Record<string, unknown>>();
  const grouped: Record<string, EvaluationItemRow[]> = {};
  for (const row of rows.results) {
    const id = String(row.evaluation_id);
    (grouped[id] ??= []).push({ key: String(row.item_key ?? ""), score: Number(row.score ?? 0), comment: String(row.comment ?? "") });
  }
  return grouped;
}

function apiEvaluation(row: Record<string, unknown>, items: EvaluationItemRow[]) {
  const ordered = EVALUATION_ITEM_KEYS
    .map((key) => items.find((item) => item.key === key))
    .filter((item): item is EvaluationItemRow => Boolean(item));
  return {
    evaluationId: row.evaluation_id ?? "",
    candidateId: row.candidate_id ?? "",
    evaluatorName: row.evaluator_name ?? "",
    evalDate: row.eval_date ?? "",
    jobRole: row.job_role ?? "",
    totalScore: numberOrNull(row.total_score) ?? 0,
    overallComment: row.overall_comment ?? "",
    items: ordered,
    createdBy: row.created_by ?? "",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

async function registerEvaluator(db: D1Database, payload: Record<string, unknown>) {
  const name = String(payload.name ?? "").trim();
  if (!name) throw new HttpError(400, "validation", "評価者名を入力してください");
  if (name.length > 100) throw new HttpError(400, "validation", "評価者名が長すぎます");
  const existing = await db.prepare("SELECT evaluator_id, name FROM evaluators WHERE name = ?").bind(name).first<Record<string, unknown>>();
  if (existing) {
    return { evaluator: { evaluatorId: existing.evaluator_id ?? "", name: existing.name ?? name }, alreadyExists: true };
  }
  const evaluatorId = crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO evaluators (evaluator_id, name, email, active) VALUES (?, ?, '', 1)").bind(evaluatorId, name).run();
  return { evaluator: { evaluatorId, name } };
}

async function saveEvaluation(db: D1Database, context: Context) {
  const payload = context.payload;
  const candidateId = requireCandidateId(payload);
  // 候補者は本番では Sheets(scoring-api)管理で D1 には存在しない。candidate_id は参照キー
  // としてのみ保存し、D1 候補者行の存在は要求しない。
  const evaluatorName = String(payload.evaluatorName ?? "").trim();
  if (!evaluatorName) throw new HttpError(400, "validation", "評価者名を入力してください");
  const items = normalizeEvaluationItems(payload.items);
  const total = items.reduce((sum, item) => sum + item.score, 0);
  const evalDate = String(payload.evalDate ?? "").trim();
  const jobRole = String(payload.jobRole ?? "").trim();
  const overallComment = String(payload.overallComment ?? "");
  const requestedId = String(payload.evaluationId ?? "").trim();
  const now = nowIso();

  let evaluationId = requestedId;
  if (requestedId) {
    const existing = await db.prepare("SELECT candidate_id FROM evaluations WHERE evaluation_id = ?").bind(requestedId).first<Record<string, unknown>>();
    if (!existing) throw new HttpError(404, "not_found", `Evaluation not found: ${requestedId}`);
    if (String(existing.candidate_id) !== candidateId) throw new HttpError(400, "validation", "candidateId does not match the evaluation");
    await db
      .prepare("UPDATE evaluations SET evaluator_name = ?, eval_date = ?, job_role = ?, total_score = ?, overall_comment = ?, updated_at = ? WHERE evaluation_id = ?")
      .bind(evaluatorName, evalDate, jobRole, total, overallComment, now, requestedId)
      .run();
    await db.prepare("DELETE FROM evaluation_items WHERE evaluation_id = ?").bind(requestedId).run();
  } else {
    evaluationId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO evaluations (evaluation_id, candidate_id, evaluator_name, evaluator_email, eval_date, job_role, total_score, overall_comment, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(evaluationId, candidateId, evaluatorName, "", evalDate, jobRole, total, overallComment, context.operator, now, now)
      .run();
  }
  await db.batch(
    items.map((item) =>
      db.prepare("INSERT INTO evaluation_items (evaluation_id, item_key, score, comment) VALUES (?, ?, ?, ?)").bind(evaluationId, item.key, item.score, item.comment),
    ),
  );
  const row = await db.prepare("SELECT * FROM evaluations WHERE evaluation_id = ?").bind(evaluationId).first<Record<string, unknown>>();
  const itemsByEvaluation = await fetchEvaluationItems(db, [evaluationId]);
  return { evaluation: apiEvaluation(row ?? {}, itemsByEvaluation[evaluationId] ?? []) };
}

function normalizeEvaluationItems(value: unknown): EvaluationItemRow[] {
  if (!Array.isArray(value)) throw new HttpError(400, "validation", "items is required");
  const map = new Map<string, EvaluationItemRow>();
  for (const entry of value) {
    const record = asRecord(entry);
    const key = String(record.key ?? "").trim();
    if (!EVALUATION_ITEM_KEYS.includes(key)) continue;
    const score = Number(record.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new HttpError(400, "validation", `評価点は1〜5で入力してください (${key})`);
    }
    map.set(key, { key, score, comment: String(record.comment ?? "") });
  }
  return EVALUATION_ITEM_KEYS.map((key) => {
    const found = map.get(key);
    if (!found) throw new HttpError(400, "validation", `評価要素 ${key} の点数が未入力です`);
    return found;
  });
}

async function deleteEvaluation(db: D1Database, payload: Record<string, unknown>) {
  const evaluationId = requireEvaluationId(payload);
  const existing = await db.prepare("SELECT candidate_id FROM evaluations WHERE evaluation_id = ?").bind(evaluationId).first<Record<string, unknown>>();
  if (!existing) return { deleted: true, evaluationId, alreadyDeleted: true };
  await db.prepare("DELETE FROM evaluation_items WHERE evaluation_id = ?").bind(evaluationId).run();
  await db.prepare("DELETE FROM evaluations WHERE evaluation_id = ?").bind(evaluationId).run();
  return { deleted: true, evaluationId, candidateId: existing.candidate_id ?? "" };
}

function requireEvaluationId(payload: Record<string, unknown>) {
  const evaluationId = String(payload.evaluationId ?? "").trim();
  if (!evaluationId) throw new HttpError(400, "validation", "evaluationId is required");
  return evaluationId;
}

async function readMasters(db: D1Database, candidateId: string): Promise<MasterRows> {
  const [itemMaster, scoreBands, handwrittenTotals] = await Promise.all([
    db.prepare("SELECT * FROM item_master ORDER BY display_order").all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM score_bands ORDER BY item_key, min_score").all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM handwritten_totals WHERE candidate_id = ?").bind(candidateId).all<Record<string, unknown>>(),
  ]);
  return {
    itemMaster: itemMaster.results,
    scoreBands: scoreBands.results,
    handwrittenTotals: handwrittenTotals.results,
  };
}

async function insertOpenReviews(db: D1Database, candidateId: string) {
  await db.batch(
    CELL_KEYS.map((key) =>
      db
        .prepare("INSERT INTO review_queue (review_id, candidate_id, cell_key, detected, reason, confidence, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), candidateId, key, "", "manual_entry_required", 0, "OPEN"),
    ),
  );
}

async function upsertResult(db: D1Database, row: Record<string, unknown>) {
  await db
    .prepare(
      `INSERT INTO results (
        candidate_id, total_rank, response_attitude_stage, minus_points, attitude_minus_points,
        job_requirement_minus_points, job_requirement_low_items_json, row_scores_json,
        item_totals_json, item_stages_json, cross_check_json, notes, finalized_by, finalized_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        total_rank = excluded.total_rank,
        response_attitude_stage = excluded.response_attitude_stage,
        minus_points = excluded.minus_points,
        attitude_minus_points = excluded.attitude_minus_points,
        job_requirement_minus_points = excluded.job_requirement_minus_points,
        job_requirement_low_items_json = excluded.job_requirement_low_items_json,
        row_scores_json = excluded.row_scores_json,
        item_totals_json = excluded.item_totals_json,
        item_stages_json = excluded.item_stages_json,
        cross_check_json = excluded.cross_check_json,
        notes = excluded.notes,
        finalized_by = excluded.finalized_by,
        finalized_at = excluded.finalized_at,
        status = excluded.status`,
    )
    .bind(
      row.candidate_id,
      row.total_rank,
      row.response_attitude_stage,
      row.minus_points,
      row.attitude_minus_points,
      row.job_requirement_minus_points,
      row.job_requirement_low_items_json,
      row.row_scores_json,
      row.item_totals_json,
      row.item_stages_json,
      row.cross_check_json,
      row.notes,
      row.finalized_by,
      row.finalized_at,
      row.status,
    )
    .run();
}

async function getCandidate(db: D1Database, candidateId: string) {
  return db.prepare("SELECT * FROM candidates WHERE candidate_id = ?").bind(candidateId).first<Record<string, unknown>>();
}

async function updateCandidateStatusValue(db: D1Database, candidateId: string, status: string) {
  await db.prepare("UPDATE candidates SET status = ?, updated_at = ? WHERE candidate_id = ?").bind(status, nowIso(), candidateId).run();
}

function apiCandidate(row: Record<string, unknown>) {
  return {
    candidateId: row.candidate_id ?? "",
    name: row.name ?? "",
    testDate: row.test_date ?? "",
    gender: row.gender ?? "",
    role: row.role ?? "",
    status: STATUS_TO_API[String(row.status ?? "").toUpperCase()] ?? String(row.status ?? "").toLowerCase(),
    uploadedAt: row.uploaded_at ?? "",
    decision: normalizeDecision(row.hiring_decision),
    employeeNumber: row.employee_number ?? "",
    decisionBy: row.decision_by ?? "",
    decisionAt: row.decision_at ?? "",
    memo: row.memo ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

function normalizeGenderInput(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["male", "female", "other"].includes(normalized)) return normalized;
  return "";
}

function detailedResult(candidate: Record<string, unknown>, result: Record<string, unknown>) {
  return {
    candidateId: candidate.candidate_id ?? result.candidate_id ?? "",
    totalRank: result.total_rank ?? "",
    responseAttitudeStage: numberOrNull(result.response_attitude_stage),
    attitudeMinusPoints: Number(result.attitude_minus_points ?? 0),
    jobRequirementMinusPoints: Number(result.job_requirement_minus_points ?? result.minus_points ?? 0),
    jobRequirementLowItems: jsonParse(String(result.job_requirement_low_items_json ?? "[]"), []),
    items: resultItems(jsonParse(String(result.item_totals_json ?? "{}"), {}), jsonParse(String(result.item_stages_json ?? "{}"), {})),
    crossCheck: jsonParse(String(result.cross_check_json ?? "[]"), []),
    notes: result.notes ?? "",
    finalizedBy: result.finalized_by ?? "",
    finalizedAt: result.finalized_at ?? "",
    status: STATUS_TO_API[String(result.status ?? candidate.status ?? "").toUpperCase()] ?? "finalized",
  };
}

function resultItems(itemTotals: Record<string, unknown>, itemStages: Record<string, unknown>) {
  const defaults = [
    ["self_control", "①セルフコントロール"], ["communication", "②コミュニケーション"], ["situation", "③状況認識力"],
    ["stress", "④ストレス対処力"], ["proactivity", "⑤積極性"], ["goal", "⑥目標達成力"], ["positive", "⑦ポジティブ思考力"],
    ["teamwork", "⑧チームワーク"], ["hospitality", "⑨ホスピタリティー"], ["attitude", "応答態度"],
  ];
  return defaults.map(([key, label]) => ({
    key,
    label,
    total: numberOrNull(itemTotals[label] ?? itemTotals[key]),
    stage: numberOrNull(itemStages[label] ?? itemStages[key]),
    isJobRequirement: ["⑤", "⑥", "⑦", "⑧", "⑨"].includes(label.slice(0, 1)),
    isAttitude: key === "attitude",
  }));
}

function apiResultFromRow(row: Record<string, unknown>) {
  return {
    candidateId: row.candidate_id ?? "",
    totalRank: row.total_rank ?? "",
    responseAttitudeStage: numberOrNull(row.response_attitude_stage),
    minusPoints: numberOrNull(row.minus_points),
    attitudeMinusPoints: numberOrNull(row.attitude_minus_points),
    jobRequirementMinusPoints: numberOrNull(row.job_requirement_minus_points),
    finalizedBy: row.finalized_by ?? "",
    finalizedAt: row.finalized_at ?? "",
    notes: row.notes ?? "",
  };
}

async function appendAudit(db: D1Database, context: Context, result: Record<string, unknown>) {
  await db
    .prepare("INSERT INTO audit_log (logged_at, actor, action, candidate_id, detail_json, operation_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(nowIso(), context.operator, context.action, candidateIdFromResult(context.payload, result), JSON.stringify(auditDetail(context, result)), context.operationId ?? "")
    .run();
}

function auditDetail(context: Context, result: Record<string, unknown>) {
  if (context.action !== "exportBackup") return result;
  const backup = asRecord(result.backup);
  const sheets = Array.isArray(backup.sheets) ? backup.sheets.map((sheet) => {
    const item = asRecord(sheet);
    return { name: item.name, table: item.table, rowCount: item.rowCount };
  }) : [];
  return {
    backup: {
      schemaVersion: backup.schemaVersion,
      exportedAt: backup.exportedAt,
      sheets,
    },
  };
}

function normalizeDecision(value: unknown) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "PASSED") return "hire";
  if (normalized === "FAILED") return "reject";
  return normalized ? normalized.toLowerCase() : undefined;
}

function operationIdFrom(payload: Record<string, unknown>) {
  const value = payload.operationId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireCandidateId(payload: Record<string, unknown>) {
  const candidateId = candidateIdFromPayload(payload);
  if (!candidateId) throw new HttpError(400, "validation", "candidateId is required");
  return candidateId;
}

function candidateIdFromPayload(payload: Record<string, unknown>) {
  return String(payload.candidateId ?? "").trim();
}

function candidateIdFromResult(payload: Record<string, unknown>, result: Record<string, unknown>) {
  const resultCandidate = asRecord(result.candidate).candidateId ?? asRecord(result.result).candidateId;
  return candidateIdFromPayload(payload) || String(resultCandidate ?? "");
}

function stripInternal(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("_")));
}

function normalizeEmail(email: unknown) {
  return String(email ?? "").trim().toLowerCase();
}

function normalizeGenderForDashboard(value: unknown): "male" | "female" | "other" | "unknown" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["male", "m", "man", "men", "男性", "男"].includes(normalized)) return "male";
  if (["female", "f", "woman", "women", "女性", "女"].includes(normalized)) return "female";
  if (["other", "その他", "回答しない", "非回答"].includes(normalized)) return "other";
  return "unknown";
}

function yearFromDate(value: unknown): number | null {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date.getFullYear();
}

function monthFromDate(value: unknown): number | null {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date.getMonth() + 1;
}

function sortBreakdown(a: { label?: string; value: number }, b: { label?: string; value: number }) {
  return b.value - a.value || String(a.label ?? "").localeCompare(String(b.label ?? ""), "ja");
}

function nowIso() {
  return new Date().toISOString();
}

function numberOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function jsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uploadMaxBytes(env: Env): number {
  if (env.CHEQ_FILES) return 15 * 1024 * 1024;
  if (env.GAS_API_URL && env.FUNCTIONS_GAS_SECRET) return GAS_DRIVE_FILE_MAX_BYTES;
  return D1_CHUNKED_FILE_MAX_BYTES;
}

function shouldUseGasDrive(env: Env, file: PreparedFile): boolean {
  return !env.CHEQ_FILES
    && Boolean(env.GAS_API_URL && env.FUNCTIONS_GAS_SECRET)
    && file.bytes.byteLength <= GAS_DRIVE_FILE_MAX_BYTES;
}

function gasErrorMessage(value: unknown): string {
  const record = asRecord(value);
  const error = record.error;
  if (typeof error === "string") return error;
  const errorRecord = asRecord(error);
  return typeof errorRecord.message === "string" ? errorRecord.message : "";
}

function fileUrl(fileId: string, filename: string): string {
  return `/files/${encodeURIComponent(fileId)}/${encodeURIComponent(filename)}`;
}

function imageLinksForFile(sourceUrl: string, contentType: string) {
  return {
    original: sourceUrl,
    preview: sourceUrl,
    pages: [sourceUrl],
    mimeType: contentType,
  };
}

function safeFilename(value: string): string {
  const normalized = value
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 180) || "scoresheet";
}

function isAllowedUploadType(contentType: string): boolean {
  return contentType === "application/pdf" || contentType.startsWith("image/");
}

function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new HttpError(400, "validation", "file.base64 is invalid");
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
