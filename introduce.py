"""Program metadata for the your_schedule project."""


class Introduce:
    """Expose program identity and version information."""

    def __init__(self) -> None:
        self.program = "your_schedule"
        self.version = "v2.2"
        self.developer = "Calla.Lin #6381"
        self.program_intro = "your_schedule 甘特圖編輯介面：左側工作表格、右側月區段格線，以格子上色排程。"
        self.program_notice = "執行 python main.py 後開 http://localhost:8520；資料存在瀏覽器 localStorage，請定期匯出 JSON 備份。"
