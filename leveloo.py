"""LEVELOO 小精靈：登入頁頭像用的像素底圖與每個人的專屬色。

資料來源是 ``vr20_game.db``（只讀不寫）：

* ``Leveloo_orig``：100×100 像素表（row / col / R / G / B），與 Callami 辦事處
  （``600_Leveloo/leveloo_graphics.py`` 的 ``read_base_pixels``）用的是同一張圖
* ``accounts.hex_color_codes``：每個人的專屬色，前端把底圖的橘色換成這個顏色
"""

import re
import sqlite3
import threading
import time

import mpivr20_cms as cms

ROWS: int = 100
COLS: int = 100
#: 底圖的背景色（前端畫成透明）與要換成專屬色的橘色
BACKGROUND_RGB: tuple[int, int, int] = (0, 100, 0)
ORANGE_RGB: tuple[int, int, int] = (217, 122, 31)
#: 專屬色快取秒數
COLOR_CACHE_TTL_SECONDS: int = 300

_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class LevelooSprite:
    """唯讀快取 LEVELOO 底圖與專屬色。"""

    def __init__(self) -> None:
        """建立空快取，第一次使用時才讀共享槽。"""
        self._pixels: list[int] | None = None
        self._colors: dict[str, str] = {}
        self._colors_loaded_at: float = 0.0
        self._lock = threading.Lock()

    def _connect(self) -> sqlite3.Connection:
        """以唯讀 URI 連 ``vr20_game.db``。"""
        return sqlite3.connect(cms.read_only_uri(cms.VR20_GAME_DB_PATH), uri=True, timeout=10.0)

    def sprite(self) -> dict | None:
        """回傳底圖與換色用的常數；共享槽讀不到且沒有快取時回 None。

        :return: ``{rows, cols, background, orange, pixels}``，pixels 為 rows×cols×3 的扁平陣列
        """
        with self._lock:
            if self._pixels is None:
                try:
                    self._pixels = self._load_pixels()
                    print(f"[leveloo] 已載入底圖 {ROWS}x{COLS}")
                except sqlite3.Error as exc:
                    print(f"[leveloo] ⚠ 底圖載入失敗：{exc}")
                    return None
            pixels = self._pixels
        return {
            "rows": ROWS,
            "cols": COLS,
            "background": list(BACKGROUND_RGB),
            "orange": list(ORANGE_RGB),
            "pixels": pixels,
        }

    def _load_pixels(self) -> list[int]:
        """讀 ``Leveloo_orig``，沒有資料的格子補背景色。"""
        pixels = [value for _ in range(ROWS * COLS) for value in BACKGROUND_RGB]
        conn = self._connect()
        try:
            for row, col, red, green, blue in conn.execute("SELECT row, col, R, G, B FROM Leveloo_orig"):
                if 0 <= int(row) < ROWS and 0 <= int(col) < COLS:
                    index = (int(row) * COLS + int(col)) * 3
                    pixels[index : index + 3] = [max(0, min(255, int(v))) for v in (red, green, blue)]
        finally:
            conn.close()
        return pixels

    def color_of(self, user: str) -> str | None:
        """查帳號的專屬色（不分大小寫），查不到或格式不對回 None。"""
        key = (user or "").strip().lower()
        if not key:
            return None
        with self._lock:
            if not self._colors or time.monotonic() - self._colors_loaded_at > COLOR_CACHE_TTL_SECONDS:
                try:
                    self._colors = self._load_colors()
                    self._colors_loaded_at = time.monotonic()
                    print(f"[leveloo] 已載入 {len(self._colors)} 個專屬色")
                except sqlite3.Error as exc:
                    # 共享槽斷線時沿用舊快取；沒有快取就一律回 None（前端用預設黃色）
                    print(f"[leveloo] ⚠ 專屬色載入失敗：{exc}")
            return self._colors.get(key)

    def _load_colors(self) -> dict[str, str]:
        """讀 ``accounts`` 的專屬色，只收 ``#rrggbb`` 格式。"""
        conn = self._connect()
        try:
            rows = conn.execute("SELECT user, hex_color_codes FROM accounts").fetchall()
        finally:
            conn.close()
        return {
            user.lower(): color.strip()
            for user, color in rows
            if user and color and _HEX_COLOR.match(color.strip())
        }
