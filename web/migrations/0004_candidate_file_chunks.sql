CREATE TABLE IF NOT EXISTS candidate_file_chunks (
  file_id TEXT NOT NULL REFERENCES candidate_files(file_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  body_base64 TEXT NOT NULL,
  PRIMARY KEY (file_id, chunk_index)
);
