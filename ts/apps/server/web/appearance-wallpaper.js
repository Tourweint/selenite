/**
 * 壁纸（2026-11-14 外观页扩展）
 *
 * 设置 → 外观 → 壁纸：一张图铺在主区那张纸上，配「可见度 / 模糊」两条滑杆。
 * 样式在 style-23-appearance.css，按 [data-wallpaper="paper|custom"] 生效；本模块负责三件事：
 *   1. 启动时把 localStorage 的选择写到 <html>（index.html 内联脚本已先写过一遍，防首帧闪）；
 *   2. 在「外观」页挂一节「壁纸」（三选一 + 两条滑杆）；
 *   3. 选图走 POST /api/v1/appearance/wallpaper，图存服务端 .data/appearance，
 *      这里只记 etag —— URL 带 ?v=etag，换图即换缓存。
 *
 * 只有图和 mime 在服务端；「用哪张 / 可见度 / 模糊」是这台设备的外观偏好，
 * 跟主题、强调色一样走 localStorage。
 *
 * 一条边界：壁纸只铺主区（.main 那张纸）的底，不动侧栏和标题栏，
 * 气泡/卡片/composer 保持不透明 —— 让"纸"换材质，不让界面变成一层蒙版。
 */

import { authHeaders } from "./net.js";
import { toast } from "./ui-atoms.js";

const KEY = "lifediary.wallpaper";
const DEFAULT_VISIBLE = 38;
const DEFAULT_BLUR = 12;
const MAX_BLUR = 24;
const MAX_BYTES = 20 * 1024 * 1024;

function clampVisible(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_VISIBLE;
  return Math.min(100, Math.max(0, n));
}

function clampBlur(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_BLUR;
  return Math.min(MAX_BLUR, Math.max(0, n));
}

function normalize(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const BUILT_IN_IDS = ["paper", "grid", "cloud", "custom"];
  const kind = BUILT_IN_IDS.includes(source.source) ? source.source : "none";
  return {
    source: kind,
    visible: clampVisible(source.visible),
    blur: clampBlur(source.blur),
    etag: typeof source.etag === "string" ? source.etag : "",
  };
}

function readState() {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) || "null"));
  } catch {
    return normalize(null);
  }
}

function saveState(state) {
  const next = normalize(state);
  localStorage.setItem(KEY, JSON.stringify(next));
}

/** 服务端那张图的地址（只跟 etag 有关，跟"现在用没用它"无关）。 */
function imageUrl(state) {
  if (!state.etag) return "";
  return `/api/v1/appearance/wallpaper?v=${encodeURIComponent(state.etag)}`;
}

function wallpaperUrl(state) {
  if (state.source !== "custom") return "";
  return imageUrl(state);
}

/** 把状态写到 <html>：选了哪张认属性，可见度/模糊/图地址认 CSS 变量。 */
function applyState(raw = readState()) {
  const state = normalize(raw);
  const root = document.documentElement;
  if (state.source === "none") {
    delete root.dataset.wallpaper;
  } else {
    root.dataset.wallpaper = state.source;
  }
  root.style.setProperty("--wallpaper-alpha", String(state.visible / 100));
  root.style.setProperty("--wallpaper-blur", `${state.blur}px`);
  const url = wallpaperUrl(state);
  if (url) root.style.setProperty("--wallpaper-image", `url("${url}")`);
  else root.style.removeProperty("--wallpaper-image");
}

/** 滑杆"已填充"的那一截：轨道两头分别是强调色和中性轨道色（与气泡宽度同一套做法）。 */
function syncFill(range) {
  if (!range) return;
  const min = Number(range.min);
  const max = Number(range.max);
  const value = Number(range.value);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  range.style.setProperty("--wall-p", `${Math.min(100, Math.max(0, pct))}%`);
}

/** 只要服务端存着图就算"有图"（哪怕当前用的是内置纹）——不能拿 source 判，
 *  否则切去别的壁纸再切回来，会以为没图而弹选图框（2026-11-14 用户报的那条）。 */
