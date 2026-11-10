"""Program metadata for the your_schedule project."""


class Introduce:
    """Expose program identity and version information."""

    def __init__(self) -> None:
        self.program = "your_schedule"
        self.version = "v4.1"
        self.developer = "Calla.Lin #6381"
        self.program_intro = "快速甘特你的計畫"
        self.program_notice = "執行 python main.py 後開 http://localhost:3330（內網其他人用啟動時印出的 IP:3330），以 VR20 帳密登入；排程表存在共享槽（vr20_schedule.db 索引＋10_Schedule JSON），按「存檔」才會寫回並產生新版本。"
