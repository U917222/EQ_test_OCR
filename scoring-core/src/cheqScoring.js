"use strict";

/**
 * CHEQ採点表(page.5) 採点コア（純粋関数）。
 *
 * セル契約は docs/cell-contract.md を正とする:
 *   - セルキー: s01〜s80（block*40 + letterIndex*4 + pos）
 *   - 値: 0〜3 の整数。判定不能は null + reason
 *   - 行キー: A1〜J1(上ブロック) / A2〜J2(下ブロック)
 *
 * 本番ではマスタ(itemMaster/bands)を保存層から読んで渡す。
 * DEFAULT_ITEM_MASTER / DEFAULT_BANDS はローカルテストとシード用。
 */

var CHEQ_LETTERS = "ABCDEFGHIJ";
var CHEQ_CELLS_PER_ROW = 4;
var CHEQ_BLOCKS = 2;

/** セルキーを契約どおり採番する。block: 0=上,1=下 / letter: A〜J / pos: 1〜4 */
function cellKey(block, letter, pos) {
  var letterIndex = CHEQ_LETTERS.indexOf(letter);
  if (block < 0 || block >= CHEQ_BLOCKS || letterIndex < 0 || pos < 1 || pos > CHEQ_CELLS_PER_ROW) {
    throw new Error("invalid cell: block=" + block + " letter=" + letter + " pos=" + pos);
  }
  var index = block * 40 + letterIndex * CHEQ_CELLS_PER_ROW + (pos - 1);
  var nn = String(index + 1);
  return "s" + (nn.length < 2 ? "0" + nn : nn);
}

function rowKey(block, letter) {
  return letter + String(block + 1);
}

/**
 * 行得点を計算する。
 * null セルは行得点から除外して仮計算し、issues に積む（確認キュー行き）。
 * @param {Object} cells - { s01: {value: 0-3|null, confidence, reason?}, ... }
 * @returns {{scores: Object, issues: Array<{cell, row, reason}>}}
 */
function computeRowScores(cells) {
  var scores = {};
  var issues = [];
  for (var block = 0; block < CHEQ_BLOCKS; block++) {
    for (var li = 0; li < CHEQ_LETTERS.length; li++) {
      var letter = CHEQ_LETTERS[li];
      var row = rowKey(block, letter);
      var sum = 0;
      for (var pos = 1; pos <= CHEQ_CELLS_PER_ROW; pos++) {
        var key = cellKey(block, letter, pos);
        var cell = cells[key];
        if (!cell || cell.value === null || cell.value === undefined) {
          issues.push({ cell: key, row: row, reason: (cell && cell.reason) || "blank" });
        } else {
          sum += cell.value;
        }
      }
      scores[row] = sum;
    }
  }
  return { scores: scores, issues: issues };
}

/**
 * 同字ペア加算（上ブロック + 下ブロック）で項目合計を出す。
 * @param {Object} rowScores - { A1: 8, ..., J2: 1 }
 * @param {Array} itemMaster - [{key, label, letter, isAttitude?}, ...]
 * @returns {Object} { itemKey: 合計点 }
 */
function computeItemTotals(rowScores, itemMaster) {
  var totals = {};
  for (var i = 0; i < itemMaster.length; i++) {
    var item = itemMaster[i];
    totals[item.key] = rowScores[item.letter + "1"] + rowScores[item.letter + "2"];
  }
  return totals;
}

/**
 * 項目別バンドで段階得点(1〜5)を出す。
 * バンド未登録・範囲外は null（誤った段階を出さない）。
 * @param {Object} itemTotals - { itemKey: 合計点 }
 * @param {Object} bands - { itemKey: [{min, max, stage}, ...] }
 * @returns {Object} { itemKey: 1-5|null }
 */
function computeStages(itemTotals, bands) {
  var stages = {};
  for (var key in itemTotals) {
    stages[key] = null;
    var itemBands = bands[key];
    if (!itemBands) continue;
    for (var i = 0; i < itemBands.length; i++) {
      var b = itemBands[i];
      if (itemTotals[key] >= b.min && itemTotals[key] <= b.max) {
        stages[key] = b.stage;
        break;
      }
    }
  }
  return stages;
}

/** 応答態度の段階→マイナスポイント。4→-1, 5→-2, それ以外(未確定含む)→0 */
function minusPointsForAttitudeStage(stage) {
  if (stage === 5) return -2;
  if (stage === 4) return -1;
  return 0;
}

function isJobRequirementItem(item) {
  if (!item || item.isAttitude) return false;
  var first = String(item.label || "").charAt(0);
  return first === "⑤" || first === "⑥" || first === "⑦" || first === "⑧" || first === "⑨";
}

