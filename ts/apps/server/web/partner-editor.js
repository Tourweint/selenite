/**
 * 人设编辑器（头像 + SOUL）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { AVATAR_PRESET_FILES, AVATAR_PRESET_URL, avatarDataProblem, fileToAvatarPng, paintAvatar } from "./avatar.js";
import { request } from "./net.js";
import { loadPartners } from "./partner-modals.js";
import { loadRoster, syncChiefAvatar } from "./partners-status.js";
import { clearModalHint } from "./project-modal.js";
import { state } from "./state.js";
import { toast } from "./ui-atoms.js";


/* ── 人设编辑器（2026-11-07）：头像 + SOUL 一次改、一次存 ──────────────────
 *
 * 用户口径：「头像应该合并到指示里（界面称呼现为「人设」）；选图片可以下拉选择系统预设图片，
 * 也可以从本地选文件」。
 * 所以头像不再是一个独立表单，而是头像按钮自己弹出选择面板：
 *   点头像 → 面板（预设图库网格 + "从本地选一张"）→ 选中即进草稿 → 与 SOUL 一起「保存人设」。
 * 草稿语义沿用 C 批：选完只改本地预览，保存才写服务端；撤销 / 关窗不动任何数据。
 * 预设走 /assets/preset/<m|f><NN>.png（服务端白名单，2026-11-06 已落地），本地上传走
 * fileToAvatarPng（解码 → 最长边 ≤256 → PNG → ≤128KiB，与服务端复核同口径）。 */

const INSTR_PRESET_GROUPS = [
  { id: "male", label: "男生", files: AVATAR_PRESET_FILES.male },
  { id: "female", label: "女生", files: AVATAR_PRESET_FILES.female },
];

/**
 * 头像选择面板（2026-11-07 抽出共用）：贴在触发按钮下方浮出，
 * 预设图库（30 张）+ 从本地选一张 + 不使用。
 *
 * 抽出来的原因：抽屉的人设页与「全部设置 → 人设」的弹窗都要换头像，
 * 两份实现一定会漂移（此前就是弹窗独占一份）。回调口径：
 *   onPick(dataUrl|null) —— 选中即进草稿，不写服务端（保存由调用方决定）
 *   onBusy(bool, message) —— 解码/读取中，调用方据此禁用保存
 */
function openAvatarPanel({ anchor, current, onPick, onBusy }) {
  if (!anchor || !anchor.isConnected) return;
  if (anchor.dataset.avatarPanel === "1") {
    closeAvatarPanel();
    return;
  }
  const node = document.createElement("div");
  node.className = "pt-portrait-pop is-fixed";
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", "选择头像");

  const head = document.createElement("div");
  head.className = "pt-portrait-pop-head";
  const title = document.createElement("span");
  title.textContent = "选一张头像";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "pt-portrait-pop-clear";
  clear.textContent = "不使用";
  clear.title = "保存时不带头像，显示名字首字";
  head.append(title, clear);

  const groups = document.createElement("div");
  groups.className = "pt-portrait-groups";
  for (const group of INSTR_PRESET_GROUPS) {
    const label = document.createElement("div");
    label.className = "pt-portrait-group-label";
    label.textContent = `${group.label} · ${group.files.length}`;
    const grid = document.createElement("div");
    grid.className = "pt-portrait-grid";
    for (const file of group.files) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "pt-portrait-cell";
      cell.dataset.preset = file;
      cell.title = `预设 ${file}`;
      cell.setAttribute("aria-label", `预设头像 ${file}`);
      const img = document.createElement("img");
      img.src = AVATAR_PRESET_URL(file);
      img.alt = "";
      img.decoding = "async";
      img.setAttribute("aria-hidden", "true");
      cell.append(img);
      cell.addEventListener("click", () => void pick(file, cell));
      grid.append(cell);
    }
    groups.append(label, grid);
  }

  // 本地选图 input 常驻在 body 下（浮层收起时会被移除，系统文件框是异步的）
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/webp";
  fileInput.hidden = true;
  document.body.append(fileInput);

  const foot = document.createElement("div");
  foot.className = "pt-portrait-pop-foot";
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "ghost";
  upload.textContent = "从本地选一张…";
  const note = document.createElement("span");
  note.className = "pt-portrait-pop-note";
  note.textContent = "PNG / JPEG / WebP · ≤5MiB";
  foot.append(upload, note);
  node.append(head, groups, foot);
  document.body.append(node);

  const position = () => {
    const r = anchor.getBoundingClientRect();
    const width = node.offsetWidth || 332;
    const height = node.offsetHeight || 420;
    const gap = 8;
    let left = r.left;
    if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
    let top = r.bottom + gap;
    if (top + height > window.innerHeight - 12) {
      const above = r.top - height - gap;
      top = above >= 12 ? above : Math.max(12, window.innerHeight - height - 12);
    }
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  };
  position();
  anchor.dataset.avatarPanel = "1";
  anchor.setAttribute("aria-expanded", "true");

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    delete anchor.dataset.avatarPanel;
    anchor.setAttribute("aria-expanded", "false");
    node.remove();
    // 选图按钮点下去会先 close() 再 fileInput.click()：系统文件框是异步的，
    // 这里若把 input 摘掉，change 就永远不触发。等 change/取消之后再清。
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
  };
  const onResize = () => position();
  const onDocPointer = (event) => {
    if (node.contains(event.target) || anchor.contains(event.target)) return;
    close();
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    if (event.isComposing || event.keyCode === 229) return;
    event.stopPropagation(); // 只关面板，别把外面的抽屉/弹窗一起关了
    close();
    anchor.focus();
  };
  window.addEventListener("resize", onResize);
  document.addEventListener("pointerdown", onDocPointer, true);
  document.addEventListener("keydown", onKey, true);

  clear.addEventListener("click", () => {
    onPick(null);
    close();
  });
  upload.addEventListener("click", () => {
    close();
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) {
      fileInput.remove();
      return;
    }
    onBusy?.(true, "处理图片…");
    try {
      const dataUrl = await fileToAvatarPng(file);
      onPick(dataUrl);
    } catch (error) {
      onBusy?.(false, error.message || "这张图片不能用作头像");
      fileInput.remove();
      return;
    }
    onBusy?.(false, "");
    fileInput.remove();
  });

  async function pick(file, cell) {
    if (cell) cell.classList.add("is-busy");
    onBusy?.(true, "读取预设…");
    try {
      const resp = await fetch(AVATAR_PRESET_URL(file), { cache: "no-store" });
      if (!resp.ok) throw new Error(`预设读不到（HTTP ${resp.status}）`);
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("预设读不出来"));
        reader.readAsDataURL(blob);
      });
      const problem = avatarDataProblem(dataUrl);
      if (problem) throw new Error(problem);
      onPick(dataUrl);
      close();
      onBusy?.(false, "");
    } catch (error) {
      if (cell) cell.classList.remove("is-busy");
      onBusy?.(false, error.message || "这个预设用不了");
    }
  }
}

