// 登入頁：驗證 VR20 帳密，成功後進排程表清單

(function main() {
  /* 只記住帳號；密碼永遠不寫入瀏覽器儲存空間 */
  const LOGIN_USER_STORAGE_KEY = "your_schedule.login.user";
  const STATUS_INTERVAL_MS = 15000;

  const form = document.getElementById("loginForm");
  const userInput = document.getElementById("loginUser");
  const passwordInput = document.getElementById("loginPassword");
  const submitBtn = document.getElementById("loginSubmit");
  const errorBox = document.getElementById("loginError");
  const statusBox = document.getElementById("loginServerStatus");
  const statusDot = document.getElementById("loginServerStatusDot");
  const statusText = document.getElementById("loginServerStatusText");

  function rememberedLoginUser() {
    try {
      return localStorage.getItem(LOGIN_USER_STORAGE_KEY) || "";
    } catch (err) {
      return "";
    }
  }

  function rememberLoginUser(user) {
    if (!user) return;
    try {
      localStorage.setItem(LOGIN_USER_STORAGE_KEY, user);
    } catch (err) {
      /* localStorage 被瀏覽器停用時仍可正常登入，只是不記住帳號 */
    }
  }

  // 資料庫燈號：共享槽連不到時登入後也讀不到排程表，先在這裡提示
  async function refreshStatus() {
    let ok = false;
    try {
      ok = (await api("GET", "/api/health", undefined, { redirectOn401: false })).db;
    } catch (err) {
      ok = false;
    }
    statusDot.className = `dot ${ok ? "on" : "off"}`;
    statusText.textContent = ok ? "資料庫已連線" : "資料庫無法連線";
    statusBox.title = ok ? "共享槽上的排程資料庫可以使用" : "連不到共享槽上的排程資料庫，請確認網路磁碟";
  }

  async function submitLogin(event) {
    event.preventDefault();
    const user = userInput.value.trim();
    const password = passwordInput.value;
    if (!user || !password) return;

    userInput.disabled = true;
    passwordInput.disabled = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "驗證中…";
    errorBox.textContent = "";
    try {
      const data = await api("POST", "/api/auth/login", { user, password }, { redirectOn401: false });
      passwordInput.value = "";
      rememberLoginUser(data.user || user);
      console.log("[login] ok", data.user);
      location.replace(SHEETS_PAGE);
      return;
    } catch (err) {
      errorBox.textContent = err.message || "登入失敗";
    }
    userInput.disabled = false;
    passwordInput.disabled = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "登入";
    passwordInput.focus();
  }

  async function init() {
    // 已登入就不必再輸入一次
    try {
      await api("GET", "/api/me", undefined, { redirectOn401: false });
      location.replace(SHEETS_PAGE);
      return;
    } catch (err) {
      /* 尚未登入，留在登入頁 */
    }
    userInput.value = rememberedLoginUser();
    (userInput.value ? passwordInput : userInput).focus();
    refreshStatus();
    setInterval(refreshStatus, STATUS_INTERVAL_MS);
    if (await avatar.init()) avatar.show(userInput.value.trim());
  }

  // 輸入帳號停 300ms 後讓 LEVELOO 以該帳號的專屬色彈出來
  const AVATAR_DEBOUNCE_MS = 300;
  const avatar = new LevelooAvatar(document.getElementById("loginAvatar"), document.getElementById("levelooCanvas"));
  let avatarTimer = null;
  userInput.addEventListener("input", () => {
    clearTimeout(avatarTimer);
    avatarTimer = setTimeout(() => avatar.show(userInput.value.trim()), AVATAR_DEBOUNCE_MS);
  });

  form.addEventListener("submit", submitLogin);
  init();
})();