function hasImage(state) {
  return Boolean(state.etag);
}

const KEY_ASPECT = "lifediary.wallAspect";

/** 主区的宽高比：裁剪框按它走，存下来的图就是"正好铺满、不再二次裁"的比例。
 *  必须在**对话页**那个 .main 上量：切到外观页时 #view-chat 是 hidden（0×0），
 *  而设置页那个 .main 是整窗宽（1280×920），两者比例差很多（1.14 vs 1.39）；
 *  用设置页量出来的比例去裁，图铺回对话页还要再裁一次。
 *  所以：聊天页能看见就现量并记下来，看不见就用上次记的（每次启动默认停在聊天页，必有一次）。 */
function mainAspect() {
  const chat = document.getElementById("view-chat");
  if (chat && chat.clientWidth > 0 && chat.clientHeight > 0) {
    const ratio = chat.clientWidth / chat.clientHeight;
    try {
      localStorage.setItem(KEY_ASPECT, ratio.toFixed(4));
    } catch {
      /* 存不进去就现量，不影响这次裁剪 */
    }
    return ratio;
  }
  const cached = Number(localStorage.getItem(KEY_ASPECT));
  if (Number.isFinite(cached) && cached > 0.4 && cached < 5) return cached;
  for (const el of document.querySelectorAll(".main")) {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0) return w / h;
  }
  return 16 / 9;
}

/**
 * 取景框：拖动选位置 + 滑杆缩放，确定后按框里那一块裁成新图。
 * 不引入第三方库——一张图、一个框、一次 drawImage 就够了。
 * 取消（或 Esc / 点遮罩）返回 null。
 */