/** 供面板切换：当前已打开就收起 */
function closeAvatarPanel() {
  document.querySelectorAll('[data-avatar-panel="1"]').forEach((node) => {
    delete node.dataset.avatarPanel;
    node.setAttribute("aria-expanded", "false");
  });
  for (const pop of document.querySelectorAll(".pt-portrait-pop.is-fixed")) pop.remove();
}

async function ptWireInstructionEditor(body, partnerId, partner, initialSoul, soulVersion) {
  const preview = body.querySelector("#pt-avatar-preview");
  const caption = body.querySelector("#pt-portrait-caption");
  const soulArea = body.querySelector("#pt-soul");
  const hint = body.querySelector("#pt-instr-hint");
  const save = body.querySelector("#pt-instr-save");
  const reset = body.querySelector("#pt-instr-reset");
  const versionNode = body.querySelector("#pt-soul-version");
  if (!preview || !soulArea) return;

  const nameOf = () => String(partner.name || "").trim() || "执事";
  let originalAvatar = partner.avatar || null;
  let originalSoul = String(initialSoul ?? "");
  let avatarDraft = originalAvatar;
  let soulDraft = originalSoul;
  let decoding = false;
  let saving = false;
  let decodeSeq = 0;

  // 模态关闭后 #modal-body 会被 replaceChildren 清空（节点本身还在 DOM 里），
  // 所以 alive() 不能只看 isConnected——要确认这个 textarea 自己还在文档里。
  const alive = () => soulArea.isConnected && body.isConnected;
  const isDirty = () => avatarDraft !== originalAvatar || soulDraft !== originalSoul;

  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", Boolean(isError && text));
  };

  const paint = () => {
    paintAvatar(preview, avatarDraft, nameOf());
    preview.classList.toggle("has-image", Boolean(avatarDraft));
    if (caption) {
      caption.textContent = avatarDraft
        ? "点头像换一张：30 张预设或本地图片"
        : "还没有头像，点头像选一张（预设或本地文件）";
    }
  };

  const refresh = () => {
    const dirty = isDirty();
    save.disabled = saving || decoding || !dirty || !soulDraft.trim();
    reset.disabled = saving || decoding || !dirty;
    preview.disabled = saving;
    soulArea.disabled = saving;
  };

  paint();
  refresh();

  // 本地选图 input：常驻在弹窗 body 里（不进浮层）——浮层收起时会被移除，
  // 而系统文件框是异步的，change 必须落在还活着的节点上。
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.id = "pt-avatar-file";
  fileInput.accept = "image/png,image/jpeg,image/webp";
  fileInput.hidden = true;
  body.append(fileInput);
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ""; // 同一张图再选一次也能触发 change
    if (!file || saving || !alive()) return;
    const seq = ++decodeSeq;
    decoding = true;
    refresh();
    setHint("处理图片…");
    try {
      const dataUrl = await fileToAvatarPng(file);
      if (seq !== decodeSeq || !alive()) return; // 选 A 后清除 / 选 B：A 迟到就作废
      avatarDraft = dataUrl;
      paint();
      setHint("头像已选好，点「保存人设」生效。");
    } catch (error) {
      if (seq !== decodeSeq || !alive()) return;
      setHint(error.message || "这张图片不能用作头像", true);
    } finally {
      if (seq === decodeSeq) {
        decoding = false;
        if (alive()) refresh();
      }
    }
  });

  /* ── 头像：点按钮弹共用面板（与抽屉的人设页同一份实现，2026-11-07 抽出）── */
  preview.addEventListener("click", () => {
    if (saving || decoding || !alive()) return;
    openAvatarPanel({
      anchor: preview,
      current: avatarDraft,
      onPick: (dataUrl) => {
        avatarDraft = dataUrl;
        decodeSeq += 1;
        decoding = false;
        paint();
        refresh();
        setHint(dataUrl ? "头像已选好，点「保存人设」生效。" : "已改为不使用头像，保存后显示名字首字。");
      },
      onBusy: (busy, message) => {
        decoding = busy;
        if (message) setHint(message, true);
        if (alive()) refresh();
      },
    });
  });

  soulArea.addEventListener("input", () => {
    soulDraft = soulArea.value;
    clearModalHint(hint);
    refresh();
  });

  reset?.addEventListener("click", () => {
    if (saving || !alive()) return;
    decodeSeq += 1;
    decoding = false;
    avatarDraft = originalAvatar;
    soulDraft = originalSoul;
    soulArea.value = originalSoul;
    paint();
    setHint("");
    refresh();
    closeAvatarPanel();
  });

  save?.addEventListener("click", async () => {
    const nextSoul = soulArea.value;
    if (!nextSoul.trim()) {
      setHint("人设不能是空的。", true);
      soulArea.focus();
      return;
    }
    if (!isDirty() || saving || decoding || !alive()) return;
    saving = true;
    refresh();
    setHint("保存中…");
    const payload = {};
    if (nextSoul !== originalSoul) payload.soul = nextSoul;
    if (avatarDraft !== originalAvatar) payload.avatar = avatarDraft;
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (alive()) setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
        return;
      }
      // 保存成功后把基准推进到服务端回读值：再点保存不会重复提交同样的内容
      partner.avatar = data.partner?.avatar ?? null;
      const cached = state.partners.find((item) => item.id === partnerId);
      if (cached) cached.avatar = partner.avatar;
      // 缓存同步：侧栏（展开 + 轨道）与设置页都从 state.partners 取头像
      syncChiefAvatar();
      void loadRoster();
      void loadPartners();
      if (!alive()) return;
      const nextVersion = data.soulVersion ?? soulVersion;
      if (versionNode && nextVersion != null) versionNode.textContent = `人设 v${nextVersion}`;
      setHint(data.soulVersion != null ? `已保存为 v${data.soulVersion}，下一轮起用。` : "已保存。");
      // 用回读值重设基准：把「刚保存的内容」当成新的 original
      avatarDraft = partner.avatar;
      soulDraft = nextSoul;
      paint();
      body.querySelector("#pt-soul")?.blur();
      setOriginal(partner.avatar, nextSoul);
    } catch (error) {
      if (alive() && error.message !== "forbidden") setHint(`没存成：${error.message}`, true);
    } finally {
      saving = false;
      if (alive()) refresh();
    }
  });

  /** 保存成功后的新基准（闭包内两个 let 不能从外部改，走这一层） */
  function setOriginal(nextAvatar, nextSoul) {
    originalAvatar = nextAvatar;
    originalSoul = nextSoul;
    refresh();
  }

  /** 关窗即清场：共用面板挂在 body 里，模态一关就一起摘掉 */
  const observer = new MutationObserver(() => {
    if (!alive()) {
      closeAvatarPanel();
      observer.disconnect();
    }
  });
  observer.observe(body, { childList: true });
}

async function ptSaveName(partnerId, input) {
  const name = input.value.trim();
  if (!name) { toast("名字不能为空"); return; }
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { toast(`没改名：${data.message || data.error || response.status}`); return; }
    toast("名字已保存");
    void loadPartners();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没改名：${error.message}`);
  }
}

export { INSTR_PRESET_GROUPS, closeAvatarPanel, openAvatarPanel, ptSaveName, ptWireInstructionEditor };
