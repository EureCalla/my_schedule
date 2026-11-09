// your_schedule 前端進入點：初始化資料與甘特圖，綁定工具列

(function main() {
  const store = new Store();
  const gantt = new Gantt(store, document.getElementById("gantt"), document.getElementById("tip"), document.getElementById("dlg"));

  const legendBox = document.getElementById("legend");
  const hint = document.getElementById("hint");
  const undoBtn = document.getElementById("btn-undo");
  const startInput = document.getElementById("tl-start");
  const monthsInput = document.getElementById("tl-months");
  const fileInput = document.getElementById("file-import");
  const sheetTitle = document.getElementById("sheet-title");

  function renderLegend() {
    // 顏色依分類自動配置，這裡只做對照；點一下可改分類名稱或顏色
    legendBox.replaceChildren(
      ...store.data.categories.map((c) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "legend-item";
        item.title = "點擊編輯分類名稱或顏色";
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = c.color;
        item.append(sw, document.createTextNode(c.name || "（未命名分類）"));
        item.onclick = () => gantt.editCategory(c.id);
        return item;
      })
    );
  }

  function renderToolbar() {
    const t = store.data.timeline;
    sheetTitle.textContent = store.data.title;
    document.title = `${store.data.title}｜甘特圖`;
    startInput.value = `${t.startYear}-${String(t.startMonth).padStart(2, "0")}`;
    monthsInput.value = t.months;
    document.querySelectorAll("#scales button").forEach((b) => b.classList.toggle("active", b.dataset.scale === t.scale));
    undoBtn.disabled = !store.canUndo();
  }

  function renderAll() {
    gantt.render();
    renderLegend();
    renderKindLegend();
    renderToolbar();
  }

  const kindMenu = document.getElementById("kind-menu");
  const KIND_LABEL = { plan: "預計", actual: "實際" };
  const MODE_LABEL = { paint: "🖌 建立排程塊", erase: "🧽 清除" };

  function setMode(mode) {
    gantt.setMode(mode);
    document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    hint.textContent = MODE_HINT[mode];
  }

  // 建立排程塊／清除按鈕上標出目前作用的種類，例如「🖌 建立排程塊（預計）」
  function setKind(kind) {
    gantt.segKind = kind;
    Object.entries(MODE_LABEL).forEach(([mode, label]) => {
      document.querySelector(`#modes button[data-mode="${mode}"]`).textContent = `${label}（${KIND_LABEL[kind]}）`;
    });
    kindMenu.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
    console.log("[app] segment kind", kind);
  }

  function showKindMenu(button) {
    const rect = button.getBoundingClientRect();
    kindMenu.style.left = `${rect.left}px`;
    kindMenu.style.top = `${rect.bottom + 4}px`;
    kindMenu.hidden = false;
  }

  function hideKindMenu() {
    kindMenu.hidden = true;
  }

  // 圖例右側的樣式說明：預計＝淡色、實際＝粗斜線（以第一個分類的顏色示意）
  function renderKindLegend() {
    const box = document.getElementById("kind-legend");
    const color = store.data.categories[0]?.color || PALETTE[0];
    box.replaceChildren(
      ...[["plan", "預計排程"], ["actual", "實際執行"]].map(([kind, label]) => {
        const item = document.createElement("span");
        item.className = "legend-item";
        const sw = document.createElement("span");
        sw.className = "swatch";
        gantt.paintBar(sw, { color }, kind);
        item.append(sw, document.createTextNode(label));
        return item;
      })
    );
  }

  store.onChange(renderAll);

  document.querySelectorAll("#modes button").forEach((b) => {
    b.onclick = (e) => {
      setMode(b.dataset.mode);
      // 建立排程塊與清除要先選預計或實際
      if (MODE_LABEL[b.dataset.mode]) {
        e.stopPropagation();
        showKindMenu(b);
      } else {
        hideKindMenu();
      }
    };
  });

  kindMenu.querySelectorAll("button").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      setKind(b.dataset.kind);
      hideKindMenu();
    };
  });

  // 點選單以外的地方就收起，沿用原本選的種類
  document.addEventListener("click", (e) => {
    if (!kindMenu.hidden && !kindMenu.contains(e.target)) hideKindMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideKindMenu();
  });

  document.querySelectorAll("#scales button").forEach((b) => {
    b.onclick = () => {
      if (store.data.timeline.scale === b.dataset.scale) return;
      gantt.setScale(b.dataset.scale);
      gantt.scrollToToday(document.getElementById("scroller"));
    };
  });

  undoBtn.onclick = () => store.undo();
  sheetTitle.onclick = () => gantt.renameSheet();
  document.getElementById("btn-add-cat").onclick = () => gantt.addCategory();

  startInput.onchange = () => {
    const [y, m] = startInput.value.split("-").map(Number);
    if (!y || !m) return renderToolbar();
    store.update((d) => {
      d.timeline.startYear = y;
      d.timeline.startMonth = m;
    });
  };

  monthsInput.onchange = () => {
    const months = Math.min(60, Math.max(1, Number(monthsInput.value) || 1));
    store.update((d) => {
      d.timeline.months = months;
    });
  };

  document.getElementById("btn-export").onclick = () => store.exportJson();
  document.getElementById("btn-import").onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    try {
      store.importJson(await file.text());
    } catch (err) {
      alert(`匯入失敗：${err.message}`);
    }
  };

  document.getElementById("btn-reset").onclick = () => {
    if (confirm("用示範資料覆蓋目前內容？（可用復原找回）")) store.resetDemo();
  };

  document.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing && !document.getElementById("dlg").open) {
      e.preventDefault();
      store.undo();
    }
  });

  setMode("paint");
  setKind("plan");
  renderAll();
  gantt.scrollToToday(document.getElementById("scroller"));
  console.log("[app] your_schedule ready");
})();