function jobRequirementLowStageItems(stages, itemMaster) {
  var items = [];
  for (var i = 0; i < itemMaster.length; i++) {
    var item = itemMaster[i];
    if (!isJobRequirementItem(item)) continue;
    var stage = stages[item.key];
    if (stage === 1 || stage === 2) {
      items.push({ key: item.key, label: item.label, stage: stage });
    }
  }
  return items;
}

function minusPointsForJobRequirements(stages, itemMaster) {
  var n = jobRequirementLowStageItems(stages, itemMaster).length;
  return n === 0 ? 0 : -n;
}

/**
 * システム再計算と手書き合計点の不一致を検出する。
 * 手書きが渡されていない項目はスキップ。
 * @returns {Array<{item, computed, handwritten}>}
 */
function crossCheck(itemTotals, handwrittenTotals) {
  var mismatches = [];
  if (!handwrittenTotals) return mismatches;
  for (var key in itemTotals) {
    if (!(key in handwrittenTotals)) continue;
    if (itemTotals[key] !== handwrittenTotals[key]) {
      mismatches.push({ item: key, computed: itemTotals[key], handwritten: handwrittenTotals[key] });
    }
  }
  return mismatches;
}

function findAttitudeKey(itemMaster) {
  for (var i = 0; i < itemMaster.length; i++) {
    if (itemMaster[i].isAttitude) return itemMaster[i].key;
  }
  return null;
}

/**
 * セル→総合まで一気通貫の採点。
 * @param {Object} cells - s01〜s80
 * @param {Object} opts - { itemMaster, bands, handwrittenTotals? }
 */
function scoreSheet(cells, opts) {
  var rows = computeRowScores(cells);
  var itemTotals = computeItemTotals(rows.scores, opts.itemMaster);
  var stages = computeStages(itemTotals, opts.bands);
  var attitudeKey = findAttitudeKey(opts.itemMaster);
  var attitudeStage = attitudeKey ? stages[attitudeKey] : null;
  var attitudeMinusPoints = minusPointsForAttitudeStage(attitudeStage);
  var jobRequirementLowItems = jobRequirementLowStageItems(stages, opts.itemMaster);
  var jobRequirementMinusPoints = jobRequirementLowItems.length === 0 ? 0 : -jobRequirementLowItems.length;
  return {
    rowScores: rows.scores,
    issues: rows.issues,
    itemTotals: itemTotals,
    stages: stages,
    attitudeStage: attitudeStage,
    attitudeMinusPoints: attitudeMinusPoints,
    jobRequirementMinusPoints: jobRequirementMinusPoints,
    jobRequirementLowItems: jobRequirementLowItems,
    minusPoints: jobRequirementMinusPoints,
    crossCheck: crossCheck(itemTotals, opts.handwrittenTotals),
  };
}

/**
 * シート(ItemMaster)の行オブジェクトから項目マスタを組み立てる。
 * 行: { item_key, label, letter, is_attitude, display_order }
 * is_attitude は TRUE/true/1 などの表記ゆれを吸収する。
 */
function buildItemMasterFromRows(rows) {
  return rows
    .slice()
    .sort(function (a, b) {
      return Number(a.display_order || 0) - Number(b.display_order || 0);
    })
    .map(function (row) {
      return {
        key: String(row.item_key || "").trim(),
        label: String(row.label || "").trim(),
        letter: String(row.letter || "").trim().toUpperCase(),
        isAttitude: parseBoolean(row.is_attitude),
      };
    });
}

/**
 * シート(ScoreBands)の行オブジェクトから項目別バンドを組み立てる。
 * 行: { item_key, min_score, max_score, stage }
 */
function buildBandsFromRows(rows) {
  var bands = {};
  rows.forEach(function (row) {
    var key = String(row.item_key || "").trim();
    if (!key) return;
    if (!bands[key]) bands[key] = [];
    bands[key].push({
      min: parseBandNumber(row.min_score),
      max: parseBandNumber(row.max_score),
      stage: parseBandNumber(row.stage),
    });
  });
  for (var key2 in bands) {
    bands[key2].sort(function (a, b) {
      return a.min - b.min;
    });
  }
  return bands;
}

/**
 * マスタの整合性を検証し、問題の説明文の配列を返す（空配列=OK）。
 * 呼び出し側は採点前にこれを実行し、エラーがあれば採点を拒否する。
 */
