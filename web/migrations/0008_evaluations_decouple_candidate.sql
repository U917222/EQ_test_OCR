-- 評定(evaluations)を D1 の candidates 行から疎結合にする。
-- 本番の候補者は Google Sheets(Cloud Run scoring-api)に保存され、D1 の candidates は空。
-- そのため evaluations.candidate_id の `REFERENCES candidates(...)` FK と
-- ハンドラの getCandidate 存在チェックが本番で必ず失敗していた(「Candidate not found」)。
-- ここでは FK を外し、candidate_id は候補者ID(Sheets由来)の参照キーとして保持する。
-- SQLite は ALTER で FK を落とせないためテーブルを作り直す。
-- evaluation_items は evaluations を参照する FK を持つため、退避→復元で保全する
-- (parent の DROP は FK 有効時に子へ暗黙 CASCADE するため child を先に退避/削除)。

PRAGMA defer_foreign_keys = TRUE;

-- 1) データ退避(制約なしの素テーブル)
CREATE TABLE _evaluations_bak AS SELECT * FROM evaluations;
CREATE TABLE _evaluation_items_bak AS SELECT * FROM evaluation_items;

-- 2) 子→親の順で破棄
DROP TABLE evaluation_items;
DROP TABLE evaluations;

-- 3) evaluations を candidates への FK 無しで再作成
CREATE TABLE evaluations (
  evaluation_id   TEXT PRIMARY KEY,
  candidate_id    TEXT NOT NULL,
  evaluator_name  TEXT NOT NULL,
  evaluator_email TEXT NOT NULL DEFAULT '',
  eval_date       TEXT NOT NULL DEFAULT '',
  job_role        TEXT NOT NULL DEFAULT '',
  total_score     INTEGER NOT NULL DEFAULT 0,
  overall_comment TEXT NOT NULL DEFAULT '',
  created_by      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evaluations_candidate
ON evaluations(candidate_id, created_at DESC);

-- 4) evaluation_items は evaluations への FK を維持して再作成
CREATE TABLE evaluation_items (
  evaluation_id TEXT NOT NULL REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
  item_key      TEXT NOT NULL,
  score         INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (evaluation_id, item_key)
);

-- 5) 親→子の順でデータ復元
INSERT INTO evaluations SELECT * FROM _evaluations_bak;
INSERT INTO evaluation_items SELECT * FROM _evaluation_items_bak;

-- 6) 退避テーブル破棄
DROP TABLE _evaluations_bak;
DROP TABLE _evaluation_items_bak;
