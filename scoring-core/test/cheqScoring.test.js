"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const {
  cellKey,
  computeRowScores,
  computeItemTotals,
  computeStages,
  minusPointsForAttitudeStage,
  minusPointsForJobRequirements,
  jobRequirementLowStageItems,
  crossCheck,
  scoreSheet,
  DEFAULT_ITEM_MASTER,
  DEFAULT_BANDS,
} = require("../src/cheqScoring.js");

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "fixtures", "sample-expected.json"), "utf8")
);

/** 行得点の期待値どおりにセル(0-3)を合成する。1セル最大3なので 3,3,3,... と詰める。 */
function synthesizeCells(rowScores) {
  const cells = {};
  const letters = "ABCDEFGHIJ";
  for (let block = 0; block < 2; block++) {
    for (let li = 0; li < letters.length; li++) {
      const letter = letters[li];
      let remain = rowScores[`${letter}${block + 1}`];
      for (let pos = 1; pos <= 4; pos++) {
        const v = Math.min(3, remain);
        remain -= v;
        cells[cellKey(block, letter, pos)] = { value: v, confidence: 0.95 };
      }
      assert.equal(remain, 0, `行 ${letter}${block + 1} の合成失敗`);
    }
  }
  return cells;
}

test("cellKey: 契約どおりの採番 (docs/cell-contract.md)", () => {
  assert.equal(cellKey(0, "A", 1), "s01");
  assert.equal(cellKey(0, "A", 4), "s04");
  assert.equal(cellKey(0, "B", 1), "s05");
  assert.equal(cellKey(0, "J", 4), "s40");
  assert.equal(cellKey(1, "A", 1), "s41");
  assert.equal(cellKey(1, "J", 4), "s80");
});

test("computeRowScores: 行内4セルの合計が行得点になる", () => {
  const cells = synthesizeCells(fixture.rowScores);
  const { scores, issues } = computeRowScores(cells);
  assert.deepEqual(scores, fixture.rowScores);
  assert.deepEqual(issues, []);
});

test("computeRowScores: null セルは残りで仮計算し issue を出す", () => {
  const cells = synthesizeCells(fixture.rowScores);
  cells.s01 = { value: null, confidence: 0.2, reason: "blank" };
  const { scores, issues } = computeRowScores(cells);
  // s01 = 上A 小問1（合成では3）。仮計算は残セルのみ。
  assert.equal(scores.A1, fixture.rowScores.A1 - 3);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], { cell: "s01", row: "A1", reason: "blank" });
});

test("computeItemTotals: 同字ペア加算でサンプル期待値と一致する", () => {
  const totals = computeItemTotals(fixture.rowScores, DEFAULT_ITEM_MASTER);
  assert.deepEqual(totals, fixture.itemTotals);
});

test("computeStages: 項目別バンドで段階得点を出す（確定値）", () => {
  // ①セルフコントロール: 0-8/9-10/11-12/13-14/15-24
  assert.equal(computeStages({ self_control: 8 }, DEFAULT_BANDS).self_control, 1);
  assert.equal(computeStages({ self_control: 9 }, DEFAULT_BANDS).self_control, 2);
  assert.equal(computeStages({ self_control: 10 }, DEFAULT_BANDS).self_control, 2);
  assert.equal(computeStages({ self_control: 24 }, DEFAULT_BANDS).self_control, 5);
  // 応答態度: 0-3/4-7/8-11/12-15/16-24
  assert.equal(computeStages({ attitude: 1 }, DEFAULT_BANDS).attitude, 1);
  assert.equal(computeStages({ attitude: 16 }, DEFAULT_BANDS).attitude, 5);
  // 境界の確認（⑨ホスピタリティー 16-17 = 段階3）
  assert.equal(computeStages({ hospitality: 17 }, DEFAULT_BANDS).hospitality, 3);
  assert.equal(computeStages({ hospitality: 18 }, DEFAULT_BANDS).hospitality, 4);
});

test("computeStages: バンド未登録/範囲外は null（誤った段階を出さない）", () => {
  // 未登録キー
  assert.equal(computeStages({ unknown_item: 10 }, DEFAULT_BANDS).unknown_item, null);
  // バンドが渡されなければ null
  assert.equal(computeStages({ self_control: 10 }, {}).self_control, null);
  // 負値など範囲外
  assert.equal(computeStages({ self_control: -1 }, DEFAULT_BANDS).self_control, null);
});

test("minusPointsForAttitudeStage: 4→-1, 5→-2, それ以外0", () => {
  assert.equal(minusPointsForAttitudeStage(1), 0);
  assert.equal(minusPointsForAttitudeStage(2), 0);
  assert.equal(minusPointsForAttitudeStage(3), 0);
  assert.equal(minusPointsForAttitudeStage(4), -1);
  assert.equal(minusPointsForAttitudeStage(5), -2);
  assert.equal(minusPointsForAttitudeStage(null), 0);
});

test("minusPointsForJobRequirements: 対象5項目すべて段階3以上なら0", () => {
  const stages = {
    self_control: 1,
    communication: 1,
    situation: 1,
    stress: 1,
    proactivity: 3,
    goal: 3,
    positive: 4,
    teamwork: 5,
    hospitality: 3,
    attitude: 1,
  };
  assert.equal(minusPointsForJobRequirements(stages, DEFAULT_ITEM_MASTER), 0);
});

