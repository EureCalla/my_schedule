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

  function renderLegend() {
    legendBox.replaceChildren(
      ...store.data.legend.map((l) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = `legend-item${l.id === gantt.colorId ? " active" : ""}`;
        item.title = "點選作為上色顏色";
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = l.color;
        item.append(sw, document.createTextNode(l.label || "（未命名）"));
        item.onclick = () => {
          gantt.colorId = l.id;
          setMode("paint");
          renderLegend();
        };
        return item;
      })
    );
  }

  function renderToolbar() {
    const t = store.data.timeline;
    startInput.value = `${t.startYear}-${String(t.startMonth).padStart(2, "0")}`;
    monthsInput.value = t.months;
    undoBtn.disabled = !store.canUndo();
  }

  function renderAll() {
    gantt.render();
    renderLegend();
    renderToolbar();
  }

  function setMode(mode) {
    gantt.setMode(mode);
    document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    hint.textContent = MODE_HINT[mode];
  }

  store.onChange(renderAll);

  document.querySelectorAll("#modes button").forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });

  undoBtn.onclick = () => store.undo();
  document.getElementById("btn-add-cat").onclick = () => gantt.addCategory();
  document.getElementById("btn-legend").onclick = () => gantt.manageLegend();

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
  renderAll();
  console.log("[app] your_schedule ready");
})();
