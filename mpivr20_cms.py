"""Centralized paths and settings for the your_schedule project."""

from pathlib import Path

ROOT_DIR: Path = Path(__file__).resolve().parent
STATIC_DIR: Path = ROOT_DIR / "static"
DB_PATH: Path = ROOT_DIR / "your_schedule.db"

HOST: str = "127.0.0.1"
PORT: int = 8520
