"""HTTP API：登入、排程表清單、讀取／存檔、編輯鎖。

``main.py`` 的 handler 把 ``/api/*`` 交給 :class:`ScheduleApi`，這裡不碰 socket，
只吃（method, path, cookie, body）、回（status, payload, 額外 header），方便測試。
"""

import json
import re
import secrets
import sqlite3
import threading
import time
from collections.abc import Callable
from http.cookies import SimpleCookie
from typing import Any

import mpivr20_cms as cms
from accounts import AccountStore
from introduce import Introduce
from leveloo import LevelooSprite
from models import ScheduleDB

COOKIE_NAME: str = "ys_session"
SESSION_TTL_SECONDS: int = 12 * 60 * 60
MAX_TITLE_LEN: int = 100

Response = tuple[int, dict[str, Any], list[tuple[str, str]]]


class ApiError(Exception):
    """帶 HTTP 狀態碼的錯誤，由 :meth:`ScheduleApi.handle` 轉成 JSON 回應。"""

    def __init__(self, status: int, detail: str) -> None:
        """記下狀態碼與給使用者看的訊息。"""
        super().__init__(detail)
        self.status = status
        self.detail = detail


class ScheduleApi:
    """your_schedule 的 API 路由與業務邏輯。"""

    def __init__(self, accounts: AccountStore | None = None) -> None:
        """建立帳號快取與記憶體內的登入 session 表。"""
        self.accounts = accounts or AccountStore()
        self.leveloo = LevelooSprite()
        self._sessions: dict[str, tuple[str, float]] = {}
        self._lock = threading.Lock()
        self._routes: list[tuple[str, re.Pattern[str], Callable[..., dict[str, Any]], bool]] = [
            ("GET", re.compile(r"/api/health"), self.health, False),
            ("GET", re.compile(r"/api/leveloo"), self.leveloo_sprite, False),
            ("POST", re.compile(r"/api/leveloo/color"), self.leveloo_color, False),
            ("GET", re.compile(r"/api/auth/users"), self.login_users, False),
            ("POST", re.compile(r"/api/auth/login"), self.login, False),
            ("POST", re.compile(r"/api/auth/logout"), self.logout, False),
            ("GET", re.compile(r"/api/me"), self.me, True),
            ("GET", re.compile(r"/api/sheets"), self.list_sheets, True),
            ("POST", re.compile(r"/api/sheets"), self.create_sheet, True),
            ("GET", re.compile(r"/api/sheets/(\d+)"), self.get_sheet, True),
            ("POST", re.compile(r"/api/sheets/(\d+)/lock"), self.lock, True),
            ("POST", re.compile(r"/api/sheets/(\d+)/heartbeat"), self.heartbeat, True),
            ("POST", re.compile(r"/api/sheets/(\d+)/unlock"), self.unlock, True),
            ("POST", re.compile(r"/api/sheets/(\d+)/save"), self.save, True),
            ("POST", re.compile(r"/api/sheets/(\d+)/public"), self.set_public, True),
            ("GET", re.compile(r"/api/profile"), self.profile, True),
            ("GET", re.compile(r"/api/sheets/(\d+)/versions"), self.list_versions, True),
            ("GET", re.compile(r"/api/sheets/(\d+)/versions/(\d+)"), self.get_version, True),
            ("POST", re.compile(r"/api/sheets/(\d+)/copy"), self.copy_sheet, True),
            ("POST", re.compile(r"/api/sheets/(\d+)/copy-holidays"), self.copy_holidays, True),
            ("POST", re.compile(r"/api/sheets/(\d+)/archive"), self.set_archived, True),
        ]

    # ── 共用 ───────────────────────────────────────────────────

    def startup(self) -> None:
        """啟動時確認 db 存在並套用尚未執行的 migration。"""
        db = self._open_db()
        try:
            db.migrate()
        finally:
            db.close()

    def _open_db(self) -> ScheduleDB:
        """每個請求開一條連線（ThreadingHTTPServer 多執行緒，不共用連線）。"""
        return ScheduleDB(cms.SCHEDULE_DB_PATH, cms.SCHEDULE_JSON_DIR)

    def _session_user(self, cookie_header: str | None) -> tuple[str | None, str | None]:
        """從 cookie 找出登入中的帳號，過期的 session 順手清掉。

        :return: （帳號, token），未登入時為 (None, None)
        """
        if not cookie_header:
            return None, None
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
        except Exception:
            return None, None
        morsel = cookie.get(COOKIE_NAME)
        if morsel is None:
            return None, None
        token = morsel.value
        with self._lock:
            found = self._sessions.get(token)
            if found is None:
                return None, None
            if found[1] < time.time():
                del self._sessions[token]
                return None, None
            return found[0], token

    def handle(self, method: str, path: str, cookie_header: str | None, body: bytes) -> Response:
        """依 method 與 path 分派到對應的處理函式。

        :return: （HTTP 狀態碼, JSON 物件, 額外 header）
        """
        path = path.split("?", 1)[0].rstrip("/")
        for route_method, pattern, func, need_login in self._routes:
            match = pattern.fullmatch(path)
            if not match or route_method != method:
                continue
            user, token = self._session_user(cookie_header)
            try:
                if need_login and user is None:
                    raise ApiError(401, "尚未登入")
                payload = json.loads(body.decode("utf-8")) if body else {}
                if not isinstance(payload, dict):
                    raise ApiError(400, "請求格式錯誤")
                ctx = {"user": user, "token": token, "body": payload, "headers": []}
                result = func(ctx, *match.groups())
                return 200, result, ctx["headers"]
            except ApiError as exc:
                return exc.status, {"detail": exc.detail}, []
            except json.JSONDecodeError:
                return 400, {"detail": "請求格式錯誤"}, []
            except sqlite3.Error as exc:
                print(f"[api] ⚠ 資料庫錯誤：{exc}")
                return 503, {"detail": f"資料庫暫時無法使用：{exc}"}, []
            except OSError as exc:
                print(f"[api] ⚠ 檔案存取錯誤：{exc}")
                return 503, {"detail": f"共享槽暫時無法存取：{exc}"}, []
        return 404, {"detail": "找不到這個 API"}, []

    def _visible_sheet(self, db: ScheduleDB, sheet_id: int, user: str) -> dict[str, Any]:
        """取得 user 看得到的排程表；私人表對其他人一律當作不存在。"""
        sheet = db.get_sheet(sheet_id)
        if sheet is None or not db.can_view(sheet, user):
            raise ApiError(404, "找不到這張排程表")
        return sheet

    # ── 登入 ───────────────────────────────────────────────────

    def health(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """回報共享槽上的排程 db 是否連得到（登入頁的燈號用）。"""
        try:
            conn = sqlite3.connect(cms.read_only_uri(cms.SCHEDULE_DB_PATH), uri=True, timeout=5.0)
            try:
                conn.execute("SELECT 1 FROM sheets LIMIT 1").fetchall()
            finally:
                conn.close()
            return {"db": True}
        except sqlite3.Error as exc:
            print(f"[api] ⚠ health 檢查失敗：{exc}")
            return {"db": False}

    def leveloo_sprite(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """登入頁頭像：LEVELOO 底圖；共享槽讀不到時 sprite 為 None。"""
        return {"sprite": self.leveloo.sprite()}

    def leveloo_color(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """登入頁頭像：輸入中帳號的專屬色，查不到為 None（前端用預設黃色）。"""
        return {"color": self.leveloo.color_of(str(ctx["body"].get("user", "")))}

    def login_users(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """登入頁的使用者下拉選單：vr20_data.db accounts 的所有帳號。"""
        return {"users": self.accounts.users()}

    def login(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """驗證帳密，成功後發 session cookie。"""
        body = ctx["body"]
        user = self.accounts.verify(str(body.get("user", "")), str(body.get("password", "")))
        if user is None:
            raise ApiError(401, "帳號或密碼錯誤")
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = (user, time.time() + SESSION_TTL_SECONDS)
        ctx["headers"].append((
            "Set-Cookie",
            f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}",
        ))
        return {"user": user}

    def logout(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """清除 session 與 cookie。"""
        if ctx["token"]:
            with self._lock:
                self._sessions.pop(ctx["token"], None)
            print(f"[api] 登出：{ctx['user']}")
        ctx["headers"].append(("Set-Cookie", f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"))
        return {"ok": True}

    def me(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """回傳目前登入的帳號。"""
        return {"user": ctx["user"]}

    # ── 排程表 ─────────────────────────────────────────────────

    def list_sheets(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """列出看得到的排程表：所有人公開的，加上自己的私人表。"""
        db = self._open_db()
        try:
            sheets = db.list_sheets(ctx["user"])
        finally:
            db.close()
        return {"user": ctx["user"], "sheets": [self._sheet_meta(s, ctx["user"]) for s in sheets]}

    def create_sheet(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """新增一張排程表（尚無版本，第一次存檔才產生 v1）。"""
        title = str(ctx["body"].get("title", "")).strip()[:MAX_TITLE_LEN]
        if not title:
            raise ApiError(400, "請輸入排程表名稱")
        db = self._open_db()
        try:
            sheet_id = db.create_sheet(ctx["user"], title, bool(ctx["body"].get("is_public", True)))
        finally:
            db.close()
        return {"id": sheet_id}

    def get_sheet(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """讀取排程表的中繼資料與目前版本內容。"""
        db = self._open_db()
        try:
            sheet = self._visible_sheet(db, int(sheet_id), ctx["user"])
            data = db.load_sheet_data(sheet["id"])
            chain = db.copy_chain(sheet["id"])
        finally:
            db.close()
        info = Introduce()
        # app：甘特頁右下角顯示的程式版本與模板作者
        app = {"version": info.version, "developer": info.developer}
        return {"sheet": self._sheet_meta(sheet, ctx["user"]), "data": data, "app": app, "copied_from": chain}

    def lock(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """打開編輯：取得編輯鎖。"""
        db = self._open_db()
        try:
            sheet = self._visible_sheet(db, int(sheet_id), ctx["user"])
            if not db.can_edit(sheet, ctx["user"]):
                raise ApiError(403, "只有建立者可以編輯這張排程表")
            if not db.acquire_lock(sheet["id"], ctx["user"]):
                locked_by = db.get_sheet(sheet["id"])["locked_by"]
                raise ApiError(409, f"{locked_by} 正在編輯這張排程表")
        finally:
            db.close()
        return {"ok": True}

    def heartbeat(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """編輯中續約；鎖已被接手時回 409。"""
        db = self._open_db()
        try:
            if not db.heartbeat_lock(int(sheet_id), ctx["user"]):
                raise ApiError(409, "編輯鎖已失效，請重新整理頁面")
        finally:
            db.close()
        return {"ok": True}

    def unlock(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """離開編輯：釋放自己的鎖。"""
        db = self._open_db()
        try:
            db.release_lock(int(sheet_id), ctx["user"])
        finally:
            db.close()
        return {"ok": True}

    def save(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """整張表存回成新版本，存檔後仍保有編輯鎖。"""
        data = ctx["body"].get("data")
        if not isinstance(data, dict) or not isinstance(data.get("categories"), list):
            raise ApiError(400, "排程資料格式錯誤")
        db = self._open_db()
        try:
            sheet = self._visible_sheet(db, int(sheet_id), ctx["user"])
            if not db.can_edit(sheet, ctx["user"]):
                raise ApiError(403, "只有建立者可以編輯這張排程表")
            try:
                version_no = db.save_version(sheet["id"], ctx["user"], data, release=False)
            except PermissionError:
                raise ApiError(409, "編輯鎖已失效，請重新整理頁面後再存檔") from None
            title = str(data.get("title", "")).strip()[:MAX_TITLE_LEN]
            if title:
                db.update_title(sheet["id"], ctx["user"], title)
            updated_at = db.get_sheet(sheet["id"])["updated_at"]
        finally:
            db.close()
        return {"version_no": version_no, "updated_at": updated_at}

    def set_public(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """建立者切換公開／私人。"""
        db = self._open_db()
        try:
            sheet = self._visible_sheet(db, int(sheet_id), ctx["user"])
            if not db.set_public(sheet["id"], ctx["user"], bool(ctx["body"].get("is_public"))):
                raise ApiError(403, "只有建立者可以變更公開設定")
        finally:
            db.close()
        return {"ok": True}

    # ── 清單頁側邊欄、舊版、複製、封存（v3.8） ─────────────────

    def profile(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """清單頁側邊欄：程式資訊＋登入者的 LEVELOO 等級資訊（讀不到時 leveloo 為 None）。"""
        info = Introduce()
        return {
            "program": info.program,
            "version": info.version,
            "developer": info.developer,
            "intro": info.program_intro,
            "user": ctx["user"],
            "leveloo": self.leveloo.profile(ctx["user"]),
        }

    def list_versions(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """排程表的所有版本（新到舊），供「舊版」選單。"""
        db = self._open_db()
        try:
            sheet = self._visible_sheet(db, int(sheet_id), ctx["user"])
            versions = db.list_versions(sheet["id"])
        finally:
            db.close()
        return {
            "sheet": self._sheet_meta(sheet, ctx["user"]),
            "versions": [
                {"version_no": v["version_no"], "saved_by": v["saved_by"], "saved_at": v["saved_at"]}
                for v in versions
            ],
        }

    def get_version(self, ctx: dict[str, Any], sheet_id: str, version_no: str) -> dict[str, Any]:
        """讀取某個舊版本的內容（甘特頁一律唯讀顯示）。"""
        db = self._open_db()
        try:
            sheet = self._visible_sheet(db, int(sheet_id), ctx["user"])
            meta = db.get_version_meta(sheet["id"], int(version_no))
            if meta is None:
                raise ApiError(404, f"找不到 v{version_no}")
            data = db.load_sheet_data(sheet["id"], int(version_no))
            chain = db.copy_chain(sheet["id"])
        finally:
            db.close()
        info = Introduce()
        return {
            "sheet": self._sheet_meta(sheet, ctx["user"]),
            "version": meta,
            "data": data,
            "app": {"version": info.version, "developer": info.developer},
            "copied_from": chain,
        }

    def copy_sheet(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """把看得到的排程表整份複製成自己的新排程表（記下來源）。"""
        title = str(ctx["body"].get("title", "")).strip()[:MAX_TITLE_LEN]
        if not title:
            raise ApiError(400, "請輸入新排程表名稱")
        db = self._open_db()
        try:
            sheet = self._visible_sheet(db, int(sheet_id), ctx["user"])
            new_id = db.copy_sheet(sheet["id"], ctx["user"], title, bool(ctx["body"].get("is_public", True)))
        finally:
            db.close()
        return {"id": new_id}

    def copy_holidays(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """把看得到的排程表的反灰日套用到自己的另一張排程表。"""
        try:
            target_id = int(ctx["body"].get("target_id"))
        except (TypeError, ValueError):
            raise ApiError(400, "請選擇要套用的排程表") from None
        if target_id == int(sheet_id):
            raise ApiError(400, "不能套用到同一張排程表")
        db = self._open_db()
        try:
            sheet = self._visible_sheet(db, int(sheet_id), ctx["user"])
            try:
                added = db.copy_holidays(sheet["id"], target_id, ctx["user"])
            except PermissionError:
                raise ApiError(403, "只能套用到自己的排程表") from None
            except BlockingIOError:
                raise ApiError(409, "目標排程表正在編輯中，請先關閉該排程表再套用") from None
        finally:
            db.close()
        return {"added": added}

    def set_archived(self, ctx: dict[str, Any], sheet_id: str) -> dict[str, Any]:
        """建立者封存／取消封存。"""
        db = self._open_db()
        try:
            sheet = self._visible_sheet(db, int(sheet_id), ctx["user"])
            if not db.set_archived(sheet["id"], ctx["user"], bool(ctx["body"].get("is_archived"))):
                raise ApiError(403, "只有建立者可以封存")
        finally:
            db.close()
        return {"ok": True}

    @staticmethod
    def _sheet_meta(sheet: dict[str, Any], user: str) -> dict[str, Any]:
        """把 db 列整理成前端要的欄位。"""
        return {
            "id": sheet["id"],
            "title": sheet["title"],
            "owner": sheet["owner"],
            "is_public": bool(sheet["is_public"]),
            "is_mine": sheet["owner"].lower() == user.lower(),
            "current_version_no": sheet["current_version_no"],
            "updated_at": sheet["updated_at"],
            "locked_by": sheet["locked_by"],
            "is_archived": bool(sheet.get("is_archived")),
            "copied_from_sheet_id": sheet.get("copied_from_sheet_id"),
        }
