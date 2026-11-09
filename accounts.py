"""VR20 帳號讀取與驗證。

帳號的真相來源是 ``vr20_data.db`` 的 ``accounts`` 表（``user`` / ``password`` / ``permissions``），
那是 VR20 系統的資料庫，本程式**只讀不寫**。密碼是明文存放，這裡只做比對。
寫法參考 fellami-server 的 ``fellami_server/auth/accounts.py``。
"""

import secrets
import sqlite3
import threading
import time

import mpivr20_cms as cms

#: 帳號表快取秒數；db 在網路磁碟上，不要每次登入都去開
CACHE_TTL_SECONDS: int = 300


class AccountStore:
    """accounts 表的唯讀快取與帳密驗證。"""

    def __init__(self) -> None:
        """建立空快取，第一次使用時才載入。"""
        self._accounts: dict[str, tuple[str, str]] = {}
        self._loaded_at: float = 0.0
        self._lock = threading.Lock()

    def _load_from_db(self) -> dict[str, tuple[str, str]]:
        """以唯讀 URI 讀出所有帳號。

        :return: 以小寫帳號為 key、值為（原始大小寫帳號, 密碼）的字典
        :raises sqlite3.Error: 網路磁碟不可用時
        """
        conn = sqlite3.connect(cms.read_only_uri(cms.VR20_DB_PATH), uri=True, timeout=10.0)
        try:
            rows = conn.execute("SELECT user, password FROM accounts").fetchall()
        finally:
            conn.close()
        return {user.lower(): (user, password or "") for user, password in rows if user}

    def load(self, force: bool = False) -> dict[str, tuple[str, str]]:
        """取得帳號表，快取過期才重讀；重讀失敗時沿用舊快取。"""
        with self._lock:
            stale = not self._accounts or time.monotonic() - self._loaded_at > CACHE_TTL_SECONDS
            if force or stale:
                try:
                    self._accounts = self._load_from_db()
                    self._loaded_at = time.monotonic()
                    print(f"[accounts] 已載入 {len(self._accounts)} 個帳號")
                except sqlite3.Error as exc:
                    if not self._accounts:
                        print(f"[accounts] ⚠ 載入失敗且無快取可用：{exc}")
                        raise
                    print(f"[accounts] ⚠ 重新載入失敗，沿用既有快取：{exc}")
            return self._accounts

    def users(self) -> list[str]:
        """登入頁下拉選單用：所有帳號（原始大小寫，不分大小寫排序），不含密碼。"""
        return sorted((user for user, _ in self.load().values()), key=str.lower)

    def verify(self, user: str, password: str) -> str | None:
        """驗證帳密（帳號不分大小寫）。

        :return: 成功時回傳 accounts 裡原始大小寫的帳號，失敗回 None
        """
        found = self.load().get((user or "").strip().lower())
        if found is None:
            print(f"[accounts] 登入失敗（查無帳號）：{user!r}")
            return None
        if not secrets.compare_digest(found[1].encode("utf-8"), (password or "").encode("utf-8")):
            print(f"[accounts] 登入失敗（密碼錯誤）：{found[0]}")
            return None
        print(f"[accounts] 登入成功：{found[0]}")
        return found[0]