function openCropper(src, aspect = mainAspect()) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "crop-overlay";
    overlay.innerHTML = `<div class="crop-card" role="dialog" aria-modal="true" aria-label="调整壁纸">
      <div class="crop-head">
        <h3>调整壁纸</h3>
        <p>框的比例就是主区的比例：拖动图片选位置，滑杆缩放。确定后只存框里这一块，铺上去正好铺满、不再被二次裁。</p>
      </div>
      <div class="crop-frame" data-crop-frame>
        <img alt="" draggable="false" data-crop-img />
        <span class="crop-grid" aria-hidden="true"></span>
      </div>
      <div class="crop-tools">
        <span class="wall-slider-name">缩放</span>
        <input class="wall-range" type="range" min="100" max="400" step="1" value="100"
               aria-label="缩放" data-crop-zoom />
        <span class="wall-range-val" data-crop-zoom-val>100%</span>
      </div>
      <div class="crop-actions">
        <button class="ghost wall-mini" type="button" data-crop-cancel>取消</button>
        <button class="btn-primary" type="button" data-crop-ok>就用这张</button>
      </div>
    </div>`;
    document.body.append(overlay);

    const frame = overlay.querySelector("[data-crop-frame]");
    const img = overlay.querySelector("[data-crop-img]");
    const zoomInput = overlay.querySelector("[data-crop-zoom]");
    const zoomVal = overlay.querySelector("[data-crop-zoom-val]");

    // 框尺寸：宽度优先，高度超了就按高度反推（保证一定塞得进窗口）
    const maxW = Math.min(720, Math.floor(window.innerWidth * 0.86));
    let frameW = maxW;
    let frameH = Math.round(frameW / aspect);
    const maxH = Math.floor(window.innerHeight * 0.56);
    if (frameH > maxH) {
      frameH = maxH;
      frameW = Math.round(frameH * aspect);
    }
    frame.style.width = `${frameW}px`;
    frame.style.height = `${frameH}px`;

    let nat = { w: 0, h: 0 };
    let zoom = 1;
    let pw = 0;
    let ph = 0;
    let tx = 0;
    let ty = 0;

    const clampPan = () => {
      tx = Math.min(0, Math.max(frameW - pw, tx));
      ty = Math.min(0, Math.max(frameH - ph, ty));
    };

    const apply = () => {
      img.style.width = `${pw}px`;
      img.style.height = `${ph}px`;
      img.style.transform = `translate(${tx}px, ${ty}px)`;
    };

    const baseScale = () => Math.max(frameW / nat.w, frameH / nat.h);

    const layout = () => {
      const scale = baseScale() * zoom;
      pw = nat.w * scale;
      ph = nat.h * scale;
      clampPan();
      apply();
    };

    const finish = (result) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };

    const onKey = (event) => {
      if (event.key === "Escape") finish(null);
    };
    document.addEventListener("keydown", onKey);

    img.addEventListener("load", () => {
      nat = { w: img.naturalWidth || frameW, h: img.naturalHeight || frameH };
      // 初始不算缩放：按 cover 铺满框，再居中
      zoom = 1;
      layout();
      tx = (frameW - pw) / 2;
      ty = (frameH - ph) / 2;
      clampPan();
      apply();
      syncFill(zoomInput);
    });
    img.src = src;

    let drag = null;
    frame.addEventListener("pointerdown", (event) => {
      drag = { x: event.clientX, y: event.clientY, tx, ty, id: event.pointerId };
      frame.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    frame.addEventListener("pointermove", (event) => {
      if (!drag) return;
      tx = drag.tx + (event.clientX - drag.x);
      ty = drag.ty + (event.clientY - drag.y);
      clampPan();
      apply();
    });
    const endDrag = () => {
      drag = null;
    };
    frame.addEventListener("pointerup", endDrag);
    frame.addEventListener("pointercancel", endDrag);

    zoomInput.addEventListener("input", () => {
      const next = Number(zoomInput.value) / 100;
      // 以框心为锚缩放：放大时画面不会"跑"到左上角
      const cx = pw ? (frameW / 2 - tx) / pw : 0.5;
      const cy = ph ? (frameH / 2 - ty) / ph : 0.5;
      zoom = next;
      const scale = baseScale() * zoom;
      pw = nat.w * scale;
      ph = nat.h * scale;
      tx = frameW / 2 - cx * pw;
      ty = frameH / 2 - cy * ph;
      clampPan();
      apply();
      zoomVal.textContent = `${zoomInput.value}%`;
      syncFill(zoomInput);
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });
    overlay.querySelector("[data-crop-cancel]")?.addEventListener("click", () => finish(null));

    overlay.querySelector("[data-crop-ok]")?.addEventListener("click", () => {
      if (!nat.w) return;
      const scale = baseScale() * zoom; // 显示像素 / 原图像素
      const sx = -tx / scale;
      const sy = -ty / scale;
      const sw = frameW / scale;
      const sh = frameH / scale;
      // 输出宽度封顶 2400：再高的壁纸在这块屏上也看不出来，只是把 20MB 额度烧掉
      const outW = Math.min(2400, Math.round(sw));
      const outH = Math.max(1, Math.round(outW * frameH / frameW));
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        finish(null);
        return;
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
      canvas.toBlob(
        (blob) => {
          finish(blob ? new File([blob], "wallpaper.jpg", { type: "image/jpeg" }) : null);
        },
        "image/jpeg",
        0.9,
      );
    });
  });
}

/** 三档内置材质（2026-11-14：原来只有宣纸纹，用户要求跟主题卡一样一排 5 格，补两档）。 */
const BUILT_IN = [
  { id: "paper", cls: "is-paper", name: "宣纸纹", hint: "纤维" },
  { id: "grid", cls: "is-grid", name: "细格", hint: "方格" },
  { id: "cloud", cls: "is-cloud", name: "云纹", hint: "墨晕" },
];

