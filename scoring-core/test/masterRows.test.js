"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildItemMasterFromRows,
  buildBandsFromRows,
  validateMasters,
  DEFAULT_ITEM_MASTER,
  DEFAULT_BANDS,
} = require("../src/cheqScoring.js");

const ITEM_ROWS = [
  { item_key: "communication", label: "②コミュニケーション", letter: "A", is_attitude: "", display_order: 2 },
  { item_key: "self_control", label: "①セルフコントロール", letter: "B", is_attitude: false, display_order: 1 },
  { item_key: "attitude", label: "応答態度", letter: "J", is_attitude: "TRUE", display_order: 10 },
];

test("buildItemMasterFromRows: display_order順・is_attitudeの表記ゆれを吸収", () => {
  const master = buildItemMasterFromRows(ITEM_ROWS);
  assert.deepEqual(master.map((m) => m.key), ["self_control", "communication", "attitude"]);
  assert.equal(master[0].isAttitude, false);
  assert.equal(master[2].isAttitude, true);
  assert.equal(master[2].letter, "J");
  assert.equal(master[0].label, "①セルフコントロール");
});

test("buildBandsFromRows: item_keyごとにまとめmin昇順・数値化する", () => {
  const rows = [
    { item_key: "attitude", min_score: "4", max_score: "7", stage: "2" },
    { item_key: "attitude", min_score: 0, max_score: 3, stage: 1 },
    { item_key: "self_control", min_score: 0, max_score: 8, stage: 1 },
  ];
  const bands = buildBandsFromRows(rows);
  assert.deepEqual(bands.attitude, [
    { min: 0, max: 3, stage: 1 },
    { min: 4, max: 7, stage: 2 },
  ]);
  assert.deepEqual(bands.self_control, [{ min: 0, max: 8, stage: 1 }]);
});

test("validateMasters: 確定マスタ(DEFAULT_BANDS)はエラーなし", () => {
  assert.deepEqual(validateMasters(DEFAULT_ITEM_MASTER, DEFAULT_BANDS), []);
});

test("validateMasters: 項目数・文字重複・応答態度の不備を検出する", () => {
  const dupLetter = DEFAULT_ITEM_MASTER.map((m) =>
    m.key === "communication" ? { ...m, letter: "B" } : m
  );
  const errors = validateMasters(dupLetter, fullBands());
  assert.ok(errors.some((e) => e.includes("letter")));

  const noAttitude = DEFAULT_ITEM_MASTER.map((m) => ({ ...m, isAttitude: false }));
  assert.ok(validateMasters(noAttitude, fullBands()).some((e) => e.includes("応答態度")));

  const nine = DEFAULT_ITEM_MASTER.slice(0, 9);
  assert.ok(validateMasters(nine, fullBands()).some((e) => e.includes("10")));
});

test("validateMasters: item_key の空・前後空白・重複・未知バンドキーを検出する", () => {
  const blankKey = DEFAULT_ITEM_MASTER.map((m) =>
    m.key === "self_control" ? { ...m, key: "" } : m
  );
  assertIncludes(validateMasters(blankKey, fullBands()), "item_key が不正");

  const paddedKey = DEFAULT_ITEM_MASTER.map((m) =>
    m.key === "self_control" ? { ...m, key: " self_control " } : m
  );
  assertIncludes(validateMasters(paddedKey, fullBands()), "item_key が不正");

  const duplicateKey = DEFAULT_ITEM_MASTER.map((m) =>
    m.key === "communication" ? { ...m, key: "self_control" } : m
  );
  assertIncludes(validateMasters(duplicateKey, fullBands()), "item_key が重複");

  const bands = cloneBands(DEFAULT_BANDS);
  bands.unknown_item = [{ min: 0, max: 24, stage: 1 }];
  assertIncludes(validateMasters(DEFAULT_ITEM_MASTER, bands), "項目マスタに存在しません");
});

