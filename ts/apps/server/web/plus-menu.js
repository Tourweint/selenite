/**
 * composer 加号菜单
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { addBrowserFiles, addImageFiles, captureScreenshot, clearPendingAttachments, closeLightbox, pickFiles } from "./attachments.js";
import { startNewChat } from "./chat-open.js";
// 会话画板（2026-11-17）：能力投影决定顶栏入口挂不挂；这里只做一次同步
import { syncChatMapEntry } from "./chat-map.js";
// 工作归属标签（2026-11-18）：能力投影关着时收起输入框左下角的只读标签
import { syncChatProjectPill } from "./chat-project.js";
import { syncEditEntry } from "./chat-thread.js";
import { busyWhenSteerDefault, followUp, send, syncSendEnabled } from "./composer-send.js";
import { el } from "./dom.js";
import { closeGroupSettingsDrawer, groupSettingsOpen } from "./groups-settings.js";
import { closeModelMenu } from "./hover-tip.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { closeProjectMenu, setModalHint } from "./project-modal.js";
import { closeRailCards } from "./rail-card.js";
import { currentRoute, currentTicketId, go, groupRouteId } from "./route.js";
import { closeChatSettings, csResolveTarget } from "./settings-drawer.js";
import { closeMenu, toggleSidebar } from "./shell.js";
import { refreshSkillSuggest } from "./skill-picker.js";
import { closeSkillSelects } from "./skills-list.js";
import { state } from "./state.js";
import { isTaskConversation } from "./task-thread.js";
import { KEY_SEND } from "./theme.js";
import { steerIntoTurn } from "./turn-reconcile.js";
import { closeModal, closePopover, modalOpen, openModal, openPopover, popoverOpen, toast } from "./ui-atoms.js";

/* ── 加号菜单（2026-11-13，抄 ZCode/cindy 的 composer「+」）────────────
   菜单项按能力现渲染：截图只在 getDisplayMedia 存在时出现；「新建目标」只在有执事身份
   （总管 / 执事会话）时出现，普通助手会话没有目标位。菜单向上弹，复用 composer-pop 动效。 */

const PLUS_ICONS = {
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  target:
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
};

