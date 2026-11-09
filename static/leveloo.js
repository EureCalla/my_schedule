// 登入頁的 LEVELOO 頭像：畫法同 Callami 辦事處（600_Leveloo/leveloo_office.py 的 drawAvatar），
// 底圖的橘色換成帳號專屬色、背景畫成透明；輸入帳號時從頭像框底部長出來
//
// 動畫不移動整張圖（會讓脖子和框底斷開），而是沿用辦事處 neck_length 的作法逐格重畫：
// 第 row 列畫底圖的第 row + neck 列，超出底部就重複最後一列（脖子）。
//   neck = -rows：整隻在框外（看不到）
//   neck = 0：原圖
//   neck > 0：脖子拉長
// 所以不論 neck 多少，脖子底部都接著框底。

const LEVELOO_DEFAULT_COLOR = "#f5d97b"; // 查不到專屬色時用頁面的鵝黃色
const LEVELOO_GROW_MS = 1000; // 脖子從 0 長出、回彈到停住
const LEVELOO_SHRINK_MS = 220; // 縮回框底
const LEVELOO_HOP_MS = 600; // 同色換人時伸縮一下

class LevelooAvatar {
  constructor(box, canvas) {
    this.box = box;
    this.canvas = canvas;
    this.sprite = null;
    this.colored = null; // 換好色的 RGBA 底圖，每格動畫只做列的對應
    this.visible = false;
    this.color = "";
    this.neck = 0;
    this.frame = 0;
    this.seq = 0; // 連續輸入時只採用最後一次查詢的結果
    this.reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  // 讀底圖；讀不到（共享槽斷線）就維持 📅，回傳 false
  async init() {
    try {
      const { sprite } = await api("GET", "/api/leveloo", undefined, { redirectOn401: false });
      if (!sprite || !Array.isArray(sprite.pixels)) return false;
      this.sprite = sprite;
      this.canvas.width = sprite.cols;
      this.canvas.height = sprite.rows;
      this.neck = -sprite.rows;
      this.canvas.hidden = false;
      this.box.classList.add("has-leveloo");
      console.log("[leveloo] sprite ready");
      return true;
    } catch (err) {
      console.warn("[leveloo] sprite unavailable", err);
      return false;
    }
  }

  // 換色：橘色換成專屬色、背景透明，結果存成 RGBA 供每格重畫
  recolor(hexColor) {
    const { rows, cols, pixels, background, orange } = this.sprite;
    const out = new Uint8ClampedArray(rows * cols * 4);
    const replacement = hexToRgbTriple(hexColor);
    const same = (i, rgb) => pixels[i] === rgb[0] && pixels[i + 1] === rgb[1] && pixels[i + 2] === rgb[2];
    for (let p = 0; p < rows * cols; p += 1) {
      const src = p * 3;
      const dst = p * 4;
      if (same(src, background)) continue;
      const rgb = same(src, orange) ? replacement : [pixels[src], pixels[src + 1], pixels[src + 2]];
      out[dst] = rgb[0];
      out[dst + 1] = rgb[1];
      out[dst + 2] = rgb[2];
      out[dst + 3] = 255;
    }
    this.colored = out;
    this.color = hexColor;
  }

  // 依目前的 neck 畫一格
  render() {
    const { rows, cols } = this.sprite;
    const ctx = this.canvas.getContext("2d");
    const image = ctx.createImageData(cols, rows);
    const neck = Math.round(this.neck);
    const rowBytes = cols * 4;
    for (let row = 0; row < rows; row += 1) {
      const src = row + neck;
      if (src < 0) continue; // 框外，保持透明
      const from = Math.min(rows - 1, src) * rowBytes;
      image.data.set(this.colored.subarray(from, from + rowBytes), row * rowBytes);
    }
    ctx.putImageData(image, 0, 0);
  }

  // 逐格把 neck 換成 curve(t)，t 從 0 到 1；結束時 neck 固定在 end
  animate(ms, curve, end) {
    cancelAnimationFrame(this.frame);
    return new Promise((resolve) => {
      if (this.reduceMotion) {
        this.neck = end;
        this.render();
        resolve();
        return;
      }
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms);
        this.neck = t < 1 ? curve(t) : end;
        this.render();
        if (t < 1) this.frame = requestAnimationFrame(step);
        else resolve();
      };
      this.frame = requestAnimationFrame(step);
    });
  }

  // 脖子從 0 長出：衝過頭（脖子拉長）再回彈幾下停在 target（預設 0＝原圖；側邊欄依等級給脖子長度）
  grow(target = 0) {
    const hidden = -this.sprite.rows;
    const sec = LEVELOO_GROW_MS / 1000;
    return this.animate(
      LEVELOO_GROW_MS,
      (t) => target + (hidden - target) * Math.exp(-4.8 * t * sec) * Math.cos(10 * t * sec),
      target
    );
  }

  // 縮回框底
  shrink() {
    const from = this.neck;
    const hidden = -this.sprite.rows;
    return this.animate(LEVELOO_SHRINK_MS, (t) => from + (hidden - from) * t * t, hidden);
  }

  // 原地伸縮一下
  hop() {
    return this.animate(LEVELOO_HOP_MS, (t) => 12 * Math.exp(-4 * t) * Math.sin(4 * Math.PI * t), 0);
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
      this.visible = true;
      this.recolor(color);
      this.grow();
    } else if (color.toLowerCase() !== this.color.toLowerCase()) {
      // 換人：先縮回去、換色，再長一次
      await this.shrink();
      if (seq !== this.seq) return;
      this.recolor(color);
      this.grow();
    } else {
      this.hop();
    }
    console.log("[leveloo] show", user, color);
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.shrink();
  }
}

function hexToRgbTriple(hex) {
  const v = String(hex).replace("#", "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0);
}
