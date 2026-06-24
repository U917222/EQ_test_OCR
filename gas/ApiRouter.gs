const API_SIGNATURE_HEADER = 'X-Signature';
const API_TIMESTAMP_HEADER = 'X-Timestamp';
const API_NONCE_HEADER = 'X-Nonce';
const API_SIGNATURE_PREFIX = 'sha256=';
const API_AUDIENCE = 'gas-api';
const API_MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const API_NONCE_TTL_SECONDS = 10 * 60;
const API_OPERATION_TTL_SECONDS = 30 * 24 * 60 * 60;

const API_WRITE_ACTIONS = {
  registerCandidate: true,
  saveCandidateFile: true,
  saveCells: true,
  updateStatus: true,
  deleteCandidate: true,
  finalize: true,
  saveDecision: true,
};

const API_REQUIRED_ROLES = {
  me: 'operator',
  listCandidates: 'operator',
  getDashboard: 'operator',
  getCells: 'operator',
  saveCells: 'operator',
  registerCandidate: 'operator',
  saveCandidateFile: 'operator',
  getResult: 'operator',
  updateStatus: 'operator',
  deleteCandidate: 'operator',
  finalize: 'reviewer',
  saveDecision: 'reviewer',
  getResultPdf: 'reviewer',
};

const API_ROLE_RANK = {
  operator: 1,
  reviewer: 2,
  admin: 3,
};

function dispatchApiRequest_(event, bodyText, envelope) {
  const startedAt = new Date();
  let context = null;

  try {
    context = verifyApiEnvelope_(event, envelope);
    const responsePayload = executeApiAction_(context);
    apiAppendAudit_(context, responsePayload, startedAt);
    return jsonResponse_(apiSerialize_({ ok: true, ...responsePayload }));
  } catch (error) {
    const apiError = normalizeApiError_(error);
    if (context || (envelope && envelope.claims)) {
      apiAppendAudit_(context || apiContextFromUntrustedClaims_(envelope.claims), {
        error: apiError.code,
      }, startedAt);
    }
    return jsonResponse_({
      ok: false,
      error: {
        code: apiError.code,
        message: apiError.message,
      },
    });
  }
}

function verifyApiEnvelope_(event, envelope) {
  if (!envelope || typeof envelope !== 'object') throw apiError_('validation', 'Request envelope is required');
  const claims = envelope.claims;
  const payload = envelope.payload || {};
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw apiError_('validation', 'claims is required');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw apiError_('validation', 'payload must be an object');
  }

  assertApiSignature_(event, claims, payload);
  assertApiTimestamp_(event, claims);
  assertApiNonceUnused_(event, claims);
  assertApiAudienceAndAction_(event, claims, payload);

  const user = resolveApiUser_(claims.operator);
  assertApiAuthorized_(claims.action, user.role);

  return {
    claims,
    payload,
    action: String(claims.action || ''),
    operator: normalizeEmail_(claims.operator),
    role: user.role,
    operationId: apiOperationId_(claims, payload),
  };
}

function executeApiAction_(context) {
  if (API_WRITE_ACTIONS[context.action]) {
    return executeApiWriteAction_(context);
  }
  return handleApiAction_(context);
}