function plusMenuItem(icon, label, onClick, tip = "") {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "plus-item";
  item.setAttribute("role", "menuitem");
  if (tip) item.setAttribute("data-tip", tip);
  item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span></span>`;
  item.querySelector("span").textContent = label;
  item.addEventListener("click", onClick);
  return item;
}

function renderPlusMenu() {
  const menu = el.composerPlusMenu;
  if (!menu) return;
  menu.replaceChildren();
  menu.append(
    plusMenuItem(PLUS_ICONS.file, "添加图片或文件", () => {
      closePlusMenu();
      void pickFiles();
    }, "支持图片和常见文档；也可以把文件直接拖进输入框"),
  );
  if (navigator.mediaDevices?.getDisplayMedia) {
    menu.append(
      plusMenuItem(PLUS_ICONS.monitor, "截图", () => {
        closePlusMenu();
        void captureScreenshot();
      }, "选一块屏幕区域截图；截完自动附到这条消息"),
    );
  }
  if (csResolveTarget()) {
    const sep = document.createElement("div");
    sep.className = "plus-sep";
    menu.append(sep);
    menu.append(
      plusMenuItem(PLUS_ICONS.target, "新建目标", () => {
        closePlusMenu();
        void openGoalDialog();
      }, "在项目里新建一个目标；后续派活、进度和结果都记在它下面"),
    );
  }
}

function closePlusMenu() {
  if (el.composerPlusMenu) closePopover(el.composerPlusMenu, el.composerAdd);
}

function togglePlusMenu() {
  if (popoverOpen(el.composerPlusMenu)) {
    closePlusMenu();
    return;
  }
  if (!state.capabilities.attachments) {
    toast("附件已在服务端关闭（AGENT_ATTACHMENTS=false）");
    return;
  }
  renderPlusMenu();
  openPopover(el.composerPlusMenu, el.composerAdd);
}

/** 新建目标（抄 cindy：+ → 新建目标，输入框里已有的文字作默认目标）。 */
async function openGoalDialog() {
  const target = csResolveTarget();
  if (!target) {
    toast("普通助手会话没有目标位，到总管或执事会话里设");
    return;
  }
  let current = "";
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(target)}`, {
      cache: "no-store",
    });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      current = String(data.currentGoal || "");
    }
  } catch {
    // 读不到就按空目标打开；保存仍走同一个 PATCH
  }
  const draft = el.input.value.trim();
  const owner =
    state.partners.find((item) => item.id === target)?.name ||
    (target === "chief" ? "总管" : "这个执事");

  openModal("新建目标", (body) => {
    body.innerHTML = `
      <p class="modal-desc">写给「${esc(owner)}」这一阵要奔的方向。保存后每轮都会带上，下一轮起生效。</p>
      <div class="modal-field">
        <span>目标</span>
        <textarea class="modal-input" id="goal-input" rows="4" maxlength="1000"
                  style="height:auto;min-height:96px;padding:10px;line-height:1.6;resize:vertical"
                  placeholder="例：这个月把日记 v2 的提醒链路跑通，先不碰其他需求。"></textarea>
      </div>
      <p class="modal-hint" id="goal-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="ghost" type="button" id="goal-clear">清除目标</button>
        <button class="modal-primary" type="button" id="goal-save">保存</button>
      </div>`;

    const input = body.querySelector("#goal-input");
    const hint = body.querySelector("#goal-hint");
    const save = body.querySelector("#goal-save");
    const clear = body.querySelector("#goal-clear");
    input.value = current || draft;
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    const submit = async (goal) => {
      if (save.disabled) return;
      save.disabled = true;
      clear.disabled = true;
      hint.classList.remove("is-error");
      hint.textContent = "保存中…";
      try {
        const response = await request(`/api/v1/partners/${encodeURIComponent(target)}`, {
          method: "PATCH",
          body: JSON.stringify({ currentGoal: goal || null }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, data.message || data.error || `没存成：HTTP ${response.status}`);
          save.disabled = false;
          clear.disabled = false;
          return;
        }
        // 目标来自输入框草稿且保存成功：把草稿清掉，别让它连着下一句一起发出去
        if (!current && draft && goal) {
          el.input.value = "";
          resize();
          syncSendEnabled();
        }
        const cached = state.partners.find((item) => item.id === target);
        if (cached) cached.currentGoal = data.currentGoal ?? goal ?? null;
        closeModal();
        toast(goal ? "目标已保存，下一轮起生效" : "目标已清除");
      } catch (error) {
        if (error.message === "forbidden") return;
        setModalHint(hint, `没存成：${error.message}`);
        save.disabled = false;
        clear.disabled = false;
      }
    };

    save.addEventListener("click", () => void submit(input.value.trim()));
    clear.addEventListener("click", () => void submit(""));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void submit(input.value.trim());
      }
    });
  });
}

el.composerAdd?.addEventListener("click", () => togglePlusMenu());

el.composerFile?.addEventListener("change", () => {
  const files = el.composerFile.files ? [...el.composerFile.files] : [];
  el.composerFile.value = "";
  void addBrowserFiles(files);
});

// 粘贴图片：输入框里 Ctrl+V 直接进待发条（截图文是最常用的入口；只有这一条路内联）
el.input.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  if (!files.length) return;
  event.preventDefault();
  void addImageFiles(files);
});

