"""SQLite storage for your_schedule.

資料表尚未定義，待需求確認後再補 schema 與 migration。
"""

import sqlite3
from pathlib import Path


class ScheduleDB:
    """Open the SQLite database used by your_schedule."""

    def __init__(self, db_path: Path) -> None:
        """Open the database connection with foreign keys enabled."""
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        print(f"[models] DB ready: {db_path}")
