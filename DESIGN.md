# your_schedule 設計說明

UI 採 HTML 前端（HTML / CSS / vanilla JavaScript），由 `main.py` 以 Python 標準庫靜態伺服 `static/`。

## 版面

```
┌ 工具列：模式（建立排程塊／清除／移動／里程碑／選取）、復原、＋分類、時間範圍、匯出入 ┐
├ 分類顏色列：每個分類一個自動配色，點色塊可改                             ┤
├──────────────┬────────────┬──────┬─ 2025年 11月 ─┬─ 12月 ─┬─ …   ┤ ← 表頭兩層，sticky top
│ 分類           │ 工作項目     │ 狀態   │ 44 45 46 47     │ 48 … 52 │       │ ← 當年第幾週
├──────────────┼────────────┼──────┼────────────────────────────┤
│ 3331 探針物料  │ 物料登入     │  v     │ ████ 開發 ▲                  │
│ （跨列合併）   │ 物料查詢     │  △     │        ███ 微調               │
└──────────────┴────────────┴──────┴────────────────────────────┘
  ↑ 左三欄 sticky left                    ↑ 時間軸可橫向捲動
```

- 整張圖是一個 CSS grid，左三欄與表頭用 `position: sticky`，因此左右天然同列對齊
- 每個工作列的時間軸是一個跨 N 格的元素，格線用 `background-image` 畫（每 4 格一條較深的月分隔線）
- 排程段與里程碑以絕對定位疊在時間軸上
- 分類格跨該分類所有列（同 Excel 合併儲存格），分類之間以粗線分隔

## 資料模型（`static/store.js`）

```json
{
  "version": 1,
  "timeline": { "startYear": 2025, "startMonth": 11, "months": 18, "scale": "week" },
  "calendar": { "blocked": { "20450": "元旦" }, "openWeekends": { "20452": true } },
  "categories": [
    { "id": "c…", "name": "3331 探針物料系統", "color": "#cfe2f3", "collapsed": false,
      "tasks": [
        { "id": "t…", "name": "物料登入", "status": "v",
          "segments":   [{ "id": "s…", "start": 20398, "work": 5, "text": "開發" }],
          "milestones": [{ "id": "m…", "day": 20402, "name": "上線", "note": "" }] }
      ] }
  ]
}
```

- `title`：排程表名稱（預設 your_schedule）；`layout.catWidth`：分類欄寬度 80～480px（拖曳表頭調整，不進復原堆疊）
- 時間最小單位是「天」：段落 `start` 與里程碑 `day` 都是絕對日序，自 1970-01-05（週一）起算第幾天（`day % 7 === 0` 即週一）
- `timeline.scale` 為檢視尺度 `day` / `week` / `month`（閱讀偏好，不進復原堆疊）；`timeline` 其餘欄位只決定顯示範圍
- `static/timescale.js` 依尺度把範圍切成連續格子（日＝每天；週＝起始月第一個禮拜一起每 7 天；月＝每月），格內日子按比例分配寬度，因此粗尺度下也能看出排程落在格內哪一段
- 週數顯示：每年第一個禮拜一那週為第 1 週；週檢視依週一所在月份分組（每月 4 或 5 週），日檢視依月份、月檢視依年份分組，分隔線由 `--month-lines` 動態漸層畫出
- 每個工作有兩種排程段：`segments`＝預計排程、`actuals`＝實際執行，結構相同、分開存放；切割／合併／蓋掉只在同一種清單內做，所以兩者可重疊。繪製時先預計後實際（實際在上），實際執行用 `strongColor`（同色相，彩度 0.42／亮度 0.62，條紋 0.3／0.74）畫 45° 粗斜線
- 段落存「起始日 `start`＋工作天數 `work`」，不存結束日；結束日由 `segEnd` 從 start 往後數 work 個非反灰日推算，所以反灰變動時排程自動延長／縮短。切割、合併、移動都先換成實際日期區間（`toRanges`）用 `cutRange` 處理，再換回 start + work（`fromRanges`）
- 反灰：`calendar.blocked`（日序 → 原因，明確不排工作）＋週六日預設反灰，`calendar.openWeekends` 記錄取消預設的週末日；整週設定＝7 天一起寫入。畫面上以 `.blocked-col` 半透明灰欄（z-index 1）蓋在排程塊上面，看得出那幾天不排工作、透過去仍看得到區塊連續；原因直式置中顯示在灰欄上；週檢視只有 7 天全反灰才畫，月檢視不畫
- `version: 4`；v3（start / end）→ start 貼到工作日、work＝區間內工作日數；v1（每月 4 區段）→ 第 n 區段換成該月第 n 個禮拜一那週；v1／v2（週序）→ 每週換成週一到週日 7 天，里程碑放週一
- 顏色跟著分類走：`category.color` 在新增分類時從色盤依序自動配置，可手動改；段落本身不存顏色
- 一項工作可有多段 `segments`，各自有文字；新建立的排程塊會蓋過重疊部分（切開舊段），只與相鄰「沒有文字」的段合併
- 匯入舊格式（含 `legend` / `colorId`）時會自動捨棄這兩個欄位並補上分類顏色
- 狀態：`""`、`"△"`（進行中）、`"v"`（完成）

