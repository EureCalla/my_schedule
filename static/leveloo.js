// 登入頁的 LEVELOO 頭像：畫法同 Callami 辦事處（600_Leveloo/leveloo_office.py 的 drawAvatar），
// 底圖的橘色換成帳號專屬色、背景畫成透明；輸入帳號時從頭像框底部彈出來

const LEVELOO_DEFAULT_COLOR = "#f5d97b"; // 查不到專屬色時用頁面的鵝黃色
const LEVELOO_DOWN_MS = 220; // 與 login.css 的 leveloo-down 動畫長度一致

class LevelooAvatar {
  constructor(box, canvas) {
    this.box = box;
    this.canvas = canvas;
    this.sprite = null;
    this.visible = false;
    this.color = "";
    this.seq = 0; // 連續輸入時只採用最後一次查詢的結果
  }

  // 讀底圖；讀不到（共享槽斷線）就維持 📅，回傳 false
  async init() {
    try {
      const { sprite } = await api("GET", "/api/leveloo", undefined, { redirectOn401: false });
      if (!sprite || !Array.isArray(sprite.pixels)) return false;
      this.sprite = sprite;
      this.canvas.width = sprite.cols;
      this.canvas.height = sprite.rows;
      this.canvas.hidden = false;
      this.box.classList.add("has-leveloo");
      console.log("[leveloo] sprite ready");
      return true;
    } catch (err) {
      console.warn("[leveloo] sprite unavailable", err);
      return false;
    }
  }

  draw(hexColor) {
    const { rows, cols, pixels, background, orange } = this.sprite;
    const ctx = this.canvas.getContext("2d");
    const image = ctx.createImageData(cols, rows);
    const replacement = hexToRgbTriple(hexColor);
    const same = (i, rgb) => pixels[i] === rgb[0] && pixels[i + 1] === rgb[1] && pixels[i + 2] === rgb[2];
    for (let p = 0; p < rows * cols; p += 1) {
      const src = p * 3;
      const dst = p * 4;
      if (same(src, background)) continue; // 透明，露出框底的霧灰
      const rgb = same(src, orange) ? replacement : [pixels[src], pixels[src + 1], pixels[src + 2]];
      image.data[dst] = rgb[0];
      image.data[dst + 1] = rgb[1];
      image.data[dst + 2] = rgb[2];
      image.data[dst + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    this.color = hexColor;
  }

  // 重新觸發 CSS 動畫：拿掉 class、強制 reflow 再加回去
  play(cls) {
    this.canvas.classList.remove("up", "hop", "down");
    void this.canvas.offsetWidth;
    this.canvas.classList.add(cls);
  }

  async show(user) {
    if (!this.sprite) return;
    const seq = ++this.seq;
    if (!user) {
      this.hide();
      return;
    }
    let color = null;
    try {
      ({ color } = await api("POST", "/api/leveloo/color", { user }, { redirectOn401: false }));
    } catch (err) {
      color = null;
    }
    if (seq !== this.seq) return;
    color = color || LEVELOO_DEFAULT_COLOR;

    if (!this.visible) {
      this.draw(color);
      this.play("up");
      this.visible = true;
    } else if (color.toLowerCase() !== this.color.toLowerCase()) {
      // 換人：先縮回去、換色，再彈一次
      this.play("down");
      setTimeout(() => {
        if (seq !== this.seq) return;
        this.draw(color);
        this.play("up");
      }, LEVELOO_DOWN_MS);
    } else {
      this.play("hop");
    }
    console.log("[leveloo] show", user, color);
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.play("down");
  }
}

function hexToRgbTriple(hex) {
  const v = String(hex).replace("#", "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0);
}
