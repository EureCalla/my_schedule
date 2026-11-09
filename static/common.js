// 三個頁面共用：呼叫後端 API、登入狀態、登出

const LOGIN_PAGE = "/login.html";
const SHEETS_PAGE = "/sheets.html";

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// fetch 包裝：一律送／收 JSON；401 代表登入失效，除非呼叫端要自己處理，否則直接導回登入頁
async function api(method, path, body, { redirectOn401 = true } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    /* 非 JSON 回應時保留空物件，錯誤訊息改用狀態碼 */
  }
  if (res.status === 401 && redirectOn401) {
    location.replace(LOGIN_PAGE);
    throw new ApiError(401, "尚未登入");
  }
  if (!res.ok) throw new ApiError(res.status, data.detail || `請求失敗（${res.status}）`);
  return data;
}

async function logout() {
  try {
    await api("POST", "/api/auth/logout", {}, { redirectOn401: false });
  } catch (err) {
    /* 後端登出失敗仍回登入頁，下一次 /api/me 會重新確認 */
  }
  location.replace(LOGIN_PAGE);
}

// 後端時間是 UTC 的 "YYYY-MM-DD HH:MM:SS"，顯示時轉成本地時間
function fmtUtc(text) {
  if (!text) return "—";
  const d = new Date(text.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return text;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
