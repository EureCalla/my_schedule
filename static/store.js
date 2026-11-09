// 資料模型、本機自動儲存、復原與 JSON 匯出入
//
// 時間的最小單位是「天」：排程段 start 與里程碑 day 都存「絕對日序」，
// 自 1970-01-05（週一）起算第幾天。
// 排程段存「起始日 start ＋ 工作天數 work」，結束日依反灰（不排工作）日動態推算，
// 所以新增或取消反灰時，跨到的排程會自動延長或縮短，區塊在畫面上維持連續。日／週／月三種檢視只是同一份資料的不同粗細（見 timescale.js），
// 調整畫面的起始月份或檢視尺度時，既有排程不會跟著位移。
// 日期一律用 UTC 計算，避免日光節約時間造成差一天。

const STORAGE_KEY = "your_schedule.v1";
const DATA_VERSION = 4;
const UNDO_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_MONDAY = Date.UTC(1970, 0, 5);
const WEEKDAY_NAMES = "日一二三四五六";
const SCALE_KEYS = ["day", "week", "month"];
const SEARCH_LIMIT = 3660; // 往後找工作日最多十年，避免整段都被反灰時無限迴圈

// 分類自動配色：新分類依序取下一個顏色（淡色系，深色文字可讀）
const PALETTE = [
  "#cfe2f3", "#d9ead3", "#fce5cd", "#e6d7f0", "#f4cccc",
  "#d0e0e3", "#fff2cc", "#ead1dc", "#d9d2e9", "#e2efc6",
];

function paletteColor(index) {
  return PALETTE[index % PALETTE.length];
}

// 分類顏色限制成淡色：彩度（chroma）不超過 0.2、亮度介於 0.8～0.92（HSL，太接近白色會看不出排程）
// 預留高彩度的顏色給之後「實際完成」的排程塊對照用
const MAX_CHROMA = 0.2;
const MIN_LIGHTNESS = 0.8;
const MAX_LIGHTNESS = 0.92;
// 色相拉條選出的顏色固定用這組彩度與亮度，只改色相（紅 0° → 紫 290°）
const HUE_CHROMA = 0.18;
const HUE_LIGHTNESS = 0.86;
const HUE_MAX = 290;

// hex → { h: 色相 0～360, chroma: 彩度 0～1, l: HSL 亮度 0～1 }
function hexToHcl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: h * 60, chroma: max - min, l: (max + min) / 2 };
}

function hclToHex(h, chroma, l) {
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const [r1, g1, b1] =
    h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  const base = l - chroma / 2;
  const toHex = (v) => Math.round((v + base) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

function softenColor(hex) {
  const c = hexToHcl(hex);
  if (!c) return PALETTE[0];
  const l = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, c.l));
  return hclToHex(c.h, Math.min(MAX_CHROMA, c.chroma, 2 * (1 - l)), l);
}

// 色相拉條：只選色相，彩度與亮度固定在淡色範圍內
function hueColor(h) {
  return hclToHex(Math.min(HUE_MAX, Math.max(0, h)), HUE_CHROMA, HUE_LIGHTNESS);
}

function hueOf(hex) {
  const c = hexToHcl(hex);
  return c ? Math.min(HUE_MAX, Math.round(c.h)) : 0;
}

// ---- 日期工具（日序 day：自 1970-01-05 週一起算，day % 7 === 0 即週一） ----
function dayFromYmd(year, month, date) {
  return Math.round((Date.UTC(year, month - 1, date) - EPOCH_MONDAY) / DAY_MS);
}

function ymdOf(day) {
  const d = new Date(EPOCH_MONDAY + day * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, date: d.getUTCDate(), weekday: d.getUTCDay() };
}

