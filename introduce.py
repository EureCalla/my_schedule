"""Program metadata for the your_schedule project."""


class Introduce:
    """Expose program identity and version information."""

    def __init__(self) -> None:
        self.program = "your_schedule"
        self.version = "v2.0"
        self.developer = "Calla.Lin #6381"
        self.program_intro = "your_schedule 排程工具，HTML 前端介面雛形。"
        self.program_notice = "執行 python main.py 後開 http://localhost:8520。"
