# your_schedule

排程工具（雛形階段）。

- UI：HTML 前端（HTML / CSS / JavaScript），後端 Python 標準庫，不需安裝套件
- 資料庫：SQLite（schema 待定）

## 啟動

```bash
python main.py
```

開啟 http://localhost:8520

## 檔案

| 檔案 | 說明 |
|------|------|
| `main.py` | 程式入口，伺服 `static/` |
| `introduce.py` | 程式名稱、版本、開發者 |
| `mpivr20_cms.py` | 路徑與 port 集中管理 |
| `models.py` | SQLite 存取 |
| `static/` | HTML / CSS / JS 前端 |
| `DESIGN.md` | UI 設計紀錄 |
