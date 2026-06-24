// 採点表(page.5)モデル: セルキー s01〜s80 (docs/cell-contract.md)
const CELL_KEYS = Array.from({ length: 80 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`);

const SHEETS = {
  candidates: 'Candidates',
  rawCells: 'RawCells',
  reviewQueue: 'ReviewQueue',
  itemMaster: 'ItemMaster',
  scoreBands: 'ScoreBands',
  rankRules: 'RankRules',
  handwrittenTotals: 'HandwrittenTotals',
  results: 'Results',
  auditLog: 'AuditLog',
  users: 'Users',
  apiOperations: 'ApiOperations',
  apiNonces: 'ApiNonces',
  config: 'Config',
};

const HEADERS = {
  Candidates: [
    'candidate_id',
    'name',
    'test_date',
    'role',
    'uploaded_at',
    'status',
    'source_url',
    'memo',
    'hiring_decision',
    'employee_number',
    'decision_by',
    'decision_at',
  ],
  RawCells: [
    'candidate_id',
    ...CELL_KEYS,
    'confidence_avg',
    'unresolved_count',
    'page_index',
    'updated_at',
  ],
  ReviewQueue: [
    'review_id',
    'candidate_id',
    'cell_key',
    'detected',
    'reason',
    'confidence',
    'image_link',
    'corrected_value',
    'status',
    'resolved_by',
    'resolved_at',
  ],
  // 文字(A〜J)→検査項目の対応。is_attitude=TRUE の行が応答態度
  ItemMaster: [
    'item_key',
    'label',
    'letter',
    'is_attitude',
    'display_order',
  ],
  // 項目別の段階バンド (項目ごとに1〜5の境界が異なる)
  ScoreBands: [
    'item_key',
    'min_score',
    'max_score',
    'stage',
  ],
  RankRules: [
    'rule_id',
    'label',
    'condition_json',
    'rank',
    'minus_points',
    'note',
  ],
  // 採点表に手書きされた項目合計点 (任意入力)。crossCheck の照合に使う
  HandwrittenTotals: [
    'candidate_id',
    'item_key',
    'total',
  ],
  Results: [
    'candidate_id',
    'total_rank',
    'response_attitude_stage',
    'minus_points',
    'attitude_minus_points',
    'job_requirement_minus_points',
    'job_requirement_low_items_json',
    'row_scores_json',
    'item_totals_json',
    'item_stages_json',
    'cross_check_json',
    'notes',
    'finalized_by',
    'finalized_at',
  ],
  AuditLog: [
    'logged_at',
    'actor',
    'action',
    'candidate_id',
    'detail_json',
    'operator',
    'operation_id',
    'result',
    'at',
  ],
  Users: [
    'email',
    'role',
    'active',
  ],
  ApiOperations: [
    'operation_id',
    'action',
    'candidate_id',
    'status',
    'result_json',
    'created_at',
  ],
  ApiNonces: [
    'nonce',
    'ts',
  ],
  Config: [
    'key',
    'value',
    'note',
  ],
};

const PRODUCTION_CONFIG_DEFAULTS = [
  {
    key: 'UPLOAD_FOLDER_ID',
    value: '',
    note: 'アップロード原本の保存先DriveフォルダID。必須。空欄の場合はアップロードを拒否します。',
  },
  {
    key: 'RECOGNITION_ENDPOINT_URL',
    value: '',
    note: '画像解析APIのHTTPS URL。ホスト名はScript PropertiesのRECOGNITION_ENDPOINT_HOSTSで完全一致許可します。',
  },
  {
    key: 'RECOGNITION_MIN_CONFIDENCE',
    value: '0.8',
    note: 'この値未満の設問はReviewQueueへ入れます。',
  },
  {
    key: 'AUTO_FINALIZE_WHEN_CLEAN',
    value: 'false',
    note: 'trueの場合、要確認0件の読み取り結果を自動で採点確定します。',
  },
];

const SCRIPT_PROPERTY_KEYS = {
  spreadsheetId: 'SPREADSHEET_ID',
  recognitionApiKey: 'RECOGNITION_API_KEY',
  webhookSecret: 'RECOGNITION_WEBHOOK_SECRET',
  authorizedUsers: 'AUTHORIZED_USER_EMAILS',
  adminUsers: 'ADMIN_USER_EMAILS',
  recognitionEndpointHosts: 'RECOGNITION_ENDPOINT_HOSTS',
  appAccessCode: 'APP_ACCESS_CODE',
  functionsGasSecret: 'FUNCTIONS_GAS_SECRET',
};

const DEFAULT_SPREADSHEET_ID = '102G-XV6OXrNzTmXa96IWwcJcXZJ6A_vSEOQVIZ-7Z7U';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_UPLOAD_MIME_TYPES = {
  'image/jpeg': true,
  'image/png': true,
  'image/heic': true,
  'image/heif': true,
  'application/pdf': true,
};
const UPLOAD_EXTENSION_MIME_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
};
const FORMULA_INJECTION_PATTERN = /^[=+\-@\t\r\n]/;
const WEBHOOK_SIGNATURE_PARAM = 'cheqSignature';
const WEBHOOK_TIMESTAMP_PARAM = 'cheqTimestamp';
const WEBHOOK_MAX_CLOCK_SKEW_SECONDS = 5 * 60;

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('CHEQ採点支援')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(event) {
  try {
    const bodyText = getPostBody_(event);
    const payload = parsePostPayload_(bodyText);

    if (payload && payload.claims) {
      return dispatchApiRequest_(event, bodyText, payload);
    }

    assertWebhookAuthorized_(event, bodyText);

    if (payload.action === 'recognitionResult') {
      const result = importRecognitionResultInternal_(payload.candidateId, payload.recognition);
      return jsonResponse_({ ok: true, result });
    }

    if (payload.action === 'calculateResult') {
      const result = calculateCandidateResultInternal_(payload.candidateId);
      return jsonResponse_({ ok: true, result });
    }

    throw new Error(`Unsupported action: ${payload.action || ''}`);
  } catch (error) {
    return jsonResponse_({ ok: false, error: error.message }, 400);
  }
}

function setupWorkbook() {
  return setupProductionWorkbook();
}

function setupProductionWorkbook() {
  assertAdmin_();
  const lock = getWorkbookLock_();
  lock.waitLock(30000);
  try {
    const ss = getWorkbook_();
    Object.keys(HEADERS).forEach((sheetName) => {
      const sheet = getOrCreateSheet_(ss, sheetName);
      ensureHeader_(sheet, HEADERS[sheetName]);
    });
    seedProductionConfig_();
    seedApiUsersPlaceholder_();
    logAudit_('SETUP_PRODUCTION_WORKBOOK', '', { spreadsheetUrl: ss.getUrl() });
    return { ok: true, spreadsheetUrl: ss.getUrl() };
  } finally {
    lock.releaseLock();
  }
}

function setProductionSecret(key, value) {
  assertAdmin_();
  if (!Object.values(SCRIPT_PROPERTY_KEYS).includes(key)) {
    throw new Error(`Unsupported secret key: ${key}`);
  }
  PropertiesService.getScriptProperties().setProperty(key, value || '');
  return { ok: true };
}

function registerCandidate(payload, accessCode) {
  assertAuthorizedUser_(accessCode);
  assertWorkbookReady_();
  validateRequired_(payload, ['name', 'testDate']);

  let candidateId = '';
  let sourceUrl = '';
  const lock = getWorkbookLock_();
  lock.waitLock(30000);
  try {
    const ss = getWorkbook_();
    candidateId = Utilities.getUuid();
    const uploadedAt = new Date();
    sourceUrl = payload.file ? saveUploadedFile_(candidateId, payload.file) : '';

    appendObject_(ss.getSheetByName(SHEETS.candidates), {
      candidate_id: candidateId,
      name: payload.name,
      test_date: payload.testDate,
      role: payload.role || '',
      uploaded_at: uploadedAt,
      status: sourceUrl ? 'UPLOADED' : 'REGISTERED',
      source_url: sourceUrl,
      memo: payload.memo || '',
    });

    appendObject_(ss.getSheetByName(SHEETS.rawCells), {
      candidate_id: candidateId,
      confidence_avg: '',
      unresolved_count: '',
      updated_at: uploadedAt,
    });

    logAudit_('REGISTER_CANDIDATE', candidateId, {
      name: payload.name,
      testDate: payload.testDate,
      role: payload.role || '',
      hasFile: Boolean(payload.file),
    });
  } finally {
    lock.releaseLock();
  }

  if (sourceUrl && getConfig_('RECOGNITION_ENDPOINT_URL')) {
    startRecognition(candidateId, accessCode);
  }

  return { ok: true, candidateId, sourceUrl };
}

function startRecognition(candidateId, accessCode) {
  assertAuthorizedUser_(accessCode);
  assertWorkbookReady_();
  if (!candidateId) throw new Error('candidateId is required');

  const endpointUrl = getTrustedRecognitionEndpoint_();

  const ss = getWorkbook_();
  const candidate = findById_(ss.getSheetByName(SHEETS.candidates), 'candidate_id', candidateId);
  if (!candidate) throw new Error(`Candidate not found: ${candidateId}`);
  if (!candidate.source_url) throw new Error(`Candidate source_url is empty: ${candidateId}`);

  const apiKey = getScriptProperty_(SCRIPT_PROPERTY_KEYS.recognitionApiKey);
  if (!apiKey) throw new Error('RECOGNITION_API_KEY is not configured');

  updateCandidateStatus_(ss, candidateId, 'PROCESSING');
  const response = UrlFetchApp.fetch(endpointUrl, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify({
      candidateId,
      sourceUrl: candidate.source_url,
      callbackUrl: ScriptApp.getService().getUrl(),
    }),
  });

  const statusCode = response.getResponseCode();
  const text = response.getContentText();
  if (statusCode < 200 || statusCode >= 300) {
    updateCandidateStatus_(ss, candidateId, 'PROCESSING_FAILED');
    logAudit_('START_RECOGNITION_FAILED', candidateId, { statusCode, response: text.slice(0, 1000) });
    throw new Error(`Recognition API failed: HTTP ${statusCode}`);
  }

  const body = safeJsonParse_(text, {});
  logAudit_('START_RECOGNITION', candidateId, { statusCode, response: body });

  if (body && body.recognition) {
    return importRecognitionResultInternal_(candidateId, body.recognition);
  }

  return { ok: true, candidateId, statusCode };
}

function importRecognitionResult(candidateId, recognition, accessCode) {
  assertAuthorizedUser_(accessCode);
  return importRecognitionResultInternal_(candidateId, recognition);
}

function importRecognitionResultInternal_(candidateId, recognition) {
  assertWorkbookReady_();
  if (!candidateId) throw new Error('candidateId is required');
  if (!recognition || !recognition.cells) throw new Error('recognition.cells is required');

  let importResult = null;
  let shouldAutoFinalize = false;
  const lock = getWorkbookLock_();
  lock.waitLock(30000);
  try {
    const ss = getWorkbook_();
    const cells = normalizeCells_(recognition.cells);
    const reviewItems = buildCellReviewItems_(candidateId, cells, recognition.imageLinks || {});
    const confidenceAvg = averageCellConfidence_(cells);

    upsertRawCells_(ss, candidateId, cells, confidenceAvg, reviewItems.length, recognition.pageIndex);
    replaceReviewItems_(ss, candidateId, reviewItems);
    updateCandidateStatus_(ss, candidateId, reviewItems.length > 0 ? 'REVIEW_REQUIRED' : 'READY_TO_FINALIZE');

    logAudit_('IMPORT_RECOGNITION_RESULT', candidateId, {
      confidenceAvg,
      unresolvedCount: reviewItems.length,
    });

    shouldAutoFinalize = reviewItems.length === 0 && getConfigBoolean_('AUTO_FINALIZE_WHEN_CLEAN');
    importResult = {
      ok: true,
      candidateId,
      confidenceAvg,
      unresolvedCount: reviewItems.length,
    };
  } finally {
    lock.releaseLock();
  }

  if (shouldAutoFinalize) {
    return calculateCandidateResultInternal_(candidateId);
  }

  return importResult;
}

function getCandidates(accessCode) {
  assertAuthorizedUser_(accessCode);
  return getCandidatesInternal_();
}

function getCandidatesInternal_() {
  assertWorkbookReady_();
  const ss = getWorkbook_();
  return sanitizeForClient_(readObjects_(ss.getSheetByName(SHEETS.candidates)));
}

function registerHiringDecision(candidateId, decision, employeeNumber, accessCode) {
  assertAuthorizedUser_(accessCode);
  assertWorkbookReady_();
  if (!candidateId) throw new Error('candidateId is required');

  const normalizedDecision = decision === null || decision === undefined
    ? ''
    : String(decision).trim();
  if (!['', 'PASSED', 'FAILED'].includes(normalizedDecision)) {
    throw new Error('合否は PASSED / FAILED / 空(取り消し) のいずれかにしてください');
  }

  const normalizedEmployeeNumber = employeeNumber === null || employeeNumber === undefined
    ? ''
    : String(employeeNumber).trim();
  if (normalizedDecision !== 'PASSED' && normalizedEmployeeNumber) {
    throw new Error('職員番号は合格時のみ登録できます');
  }

  const lock = getWorkbookLock_();
  lock.waitLock(30000);
  try {
    const ss = getWorkbook_();
    const sheet = ss.getSheetByName(SHEETS.candidates);
    const table = readTable_(sheet);
    const rowIndex = table.rows.findIndex((row) => row.candidate_id === candidateId);
    if (rowIndex < 0) throw new Error(`Candidate not found: ${candidateId}`);

    if (normalizedEmployeeNumber) {
      const duplicate = table.rows.find((row) => (
        row.candidate_id !== candidateId
          && String(row.employee_number || '').trim() === normalizedEmployeeNumber
      ));
      if (duplicate) {
        throw new Error(`職員番号 ${normalizedEmployeeNumber} は既に別の候補者に登録されています`);
      }
    }

    const rowNumber = rowIndex + 2;
    const storedEmployeeNumber = normalizedDecision === 'PASSED' ? normalizedEmployeeNumber : '';
    const actor = getActor_();
    const decidedAt = new Date();

    setCellByHeader_(sheet, table.headers, rowNumber, 'hiring_decision', normalizedDecision);
    formatTextCellByHeader_(sheet, table.headers, rowNumber, 'employee_number');
    setCellByHeader_(sheet, table.headers, rowNumber, 'employee_number', storedEmployeeNumber);
    setCellByHeader_(sheet, table.headers, rowNumber, 'decision_by', actor);
    setCellByHeader_(sheet, table.headers, rowNumber, 'decision_at', decidedAt);
    if (normalizedDecision) {
      setCellByHeader_(sheet, table.headers, rowNumber, 'status', 'FINALIZED');
    }

    const detail = { decision: normalizedDecision };
    if (storedEmployeeNumber) detail.employeeNumber = storedEmployeeNumber;
    if (normalizedDecision) detail.status = 'FINALIZED';
    logAudit_('REGISTER_HIRING_DECISION', candidateId, detail);

    return {
      ok: true,
      candidateId,
      decision: normalizedDecision,
      employeeNumber: storedEmployeeNumber,
    };
  } finally {
    lock.releaseLock();
  }
}

function getReviewQueue(candidateId, accessCode) {
  assertAuthorizedUser_(accessCode);
  return getReviewQueueInternal_(candidateId);
}

function getReviewQueueInternal_(candidateId) {
  assertWorkbookReady_();
  const ss = getWorkbook_();
  return sanitizeForClient_(
    readObjects_(ss.getSheetByName(SHEETS.reviewQueue))
      .filter((row) => !candidateId || row.candidate_id === candidateId)
      .filter((row) => row.status !== 'RESOLVED')
  );
}

// google.script.run は Date オブジェクトを返せない(呼び出しが失敗する)ため、
// クライアントへ返す直前に Date を文字列へ変換する
function sanitizeForClient_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForClient_);
  }
  if (value && typeof value === 'object') {
    const sanitized = {};
    Object.keys(value).forEach((key) => {
      sanitized[key] = sanitizeForClient_(value[key]);
    });
    return sanitized;
  }
  return value;
}

function resolveReviewItem(reviewId, correctedValue, accessCode) {
  assertAuthorizedUser_(accessCode);
  assertWorkbookReady_();
  if (!reviewId) throw new Error('reviewId is required');
  const value = Number(correctedValue);
  if (![0, 1, 2, 3].includes(value)) {
    throw new Error('correctedValue must be one of 0/1/2/3');
  }

  const lock = getWorkbookLock_();
  lock.waitLock(30000);
  try {
    const ss = getWorkbook_();
    const sheet = ss.getSheetByName(SHEETS.reviewQueue);
    const table = readTable_(sheet);
    const rowIndex = table.rows.findIndex((row) => row.review_id === reviewId);
    if (rowIndex < 0) throw new Error(`Review item not found: ${reviewId}`);

    const row = table.rows[rowIndex];
    const actor = getActor_();
    setCellByHeader_(sheet, table.headers, rowIndex + 2, 'corrected_value', value);
    setCellByHeader_(sheet, table.headers, rowIndex + 2, 'status', 'RESOLVED');
    setCellByHeader_(sheet, table.headers, rowIndex + 2, 'resolved_by', actor);
    setCellByHeader_(sheet, table.headers, rowIndex + 2, 'resolved_at', new Date());

    patchRawCell_(ss, row.candidate_id, row.cell_key, value);
    refreshUnresolvedCount_(ss, row.candidate_id);

    logAudit_('RESOLVE_REVIEW_ITEM', row.candidate_id, {
      reviewId,
      cellKey: row.cell_key,
      correctedValue: value,
    });

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// 目視修正用: 候補者の80セルの読み取り値を返す(フラグ・理由付き)。原本URLも返す。
function getCandidateCells(candidateId, accessCode) {
  assertAuthorizedUser_(accessCode);
  assertWorkbookReady_();
  if (!candidateId) throw new Error('candidateId is required');
  const ss = getWorkbook_();
  const rawCells = findById_(ss.getSheetByName(SHEETS.rawCells), 'candidate_id', candidateId);
  if (!rawCells) throw new Error(`Raw cells not found: ${candidateId}`);
  const candidate = findById_(ss.getSheetByName(SHEETS.candidates), 'candidate_id', candidateId);

  const flagged = {};
  readObjects_(ss.getSheetByName(SHEETS.reviewQueue))
    .filter((row) => row.candidate_id === candidateId && row.status === 'OPEN')
    .forEach((item) => {
      flagged[item.cell_key] = item.reason;
    });

  const cells = {};
  CELL_KEYS.forEach((key) => {
    const raw = rawCells[key];
    cells[key] = {
      value: raw === '' || raw === null || raw === undefined ? '' : Number(raw),
      flagged: Object.prototype.hasOwnProperty.call(flagged, key),
      reason: flagged[key] || '',
    };
  });

  return sanitizeForClient_({
    candidateId,
    name: candidate ? candidate.name : '',
    sourceUrl: candidate ? candidate.source_url : '',
    status: candidate ? candidate.status : '',
    unresolvedCount: rawCells.unresolved_count === '' || rawCells.unresolved_count === undefined
      ? 0 : Number(rawCells.unresolved_count),
    cells,
  });
}

// 目視修正の保存: updates = { s01: 0-3, ... }(変更セルのみ)。RawCellsを上書きし、
// 対応するOPENレビュー項目はRESOLVED化、未確定数を再計算する。採点確定は別途ボタンで行う。
function overrideCellValues(candidateId, updates, accessCode) {
  assertAuthorizedUser_(accessCode);
  assertWorkbookReady_();
  if (!candidateId) throw new Error('candidateId is required');
  const keys = updates && typeof updates === 'object' ? Object.keys(updates) : [];
  if (keys.length === 0) throw new Error('変更されたセルがありません');

  const lock = getWorkbookLock_();
  lock.waitLock(30000);
  try {
    const ss = getWorkbook_();
    const reviewSheet = ss.getSheetByName(SHEETS.reviewQueue);
    const actor = getActor_();

    keys.forEach((cellKey) => {
      if (!CELL_KEYS.includes(cellKey)) throw new Error(`Invalid cell key: ${cellKey}`);
      const value = Number(updates[cellKey]);
      if (![0, 1, 2, 3].includes(value)) {
        throw new Error(`${cellKey} の値は 0/1/2/3 のいずれかにしてください`);
      }
      patchRawCell_(ss, candidateId, cellKey, value);

      const table = readTable_(reviewSheet);
      const rowIndex = table.rows.findIndex(
        (row) => row.candidate_id === candidateId && row.cell_key === cellKey && row.status === 'OPEN'
      );
      if (rowIndex >= 0) {
        setCellByHeader_(reviewSheet, table.headers, rowIndex + 2, 'corrected_value', value);
        setCellByHeader_(reviewSheet, table.headers, rowIndex + 2, 'status', 'RESOLVED');
        setCellByHeader_(reviewSheet, table.headers, rowIndex + 2, 'resolved_by', actor);
        setCellByHeader_(reviewSheet, table.headers, rowIndex + 2, 'resolved_at', new Date());
      }
    });

    refreshUnresolvedCount_(ss, candidateId);
    logAudit_('OVERRIDE_CELLS', candidateId, { count: keys.length, cells: keys.join(',') });

    const updatedRaw = findById_(ss.getSheetByName(SHEETS.rawCells), 'candidate_id', candidateId);
    return {
      ok: true,
      unresolvedCount: updatedRaw && updatedRaw.unresolved_count !== ''
        ? Number(updatedRaw.unresolved_count) : 0,
    };
  } finally {
    lock.releaseLock();
  }
}

function calculateCandidateResult(candidateId, accessCode) {
  assertAuthorizedUser_(accessCode);
  return calculateCandidateResultInternal_(candidateId);
}

function calculateCandidateResultInternal_(candidateId) {
  assertWorkbookReady_();
  assertScoringRulesReady_();
  if (!candidateId) throw new Error('candidateId is required');

  const lock = getWorkbookLock_();
  lock.waitLock(30000);
  try {
    const ss = getWorkbook_();
    const rawCells = findById_(ss.getSheetByName(SHEETS.rawCells), 'candidate_id', candidateId);
    if (!rawCells) throw new Error(`Raw cells not found: ${candidateId}`);

    const unresolved = Number(rawCells.unresolved_count || 0);
    if (unresolved > 0) {
      throw new Error(`Unresolved review items remain: ${unresolved}`);
    }

    // マスタはシートが正。採点ロジックは CheqScoring.gs (純粋関数) に委譲する
    const itemMaster = buildItemMasterFromRows(readObjects_(ss.getSheetByName(SHEETS.itemMaster)));
    const bands = buildBandsFromRows(readObjects_(ss.getSheetByName(SHEETS.scoreBands)));
    const handwrittenTotals = readHandwrittenTotals_(ss, candidateId);

    const scored = scoreSheet(extractCells_(rawCells), {
      itemMaster,
      bands,
      handwrittenTotals,
    });
    if (scored.issues.length > 0) {
      throw new Error(`Undecided cells remain: ${scored.issues.map((i) => i.cell).join(', ')}`);
    }

    // 総合判定は項目ラベル①〜④だけを見る。
    const stagesByLabel = {};
    const totalsByLabel = {};
    itemMaster.forEach((item) => {
      stagesByLabel[item.label] = scored.stages[item.key];
      totalsByLabel[item.label] = scored.itemTotals[item.key];
    });
    const rankResult = calculateFallbackRank_(stagesByLabel);
    const attitudeMinus = Number(rankResult.minusPoints || 0);
    const jobReqMinus = Number(scored.jobRequirementMinusPoints || 0);
    // minus_points は職務必要要件(⑤〜⑨)の低段階項目のみ。応答態度減点は別列で保持する。
    const minusPoints = jobReqMinus;
    const jobRequirementLowItems = scored.jobRequirementLowItems || [];
    appendCrossCheckNotices_(ss, candidateId, scored.crossCheck, itemMaster);
    const finalizedAt = new Date();
    const actor = getActor_();

    upsertResult_(ss, {
      candidate_id: candidateId,
      total_rank: rankResult.rank,
      response_attitude_stage: scored.attitudeStage === null ? '' : scored.attitudeStage,
      minus_points: minusPoints,
      attitude_minus_points: attitudeMinus,
      job_requirement_minus_points: jobReqMinus,
      job_requirement_low_items_json: JSON.stringify(jobRequirementLowItems.map(({ label, stage }) => ({ label, stage }))),
      row_scores_json: JSON.stringify(scored.rowScores),
      item_totals_json: JSON.stringify(totalsByLabel),
      item_stages_json: JSON.stringify(stagesByLabel),
      cross_check_json: JSON.stringify(scored.crossCheck),
      notes: buildResultNotes_(rankResult, scored.crossCheck, itemMaster, jobReqMinus, jobRequirementLowItems),
      finalized_by: actor,
      finalized_at: finalizedAt,
    });

    updateCandidateStatus_(ss, candidateId, 'FINALIZED');
    logAudit_('CALCULATE_CANDIDATE_RESULT', candidateId, {
      rank: rankResult.rank,
      minusPoints,
      attitudeMinus,
      jobReqMinus,
      crossCheckMismatches: scored.crossCheck.length,
    });

    return getDashboardDataInternal_(candidateId);
  } finally {
    lock.releaseLock();
  }
}

function readHandwrittenTotals_(ss, candidateId) {
  const rows = readObjects_(ss.getSheetByName(SHEETS.handwrittenTotals))
    .filter((row) => row.candidate_id === candidateId && row.item_key !== '' && row.total !== '');
  if (rows.length === 0) return null;
  const totals = {};
  rows.forEach((row) => {
    totals[String(row.item_key).trim()] = Number(row.total);
  });
  return totals;
}

// 手書き合計との不一致は採点を止めず、NOTICE としてReviewQueueに記録する
function appendCrossCheckNotices_(ss, candidateId, mismatches, itemMaster) {
  if (!mismatches || mismatches.length === 0) return;
  const sheet = ss.getSheetByName(SHEETS.reviewQueue);
  const labelByKey = {};
  itemMaster.forEach((item) => {
    labelByKey[item.key] = item.label;
  });
  mismatches.forEach((mismatch) => {
    appendObject_(sheet, {
      review_id: Utilities.getUuid(),
      candidate_id: candidateId,
      cell_key: '',
      detected: mismatch.computed,
      reason: `手書き不一致: ${labelByKey[mismatch.item] || mismatch.item} 手書き${mismatch.handwritten} / 再計算${mismatch.computed}`,
      confidence: '',
      image_link: '',
      corrected_value: '',
      status: 'NOTICE',
      resolved_by: '',
      resolved_at: '',
    });
  });
}

function buildResultNotes_(rankResult, mismatches, itemMaster, jobReqMinus, jobRequirementLowItems) {
  const notes = [rankResult.note].filter(Boolean);
  if (jobReqMinus < 0) {
    const lowItems = jobRequirementLowItems || [];
    const labels = lowItems.map((item) => item.label).filter(Boolean);
    notes.push(`職務必要要件(⑤〜⑨)で段階2以下が ${Math.abs(jobReqMinus)} 件: ${labels.join(', ')}`);
  }
  if (mismatches && mismatches.length > 0) {
    const labelByKey = {};
    itemMaster.forEach((item) => {
      labelByKey[item.key] = item.label;
    });
    notes.push(`手書き合計と${mismatches.length}件不一致 (${mismatches.map((m) => labelByKey[m.item] || m.item).join(', ')})。システム再計算を正とする`);
  }
  return notes.join(' / ');
}

function getDashboardData(candidateId, accessCode) {
  assertAuthorizedUser_(accessCode);
  return getDashboardDataInternal_(candidateId);
}

function downloadCandidateResultPdf(candidateId, accessCode) {
  assertAuthorizedUser_(accessCode);
  const data = getDashboardDataInternal_(candidateId);
  if (!data.candidate || !data.result) {
    throw new Error('採点結果がまだ確定していません。先に「結果を表示」または「採点確定」を実行してください。');
  }

  const fileName = `CHEQ_${sanitizePdfFileName_(data.candidate.name || data.candidate.candidate_id || 'result')}.pdf`;
  const html = buildCandidateResultPdfHtml_(data);
  const pdfBlob = Utilities
    .newBlob(html, 'text/html; charset=UTF-8', fileName.replace(/\.pdf$/, '.html'))
    .getAs('application/pdf')
    .setName(fileName);

  return {
    fileName,
    mimeType: 'application/pdf',
    base64: Utilities.base64Encode(pdfBlob.getBytes()),
  };
}

function getDashboardDataInternal_(candidateId) {
  assertWorkbookReady_();
  const ss = getWorkbook_();
  const candidates = readObjects_(ss.getSheetByName(SHEETS.candidates));
  const candidate = candidateId
    ? candidates.find((row) => row.candidate_id === candidateId)
    : candidates[0];
  if (!candidate) return { candidate: null, result: null };

  const result = findById_(ss.getSheetByName(SHEETS.results), 'candidate_id', candidate.candidate_id);
  const rawCells = findById_(ss.getSheetByName(SHEETS.rawCells), 'candidate_id', candidate.candidate_id);
  const reviewQueue = getReviewQueueInternal_(candidate.candidate_id);

  return sanitizeForClient_({
    candidate,
    result: result ? {
      ...result,
      row_scores: safeJsonParse_(result.row_scores_json, {}),
      item_totals: safeJsonParse_(result.item_totals_json, {}),
      item_stages: safeJsonParse_(result.item_stages_json, {}),
      cross_check: safeJsonParse_(result.cross_check_json, []),
      job_requirement_low_items: safeJsonParse_(result.job_requirement_low_items_json, []),
    } : null,
    rawCellSummary: rawCells ? {
      confidence_avg: rawCells.confidence_avg,
      unresolved_count: rawCells.unresolved_count,
      page_index: rawCells.page_index,
      updated_at: rawCells.updated_at,
    } : null,
    reviewQueue,
  });
}

function buildCandidateResultPdfHtml_(data) {
  const candidate = data.candidate || {};
  const result = data.result || {};
  const summary = data.rawCellSummary || {};
  const stages = result.item_stages || {};
  const totals = result.item_totals || {};
  const labels = sortDashboardLabelsForPdf_(
    Object.keys(stages).filter((label) => label !== '応答態度')
  );
  const attitudeMinus = numericOrNullForPdf_(result.attitude_minus_points);
  const profileMinus = attitudeMinus === null
    ? Number(result.minus_points || 0)
    : attitudeMinus;
  const jobReqLowItems = Array.isArray(result.job_requirement_low_items)
    ? result.job_requirement_low_items
    : [];
  const crossCheck = Array.isArray(result.cross_check) ? result.cross_check : [];
  const cautions = labels.filter((label) => {
    const value = Number(stages[label]);
    return value >= 1 && value <= 2;
  });
  const jobReqMinus = numericOrNullForPdf_(result.job_requirement_minus_points);
  const minusLabel = jobReqMinus === null
    ? '-'
    : (jobReqMinus === 0 ? 'なし' : String(jobReqMinus));
  const attitudeStage = isBlankForPdf_(result.response_attitude_stage)
    ? '-'
    : String(result.response_attitude_stage);
  const unresolved = isBlankForPdf_(summary.unresolved_count)
    ? '0'
    : String(summary.unresolved_count);
  const generatedAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      @page { size: A4; margin: 9mm; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: #1a1a1a;
        font-family: "Noto Sans JP", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif;
        font-size: 10px;
      }
      h1, h2, h3, p { margin: 0; }
      .header {
        width: 100%;
        border-collapse: collapse;
        border-bottom: 2px solid #1a1a1a;
      }
      .header td { border: 0; padding: 0 0 3mm; vertical-align: top; }
      h1 { font-size: 22px; line-height: 1.2; }
      .name { margin-top: 4mm; font-size: 18px; font-weight: 700; }
      .meta {
        width: 76mm;
        border-collapse: collapse;
        color: #4d4d4d;
        line-height: 1.45;
      }
      .meta td { border: 0; padding: 0 0 0 4mm; font-size: 10px; white-space: nowrap; }
      .metrics {
        width: 100%;
        border-collapse: separate;
        border-spacing: 3mm 0;
        margin-top: 4mm;
      }
      .metrics td {
        border: 1px solid #cccccc;
        border-radius: 5px;
        padding: 2.5mm;
        width: 25%;
      }
      .metrics span { display: block; color: #4d4d4d; font-size: 9px; }
      .metrics strong { display: block; margin-top: 1mm; font-size: 20px; line-height: 1.1; }
      section { margin-top: 4mm; }
      h2 { margin-bottom: 2mm; font-size: 14px; }
      .legend { margin-bottom: 1mm; color: #4d4d4d; font-size: 10px; }
      .legend-item { display: inline-block; margin-right: 5mm; }
      .swatch { display: inline-block; width: 8mm; height: 1mm; margin-right: 2mm; border-radius: 1mm; background: #0017c1; vertical-align: middle; }
      .swatch-dash { background-image: repeating-linear-gradient(90deg, #e53935 0 5px, transparent 5px 9px); }
      svg { width: 100%; height: 70mm; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #eeeeee; padding: 1.3mm 1.8mm; text-align: left; font-size: 9px; }
      th { color: #4d4d4d; font-weight: 700; }
      .badge {
        display: inline-block;
        margin: 0 1mm 1mm 0;
        border-radius: 10px;
        padding: 0.6mm 1.6mm;
        font-size: 8px;
        font-weight: 700;
      }
      .ok { background: #dff4e8; color: #115a36; }
      .warn { background: #ffdfca; color: #ac3e00; }
      .alert { background: #ffdada; color: #8b0000; }
      .attention {
        border: 1px solid #cccccc;
        border-radius: 5px;
        padding: 2.5mm;
        line-height: 1.6;
      }
      .attention p + p { margin-top: 1mm; }
      .footer { margin-top: 2mm; color: #4d4d4d; font-size: 8px; text-align: right; }
    </style>
  </head>
  <body>
    <table class="header">
      <tr>
      <td>
        <h1>CHEQ 採点結果</h1>
        <p class="name">${escapeHtmlForPdf_(candidate.name || '-')}</p>
      </td>
      <td>
        <table class="meta">
          <tr>
            <td>候補者ID: ${escapeHtmlForPdf_(candidate.candidate_id || '-')}</td>
            <td>検査日: ${escapeHtmlForPdf_(candidate.test_date || '-')}</td>
          </tr>
        </table>
      </td>
      </tr>
    </table>
    <table class="metrics">
      <tr>
        <td><span>総合判定</span><strong>${escapeHtmlForPdf_(result.total_rank || '-')}</strong></td>
        <td><span>応答態度</span><strong>${escapeHtmlForPdf_(attitudeStage)}</strong></td>
        <td><span>マイナスポイント</span><strong>${escapeHtmlForPdf_(minusLabel)}</strong></td>
        <td><span>要確認</span><strong>${escapeHtmlForPdf_(unresolved)}</strong></td>
      </tr>
    </table>
    <section>
      <h2>カテゴリ別プロフィール</h2>
      ${profileMinus < 0 ? '<div class="legend"><span class="legend-item"><span class="swatch"></span>現状</span><span class="legend-item"><span class="swatch swatch-dash"></span>応答態度マイナス適用後 (' + escapeHtmlForPdf_(profileMinus) + ')</span></div>' : ''}
      ${renderPdfProfileChart_(labels, stages, profileMinus)}
    </section>
    <section>
      <h2>カテゴリ別結果</h2>
      ${renderPdfResultTable_(labels, stages, totals)}
    </section>
    <section>
      <h2>注意領域・確認事項</h2>
      <div class="attention">
        <p><strong>注意領域:</strong> ${
          cautions.length > 0
            ? cautions.map((label) => `<span class="badge alert">${escapeHtmlForPdf_(label)}</span>`).join(' ')
            : '<span class="badge ok">なし</span>'
        }</p>
        <p><strong>職務必要要件マイナス:</strong> ${
          jobReqLowItems.length > 0
            ? `${escapeHtmlForPdf_(jobReqMinus !== null ? jobReqMinus : -jobReqLowItems.length)}（${jobReqLowItems.map((item) => `${escapeHtmlForPdf_(item.label)} 段階${escapeHtmlForPdf_(item.stage)}`).join(' / ')}）`
            : 'なし'
        }</p>
        <p><strong>手書き不一致:</strong> ${
          crossCheck.length > 0
            ? crossCheck.map((m) => `${escapeHtmlForPdf_(m.item)} 手書き${escapeHtmlForPdf_(m.handwritten)} / 再計算${escapeHtmlForPdf_(m.computed)}`).join('、')
            : 'なし'
        }</p>
      </div>
    </section>
    <p class="footer">出力日時: ${escapeHtmlForPdf_(generatedAt)} / システム再計算を正とする</p>
  </body>
</html>`;
}

function renderPdfProfileChart_(labels, stages, minus) {
  const width = 680;
  const left = 30;
  const right = 660;
  const top = 16;
  const bottom = 190;
  const minusNum = Number(minus);
  const adjust = minusNum < 0;
  const xAt = (index) => labels.length === 1 ? (left + right) / 2 : left + ((right - left) * index) / (labels.length - 1);
  const yAt = (stage) => bottom - ((bottom - top) * stage) / 5;
  const valueAt = (label, applyMinus) => {
    const stage = Number(stages[label]);
    if (!(stage >= 1 && stage <= 5)) return null;
    return applyMinus ? Math.max(0, stage + minusNum) : stage;
  };
  const buildLine = (applyMinus, stroke, dash) => {
    let segment = [];
    const segments = [];
    labels.forEach((label, index) => {
      const value = valueAt(label, applyMinus);
      if (value !== null) {
        segment.push(`${xAt(index)},${yAt(value)}`);
      } else if (segment.length > 0) {
        segments.push(segment);
        segment = [];
      }
    });
    if (segment.length > 0) segments.push(segment);
    return segments
      .filter((points) => points.length > 1)
      .map((points) => `<polyline points="${points.join(' ')}" fill="none" stroke="${stroke}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`)
      .join('');
  };

  let svg = `<svg viewBox="0 0 ${width} 232" role="img" aria-label="カテゴリ別段階の折れ線グラフ">`;
  for (let stage = 1; stage <= 5; stage += 1) {
    svg += `<line x1="${left}" y1="${yAt(stage)}" x2="${right}" y2="${yAt(stage)}" stroke="#eeeeee"/>`;
    svg += `<text x="${left - 8}" y="${yAt(stage) + 4}" font-size="11" fill="#4d4d4d" text-anchor="end">${stage}</text>`;
  }
  if (adjust) svg += buildLine(true, '#e53935', '5 4');
  svg += buildLine(false, '#0017c1', '');

  if (adjust) {
    labels.forEach((label, index) => {
      const value = valueAt(label, true);
      if (value !== null) {
        svg += `<circle cx="${xAt(index)}" cy="${yAt(value)}" r="4" fill="#e53935"/>`;
      }
    });
  }

  labels.forEach((label, index) => {
    const stage = Number(stages[label]);
    const x = xAt(index);
    if (stage >= 1 && stage <= 5) {
      const caution = stage <= 2;
      svg += `<circle cx="${x}" cy="${yAt(stage)}" r="5" fill="${caution ? '#8b0000' : '#0017c1'}"/>`;
      svg += `<text x="${x}" y="${yAt(stage) - 10}" font-size="12" font-weight="700" fill="${caution ? '#8b0000' : '#1a1a1a'}" text-anchor="middle">${stage}</text>`;
    } else {
      svg += `<text x="${x}" y="${yAt(2.5)}" font-size="12" fill="#4d4d4d" text-anchor="middle">-</text>`;
    }
    svg += `<text x="${x}" y="220" font-size="11" fill="#4d4d4d" text-anchor="middle">${escapeHtmlForPdf_(shortLabelForPdf_(label))}</text>`;
  });
  svg += '</svg>';
  return svg;
}

function renderPdfResultTable_(labels, stages, totals) {
  const rows = labels.map((label) => {
    const stage = Number(stages[label]);
    const score = isBlankForPdf_(totals[label]) ? '-' : String(totals[label]);
    return `<tr>
      <td>${escapeHtmlForPdf_(label)}</td>
      <td>${escapeHtmlForPdf_(score)}</td>
      <td>${stage >= 1 && stage <= 5 ? escapeHtmlForPdf_(stage) : '-'}</td>
      <td>${escapeHtmlForPdf_(evaluationTextForPdf_(stage))}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th>項目</th><th>点数</th><th>段階</th><th>評価</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function evaluationTextForPdf_(stage) {
  if (!(stage >= 1 && stage <= 5)) return '-';
  if (stage >= 4) return '安定';
  if (stage === 3) return '標準';
  return '注意';
}

function sortDashboardLabelsForPdf_(labels) {
  return labels
    .map((label, index) => ({ label, index, order: dashboardLabelOrderForPdf_(label) }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.index - b.index;
    })
    .map((item) => item.label);
}

function dashboardLabelOrderForPdf_(label) {
  const circledOrder = {
    '①': 1,
    '②': 2,
    '③': 3,
    '④': 4,
    '⑤': 5,
    '⑥': 6,
    '⑦': 7,
    '⑧': 8,
    '⑨': 9,
    '⑩': 10,
  };
  const value = String(label || '').trim();
  const circled = value.match(/^[①②③④⑤⑥⑦⑧⑨⑩]/);
  if (circled) return circledOrder[circled[0]];
  const numbered = value.match(/^(\d{1,2})(?:[.)、．\s]|$)/);
  if (numbered) return Number(numbered[1]);
  return Number.MAX_SAFE_INTEGER;
}

function shortLabelForPdf_(label) {
  const circled = String(label || '').match(/^[①-⑨⑩]/);
  if (circled) return circled[0];
  return String(label || '').slice(0, 4);
}

function numericOrNullForPdf_(value) {
  if (isBlankForPdf_(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isBlankForPdf_(value) {
  return value === '' || value === undefined || value === null;
}

function escapeHtmlForPdf_(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (char) => {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
  });
}

function sanitizePdfFileName_(value) {
  const cleaned = String(value || 'result')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  return cleaned || 'result';
}

function getDemoData(accessCode) {
  assertAuthorizedUser_(accessCode);
  return {
    candidates: getCandidatesInternal_(),
    reviewQueue: getReviewQueueInternal_(),
  };
}

function getOrCreateSheet_(ss, name) {
  const existing = ss.getSheetByName(name);
  if (existing) return existing;

  try {
    return ss.insertSheet(name);
  } catch (error) {
    const createdByConcurrentRun = ss.getSheetByName(name);
    if (createdByConcurrentRun) return createdByConcurrentRun;
    throw error;
  }
}

function ensureHeader_(sheet, expectedHeaders) {
  const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), expectedHeaders.length)).getValues()[0];
  const hasAnyHeader = current.some((value) => String(value || '').trim());
  if (!hasAnyHeader) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    sheet.setFrozenRows(1);
    return;
  }

  const currentSet = new Set(current.filter((value) => String(value || '').trim()));
  const missing = expectedHeaders.filter((header) => !currentSet.has(header));
  if (missing.length > 0) {
    let missingIndex = 0;
    current.forEach((value, index) => {
      if (missingIndex >= missing.length) return;
      if (!String(value || '').trim()) {
        sheet.getRange(1, index + 1).setValue(missing[missingIndex]);
        missingIndex += 1;
      }
    });
    if (missingIndex < missing.length) {
      sheet
        .getRange(1, sheet.getLastColumn() + 1, 1, missing.length - missingIndex)
        .setValues([missing.slice(missingIndex)]);
    }
  }
}

function appendObject_(sheet, object) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map((header) => sanitizeSheetValue_(object[header] === undefined ? '' : object[header]));
  sheet.appendRow(row);
}

function readTable_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) return { headers: [], rows: [] };
  const headers = values[0].map(String);
  const rows = values.slice(1)
    .filter((row) => row.some((value) => value !== ''))
    .map((row) => {
      const object = {};
      headers.forEach((header, index) => {
        object[header] = row[index];
      });
      return object;
    });
  return { headers, rows };
}

function readObjects_(sheet) {
  return readTable_(sheet).rows;
}

function findById_(sheet, key, value) {
  return readObjects_(sheet).find((row) => row[key] === value) || null;
}

function setCellByHeader_(sheet, headers, row, header, value) {
  const column = headers.indexOf(header) + 1;
  if (column <= 0) throw new Error(`Header not found: ${header}`);
  sheet.getRange(row, column).setValue(sanitizeSheetValue_(value));
}

function formatTextCellByHeader_(sheet, headers, row, header) {
  const column = headers.indexOf(header) + 1;
  if (column <= 0) throw new Error(`Header not found: ${header}`);
  sheet.getRange(row, column).setNumberFormat('@');
}

function validateRequired_(payload, keys) {
  keys.forEach((key) => {
    if (!payload || !payload[key]) throw new Error(`${key} is required`);
  });
}

function sanitizeSheetValue_(value) {
  if (typeof value !== 'string') return value;
  if (FORMULA_INJECTION_PATTERN.test(value)) return `'${value}`;
  return value;
}

function saveUploadedFile_(candidateId, file) {
  const folderId = String(getConfig_('UPLOAD_FOLDER_ID') || '').trim();
  if (!folderId) throw new Error('UPLOAD_FOLDER_ID is required');

  const upload = validateUpload_(candidateId, file);
  const folder = DriveApp.getFolderById(folderId);
  const blob = Utilities.newBlob(upload.bytes, upload.mimeType, upload.name);
  const saved = folder.createFile(blob);
  return saved.getUrl();
}

function validateUpload_(candidateId, file) {
  if (!file || typeof file !== 'object') throw new Error('file is required');

  const mimeType = normalizeUploadMimeType_(file.mimeType, file.name);
  if (!ALLOWED_UPLOAD_MIME_TYPES[mimeType]) {
    throw new Error(`Unsupported upload MIME type: ${file.mimeType || ''}`);
  }

  const claimedSize = Number(file.size || 0);
  if (Number.isFinite(claimedSize) && claimedSize > MAX_UPLOAD_BYTES) {
    throw new Error(`Upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }

  const base64 = String(file.base64 || '').replace(/\s/g, '');
  if (!base64) throw new Error('file.base64 is required');
  if (base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('file.base64 is invalid');
  }
  if (estimateBase64DecodedBytes_(base64) > MAX_UPLOAD_BYTES) {
    throw new Error(`Upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }

  const bytes = Utilities.base64Decode(base64);
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }
  if (!uploadBytesMatchMime_(bytes, mimeType)) {
    throw new Error(`Upload content does not match MIME type: ${mimeType}`);
  }

  return {
    bytes,
    mimeType,
    name: sanitizeUploadFileName_(file.name, candidateId, mimeType),
  };
}

function normalizeUploadMimeType_(mimeType, fileName) {
  let normalized = String(mimeType || '').trim().toLowerCase();
  if (normalized === 'image/jpg') normalized = 'image/jpeg';
  if (ALLOWED_UPLOAD_MIME_TYPES[normalized]) return normalized;

  const extension = getFileExtension_(fileName);
  const fromExtension = UPLOAD_EXTENSION_MIME_TYPES[extension];
  if ((!normalized || normalized === 'application/octet-stream') && fromExtension) {
    return fromExtension;
  }
  return normalized;
}

function getFileExtension_(fileName) {
  const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function sanitizeUploadFileName_(fileName, candidateId, mimeType) {
  const fallback = `${candidateId}.${extensionForMime_(mimeType)}`;
  const cleaned = String(fileName || '')
    .replace(/[\u0000-\u001f\u007f/\\:]/g, '_')
    .trim();
  return (cleaned || fallback).slice(0, 120);
}

function extensionForMime_(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/heic') return 'heic';
  if (mimeType === 'image/heif') return 'heif';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'bin';
}

function estimateBase64DecodedBytes_(base64) {
  const padding = (base64.match(/=+$/) || [''])[0].length;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function uploadBytesMatchMime_(bytes, mimeType) {
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3
      && byteAt_(bytes, 0) === 0xff
      && byteAt_(bytes, 1) === 0xd8
      && byteAt_(bytes, 2) === 0xff;
  }
  if (mimeType === 'image/png') {
    return bytesStartWith_(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (mimeType === 'application/pdf') {
    return bytesStartWith_(bytes, [0x25, 0x50, 0x44, 0x46]);
  }
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    return isHeifBytes_(bytes);
  }
  return false;
}

function bytesStartWith_(bytes, signature) {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (byteAt_(bytes, i) !== signature[i]) return false;
  }
  return true;
}

function isHeifBytes_(bytes) {
  if (bytes.length < 12 || asciiBytes_(bytes, 4, 8) !== 'ftyp') return false;
  return /(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(
    asciiBytes_(bytes, 8, Math.min(bytes.length, 64)).toLowerCase()
  );
}

function asciiBytes_(bytes, start, end) {
  let text = '';
  for (let i = start; i < end; i += 1) {
    text += String.fromCharCode(byteAt_(bytes, i));
  }
  return text;
}

function byteAt_(bytes, index) {
  return bytes[index] & 0xff;
}

function normalizeCells_(cells) {
  // Python側の契約 (docs/cell-contract.md): { s01: {value: 0-3|null, confidence, reason?} }
  const normalized = {};
  CELL_KEYS.forEach((key) => {
    const cell = cells[key] || {};
    const raw = cell.value;
    const value = raw === null || raw === undefined || raw === '' ? '' : Number(raw);
    normalized[key] = {
      value: [0, 1, 2, 3].includes(value) ? value : '',
      confidence: Number(cell.confidence || 0),
      reason: String(cell.reason || ''),
    };
  });
  return normalized;
}

const REVIEW_REASON_LABELS = {
  blank: '空欄',
  multiple: '複数○',
  low_confidence: '低信頼度',
};

function buildCellReviewItems_(candidateId, cells, imageLinks) {
  const minConfidence = Number(getConfig_('RECOGNITION_MIN_CONFIDENCE') || 0.8);
  const items = [];
  CELL_KEYS.forEach((key) => {
    const cell = cells[key];
    const reasons = [];

    if (cell.value === '') {
      reasons.push(REVIEW_REASON_LABELS[cell.reason] || REVIEW_REASON_LABELS.low_confidence);
    } else if (cell.confidence > 0 && cell.confidence < minConfidence) {
      reasons.push(REVIEW_REASON_LABELS.low_confidence);
    }

    if (reasons.length > 0) {
      items.push({
        review_id: Utilities.getUuid(),
        candidate_id: candidateId,
        cell_key: key,
        detected: cell.value,
        reason: reasons.join(', '),
        confidence: cell.confidence,
        image_link: imageLinks[key] || '',
        corrected_value: '',
        status: 'OPEN',
        resolved_by: '',
        resolved_at: '',
      });
    }
  });
  return items;
}

function averageCellConfidence_(cells) {
  const values = Object.values(cells).map((cell) => Number(cell.confidence)).filter((value) => value > 0);
  if (values.length === 0) return '';
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function upsertRawCells_(ss, candidateId, cells, confidenceAvg, unresolvedCount, pageIndex) {
  const sheet = ss.getSheetByName(SHEETS.rawCells);
  const table = readTable_(sheet);
  const rowIndex = table.rows.findIndex((row) => row.candidate_id === candidateId);
  const object = {
    candidate_id: candidateId,
    confidence_avg: confidenceAvg,
    unresolved_count: unresolvedCount,
    page_index: pageIndex === null || pageIndex === undefined ? '' : pageIndex,
    updated_at: new Date(),
  };
  CELL_KEYS.forEach((key) => {
    object[key] = cells[key].value;
  });

  if (rowIndex < 0) {
    appendObject_(sheet, object);
    return;
  }

  table.headers.forEach((header, index) => {
    if (object[header] !== undefined) {
      sheet.getRange(rowIndex + 2, index + 1).setValue(sanitizeSheetValue_(object[header]));
    }
  });
}

function replaceReviewItems_(ss, candidateId, reviewItems) {
  const sheet = ss.getSheetByName(SHEETS.reviewQueue);
  const table = readTable_(sheet);
  const keptRows = table.rows.filter((row) => row.candidate_id !== candidateId || row.status === 'RESOLVED');
  const values = [table.headers].concat(
    keptRows.map((row) => table.headers.map((header) => (
      sanitizeSheetValue_(row[header] === undefined ? '' : row[header])
    )))
  );
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, table.headers.length).setValues(values);
  reviewItems.forEach((item) => appendObject_(sheet, item));
}

function patchRawCell_(ss, candidateId, cellKey, value) {
  const sheet = ss.getSheetByName(SHEETS.rawCells);
  const table = readTable_(sheet);
  const rowIndex = table.rows.findIndex((row) => row.candidate_id === candidateId);
  if (rowIndex < 0) throw new Error(`Raw cells not found: ${candidateId}`);
  if (!CELL_KEYS.includes(cellKey)) throw new Error(`Invalid cell key: ${cellKey}`);
  setCellByHeader_(sheet, table.headers, rowIndex + 2, cellKey, value);
}

function refreshUnresolvedCount_(ss, candidateId) {
  // NOTICE(手書き不一致など)は情報共有のみで、未解決には数えない
  const openItems = readObjects_(ss.getSheetByName(SHEETS.reviewQueue))
    .filter((row) => row.candidate_id === candidateId && row.status === 'OPEN');
  const sheet = ss.getSheetByName(SHEETS.rawCells);
  const table = readTable_(sheet);
  const rowIndex = table.rows.findIndex((row) => row.candidate_id === candidateId);
  if (rowIndex >= 0) {
    setCellByHeader_(sheet, table.headers, rowIndex + 2, 'unresolved_count', openItems.length);
    setCellByHeader_(sheet, table.headers, rowIndex + 2, 'updated_at', new Date());
  }
  updateCandidateStatus_(ss, candidateId, openItems.length > 0 ? 'REVIEW_REQUIRED' : 'READY_TO_FINALIZE');
}

function updateCandidateStatus_(ss, candidateId, status) {
  const sheet = ss.getSheetByName(SHEETS.candidates);
  const table = readTable_(sheet);
  const rowIndex = table.rows.findIndex((row) => row.candidate_id === candidateId);
  if (rowIndex >= 0) {
    setCellByHeader_(sheet, table.headers, rowIndex + 2, 'status', status);
  }
}

function extractCells_(rawCellsRow) {
  // RawCells行 → 採点コア(scoreSheet)のセル形式。空欄は value:null として issue になる
  const cells = {};
  CELL_KEYS.forEach((key) => {
    const raw = rawCellsRow[key];
    const value = raw === '' || raw === null || raw === undefined ? null : Number(raw);
    cells[key] = {
      value: [0, 1, 2, 3].includes(value) ? value : null,
      confidence: 1,
    };
  });
  return cells;
}

// 総合ランクの集計対象段階は①〜④のみ。
// ⑤〜⑨は職務必要要件マイナスとして扱い、総合ランクの段階2以下カウントには含めない。
// 応答態度は「段階が高いほど悪い」逆スケールのため除外する。
function rankStageValues_(categoryStages) {
  return Object.keys(categoryStages)
    .filter((label) => /^[①②③④]/.test(label))
    .map((label) => Number(categoryStages[label]))
    .filter((value) => value > 0);
}

function calculateFallbackRank_(categoryStages) {
  const stages = rankStageValues_(categoryStages);
  if (stages.length === 0) {
    return { rank: '', minusPoints: '', note: '段階得点がありません' };
  }

  const lowStageCount = stages.filter((value) => value <= 2).length;
  const minusPoints = calculateResponseAttitudeMinusPoints_(categoryStages);

  if (lowStageCount <= 0) {
    return { rank: 'A', minusPoints, note: '段階2以下の項目はありません' };
  }
  if (lowStageCount === 1) {
    return { rank: 'B', minusPoints, note: '段階2以下の項目が1件あります' };
  }
  if (lowStageCount === 2) {
    return { rank: 'C', minusPoints, note: '段階2以下の項目が2件あります' };
  }
  return { rank: 'D', minusPoints, note: '段階2以下の項目が3件以上あります' };
}

function calculateResponseAttitudeMinusPoints_(categoryStages) {
  const responseAttitude = Number(categoryStages['応答態度'] || 0);
  if (responseAttitude >= 5) return -2;
  if (responseAttitude >= 4) return -1;
  return 0;
}

function upsertResult_(ss, result) {
  const sheet = ss.getSheetByName(SHEETS.results);
  const table = readTable_(sheet);
  const rowIndex = table.rows.findIndex((row) => row.candidate_id === result.candidate_id);
  if (rowIndex < 0) {
    appendObject_(sheet, result);
    return;
  }
  table.headers.forEach((header, index) => {
    if (result[header] !== undefined) {
      sheet.getRange(rowIndex + 2, index + 1).setValue(sanitizeSheetValue_(result[header]));
    }
  });
}

function assertWorkbookReady_() {
  const ss = getWorkbook_();
  Object.keys(HEADERS).forEach((sheetName) => {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      if (['Users', 'ApiOperations', 'ApiNonces'].includes(sheetName)) {
        sheet = getOrCreateSheet_(ss, sheetName);
        ensureHeader_(sheet, HEADERS[sheetName]);
        return;
      }
      throw new Error(`Sheet is missing: ${sheetName}. Run setupProductionWorkbook first.`);
    }
    const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), HEADERS[sheetName].length)).getValues()[0];
    const missing = HEADERS[sheetName].filter((header) => !headers.includes(header));
    if (missing.length > 0) {
      // 列追加リリース後に手動セットアップ不要とするため自己修復化
      ensureHeader_(sheet, HEADERS[sheetName]);
    }
  });
}

function getWorkbook_() {
  const spreadsheetId = String(getScriptProperty_(SCRIPT_PROPERTY_KEYS.spreadsheetId) || DEFAULT_SPREADSHEET_ID).trim();
  if (spreadsheetId) {
    return SpreadsheetApp.openById(spreadsheetId);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Spreadsheet is not configured. Set Script Property SPREADSHEET_ID.');
  }
  return ss;
}

function getWorkbookLock_() {
  return LockService.getDocumentLock() || LockService.getScriptLock();
}

function assertScoringRulesReady_() {
  // ItemMaster(文字→項目)とScoreBands(項目別バンド)の整合性を検証する。
  // バンド未確定の項目があるうちは採点を拒否し、誤った段階得点を出さない。
  const ss = getWorkbook_();
  const itemMaster = buildItemMasterFromRows(readObjects_(ss.getSheetByName(SHEETS.itemMaster)));
  const bands = buildBandsFromRows(readObjects_(ss.getSheetByName(SHEETS.scoreBands)));
  const errors = validateMasters(itemMaster, bands);
  if (errors.length > 0) {
    throw new Error(`採点マスタが未整備です: ${errors.join(' / ')}`);
  }
}

function getConfig_(key) {
  const sheet = getWorkbook_().getSheetByName(SHEETS.config);
  const row = readObjects_(sheet).find((item) => item.key === key);
  return row ? row.value : '';
}

function getConfigBoolean_(key) {
  return String(getConfig_(key) || '').toLowerCase() === 'true';
}

function assertAuthorizedUser_(accessCode) {
  // WebアプリのURLを知っている人は通常操作を利用できる運用。
  // setup/seed などの管理者向け関数は assertAdmin_ で別途制限する。
  return true;
}

function assertAdmin_() {
  const email = getActiveUserEmail_();
  if (!isAdminEmail_(email)) throw new Error('Admin authorization required');
}

function isAuthorizedEmail_(email) {
  const normalized = normalizeEmail_(email);
  if (!normalized) return false;

  const users = getEmailSet_(SCRIPT_PROPERTY_KEYS.authorizedUsers);
  const admins = getEmailSet_(SCRIPT_PROPERTY_KEYS.adminUsers);
  if (users.has(normalized) || admins.has(normalized)) return true;
  return users.size === 0 && admins.size === 0 && isBootstrapAdmin_(normalized);
}

function isAdminEmail_(email) {
  const normalized = normalizeEmail_(email);
  if (!normalized) return false;

  const admins = getEmailSet_(SCRIPT_PROPERTY_KEYS.adminUsers);
  if (admins.has(normalized)) return true;
  return admins.size === 0 && isBootstrapAdmin_(normalized);
}

function isBootstrapAdmin_(email) {
  const effective = getEffectiveUserEmail_();
  return Boolean(email && effective && email === effective);
}

function isValidAppAccessCode_(accessCode) {
  const expected = String(getScriptProperty_(SCRIPT_PROPERTY_KEYS.appAccessCode) || '').trim();
  const provided = String(accessCode || '').trim();
  return Boolean(expected && provided && constantTimeEqual_(provided, expected));
}

function getEmailSet_(propertyKey) {
  return new Set(parseDelimitedList_(getScriptProperty_(propertyKey)).map(normalizeEmail_).filter(Boolean));
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function getActiveUserEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (error) {
    return '';
  }
}

function getEffectiveUserEmail_() {
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (error) {
    return '';
  }
}

function getTrustedRecognitionEndpoint_() {
  const endpointUrl = String(getConfig_('RECOGNITION_ENDPOINT_URL') || '').trim();
  if (!endpointUrl) throw new Error('RECOGNITION_ENDPOINT_URL is not configured');

  const parsed = parseHttpsUrl_(endpointUrl, 'RECOGNITION_ENDPOINT_URL');
  const allowedHosts = getRecognitionEndpointHosts_();
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`RECOGNITION_ENDPOINT_URL host is not allowed: ${parsed.hostname}`);
  }
  return parsed.url;
}