function sectionHtml(state) {
  const checked = (kind) => (state.source === kind ? "true" : "false");
  const disabled = state.source === "none" ? "disabled" : "";
  return `<section class="set-sec" data-wallpaper-sec>
  <h2 class="set-sec-title">壁纸</h2>
  <div class="card">
    <div class="row">
      <div class="row-main">
        <div class="row-label" data-tip="铺在主区那张纸上；气泡、卡片、输入框保持不透明，只有空隙透出来。自定义图支持 PNG / JPEG / WebP，单张 ≤20 MB，存在本机换成新的会覆盖旧的">壁纸</div>
      </div>
      <div class="row-control" data-wall-note></div>
    </div>
    <div class="wallpapers" role="radiogroup" aria-label="壁纸">
      <button class="wall-choice" type="button" role="radio" data-wall="none" aria-checked="${checked("none")}">
        <span class="wall-thumb is-none" aria-hidden="true"></span>
        <span class="wall-cap"><b>无</b><small>纯色底</small></span>
      </button>
      ${BUILT_IN.map(
        (item) => `<button class="wall-choice" type="button" role="radio" data-wall="${item.id}" aria-checked="${checked(item.id)}">
        <span class="wall-thumb ${item.cls}" aria-hidden="true"></span>
        <span class="wall-cap"><b>${item.name}</b><small>${item.hint}</small></span>
      </button>`,
      ).join("")}
      <button class="wall-choice" type="button" role="radio" data-wall="custom" aria-checked="${checked("custom")}">
        <span class="wall-thumb is-custom" aria-hidden="true">
          <img data-wall-img alt="" ${hasImage(state) ? "" : "hidden"} />
          <span class="wall-empty" data-wall-empty ${hasImage(state) ? "hidden" : ""}>选一张图</span>
        </span>
        <span class="wall-cap"><b>自定义…</b><small data-wall-custom-hint>${hasImage(state) ? "已选" : "上传"}</small></span>
      </button>
    </div>
    <div class="wall-slider-row">
      <span class="wall-slider-name" title="0% 完全看不出来，100% 不做任何遮挡">可见度</span>
      <input class="wall-range" type="range" min="0" max="100" step="1" value="${state.visible}"
             aria-label="壁纸可见度" data-wall-visible ${disabled} />
      <span class="wall-range-val" data-wall-visible-val>${state.visible}%</span>
    </div>
    <div class="wall-slider-row">
      <span class="wall-slider-name" title="只对自定义图生效：内置纹是 1px 纤维，糊了就不成纹了">模糊</span>
      <input class="wall-range" type="range" min="0" max="${MAX_BLUR}" step="1" value="${state.blur}"
             aria-label="壁纸模糊" data-wall-blur ${disabled} />
      <span class="wall-range-val" data-wall-blur-val>${state.blur} px</span>
    </div>
  </div>
  <input type="file" accept="image/png,image/jpeg,image/webp" hidden data-wall-file />
</section>`;
}

/** 三个格子之外的「换一张 / 裁剪 / 移除」：服务端存着图就出现（2026-11-14 用户：
 *  自定义完没法再换，要先移除才行 —— 换图入口得一直在，不能藏在"移除之后"）。 */
function paintNote(note, state) {
  if (!note) return;
  if (!hasImage(state)) {
    // 说明文字不摆在这里了（2026-11-14 用户要求）：一律收进「壁纸」标签的悬停提示
    note.innerHTML = "";
    return;
  }
  note.innerHTML = `<button class="ghost wall-mini" type="button" data-wall-replace>换一张</button>
    <button class="ghost wall-mini" type="button" data-wall-crop>裁剪</button>
    <button class="ghost wall-mini" type="button" data-wall-remove>移除</button>`;
}