function validateMasters(itemMaster, bands) {
  var errors = [];
  if (!Array.isArray(itemMaster)) {
    return ["検査項目マスタは配列である必要があります"];
  }
  if (!bands || typeof bands !== "object" || Array.isArray(bands)) {
    errors.push("段階バンドマスタはオブジェクトである必要があります");
    bands = {};
  }
  if (itemMaster.length !== 10) {
    errors.push("検査項目は10件必要です（現在 " + itemMaster.length + " 件）");
  }
  var seenKeys = {};
  var validItemKeys = {};
  var seenLetters = {};
  var attitudeCount = 0;
  itemMaster.forEach(function (item, index) {
    var key = item && typeof item.key === "string" ? item.key : "";
    var trimmedKey = key.trim();
    var itemName = trimmedKey || "row " + String(index + 1);
    if (!item || typeof item.key !== "string" || !trimmedKey || key !== trimmedKey) {
      errors.push("item_key が不正です: " + itemName);
    }
    if (trimmedKey) {
      if (seenKeys[trimmedKey]) {
        errors.push("item_key が重複しています: " + trimmedKey);
      }
      seenKeys[trimmedKey] = true;
      validItemKeys[trimmedKey] = true;
    }

    var letter = item && item.letter !== undefined && item.letter !== null ? String(item.letter).trim().toUpperCase() : "";
    if (letter.length !== 1 || CHEQ_LETTERS.indexOf(letter) === -1) {
      errors.push("letter は A-J の1文字である必要があります: " + itemName);
    } else if (seenLetters[letter]) {
      errors.push("letter が重複しています: " + letter);
    } else {
      seenLetters[letter] = true;
    }
    if (item && item.isAttitude) attitudeCount++;
  });
  if (attitudeCount !== 1) {
    errors.push("応答態度の項目（is_attitude=TRUE）はちょうど1件必要です（現在 " + attitudeCount + " 件）");
  }

  for (var bandKey in bands) {
    if (Object.prototype.hasOwnProperty.call(bands, bandKey) && !validItemKeys[bandKey]) {
      errors.push("段階バンドの item_key が項目マスタに存在しません: " + bandKey);
    }
  }

  itemMaster.forEach(function (item) {
    var key = item && typeof item.key === "string" ? item.key.trim() : "";
    if (!key) return;
    validateBandsForItem(key, item.label, bands[key], errors);
  });
  return errors;
}

function validateBandsForItem(key, label, itemBands, errors) {
  if (!Array.isArray(itemBands) || itemBands.length === 0) {
    errors.push("段階バンドが未登録です: " + key + " (" + label + ")");
    return;
  }

  var ranges = [];
  var canCheckCoverage = true;
  itemBands.forEach(function (band, index) {
    var context = key + " #" + String(index + 1);
    if (!band || typeof band !== "object") {
      errors.push("段階バンド行が不正です: " + context);
      canCheckCoverage = false;
      return;
    }

    var min = band.min;
    var max = band.max;
    var stage = band.stage;
    if (!isFiniteNumber(min)) {
      errors.push("段階バンド min は有限数である必要があります: " + context);
      canCheckCoverage = false;
    }
    if (!isFiniteNumber(max)) {
      errors.push("段階バンド max は有限数である必要があります: " + context);
      canCheckCoverage = false;
    }
    if (!isFiniteNumber(stage)) {
      errors.push("段階バンド stage は有限数である必要があります: " + context);
    } else if (!isInteger(stage) || stage < 1 || stage > 5) {
      errors.push("段階バンド stage は1〜5の整数である必要があります: " + context);
    }

    if (!isFiniteNumber(min) || !isFiniteNumber(max)) return;
    if (!isInteger(min) || !isInteger(max)) {
      errors.push("段階バンド min/max は整数である必要があります: " + context);
      canCheckCoverage = false;
      return;
    }
    if (min < 0 || max > 24) {
      errors.push("段階バンド min/max は0〜24の範囲である必要があります: " + context);
      canCheckCoverage = false;
    }
    if (min > max) {
      errors.push("段階バンド min は max 以下である必要があります: " + context);
      canCheckCoverage = false;
    }
    ranges.push({ min: min, max: max, context: context });
  });

  if (!canCheckCoverage) return;

  ranges.sort(function (a, b) {
    if (a.min !== b.min) return a.min - b.min;
    return a.max - b.max;
  });
  var expectedMin = 0;
  for (var i = 0; i < ranges.length; i++) {
    var range = ranges[i];
    if (range.min > expectedMin) {
      errors.push("段階バンドに欠けがあります: " + key + " " + expectedMin + "〜" + (range.min - 1));
    } else if (range.min < expectedMin) {
      errors.push("段階バンドが重複しています: " + key + " " + range.min + "〜" + range.max);
    }
    if (range.max + 1 > expectedMin) {
      expectedMin = range.max + 1;
    }
  }
  if (expectedMin <= 24) {
    errors.push("段階バンドに欠けがあります: " + key + " " + expectedMin + "〜24");
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function isInteger(value) {
  return isFiniteNumber(value) && Math.floor(value) === value;
}

function parseBandNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "string" && value.trim() === "") return NaN;
  return Number(value);
}

