/**
 * 附件：待发清单、路径、上传、截图
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { ATT_FILE_ICON, formatBytes } from "./chat-thread.js";
import { syncSendEnabled } from "./composer-send.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { shellCall } from "./settings-connection.js";
import { state } from "./state.js";
import { nativeScreenshotReady, toast } from "./ui-atoms.js";

/* ── 附件（2026-11-08 扫尾批 4a 图片；2026-11-13 附件走路径）────────
   规则只有一条：**只有粘贴的截图内联，其余附件全部只带路径**。
   - 壳里（window.mygo）「添加图片或文件」走 Shell.SelectFiles 原生多选 → 绝对路径，零拷贝；
   - 浏览器里选择器 / 拖入 → POST /api/v1/agent/attachments 落盘 → 服务端绝对路径；
   - 粘贴截图没有路径，仍走内联 base64（模型直接看，比多一次工具轮快）。
   浏览器侧先挡一次（图片 ≤4 张/8MB、文件 ≤8 个/32MB），服务端还会全量复核。 */
const MAX_PENDING_IMAGES = 4;
const MAX_PENDING_FILES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

function renderPendingAttachments() {
  const host = el.composerAttachments;
  if (!host) return;
  host.replaceChildren();
  host.hidden = state.pendingImages.length === 0 && state.pendingFiles.length === 0;

  state.pendingImages.forEach((image, index) => {
    const item = document.createElement("div");
    item.className = "composer-att";
    const img = document.createElement("img");
    img.src = `data:${image.mimeType};base64,${image.data}`;
    img.alt = `待发图片 ${index + 1}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除这张图片");
    remove.setAttribute("data-tip", "移除这张图片");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.pendingImages.splice(index, 1);
      renderPendingAttachments();
      syncSendEnabled();
    });
    item.append(img, remove);
    host.append(item);
  });

  state.pendingFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "composer-att is-file";
    item.setAttribute("data-tip", file.path || file.name);
    const icon = document.createElement("span");
    icon.innerHTML = ATT_FILE_ICON;
    icon.firstChild?.setAttribute?.("aria-hidden", "true");
    const main = document.createElement("span");
    main.className = "composer-att-file-main";
    const name = document.createElement("span");
    name.className = "composer-att-file-name";
    name.textContent = file.name;
    const meta = document.createElement("span");
    meta.className = "composer-att-file-meta";
    meta.textContent = [file.mimeType, formatBytes(file.bytes)].filter(Boolean).join(" · ") || "文件";
    main.append(name, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除这个文件");
    remove.setAttribute("data-tip", "移除这个文件");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.pendingFiles.splice(index, 1);
      renderPendingAttachments();
      syncSendEnabled();
    });
    item.append(icon, main, remove);
    host.append(item);
  });
}

function clearPendingAttachments() {
  state.pendingImages = [];
  state.pendingFiles = [];
  renderPendingAttachments();
  syncSendEnabled();
}

/** 绝对路径 → 待发文件（壳里原生选择器的产物；name 取 basename，体积由服务端 stat 补） */
function addPendingPaths(paths) {
  for (const raw of paths || []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (state.pendingFiles.length >= MAX_PENDING_FILES) {
      toast(`一条消息最多 ${MAX_PENDING_FILES} 个文件`);
      break;
    }
    const path = raw.trim();
    if (state.pendingFiles.some((file) => file.path === path)) continue;
    const name = path.split(/[\\/]/).pop() || path;
    state.pendingFiles.push({ path, name });
  }
  renderPendingAttachments();
  syncSendEnabled();
}

/** File → 裸 base64；读不出返回 null */
function readFileBase64(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma < 0 ? null : result.slice(comma + 1));
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** File → {mimeType, data(裸 base64)}；只给粘贴/拖入的图片用 */
async function readImageFile(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) return null;
  if (file.size > MAX_IMAGE_BYTES) return { error: "单张图片不能超过 8MB" };
  const data = await readFileBase64(file);
  return data ? { mimeType: file.type, data } : null;
}

/** 粘贴截图：内联进待发条（没有路径，模型直接看最快） */
async function addImageFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  if (!state.capabilities.attachments) {
    toast("附件已在服务端关闭（AGENT_ATTACHMENTS=false）");
    return;
  }
  for (const file of list) {
    if (state.pendingImages.length >= MAX_PENDING_IMAGES) {
      toast(`一条消息最多 ${MAX_PENDING_IMAGES} 张图片`);
      break;
    }
    const image = await readImageFile(file);
    if (!image) {
      toast("只支持图片文件");
      continue;
    }
    if (image.error) {
      toast(image.error);
      continue;
    }
    state.pendingImages.push(image);
  }
  renderPendingAttachments();
  syncSendEnabled();
}

/** 浏览器上传：把字节交给服务端落盘，拿回服务端绝对路径 */
async function uploadAttachment(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${file.name} 超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
  }
  const data = await readFileBase64(file);
  if (!data) throw new Error(`读不出 ${file.name}`);
  const response = await request("/api/v1/agent/attachments", {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      ...(file.type ? { mimeType: file.type } : {}),
      data,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  }
  return payload.file;
}

/** 选择器 / 拖入：文件附件开着就上传拿路径，关着退回老的内联图片 */
async function addBrowserFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  if (!state.capabilities.attachments) {
    toast("附件已在服务端关闭（AGENT_ATTACHMENTS=false）");
    return;
  }
  if (!state.capabilities.fileAttachments) {
    void addImageFiles(list);
    return;
  }
  for (const file of list) {
    if (state.pendingFiles.length >= MAX_PENDING_FILES) {
      toast(`一条消息最多 ${MAX_PENDING_FILES} 个文件`);
      break;
    }
    try {
      const saved = await uploadAttachment(file);
      if (!saved || typeof saved.path !== "string") continue;
      if (state.pendingFiles.some((item) => item.path === saved.path)) continue;
      state.pendingFiles.push({
        path: saved.path,
        name: saved.name || file.name,
        ...(saved.mimeType ? { mimeType: saved.mimeType } : {}),
        ...(typeof saved.bytes === "number" ? { bytes: saved.bytes } : {}),
      });
    } catch (error) {
      toast(`没上传成：${error.message}`);
    }
  }
  renderPendingAttachments();
  syncSendEnabled();
}

/** 加号 →「添加图片或文件」：壳里给路径，浏览器上传 */
async function pickFiles() {
  if (!state.capabilities.attachments) {
    toast("附件已在服务端关闭（AGENT_ATTACHMENTS=false）");
    return;
  }
  if (window.mygo?.call && state.capabilities.fileAttachments) {
    try {
      const paths = await shellCall("SelectFiles");
      if (Array.isArray(paths)) {
        if (paths.length) addPendingPaths(paths);
        return; // 用户取消 = 空数组，停在这里，不再弹浏览器选择器
      }
    } catch {
      // 旧壳没这个方法 / Shell 绑定被关：退回浏览器上传
    }
  }
  el.composerFile?.click();
}

/** 加号 →「截图」（2026-11-25 起先试壳的原生截图工具）
 *
 * 壳能力 nativeScreenshot 开 → Shell.CaptureSnapshot（拖动框选 / 单击吸附整个窗口，
 * desktop/snapshot.go）。其余三种情况走原来的 getDisplayMedia：浏览器（没有 window.mygo）、
 * 老壳（没有这个方法，Capabilities 也探不到）、回滚开关关（LIFEDIARY_NATIVE_SNAPSHOT=off）。
 * 用户在遮罩里按 Esc / 右键 = 取消：到此为止，什么都不产出，也不再去弹系统共享选择器；
 * 只有壳调用出错（或没返回图片）才 toast 后回退。 */
async function captureScreenshot() {
  if (nativeScreenshotReady()) {
    try {
      const shot = await shellCall("CaptureSnapshot");
      if (shot?.canceled) return;
      if (typeof shot?.data === "string" && shot.data) {
        if (state.pendingImages.length >= MAX_PENDING_IMAGES) {
          toast(`一条消息最多 ${MAX_PENDING_IMAGES} 张图片`);
          return;
        }
        state.pendingImages.push({ mimeType: shot.mimeType || "image/png", data: shot.data });
        renderPendingAttachments();
        syncSendEnabled();
        return;
      }
      toast("原生截图没有返回图片，改用系统共享选择器");
    } catch (error) {
      toast(`原生截图出错：${error?.message || error}，改用系统共享选择器`);
    }
  }
  await captureScreenShare();
}

/** 原来那条截图路（浏览器 / 老壳 / 开关关）：系统共享选择器选一块屏幕，抓一帧 */
async function captureScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("这个窗口不支持截屏，可以直接粘贴图片");
    return;
  }
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
    });
    await video.play();
    if (state.pendingImages.length >= MAX_PENDING_IMAGES) {
      toast(`一条消息最多 ${MAX_PENDING_IMAGES} 张图片`);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return;
    state.pendingImages.push({ mimeType: "image/png", data: dataUrl.slice(comma + 1) });
    renderPendingAttachments();
    syncSendEnabled();
  } catch {
    // 用户取消 / 环境不允许：不打扰
  } finally {
    for (const track of stream?.getTracks?.() || []) track.stop();
  }
}

function openLightbox(src) {
  if (!el.lightbox || !el.lightboxImg || !src) return;
  el.lightboxImg.src = src;
  el.lightbox.hidden = false;
}

function closeLightbox() {
  if (!el.lightbox || !el.lightboxImg || el.lightbox.hidden) return;
  el.lightbox.hidden = true;
  el.lightboxImg.removeAttribute("src");
}

el.lightbox?.addEventListener("click", closeLightbox);

export { MAX_IMAGE_BYTES, MAX_PENDING_FILES, MAX_PENDING_IMAGES, MAX_UPLOAD_BYTES, addBrowserFiles, addImageFiles, addPendingPaths, captureScreenshot, clearPendingAttachments, closeLightbox, openLightbox, pickFiles, readFileBase64, readImageFile, renderPendingAttachments, uploadAttachment };
