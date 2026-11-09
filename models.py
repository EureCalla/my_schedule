"""SQLite storage for your_schedule.

資料表尚未定義，待需求確認後再補 schema 與 migration。
（v3.0 起已定義：schema 見 ``migrations/``。db 只做索引，排程表本體存成 JSON 檔，
每次存檔寫一個新版本檔、舊檔保留；編輯鎖逾時見 ``mpivr20_cms.LOCK_TIMEOUT_MINUTES``。）
"""

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import mpivr20_cms as cms


def _now() -> str:
    """回傳目前 UTC 時間的 ISO 8601 字串（YYYY-MM-DD HH:MM:SS）。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _expire_before() -> str:
    """回傳鎖失效的時間界線：心跳早於此時間的鎖視為失效。"""
    limit = datetime.now(timezone.utc) - timedelta(minutes=cms.LOCK_TIMEOUT_MINUTES)
    return limit.strftime("%Y-%m-%d %H:%M:%S")


def _safe_dir_name(name: str) -> str:
    """把帳號轉成可當資料夾名稱的字串（只留英數、點、底線、連字號）。"""
    return re.sub(r"[^A-Za-z0-9._-]", "_", name) or "_"


class ScheduleDB:
    """Open the SQLite database used by your_schedule."""

    def __init__(self, db_path: Path, json_dir: Path = cms.SCHEDULE_JSON_DIR) -> None:
        """Open the database connection with foreign keys enabled."""
        # isolation_level=None：交易一律自己下 BEGIN IMMEDIATE，避免多人同時寫入時互相覆蓋
        self.conn = sqlite3.connect(
            str(db_path), check_same_thread=False, timeout=10.0, isolation_level=None
        )
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        # 網路共享槽上不能用 WAL，維持預設的 rollback journal
        self.conn.execute("PRAGMA journal_mode = DELETE")
        self.json_dir = json_dir
        print(f"[models] DB ready: {db_path}")

    # ── migration ──────────────────────────────────────────────

    def migrate(self, migrations_dir: Path = cms.MIGRATIONS_DIR) -> list[str]:
        """依檔名順序套用尚未執行的 ``migrations/*.sql``。

        :param migrations_dir: migration 檔所在資料夾
        :return: 本次新套用的 migration 名稱
        """
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " version TEXT PRIMARY KEY, applied_at DATETIME NOT NULL)"
        )
        done = {r["version"] for r in self.conn.execute("SELECT version FROM schema_migrations")}
        applied: list[str] = []
        for path in sorted(migrations_dir.glob("*.sql")):
            if path.stem in done:
                continue
            print(f"[models] 套用 migration：{path.name}")
            sql = path.read_text(encoding="utf-8")
            self.conn.executescript(
                f"BEGIN IMMEDIATE;\n{sql}\n"
                f"INSERT INTO schema_migrations (version, applied_at) VALUES ('{path.stem}', '{_now()}');\n"
                "COMMIT;"
            )
            applied.append(path.stem)
        print(f"[models] migration 完成，新套用 {len(applied)} 個")
        return applied

    # ── 排程表 ─────────────────────────────────────────────────

    def create_sheet(self, owner: str, title: str, is_public: bool = True) -> int:
        """建立一張空的排程表（尚無版本）。

        :param owner: 建立者帳號（accounts.user）
        :param title: 排程表名稱
        :param is_public: 是否公開給所有人檢視，預設公開
        :return: 新排程表 id
        """
        now = _now()
        cur = self.conn.execute(
            "INSERT INTO sheets (owner, title, is_public, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (owner, title, int(is_public), now, now),
        )
        print(f"[models] 建立排程表 #{cur.lastrowid}：{title}（{owner}，公開={is_public}）")
        return int(cur.lastrowid)

    def get_sheet(self, sheet_id: int) -> dict[str, Any] | None:
        """取得單張排程表（含目前版本號與鎖狀態），已刪除者回 None。"""
        row = self.conn.execute(
            "SELECT s.*, v.version_no AS current_version_no,"
            "       l.locked_by, l.heartbeat_at AS lock_heartbeat_at"
            "  FROM sheets s"
            "  LEFT JOIN sheet_versions v ON v.id = s.current_version_id"
            "  LEFT JOIN sheet_locks l ON l.sheet_id = s.id AND l.heartbeat_at >= ?"
            " WHERE s.id = ? AND s.is_deleted = 0",
            (_expire_before(), sheet_id),
        ).fetchone()
        return dict(row) if row else None

    def list_sheets(self, viewer: str) -> list[dict[str, Any]]:
        """列出 viewer 看得到的排程表：自己的全部，加上別人公開的。

        v3.8 起別人封存（is_archived）的表即使公開也看不到。

        :param viewer: 目前登入的帳號（大小寫不敏感）
        :return: 依更新時間新到舊排序的排程表
        """
        rows = self.conn.execute(
            "SELECT s.*, v.version_no AS current_version_no,"
            "       l.locked_by, l.heartbeat_at AS lock_heartbeat_at"
            "  FROM sheets s"
            "  LEFT JOIN sheet_versions v ON v.id = s.current_version_id"
            "  LEFT JOIN sheet_locks l ON l.sheet_id = s.id AND l.heartbeat_at >= ?"
            " WHERE s.is_deleted = 0"
            "   AND ((s.is_public = 1 AND s.is_archived = 0) OR lower(s.owner) = lower(?))"
            " ORDER BY s.updated_at DESC",
            (_expire_before(), viewer),
        ).fetchall()
        print(f"[models] {viewer} 可見排程表 {len(rows)} 張")
        return [dict(r) for r in rows]

    def can_view(self, sheet: dict[str, Any], viewer: str) -> bool:
        """公開的表人人可看，私人的表只有建立者能看；封存的表只有建立者能看。"""
        if sheet["owner"].lower() == viewer.lower():
            return True
        return bool(sheet["is_public"]) and not sheet.get("is_archived")

    def can_edit(self, sheet: dict[str, Any], user: str) -> bool:
        """目前只有建立者能編輯自己的排程表。"""
        return sheet["owner"].lower() == user.lower()

    def set_public(self, sheet_id: int, owner: str, is_public: bool) -> bool:
        """由建立者切換排程表是否公開。

        :return: 是否有更新到（不是建立者或表不存在時為 False）
        """
        cur = self.conn.execute(
            "UPDATE sheets SET is_public = ?, updated_at = ?"
            " WHERE id = ? AND lower(owner) = lower(?) AND is_deleted = 0",
            (int(is_public), _now(), sheet_id, owner),
        )
        print(f"[models] 排程表 #{sheet_id} 公開={is_public}：{'成功' if cur.rowcount else '未更新'}")
        return cur.rowcount > 0

    def update_title(self, sheet_id: int, owner: str, title: str) -> bool:
        """由建立者修改排程表名稱（甘特頁改名後存檔時同步）。

        :return: 是否有更新到（名稱相同、不是建立者或表不存在時為 False）
        """
        cur = self.conn.execute(
            "UPDATE sheets SET title = ?, updated_at = ?"
            " WHERE id = ? AND lower(owner) = lower(?) AND is_deleted = 0 AND title <> ?",
            (title, _now(), sheet_id, owner, title),
        )
        if cur.rowcount:
            print(f"[models] 排程表 #{sheet_id} 改名為：{title}")
        return cur.rowcount > 0

    def soft_delete_sheet(self, sheet_id: int, owner: str) -> bool:
        """由建立者軟刪除排程表；版本列與 JSON 檔都保留。"""
        now = _now()
        cur = self.conn.execute(
            "UPDATE sheets SET is_deleted = 1, deleted_at = ?, updated_at = ?"
            " WHERE id = ? AND lower(owner) = lower(?) AND is_deleted = 0",
            (now, now, sheet_id, owner),
        )
        print(f"[models] 軟刪除排程表 #{sheet_id}：{'成功' if cur.rowcount else '未更新'}")
        return cur.rowcount > 0

    # ── 編輯鎖 ─────────────────────────────────────────────────

    def acquire_lock(self, sheet_id: int, user: str) -> bool:
        """打開排程表準備編輯時上鎖。

        沒有鎖、鎖已逾時、或鎖本來就是自己的 → 取得（或續約）成功；
        別人持有且未逾時 → 失敗。只有建立者能上鎖。

        :return: 是否取得編輯權
        """
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            sheet = self.conn.execute(
                "SELECT owner FROM sheets WHERE id = ? AND is_deleted = 0", (sheet_id,)
            ).fetchone()
            if sheet is None or sheet["owner"].lower() != user.lower():
                self.conn.execute("ROLLBACK")
                print(f"[models] {user} 無權編輯排程表 #{sheet_id}")
                return False
            lock = self.conn.execute(
                "SELECT locked_by, heartbeat_at FROM sheet_locks WHERE sheet_id = ?", (sheet_id,)
            ).fetchone()
            now = _now()
            if lock and lock["locked_by"].lower() != user.lower() and lock["heartbeat_at"] >= _expire_before():
                self.conn.execute("ROLLBACK")
                print(f"[models] 排程表 #{sheet_id} 正由 {lock['locked_by']} 編輯中")
                return False
            if lock and lock["locked_by"].lower() == user.lower() and lock["heartbeat_at"] >= _expire_before():
                self.conn.execute(
                    "UPDATE sheet_locks SET heartbeat_at = ? WHERE sheet_id = ?", (now, sheet_id)
                )
            else:
                self.conn.execute(
                    "INSERT OR REPLACE INTO sheet_locks (sheet_id, locked_by, locked_at, heartbeat_at)"
                    " VALUES (?, ?, ?, ?)",
                    (sheet_id, user, now, now),
                )
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        print(f"[models] {user} 取得排程表 #{sheet_id} 編輯鎖")
        return True

    def heartbeat_lock(self, sheet_id: int, user: str) -> bool:
        """編輯中定期續約；鎖已不是自己的（被接手）時回 False。"""
        cur = self.conn.execute(
            "UPDATE sheet_locks SET heartbeat_at = ? WHERE sheet_id = ? AND lower(locked_by) = lower(?)",
            (_now(), sheet_id, user),
        )
        return cur.rowcount > 0

    def release_lock(self, sheet_id: int, user: str) -> bool:
        """釋放自己持有的鎖（不存檔直接關閉時用）。"""
        cur = self.conn.execute(
            "DELETE FROM sheet_locks WHERE sheet_id = ? AND lower(locked_by) = lower(?)",
            (sheet_id, user),
        )
        print(f"[models] {user} 釋放排程表 #{sheet_id} 編輯鎖：{'成功' if cur.rowcount else '本來就沒有'}")
        return cur.rowcount > 0

    # ── 版本 ───────────────────────────────────────────────────

    def save_version(
        self, sheet_id: int, user: str, data: dict[str, Any], release: bool = True
    ) -> int:
        """整張表存回：寫一個新版本 JSON 檔，舊版本檔保留。

        必須持有這張表的編輯鎖（鎖逾時但還沒被別人接手，仍視為自己的）。

        :param sheet_id: 排程表 id
        :param user: 存檔者帳號
        :param data: 整張排程表的資料（store.js 的資料模型）
        :param release: 存檔後是否釋放編輯鎖，預設釋放
        :return: 新的版本號
        :raises PermissionError: 沒有持有編輯鎖時
        """
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            row = self.conn.execute(
                "SELECT s.owner, l.locked_by FROM sheets s"
                "  LEFT JOIN sheet_locks l ON l.sheet_id = s.id"
                " WHERE s.id = ? AND s.is_deleted = 0",
                (sheet_id,),
            ).fetchone()
            if row is None or not row["locked_by"] or row["locked_by"].lower() != user.lower():
                raise PermissionError(f"{user} 未持有排程表 #{sheet_id} 的編輯鎖")
            version_no, rel_path, now = self._insert_version(sheet_id, row["owner"], user, data)
            if release:
                self.conn.execute("DELETE FROM sheet_locks WHERE sheet_id = ?", (sheet_id,))
            else:
                self.conn.execute(
                    "UPDATE sheet_locks SET heartbeat_at = ? WHERE sheet_id = ?", (now, sheet_id)
                )
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        print(f"[models] {user} 存檔排程表 #{sheet_id} → v{version_no}（{rel_path.as_posix()}）")
        return int(version_no)

    def _insert_version(
        self, sheet_id: int, owner: str, user: str, data: dict[str, Any]
    ) -> tuple[int, Path, str]:
        """寫一個新版本 JSON 檔並記版本列、更新目前版本（呼叫端負責交易與權限）。

        :return: （版本號, 相對 JSON 根目錄的路徑, 存檔時間）
        """
        version_no = int(self.conn.execute(
            "SELECT COALESCE(MAX(version_no), 0) + 1 FROM sheet_versions WHERE sheet_id = ?",
            (sheet_id,),
        ).fetchone()[0])

        rel_path = Path(_safe_dir_name(owner)) / str(sheet_id) / f"v{version_no:04d}.json"
        payload = json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8")
        target = self.json_dir / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".json.tmp")
        tmp.write_bytes(payload)
        tmp.replace(target)

        now = _now()
        cur = self.conn.execute(
            "INSERT INTO sheet_versions"
            " (sheet_id, version_no, json_path, saved_by, saved_at, sha256, size_bytes)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sheet_id, version_no, rel_path.as_posix(), user, now,
             hashlib.sha256(payload).hexdigest(), len(payload)),
        )
        self.conn.execute(
            "UPDATE sheets SET current_version_id = ?, updated_at = ? WHERE id = ?",
            (cur.lastrowid, now, sheet_id),
        )
        return version_no, rel_path, now

    def get_version_meta(self, sheet_id: int, version_no: int) -> dict[str, Any] | None:
        """取得某個版本的版本列（舊版檢視用），不存在回 None。"""
        row = self.conn.execute(
            "SELECT version_no, saved_by, saved_at FROM sheet_versions WHERE sheet_id = ? AND version_no = ?",
            (sheet_id, version_no),
        ).fetchone()
        return dict(row) if row else None

    # ── 封存、複製 ─────────────────────────────────────────────

    def set_archived(self, sheet_id: int, owner: str, is_archived: bool) -> bool:
        """由建立者封存／取消封存；封存後除了建立者以外都看不到。

        :return: 是否有更新到（不是建立者或表不存在時為 False）
        """
        cur = self.conn.execute(
            "UPDATE sheets SET is_archived = ?, archived_at = ?, updated_at = ?"
            " WHERE id = ? AND lower(owner) = lower(?) AND is_deleted = 0",
            (int(is_archived), _now() if is_archived else None, _now(), sheet_id, owner),
        )
        print(f"[models] 排程表 #{sheet_id} 封存={is_archived}：{'成功' if cur.rowcount else '未更新'}")
        return cur.rowcount > 0

    def copy_sheet(self, source_id: int, user: str, title: str, is_public: bool = True) -> int:
        """把來源排程表的目前版本整份複製成 user 的新排程表，並記下來源快照。

        新表的第一版直接寫入（剛建立、不會有人在編輯，不需要編輯鎖）。

        :param source_id: 來源排程表 id（呼叫端已確認 user 看得到）
        :param user: 複製者（新表的建立者）
        :param title: 新表名稱
        :param is_public: 新表是否公開
        :return: 新排程表 id
        """
        source = self.get_sheet(source_id)
        if source is None:
            raise LookupError(f"找不到排程表 #{source_id}")
        data = self.load_sheet_data(source_id)
        now = _now()
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            cur = self.conn.execute(
                "INSERT INTO sheets (owner, title, is_public, created_at, updated_at,"
                "  copied_from_sheet_id, copied_from_version_no, copied_from_owner, copied_from_title)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (user, title, int(is_public), now, now, source_id,
                 source["current_version_no"], source["owner"], source["title"]),
            )
            new_id = int(cur.lastrowid)
            if data is not None:
                data["title"] = title
                self._insert_version(new_id, user, user, data)
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        print(f"[models] {user} 複製排程表 #{source_id} v{source['current_version_no']} → #{new_id}：{title}")
        return new_id

    def copy_chain(self, sheet_id: int, max_depth: int = 10) -> list[dict[str, Any]]:
        """往前追溯複製來源鏈（近到遠），用複製當下的快照，最多 max_depth 層。"""
        chain: list[dict[str, Any]] = []
        seen = {sheet_id}
        current = sheet_id
        for _ in range(max_depth):
            row = self.conn.execute(
                "SELECT copied_from_sheet_id, copied_from_version_no, copied_from_owner, copied_from_title"
                "  FROM sheets WHERE id = ?",
                (current,),
            ).fetchone()
            if row is None or row["copied_from_sheet_id"] is None:
                break
            chain.append({
                "sheet_id": row["copied_from_sheet_id"],
                "version_no": row["copied_from_version_no"],
                "owner": row["copied_from_owner"],
                "title": row["copied_from_title"],
            })
            current = row["copied_from_sheet_id"]
            if current in seen:
                break
            seen.add(current)
        return chain

    def copy_holidays(self, source_id: int, target_id: int, user: str) -> int:
        """把來源的反灰日（calendar.blocked）聯集進 user 自己的目標排程表，存成目標的新版本。

        目標原有的反灰日與原因保留不覆蓋；openWeekends 不動。目標正被編輯（鎖未逾時）時拒絕。

        :return: 新加入的反灰日數；為 0 時不產生新版本
        :raises PermissionError: 目標不是 user 的排程表
        :raises BlockingIOError: 目標正有人編輯中
        """
        source_data = self.load_sheet_data(source_id) or {}
        source_blocked = (source_data.get("calendar") or {}).get("blocked") or {}
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            target = self.conn.execute(
                "SELECT owner, title FROM sheets WHERE id = ? AND is_deleted = 0", (target_id,)
            ).fetchone()
            if target is None or target["owner"].lower() != user.lower():
                raise PermissionError(f"{user} 不能修改排程表 #{target_id}")
            lock = self.conn.execute(
                "SELECT locked_by FROM sheet_locks WHERE sheet_id = ? AND heartbeat_at >= ?",
                (target_id, _expire_before()),
            ).fetchone()
            if lock:
                raise BlockingIOError(f"排程表 #{target_id} 正由 {lock['locked_by']} 編輯中")

            data = self.load_sheet_data(target_id)
            if data is None:
                data = {
                    "version": 4,
                    "title": target["title"],
                    "timeline": source_data.get("timeline") or {},
                    "calendar": {"blocked": {}, "openWeekends": {}},
                    "categories": [],
                }
            calendar = data.setdefault("calendar", {})
            blocked = calendar.setdefault("blocked", {})
            calendar.setdefault("openWeekends", {})
            added = 0
            for day, reason in source_blocked.items():
                if str(day) not in blocked:
                    blocked[str(day)] = reason
                    added += 1
            if added:
                self._insert_version(target_id, target["owner"], user, data)
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        print(f"[models] {user} 複製休假 #{source_id} → #{target_id}：新增 {added} 個反灰日")
        return added

    def list_versions(self, sheet_id: int) -> list[dict[str, Any]]:
        """列出排程表的所有版本，新到舊。"""
        rows = self.conn.execute(
            "SELECT version_no, json_path, saved_by, saved_at, sha256, size_bytes"
            "  FROM sheet_versions WHERE sheet_id = ? ORDER BY version_no DESC",
            (sheet_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def load_sheet_data(self, sheet_id: int, version_no: int | None = None) -> dict[str, Any] | None:
        """讀取排程表某個版本的 JSON 內容，預設讀目前版本。

        :return: 排程表資料；尚無任何版本時回 None
        """
        if version_no is None:
            row = self.conn.execute(
                "SELECT v.json_path FROM sheets s JOIN sheet_versions v ON v.id = s.current_version_id"
                " WHERE s.id = ? AND s.is_deleted = 0",
                (sheet_id,),
            ).fetchone()
        else:
            row = self.conn.execute(
                "SELECT json_path FROM sheet_versions WHERE sheet_id = ? AND version_no = ?",
                (sheet_id, version_no),
            ).fetchone()
        if row is None:
            print(f"[models] 排程表 #{sheet_id} 查無版本 {version_no or '(目前)'}")
            return None
        path = self.json_dir / row["json_path"]
        print(f"[models] 讀取排程表 #{sheet_id}：{row['json_path']}")
        return json.loads(path.read_text(encoding="utf-8"))

    def close(self) -> None:
        """關閉連線。"""
        self.conn.close()


def _init(db_path: Path, json_dir: Path) -> None:
    """建立 db、套用 migration，並建立 JSON 根目錄。"""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    json_dir.mkdir(parents=True, exist_ok=True)
    db = ScheduleDB(db_path, json_dir)
    try:
        db.migrate()
        tables = [r[0] for r in db.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
        print(f"[models] 資料表：{tables}")
    finally:
        db.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="your_schedule 資料庫工具")
    parser.add_argument("--init", action="store_true", help="建立 db 並套用 migration")
    parser.add_argument("--db", type=Path, default=cms.SCHEDULE_DB_PATH, help="db 路徑")
    parser.add_argument("--json-dir", type=Path, default=cms.SCHEDULE_JSON_DIR, help="JSON 根目錄")
    args = parser.parse_args()
    if args.init:
        _init(args.db, args.json_dir)
    else:
        parser.print_help()
