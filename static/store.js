// 資料模型、本機自動儲存、復原與 JSON 匯出入
//
// 時間格（slot）一律存「絕對值」：slot = (年 × 12 + 月 − 1) × 4 + (區段 − 1)
// 這樣調整畫面的起始月份時，既有排程不會跟著位移。

const STORAGE_KEY = "your_schedule.v1";
const UNDO_LIMIT = 50;
const SLOTS_PER_MONTH = 4;

function slotOf(year, month, section) {
  return (year * 12 + month - 1) * SLOTS_PER_MONTH + (section - 1);
}

function slotInfo(slot) {
  const monthIndex = Math.floor(slot / SLOTS_PER_MONTH);
  return {
    year: Math.floor(monthIndex / 12),
    month: (monthIndex % 12) + 1,
    section: (slot % SLOTS_PER_MONTH) + 1,
  };
}

function slotLabel(slot) {
  const s = slotInfo(slot);
  return `${s.year}/${String(s.month).padStart(2, "0")} 第${s.section}區段`;
}

let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

// ---- 示範資料（取自 系統時程規劃_Eulla.xlsx「智能化系統展開」分頁，換算成月區段） ----
function demoData() {
  const base = slotOf(2025, 11, 1);
  const seg = (start, end, colorId, text = "") => ({ id: newId("s"), start: base + start, end: base + end, colorId, text });
  const ms = (slot, name, note = "") => ({ id: newId("m"), slot: base + slot, name, note });
  const task = (name, status, segments = [], milestones = []) => ({ id: newId("t"), name, status, segments, milestones });
  const cat = (name, tasks) => ({ id: newId("c"), name, collapsed: false, tasks });

  return {
    version: 1,
    timeline: { startYear: 2025, startMonth: 11, months: 18 },
    legend: [
      { id: "dev", color: "#cfe2f3", label: "開發" },
      { id: "tune", color: "#d9ead3", label: "微調" },
      { id: "exp", color: "#fce5cd", label: "實驗系統" },
      { id: "int", color: "#e6d7f0", label: "整合測試" },
      { id: "event", color: "#f4cccc", label: "活動 / 會議" },
    ],
    categories: [
      cat("3331 探針物料系統", [
        task("探針物料登入", "v", [seg(8, 8, "event", "Town Hall Meeting")], [ms(13, "Probation", "試用期評核")]),
        task("尺寸登入", "v"),
        task("物料管理", "v"),
        task("排程管理(暫)", "△"),
        task("實驗後物料歸檔", "", [seg(4, 4, "dev", "新增模組")]),
        task("搜尋物料", "v"),
        task("物料外觀搜尋", "", [seg(7, 7, "dev", "新增模組")]),
      ]),
      cat("3332 PH導板物料系統", [
        task("導板物料登入", "v", [seg(0, 1, "dev", "EVS資料庫開發"), seg(4, 4, "tune", "微調修整")]),
        task("孔型孔徑尺寸登入", "v", [seg(0, 1, "dev", "EVS資料庫開發"), seg(4, 4, "tune", "微調修整")]),
        task("物料檢驗登入", "", [seg(6, 7, "dev", "新增模組")]),
        task("物料移動", "v"),
        task("物料查詢", "△", [seg(1, 1, "dev", "孔型查詢")]),
      ]),
      cat("4441 實驗設計系統", [
        task("實驗設計", "△", [seg(1, 1, "exp", "重構PH_daSH")]),
        task("實驗管理", "", [seg(3, 3, "exp", "新增模組")]),
        task("實驗人員操作", "", [seg(2, 3, "exp", "新增模組")]),
        task("實驗物料上傳", "", [seg(3, 4, "exp", "串接")], [ms(4, "串接完成")]),
      ]),
      cat("5551 分析模組", [
        task("CFCR分析模組", "v", [seg(8, 11, "tune", "Cross-department")]),
        task("CCC分析模組", "v", [seg(8, 11, "tune")]),
        task("GetHub分享區", "v", [seg(8, 11, "tune")]),
      ]),
      cat("第一輪系統整合 & 上線", [
        task("系統串接", "", [seg(4, 4, "int"), seg(5, 5, "int", "整合報告")], [ms(5, "整合報告", "提交第一輪整合報告")]),
        task("系統測試&調整", "", [seg(6, 7, "int", "測試")], [ms(7, "上線")]),
      ]),
    ],
  };
}

function isValidData(data) {
  return Boolean(
    data &&
      Array.isArray(data.legend) &&
      Array.isArray(data.categories) &&
      data.timeline &&
      data.categories.every((c) => Array.isArray(c.tasks))
  );
}

// 補齊缺漏欄位，讓匯入的舊格式或手改過的 JSON 也能畫出來
function normalize(data) {
  data.version = 1;
  data.timeline = {
    startYear: Number(data.timeline.startYear) || 2025,
    startMonth: Number(data.timeline.startMonth) || 1,
    months: Math.max(1, Number(data.timeline.months) || 12),
  };
  data.legend.forEach((l) => {
    l.id = l.id || newId("l");
    l.color = l.color || "#cccccc";
    l.label = l.label || "";
  });
  data.categories.forEach((c) => {
    c.id = c.id || newId("c");
    c.name = c.name || "";
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
      });
      t.milestones.forEach((m) => {
        m.id = m.id || newId("m");
        m.name = m.name || "";
        m.note = m.note || "";
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
    if (!isValidData(data)) throw new Error("JSON 格式不符：需要 timeline、legend、categories");
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

  legendById(id) {
    return this.data.legend.find((l) => l.id === id);
  }

  // ---- 排程段 ----
  paint(taskId, a, b, colorId) {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    this.update(() => {
      const { task } = this.findTask(taskId);
      // 用同色重塗既有段時保留原本的段落文字
      const sameColor = task.segments.find((s) => s.colorId === colorId && s.start <= hi && s.end >= lo && s.text);
      let segs = cutRange(task.segments, lo, hi);
      let start = lo;
      let end = hi;
      let text = sameColor ? sameColor.text : "";
      // 相鄰同色的段併成一段，接著拖就像在 Excel 延長同一塊顏色
      segs = segs.filter((s) => {
        if (s.colorId !== colorId) return true;
        if (s.end === start - 1) {
          start = s.start;
          text = s.text || text;
          return false;
        }
        if (s.start === end + 1) {
          end = s.end;
          text = text || s.text;
          return false;
        }
        return true;
      });
      segs.push({ id: newId("s"), start, end, colorId, text });
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
