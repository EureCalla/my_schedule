// 資料模型、本機自動儲存、復原與 JSON 匯出入
//
// 一格＝一週（週一開始）。時間格（slot）存「絕對週序」：自 1970-01-05（週一）起算第幾週，
// 這樣調整畫面的起始月份時，既有排程不會跟著位移。
// 日期一律用 UTC 計算，避免日光節約時間造成差一天。

const STORAGE_KEY = "your_schedule.v1";
const DATA_VERSION = 2;
const UNDO_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const EPOCH_MONDAY = Date.UTC(1970, 0, 5);

// 分類自動配色：新分類依序取下一個顏色（淡色系，深色文字可讀）
const PALETTE = [
  "#cfe2f3", "#d9ead3", "#fce5cd", "#e6d7f0", "#f4cccc",
  "#d0e0e3", "#fff2cc", "#ead1dc", "#d9d2e9", "#e2efc6",
];

function paletteColor(index) {
  return PALETTE[index % PALETTE.length];
}

// 某個 UTC 時間所在那週的週序
function weekOf(utcMs) {
  return Math.floor((utcMs - EPOCH_MONDAY) / WEEK_MS);
}

function mondayOf(slot) {
  return new Date(EPOCH_MONDAY + slot * WEEK_MS);
}

// 某月（month 為 1～12）的第一個禮拜一所在週序
function firstMondaySlot(year, month) {
  const first = Date.UTC(year, month - 1, 1);
  const weekday = new Date(first).getUTCDay(); // 0 = 週日
  return weekOf(first + ((8 - weekday) % 7) * DAY_MS);
}

function todaySlot() {
  const now = new Date();
  return weekOf(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

// 週一所在的年、月、日，以及當年第幾週（當年第一個禮拜一那週為第 1 週）
function slotInfo(slot) {
  const monday = mondayOf(slot);
  const year = monday.getUTCFullYear();
  return {
    year,
    month: monday.getUTCMonth() + 1,
    day: monday.getUTCDate(),
    week: slot - firstMondaySlot(year, 1) + 1,
  };
}

function slotLabel(slot) {
  const s = slotInfo(slot);
  return `${s.year} 第${s.week}週（${s.month}/${s.day} 起）`;
}

// v1 舊格式：slot = (年 × 12 + 月 − 1) × 4 + (區段 − 1)，換成該月第 n 個禮拜一那週
function legacySlotToWeek(old) {
  const monthIndex = Math.floor(old / 4);
  const section = (old % 4) + 1;
  return firstMondaySlot(Math.floor(monthIndex / 12), (monthIndex % 12) + 1) + section - 1;
}

let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

// ---- 示範資料（取自 系統時程規劃_Eulla.xlsx「智能化系統展開」分頁，原表從 2025/11/10 週一起逐日排，換算成週） ----
function demoData() {
  const base = weekOf(Date.UTC(2025, 10, 10));
  const seg = (start, end, text = "") => ({ id: newId("s"), start: base + start, end: base + end, text });
  const ms = (slot, name, note = "") => ({ id: newId("m"), slot: base + slot, name, note });
  const task = (name, status, segments = [], milestones = []) => ({ id: newId("t"), name, status, segments, milestones });
  let catIndex = 0;
  const cat = (name, tasks) => ({ id: newId("c"), name, color: paletteColor(catIndex++), collapsed: false, tasks });

  return {
    version: DATA_VERSION,
    timeline: { startYear: 2025, startMonth: 11, months: 18 },
    categories: [
      cat("3331 探針物料系統", [
        task("探針物料登入", "v", [seg(7, 7, "Town Hall Meeting")], [ms(13, "Probation", "試用期評核")]),
        task("尺寸登入", "v"),
        task("物料管理", "v"),
        task("排程管理(暫)", "△"),
        task("實驗後物料歸檔", "", [seg(3, 3, "新增模組")]),
        task("搜尋物料", "v"),
        task("物料外觀搜尋", "", [seg(6, 6, "新增模組")]),
      ]),
      cat("3332 PH導板物料系統", [
        task("導板物料登入", "v", [seg(0, 0, "EVS資料庫開發"), seg(3, 3, "微調修整")]),
        task("孔型孔徑尺寸登入", "v", [seg(0, 0, "EVS資料庫開發"), seg(3, 3, "微調修整")]),
        task("物料檢驗登入", "", [seg(5, 6, "新增模組")]),
        task("物料移動", "v"),
        task("物料查詢", "△", [seg(0, 0, "孔型查詢")]),
      ]),
      cat("4441 實驗設計系統", [
        task("實驗設計", "△", [seg(0, 0, "重構PH_daSH")]),
        task("實驗管理", "", [seg(2, 2, "新增模組")]),
        task("實驗人員操作", "", [seg(1, 2, "新增模組")]),
        task("實驗物料上傳", "", [seg(2, 2, "串接")], [ms(2, "串接完成")]),
      ]),
      cat("5551 分析模組", [
        task("CFCR分析模組", "v", [seg(8, 11, "Cross-department")]),
        task("CCC分析模組", "v", [seg(8, 11)]),
        task("GetHub分享區", "v", [seg(8, 11)]),
      ]),
      cat("第一輪系統整合 & 上線", [
        task("系統串接", "", [seg(3, 3), seg(4, 4, "整合報告")], [ms(4, "整合報告", "提交第一輪整合報告")]),
        task("系統測試&調整", "", [seg(5, 6, "測試")], [ms(6, "上線")]),
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
function normalize(data) {
  const legacy = (Number(data.version) || 1) < 2;
  data.version = DATA_VERSION;
  data.timeline = {
    startYear: Number(data.timeline.startYear) || 2025,
    startMonth: Number(data.timeline.startMonth) || 1,
    months: Math.max(1, Number(data.timeline.months) || 12),
  };
  // 顏色跟著分類走，舊格式的圖例不再使用
  delete data.legend;
  data.categories.forEach((c, ci) => {
    c.id = c.id || newId("c");
    c.name = c.name || "";
    c.color = c.color || paletteColor(ci);
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
        if (legacy) {
          s.start = legacySlotToWeek(s.start);
          s.end = legacySlotToWeek(s.end);
        }
      });
      t.milestones.forEach((m) => {
        m.id = m.id || newId("m");
        m.name = m.name || "";
        m.note = m.note || "";
        if (legacy) m.slot = legacySlotToWeek(m.slot);
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

  // ---- 排程段 ----
  paint(taskId, a, b) {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    this.update(() => {
      const { task } = this.findTask(taskId);
      // 重塗既有段時保留原本的段落文字
      const covered = task.segments.find((s) => s.start <= hi && s.end >= lo && s.text);
      let segs = cutRange(task.segments, lo, hi);
      let start = lo;
      let end = hi;
      const text = covered ? covered.text : "";
      // 只和相鄰「沒有文字」的段合併，讓「開發」後面可以緊接一段「測試」
      segs = segs.filter((s) => {
        if (s.text && s.text !== text) return true;
        if (s.end === start - 1) {
          start = s.start;
          return false;
        }
        if (s.start === end + 1) {
          end = s.end;
          return false;
        }
        return true;
      });
      segs.push({ id: newId("s"), start, end, text });
      task.segments = segs.sort((x, y) => x.start - y.start);
    });
  }

  erase(taskId, a, b) {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    this.update(() => {
      const { task } = this.findTask(taskId);
      task.segments = cutRange(task.segments, lo, hi);
    });
  }
}