// 拖拽：整个 composer 是投放区（只拦 dragover 才收得到 drop）；拖入按「选文件」处理 → 上传
el.composer.addEventListener("dragover", (event) => {
  if (!state.capabilities.attachments) return;
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
el.composer.addEventListener("drop", (event) => {
  if (!state.capabilities.attachments) return;
  const files = event.dataTransfer?.files ? [...event.dataTransfer.files] : [];
  if (!files.length) return;
  event.preventDefault();
  void addBrowserFiles(files);
});

/**
 * 能力投影（2026-11-08 4a）：GET /agent/policy 顺带带回 `attachments` / `editResend`。
 * 关着就把入口**收掉**（而不是点了再报错）；拉不到按默认开处理，不因为一次网络抖动
 * 把功能藏起来。
 *
 * 2026-11-08 扫尾批 8c：顺带读审批形态（`approvalMode`）。`blocking` = 旧的 120s 阻塞，
 * 卡片保留倒计时；缺省 `async` = 等待态落库，卡片显示「等待处理」、不显示倒计时。
 */
async function loadCapabilities() {
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    state.capabilities.attachments = data.attachments !== false;
    // 2026-11-13：任意文件（路径引用）与浏览器上传入口；关着时只剩图片内联
    state.capabilities.fileAttachments = data.fileAttachments !== false;
    state.capabilities.editResend = data.editResend !== false;
    state.capabilities.approvalMode = data.approvalMode === "blocking" ? "blocking" : "async";
    // 会话画板（2026-11-17）：缺字段按开处理（老服务端不挡）
    state.capabilities.chatMap = data.chatMap !== false;
    // 工作归属标签（2026-11-18）：缺字段按开处理
    state.capabilities.chatProjectLabel = data.chatProjectLabel !== false;
  } catch {
    return;
  }
  syncChatMapEntry();
  syncChatProjectPill();
  if (el.composerAdd) el.composerAdd.hidden = !state.capabilities.attachments;
  // 文件附件关着：选择器退回只认图片（老行为），不让用户选完才报错
  if (el.composerFile) {
    if (state.capabilities.fileAttachments) el.composerFile.removeAttribute("accept");
    else el.composerFile.setAttribute("accept", "image/*");
  }
  if (!state.capabilities.attachments) clearPendingAttachments();
  syncEditEntry();
}

// pill 在右组（D2），不能再用 .composer-tools 判内外：按触发 pill 和菜单自己判
document.addEventListener("click", (event) => {
  if (!event.target.closest("#model-pill") && !event.target.closest("#model-menu")) closeModelMenu();
  // 加号菜单（2026-11-13）：触发钮和菜单自己都算里面，点外面才收
  if (!event.target.closest("#composer-add") && !event.target.closest("#composer-plus-menu")) {
    closePlusMenu();
  }
  // 抽屉主选模型弹层（2026-11-08）：点外收起（元素随抽屉重渲，每次现查现判）
  const csPick = document.getElementById("cs-primary-menu");
  if (csPick && !csPick.hidden && !event.target.closest(".cs-model-pick")) {
    closePopover(csPick, document.getElementById("cs-primary-trigger"));
  }
  // 设置 → 模型的「更换」弹层（2026-11-12）：触发钮与弹层同属 .mdl-wrap，
  // 点卡片/弹层里的任何位置都不收，点外面才收。
  const mdlMenu = document.getElementById("mdl-menu");
  if (mdlMenu && !mdlMenu.hidden && !event.target.closest(".mdl-wrap")) {
    closePopover(mdlMenu, document.getElementById("mdl-change"));
  }
  // 技能页筛选/排序下拉（2026-11-13 二轮）：点外面收
  if (!event.target.closest(".sk-select")) closeSkillSelects();
  // 项目弹层与轨道悬停卡：触发钮和卡片自己都算里面，点外才收（2026-11-13）
  if (
    !event.target.closest("#proj-pill") &&
    !event.target.closest("#rail-proj") &&
    !event.target.closest("#proj-menu")
  ) {
    closeProjectMenu();
  }
  // 轨道悬停卡：整个轨道 + 所有悬停卡都算里面。2026-11-13 轨道对齐后卡从两张变五张，
  // 原来只白名单 groups/partners 的写法会让点「对话 / 总管」时把刚开的卡立刻收掉。
  if (!event.target.closest("#side-rail") && !event.target.closest(".proj-pop")) {
    closeRailCards();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // 输入法豁免： composing 中 / keyCode 229（安卓输入法）的 Esc 不当关闭用
  if (event.isComposing || event.keyCode === 229) return;
  // 大图查看（2026-11-08）：它压在页面最上层，先关它
  if (el.lightbox && !el.lightbox.hidden) {
    event.stopImmediatePropagation();
    closeLightbox();
    return;
  }
  // 模态在最上层：先关它，别同时把下面的弹层/路由也收掉。
  // stopImmediatePropagation 是给 reduced-motion 的：没有动画时 modalOpen()
  // 立刻变 false，第二个全局 Esc 监听会以为是普通返回。
  if (modalOpen()) {
    event.stopImmediatePropagation();
    closeModal();
    return;
  }
  // 群设置抽屉压在群会话页上：先关抽屉，别把路由带回列表
  if (groupSettingsOpen()) {
    event.stopImmediatePropagation();
    closeGroupSettingsDrawer();
    return;
  }
  // 抽屉主选模型弹层开着：先收它，抽屉留着（同一优先级思路：先收最上层）
  const csPick = document.getElementById("cs-primary-menu");
  if (csPick && !csPick.hidden) {
    closePopover(csPick, document.getElementById("cs-primary-trigger"));
    return;
  }
  // 设置 → 模型的「更换」弹层同样先收（2026-11-12）
  const mdlMenu = document.getElementById("mdl-menu");
  if (mdlMenu && !mdlMenu.hidden) {
    closePopover(mdlMenu, document.getElementById("mdl-change"));
    return;
  }
  // 技能页筛选/排序下拉：先收它（在模型菜单之前，别同时收两层）
  if (document.querySelector(".sk-select-menu:not([hidden])")) {
    closeSkillSelects();
    return;
  }
  closeModelMenu();
  closePlusMenu();
  closeChatSettings();
  closeProjectMenu();
  closeRailCards();
});

/** 插话意图（2026-11-07 消息即引导）：keydown 置位、submit 消费一次。 */
let steerNextSubmit = false;

el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  // 插话意图先消费（2026-11-07 修）：放回 text 判空之后的话，Ctrl+Enter 对着
  // 空输入框按下时标志会残留，下一次普通发送就被误当成插话
  const steer = steerNextSubmit;
  steerNextSubmit = false;
  const text = el.input.value.trim();
  // 附件条（2026-11-08 4a 图片；2026-11-13 文件）：纯附件消息允许，判空要把两者都算进去
  const images = state.pendingImages.slice();
  const files = state.pendingFiles.slice();
  if (!text && !images.length && !files.length) return;
  // 手动压缩斜杠命令（扫尾批 1 B1）：只认 /compact 一个，刻意不做通用命令系统。
  // 命中后不作为消息发送、不进历史；剩余文字当作 instructions，wait=1 等结果。
  const compactMatch = /^\/compact\b/i.exec(text);
  if (compactMatch) {
    if (images.length || files.length) {
      toast("压缩命令不能带附件");
      return;
    }
    el.input.value = "";
    resize();
    void runCompactCommand(text.slice(compactMatch[0].length).trim());
    return;
  }
  // 忙时投递（2026-11-07 消息即引导；2026-11-19 插话统一改缺省）：
  //   默认（插件卡「忙时消息」开）= 插话，带 whenBusy=steer 直接投到正在跑的这一轮；
  //   插件卡切「排队」      = 旧行为，带 whenBusy=followUp 交给服务端落 durable（下一轮的指令）。
  //   Ctrl/⌘+Enter 保留不删：忙时显式指定插话（与默认档同义的快捷键）。
  // 两条都只走纯文本（附件只在空闲时发，附件先留在条上）。
  if (state.sending) {
    if (images.length || files.length) {
      toast("附件消息要等这一轮结束再发");
      return;
    }
    el.input.value = "";
    resize();
    void (async () => {
      // 插话意图（Ctrl/⌘+Enter）优先；普通 Enter 读插件卡档位（缺省插话）
      if (steer || (await busyWhenSteerDefault())) await steerIntoTurn(text);
      else await followUp(text);
    })();
    return;
  }
  // 任务线程先只收文字（2026-11-22）：附件不进池票面，也不伪造进专线。
  if (isTaskConversation(state.conversationId) && (images.length || files.length)) {
    toast("任务线程先只发文字");
    return;
  }
  el.input.value = "";
  resize();
  clearPendingAttachments();
  void send(text, images, files);
});

