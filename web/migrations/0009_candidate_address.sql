-- 候補者の住所情報。地域別ダッシュボード集計と連絡先管理のために追加。
-- 郵便番号→住所はフロントで補完するが、確定値はここに保存する。
ALTER TABLE candidates ADD COLUMN postal_code TEXT NOT NULL DEFAULT '';
ALTER TABLE candidates ADD COLUMN prefecture TEXT NOT NULL DEFAULT '';
ALTER TABLE candidates ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE candidates ADD COLUMN address_line TEXT NOT NULL DEFAULT '';