function parseBoolean(value) {
  if (value === true) return true;
  var s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/**
 * 文字→検査項目マスタ（CHEQ採点表 page.5 / ブランク原本 4.HEIC で確定）。
 * 本番はシートマスタを正とし、これはテスト・シード用。
 */
var DEFAULT_ITEM_MASTER = [
  { key: "self_control", label: "①セルフコントロール", letter: "B" },
  { key: "communication", label: "②コミュニケーション", letter: "A" },
  { key: "situation", label: "③状況認識力", letter: "I" },
  { key: "stress", label: "④ストレス対処力", letter: "G" },
  { key: "proactivity", label: "⑤積極性", letter: "E" },
  { key: "goal", label: "⑥目標達成力", letter: "H" },
  { key: "positive", label: "⑦ポジティブ思考力", letter: "C" },
  { key: "teamwork", label: "⑧チームワーク", letter: "F" },
  { key: "hospitality", label: "⑨ホスピタリティー", letter: "D" },
  { key: "attitude", label: "応答態度", letter: "J", isAttitude: true },
];

/**
 * 項目別 段階バンド（CHEQ採点表 page.5 / ブランク原本 4.HEIC から読取・確定）。
 * 各項目の満点は 24（2行 × 4小問 × 最大3）。上段(段階5)は max=24 まで。
 */
var DEFAULT_BANDS = {
  self_control: [
    { min: 0, max: 8, stage: 1 },
    { min: 9, max: 10, stage: 2 },
    { min: 11, max: 12, stage: 3 },
    { min: 13, max: 14, stage: 4 },
    { min: 15, max: 24, stage: 5 },
  ],
  communication: [
    { min: 0, max: 9, stage: 1 },
    { min: 10, max: 12, stage: 2 },
    { min: 13, max: 14, stage: 3 },
    { min: 15, max: 16, stage: 4 },
    { min: 17, max: 24, stage: 5 },
  ],
  situation: [
    { min: 0, max: 9, stage: 1 },
    { min: 10, max: 12, stage: 2 },
    { min: 13, max: 15, stage: 3 },
    { min: 16, max: 17, stage: 4 },
    { min: 18, max: 24, stage: 5 },
  ],
  stress: [
    { min: 0, max: 12, stage: 1 },
    { min: 13, max: 14, stage: 2 },
    { min: 15, max: 16, stage: 3 },
    { min: 17, max: 18, stage: 4 },
    { min: 19, max: 24, stage: 5 },
  ],
  proactivity: [
    { min: 0, max: 11, stage: 1 },
    { min: 12, max: 13, stage: 2 },
    { min: 14, max: 15, stage: 3 },
    { min: 16, max: 17, stage: 4 },
    { min: 18, max: 24, stage: 5 },
  ],
  goal: [
    { min: 0, max: 9, stage: 1 },
    { min: 10, max: 12, stage: 2 },
    { min: 13, max: 14, stage: 3 },
    { min: 15, max: 16, stage: 4 },
    { min: 17, max: 24, stage: 5 },
  ],
  positive: [
    { min: 0, max: 8, stage: 1 },
    { min: 9, max: 11, stage: 2 },
    { min: 12, max: 13, stage: 3 },
    { min: 14, max: 16, stage: 4 },
    { min: 17, max: 24, stage: 5 },
  ],
  teamwork: [
    { min: 0, max: 8, stage: 1 },
    { min: 9, max: 10, stage: 2 },
    { min: 11, max: 13, stage: 3 },
    { min: 14, max: 16, stage: 4 },
    { min: 17, max: 24, stage: 5 },
  ],
  hospitality: [
    { min: 0, max: 12, stage: 1 },
    { min: 13, max: 15, stage: 2 },
    { min: 16, max: 17, stage: 3 },
    { min: 18, max: 20, stage: 4 },
    { min: 21, max: 24, stage: 5 },
  ],
  attitude: [
    { min: 0, max: 3, stage: 1 },
    { min: 4, max: 7, stage: 2 },
    { min: 8, max: 11, stage: 3 },
    { min: 12, max: 15, stage: 4 },
    { min: 16, max: 24, stage: 5 },
  ],
};

module.exports = {
  cellKey: cellKey,
  rowKey: rowKey,
  computeRowScores: computeRowScores,
  computeItemTotals: computeItemTotals,
  computeStages: computeStages,
  minusPointsForAttitudeStage: minusPointsForAttitudeStage,
  minusPointsForJobRequirements: minusPointsForJobRequirements,
  jobRequirementLowStageItems: jobRequirementLowStageItems,
  crossCheck: crossCheck,
  scoreSheet: scoreSheet,
  buildItemMasterFromRows: buildItemMasterFromRows,
  buildBandsFromRows: buildBandsFromRows,
  validateMasters: validateMasters,
  DEFAULT_ITEM_MASTER: DEFAULT_ITEM_MASTER,
  DEFAULT_BANDS: DEFAULT_BANDS,
};
