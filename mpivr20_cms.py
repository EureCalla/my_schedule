"""Centralized paths and settings for the your_schedule project."""

from pathlib import Path

ROOT_DIR: Path = Path(__file__).resolve().parent
STATIC_DIR: Path = ROOT_DIR / "static"
MIGRATIONS_DIR: Path = ROOT_DIR / "migrations"

# 共享槽：多人共用的索引 db 與排程表 JSON 本體
SHARE_ROOT: Path = Path(r"\\mpi-file01\VPCRD2-AI")
SCHEDULE_DB_PATH: Path = SHARE_ROOT / "00_Database_Center" / "vr20_schedule.db"
SCHEDULE_JSON_DIR: Path = SHARE_ROOT / "10_Schedule"
# VR20 系統的帳號表（accounts），只讀不寫
VR20_DB_PATH: Path = SHARE_ROOT / "00_Database_Center" / "vr20_data.db"

DB_PATH: Path = SCHEDULE_DB_PATH

# 編輯鎖的心跳超過這個分鐘數就視為失效，別人可以接手
LOCK_TIMEOUT_MINUTES: int = 30

HOST: str = "127.0.0.1"
PORT: int = 8520


def read_only_uri(path: Path) -> str:
    """把路徑轉成 SQLite 的唯讀 URI。

    UNC 路徑不能直接塞進 ``file:``：``file://mpi-file01/x.db`` 會被當成 URI 的
    authority 而被拒絕，要多兩個斜線寫成 ``file:////mpi-file01/x.db``。

    :param path: db 檔路徑，可為本機或 UNC
    :return: 可交給 ``sqlite3.connect(..., uri=True)`` 的唯讀 URI
    """
    posix = str(path).replace("\\", "/")
    if posix.startswith("//"):
        posix = "//" + posix
    return f"file:{posix}?mode=ro"
