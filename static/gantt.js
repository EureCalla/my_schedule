// 甘特圖繪製與操作：左側工作表格 + 右側時間格線
//
// 版面是一個 CSS grid：前三欄（分類／工作項目／狀態）sticky 固定在左，
// 兩層表頭 sticky 固定在上；每個工作列的時間軸是一個跨 N 格的元素，
// 格線用背景畫，排程段與里程碑以絕對定位疊在上面。

const CELL_W = 26;
const STATUS_CYCLE = ["", "△", "v"];
const STATUS_LABEL = { "": "（空白）", "△": "△ 進行中", v: "v 完成" };
const MODE_HINT = {
  paint: "在工作列上按住滑鼠橫向拖曳上色（顏色依分類自動決定）；右鍵點段落可編輯",
  erase: "在工作列上按住滑鼠橫向拖曳，清除該範圍的上色",
  milestone: "點格子新增 ▲ 里程碑，點既有 ▲ 可編輯",
  select: "點排程段落或 ▲ 里程碑編輯內容",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function place(node, column, row) {
  node.style.gridColumn = column;
  node.style.gridRow = row;
  return node;
}

class Gantt {
  constructor(store, root, tip, dialog) {
    this.store = store;
    this.root = root;
    this.tip = tip;
    this.dialog = dialog;
    this.mode = "paint";
    this.drag = null;
    document.documentElement.style.setProperty("--cell-w", `${CELL_W}px`);
    this.bindPointer();
    this.bindTooltip();
  }

  // ---- 時間範圍 ----
  // 從起始月份的第一個禮拜一，到最後一個月份的最後一個禮拜一那週
  get startSlot() {
    const t = this.store.data.timeline;
    return firstMondaySlot(t.startYear, t.startMonth);
  }

  get endSlot() {
    const t = this.store.data.timeline;
    const monthIndex = t.startYear * 12 + (t.startMonth - 1) + t.months;
    return firstMondaySlot(Math.floor(monthIndex / 12), (monthIndex % 12) + 1) - 1;
  }

  get todaySlot() {
    return todaySlot();
  }

  get slotCount() {
    return this.endSlot - this.startSlot + 1;
  }

  setMode(mode) {
    this.mode = mode;
    this.root.classList.remove("mode-paint", "mode-erase", "mode-milestone", "mode-select");
    this.root.classList.add(`mode-${mode}`);
    console.log("[gantt] mode", mode);
  }

  // ---- 繪製 ----
  render() {
    const data = this.store.data;
    const n = this.slotCount;
    const root = this.root;
    root.replaceChildren();
    root.style.gridTemplateColumns = `var(--cat-w) var(--task-w) var(--status-w) repeat(${n}, var(--cell-w))`;
    root.style.gridTemplateRows = `var(--head-h) var(--head-h)`;
    root.style.gridAutoRows = `minmax(var(--row-h), auto)`;

    this.renderHeader(root, n);

    let row = 3;
    data.categories.forEach((cat, ci) => {
      row = this.renderCategory(root, cat, ci, row, n);
    });
    this.renderTodayLine(root);
    console.log("[gantt] rendered", data.categories.length, "categories,", n, "slots");
  }

  // 深紅色進度線：畫在本週的左緣（上週與這週之間），貫穿所有工作列
  renderTodayLine(root) {
    const offset = this.todaySlot - this.startSlot;
    if (offset < 0 || offset >= this.slotCount) return;
    const line = el("div", "today-line");
    line.style.left = `calc(var(--cat-w) + var(--task-w) + var(--status-w) + ${offset * CELL_W}px)`;
    line.dataset.tip = `目前進度：${slotLabel(this.todaySlot)}`;
    root.append(line);
  }

  // 把進度線捲到畫面左側約三分之一處
  scrollToToday(scroller) {
    const offset = this.todaySlot - this.startSlot;
    if (offset < 0 || offset >= this.slotCount) return;
    const fixedW = this.root.querySelector(".h.corner.status").getBoundingClientRect().right - this.root.getBoundingClientRect().left;
    scroller.scrollLeft = Math.max(0, offset * CELL_W - (scroller.clientWidth - fixedW) / 3);
  }

  renderHeader(root, n) {
    [
      ["分類", "cat", 1],
      ["工作項目", "task", 2],
      ["狀態", "status", 3],
    ].forEach(([text, cls, col]) => {
      root.append(place(el("div", `h top corner ${cls}`, text), col, "1 / span 2"));
    });

    // 上層：依各週週一所在的月份分組；下層：當年第幾週
    const months = [];
    for (let i = 0; i < n; i += 1) {
      const info = slotInfo(this.startSlot + i);
      const last = months[months.length - 1];
      if (last && last.year === info.year && last.month === info.month) last.span += 1;
      else months.push({ year: info.year, month: info.month, from: i, span: 1 });
    }
    months.forEach((m, mi) => {
      const label = mi === 0 || m.month === 1 ? `${m.year}年 ${m.month}月` : `${m.month}月`;
      root.append(place(el("div", "h top month", label), `${4 + m.from} / span ${m.span}`, 1));
    });

    const monthEnds = new Set(months.map((m) => m.from + m.span - 1));
    for (let i = 0; i < n; i += 1) {
      const slot = this.startSlot + i;
      const info = slotInfo(slot);
      let cls = monthEnds.has(i) ? "h bottom month-end" : "h bottom";
      if (slot === this.todaySlot) cls += " today";
      const cell = place(el("div", cls, String(info.week)), 4 + i, 2);
      cell.dataset.tip = slot === this.todaySlot ? `目前進度\n${slotLabel(slot)}` : slotLabel(slot);
      root.append(cell);
    }

    // 時間軸的月分隔線：月份格數不固定（4 或 5 週），改用動態漸層畫在每個月的右緣
    const stops = months
      .map((m) => (m.from + m.span) * CELL_W)
      .map((x) => `transparent ${x - 1}px, var(--line-month) ${x - 1}px, var(--line-month) ${x}px, transparent ${x}px`);
    root.style.setProperty("--month-lines", `linear-gradient(to right, ${stops.join(", ")})`);
  }

  renderCategory(root, cat, ci, row, n) {
    const tasks = cat.tasks;
    const rows = cat.collapsed ? 1 : Math.max(1, tasks.length);

    // 分類欄：像 Excel 合併儲存格一樣跨整個分類
    const catCell = place(el("div", "c-cat cat-first"), 1, `${row} / span ${rows}`);
    catCell.style.borderLeft = `6px solid ${cat.color}`;
    const name = el("div", "cat-name");
    const toggle = el("button", "toggle", cat.collapsed ? "▸" : "▾");
    toggle.type = "button";
    toggle.title = cat.collapsed ? "展開" : "收合";
    toggle.onclick = () => this.toggleCategory(cat.id);
    const label = el("span", "label", cat.name || "（未命名分類）");
    label.title = "點擊編輯分類";
    label.onclick = () => this.editCategory(cat.id);
    name.append(toggle, label);
    const actions = el("div", "cat-actions");
    actions.append(
      this.iconButton("＋工作", "新增工作", () => this.addTask(cat.id)),
      this.iconButton("↑", "分類上移", () => this.moveCategory(ci, -1)),
      this.iconButton("↓", "分類下移", () => this.moveCategory(ci, 1))
    );
    catCell.append(name, actions);
    root.append(catCell);

    if (cat.collapsed) {
      const note = place(el("div", "c-task cat-first"), 2, row);
      note.append(el("span", "collapsed-note", `${tasks.length} 項已收合`));
      root.append(note, place(el("div", "c-status cat-first"), 3, row));
      const tl = place(el("div", "tl summary cat-first"), `4 / span ${n}`, row);
      tasks.forEach((t) => this.drawTaskItems(tl, t, cat));
      root.append(tl);
      return row + 1;
    }

    if (tasks.length === 0) {
      const empty = place(el("div", "c-task cat-first"), 2, row);
      empty.append(el("span", "collapsed-note", "尚無工作，滑到分類上按「＋工作」"));
      root.append(empty, place(el("div", "c-status cat-first"), 3, row));
      root.append(place(el("div", "tl summary cat-first"), `4 / span ${n}`, row));
      return row + 1;
    }

    tasks.forEach((task, ti) => {
      const first = ti === 0 ? " cat-first" : "";
      const r = row + ti;

      const taskCell = place(el("div", `c-task${first}`), 2, r);
      const taskName = el("span", "task-name", task.name || "（未命名）");
      taskName.title = task.name;
      const rowActions = el("div", "row-actions");
      rowActions.append(
        this.iconButton("✎", "編輯工作", () => this.editTask(task.id)),
        this.iconButton("↑", "上移", () => this.moveTask(task.id, -1)),
        this.iconButton("↓", "下移", () => this.moveTask(task.id, 1)),
        this.iconButton("🗑", "刪除工作", () => this.deleteTask(task.id))
      );
      taskCell.append(taskName, rowActions);

      const statusCell = place(el("div", `c-status${first}`, task.status), 3, r);
      statusCell.title = "點擊切換狀態：空白 → △ → v";
      statusCell.onclick = () => this.cycleStatus(task.id);

      const tl = place(el("div", `tl${first}`), `4 / span ${n}`, r);
      tl.dataset.taskId = task.id;
      this.drawTaskItems(tl, task, cat);

      root.append(taskCell, statusCell, tl);
    });
    return row + tasks.length;
  }

  iconButton(text, title, onClick) {
    const b = el("button", "", text);
    b.type = "button";
    b.title = title;
    b.onclick = (e) => {
      e.stopPropagation();
      onClick();
    };
    return b;
  }

  // 把 slot 轉成這一列上的 px 位置；完全落在畫面範圍外的回傳 null
  span(start, end) {
    const lo = Math.max(start, this.startSlot);
    const hi = Math.min(end, this.startSlot + this.slotCount - 1);
    if (lo > hi) return null;
    return { left: (lo - this.startSlot) * CELL_W, width: (hi - lo + 1) * CELL_W };
  }

  drawTaskItems(tl, task, cat) {
    task.segments.forEach((s) => {
      const pos = this.span(s.start, s.end);
      if (!pos) return;
      const bar = el("div", "bar", s.text);
      bar.style.left = `${pos.left}px`;
      bar.style.width = `${pos.width}px`;
      bar.style.background = cat.color;
      bar.dataset.segId = s.id;
      bar.dataset.taskId = task.id;
      const range = s.start === s.end ? slotLabel(s.start) : `${slotLabel(s.start)} ~ ${slotLabel(s.end)}`;
      bar.dataset.tip = [`${cat.name}｜${task.name}`, s.text, range].filter(Boolean).join("\n");
      tl.append(bar);
    });
    task.milestones.forEach((m) => {
      const pos = this.span(m.slot, m.slot);
      if (!pos) return;
      const node = el("div", "ms", "▲");
      node.style.left = `${pos.left}px`;
      node.dataset.msId = m.id;
      node.dataset.taskId = task.id;
      node.dataset.tip = [`▲ ${m.name || "（未命名里程碑）"}`, slotLabel(m.slot), m.note].filter(Boolean).join("\n");
      tl.append(node);
    });
  }

  // ---- 滑鼠操作 ----
  slotAt(tl, clientX) {
    const x = clientX - tl.getBoundingClientRect().left;
    const i = Math.min(this.slotCount - 1, Math.max(0, Math.floor(x / CELL_W)));
    return this.startSlot + i;
  }

  bindPointer() {
    this.root.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const tl = e.target.closest(".tl");
      if (!tl || tl.classList.contains("summary")) return;
      const taskId = tl.dataset.taskId;
      const slot = this.slotAt(tl, e.clientX);
      e.preventDefault();

      if (this.mode === "select") {
        const bar = e.target.closest(".bar");
        const ms = e.target.closest(".ms");
        if (ms) this.editMilestone(taskId, ms.dataset.msId);
        else if (bar) this.editSegment(taskId, bar.dataset.segId);
        return;
      }
      if (this.mode === "milestone") {
        const ms = e.target.closest(".ms");
        const { task } = this.store.findTask(taskId);
        const existing = ms ? task.milestones.find((m) => m.id === ms.dataset.msId) : task.milestones.find((m) => m.slot === slot);
        if (existing) this.editMilestone(taskId, existing.id);
        else this.addMilestone(taskId, slot);
        return;
      }
      this.hideTip();
      this.drag = { tl, taskId, a: slot, b: slot, color: this.store.findTask(taskId).category.color, preview: el("div", `bar preview${this.mode === "erase" ? " erase" : ""}`) };
      tl.append(this.drag.preview);
      this.updatePreview();
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.drag) return;
      const b = this.slotAt(this.drag.tl, e.clientX);
      if (b !== this.drag.b) {
        this.drag.b = b;
        this.updatePreview();
      }
    });

    document.addEventListener("mouseup", () => {
      if (!this.drag) return;
      const { taskId, a, b } = this.drag;
      this.drag = null;
      if (this.mode === "paint") {
        console.log("[gantt] paint", taskId, slotLabel(Math.min(a, b)), "~", slotLabel(Math.max(a, b)));
        this.store.paint(taskId, a, b);
      } else {
        console.log("[gantt] erase", taskId, slotLabel(Math.min(a, b)), "~", slotLabel(Math.max(a, b)));
        this.store.erase(taskId, a, b);
      }
    });

    // 任何模式下右鍵點段落或里程碑都可以直接編輯
    this.root.addEventListener("contextmenu", (e) => {
      const bar = e.target.closest(".tl:not(.summary) .bar");
      const ms = e.target.closest(".tl:not(.summary) .ms");
      if (!bar && !ms) return;
      e.preventDefault();
      if (ms) this.editMilestone(ms.dataset.taskId, ms.dataset.msId);
      else this.editSegment(bar.dataset.taskId, bar.dataset.segId);
    });
  }

  updatePreview() {
    const { a, b, color, preview } = this.drag;
    const pos = this.span(Math.min(a, b), Math.max(a, b));
    preview.style.left = `${pos.left}px`;
    preview.style.width = `${pos.width}px`;
    if (this.mode === "paint") preview.style.background = color;
  }

  // ---- tooltip ----
  bindTooltip() {
    this.root.addEventListener("mouseover", (e) => {
      const target = e.target.closest("[data-tip]");
      if (!target || this.drag) return this.hideTip();
      this.tip.textContent = target.dataset.tip;
      this.tip.hidden = false;
    });
    this.root.addEventListener("mousemove", (e) => {
      if (this.tip.hidden) return;
      const x = Math.min(e.clientX + 14, window.innerWidth - this.tip.offsetWidth - 8);
      const y = Math.min(e.clientY + 16, window.innerHeight - this.tip.offsetHeight - 8);
      this.tip.style.left = `${x}px`;
      this.tip.style.top = `${y}px`;
    });
    this.root.addEventListener("mouseleave", () => this.hideTip());
  }

  hideTip() {
    this.tip.hidden = true;
  }

  // ---- 對話框 ----
  // actions: [{ label, value, cls }]；回傳按下的 value，按 Esc 關閉時為 ""
  ask(title, bodyNodes, actions) {
    const dlg = this.dialog;
    dlg.querySelector("#dlg-title").textContent = title;
    dlg.querySelector("#dlg-body").replaceChildren(...bodyNodes);
    const menu = dlg.querySelector("#dlg-actions");
    menu.replaceChildren(
      ...actions.map((a) => {
        const b = el("button", a.cls || "", a.label);
        b.value = a.value;
        return b;
      })
    );
    // 在輸入框按 Enter 時瀏覽器會按下第一顆按鈕（通常是「刪除」），改成按主要按鈕
    dlg.onkeydown = (e) => {
      if (e.key !== "Enter" || e.target.tagName === "TEXTAREA" || e.target.tagName === "BUTTON") return;
      e.preventDefault();
      menu.querySelector(".primary")?.click();
    };
    dlg.returnValue = "";
    this.hideTip();
    dlg.showModal();
    const firstInput = dlg.querySelector("#dlg-body input[type=text], #dlg-body textarea");
    if (firstInput) firstInput.focus();
    return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true }));
  }

  field(label, input) {
    const wrap = el("label", "field");
    wrap.append(el("span", "", label), input);
    return wrap;
  }

  textInput(value, placeholder = "") {
    const input = el("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    return input;
  }

  select(options, value) {
    const s = el("select");
    options.forEach(([v, text]) => {
      const o = el("option", "", text);
      o.value = v;
      s.append(o);
    });
    s.value = value;
    return s;
  }

  // ---- 工作 ----
  async addTask(catId) {
    const name = this.textInput("", "例如：物料登入");
    const status = this.select(STATUS_CYCLE.map((s) => [s, STATUS_LABEL[s]]), "");
    const res = await this.ask("新增工作", [this.field("工作項目", name), this.field("狀態", status)], [
      { label: "取消", value: "cancel" },
      { label: "新增", value: "ok", cls: "primary" },
    ]);
    if (res !== "ok" || !name.value.trim()) return;
    this.store.update((d) => {
      const cat = d.categories.find((c) => c.id === catId);
      cat.collapsed = false;
      cat.tasks.push({ id: newId("t"), name: name.value.trim(), status: status.value, segments: [], milestones: [] });
    });
  }

  async editTask(taskId) {
    const { category, task } = this.store.findTask(taskId);
    const name = this.textInput(task.name);
    const status = this.select(STATUS_CYCLE.map((s) => [s, STATUS_LABEL[s]]), task.status);
    const cat = this.select(this.store.data.categories.map((c) => [c.id, c.name]), category.id);
    const res = await this.ask("編輯工作", [this.field("工作項目", name), this.field("狀態", status), this.field("所屬分類", cat)], [
      { label: "刪除", value: "delete", cls: "danger" },
      { label: "取消", value: "cancel" },
      { label: "儲存", value: "ok", cls: "primary" },
    ]);
    if (res === "delete") return this.deleteTask(taskId);
    if (res !== "ok") return;
    this.store.update((d) => {
      const found = this.store.findTask(taskId);
      found.task.name = name.value.trim() || found.task.name;
      found.task.status = status.value;
      if (cat.value !== found.category.id) {
        found.category.tasks.splice(found.index, 1);
        d.categories.find((c) => c.id === cat.value).tasks.push(found.task);
      }
    });
  }

  deleteTask(taskId) {
    const { task } = this.store.findTask(taskId);
    if (!confirm(`刪除工作「${task.name}」？（可用復原找回）`)) return;
    this.store.update(() => {
      const found = this.store.findTask(taskId);
      found.category.tasks.splice(found.index, 1);
    });
  }

  moveTask(taskId, delta) {
    const { category, index } = this.store.findTask(taskId);
    const to = index + delta;
    if (to < 0 || to >= category.tasks.length) return;
    this.store.update(() => {
      const { category: c, index: i } = this.store.findTask(taskId);
      const [t] = c.tasks.splice(i, 1);
      c.tasks.splice(i + delta, 0, t);
    });
  }

  cycleStatus(taskId) {
    this.store.update(() => {
      const { task } = this.store.findTask(taskId);
      const i = STATUS_CYCLE.indexOf(task.status);
      task.status = STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length];
    });
  }

  // ---- 分類 ----
  toggleCategory(catId) {
    // 收合是閱讀狀態，不進復原堆疊
    this.store.update(
      (d) => {
        const cat = d.categories.find((c) => c.id === catId);
        cat.collapsed = !cat.collapsed;
      },
      { undoable: false }
    );
  }

  async addCategory() {
    const name = this.textInput("", "例如：物料系統");
    const res = await this.ask("新增分類", [this.field("分類名稱", name)], [
      { label: "取消", value: "cancel" },
      { label: "新增", value: "ok", cls: "primary" },
    ]);
    if (res !== "ok" || !name.value.trim()) return;
    this.store.update((d) => {
      d.categories.push({ id: newId("c"), name: name.value.trim(), color: this.store.nextCategoryColor(), collapsed: false, tasks: [] });
    });
  }

  async editCategory(catId) {
    const cat = this.store.data.categories.find((c) => c.id === catId);
    const name = this.textInput(cat.name);
    const color = el("input");
    color.type = "color";
    color.value = cat.color;
    const res = await this.ask("編輯分類", [this.field("分類名稱", name), this.field("顏色（自動配色，可手動改）", color)], [
      { label: "刪除分類", value: "delete", cls: "danger" },
      { label: "取消", value: "cancel" },
      { label: "儲存", value: "ok", cls: "primary" },
    ]);
    if (res === "delete") {
      if (!confirm(`刪除分類「${cat.name}」與底下 ${cat.tasks.length} 項工作？（可用復原找回）`)) return;
      this.store.update((d) => {
        d.categories = d.categories.filter((c) => c.id !== catId);
      });
      return;
    }
    if (res !== "ok" || !name.value.trim()) return;
    this.store.update((d) => {
      const c = d.categories.find((x) => x.id === catId);
      c.name = name.value.trim();
      c.color = color.value;
    });
  }

  moveCategory(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= this.store.data.categories.length) return;
    this.store.update((d) => {
      const [c] = d.categories.splice(index, 1);
      d.categories.splice(to, 0, c);
    });
  }

  // ---- 排程段 ----
  async editSegment(taskId, segId) {
    const { task } = this.store.findTask(taskId);
    const seg = task.segments.find((s) => s.id === segId);
    const text = this.textInput(seg.text, "例如：開發、微調、測試");
    const range = el("div", "", `${task.name}｜${slotLabel(seg.start)} ~ ${slotLabel(seg.end)}`);
    const res = await this.ask("編輯排程段", [range, el("br"), this.field("段落文字", text)], [
      { label: "刪除此段", value: "delete", cls: "danger" },
      { label: "取消", value: "cancel" },
      { label: "儲存", value: "ok", cls: "primary" },
    ]);
    if (res === "delete") {
      this.store.update(() => {
        const t = this.store.findTask(taskId).task;
        t.segments = t.segments.filter((s) => s.id !== segId);
      });
      return;
    }
    if (res !== "ok") return;
    this.store.update(() => {
      const s = this.store.findTask(taskId).task.segments.find((x) => x.id === segId);
      s.text = text.value.trim();
    });
  }

  // ---- 里程碑 ----
  async addMilestone(taskId, slot) {
    const { task } = this.store.findTask(taskId);
    const name = this.textInput("", "例如：上線、驗收");
    const note = el("textarea");
    const res = await this.ask(`新增里程碑｜${task.name}`, [el("div", "", slotLabel(slot)), el("br"), this.field("名稱", name), this.field("備註", note)], [
      { label: "取消", value: "cancel" },
      { label: "新增", value: "ok", cls: "primary" },
    ]);
    if (res !== "ok") return;
    this.store.update(() => {
      this.store.findTask(taskId).task.milestones.push({ id: newId("m"), slot, name: name.value.trim(), note: note.value.trim() });
    });
  }

  async editMilestone(taskId, msId) {
    const { task } = this.store.findTask(taskId);
    const ms = task.milestones.find((m) => m.id === msId);
    const name = this.textInput(ms.name);
    const note = el("textarea");
    note.value = ms.note;
    const res = await this.ask(`編輯里程碑｜${task.name}`, [el("div", "", slotLabel(ms.slot)), el("br"), this.field("名稱", name), this.field("備註", note)], [
      { label: "刪除", value: "delete", cls: "danger" },
      { label: "取消", value: "cancel" },
      { label: "儲存", value: "ok", cls: "primary" },
    ]);
    if (res === "delete") {
      this.store.update(() => {
        const t = this.store.findTask(taskId).task;
        t.milestones = t.milestones.filter((m) => m.id !== msId);
      });
      return;
    }
    if (res !== "ok") return;
    this.store.update(() => {
      const m = this.store.findTask(taskId).task.milestones.find((x) => x.id === msId);
      m.name = name.value.trim();
      m.note = note.value.trim();
    });
  }
}
