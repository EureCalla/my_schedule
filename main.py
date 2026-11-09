"""Entry point: serve the static HTML front end."""

import functools
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import mpivr20_cms as cms
from api import ScheduleApi
from introduce import Introduce

#: API 請求本體上限（整張排程表 JSON），避免誤送超大檔案
MAX_BODY_BYTES: int = 20 * 1024 * 1024


class ScheduleHandler(SimpleHTTPRequestHandler):
    """``/api/*`` 交給 :class:`ScheduleApi`，其餘照舊伺服 ``static/``。"""

    def __init__(self, *args, api: ScheduleApi, **kwargs) -> None:
        """記下共用的 API 物件（session 表在裡面，所有請求共用一份）。"""
        self.api = api
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        """GET：API、首頁導向或靜態檔。"""
        if self.path.startswith("/api/"):
            self._handle_api("GET")
        elif self.path.split("?", 1)[0] == "/":
            self.send_response(302)
            self.send_header("Location", "/sheets.html")
            self.end_headers()
        else:
            super().do_GET()

    def do_POST(self) -> None:
        """POST：只有 API。"""
        if self.path.startswith("/api/"):
            self._handle_api("POST")
        else:
            self.send_error(405)

    def end_headers(self) -> None:
        """一律不快取，改完前端重新整理就生效。"""
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _handle_api(self, method: str) -> None:
        """讀取請求本體、交給 API，再把結果寫成 JSON。"""
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            status, payload, headers = 413, {"detail": "資料太大"}, []
        else:
            body = self.rfile.read(length) if length else b""
            status, payload, headers = self.api.handle(method, self.path, self.headers.get("Cookie"), body)
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args) -> None:
        """只印 API 請求，靜態檔不洗版。"""
        if self.path.startswith("/api/"):
            super().log_message(format, *args)


def main() -> None:
    """Serve the static folder until Ctrl+C."""
    sys.stdout.reconfigure(encoding="utf-8")
    info = Introduce()
    print(f"[main] {info.program} {info.version}")
    api = ScheduleApi()
    api.startup()
    handler = functools.partial(ScheduleHandler, directory=str(cms.STATIC_DIR), api=api)
    server = ThreadingHTTPServer((cms.HOST, cms.PORT), handler)
    print(f"[main] 本機：http://localhost:{cms.PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[main] 已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