function todayDay() {
  const now = new Date();
  return dayFromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function mondayOf(day) {
  return day - (((day % 7) + 7) % 7);
}

// 某月（month 為 1～12）第一個禮拜一的日序
function firstMondayOfMonth(year, month) {
  const first = dayFromYmd(year, month, 1);
  return first + ((7 - (((first % 7) + 7) % 7)) % 7);
}

// 當年第幾週：當年第一個禮拜一那週為第 1 週（年份以週一所在年份為準）
function weekNumber(monday) {
  return (monday - firstMondayOfMonth(ymdOf(monday).year, 1)) / 7 + 1;
}

function fmtDay(day) {
  const d = ymdOf(day);
  return `${d.year}/${d.month}/${d.date}（${WEEKDAY_NAMES[d.weekday]}）`;
}

function rangeLabel(start, end) {
  return start === end ? fmtDay(start) : `${fmtDay(start)} ~ ${fmtDay(end)}`;
}

// ---- 反灰日曆 ----
// calendar.blocked：{ 日序: 原因 }，明確設定為不排工作的日子（原因可為空字串）
// calendar.openWeekends：{ 日序: true }，取消預設反灰的週六日
function isWeekendDay(day) {
  const w = ((day % 7) + 7) % 7; // 0 = 週一，5 = 週六，6 = 週日
  return w === 5 || w === 6;
}

function isBlockedIn(cal, day) {
  return Object.prototype.hasOwnProperty.call(cal.blocked, day) || (isWeekendDay(day) && !cal.openWeekends[day]);
}

function blockReasonIn(cal, day) {
  return cal.blocked[day] || "";
}

// day 當天或之後的第一個工作日
function nextWorkdayIn(cal, day) {
  for (let d = day, i = 0; i < SEARCH_LIMIT; d += 1, i += 1) {
    if (!isBlockedIn(cal, d)) return d;
  }
  return day;
}

function countWorkIn(cal, a, b) {
  let n = 0;
  for (let d = a; d <= b; d += 1) if (!isBlockedIn(cal, d)) n += 1;
  return n;
}

// 從 start 起往後數 work 個工作日，回傳最後一個工作日
function segEndIn(cal, start, work) {
  let left = work;
  for (let d = start, i = 0; i < SEARCH_LIMIT; d += 1, i += 1) {
    if (!isBlockedIn(cal, d)) {
      left -= 1;
      if (left <= 0) return d;
    }
  }
  return start + work - 1;
}

// 段落的實際日期區間（起點若因日曆變動落在反灰日，往後貼到工作日）
function segRangeIn(cal, seg) {
  const start = nextWorkdayIn(cal, seg.start);
  return [start, segEndIn(cal, start, seg.work)];
}

// 段落與「實際日期區間」互轉：切割、合併都在日期區間上做，做完再換回 start + work
function toRanges(cal, segments) {
  return segments.map((seg) => {
    const [start, end] = segRangeIn(cal, seg);
    return { id: seg.id, start, end, text: seg.text };
  });
}

function fromRanges(cal, ranges) {
  return ranges
    .map((r) => {
      const start = nextWorkdayIn(cal, r.start);
      if (start > r.end) return null; // 整段都落在反灰日，丟掉
      return { id: r.id, start, work: countWorkIn(cal, start, r.end), text: r.text };
    })
    .filter(Boolean)
    .sort((x, y) => x.start - y.start);
}

// ---- 舊格式換算 ----
// v1：slot = (年 × 12 + 月 − 1) × 4 + (區段 − 1)，第 n 區段＝該月第 n 個禮拜一那週
function legacyV1ToWeek(old) {
  const monthIndex = Math.floor(old / 4);
  const monday = firstMondayOfMonth(Math.floor(monthIndex / 12), (monthIndex % 12) + 1);
  return monday / 7 + (old % 4);
}

let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

// ---- 示範資料（取自 系統時程規劃_Eulla.xlsx「智能化系統展開」分頁，原表從 2025/11/10 週一起逐日排） ----
function demoData() {
  const base = dayFromYmd(2025, 11, 10);
  const seg = (start, end, text = "") => ({ id: newId("s"), start: base + start, end: base + end, text });
  const ms = (day, name, note = "") => ({ id: newId("m"), day: base + day, name, note });
  const task = (name, status, segments = [], milestones = []) => ({ id: newId("t"), name, status, segments, milestones });
  let catIndex = 0;
  const cat = (name, tasks) => ({ id: newId("c"), name, color: paletteColor(catIndex++), collapsed: false, tasks });

  const holiday = {};
  holiday[dayFromYmd(2026, 1, 1)] = "元旦";
  for (let d = dayFromYmd(2026, 2, 16); d <= dayFromYmd(2026, 2, 22); d += 1) holiday[d] = "春節";

  // 段落以 v3 的 start / end 寫，交給 normalize 換成 start + 工作天數
  return {
    version: 3,
    timeline: { startYear: 2025, startMonth: 11, months: 18, scale: "week" },
    calendar: { blocked: holiday, openWeekends: {} },
    categories: [
      cat("3331 探針物料系統", [
        task("探針物料登入", "v", [seg(53, 53, "Town Hall Meeting")], [ms(91, "Probation", "試用期評核")]),
        task("尺寸登入", "v"),
        task("物料管理", "v"),
        task("排程管理(暫)", "△"),
        task("實驗後物料歸檔", "", [seg(21, 25, "新增模組")]),
        task("搜尋物料", "v"),
        task("物料外觀搜尋", "", [seg(42, 46, "新增模組")]),
      ]),
      cat("3332 PH導板物料系統", [
        task("導板物料登入", "v", [seg(0, 4, "EVS資料庫開發"), seg(21, 25, "微調修整")]),
        task("孔型孔徑尺寸登入", "v", [seg(0, 4, "EVS資料庫開發"), seg(21, 25, "微調修整")]),
        task("物料檢驗登入", "", [seg(35, 39, "新增模組"), seg(42, 46)]),
        task("物料移動", "v"),
        task("物料查詢", "△", [seg(2, 4, "孔型查詢")]),
      ]),
      cat("4441 實驗設計系統", [
        task("實驗設計", "△", [seg(0, 1, "重構PH_daSH")]),
        task("實驗管理", "", [seg(14, 18, "新增模組")]),
        task("實驗人員操作", "", [seg(7, 8, "新增模組"), seg(11, 11), seg(14, 18)]),
        task("實驗物料上傳", "", [seg(16, 18, "串接")], [ms(18, "串接完成")]),
      ]),
      cat("5551 分析模組", [
        task("CFCR分析模組", "v", [seg(58, 81, "Cross-department")]),
        task("CCC分析模組", "v", [seg(58, 81)]),
        task("GetHub分享區", "v", [seg(58, 81)]),
      ]),
      cat("第一輪系統整合 & 上線", [
        task("系統串接", "", [seg(21, 25), seg(28, 29, "整合報告"), seg(31, 32)], [ms(29, "整合報告", "提交第一輪整合報告")]),
        task("系統測試&調整", "", [seg(35, 39, "測試"), seg(42, 46)], [ms(46, "上線")]),
      ]),
    ],
  };
}

function isValidData(data) {
  return Boolean(
    data &&
      Array.isArray(data.categories) &&
      data.timeline &&
      data.categories.every((c) => Array.isArray(c.tasks))
  );
}

// 補齊缺漏欄位，讓匯入的舊格式或手改過的 JSON 也能畫出來
//   v1（每月 4 區段）→ 先換成週；v1／v2（週序）→ 每週換成週一到週日 7 天，里程碑放週一
//   v3（start / end）→ start 貼到工作日，work＝區間內的工作日數
function normalize(data) {
  const version = Number(data.version) || 1;
  const toWeek = (slot) => (version < 2 ? legacyV1ToWeek(slot) : slot);
  data.version = DATA_VERSION;
  data.timeline = {
    startYear: Number(data.timeline.startYear) || 2025,
    startMonth: Number(data.timeline.startMonth) || 1,
    months: Math.max(1, Number(data.timeline.months) || 12),
    scale: SCALE_KEYS.includes(data.timeline.scale) ? data.timeline.scale : "week",
  };
  const cal = data.calendar || {};
  const open = Array.isArray(cal.openWeekends)
    ? Object.fromEntries(cal.openWeekends.map((d) => [d, true]))
    : cal.openWeekends || {};
  data.calendar = { blocked: cal.blocked || {}, openWeekends: open };
  // 顏色跟著分類走，舊格式的圖例不再使用
  delete data.legend;
  data.categories.forEach((c, ci) => {
    c.id = c.id || newId("c");
    c.name = c.name || "";
    c.color = softenColor(c.color || paletteColor(ci));
    c.collapsed = Boolean(c.collapsed);
    c.tasks.forEach((t) => {
      t.id = t.id || newId("t");
      t.name = t.name || "";
      t.status = t.status || "";
      t.segments = Array.isArray(t.segments) ? t.segments : [];
      t.milestones = Array.isArray(t.milestones) ? t.milestones : [];
      t.segments.forEach((s) => {
        s.id = s.id || newId("s");
        s.text = s.text || "";
        delete s.colorId;
        if (version < 3) {
          s.start = toWeek(s.start) * 7;
          s.end = toWeek(s.end) * 7 + 6;
        }
        if (version < 4) {
          const start = nextWorkdayIn(data.calendar, s.start);
          s.work = Math.max(1, countWorkIn(data.calendar, start, s.end));
          s.start = start;
        }
        s.work = Math.max(1, Math.round(Number(s.work)) || 1);
        delete s.end;
      });
      t.milestones.forEach((m) => {
        m.id = m.id || newId("m");
        m.name = m.name || "";
        m.note = m.note || "";
        if (version < 3) {
          m.day = toWeek(m.slot) * 7;
          delete m.slot;
        }
      });
    });
  });
  return data;
}

// 把 [a, b] 範圍從段落清單中挖掉，跨過範圍的段會被切成兩段
function cutRange(segments, a, b) {
  const result = [];
  segments.forEach((s) => {
    if (s.end < a || s.start > b) {
      result.push(s);
      return;
    }
    if (s.start < a) result.push({ ...s, end: a - 1 });
    if (s.end > b) result.push({ ...s, id: newId("s"), start: b + 1, text: s.start < a ? "" : s.text });
  });
  return result;
}

class Store {
  constructor() {
    this.listeners = [];
    this.undoStack = [];
    this.data = this.load() || normalize(demoData());
    console.log("[store] loaded", this.data.categories.length, "categories");
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return isValidData(data) ? normalize(data) : null;
    } catch (err) {
      console.warn("[store] load failed", err);
      return null;
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn("[store] save failed", err);
    }
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  emit() {
    this.listeners.forEach((fn) => fn(this.data));
  }

  // 所有修改都走這裡：先留快照再改，改完自動儲存並通知重畫
  update(fn, { undoable = true } = {}) {
    if (undoable) {
      this.undoStack.push(JSON.stringify(this.data));
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    }
    fn(this.data);
    this.save();
    this.emit();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  undo() {
    if (!this.canUndo()) return;
    this.data = JSON.parse(this.undoStack.pop());
    console.log("[store] undo, remaining", this.undoStack.length);
    this.save();
    this.emit();
  }

  resetDemo() {
    this.update((d) => {
      Object.assign(d, normalize(demoData()));
    });
  }

  exportJson() {
    const blob = new Blob([JSON.stringify(this.data, null, 2)], { type: "application/json" });
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `your_schedule_${stamp}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    console.log("[store] exported", a.download);
  }

  importJson(text) {
    const data = JSON.parse(text);
    if (!isValidData(data)) throw new Error("JSON 格式不符：需要 timeline、categories");
    this.update((d) => {
      Object.keys(d).forEach((k) => delete d[k]);
      Object.assign(d, normalize(data));
    });
    console.log("[store] imported");
  }

  // ---- 查找 ----
  findTask(taskId) {
    for (const c of this.data.categories) {
      const i = c.tasks.findIndex((t) => t.id === taskId);
      if (i >= 0) return { category: c, task: c.tasks[i], index: i };
    }
    return null;
  }

  nextCategoryColor() {
    return paletteColor(this.data.categories.length);
  }

  // ---- 反灰日曆 ----
  isBlocked(day) {
    return isBlockedIn(this.data.calendar, day);
  }

  blockReason(day) {
    return blockReasonIn(this.data.calendar, day);
  }

  nextWorkday(day) {
    return nextWorkdayIn(this.data.calendar, day);
  }

  segEnd(start, work) {
    return segEndIn(this.data.calendar, start, work);
  }

  segRange(seg) {
    return segRangeIn(this.data.calendar, seg);
  }

  // 單日設定；取消週六日時記進 openWeekends，否則它會回到預設反灰
  setDayBlocked(day, blocked, reason) {
    this.update((d) => {
      const cal = d.calendar;
      if (blocked) {
        cal.blocked[day] = reason;
        delete cal.openWeekends[day];
      } else {
        delete cal.blocked[day];
        if (isWeekendDay(day)) cal.openWeekends[day] = true;
      }
    });
  }

  // 整週設定；整週取消時週六日回到預設反灰
  setWeekBlocked(monday, blocked, reason) {
    this.update((d) => {
      const cal = d.calendar;
      for (let day = monday; day < monday + 7; day += 1) {
        delete cal.openWeekends[day];
        if (blocked) cal.blocked[day] = reason;
        else delete cal.blocked[day];
      }
    });
  }

  // ---- 排程段（在實際日期區間上切割／合併，做完換回 start + 工作天數） ----
  paint(taskId, a, b) {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const cal = this.data.calendar;
    const first = nextWorkdayIn(cal, lo);
    if (first > hi) return; // 範圍內全是反灰日，不排
    this.update(() => {
      const { task } = this.findTask(taskId);
      const ranges = toRanges(cal, task.segments);
      // 重塗既有段時保留原本的段落文字
      const covered = ranges.find((r) => r.start <= hi && r.end >= lo && r.text);
      let segs = cutRange(ranges, lo, hi);
      let start = first;
      let end = hi;
      const text = covered ? covered.text : "";
      // 只和相鄰「沒有文字」的段合併；中間只隔著反灰日也算相鄰（週五結束、下週一開始）
      segs = segs.filter((r) => {
        if (r.text && r.text !== text) return true;
        if (r.end < start && countWorkIn(cal, r.end + 1, start - 1) === 0) {
          start = r.start;
          return false;
        }
        if (r.start > end && countWorkIn(cal, end + 1, r.start - 1) === 0) {
          end = r.end;
          return false;
        }
        return true;
      });
      segs.push({ id: newId("s"), start, end, text });
      task.segments = fromRanges(cal, segs);
    });
  }

  erase(taskId, a, b) {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    this.update(() => {
      const cal = this.data.calendar;
      const { task } = this.findTask(taskId);
      task.segments = fromRanges(cal, cutRange(toRanges(cal, task.segments), lo, hi));
    });
  }

  // 整段平移到 newStart（遇反灰往後貼到工作日），工作天數與文字不變，結束日依反灰自動遞補；
  // 落點上原有的排程被蓋掉（同建立排程塊）
  moveSegment(taskId, segId, newStart) {
    this.update(() => {
      const cal = this.data.calendar;
      const { task } = this.findTask(taskId);
      const seg = task.segments.find((s) => s.id === segId);
      const start = nextWorkdayIn(cal, newStart);
      const end = segEndIn(cal, start, seg.work);
      const others = cutRange(toRanges(cal, task.segments.filter((s) => s !== seg)), start, end);
      task.segments = [...fromRanges(cal, others), { ...seg, start }].sort((x, y) => x.start - y.start);
    });
  }

  // 改段落文字與工作天數；變長時蓋掉後面重疊的排程
  updateSegment(taskId, segId, { text, work }) {
    this.update(() => {
      const cal = this.data.calendar;
      const { task } = this.findTask(taskId);
      const seg = task.segments.find((s) => s.id === segId);
      seg.text = text;
      seg.work = Math.max(1, Math.round(work) || 1);
      const [start, end] = segRangeIn(cal, seg);
      const others = cutRange(toRanges(cal, task.segments.filter((s) => s !== seg)), start, end);
      task.segments = [...fromRanges(cal, others), seg].sort((x, y) => x.start - y.start);
    });
  }
}
