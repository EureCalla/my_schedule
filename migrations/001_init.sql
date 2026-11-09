-- 001_init：vr20_schedule.db 初始結構
-- db 只是索引：排程表本體是 10_Schedule 下的 JSON，這裡記位置、版本、公開與編輯鎖。
-- 帳號來自 vr20_data.db 的 accounts，不另建表；owner / saved_by / locked_by 存 accounts.user。
-- 時間一律 ISO 8601 UTC（YYYY-MM-DD HH:MM:SS）。

CREATE TABLE IF NOT EXISTS sheets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    owner               TEXT    NOT NULL,
    title               TEXT    NOT NULL,
    is_public           INTEGER NOT NULL DEFAULT 1,
    current_version_id  INTEGER REFERENCES sheet_versions(id),
    created_at          DATETIME NOT NULL,
    updated_at          DATETIME NOT NULL,
    is_deleted          INTEGER NOT NULL DEFAULT 0,
    deleted_at          DATETIME
);
CREATE INDEX IF NOT EXISTS idx_sheets_owner ON sheets(owner);
CREATE INDEX IF NOT EXISTS idx_sheets_is_public ON sheets(is_public);
CREATE INDEX IF NOT EXISTS idx_sheets_is_deleted ON sheets(is_deleted);
CREATE INDEX IF NOT EXISTS idx_sheets_current_version ON sheets(current_version_id);

-- 每次存檔一列，JSON 檔不覆蓋，保留完整歷史
CREATE TABLE IF NOT EXISTS sheet_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id    INTEGER NOT NULL REFERENCES sheets(id),
    version_no  INTEGER NOT NULL,
    json_path   TEXT    NOT NULL,  -- 相對於 10_Schedule
    saved_by    TEXT    NOT NULL,
    saved_at    DATETIME NOT NULL,
    sha256      TEXT    NOT NULL,
    size_bytes  INTEGER NOT NULL,
    UNIQUE (sheet_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_sheet_versions_sheet ON sheet_versions(sheet_id);
CREATE INDEX IF NOT EXISTS idx_sheet_versions_saved_by ON sheet_versions(saved_by);

-- 編輯鎖：一張表同時只有一位編輯者；heartbeat_at 逾時即失效
CREATE TABLE IF NOT EXISTS sheet_locks (
    sheet_id      INTEGER PRIMARY KEY REFERENCES sheets(id),
    locked_by     TEXT    NOT NULL,
    locked_at     DATETIME NOT NULL,
    heartbeat_at  DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sheet_locks_locked_by ON sheet_locks(locked_by);
