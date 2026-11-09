// 排程表清單：所有人公開的排程表＋自己的私人表，可依擁有者篩選，點卡片進甘特頁
//
// v3.8 起：左側邊欄（程式資訊、使用者、LEVELOO 等級與頭像，參考 Probe_Tracking），
// 點卡片改成彈出操作選單：進入／舊版（唯讀）／複製／複製休假／封存（只有建立者）。
// 封存的表只有自己看得到，篩選列的「顯示封存」預設不勾。

(function main() {
  const FILTER_KEY = "your_schedule.sheets.filter";
  const ARCHIVED_KEY = "your_schedule.sheets.showArchived";
  const SIDEBAR_DEVELOPER = "Calla #6381";

  const listBox = document.getElementById("list");
  const countBox = document.getElementById("count");
  const errorBox = document.getElementById("error");
  const noticeBox = document.getElementById("notice");
  const filterSelect = document.getElementById("owner-filter");
  const showArchived = document.getElementById("show-archived");
  const menu = document.getElementById("card-menu");
  const menuArchive = document.getElementById("menu-archive");
  const dlg = document.getElementById("dlg-new");
  const newTitle = document.getElementById("new-title");
  const newPublic = document.getElementById("new-public");
  const newError = document.getElementById("new-error");

  let me = "";
  let sheets = [];
  let menuSheet = null; // 目前選單對應的排程表
  let menuCard = null;

  function openSheet(id, version) {
    location.href = version ? `/index.html?sheet=${id}&version=${version}` : `/index.html?sheet=${id}`;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function showNotice(message) {
    noticeBox.textContent = message;
    noticeBox.hidden = !message;
  }

  function remember(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      /* 記不住篩選不影響使用 */
    }
  }

  // ---- 側邊欄 ----
  async function loadProfile() {
    let p;
    try {
      p = await api("GET", "/api/profile");
    } catch (err) {
      return;
    }
    document.getElementById("side-program").textContent = p.program;
    document.getElementById("side-intro").textContent = p.intro;
    document.getElementById("side-version").textContent = p.version;
    // 側邊欄顯示用的署名；introduce.py 的 developer 依 side-project 規範固定為 "Calla.Lin #6381"（甘特頁頁尾也用它）
    document.getElementById("side-developer").textContent = SIDEBAR_DEVELOPER;
    document.getElementById("user").textContent = p.user;

    const lv = p.leveloo;
    if (!lv) return; // 遊戲資料庫讀不到：只隱藏 LEVELOO 區塊
    const stats = document.getElementById("side-stats");
    const line = (html) => {
      const div = document.createElement("div");
      div.append(...html);
      return div;
    };
    const strong = (t) => {
      const s = document.createElement("strong");
      s.textContent = t;
      return s;
    };
    stats.replaceChildren(
      line([lv.title ? `《${lv.title}》 ` : "", `🪙 ${lv.coin} Coins`]),
      line([`⚔️ lv.${lv.level} 《${lv.rank}》/ `, lv.exp_to_next > 0 ? `距離下次長高尚須${lv.exp_to_next}exp` : "已達最高等級！"]),
      line([strong(`您已經為部門系統貢獻${lv.exp}筆有效資訊`)])
    );
    // 同 Probe_Tracking：8:00–17:59 白天，其餘黑夜
    const hour = new Date().getHours();
    document.getElementById("side-mode").textContent =
      hour >= 8 && hour <= 17 ? "☀️ Happy Day，工作愉快!!!" : "🌙 Night Shift，早點回家休息吧~";
    document.getElementById("side-leveloo").hidden = false;

    const avatar = new LevelooAvatar(document.getElementById("side-avatar"), document.getElementById("side-canvas"));
    if (await avatar.init()) {
      avatar.recolor(lv.color || LEVELOO_DEFAULT_COLOR);
      avatar.visible = true;
      // 脖子長度同 Probe：(neck_length − 5) × 10
      avatar.grow((lv.neck_length - 5) * 10);
    }
    console.log("[sheets] profile", lv.level, lv.rank);
  }

  // ---- 清單 ----
  // 篩選選項：全部、我自己，再加上清單裡出現的其他擁有者
  function renderFilter() {
    const keep = filterSelect.value;
    const others = [...new Set(sheets.filter((s) => !s.is_mine).map((s) => s.owner))].sort((a, b) => a.localeCompare(b));
    filterSelect.replaceChildren(
      new Option("全部", "all"),
      new Option("我自己", "mine"),
      ...others.map((o) => new Option(o, `owner:${o}`))
    );
    const options = [...filterSelect.options].map((o) => o.value);
    filterSelect.value = options.includes(keep) ? keep : "all";
  }

  function filtered() {
    const f = filterSelect.value;
    let rows = showArchived.checked ? sheets : sheets.filter((s) => !s.is_archived);
    if (f === "mine") rows = rows.filter((s) => s.is_mine);
    if (f.startsWith("owner:")) rows = rows.filter((s) => s.owner === f.slice(6));
    return rows;
  }

  function card(s) {
    const el = document.createElement("div");
    el.className = `card${s.is_mine ? " mine" : ""}${s.is_archived ? " archived" : ""}`;
    el.tabIndex = 0;
    el.title = "點擊選擇：進入／舊版／複製／複製休假" + (s.is_mine ? "／封存" : "");

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = s.title;

    const row = document.createElement("div");
    row.className = "row";
    const owner = document.createElement("span");
    owner.textContent = s.is_mine ? `${s.owner}（我）` : s.owner;
    row.append(owner);
    if (!s.is_public) row.append(badge("🔒 私人"));
    if (s.is_archived) row.append(badge("🗄 已封存"));
    if (s.copied_from_sheet_id) row.append(badge("📋 副本"));
    if (s.locked_by) row.append(badge(`✎ ${s.locked_by} 編輯中`, "lock"));

    if (s.is_mine) {
      // 只有建立者可切換公開；點這裡不要觸發開啟
      const toggle = document.createElement("label");
      toggle.className = "public-toggle";
      toggle.title = "公開＝所有人都看得到";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = s.is_public;
      box.onchange = async () => {
        try {
          await api("POST", `/api/sheets/${s.id}/public`, { is_public: box.checked });
          s.is_public = box.checked;
          console.log("[sheets] public", s.id, box.checked);
          render();
        } catch (err) {
          box.checked = s.is_public;
          showError(err.message);
        }
      };
      toggle.append(box, document.createTextNode("公開"));
      toggle.onclick = (e) => e.stopPropagation();
      row.append(toggle);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const version = s.current_version_no ? `v${s.current_version_no}` : "尚未存檔";
    meta.append(text(`版本 ${version}`), text(`更新 ${fmtUtc(s.updated_at)}`));

    el.append(title, row, meta);
    el.onclick = (e) => {
      e.stopPropagation();
      openMenu(s, el);
    };
    el.onkeydown = (e) => {
      if (e.key === "Enter") openMenu(s, el);
    };
    return el;
  }

  function badge(label, cls = "") {
    const b = document.createElement("span");
    b.className = `badge ${cls}`.trim();
    b.textContent = label;
    return b;
  }

  function text(t) {
    const span = document.createElement("span");
    span.textContent = t;
    return span;
  }

  function render() {
    const rows = filtered();
    const hidden = sheets.filter((s) => s.is_archived).length;
    countBox.textContent = `${rows.length} 張` + (!showArchived.checked && hidden ? `（另有 ${hidden} 張封存）` : "");
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = filterSelect.value === "mine" ? "你還沒有排程表，按「＋ 新增排程表」建立一張" : "沒有符合的排程表";
      listBox.replaceChildren(empty);
      return;
    }
    listBox.replaceChildren(...rows.map(card));
  }

  async function load() {
    try {
      const data = await api("GET", "/api/sheets");
      me = data.user;
      sheets = data.sheets;
      document.getElementById("user").textContent = me;
      showError("");
      renderFilter();
      render();
      console.log("[sheets] loaded", sheets.length);
    } catch (err) {
      if (err.status !== 401) showError(err.message);
    }
  }

  // ---- 卡片操作選單 ----
  function openMenu(sheet, cardEl) {
    closeMenu();
    menuSheet = sheet;
    menuCard = cardEl;
    cardEl.classList.add("selected");
    menuArchive.hidden = !sheet.is_mine;
    menuArchive.textContent = sheet.is_archived ? "🗄 取消封存" : "🗄 封存";
    menu.hidden = false;
    // 放在卡片右上角附近，超出視窗就往內收
    const rect = cardEl.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.min(rect.right - 12, window.innerWidth - mw - 8);
    const top = Math.min(rect.top + 8, window.innerHeight - mh - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.querySelector("button").focus();
  }

  function closeMenu() {
    menu.hidden = true;
    if (menuCard) menuCard.classList.remove("selected");
    menuCard = null;
  }

  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeMenu();
  });
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", closeMenu, { passive: true });

  menu.querySelectorAll("button").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const sheet = menuSheet;
      closeMenu();
      console.log("[sheets] action", b.dataset.action, sheet.id);
      ({ enter: () => openSheet(sheet.id), versions: showVersions, copy: showCopy, holidays: showHolidays, archive: toggleArchive })[
        b.dataset.action
      ](sheet);
    };
  });

  // 舊版：列出所有版本，選一版以唯讀開啟
  async function showVersions(sheet) {
    const box = document.getElementById("version-list");
    const err = document.getElementById("versions-error");
    document.getElementById("versions-title").textContent = `舊版：${sheet.title}`;
    err.textContent = "";
    box.replaceChildren(text("讀取中…"));
    document.getElementById("dlg-versions").showModal();
    try {
      const { versions } = await api("GET", `/api/sheets/${sheet.id}/versions`);
      if (!versions.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "這張排程表還沒有存過檔";
        box.replaceChildren(empty);
        return;
      }
      box.replaceChildren(
        ...versions.map((v) => {
          const b = document.createElement("button");
          b.type = "button";
          const no = document.createElement("span");
          no.className = "vno";
          no.textContent = `v${v.version_no}`;
          const meta = document.createElement("span");
          meta.className = "vmeta";
          meta.textContent = `${fmtUtc(v.saved_at)}　${v.saved_by}` + (v.version_no === sheet.current_version_no ? "　（目前版本）" : "");
          b.append(no, meta);
          b.onclick = () => openSheet(sheet.id, v.version_no);
          return b;
        })
      );
    } catch (e) {
      box.replaceChildren();
      err.textContent = e.message;
    }
  }

  // 複製：整份複製成自己的新排程表，新表會記下來源
  const copyDlg = document.getElementById("dlg-copy");
  function showCopy(sheet) {
    menuSheet = sheet;
    document.getElementById("copy-hint").textContent =
      `來源：${sheet.owner}《${sheet.title}》` + (sheet.current_version_no ? ` v${sheet.current_version_no}` : "（尚未存檔，會複製成空白排程表）");
    document.getElementById("copy-title").value = `${sheet.title}（複製）`;
    document.getElementById("copy-public").checked = true;
    document.getElementById("copy-error").textContent = "";
    copyDlg.showModal();
    document.getElementById("copy-title").select();
  }
  document.getElementById("form-copy").onsubmit = async (e) => {
    e.preventDefault();
    const title = document.getElementById("copy-title").value.trim();
    if (!title) return;
    try {
      const { id } = await api("POST", `/api/sheets/${menuSheet.id}/copy`, {
        title,
        is_public: document.getElementById("copy-public").checked,
      });
      console.log("[sheets] copied", menuSheet.id, "→", id);
      openSheet(id);
    } catch (err) {
      document.getElementById("copy-error").textContent = err.message;
    }
  };

  // 複製休假：把來源的反灰日加進自己的某張排程表（不記來源）
  const holidaysDlg = document.getElementById("dlg-holidays");
  function showHolidays(sheet) {
    menuSheet = sheet;
    const targets = sheets.filter((s) => s.is_mine && s.id !== sheet.id);
    const select = document.getElementById("holidays-target");
    const err = document.getElementById("holidays-error");
    err.textContent = "";
    document.getElementById("holidays-hint").textContent =
      `把 ${sheet.owner}《${sheet.title}》的反灰（不排工作）日加進你的排程表；你原本的反灰與原因會保留，排程會依新的反灰日自動遞補。`;
    if (!targets.length) {
      select.replaceChildren(new Option("你還沒有其他排程表", ""));
      err.textContent = "請先新增一張自己的排程表";
    } else {
      select.replaceChildren(...targets.map((s) => new Option(`${s.title}${s.is_archived ? "（已封存）" : ""}`, String(s.id))));
    }
    holidaysDlg.showModal();
  }
  document.getElementById("form-holidays").onsubmit = async (e) => {
    e.preventDefault();
    const select = document.getElementById("holidays-target");
    if (!select.value) return;
    const target = sheets.find((s) => String(s.id) === select.value);
    try {
      const { added } = await api("POST", `/api/sheets/${menuSheet.id}/copy-holidays`, { target_id: Number(select.value) });
      holidaysDlg.close();
      showNotice(added ? `已在《${target.title}》加入 ${added} 個反灰日` : `《${target.title}》已經包含這些反灰日，沒有變更`);
      console.log("[sheets] holidays", menuSheet.id, "→", select.value, added);
      load();
    } catch (err) {
      document.getElementById("holidays-error").textContent = err.message;
    }
  };

  // 封存／取消封存（只有建立者）
  async function toggleArchive(sheet) {
    const next = !sheet.is_archived;
    if (next && !confirm(`封存《${sheet.title}》？\n封存後除了你以外都看不到（清單要勾「顯示封存」才會出現）。`)) return;
    try {
      await api("POST", `/api/sheets/${sheet.id}/archive`, { is_archived: next });
      showNotice(next ? `已封存《${sheet.title}》` : `已取消封存《${sheet.title}》`);
      load();
    } catch (err) {
      showError(err.message);
    }
  }

  // ---- 篩選、新增、登出 ----
  filterSelect.onchange = () => {
    remember(FILTER_KEY, filterSelect.value);
    render();
  };
  showArchived.onchange = () => {
    remember(ARCHIVED_KEY, showArchived.checked ? "1" : "");
    render();
  };

  document.getElementById("btn-logout").onclick = logout;

  document.getElementById("btn-new").onclick = () => {
    newTitle.value = "";
    newPublic.checked = true;
    newError.textContent = "";
    dlg.showModal();
    newTitle.focus();
  };
  document.querySelectorAll("dialog [data-close]").forEach((b) => {
    b.onclick = () => b.closest("dialog").close();
  });
  document.getElementById("form-new").onsubmit = async (e) => {
    e.preventDefault();
    const title = newTitle.value.trim();
    if (!title) return;
    try {
      const { id } = await api("POST", "/api/sheets", { title, is_public: newPublic.checked });
      console.log("[sheets] created", id);
      openSheet(id);
    } catch (err) {
      newError.textContent = err.message;
    }
  };

  try {
    const saved = localStorage.getItem(FILTER_KEY);
    if (saved) filterSelect.append(new Option(saved, saved));
    if (saved) filterSelect.value = saved;
    showArchived.checked = localStorage.getItem(ARCHIVED_KEY) === "1";
  } catch (err) {
    /* 讀不到就用預設的「全部」、不顯示封存 */
  }
  load();
  loadProfile();
})();