## 色票

| 用途 | 值 |
|------|----|
| 背景 | `#f7f7f5` |
| 表頭、分類欄、工作項目欄（同色） | `#eceef0` |
| 強調（選取中） | `#3b6ea5` |
| 里程碑 ▲ | `#c0392b` |
| 目前進度線 | `#8b0000` |
| 分類顏色限制 | 改色用色相拉條 `hueColor`（色相 0～290°，彩度 0.18、亮度 0.86 固定）；載入／匯入時以 `softenColor` 限制彩度 ≤ 0.2、HSL 亮度 0.8～0.92 |
| 分類色盤（依序） | `#cfe2f3` `#d9ead3` `#fce5cd` `#e6d7f0` `#f4cccc` `#d0e0e3` `#fff2cc` `#ead1dc` `#d9d2e9` `#e2efc6` |

字型：Microsoft JhengHei。列高 28px、時間格寬 26px。

## 待後續

- 日期檢視（實際日曆週／日）
- 排程表互相引用（預計 `002_*.sql` 新增 `sheet_refs`）
- 歷史版本的檢視與還原介面（資料已保留在 `sheet_versions`）

## 頁面流程（v3.2）

- `/` → 清單頁；任何 API 回 401 就導回 `/login.html`
- 登入頁：配色與版面照搬 fellami-client（深灰底 `#202124`＋鵝黃 `#f5d97b`、圓形頭像框、資料庫燈號）；清單與甘特頁維持原本淺色
- 清單頁：卡片左緣藍色＝自己的表；🔒＝私人；✎＝某人編輯中；篩選選項由清單裡的擁有者動態產生，選擇記在 localStorage
- 甘特頁唯讀（`body.readonly`）：隱藏編輯工具與列上的小按鈕；`Store.readOnly` 擋掉所有可復原的修改，`Gantt` 的拖曳與編輯對話框也直接略過；閱讀偏好（尺度、收合、欄寬）只改本機、不存檔
- 存檔後**仍保有編輯鎖**（可以繼續改），離開頁面（← 清單、登出、`pagehide` beacon）才釋放
- 心跳或存檔回 409（鎖被接手）時轉為唯讀，未存檔的修改留在瀏覽器草稿
- v3.3：匯出入與示範資料按鈕隱藏（`#file-group[hidden]`）；右下角固定 `.sheet-footer` 顯示「版本｜Calla.Lin #6381 行事曆模板｜修改日期」，版本與作者由 `GET /api/sheets/{id}` 的 `app` 欄位帶入（讀 `introduce.py`），修改日期為 `sheets.updated_at`
- v3.4：登入頁頭像換成 LEVELOO。畫法同辦事處 `drawAvatar()`：底圖背景綠 `(0,100,0)` 畫成透明露出霧灰框底 `#e1e3e0`，橘 `(217,122,31)` 換成專屬色（查不到用 `#f5d97b`），不做脖子位移。`GET /api/leveloo`、`POST /api/leveloo/color` 不需登入（會透露帳號是否存在，內部名單可接受）。動畫：輸入停 300ms 後彈出（`leveloo-pop` 0.6s 衝過頭再落回）、換人且換色先縮回再彈、同色輕跳、清空縮回；`prefers-reduced-motion` 時不做動畫。讀不到底圖維持 📅

## 多人共用資料層（v3，`models.py` + `migrations/001_init.sql`）

- db 只做索引，排程表本體是 `10_Schedule` 下的 JSON（內容即上面的資料模型）
- `sheets`：建立者 `owner`（accounts.user）、`is_public` 預設 1（公開＝所有人可看）、`current_version_id`、軟刪除
- `sheet_versions`：每次存檔一列，`json_path` 相對於 `10_Schedule`，附 sha256 與大小；JSON 檔不覆蓋，保留完整歷史
- `sheet_locks`：打開編輯即上鎖，只有建立者能上鎖；`save_version` 預設存檔即釋放（甘特頁用 `release=False` 續持）；心跳超過 `LOCK_TIMEOUT_MINUTES`（30 分）視為失效，可被接手
- 帳號比對一律不分大小寫；時間存 UTC ISO 8601；共享槽上維持 `journal_mode=DELETE`（不用 WAL）