function executeApiWriteAction_(context) {
  if (!context.operationId) throw apiError_('validation', 'operationId is required');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getWorkbook_();
    cleanupApiOperations_(ss);

    const existing = findApiOperation_(ss, context.operationId);
    if (existing) {
      if (String(existing.action || '') !== context.action) {
        throw apiError_('conflict', 'operationId was already used for a different action');
      }
      const requestedCandidateId = apiCandidateIdFromPayload_(context.payload);
      if (existing.candidate_id && requestedCandidateId && String(existing.candidate_id) !== requestedCandidateId) {
        throw apiError_('conflict', 'operationId was already used for a different candidate');
      }
      const replay = safeJsonParse_(existing.result_json, {});
      return { idempotentReplay: true, ...replay };
    }

    const result = handleApiAction_(context);
    recordApiOperation_(ss, context, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function handleApiAction_(context) {
  switch (context.action) {
    case 'me':
      return { email: context.operator, role: context.role };
    case 'listCandidates':
      return handleApiListCandidates_(context.payload);
    case 'getDashboard':
      return handleApiGetDashboard_();
    case 'getCells':
      return handleApiGetCells_(context.payload);
    case 'getResult':
      return handleApiGetResult_(context.payload);
    case 'registerCandidate':
      return handleApiRegisterCandidate_(context.payload);
    case 'saveCandidateFile':
      return handleApiSaveCandidateFile_(context.payload);
    case 'saveCells':
      return handleApiSaveCells_(context.payload);
    case 'updateStatus':
      return handleApiUpdateStatus_(context.payload);
    case 'deleteCandidate':
      return handleApiDeleteCandidate_(context.payload);
    case 'finalize':
      return handleApiFinalize_(context.payload);
    case 'getResultPdf':
      return handleApiGetResultPdf_(context.payload);
    case 'saveDecision':
      return handleApiSaveDecision_(context.payload);
    default:
      throw apiError_('validation', `Unsupported action: ${context.action}`);
  }
}

function handleApiListCandidates_(payload) {
  const search = String(payload.search || '').trim().toLowerCase();
  const status = String(payload.status || '').trim().toLowerCase();
  const candidates = getCandidatesInternal_()
    .map(apiCandidateFromRow_)
    .filter((candidate) => !search || (
      String(candidate.name || '').toLowerCase().includes(search)
        || String(candidate.candidateId || '').toLowerCase().includes(search)
    ))
    .filter((candidate) => !status || candidate.status === status);
  return { candidates };
}

function handleApiGetDashboard_() {
  assertWorkbookReady_();
  const ss = getWorkbook_();
  const candidates = readObjects_(ss.getSheetByName(SHEETS.candidates)).map(apiCandidateFromRow_);
  const reviewRows = readObjects_(ss.getSheetByName(SHEETS.reviewQueue));
  const results = readObjects_(ss.getSheetByName(SHEETS.results));
  const byStatus = {};
  candidates.forEach((candidate) => {
    byStatus[candidate.status] = (byStatus[candidate.status] || 0) + 1;
  });
  const recent = candidates
    .slice()
    .sort((a, b) => apiDateSortValue_(b.uploadedAt) - apiDateSortValue_(a.uploadedAt))
    .slice(0, 10);

  return {
    stats: {
      totalCandidates: candidates.length,
      byStatus,
      openReviews: reviewRows.filter((row) => row.status === 'OPEN').length,
      finalized: results.length,
    },
    recent,
  };
}

function handleApiGetCells_(payload) {
  const candidateId = requireApiCandidateId_(payload);
  const data = getCandidateCells(candidateId);
  const reviewQueue = getReviewQueueInternal_(candidateId);
  const imageLinks = {};
  reviewQueue.forEach((item) => {
    if (item.cell_key && item.image_link) imageLinks[item.cell_key] = item.image_link;
  });
  return {
    cells: data.cells || {},
    reviewQueue,
    imageLinks,
  };
}

function handleApiGetResult_(payload) {
  const candidateId = requireApiCandidateId_(payload);
  const dashboard = getDashboardDataInternal_(candidateId);
  if (!dashboard.candidate) throw apiError_('not_found', `Candidate not found: ${candidateId}`);
  return apiGetResultResponseFromDashboard_(dashboard);
}

function handleApiRegisterCandidate_(payload) {
  validateRequired_(payload, ['name', 'testDate']);
  const registered = registerCandidate({
    name: payload.name,
    testDate: payload.testDate,
    role: payload.role || '',
    memo: payload.memo || '',
    file: payload.file || null,
  });
  const candidateId = registered.candidateId;
  const candidate = apiReadCandidate_(candidateId);
  return { candidate: { ...candidate, sourceUrl: registered.sourceUrl || '' } };
}

function handleApiSaveCandidateFile_(payload) {
  const candidateId = requireApiCandidateId_(payload);
  if (!payload.file || typeof payload.file !== 'object') throw apiError_('validation', 'file is required');
  const sourceUrl = saveUploadedFile_(candidateId, payload.file);
  return { candidateId, sourceUrl };
}

function handleApiSaveCells_(payload) {
  const candidateId = requireApiCandidateId_(payload);
  const cells = normalizeApiCells_(payload.cells);
  const result = overrideCellValues(candidateId, cells);
  return {
    saved: true,
    unresolvedCount: result.unresolvedCount,
  };
}

function handleApiFinalize_(payload) {
  const candidateId = requireApiCandidateId_(payload);
  const dashboard = calculateCandidateResultInternal_(candidateId);
  return { result: apiResultFromDashboard_(dashboard) };
}

function handleApiGetResultPdf_(payload) {
  const candidateId = requireApiCandidateId_(payload);
  const pdf = downloadCandidateResultPdf(candidateId);
  return {
    filename: pdf.fileName || pdf.filename || `CHEQ_${candidateId}.pdf`,
    mimeType: pdf.mimeType,
    base64: pdf.base64,
  };
}

function handleApiUpdateStatus_(payload) {
  const candidateId = requireApiCandidateId_(payload);
  const requested = String(payload.status || '').trim().toLowerCase();
  // フロント(api status) → 内部ステータス。apiNormalizeCandidateStatus_ の逆写像。
  const statusMap = {
    uploaded: 'UPLOADED',
    recognizing: 'PROCESSING',
    needs_review: 'REVIEW_REQUIRED',
    scored: 'READY_TO_FINALIZE',
    finalized: 'FINALIZED',
  };
  if (!Object.prototype.hasOwnProperty.call(statusMap, requested)) {
    throw apiError_('validation', 'status must be one of uploaded, recognizing, needs_review, scored, finalized');
  }
  updateCandidateStatus_(getWorkbook_(), candidateId, statusMap[requested]);
  return { candidate: apiReadCandidate_(candidateId) };
}

function handleApiDeleteCandidate_(payload) {
  const candidateId = requireApiCandidateId_(payload);
  const ss = getWorkbook_();
  const candidate = findById_(ss.getSheetByName(SHEETS.candidates), 'candidate_id', candidateId);
  if (!candidate) {
    return {
      deleted: true,
      candidateId,
      alreadyDeleted: true,
      rowsDeleted: {},
    };
  }

  const rowsDeleted = {
    reviewQueue: deleteApiRowsByCandidateId_(ss.getSheetByName(SHEETS.reviewQueue), candidateId),
    rawCells: deleteApiRowsByCandidateId_(ss.getSheetByName(SHEETS.rawCells), candidateId),
    results: deleteApiRowsByCandidateId_(ss.getSheetByName(SHEETS.results), candidateId),
    handwrittenTotals: deleteApiRowsByCandidateId_(ss.getSheetByName(SHEETS.handwrittenTotals), candidateId),
    candidates: deleteApiRowsByCandidateId_(ss.getSheetByName(SHEETS.candidates), candidateId),
  };

  return {
    deleted: true,
    candidateId,
    candidate: apiCandidateFromRow_(candidate),
    rowsDeleted,
  };
}

function handleApiSaveDecision_(payload) {
  const candidateId = requireApiCandidateId_(payload);
  const apiDecision = String(payload.decision || '').trim().toLowerCase();
  const decisionMap = {
    hire: 'PASSED',
    reject: 'FAILED',
    hold: '',
  };
  if (!Object.prototype.hasOwnProperty.call(decisionMap, apiDecision)) {
    throw apiError_('validation', 'decision must be hire, reject, or hold');
  }
  registerHiringDecision(candidateId, decisionMap[apiDecision], payload.employeeNumber || '');
  return { candidate: apiReadCandidate_(candidateId) };
}

function deleteApiRowsByCandidateId_(sheet, candidateId) {
  return deleteApiRowsByHeaderValue_(sheet, 'candidate_id', candidateId);
}

function deleteApiRowsByHeaderValue_(sheet, headerName, value) {
  const table = readTable_(sheet);
  const originalLength = table.rows.length;
  const keptRows = table.rows.filter((row) => String(row[headerName] || '') !== String(value));
  const deleted = originalLength - keptRows.length;
  if (deleted === 0) return 0;

  const values = [table.headers].concat(
    keptRows.map((row) => table.headers.map((header) => (
      sanitizeSheetValue_(row[header] === undefined ? '' : row[header])
    )))
  );
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, table.headers.length).setValues(values);
  return deleted;
}

function assertApiSignature_(event, claims, payload) {
  const secret = getScriptProperty_(SCRIPT_PROPERTY_KEYS.functionsGasSecret);
  if (!secret) throw apiError_('unauthorized', 'FUNCTIONS_GAS_SECRET is not configured');

  const signature = getApiRequestParam_(event, API_SIGNATURE_HEADER);
  if (!signature) throw apiError_('unauthorized', 'Missing signature');

  const signed = `${canonicalJson_(claims)}.${canonicalJson_(payload)}`;
  const expected = `${API_SIGNATURE_PREFIX}${hmacSha256Hex_(signed, secret)}`;
  if (!constantTimeEqual_(signature, expected)) {
    throw apiError_('unauthorized', 'Invalid signature');
  }
}

function assertApiTimestamp_(event, claims) {
  const ts = Number(claims.ts);
  if (!Number.isFinite(ts)) throw apiError_('unauthorized', 'Invalid timestamp');
  const headerTs = getApiRequestParam_(event, API_TIMESTAMP_HEADER);
  if (headerTs && String(headerTs) !== String(claims.ts)) {
    throw apiError_('unauthorized', 'Timestamp mismatch');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > API_MAX_CLOCK_SKEW_SECONDS) {
    throw apiError_('unauthorized', 'Timestamp expired');
  }
}

function assertApiNonceUnused_(event, claims) {
  const nonce = String(claims.nonce || '').trim();
  if (!nonce) throw apiError_('unauthorized', 'Missing nonce');
  const headerNonce = getApiRequestParam_(event, API_NONCE_HEADER);
  if (headerNonce && String(headerNonce) !== nonce) {
    throw apiError_('unauthorized', 'Nonce mismatch');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getWorkbook_();
    cleanupApiNonces_(ss);
    const sheet = ss.getSheetByName(SHEETS.apiNonces);
    const exists = readObjects_(sheet).some((row) => String(row.nonce || '') === nonce);
    if (exists) throw apiError_('unauthorized', 'Nonce already used');
    appendObject_(sheet, {
      nonce,
      ts: Number(claims.ts),
    });
  } finally {
    lock.releaseLock();
  }
}

function assertApiAudienceAndAction_(event, claims, payload) {
  if (String(claims.aud || '') !== API_AUDIENCE) throw apiError_('unauthorized', 'Invalid audience');

  const action = String(claims.action || '').trim();
  if (!action || !API_REQUIRED_ROLES[action]) throw apiError_('validation', `Unsupported action: ${action}`);

  const routeAction = getApiRequestParam_(event, 'action');
  if (routeAction && routeAction !== action) throw apiError_('unauthorized', 'Action mismatch');
  if (payload.action && String(payload.action) !== action) throw apiError_('unauthorized', 'Action mismatch');

  const operationId = apiOperationId_(claims, payload);
  if (claims.operationId && payload.operationId && String(claims.operationId) !== String(payload.operationId)) {
    throw apiError_('unauthorized', 'operationId mismatch');
  }
  if (API_WRITE_ACTIONS[action] && !operationId) {
    throw apiError_('validation', 'operationId is required');
  }
}

function resolveApiUser_(email) {
  const normalized = normalizeEmail_(email);
  if (!normalized) throw apiError_('forbidden', 'operator is required');

  assertWorkbookReady_();
  const rows = readObjects_(getWorkbook_().getSheetByName(SHEETS.users));
  const user = rows.find((row) => normalizeEmail_(row.email) === normalized);
  if (!user || !apiParseBoolean_(user.active)) throw apiError_('forbidden', 'User is not active');

  const role = String(user.role || '').trim().toLowerCase();
  if (!API_ROLE_RANK[role]) throw apiError_('forbidden', 'User role is invalid');
  return { email: normalized, role };
}

function assertApiAuthorized_(action, role) {
  const required = API_REQUIRED_ROLES[action];
  if (!required || !API_ROLE_RANK[role] || API_ROLE_RANK[role] < API_ROLE_RANK[required]) {
    throw apiError_('forbidden', 'Insufficient role');
  }
}

function apiReadCandidate_(candidateId) {
  const row = findById_(getWorkbook_().getSheetByName(SHEETS.candidates), 'candidate_id', candidateId);
  if (!row) throw apiError_('not_found', `Candidate not found: ${candidateId}`);
  return apiCandidateFromRow_(row);
}

function apiCandidateFromRow_(row) {
  return {
    candidateId: row.candidate_id || '',
    name: row.name || '',
    testDate: apiSerializeDateLike_(row.test_date),
    role: row.role || '',
    status: apiNormalizeCandidateStatus_(row.status),
    uploadedAt: apiSerializeDateLike_(row.uploaded_at),
    decision: apiNormalizeDecision_(row.hiring_decision),
    employeeNumber: row.employee_number || '',
    decisionBy: row.decision_by || '',
    decisionAt: apiSerializeDateLike_(row.decision_at),
    memo: row.memo || '',
    updatedAt: apiSerializeDateLike_(row.updated_at),
  };
}

function apiGetResultResponseFromDashboard_(dashboard) {
  const candidate = apiCandidateForGetResult_(dashboard.candidate || {});
  return {
    candidate,
    result: dashboard.result ? apiDetailedResultFromDashboard_(dashboard) : null,
    rawCellSummary: apiRawCellSummaryFromDashboard_(dashboard.rawCellSummary),
    sourceUrl: dashboard.candidate.source_url || '',
  };
}

function apiCandidateForGetResult_(row) {
  const candidate = apiCandidateFromRow_(row);
  if (candidate.decision === 'hold') candidate.decision = null;
  return candidate;
}

function apiDetailedResultFromDashboard_(dashboard) {
  const candidate = dashboard.candidate || {};
  const result = dashboard.result || {};
  const jobRequirementMinusSource = result.job_requirement_minus_points === '' || result.job_requirement_minus_points === undefined || result.job_requirement_minus_points === null
    ? result.minus_points
    : result.job_requirement_minus_points;
  return {
    candidateId: candidate.candidate_id || result.candidate_id || '',
    totalRank: result.total_rank || '',
    responseAttitudeStage: apiNumberOrNull_(result.response_attitude_stage),
    attitudeMinusPoints: apiNumberOrDefault_(result.attitude_minus_points, 0),
    jobRequirementMinusPoints: apiNumberOrDefault_(jobRequirementMinusSource, 0),
    jobRequirementLowItems: apiJobRequirementLowItems_(result.job_requirement_low_items),
    items: apiResultItems_(result.item_totals || {}, result.item_stages || {}),
    crossCheck: apiCrossCheckItems_(result.cross_check),
    notes: result.notes || '',
    finalizedBy: result.finalized_by || '',
    finalizedAt: apiSerializeDateLike_(result.finalized_at),
    status: result.status ? apiNormalizeCandidateStatus_(result.status) : apiNormalizeCandidateStatus_(candidate.status),
  };
}

function apiResultItems_(itemTotals, itemStages) {
  return apiResultItemMaster_().map((item) => ({
    key: item.key,
    label: item.label,
    total: apiNumberOrNull_(apiValueByItem_(itemTotals, item)),
    stage: apiNumberOrNull_(apiValueByItem_(itemStages, item)),
    isJobRequirement: apiIsJobRequirementItem_(item),
    isAttitude: Boolean(item.isAttitude),
  }));
}

function apiResultItemMaster_() {
  if (typeof DEFAULT_ITEM_MASTER !== 'undefined' && Array.isArray(DEFAULT_ITEM_MASTER)) {
    return DEFAULT_ITEM_MASTER.map((item) => ({
      key: item.key,
      label: item.label,
      isAttitude: Boolean(item.isAttitude),
    }));
  }
  return [
    { key: 'self_control', label: '①セルフコントロール', isAttitude: false },
    { key: 'communication', label: '②コミュニケーション', isAttitude: false },
    { key: 'situation', label: '③状況認識力', isAttitude: false },
    { key: 'stress', label: '④ストレス対処力', isAttitude: false },
    { key: 'proactivity', label: '⑤積極性', isAttitude: false },
    { key: 'goal', label: '⑥目標達成力', isAttitude: false },
    { key: 'positive', label: '⑦ポジティブ思考力', isAttitude: false },
    { key: 'teamwork', label: '⑧チームワーク', isAttitude: false },
    { key: 'hospitality', label: '⑨ホスピタリティー', isAttitude: false },
    { key: 'attitude', label: '応答態度', isAttitude: true },
  ];
}

function apiValueByItem_(values, item) {
  if (!values || typeof values !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(values, item.label)) return values[item.label];
  if (Object.prototype.hasOwnProperty.call(values, item.key)) return values[item.key];
  return '';
}

function apiIsJobRequirementItem_(item) {
  if (!item || item.isAttitude) return false;
  const first = String(item.label || '').charAt(0);
  return first === '⑤' || first === '⑥' || first === '⑦' || first === '⑧' || first === '⑨';
}

function apiJobRequirementLowItems_(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    label: item.label || '',
    stage: apiNumberOrNull_(item.stage),
  }));
}

