CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('operator', 'reviewer', 'admin')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  test_date TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  hiring_decision TEXT NOT NULL DEFAULT '',
  employee_number TEXT NOT NULL DEFAULT '',
  decision_by TEXT NOT NULL DEFAULT '',
  decision_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_employee_number
ON candidates(employee_number)
WHERE employee_number != '';

CREATE INDEX IF NOT EXISTS idx_candidates_status_updated
ON candidates(status, updated_at);

CREATE TABLE IF NOT EXISTS raw_cells (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id) ON DELETE CASCADE,
  cells_json TEXT NOT NULL,
  confidence_avg REAL,
  unresolved_count INTEGER NOT NULL DEFAULT 0,
  page_index INTEGER,
  image_links_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_queue (
  review_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
  cell_key TEXT NOT NULL DEFAULT '',
  detected TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  confidence REAL,
  image_link TEXT NOT NULL DEFAULT '',
  corrected_value TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  resolved_by TEXT NOT NULL DEFAULT '',
  resolved_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_review_queue_candidate_status
ON review_queue(candidate_id, status, cell_key);

CREATE TABLE IF NOT EXISTS results (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id) ON DELETE CASCADE,
  total_rank TEXT NOT NULL DEFAULT '',
  response_attitude_stage INTEGER,
  minus_points INTEGER,
  attitude_minus_points INTEGER,
  job_requirement_minus_points INTEGER,
  job_requirement_low_items_json TEXT NOT NULL DEFAULT '[]',
  row_scores_json TEXT NOT NULL DEFAULT '{}',
  item_totals_json TEXT NOT NULL DEFAULT '{}',
  item_stages_json TEXT NOT NULL DEFAULT '{}',
  cross_check_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  finalized_by TEXT NOT NULL DEFAULT '',
  finalized_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'FINALIZED'
);

CREATE TABLE IF NOT EXISTS api_operations (
  operation_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  candidate_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_operations_created
ON api_operations(created_at);

CREATE TABLE IF NOT EXISTS api_nonces (
  nonce TEXT PRIMARY KEY,
  ts REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  candidate_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  operation_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_log_candidate
ON audit_log(candidate_id, logged_at);

CREATE TABLE IF NOT EXISTS item_master (
  item_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  letter TEXT NOT NULL,
  is_attitude TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS score_bands (
  item_key TEXT NOT NULL,
  min_score INTEGER NOT NULL,
  max_score INTEGER NOT NULL,
  stage INTEGER NOT NULL,
  PRIMARY KEY (item_key, min_score, max_score)
);

CREATE TABLE IF NOT EXISTS rank_rules (
  rule_id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  condition_json TEXT NOT NULL DEFAULT '',
  rank TEXT NOT NULL DEFAULT '',
  minus_points TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS handwritten_totals (
  candidate_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, item_key)
);

INSERT OR IGNORE INTO users (email, role, active)
VALUES ('operator@example.com', 'admin', 1);

INSERT OR IGNORE INTO item_master (item_key, label, letter, is_attitude, display_order) VALUES
  ('self_control', '①セルフコントロール', 'B', '', 1),
  ('communication', '②コミュニケーション', 'A', '', 2),
  ('situation', '③状況認識力', 'I', '', 3),
  ('stress', '④ストレス対処力', 'G', '', 4),
  ('proactivity', '⑤積極性', 'E', '', 5),
  ('goal', '⑥目標達成力', 'H', '', 6),
  ('positive', '⑦ポジティブ思考力', 'C', '', 7),
  ('teamwork', '⑧チームワーク', 'F', '', 8),
  ('hospitality', '⑨ホスピタリティー', 'D', '', 9),
  ('attitude', '応答態度', 'J', 'TRUE', 10);

INSERT OR IGNORE INTO score_bands (item_key, min_score, max_score, stage) VALUES
  ('self_control',0,8,1),('self_control',9,10,2),('self_control',11,12,3),('self_control',13,14,4),('self_control',15,24,5),
  ('communication',0,9,1),('communication',10,12,2),('communication',13,14,3),('communication',15,16,4),('communication',17,24,5),
  ('situation',0,9,1),('situation',10,12,2),('situation',13,15,3),('situation',16,17,4),('situation',18,24,5),
  ('stress',0,12,1),('stress',13,14,2),('stress',15,16,3),('stress',17,18,4),('stress',19,24,5),
  ('proactivity',0,11,1),('proactivity',12,13,2),('proactivity',14,15,3),('proactivity',16,17,4),('proactivity',18,24,5),
  ('goal',0,9,1),('goal',10,12,2),('goal',13,14,3),('goal',15,16,4),('goal',17,24,5),
  ('positive',0,8,1),('positive',9,11,2),('positive',12,13,3),('positive',14,16,4),('positive',17,24,5),
  ('teamwork',0,8,1),('teamwork',9,10,2),('teamwork',11,13,3),('teamwork',14,16,4),('teamwork',17,24,5),
  ('hospitality',0,12,1),('hospitality',13,15,2),('hospitality',16,17,3),('hospitality',18,20,4),('hospitality',21,24,5),
  ('attitude',0,3,1),('attitude',4,7,2),('attitude',8,11,3),('attitude',12,15,4),('attitude',16,24,5);