/** /compact（扫尾批 1 B1）：调手动压缩端点，等结果后用气泡（toast）提示。 */
async function runCompactCommand(instructions) {
  const conversationId = state.conversationId;
  if (!conversationId) {
    toast("先打开一条对话再压缩上下文");
    return;
  }
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/compact?wait=1`,
      { method: "POST", body: JSON.stringify({ instructions: instructions || undefined }) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(
        data?.reason === "llm_not_configured"
          ? "还没配置模型，压缩不可用"
          : data?.message || `压缩没成功：HTTP ${response.status}`,
      );
      return;
    }
    toast(data.waited === false ? "压缩已受理，仍在进行中" : "上下文已压缩");
  } catch (error) {
    if (error.message !== "forbidden") toast(`压缩没成功：${error.message}`);
  }
}

el.input.addEventListener("input", () => {
  resize();
  syncSendEnabled();
  // 技能斜杠选择器（2026-11-09）：输入「/xxx」时弹可用技能单
  void refreshSkillSuggest();
});

el.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  const modSend = localStorage.getItem(KEY_SEND) === "mod-enter";
  const withMod = event.metaKey || event.ctrlKey;
  // 插话快路（2026-11-07 消息即引导）：忙时 Ctrl/⌘+Enter **一律**是插话。
  // 它不受"发送快捷键"设置影响——那是"怎么把这句话变成一轮"的偏好，
  // 而插话是"把这句话塞进正在跑的那一轮"，两件事。
  // 这条必须排在前面的原因：Enter 模式下的发送条件是"不带修饰键"，
  // 若按那个条件判，带 Ctrl 的按键会被直接放行成换行，插话永远进不去（实测踩过）。
  if (state.sending && withMod && !event.shiftKey) {
    event.preventDefault();
    steerNextSubmit = true;
    el.composer.requestSubmit();
    return;
  }
  // Enter 模式：不带修饰键就发送（Shift 仍是换行）；Ctrl+Enter 模式：必须带修饰键。
  if (modSend ? withMod : !event.shiftKey && !withMod) {
    event.preventDefault();
    steerNextSubmit = false;
    el.composer.requestSubmit();
  }
});

// 全局快捷键：跟大多数桌面 Agent 一致
document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) {
    if (event.key === "Escape") {
      // 模态的 Esc 由上一处监听处理；这里别再顺手退回设置/任务页
      if (modalOpen()) return;
      if (!el.menuPop.hidden) closeMenu();
      else if (currentRoute() === "settings") go("chat");
      else if (currentRoute() === "search") go("chat");
      else if (currentRoute() === "domains") go("chat");
      else if (currentRoute() === "tasks") {
        // 详情先退回看板，再按一次才回对话；跟设置页的返回逻辑一致
        if (currentTicketId()) go("tasks");
        else go("chat");
      } else if (currentRoute() === "group") {
        // 群组两层：群会话先退到群列表，列表再按一次才回对话
        // （2026-11-07：顶栏返回键的 title 一直写着「返回对话 (Esc)」，
        //  但 Esc 根本没绑过；这里把承诺补上，语义与任务页逐字同构）。
        if (groupRouteId()) location.hash = "#/groups";
        else go("chat");
      }
    }
    return;
  }
  if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    go("chat");
    startNewChat("worker");
  } else if (event.key === ",") {
    event.preventDefault();
    go("settings");
  } else if (event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleSidebar();
  }
});

/** 输入栏学 ZCode（2026-11-11）：打字/换行/粘贴实时长高——原来只在发送清空后重算，
 *  打字过程中永远一行；上限交给 CSS 的 max-height: 200px，超出内部滚动。 */
function resize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 200)}px`;
}
el.input.addEventListener("input", resize);

