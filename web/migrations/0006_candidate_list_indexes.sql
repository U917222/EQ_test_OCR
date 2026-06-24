CREATE INDEX IF NOT EXISTS idx_candidates_uploaded
ON candidates(uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_candidates_status_uploaded
ON candidates(status, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_candidates_test_uploaded
ON candidates(test_date DESC, uploaded_at DESC);