/** 把当前状态回写到这一节的 DOM（选图/换图后要整体刷一遍，不只刷滑杆）。 */
function paintSection(section, state) {
  if (!section) return;
  for (const tile of section.querySelectorAll("[data-wall]")) {
    tile.setAttribute("aria-checked", String(tile.dataset.wall === state.source));
  }
  const img = section.querySelector("[data-wall-img]");
  const empty = section.querySelector("[data-wall-empty]");
  const hint = section.querySelector("[data-wall-custom-hint]");
  if (img) {
    const url = imageUrl(state);
    if (url) {
      img.src = url;
      img.hidden = false;
      if (empty) empty.hidden = true;
      if (hint) hint.textContent = state.source === "custom" ? "已选" : "已存";
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      if (empty) empty.hidden = false;
      if (hint) hint.textContent = "上传";
    }
  }
  const visible = section.querySelector("[data-wall-visible]");
  const blur = section.querySelector("[data-wall-blur]");
  const visibleVal = section.querySelector("[data-wall-visible-val]");
  const blurVal = section.querySelector("[data-wall-blur-val]");
  if (visible) {
    visible.value = String(state.visible);
    visible.disabled = state.source === "none";
    syncFill(visible);
  }
  if (blur) {
    blur.value = String(state.blur);
    // 内置纹不吃模糊（1px 纤维会被糊成一片灰），所以只有自定义图这一档能拖
    blur.disabled = state.source !== "custom";
    syncFill(blur);
  }
  if (visibleVal) visibleVal.textContent = `${state.visible}%`;
  if (blurVal) blurVal.textContent = `${state.blur} px`;
  paintNote(section.querySelector("[data-wall-note]"), state);
}

/** 换图 / 裁剪之后重新挂监听：note 里那几个按钮是 paintNote 现造的。 */
function wireNote(section) {
  const note = section.querySelector("[data-wall-note]");
  if (!note || note.dataset.wired === "1") return;
  note.dataset.wired = "1";
  note.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    // 用 hasAttribute：`data-wall-replace=""` 的 dataset 值是空字符串，按真值判断永远进不来
    if (target.hasAttribute("data-wall-replace")) {
      section.querySelector("[data-wall-file]")?.click();
    } else if (target.hasAttribute("data-wall-crop")) {
      const url = imageUrl(readState());
      if (url) void cropWallpaper(section, url);
    } else if (target.hasAttribute("data-wall-remove")) {
      void removeWallpaper(section);
    }
  });
}

/** 把一张图（本地文件或服务端那张）过一遍裁剪框，确定后上传。 */
async function cropWallpaper(section, src) {
  const blob = await openCropper(src, mainAspect());
  if (!blob) return;
  await uploadWallpaper(section, blob);
}