/** 停止当前这一轮：人的明确意图（跟客户端断开是两回事） */
async function stopStreaming() {
  if (!state.conversationId) return;
  state.stopRequested = true;
  try {
    await request(`/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/stop`, {
      method: "POST",
    });
  } catch {
    /* 停不下来也别拦着用户 */
  }
}

// 流式时按钮是「停止」：拦下表单提交，改走停止接口
el.send.addEventListener("click", (event) => {
  if (!state.sending) return;
  event.preventDefault();
  void stopStreaming();
});

el.newChat?.addEventListener("click", () => {
  go("chat");
  startNewChat("worker");
});

// 代码块复制（批次一）：事件挂在 thread 上，消息增删不用重挂；
// 读 pre 的 innerText，流式中也能复制到当前最新的文本
el.thread.addEventListener("click", async (event) => {
  const button = event.target.closest(".code-copy");
  if (!button) return;
  const pre = button.parentElement?.querySelector("pre.code");
  if (!pre) return;
  try {
    await navigator.clipboard.writeText(pre.innerText);
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  setTimeout(() => {
    button.textContent = "复制";
  }, 1500);
});

export { PLUS_ICONS, closePlusMenu, loadCapabilities, openGoalDialog, plusMenuItem, renderPlusMenu, resize, runCompactCommand, steerNextSubmit, stopStreaming, togglePlusMenu };