function apiCrossCheckItems_(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    item: item.item || '',
    computed: apiNumberOrNull_(item.computed),
    handwritten: apiNumberOrNull_(item.handwritten),
  }));
}

function apiRawCellSummaryFromDashboard_(summary) {
  if (!summary) return null;
  return {
    confidenceAvg: apiNumberOrNull_(summary.confidence_avg),
    unresolvedCount: apiNumberOrNull_(summary.unresolved_count),
    pageIndex: apiNumberOrNull_(summary.page_index),
    updatedAt: apiSerializeDateLike_(summary.updated_at),
  };
}

function apiNumberOrNull_(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function apiNumberOrDefault_(value, defaultValue) {
  const number = apiNumberOrNull_(value);
  return number === null ? defaultValue : number;
}

function apiResultFromDashboard_(dashboard) {
  const candidate = dashboard.candidate || {};
  const result = dashboard.result || {};
  return {
    candidateId: candidate.candidate_id || result.candidate_id || '',
    totalRank: result.total_rank || '',
    responseAttitudeStage: result.response_attitude_stage === '' ? null : result.response_attitude_stage,
    minusPoints: result.minus_points === '' ? null : Number(result.minus_points),
    attitudeMinusPoints: result.attitude_minus_points === '' ? null : Number(result.attitude_minus_points),
    jobRequirementMinusPoints: result.job_requirement_minus_points === '' ? null : Number(result.job_requirement_minus_points),
    finalizedBy: result.finalized_by || '',
    finalizedAt: apiSerializeDateLike_(result.finalized_at),
    notes: result.notes || '',
  };
}

function apiNormalizeCandidateStatus_(status) {
  const normalized = String(status || '').trim().toUpperCase();
  const map = {
    REGISTERED: 'uploaded',
    UPLOADED: 'uploaded',
    PROCESSING: 'recognizing',
    PROCESSING_FAILED: 'needs_review',
    REVIEW_REQUIRED: 'needs_review',
    READY_TO_FINALIZE: 'scored',
    FINALIZED: 'finalized',
  };
  return map[normalized] || String(status || '').trim().toLowerCase();
}

function apiNormalizeDecision_(decision) {
  const normalized = String(decision || '').trim().toUpperCase();
  if (normalized === 'PASSED') return 'hire';
  if (normalized === 'FAILED') return 'reject';
  return normalized ? normalized.toLowerCase() : 'hold';
}

function normalizeApiCells_(cells) {
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) {
    throw apiError_('validation', 'cells must be an object');
  }
  const normalized = {};
  Object.keys(cells).forEach((key) => {
    if (!CELL_KEYS.includes(key)) throw apiError_('validation', `Invalid cell key: ${key}`);
    const raw = cells[key] && typeof cells[key] === 'object' && !Array.isArray(cells[key])
      ? cells[key].value
      : cells[key];
    const value = Number(raw);
    if (![0, 1, 2, 3].includes(value)) {
      throw apiError_('validation', `${key} must be one of 0/1/2/3`);
    }
    normalized[key] = value;
  });
  if (Object.keys(normalized).length === 0) throw apiError_('validation', 'cells must include at least one cell');
  return normalized;
}

