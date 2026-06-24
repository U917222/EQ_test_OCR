ALTER TABLE candidate_files
ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'r2';

ALTER TABLE candidate_files
ADD COLUMN body_base64 TEXT NOT NULL DEFAULT '';