async function uploadWallpaper(section, file) {
  if (!file) return;
  if (file.size > MAX_BYTES) {
    toast(`这张图 ${Math.round(file.size / 1024 / 1024)} MB，超过 20 MB`);
    return;
  }
  const form = new FormData();
  form.set("file", file);
  try {
    const response = await fetch("/api/v1/appearance/wallpaper", {
      method: "POST",
      headers: authHeaders({}),
      body: form,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      toast(payload?.error || "这张图没存上");
      return;
    }
    const saved = await response.json();
    const next = { ...readState(), source: "custom", etag: String(saved.etag || "") };
    saveState(next);
    applyState(next);
    paintSection(section, next);
    wireNote(section);
    toast("壁纸已换");
  } catch (error) {
    toast("壁纸没存上：服务连不上");
  }
}

async function removeWallpaper(section) {
  try {
    await fetch("/api/v1/appearance/wallpaper", { method: "DELETE", headers: authHeaders({}) });
  } catch {
    /* 删不掉也把界面回落：图没了就是没了，不拦着用户换成"无" */
  }
  const next = { ...readState(), source: "none", etag: "" };
  saveState(next);
  applyState(next);
  paintSection(section, next);
  wireNote(section);
}

/** 启动 / 切页时和服务对一次账：图被手删了要回落，etag 变了（另一台设备换过图）要跟着换。 */
async function syncWithServer(section) {
  try {
    const response = await fetch("/api/v1/appearance/wallpaper/meta", { cache: "no-store" });
    if (response.status === 404) {
      // 端点没挂（AGENT_APPEARANCE_WALLPAPER=0）：这一整节不该存在
      section?.remove();
      delete document.documentElement.dataset.wallpaper;
      return;
    }
    if (!response.ok) return;
    const meta = await response.json();
    const state = readState();
    const present = meta && meta.present === true;
    if (!present && state.source === "custom") {
      const next = { ...state, source: "none", etag: "" };
      saveState(next);
      applyState(next);
      paintSection(section, next);
      return;
    }
    if (present && typeof meta.etag === "string" && meta.etag !== state.etag) {
      const next = { ...state, source: "custom", etag: meta.etag };
      saveState(next);
      applyState(next);
      paintSection(section, next);
      wireNote(section);
    }
  } catch {
    /* 服务没起来：按本地状态照旧铺，不打扰 */
  }
}

/** 挂一节进「外观」页（只认标记，切页重渲染会重挂）。 */
function mountSection() {
  const host = document.getElementById("settings-inner");
  if (!host) return;
  if (!host.querySelector("#font-open")) return;
  if (host.querySelector("[data-wallpaper-sec]")) {
    // 已经挂着；切页回来时刷一次标签状态就够了
    paintSection(host.querySelector("[data-wallpaper-sec]"), readState());
    return;
  }

  const state = readState();
  const holder = document.createElement("div");
  holder.innerHTML = sectionHtml(state);
  const section = holder.firstElementChild;
  // 位置上挨着「外观」卡之后、回答气泡之前
  const appearanceSec = host.querySelector(".set-sec");
  const bubbleSec = host.querySelector("[data-bubble-sec]");
  if (bubbleSec) bubbleSec.before(section);
  else if (appearanceSec) appearanceSec.after(section);
  else host.append(section);

  wireSection(section);
  paintSection(section, state);
  void syncWithServer(section);
}

function wireSection(section) {
  for (const tile of section.querySelectorAll("[data-wall]")) {
    tile.addEventListener("click", () => {
      const kind = tile.dataset.wall;
      if (kind === "custom") {
        const state = readState();
        // 没图 → 开选图；有图且已经选中 → 再点就是"换一张"（用户抱怨过"自定义完没法再换"）
        if (!hasImage(state) || state.source === "custom") {
          section.querySelector("[data-wall-file]")?.click();
          return;
        }
        const next = { ...state, source: "custom" };
        saveState(next);
        applyState(next);
        paintSection(section, next);
        return;
      }
      const next = { ...readState(), source: kind };
      saveState(next);
      applyState(next);
      paintSection(section, next);
      wireNote(section);
    });
  }

  const fileInput = section.querySelector("[data-wall-file]");
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast(`这张图 ${Math.round(file.size / 1024 / 1024)} MB，超过 20 MB`);
      return;
    }
    // 选完先进裁剪框：原图直接 cover 会切人头、切主体，也说不清"到底选中了哪块"
    const url = URL.createObjectURL(file);
    void cropWallpaper(section, url).finally(() => URL.revokeObjectURL(url));
  });

  const visible = section.querySelector("[data-wall-visible]");
  const blur = section.querySelector("[data-wall-blur]");
  visible?.addEventListener("input", () => {
    const next = { ...readState(), visible: clampVisible(visible.value) };
    applyState(next);
    const val = section.querySelector("[data-wall-visible-val]");
    if (val) val.textContent = `${next.visible}%`;
    syncFill(visible);
  });
  visible?.addEventListener("change", () => {
    saveState({ ...readState(), visible: clampVisible(visible.value) });
  });
  blur?.addEventListener("input", () => {
    const next = { ...readState(), blur: clampBlur(blur.value) };
    applyState(next);
    const val = section.querySelector("[data-wall-blur-val]");
    if (val) val.textContent = `${next.blur} px`;
    syncFill(blur);
  });
  blur?.addEventListener("change", () => {
    saveState({ ...readState(), blur: clampBlur(blur.value) });
  });

  wireNote(section);
}

applyState(readState());
// 启动时顺手量一次对话页比例存起来（这时一般停在聊天页），免得第一次裁剪时量不到
void mainAspect();
mountSection();
const host = document.getElementById("settings-inner");
if (host) {
  // 与 bubble-mode 同一条纪律：只盯 childList，别盯 subtree（聊天流式每帧都在改 DOM）
  const observer = new MutationObserver(() => mountSection());
  observer.observe(host, { childList: true });
}

export { applyState as applyWallpaperState, readState as readWallpaperState };