function requireApiCandidateId_(payload) {
  const candidateId = String(payload && payload.candidateId || '').trim();
  if (!candidateId) throw apiError_('validation', 'candidateId is required');
  return candidateId;
}

function apiOperationId_(claims, payload) {
  return String((claims && claims.operationId) || (payload && payload.operationId) || '').trim();
}

function apiCandidateIdFromPayload_(payload) {
  return String(payload && payload.candidateId || '').trim();
}

function findApiOperation_(ss, operationId) {
  return readObjects_(ss.getSheetByName(SHEETS.apiOperations))
    .find((row) => String(row.operation_id || '') === operationId) || null;
}

function recordApiOperation_(ss, context, result) {
  appendObject_(ss.getSheetByName(SHEETS.apiOperations), {
    operation_id: context.operationId,
    action: context.action,
    candidate_id: apiOperationCandidateId_(context, result),
    status: 'SUCCEEDED',
    result_json: JSON.stringify(apiSerialize_(result)),
    created_at: new Date(),
  });
}

function apiOperationCandidateId_(context, result) {
  return apiCandidateIdFromPayload_(context.payload)
    || (result && result.candidate && result.candidate.candidateId)
    || (result && result.result && result.result.candidateId)
    || '';
}

function cleanupApiOperations_(ss) {
  cleanupSheetByAge_(ss.getSheetByName(SHEETS.apiOperations), 'created_at', API_OPERATION_TTL_SECONDS);
}