function getRecognitionEndpointHosts_() {
  const hosts = parseDelimitedList_(getScriptProperty_(SCRIPT_PROPERTY_KEYS.recognitionEndpointHosts))
    .map(normalizeAllowedEndpointHost_);
  if (hosts.length === 0) {
    throw new Error('RECOGNITION_ENDPOINT_HOSTS is not configured');
  }
  return new Set(hosts);
}

function normalizeAllowedEndpointHost_(entry) {
  const value = String(entry || '').trim();
  if (/^https:\/\//i.test(value)) {
    return parseHttpsUrl_(value, 'RECOGNITION_ENDPOINT_HOSTS').hostname;
  }
  return validateHostname_(value, 'RECOGNITION_ENDPOINT_HOSTS');
}

function parseHttpsUrl_(value, label) {
  const text = String(value || '').trim();
  const match = text.match(/^https:\/\/([^/?#@:]+)(?::(\d{1,5}))?(?:\/[^?#]*)?(?:\?[^#]*)?$/i);
  if (!match) {
    throw new Error(`${label} must be an HTTPS URL without credentials or fragments`);
  }

  const hostname = validateHostname_(match[1], label);
  const port = match[2] ? Number(match[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) {
    throw new Error(`${label} has an invalid port`);
  }
  return { url: text, hostname };
}

function validateHostname_(host, label) {
  const normalized = String(host || '').trim().toLowerCase();
  const labelPattern = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const hostnamePattern = new RegExp(`^${labelPattern}(?:\\.${labelPattern})*$`);
  if (!normalized || normalized.length > 253 || !hostnamePattern.test(normalized)) {
    throw new Error(`${label} contains an invalid host: ${host}`);
  }
  return normalized;
}

function parseDelimitedList_(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 採点表マスタの初期投入（管理者がエディタから手動実行する）。
 * - ItemMaster: 文字→項目対応（CheqScoring.gs の DEFAULT_ITEM_MASTER）
 * - ScoreBands: 全10項目の段階バンド（ブランク原本 4.HEIC で確定済み）
 * 投入後すぐ採点可能。値を変えたい場合はシートを直接編集する。
 */
function seedScoresheetMasters() {
  assertAdmin_();
  assertWorkbookReady_();
  const ss = getWorkbook_();

  const itemSheet = ss.getSheetByName(SHEETS.itemMaster);
  const existingItems = new Set(readObjects_(itemSheet).map((row) => row.item_key));
  DEFAULT_ITEM_MASTER.forEach((item, index) => {
    if (existingItems.has(item.key)) return;
    appendObject_(itemSheet, {
      item_key: item.key,
      label: item.label,
      letter: item.letter,
      is_attitude: item.isAttitude ? 'TRUE' : '',
      display_order: index + 1,
    });
  });

  const bandSheet = ss.getSheetByName(SHEETS.scoreBands);
  const existingBandKeys = new Set(readObjects_(bandSheet).map((row) => row.item_key));
  Object.keys(DEFAULT_BANDS).forEach((itemKey) => {
    if (existingBandKeys.has(itemKey)) return;
    DEFAULT_BANDS[itemKey].forEach((band) => {
      appendObject_(bandSheet, {
        item_key: itemKey,
        min_score: band.min,
        max_score: band.max,
        stage: band.stage,
      });
    });
  });

  logAudit_('SEED_SCORESHEET_MASTERS', '', {
    items: DEFAULT_ITEM_MASTER.length,
    bandItems: Object.keys(DEFAULT_BANDS),
  });
  return { ok: true, note: '全10項目の文字対応・段階バンドを投入しました' };
}

/**
 * 動作確認用: 実物サンプル「適性テスト用（応答態度1）」の採点表データを流し込み、
 * 取り込み→採点確定→ダッシュボード表示まで一気通貫で検証する。
 * Cloud Run(OCR API)なしで実行できる。エディタから手動実行する。
 *
 * 期待結果: 項目合計 ①10 ②15 ③15 ④16 ⑤14 ⑥14 ⑦14 ⑧10 ⑨16 応答態度1
 *           段階 ①2 ②4 ③3 ④3 ⑤3 ⑥3 ⑦4 ⑧2 ⑨3 応答態度1 / マイナス0
 *           ⑦のみ手書き合計(13)と再計算(14)が不一致 → ReviewQueueにNOTICE
 */
function demoImportSampleScoresheet() {
  assertAdmin_();
  // サンプル採点表の行得点（上ブロックA〜J / 下ブロックA〜J）
  const rowScores = {
    A1: 8, B1: 5, C1: 8, D1: 8, E1: 7, F1: 5, G1: 8, H1: 7, I1: 5, J1: 0,
    A2: 7, B2: 5, C2: 6, D2: 8, E2: 7, F2: 5, G2: 8, H2: 7, I2: 10, J2: 1,
  };

  const registered = registerCandidate({
    name: 'サンプル検証（応答態度1）',
    testDate: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
    memo: 'demoImportSampleScoresheet による動作確認',
  });
  const candidateId = registered.candidateId;

  // 行得点どおりになるようセル値(0〜3)を合成する（3,3,2,0 のように前詰め）
  const letters = 'ABCDEFGHIJ';
  const cells = {};
  for (let block = 0; block < 2; block += 1) {
    for (let li = 0; li < letters.length; li += 1) {
      let remain = rowScores[`${letters[li]}${block + 1}`];
      for (let pos = 1; pos <= 4; pos += 1) {
        const value = Math.min(3, remain);
        remain -= value;
        const key = `s${String(block * 40 + li * 4 + pos).padStart(2, '0')}`;
        cells[key] = { value, confidence: 0.95 };
      }
    }
  }

  // 手書き合計点（⑦だけ用紙の手書きが13で、再計算14と食い違うサンプル）
  const ss = getWorkbook_();
  const handwritten = {
    self_control: 10, communication: 15, situation: 15, stress: 16, proactivity: 14,
    goal: 14, positive: 13, teamwork: 10, hospitality: 16, attitude: 1,
  };
  Object.keys(handwritten).forEach((itemKey) => {
    appendObject_(ss.getSheetByName(SHEETS.handwrittenTotals), {
      candidate_id: candidateId,
      item_key: itemKey,
      total: handwritten[itemKey],
    });
  });

  importRecognitionResult(candidateId, { cells, pageIndex: 0 });
  const dashboard = calculateCandidateResult(candidateId);
  Logger.log(JSON.stringify(dashboard.result, null, 2));
  return dashboard;
}

function seedProductionConfig_() {
  const ss = getWorkbook_();
  const sheet = ss.getSheetByName(SHEETS.config);
  const existingKeys = new Set(readObjects_(sheet).map((row) => row.key));
  PRODUCTION_CONFIG_DEFAULTS.forEach((config) => {
    if (!existingKeys.has(config.key)) {
      appendObject_(sheet, config);
    }
  });
}

function seedApiUsersPlaceholder_() {
  const ss = getWorkbook_();
  const sheet = ss.getSheetByName(SHEETS.users);
  if (!sheet || readObjects_(sheet).length > 0) return;

  appendObject_(sheet, {
    email: '',
    role: 'admin',
    active: 'FALSE',
  });

  try {
    sheet.getRange(2, 1).setNote('Cloudflare Functions API 管理者のメールアドレスを入力し、active を TRUE にしてください。');
  } catch (error) {
    // Notes are best-effort metadata; setup should still succeed without them.
  }
}

function getPostBody_(event) {
  if (!event || !event.postData || !event.postData.contents) {
    throw new Error('Request body is empty');
  }
  return event.postData.contents;
}

function parsePostPayload_(bodyText) {
  return JSON.parse(bodyText);
}

function assertWebhookAuthorized_(event, bodyText) {
  const secret = getScriptProperty_(SCRIPT_PROPERTY_KEYS.webhookSecret);
  if (!secret) throw new Error('RECOGNITION_WEBHOOK_SECRET is not configured');

  const timestamp = getWebhookRequestParam_(event, WEBHOOK_TIMESTAMP_PARAM);
  const signature = getWebhookRequestParam_(event, WEBHOOK_SIGNATURE_PARAM);
  if (!timestamp || !signature) throw new Error('Unauthorized');

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) throw new Error('Unauthorized');
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampNumber) > WEBHOOK_MAX_CLOCK_SKEW_SECONDS) {
    throw new Error('Unauthorized');
  }

  const expected = `sha256=${hmacSha256Hex_(`${timestamp}.${bodyText}`, secret)}`;
  if (!constantTimeEqual_(signature, expected)) throw new Error('Unauthorized');
}

function getWebhookRequestParam_(event, key) {
  if (!event || !event.parameter) return '';
  return String(event.parameter[key] || '');
}

function hmacSha256Hex_(value, secret) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(value, secret));
}

function bytesToHex_(bytes) {
  return bytes.map((byte) => {
    const unsigned = byte < 0 ? byte + 256 : byte;
    return unsigned.toString(16).padStart(2, '0');
  }).join('');
}

function constantTimeEqual_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= a.charCodeAt(i % Math.max(a.length, 1)) ^ b.charCodeAt(i % Math.max(b.length, 1));
  }
  return diff === 0;
}

function getScriptProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function safeJsonParse_(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getActor_() {
  // userinfo.email スコープ未付与でも処理を止めない（監査の実行者は unknown になる）
  try {
    return Session.getActiveUser().getEmail() || 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

function logAudit_(action, candidateId, detail) {
  const ss = getWorkbook_();
  appendObject_(ss.getSheetByName(SHEETS.auditLog), {
    logged_at: new Date(),
    actor: getActor_(),
    action,
    candidate_id: candidateId || '',
    detail_json: JSON.stringify(detail || {}),
  });
}
