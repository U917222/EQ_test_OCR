"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const gasSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "gas", "Code.production.gs"),
  "utf8"
);

function loadGasRankFunctions() {
  const context = {};
  vm.runInNewContext(gasSource, context);
  return {
    calculateFallbackRank: context.calculateFallbackRank_,
    rankStageValues: context.rankStageValues_,
  };
}

test("rankStageValues_: 総合判定は①〜④だけを集計する", () => {
  const { rankStageValues } = loadGasRankFunctions();
  const stages = {
    "①セルフコントロール": 5,
    "②コミュニケーション": 3,
    "③状況認識力": 3,
    "④ストレス対処力": 5,
    "⑤積極性": 1,
    "⑥目標達成力": 1,
    "⑦ポジティブ思考力": 2,
    "⑧チームワーク": 1,
    "⑨ホスピタリティー": 1,
    "応答態度": 3,
  };

  assert.deepEqual(Array.from(rankStageValues(stages)), [5, 3, 3, 5]);
});

test("calculateFallbackRank_: ⑤〜⑨が低段階でも①〜④に段階2以下がなければ総合Aにする", () => {
  const { calculateFallbackRank } = loadGasRankFunctions();
  const stages = {
    "①セルフコントロール": 5,
    "②コミュニケーション": 3,
    "③状況認識力": 3,
    "④ストレス対処力": 5,
    "⑤積極性": 5,
    "⑥目標達成力": 5,
    "⑦ポジティブ思考力": 2,
    "⑧チームワーク": 5,
    "⑨ホスピタリティー": 3,
    "応答態度": 3,
  };

  assert.deepEqual({ ...calculateFallbackRank(stages) }, {
    rank: "A",
    minusPoints: 0,
    note: "段階2以下の項目はありません",
  });
});

test("calculateFallbackRank_: ①〜④の段階2以下の個数で総合判定する", () => {
  const { calculateFallbackRank } = loadGasRankFunctions();
  const oneLow = {
    "①セルフコントロール": 5,
    "②コミュニケーション": 2,
    "③状況認識力": 3,
    "④ストレス対処力": 5,
    "⑤積極性": 5,
    "⑥目標達成力": 5,
    "⑦ポジティブ思考力": 5,
    "⑧チームワーク": 5,
    "⑨ホスピタリティー": 5,
    "応答態度": 3,
  };

  const twoLow = {
    ...oneLow,
    "③状況認識力": 1,
  };
  const threeLow = {
    ...twoLow,
    "④ストレス対処力": 2,
  };

  assert.equal(calculateFallbackRank(oneLow).rank, "B");
  assert.equal(calculateFallbackRank(twoLow).rank, "C");
  assert.equal(calculateFallbackRank(threeLow).rank, "D");
});
