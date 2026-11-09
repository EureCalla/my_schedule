// 排程表清單：所有人公開的排程表＋自己的私人表，可依擁有者篩選，點卡片進甘特頁

(function main() {
  const FILTER_KEY = "your_schedule.sheets.filter";

  const listBox = document.getElementById("list");
  const countBox = document.getElementById("count");
  const errorBox = document.getElementById("error");
  const filterSelect = document.getElementById("owner-filter");
  const dlg = document.getElementById("dlg-new");
  const newTitle = document.getElementById("new-title");
  const newPublic = document.getElementById("new-public");
  const newError = document.getElementById("new-error");

  let me = "";
  let sheets = [];

  function openSheet(id) {
    location.href = `/index.html?sheet=${id}`;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

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
    if (f === "mine") return sheets.filter((s) => s.is_mine);
    if (f.startsWith("owner:")) return sheets.filter((s) => s.owner === f.slice(6));
    return sheets;
  }

  function card(s) {
    const el = document.createElement("div");
    el.className = `card${s.is_mine ? " mine" : ""}`;
    el.tabIndex = 0;
    el.title = s.is_mine ? "開啟並編輯" : "開啟（唯讀）";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = s.title;

    const row = document.createElement("div");
    row.className = "row";
    const owner = document.createElement("span");
    owner.textContent = s.is_mine ? `${s.owner}（我）` : s.owner;
    row.append(owner);
    if (!s.is_public) row.append(badge("🔒 私人"));
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
    el.onclick = () => openSheet(s.id);
    el.onkeydown = (e) => {
      if (e.key === "Enter") openSheet(s.id);
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
    countBox.textContent = `${rows.length} 張`;
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
      document.getElementById("user").textContent = `使用者：${me}`;
      showError("");
      renderFilter();
      render();
      console.log("[sheets] loaded", sheets.length);
    } catch (err) {
      if (err.status !== 401) showError(err.message);
    }
  }

  filterSelect.onchange = () => {
    try {
      localStorage.setItem(FILTER_KEY, filterSelect.value);
    } catch (err) {
      /* 記不住篩選不影響使用 */
    }
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
  document.getElementById("btn-new-cancel").onclick = () => dlg.close();
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
  } catch (err) {
    /* 讀不到就用預設的「全部」 */
  }
  load();
})();
