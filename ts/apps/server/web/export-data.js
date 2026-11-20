/**
 * 导出数据
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { request } from "./net.js";
import { clearModalHint, setModalHint } from "./project-modal.js";
import { shellCall } from "./settings-connection.js";
import { closeModal, inShell, openModal, toast } from "./ui-atoms.js";

/* ── 导出数据（2026-11-05 J1 / 2026-11-13 升级）──────────
   2026-11-05：一个 JSON 一次性下载，落点由浏览器决定（壳里就是系统下载目录）。
   2026-11-13：先在弹层里勾"要带哪几块"，服务端打成 zip（一会话一文件夹 + 记忆/内容/团队/配置，
   包根上有 README.md + manifest.json）；存哪按能力依次退：页面保存框 → 壳的系统另存为 → 下载目录。 */

const EXPORT_PARTS = [
  {
    id: "conversations",
    name: "会话与消息",
    hint: "每个对话一个文件夹：transcript.md（人读）+ messages.json（机读）",
  },
  { id: "memory", name: "记忆", hint: "全部记忆记录（偏好 / 事实 / 打算 / 履历 / 经验）→ records.jsonl" },
  { id: "library", name: "内容", hint: "项目、日记、例行 → library/" },
  { id: "team", name: "团队", hint: "执事名册、SOUL 与契约、群组与群消息 → team/" },
  { id: "config", name: "配置与用量", hint: "供应商（不含密钥）、模型用量、开关现值 → config/" },
];

/** 过桥传字节的上限（与壳里 shellSaveBytesMax 对齐；超了退回下载目录） */
const SHELL_SAVE_MAX_BYTES = 96 * 1024 * 1024;

/** 本地时间 → `2026-11-13-1430`，和包里根目录同名 */
function exportStampOf(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function openExportModal() {
  openModal("导出数据", (body) => {
    body.innerHTML = `
      <p class="modal-desc">勾几块打成 zip。解压后每块是独立目录，包根上的 README.md 写清这次导了什么、哪里被截断、刻意没带什么。</p>
      <div class="export-list">
        ${EXPORT_PARTS.map(
          (part) => `<label class="export-part">
            <input type="checkbox" data-export-part="${part.id}" checked />
            <span class="export-part-main">
              <span class="export-part-name">${part.name}</span>
              <small>${part.hint}</small>
            </span>
          </label>`,
        ).join("")}
        <label class="export-part export-part-sub" id="export-images-row">
          <input type="checkbox" id="export-images" checked />
          <span class="export-part-main">
            <span class="export-part-name">消息里的图片</span>
            <small>关掉会小很多；messages.json 里仍记着类型与 sha256</small>
          </span>
        </label>
      </div>
      <p class="modal-hint" id="export-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="export-confirm" type="button">导出压缩包</button>
      </div>`;

    const hint = body.querySelector("#export-hint");
    const confirm = body.querySelector("#export-confirm");
    const imagesRow = body.querySelector("#export-images-row");
    const conversationsBox = body.querySelector('[data-export-part="conversations"]');
    const syncImagesRow = () => {
      const on = Boolean(conversationsBox?.checked);
      imagesRow?.classList.toggle("is-muted", !on);
      const box = imagesRow?.querySelector("input");
      if (box) box.disabled = !on;
    };
    conversationsBox?.addEventListener("change", syncImagesRow);
    syncImagesRow();
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    confirm?.addEventListener("click", async () => {
      const parts = EXPORT_PARTS.map((part) => part.id).filter(
        (id) => body.querySelector(`[data-export-part="${id}"]`)?.checked,
      );
      if (parts.length === 0) {
        setModalHint(hint, "至少选一块。");
        return;
      }
      const images = Boolean(conversationsBox?.checked) && Boolean(body.querySelector("#export-images")?.checked);
      confirm.disabled = true;
      setModalHint(hint, "打包中…（会话多的时候要等一会儿）", false);
      try {
        const where = await exportBundle(parts, images);
        if (where === "cancel") {
          confirm.disabled = false;
          clearModalHint(hint);
          return;
        }
        closeModal();
        toast(where === "download" ? "已存到下载目录（这里不能选保存位置）" : "已导出");
      } catch (error) {
        confirm.disabled = false;
        setModalHint(
          hint,
          error.message === "forbidden" ? "导出失败：没有访问权限" : `导出失败：${error.message}`,
        );
      }
    });
  });
}

/**
 * 选保存位置。**必须在点击的同一个手势里调**——`showSaveFilePicker` 依赖用户激活，
 * 等 fetch 回来再弹会被浏览器以 `NotAllowedError` 拒掉，所以先定位置、再取数据。
 */
async function pickExportTarget(name) {
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "ZIP 压缩包", accept: { "application/zip": [".zip"] } }],
      });
      return { kind: "handle", handle };
    } catch (error) {
      if (error && error.name === "AbortError") return { kind: "cancel" };
      // 不支持 / 被策略拒 / 权限不对 → 退到下一种，不在这里报错
    }
  }
  return { kind: inShell() ? "shell" : "download" };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("读不出导出的包"));
    reader.readAsDataURL(blob);
  });
}

async function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** 导出并把返回的 zip 落到用户选的位置；返回最终落点（`cancel` = 用户取消了）。 */
async function exportBundle(parts, images) {
  const name = `selenite-export-${exportStampOf(new Date())}.zip`;
  const target = await pickExportTarget(name);
  if (target.kind === "cancel") return "cancel";

  const query = new URLSearchParams({
    format: "zip",
    parts: parts.join(","),
    images: images ? "1" : "0",
  });
  const response = await request(`/api/v1/agent/export?${query}`, { cache: "no-store" });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.message || `HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (response.headers.get("x-export-partial") === "1") {
    toast("部分数据没导出，解压后看 manifest.json 的原因");
  }

  if (target.kind === "handle") {
    const writable = await target.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return "handle";
  }

  if (target.kind === "shell") {
    if (blob.size <= SHELL_SAVE_MAX_BYTES) {
      try {
        const path = await shellCall("SaveExport", name, await blobToBase64(blob));
        return path ? "shell" : "cancel";
      } catch {
        // 壳还没重编 / 桥没挂：不挡着用户，退到下载目录
      }
    }
  }

  await downloadBlob(blob, name);
  return "download";
}

export { EXPORT_PARTS, SHELL_SAVE_MAX_BYTES, blobToBase64, downloadBlob, exportBundle, exportStampOf, openExportModal, pickExportTarget };