test("validateMasters: letter は A-J の1文字だけ許可する", () => {
  const invalidLetter = DEFAULT_ITEM_MASTER.map((m) =>
    m.key === "self_control" ? { ...m, letter: "K" } : m
  );
  assertIncludes(validateMasters(invalidLetter, fullBands()), "A-J");

  const blankLetter = DEFAULT_ITEM_MASTER.map((m) =>
    m.key === "self_control" ? { ...m, letter: "" } : m
  );
  assertIncludes(validateMasters(blankLetter, fullBands()), "A-J");
});

test("validateMasters: バンド未登録の項目を検出する", () => {
  // self_control と attitude だけにバンドを張った不完全マスタ
  const partial = {
    self_control: DEFAULT_BANDS.self_control,
    attitude: DEFAULT_BANDS.attitude,
  };
  const errors = validateMasters(DEFAULT_ITEM_MASTER, partial);
  // ②〜⑨の8項目がバンド未登録
  assert.equal(errors.length, 8);
  assert.ok(errors.every((e) => e.includes("バンド")));
});

test("validateMasters: バンドの非有限値・stage範囲外・min/max不整合を検出する", () => {
  const bands = cloneBands(DEFAULT_BANDS);
  bands.self_control = [
    { min: Number.NaN, max: 8, stage: 1 },
    { min: 9, max: Infinity, stage: 2 },
    { min: 11, max: 12, stage: 0 },
    { min: 13, max: 12, stage: 4 },
    { min: 15, max: 24, stage: 6 },
  ];
  const errors = validateMasters(DEFAULT_ITEM_MASTER, bands);
  assertIncludes(errors, "min は有限数");
  assertIncludes(errors, "max は有限数");
  assertIncludes(errors, "stage は1〜5");
  assertIncludes(errors, "min は max 以下");
});

test("validateMasters: バンドは0-24を隙間なく重複なく覆う必要がある", () => {
  const gapBands = cloneBands(DEFAULT_BANDS);
  gapBands.self_control = [
    { min: 0, max: 8, stage: 1 },
    { min: 10, max: 24, stage: 2 },
  ];
  assertIncludes(validateMasters(DEFAULT_ITEM_MASTER, gapBands), "欠け");

  const overlapBands = cloneBands(DEFAULT_BANDS);
  overlapBands.self_control = [
    { min: 0, max: 8, stage: 1 },
    { min: 8, max: 24, stage: 2 },
  ];
  assertIncludes(validateMasters(DEFAULT_ITEM_MASTER, overlapBands), "重複");

  const outOfRangeBands = cloneBands(DEFAULT_BANDS);
  outOfRangeBands.self_control = [
    { min: -1, max: 8, stage: 1 },
    { min: 9, max: 24, stage: 2 },
  ];
  assertIncludes(validateMasters(DEFAULT_ITEM_MASTER, outOfRangeBands), "0〜24");
});

test("buildBandsFromRows + validateMasters: 空の数値セルを0扱いせず検出する", () => {
  const bands = cloneBands(DEFAULT_BANDS);
  bands.self_control = buildBandsFromRows([
    { item_key: "self_control", min_score: "", max_score: "8", stage: "1" },
    { item_key: "self_control", min_score: "9", max_score: "24", stage: "2" },
  ]).self_control;
  assertIncludes(validateMasters(DEFAULT_ITEM_MASTER, bands), "min は有限数");
});

/** 全10項目に適当なバンドを張ったテスト用マスタ */
function fullBands() {
  const bands = {};
  DEFAULT_ITEM_MASTER.forEach((m) => {
    bands[m.key] = [
      { min: 0, max: 9, stage: 1 },
      { min: 10, max: 24, stage: 3 },
    ];
  });
  return bands;
}

function cloneBands(source) {
  const bands = {};
  Object.keys(source).forEach((key) => {
    bands[key] = source[key].map((band) => ({ ...band }));
  });
  return bands;
}

function assertIncludes(errors, text) {
  assert.ok(
    errors.some((error) => error.includes(text)),
    `expected an error containing ${text}, got:\n${errors.join("\n")}`
  );
}