function cleanupApiNonces_(ss) {
  cleanupSheetByAge_(ss.getSheetByName(SHEETS.apiNonces), 'ts', API_NONCE_TTL_SECONDS);
}

function cleanupSheetByAge_(sheet, ageHeader, ttlSeconds) {
  const table = readTable_(sheet);
  if (table.rows.length === 0) return;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const keptRows = table.rows.filter((row) => {
    const value = row[ageHeader];
    const seconds = value instanceof Date
      ? Math.floor(value.getTime() / 1000)
      : Number(value);
    return !Number.isFinite(seconds) || nowSeconds - seconds <= ttlSeconds;
  });

  if (keptRows.length === table.rows.length) return;
  const values = [table.headers].concat(
    keptRows.map((row) => table.headers.map((header) => (
      sanitizeSheetValue_(row[header] === undefined ? '' : row[header])
    )))
  );
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, table.headers.length).setValues(values);
}

function apiAppendAudit_(context, result, at) {
  try {
    const ss = getWorkbook_();
    const action = context && context.action || '';
    const candidateId = context
      ? (apiCandidateIdFromPayload_(context.payload) || apiOperationCandidateId_(context, result))
      : '';
    const operationId = context && context.operationId || '';
    const operator = context && context.operator || '';
    const resultJson = JSON.stringify(apiSerialize_(result || {}));
    appendObject_(ss.getSheetByName(SHEETS.auditLog), {
      logged_at: at || new Date(),
      actor: operator || getActor_(),
      action,
      candidate_id: candidateId,
      detail_json: resultJson,
      operator,
      operation_id: operationId,
      result: resultJson,
      at: at || new Date(),
    });
  } catch (error) {
    // Audit logging must not mask the API result.
  }
}

