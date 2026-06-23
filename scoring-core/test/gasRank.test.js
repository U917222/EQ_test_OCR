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

test("calculateFallbackRank_: ⑤〜⑨が低段階でも①〜④が安定なら総合Cにしない", () => {
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
    note: "全体的に安定しています",
  });
});

test("calculateFallbackRank_: ①〜④に低段階があれば総合Cにする", () => {
  const { calculateFallbackRank } = loadGasRankFunctions();
  const stages = {
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

  assert.equal(calculateFallbackRank(stages).rank, "C");
});
