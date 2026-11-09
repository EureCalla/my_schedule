-- 002_copy_archive：封存與複製來源
-- 封存：除了建立者以外都看不到（即使原本公開）。
-- 複製來源：複製當下的快照（來源 id、版本、擁有者、名稱），甘特頁據此往前追溯來源鏈。

ALTER TABLE sheets ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sheets ADD COLUMN archived_at DATETIME;
ALTER TABLE sheets ADD COLUMN copied_from_sheet_id INTEGER REFERENCES sheets(id);
ALTER TABLE sheets ADD COLUMN copied_from_version_no INTEGER;
ALTER TABLE sheets ADD COLUMN copied_from_owner TEXT;
ALTER TABLE sheets ADD COLUMN copied_from_title TEXT;

CREATE INDEX IF NOT EXISTS idx_sheets_is_archived ON sheets(is_archived);
CREATE INDEX IF NOT EXISTS idx_sheets_copied_from ON sheets(copied_from_sheet_id);