function apiContextFromUntrustedClaims_(claims) {
  return {
    claims: claims || {},
    payload: {},
    action: String(claims && claims.action || ''),
    operator: normalizeEmail_(claims && claims.operator || ''),
    role: '',
    operationId: String(claims && claims.operationId || '').trim(),
  };
}

function canonicalJson_(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson_).join(',')}]`;

  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson_(value[key])}`
  )).join(',')}}`;
}

function getApiRequestParam_(event, key) {
  const candidates = [
    key,
    key.toLowerCase(),
    key.replace(/-/g, '_'),
    key.replace(/-/g, '').toLowerCase(),
  ];
  const sources = [];
  if (event && event.parameter) sources.push(event.parameter);
  if (event && event.parameters) sources.push(event.parameters);
  if (event && event.headers) sources.push(event.headers);

  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    for (let j = 0; j < candidates.length; j += 1) {
      const candidate = candidates[j];
      if (source[candidate] !== undefined) {
        const value = source[candidate];
        return Array.isArray(value) ? String(value[0] || '') : String(value || '');
      }
    }
  }
  return '';
}

function apiParseBoolean_(value) {
  if (value === true) return true;
  const text = String(value || '').trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'y';
}

function apiDateSortValue_(value) {
  if (!value) return 0;
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function apiSerializeDateLike_(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? '' : String(value);
}

function apiSerialize_(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(apiSerialize_);
  if (value && typeof value === 'object') {
    const serialized = {};
    Object.keys(value).forEach((key) => {
      serialized[key] = apiSerialize_(value[key]);
    });
    return serialized;
  }
  return value;
}

function apiError_(code, message) {
  const error = new Error(message || code);
  error.apiCode = code;
  return error;
}

function normalizeApiError_(error) {
  const message = error && error.message ? error.message : 'Internal error';
  if (error && error.apiCode) {
    return { code: error.apiCode, message };
  }
  if (/not found/i.test(message)) return { code: 'not_found', message };
  if (/already|duplicate|conflict/i.test(message)) return { code: 'conflict', message };
  if (/required|invalid|must be|unsupported|unresolved|undecided|変更|候補者|合否|職員番号/.test(message)) {
    return { code: 'validation', message };
  }
  return { code: 'internal', message };
}
