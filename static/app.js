// your_schedule 前端進入點：初始化資料與甘特圖，綁定工具列
//
// v3 起資料來自後端：網址帶 ?sheet={id}，開頁時讀取排程表；建立者本人會先上編輯鎖，
// 拿到鎖才能編輯，其餘情況（別人的表、自己在別處編輯中）一律唯讀。

const HEARTBEAT_MS = 5 * 60 * 1000;

async function loadSheet(sheetId) {
  const { sheet, data } = await api("GET", `/api/sheets/${sheetId}`);
  let editable = false;
  let banner = "";
  if (!sheet.is_mine) {
    banner = `唯讀：${sheet.owner} 的排程表`;
  } else {
    try {
      await api("POST", `/api/sheets/${sheetId}/lock`, {});
      editable = true;
    } catch (err) {
      if (err.status !== 409) throw err;
      banner = `唯讀：${err.message}（可能是你在另一個視窗或電腦開著，關掉那邊或等 30 分鐘後鎖會失效）`;
    }
  }
  const initial = data && isValidData(data) ? normalize(data) : blankData(sheet.title);
  return { sheet, data: initial, isNew: !data, editable, banner };
}

(async function main() {
  const sheetId = Number(new URLSearchParams(location.search).get("sheet"));
  if (!sheetId) {
    location.replace(SHEETS_PAGE);
    return;
  }

  const banner = document.getElementById("sheet-banner");
  function showBanner(message, isError = false) {
    banner.textContent = message;
    banner.classList.toggle("error", isError);
    banner.hidden = !message;
  }

  document.body.classList.add("loading");
  let loaded;
  try {
    loaded = await loadSheet(sheetId);
  } catch (err) {
    if (err.status === 401) return;
    document.body.classList.add("readonly");
    showBanner(`無法開啟排程表：${err.message}`, true);
    document.getElementById("btn-back").onclick = () => location.assign(SHEETS_PAGE);
    document.getElementById("btn-logout").onclick = logout;
    return;
  }
  document.body.classList.remove("loading");

  const { sheet } = loaded;
  let editable = loaded.editable;
  const draftKey = `your_schedule.draft.${sheetId}.v${sheet.current_version_no || 0}`;
  const store = new Store(loaded.data, { readOnly: !editable, draftKey });
  const gantt = new Gantt(store, document.getElementById("gantt"), document.getElementById("tip"), document.getElementById("dlg"));

  document.body.classList.toggle("readonly", !editable);
  showBanner(loaded.banner);
  api("GET", "/api/me").then((me) => {
    document.getElementById("user").textContent = `使用者：${me.user}`;
  });

  const legendBox = document.getElementById("legend");
  const hint = document.getElementById("hint");
  const undoBtn = document.getElementById("btn-undo");
  const startInput = document.getElementById("tl-start");
  const monthsInput = document.getElementById("tl-months");
  const fileInput = document.getElementById("file-import");
  const sheetTitle = document.getElementById("sheet-title");
  const saveBtn = document.getElementById("btn-save");
  const saveStatus = document.getElementById("save-status");

  let versionNo = sheet.current_version_no || 0;
  let savedAt = "";
  let saving = false;
  let saveError = "";

  function renderLegend() {
    // 顏色依分類自動配置，這裡只做對照；點一下可改分類名稱或顏色
    legendBox.replaceChildren(
      ...store.data.categories.map((c) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "legend-item";
        item.title = editable ? "點擊編輯分類名稱或顏色" : c.name;
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
    sheetTitle.title = editable ? "點擊修改排程表名稱" : `${sheet.owner} 的排程表`;
    document.title = `${store.data.title}｜甘特圖`;
    startInput.value = `${t.startYear}-${String(t.startMonth).padStart(2, "0")}`;
    monthsInput.value = t.months;
    startInput.disabled = !editable;
    monthsInput.disabled = !editable;
    document.querySelectorAll("#scales button").forEach((b) => b.classList.toggle("active", b.dataset.scale === t.scale));
    undoBtn.disabled = !store.canUndo();
    renderSaveStatus();
  }

  function renderSaveStatus() {
    saveBtn.disabled = !editable || saving;
    saveStatus.classList.toggle("dirty", store.dirty && !saveError);
    saveStatus.classList.toggle("error", Boolean(saveError));
    if (saveError) saveStatus.textContent = saveError;
    else if (saving) saveStatus.textContent = "存檔中…";
    else if (store.dirty) saveStatus.textContent = "● 未存檔";
    else if (savedAt) saveStatus.textContent = `已存檔 v${versionNo}（${savedAt}）`;
    else saveStatus.textContent = versionNo ? `v${versionNo}` : "";
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
    hint.textContent = editable ? MODE_HINT[mode] : "唯讀檢視：可切換日／週／月、收合分類與匯出 JSON";
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

  // ---- 存檔、編輯鎖、離開頁面 ----
  // 失去編輯鎖（逾時被接手、存檔被拒）時轉成唯讀，避免繼續改了卻存不回去
  function loseLock(message) {
    editable = false;
    store.readOnly = true;
    saveError = "";
    document.body.classList.add("readonly");
    showBanner(`${message}；目前的修改仍可用「匯出 JSON」先另存`, true);
    setMode("select");
    renderAll();
  }

  async function saveSheet() {
    if (!editable || saving) return;
    saving = true;
    saveError = "";
    renderSaveStatus();
    try {
      const res = await api("POST", `/api/sheets/${sheetId}/save`, { data: store.data });
      versionNo = res.version_no;
      savedAt = new Date().toTimeString().slice(0, 5);
      console.log("[app] saved", versionNo);
      saving = false;
      store.markSaved();
    } catch (err) {
      saving = false;
      if (err.status === 409) loseLock(err.message);
      else saveError = `存檔失敗：${err.message}`;
      renderSaveStatus();
    }
  }

  async function heartbeat() {
    if (!editable) return;
    try {
      await api("POST", `/api/sheets/${sheetId}/heartbeat`, {});
    } catch (err) {
      if (err.status === 409) loseLock(err.message);
      else console.warn("[app] heartbeat failed", err);
    }
  }

  // 離開前：有未存檔修改先確認，再釋放編輯鎖
  async function leave(then) {
    if (store.dirty && editable && !confirm("有尚未存檔的修改，確定要離開？（草稿會留在這台電腦的瀏覽器裡）")) return;
    if (editable) {
      editable = false;
      try {
        await api("POST", `/api/sheets/${sheetId}/unlock`, {});
      } catch (err) {
        /* 解鎖失敗也沒關係，30 分鐘後鎖會自動失效 */
      }
    }
    then();
  }

  saveBtn.onclick = saveSheet;
  document.getElementById("btn-back").onclick = () => leave(() => location.assign(SHEETS_PAGE));
  document.getElementById("btn-logout").onclick = () => leave(logout);

  window.addEventListener("beforeunload", (e) => {
    if (editable && store.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  window.addEventListener("pagehide", () => {
    if (editable) navigator.sendBeacon(`/api/sheets/${sheetId}/unlock`, new Blob(["{}"], { type: "application/json" }));
  });
  if (editable) setInterval(heartbeat, HEARTBEAT_MS);

  // ---- 工具列 ----
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
    const dialogOpen = document.getElementById("dlg").open;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing && !dialogOpen) {
      e.preventDefault();
      store.undo();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !dialogOpen) {
      e.preventDefault();
      saveSheet();
    }
  });

  // 上次沒存檔就離開時留下的草稿（只認同一個版本基礎上的草稿，避免蓋掉之後別處存的新版）
  if (editable) {
    const draft = store.load();
    if (draft && confirm("這張排程表有上次未存檔的草稿，要載入嗎？（選「取消」會捨棄草稿）")) {
      store.update((d) => {
        Object.keys(d).forEach((k) => delete d[k]);
        Object.assign(d, draft);
      });
      console.log("[app] draft restored");
    } else if (draft) {
      store.clearDraft();
    }
  }
  // 新排程表還沒有任何版本：提示先存一次
  if (editable && loaded.isNew) store.dirty = true;

  setMode(editable ? "paint" : "select");
  setKind("plan");
  renderAll();
  gantt.scrollToToday(document.getElementById("scroller"));
  console.log("[app] your_schedule ready", { sheetId, editable });
})();
