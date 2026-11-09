// 甘特圖繪製與操作：左側工作表格 + 右側時間格線
//
// 版面是一個 CSS grid：前三欄（分類／工作項目／狀態）sticky 固定在左，
// 兩層表頭 sticky 固定在上；每個工作列的時間軸是一個跨 N 格的元素，
// 格線用背景畫，排程段與里程碑以絕對定位疊在上面。

const STATUS_CYCLE = ["", "△", "v"];
const STATUS_LABEL = { "": "（空白）", "△": "△ 進行中", v: "v 完成" };
const MODE_HINT = {
  paint: "在工作列上按住滑鼠橫向拖曳建立排程塊；再按一次按鈕可重新選預計／實際，右鍵點排程塊可編輯",
  erase: "在工作列上按住滑鼠橫向拖曳，清除該範圍內目前所選種類（預計／實際）的排程塊",
  move: "按住排程塊左右拖曳移動，起點會貼齊目前尺度的格子（週＝週一、月＝1 號、日＝當天），遇反灰自動往後遞補",
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
    this.segKind = "plan"; // 建立／清除時作用的種類：plan＝預計排程、actual＝實際執行
    this.drag = null;
    this.ts = null;
    this.bindPointer();
    this.bindTooltip();
    this.bindHeaderClick();
    this.bindColumnResize();
  }

  // ---- 時間尺度 ----
  setScale(scale) {
    // 檢視尺度是閱讀偏好，不進復原堆疊
    this.store.update((d) => {
      d.timeline.scale = scale;
    }, { undoable: false });
    console.log("[gantt] scale", scale);
  }

  setMode(mode) {
    this.mode = mode;
    this.root.classList.remove("mode-paint", "mode-erase", "mode-move", "mode-milestone", "mode-select");
    this.root.classList.add(`mode-${mode}`);
    console.log("[gantt] mode", mode);
  }

  // ---- 繪製 ----
  render() {
    const data = this.store.data;
    document.documentElement.style.setProperty("--cat-w", `${data.layout.catWidth}px`);
    this.ts = new TimeScale(data.timeline.scale, data.timeline);
    const n = this.ts.units.length;
    const root = this.root;
    root.replaceChildren();
    root.style.setProperty("--cell-w", `${this.ts.cellW}px`);
    root.style.gridTemplateColumns = `var(--cat-w) var(--task-w) var(--status-w) repeat(${n}, var(--cell-w))`;
    root.style.gridTemplateRows = `var(--head-h) var(--head-h)`;
    root.style.gridAutoRows = `minmax(var(--row-h), auto)`;

    this.renderHeader(root, n);
    this.renderBlockedColumns(root);

    let row = 3;
    data.categories.forEach((cat, ci) => {
      row = this.renderCategory(root, cat, ci, row, n);
    });
    this.renderTodayLine(root);
    console.log("[gantt] rendered", data.categories.length, "categories,", n, `${data.timeline.scale} units`);
  }

  // 深紅色進度線：畫在今天所在格子的左緣（日＝今天、週＝上週與這週之間、月＝本月），貫穿所有工作列
  renderTodayLine(root) {
    const i = this.ts.indexOfDay(todayDay());
    if (i < 0) return;
    const line = el("div", "today-line");
    line.style.left = `calc(var(--cat-w) + var(--task-w) + var(--status-w) + ${i * this.ts.cellW}px)`;
    root.append(line);
  }

  // 把進度線捲到畫面左側約三分之一處
  scrollToToday(scroller) {
    const i = this.ts.indexOfDay(todayDay());
    if (i < 0) return;
    const fixedW = this.root.querySelector(".h.corner.status").getBoundingClientRect().right - this.root.getBoundingClientRect().left;
    scroller.scrollLeft = Math.max(0, i * this.ts.cellW - (scroller.clientWidth - fixedW) / 3);
  }

  renderHeader(root, n) {
    [
      ["分類", "cat", 1],
      ["工作項目", "task", 2],
      ["狀態", "status", 3],
    ].forEach(([text, cls, col]) => {
      const cell = place(el("div", `h top corner ${cls}`, text), col, "1 / span 2");
      if (cls === "cat") {
        // 分類欄右緣的拖曳把手，左右拉可調整欄寬
        const grip = el("div", "col-resizer");
        grip.title = "左右拖曳調整分類欄寬度";
        cell.append(grip);
      }
      root.append(cell);
    });

    // 上層：分組（日／週檢視為月份，月檢視為年份）；下層：各格標籤
    const { units, groups, cellW } = this.ts;
    groups.forEach((g) => {
      root.append(place(el("div", "h top month", g.label), `${4 + g.from} / span ${g.span}`, 1));
    });

    const groupEnds = new Set(groups.map((g) => g.from + g.span - 1));
    const today = this.ts.indexOfDay(todayDay());
    units.forEach((u, i) => {
      let cls = groupEnds.has(i) ? "h bottom month-end" : "h bottom";
      const blocked = this.unitBlocked(u);
      if (blocked) cls += " blocked";
      if (this.ts.scale !== "month") cls += " clickable";
      if (i === today) cls += " today";
      const cell = place(el("div", cls, u.label), 4 + i, 2);
      cell.dataset.index = i;
      const lines = [i === today ? "目前進度" : "", u.tip];
      if (blocked) lines.push(`不排工作${blocked.reason ? `：${blocked.reason}` : "（週末）"}`);
      cell.dataset.tip = lines.filter(Boolean).join("\n");
      root.append(cell);
    });

    // 時間軸的分組分隔線：每組格數不固定，用動態漸層畫在每組的右緣
    const stops = groups
      .map((g) => (g.from + g.span) * cellW)
      .map((x) => `transparent ${x - 1}px, var(--line-month) ${x - 1}px, var(--line-month) ${x}px, transparent ${x}px`);
    root.style.setProperty("--month-lines", `linear-gradient(to right, ${stops.join(", ")})`);
  }

  // 格子是否反灰：日檢視看那一天；週檢視只有 7 天全反灰才算；月檢視不顯示
  // 回傳 { reason } 或 null；週的原因取那週第一個有填的原因
  unitBlocked(u) {
    if (this.ts.scale === "month") return null;
    let reason = "";
    for (let d = u.start; d <= u.end; d += 1) {
      if (!this.store.isBlocked(d)) return null;
      reason = reason || this.store.blockReason(d);
    }
    return { reason };
  }

  // 連續、原因相同的反灰格合併成一塊灰欄，原因以直式文字顯示
  renderBlockedColumns(root) {
    const { units, cellW } = this.ts;
    const runs = [];
    units.forEach((u, i) => {
      const blocked = this.unitBlocked(u);
      if (!blocked) return;
      const last = runs[runs.length - 1];
      if (last && last.to === i - 1 && last.reason === blocked.reason) last.to = i;
      else runs.push({ from: i, to: i, reason: blocked.reason });
    });
    runs.forEach((r) => {
      const col = el("div", "blocked-col");
      col.style.left = `calc(var(--cat-w) + var(--task-w) + var(--status-w) + ${r.from * cellW}px)`;
      col.style.width = `${(r.to - r.from + 1) * cellW}px`;
      if (r.reason) col.append(el("span", "reason", r.reason));
      root.append(col);
    });
  }

  // 拖曳分類欄右緣調整寬度：拖曳中即時更新 CSS 變數，放開才存檔（不進復原堆疊）
  bindColumnResize() {
    let drag = null;
    this.root.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !e.target.closest(".col-resizer")) return;
      e.preventDefault();
      e.stopPropagation();
      drag = { x: e.clientX, width: this.store.data.layout.catWidth };
      document.body.classList.add("resizing");
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      drag.now = Math.min(CAT_WIDTH.max, Math.max(CAT_WIDTH.min, Math.round(drag.width + e.clientX - drag.x)));
      document.documentElement.style.setProperty("--cat-w", `${drag.now}px`);
    });
    document.addEventListener("mouseup", () => {
      if (!drag) return;
      const width = drag.now;
      drag = null;
      document.body.classList.remove("resizing");
      if (!width) return;
      console.log("[gantt] category width", width);
      this.store.update((d) => {
        d.layout.catWidth = width;
      }, { undoable: false });
    });
  }

  async renameSheet() {
    const name = this.textInput(this.store.data.title, DEFAULT_TITLE);
    const res = await this.ask("排程表名稱", [this.field("名稱", name)], [
      { label: "取消", value: "cancel" },
      { label: "儲存", value: "ok", cls: "primary" },
    ]);
    if (res !== "ok" || !name.value.trim()) return;
    this.store.update((d) => {
      d.title = name.value.trim();
    });
  }

  bindHeaderClick() {
    this.root.addEventListener("click", (e) => {
      const cell = e.target.closest(".h.bottom.clickable");
      if (cell) this.editBlocked(Number(cell.dataset.index));
    });
  }

  // 點表頭日期（日檢視）或週數（週檢視）設定不排工作
  async editBlocked(index) {
    const u = this.ts.units[index];
    const isWeek = this.ts.scale === "week";
    const current = this.unitBlocked(u);
    const check = el("input");
    check.type = "checkbox";
    check.checked = Boolean(current);
    const checkLabel = el("label", "check-row");
    checkLabel.append(check, document.createTextNode(isWeek ? " 整週不排工作（反灰）" : " 這天不排工作（反灰）"));
    const reason = this.textInput(current?.reason || "", "例如：春節、國定假日、教育訓練");
    // 開始輸入原因就自動勾選反灰
    reason.oninput = () => {
      if (reason.value.trim()) check.checked = true;
    };
    const note = el("div", "dialog-note", "反灰的日子不會排入工作，跨到的排程會自動往後遞補。" + (isWeek ? "" : "週六日預設反灰，取消勾選即可排工作。"));
    const res = await this.ask(`不排工作設定｜${u.tip}`, [checkLabel, this.field("原因（直式顯示在欄上）", reason), note], [
      { label: "取消", value: "cancel" },
      { label: "儲存", value: "ok", cls: "primary" },
    ]);
    if (res !== "ok") return;
    const text = reason.value.trim();
    const blocked = check.checked;
    console.log("[gantt] blocked", u.tip, blocked, text);
    if (isWeek) this.store.setWeekBlocked(u.start, blocked, text);
    else this.store.setDayBlocked(u.start, blocked, text);
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
    // 名稱放不下時以「…」截斷，滑鼠移上去看全名
    const label = el("span", "label", cat.name || "（未命名分類）");
    label.title = `${cat.name}\n（點擊編輯分類）`;
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

  // 排程塊的底色：預計＝分類淡色；實際＝同色相高彩度的粗斜線
  paintBar(bar, cat, kind) {
    if (kind === "actual") {
      const c = strongColor(cat.color);
      bar.classList.add("actual");
      bar.style.background = `repeating-linear-gradient(45deg, ${c.solid} 0 6px, ${c.stripe} 6px 12px)`;
    } else {
      bar.style.background = cat.color;
    }
  }

  drawTaskItems(tl, task, cat) {
    // 先畫預計、再畫實際，實際執行的圖層在上面
    [["plan", task.segments], ["actual", task.actuals]].forEach(([kind, list]) => {
      list.forEach((s) => {
        const [start, end] = this.store.segRange(s);
        const pos = this.ts.span(start, end);
        if (!pos) return;
        const bar = el("div", "bar", s.text);
        bar.style.left = `${pos.left}px`;
        bar.style.width = `${pos.width}px`;
        this.paintBar(bar, cat, kind);
        bar.dataset.segId = s.id;
        bar.dataset.taskId = task.id;
        bar.dataset.tip = [
          `${kind === "actual" ? "實際執行" : "預計排程"}｜${cat.name}｜${task.name}`,
          s.text,
          `${rangeLabel(start, end)}｜工作 ${s.work} 天`,
        ].filter(Boolean).join("\n");
        tl.append(bar);
      });
    });
    task.milestones.forEach((m) => {
      const pos = this.ts.span(m.day, m.day);
      if (!pos) return;
      // ▲ 對準那一天的中心（週／月檢視一天很窄，▲ 會落在格內對應的位置）
      const node = el("div", "ms", "▲");
      node.style.left = `${pos.left + pos.width / 2 - this.ts.cellW / 2}px`;
      node.dataset.msId = m.id;
      node.dataset.taskId = task.id;
      node.dataset.tip = [`▲ ${m.name || "（未命名里程碑）"}`, fmtDay(m.day), m.note].filter(Boolean).join("\n");
      tl.append(node);
    });
  }

  // ---- 滑鼠操作 ----
  // 拖曳以「格」為單位：日檢視一格一天、週檢視一格一週、月檢視一格一個月
  unitAt(tl, clientX) {
    return this.ts.indexAtX(clientX - tl.getBoundingClientRect().left);
  }

  // 拖曳範圍（格索引）換成日序範圍
  dragDays(a, b) {
    const { units } = this.ts;
    return [units[Math.min(a, b)].start, units[Math.max(a, b)].end];
  }

  // 移動時排程塊的新起點：從原起點所在格往左右移 (b − a) 格，起點貼齊該格的第一天
  // （週檢視＝週一、月檢視＝1 號、日檢視＝那一天）；沒有移動時維持原位不貼齊
  moveStart(drag) {
    const delta = drag.b - drag.a;
    if (delta === 0) return drag.from;
    const { units } = this.ts;
    const i = Math.min(units.length - 1, Math.max(0, drag.startIndex + delta));
    return units[i].start;
  }

  startMove(e, tl, taskId, index) {
    const bar = e.target.closest(".bar");
    if (!bar) return;
    const { seg, kind } = this.store.findSegment(taskId, bar.dataset.segId);
    const [from] = this.store.segRange(seg);
    let startIndex = this.ts.indexOfDay(from);
    if (startIndex < 0) startIndex = from < this.ts.first ? 0 : this.ts.units.length - 1;
    bar.classList.add("moving");
    this.drag = {
      kind: "move",
      tl,
      taskId,
      seg,
      segKind: kind,
      from,
      bar,
      startIndex,
      a: index,
      b: index,
      color: this.store.findTask(taskId).category.color,
      preview: el("div", "bar preview"),
    };
    tl.append(this.drag.preview);
    this.updatePreview();
  }

  bindPointer() {
    this.root.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || this.store.readOnly) return;
      const tl = e.target.closest(".tl");
      if (!tl || tl.classList.contains("summary")) return;
      const taskId = tl.dataset.taskId;
      const index = this.unitAt(tl, e.clientX);
      const unit = this.ts.units[index];
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
        const existing = ms ? task.milestones.find((m) => m.id === ms.dataset.msId) : task.milestones.find((m) => m.day >= unit.start && m.day <= unit.end);
        if (existing) this.editMilestone(taskId, existing.id);
        else this.addMilestone(taskId, unit.start);
        return;
      }
      this.hideTip();
      if (this.mode === "move") {
        this.startMove(e, tl, taskId, index);
        return;
      }
      this.drag = {
        kind: this.mode,
        segKind: this.segKind,
        tl,
        taskId,
        a: index,
        b: index,
        color: this.store.findTask(taskId).category.color,
        preview: el("div", `bar preview${this.mode === "erase" ? " erase" : ""}`),
      };
      tl.append(this.drag.preview);
      this.updatePreview();
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.drag) return;
      const b = this.unitAt(this.drag.tl, e.clientX);
      if (b !== this.drag.b) {
        this.drag.b = b;
        this.updatePreview();
      }
    });

    document.addEventListener("mouseup", () => {
      if (!this.drag) return;
      const drag = this.drag;
      const { taskId, a, b } = drag;
      this.drag = null;
      if (drag.kind === "move") {
        const newStart = this.moveStart(drag);
        drag.preview.remove();
        drag.bar.classList.remove("moving");
        if (this.store.nextWorkday(newStart) === drag.from) return;
        console.log("[gantt] move", taskId, fmtDay(drag.from), "->", fmtDay(newStart));
        this.store.moveSegment(taskId, drag.seg.id, newStart);
        return;
      }
      const [start, end] = this.dragDays(a, b);
      console.log(`[gantt] ${this.mode}`, taskId, rangeLabel(start, end));
      if (this.mode === "paint") this.store.paint(taskId, start, end, drag.segKind);
      else this.store.erase(taskId, start, end, drag.segKind);
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
    if (this.drag.kind === "move") {
      const { seg } = this.drag;
      // 預覽直接套用遞補規則：起點貼到工作日，結束日跳過反灰往後算
      const start = this.store.nextWorkday(this.moveStart(this.drag));
      const pos = this.ts.span(start, this.store.segEnd(start, seg.work)) || { left: 0, width: 0 };
      preview.style.left = `${pos.left}px`;
      preview.style.width = `${pos.width}px`;
      this.paintBar(preview, { color }, this.drag.segKind);
      preview.textContent = seg.text;
      return;
    }
    preview.style.left = `${Math.min(a, b) * this.ts.cellW}px`;
    preview.style.width = `${(Math.abs(a - b) + 1) * this.ts.cellW}px`;
    if (this.mode === "paint") this.paintBar(preview, { color }, this.drag.segKind);
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
    // 唯讀時所有對話框都是編輯用途，直接當作取消
    if (this.store.readOnly) return Promise.resolve("");
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
      cat.tasks.push({ id: newId("t"), name: name.value.trim(), status: status.value, segments: [], actuals: [], milestones: [] });
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
    // 顏色只用一條紅→紫的色相拉條選，彩度與亮度固定為淡色
    let picked = cat.color;
    const hue = el("input", "hue-slider");
    hue.type = "range";
    hue.min = "0";
    hue.max = String(HUE_MAX);
    hue.value = String(hueOf(cat.color));
    const stops = [];
    for (let h = 0; h <= HUE_MAX; h += 29) stops.push(hueColor(h));
    hue.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
    const swatch = el("span", "swatch hue-swatch");
    swatch.style.background = picked;
    hue.oninput = () => {
      picked = hueColor(Number(hue.value));
      swatch.style.background = picked;
    };
    const hueRow = el("div", "hue-row");
    hueRow.append(hue, swatch);
    const note = el("div", "dialog-note", "左右拉選色相（紅橙黃綠藍靛紫），顏色固定為淡色；鮮豔色保留給之後的實際完成排程。");
    const res = await this.ask("編輯分類", [this.field("分類名稱", name), this.field("顏色", hueRow), note], [
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
      c.color = softenColor(picked);
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
    const { task, seg, kind } = this.store.findSegment(taskId, segId);
    const text = this.textInput(seg.text, "例如：開發、微調、測試");
    const work = el("input");
    work.type = "number";
    work.min = "1";
    work.value = seg.work;
    const [start, end] = this.store.segRange(seg);
    const range = el("div", "", `${task.name}｜${rangeLabel(start, end)}`);
    const res = await this.ask(kind === "actual" ? "編輯排程塊（實際執行）" : "編輯排程塊（預計排程）", [range, el("br"), this.field("段落文字", text), this.field("工作天數（跳過反灰日往後算）", work)], [
      { label: "刪除此段", value: "delete", cls: "danger" },
      { label: "取消", value: "cancel" },
      { label: "儲存", value: "ok", cls: "primary" },
    ]);
    if (res === "delete") {
      this.store.deleteSegment(taskId, segId);
      return;
    }
    if (res !== "ok") return;
    this.store.updateSegment(taskId, segId, { text: text.value.trim(), work: Number(work.value) });
  }

  // ---- 里程碑 ----
  async addMilestone(taskId, day) {
    const { task } = this.store.findTask(taskId);
    const name = this.textInput("", "例如：上線、驗收");
    const note = el("textarea");
    const res = await this.ask(`新增里程碑｜${task.name}`, [el("div", "", fmtDay(day)), el("br"), this.field("名稱", name), this.field("備註", note)], [
      { label: "取消", value: "cancel" },
      { label: "新增", value: "ok", cls: "primary" },
    ]);
    if (res !== "ok") return;
    this.store.update(() => {
      this.store.findTask(taskId).task.milestones.push({ id: newId("m"), day, name: name.value.trim(), note: note.value.trim() });
    });
  }

  async editMilestone(taskId, msId) {
    const { task } = this.store.findTask(taskId);
    const ms = task.milestones.find((m) => m.id === msId);
    const name = this.textInput(ms.name);
    const note = el("textarea");
    note.value = ms.note;
    const res = await this.ask(`編輯里程碑｜${task.name}`, [el("div", "", fmtDay(ms.day)), el("br"), this.field("名稱", name), this.field("備註", note)], [
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
