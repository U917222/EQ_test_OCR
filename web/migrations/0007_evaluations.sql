-- 総合評定（面接評価）。CHEQ 自動採点とは独立した、面接官による人手評価。
-- 受験者(candidates)を複数名の評価者が 6 項目×5段階(5..1)で評価し、所見を残す。

-- 評定ヘッダ＋総合所見
CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id   TEXT PRIMARY KEY,
  candidate_id    TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
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

-- 評定の各評価要素（6 行/評定）。score は 5..1。
CREATE TABLE IF NOT EXISTS evaluation_items (
  evaluation_id TEXT NOT NULL REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
  item_key      TEXT NOT NULL,
  score         INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (evaluation_id, item_key)
);

-- 評価要素マスタ（ラベル・基準文・表示順）
CREATE TABLE IF NOT EXISTS evaluation_item_master (
  item_key      TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  description   TEXT NOT NULL,
  display_order INTEGER NOT NULL
);

-- 評価者マスタ（候補選択用・「登録する」押下で明示追加。初期 0 名 / seed なし）
CREATE TABLE IF NOT EXISTS evaluators (
  evaluator_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO evaluation_item_master (item_key, label, description, display_order) VALUES
  ('knowledge',    '①知識・能力',               '募集職種に対する、技術・能力・知識は十分か', 1),
  ('adaptability', '②対応力',                   '対人対応力（コミュニケーション能力・接遇力・表現力）は十分か', 2),
  ('personality',  '③性格・人格',               '本人の人柄や人格的特徴をつかむ（社交性・リーダーシップ・ストレス耐性など）', 3),
  ('interest',     '④関心・意欲',               '当法人（当該業務）への関心の度合いを確認し、意欲を読み取る', 4),
  ('potential',    '⑤期待値・付加価値・将来性', '上記①〜④で評価できない、潜在能力に対する期待値', 5),
  ('aptitude',     '⑥適性',                     '人物の全体像を観察し、適性を総合的に判断する', 6);
