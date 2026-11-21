ALTER TABLE sheet_versions ADD COLUMN json_data TEXT;
CREATE TABLE personal_account (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL);