test("minusPointsForJobRequirements: 対象のうち2項目が段階1〜2なら-2", () => {
  const stages = {
    proactivity: 1,
    goal: 3,
    positive: 2,
    teamwork: 4,
    hospitality: 5,
  };
  assert.equal(minusPointsForJobRequirements(stages, DEFAULT_ITEM_MASTER), -2);
});

test("minusPointsForJobRequirements: 境界は段階2をカウントし段階3をカウントしない", () => {
  const stages = {
    proactivity: 2,
    goal: 3,
    positive: 3,
    teamwork: 3,
    hospitality: 3,
  };
  assert.equal(minusPointsForJobRequirements(stages, DEFAULT_ITEM_MASTER), -1);
});

test("minusPointsForJobRequirements: ①〜④や応答態度が段階1でもカウントしない", () => {
  const stages = {
    self_control: 1,
    communication: 1,
    situation: 1,
    stress: 1,
    proactivity: 3,
    goal: 3,
    positive: 3,
    teamwork: 3,
    hospitality: 3,
    attitude: 1,
  };
  assert.equal(minusPointsForJobRequirements(stages, DEFAULT_ITEM_MASTER), 0);
});

test("minusPointsForJobRequirements: 段階nullはカウントしない", () => {
  const stages = {
    proactivity: null,
    goal: 2,
    positive: 3,
    teamwork: null,
    hospitality: 4,
  };
  assert.equal(minusPointsForJobRequirements(stages, DEFAULT_ITEM_MASTER), -1);
});

test("jobRequirementLowStageItems: {key,label,stage}をItemMaster順で返す", () => {
  const stages = {
    proactivity: 2,
    goal: 3,
    positive: 1,
    teamwork: 3,
    hospitality: 2,
  };
  assert.deepEqual(jobRequirementLowStageItems(stages, DEFAULT_ITEM_MASTER), [
    { key: "proactivity", label: "⑤積極性", stage: 2 },
    { key: "positive", label: "⑦ポジティブ思考力", stage: 1 },
    { key: "hospitality", label: "⑨ホスピタリティー", stage: 2 },
  ]);
});

test("crossCheck: 手書き合計との不一致（⑦）を検出する", () => {
  const mismatches = crossCheck(fixture.itemTotals, fixture.handwrittenTotals);
  assert.deepEqual(
    mismatches.map((m) => m.item),
    fixture.expected.crossCheckMismatchKeys
  );
  assert.deepEqual(mismatches[0], { item: "positive", computed: 14, handwritten: 13 });
});

test("crossCheck: 手書きが無い項目はスキップする", () => {
  const mismatches = crossCheck(fixture.itemTotals, { positive: 14 });
  assert.deepEqual(mismatches, []);
});

test("scoreSheet: セル→総合まで一気通貫（サンプル回帰・確定バンド）", () => {
  const cells = synthesizeCells(fixture.rowScores);
  const result = scoreSheet(cells, {
    itemMaster: DEFAULT_ITEM_MASTER,
    bands: DEFAULT_BANDS,
    handwrittenTotals: fixture.handwrittenTotals,
  });
  assert.deepEqual(result.rowScores, fixture.rowScores);
  assert.deepEqual(result.itemTotals, fixture.itemTotals);
  // 全項目の段階得点を確定バンドで検証
  assert.deepEqual(result.stages, fixture.expected.stages);
  assert.equal(result.attitudeStage, fixture.expected.attitudeStage);
  assert.equal(result.minusPoints, fixture.expected.minusPoints);
  assert.deepEqual(
    result.crossCheck.map((m) => m.item),
    fixture.expected.crossCheckMismatchKeys
  );
  assert.deepEqual(result.issues, []);
});

test("scoreSheet: fixtureで応答態度分0・職務必要要件分-1・総合-1になる", () => {
  const cells = synthesizeCells(fixture.rowScores);
  const result = scoreSheet(cells, {
    itemMaster: DEFAULT_ITEM_MASTER,
    bands: DEFAULT_BANDS,
    handwrittenTotals: fixture.handwrittenTotals,
  });
  assert.equal(result.attitudeMinusPoints, fixture.expected.attitudeMinusPoints);
  assert.equal(result.jobRequirementMinusPoints, fixture.expected.jobRequirementMinusPoints);
  assert.deepEqual(result.jobRequirementLowItems, fixture.expected.jobRequirementLowItems);
  assert.equal(result.minusPoints, fixture.expected.minusPoints);
});

test("scoreSheet: 応答態度段階4と職務必要2項目低でマイナスポイントは職務必要のみになる", () => {
  const rowScores = { ...fixture.rowScores };
  rowScores.E1 = 6;
  rowScores.E2 = 7;
  rowScores.J1 = 6;
  rowScores.J2 = 6;
  const cells = synthesizeCells(rowScores);
  const result = scoreSheet(cells, {
    itemMaster: DEFAULT_ITEM_MASTER,
    bands: DEFAULT_BANDS,
  });
  assert.equal(result.stages.proactivity, 2);
  assert.equal(result.stages.teamwork, 2);
  assert.equal(result.attitudeStage, 4);
  assert.equal(result.attitudeMinusPoints, -1);
  assert.equal(result.jobRequirementMinusPoints, -2);
  assert.equal(result.minusPoints, -2);
  assert.equal(result.minusPoints, result.jobRequirementMinusPoints);
});
