/**
 * 头像：种子色块、上传、预设图库
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { state } from "./state.js";

/* ── 头像（2026-11-06 C 批）────────────────────────────
 * 只存有界 PNG data URL（服务端同样复核）。渲染一律用 DOM 属性赋 src，
 * 不把不可信字符串拼进 innerHTML；未设置时回落名字首字。 */

const AVATAR_PREFIX = "data:image/png;base64,";
const AVATAR_MAX_CHARS = 180000;
const AVATAR_MAX_BYTES = 128 * 1024;
const AVATAR_MAX_DIM = 256;
const AVATAR_INPUT_LIMIT = 5 * 1024 * 1024;

function avatarText(name) {
  return String(name || "?").trim().slice(0, 1) || "?";
}

/** 把头像写进容器（button / span）：有图用 img，没图用首字 */
function paintAvatar(host, avatar, name) {
  if (!host) return;
  if (avatar) {
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.setAttribute("aria-hidden", "true");
    img.src = avatar; // 属性赋值，不拼 HTML
    host.replaceChildren(img);
  } else {
    host.textContent = avatarText(name);
  }
}

/** 头像 data URL 是否超出契约；合法返回 null（客户端先自查，服务端仍会复核） */
function avatarDataProblem(dataUrl) {
  if (!dataUrl.startsWith(AVATAR_PREFIX)) return "头像只接受 PNG";
  if (dataUrl.length > AVATAR_MAX_CHARS) return "头像太大，换一张更简单的图片";
  const b64 = dataUrl.slice(AVATAR_PREFIX.length);
  if (!b64 || b64.length % 4 !== 0) return "头像数据不完整";
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = (b64.length / 4) * 3 - padding;
  if (bytes > AVATAR_MAX_BYTES) return "处理后的图片超过 128KiB，换一张更简单的图片";
  return null;
}

/**
 * 本地图片 → 有界 PNG data URL：先解码（坏图在这里就失败），再按最长边 ≤256 画到 canvas。
 * 相片打成 256px PNG 仍可能超过 128KiB，此时依次退到 192 / 128，保证能存进去又不超上限。
 * 不读文件名、不上传原图，页面上也只用 <img> 解码渲染。
 */
async function fileToAvatarPng(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("只支持 PNG / JPEG / WebP 图片");
  }
  if (file.size > AVATAR_INPUT_LIMIT) {
    throw new Error("图片超过 5MiB，换一张小一点的");
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    if (typeof img.decode === "function") {
      try {
        await img.decode();
      } catch {
        throw new Error("这张图片读不出来（可能已损坏）");
      }
    } else {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("这张图片读不出来（可能已损坏）"));
      });
    }
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("这张图片没有可用的画面");

    let last = "";
    for (const max of [AVATAR_MAX_DIM, 192, 128]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器画不了图，换个浏览器再试");
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/png");
      last = avatarDataProblem(dataUrl) || "";
      if (!last) return dataUrl;
    }
    throw new Error(last || "这张图片不能用作头像");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* 在线点 = 服务连通 && 伙伴 active（2026-11-06 C 批）：
   active 且服务在线 → 绿；active 但服务失联 → 黄；暂停 / 归档 → 灰。
   忙碌只走既有的单数 / 文案，不再参与在线色；state.sending 不再决定总管是否在线。 */
function partnerDotClass(status) {
  if (status === "active") return state.serviceOk ? "ok" : "warn";
  return "idle";
}

const AVATAR_PRESET_FILES = {
  male: Array.from({ length: 10 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`),
  female: Array.from({ length: 20 }, (_, i) => `f${String(i + 1).padStart(2, "0")}`),
};
const AVATAR_PRESET_URL = (file) => `/assets/preset/${file}.png`;

export { AVATAR_INPUT_LIMIT, AVATAR_MAX_BYTES, AVATAR_MAX_CHARS, AVATAR_MAX_DIM, AVATAR_PREFIX, AVATAR_PRESET_FILES, AVATAR_PRESET_URL, avatarDataProblem, avatarText, fileToAvatarPng, paintAvatar, partnerDotClass };
