CREATE TABLE IF NOT EXISTS candidate_files (
  file_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL DEFAULT '',
  uploaded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidate_files_candidate
ON candidate_files(candidate_id, uploaded_at);
