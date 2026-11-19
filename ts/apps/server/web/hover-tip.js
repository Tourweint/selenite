/**
 * 全局悬停提示
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { request } from "./net.js";
import { formatTokenCount } from "./providers.js";
import { KEY_MODEL_PROVIDER, KEY_THINKING, THINKING_LABELS, THINKING_LEVELS, clampThinking, currentThinking, setThinkingLevel } from "./shell.js";
import { state } from "./state.js";
import { closePopover, markNativePopupsBroken, nativePopupsReady, openPopover, popoverOpen, toast } from "./ui-atoms.js";

/* ── 全局悬停提示（2026-11-08，原「收起轨道 tooltip」泛化）──────────
 * 任何带 data-tip 的元素（轨道按钮 / 侧栏分区头 / 设置页标签 / 记忆组头…）
 * 悬停 ~450ms 后弹出小签，离开即收。12px 圆角、纯 opacity 进场、无箭头。
 * 挂 body 下（fixed 定位）：侧栏收起动画靠 overflow:hidden 裁内容，伪元素会被一起裁掉，
 * 设置页的分区滚动容器同理——fixed + body 挂载躲开一切裁切。
 *
 * 2026-11-14 统一口径：界面里所有原生 `title` 一律收编成 data-tip（`adoptTitleTip`）。
 * 之前 title 与 data-tip 混用，同一个元素会同时弹出浏览器默认小框和这枚浮签
 * （侧栏「群组」分区头就有 title + data-tip 两份）；现在 title 只当数据源读一次，
 * 读完即删，页面上只留一种提示。 */
const TIP_SHOW_DELAY_MS = 450;
// 指针按下后这段时间内的 focusin 算「点出来的焦点」，不弹提示（键盘 Tab 不会先有 pointerdown）。
// 2026-11-17 用户反馈：点击时小黑块会冒出来闪一下——点按钮会聚焦，focusin 分支把它当键盘聚焦了。
const POINTER_FOCUS_GUARD_MS = 600;
const hoverTipState = { timer: 0, anchor: null, x: null, y: null, pointerDownAt: 0, pressedAnchor: null, nativeShown: false };

/** 原生 title → data-tip（一次性收编）。
 *  - 手写的 data-tip 优先：title 只删不加，别覆盖更长的解释（分区头就是这种形状）。
 *  - 从 title 自动收编的提示打 `data-tip-auto` 标记：之后 JS 再改 `.title`
 *    （模型 pill、上下文环、归档按钮都是动态文案）会跟着更新，不会停在旧值。
 *  - 空 title（如发送键在空闲时 `title=""`）只清不建，避免留下一个空签。 */
function adoptTitleTip(node) {
  if (!node || typeof node.getAttribute !== "function" || !node.hasAttribute("title")) return false;
  const title = (node.getAttribute("title") || "").trim();
  const authored = node.hasAttribute("data-tip") && node.dataset.tipAuto !== "1";
  if (title && !authored) {
    node.setAttribute("data-tip", title);
    node.dataset.tipAuto = "1";
  } else if (!title && node.dataset.tipAuto === "1") {
    node.removeAttribute("data-tip");
    delete node.dataset.tipAuto;
  }
  node.removeAttribute("title");
  return true;
}

/** 启动时扫一遍静态 DOM；之后新渲染的节点在悬停/聚焦时按需收编，
 *  动态改 `.title` 由下面的属性观察器接住。 */
function adoptAllTitleTips(root = document.body) {
  if (!root) return 0;
  let count = 0;
  if (adoptTitleTip(root)) count += 1;
  for (const node of root.querySelectorAll?.("[title]") || []) {
    if (adoptTitleTip(node)) count += 1;
  }
  return count;
}

// 盯 title 属性的变化 + 新插入的子树：都是代码渲染那一刻的少量节点，
// 不会因为流式输出的文本追加而抖动（纯文本节点直接跳过）。
// 批次合并到一个微任务里跑：一次历史回读插几百个节点也只扫一遍。
let titleObserver = null;
let titleFlushQueued = false;
const titleInsertQueue = new Set();

function flushInsertedTitles() {
  titleFlushQueued = false;
  const batch = [...titleInsertQueue];
  titleInsertQueue.clear();
  for (const node of batch) {
    if (node.isConnected) adoptAllTitleTips(node);
  }
}

function watchTitleAttribute() {
  if (!document.body || typeof MutationObserver === "undefined") return;
  titleObserver?.disconnect();
  titleObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        adoptTitleTip(record.target);
        continue;
      }
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1) continue;
        titleInsertQueue.add(added);
      }
    }
    if (titleInsertQueue.size && !titleFlushQueued) {
      titleFlushQueued = true;
      queueMicrotask(flushInsertedTitles);
    }
  });
  titleObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["title"],
    childList: true,
    subtree: true,
  });
}

function hideHoverTip() {
  clearTimeout(hoverTipState.timer);
  hoverTipState.timer = 0;
  hoverTipState.anchor = null;
  hoverTipState.x = null;
  hoverTipState.y = null;
  // 原生提示还开着就收壳那枚（2026-11-19 批1）；scroll/resize 高频收口也走这里
  if (hoverTipState.nativeShown) {
    hoverTipState.nativeShown = false;
    shellHideTip();
  }
  if (el.hoverTip) el.hoverTip.hidden = true;
}

/** 让壳收提示：火后不理，失败不打扰（探测过的壳才会走到这）。 */
function shellHideTip() {
  const bridge = window.mygo;
  if (typeof bridge?.call !== "function") return;
  try {
    const result = bridge.call.call(bridge, "Shell.HideTip");
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch { /* 桥不在：随它 */ }
}

/** 让壳画提示（desktop/popovers.go 的 flyout）：true=壳接了。
 *  锚点口径与 web 定位算法一致——有鼠标落点贴光标（零尺寸矩形），键盘聚焦
 *  贴元素矩形；翻转、夹边、伸出窗口边缘都是壳的事（2026-11-16 的落点反馈
 *  在原生侧同口径成立）。 */
function shellShowTip(target, text) {
  const bridge = window.mygo;
  if (typeof bridge?.call !== "function") return false;
  const box = target.getBoundingClientRect();
  const anchor = Number.isFinite(hoverTipState.x) && Number.isFinite(hoverTipState.y)
    ? { x: Math.round(hoverTipState.x), y: Math.round(hoverTipState.y), width: 0, height: 0 }
    : { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
  try {
    const result = bridge.call.call(bridge, "Shell.ShowTip", { anchor, tip: text });
    if (result && typeof result.catch === "function") {
      result.catch(() => markNativePopupsBroken());
    }
    return true;
  } catch {
    return false;
  }
}

function showHoverTip(target) {
  if (!target) return;
  // 定时器等待的 450ms 里节点可能被重渲染摘掉；用脱链节点量出来的是 0,0，
  // 提示就会飘到屏幕左上角——直接不出。
  if (target.isConnected === false) return;
  const text = target.getAttribute("data-tip");
  if (!text) return;
  // 展开态轨道整体 pointer-events:none；键盘 Tab 进来时也别弹一个看不见的提示
  const rail = target.closest(".side-rail");
  if (rail && getComputedStyle(rail).pointerEvents === "none") return;
  hoverTipState.anchor = target;
  // 原生弹出层（2026-11-19 批1）：壳里画 flyout，页面不再建 DOM 小黑签。
  // 不依赖 el.hoverTip 存在——原生路不需要 DOM 签。
  // 探测说有但调用没成（老壳刚被换回、开关刚翻走）就粘性回 DOM 路。
  if (nativePopupsReady() && shellShowTip(target, text)) {
    hoverTipState.nativeShown = true;
    return;
  }
  const tipEl = el.hoverTip;
  if (!tipEl) return;
  tipEl.textContent = text;
  tipEl.hidden = false;
  const tipBox = tipEl.getBoundingClientRect();
  const gap = 10;
  let top;
  let left;
  if (Number.isFinite(hoverTipState.x) && Number.isFinite(hoverTipState.y)) {
    // 2026-11-16 用户反馈：提示有时离文字很远。宽行/整卡的左缘可能和鼠标停的字隔着半屏，
    // 所以有鼠标坐标时贴着落点走，不再拿元素的左缘当锚。
    left = hoverTipState.x - 2;
    top = hoverTipState.y - tipBox.height - gap;
    if (top < 8) top = hoverTipState.y + 18;
    if (left + tipBox.width > window.innerWidth - 8) left = window.innerWidth - 8 - tipBox.width;
  } else {
    // 键盘聚焦没有鼠标落点：退回元素矩形（旧行为）
    const box = target.getBoundingClientRect();
    top = box.top - tipBox.height - gap;
    if (top < 8) top = box.bottom + gap;
    left = box.left;
    if (left + tipBox.width > window.innerWidth - 8) left = window.innerWidth - 8 - tipBox.width;
  }
  tipEl.style.left = `${Math.round(Math.max(8, left))}px`;
  tipEl.style.top = `${Math.round(Math.max(8, top))}px`;
}

document.addEventListener("mouseover", (event) => {
  // 先把这一支上最近的原生 title 收编：浏览器默认小框和浮签不能同时出现
  adoptTitleTip(event.target.closest?.("[title]"));
  // 指针已经离开「刚点过」的元素：解除抑制，回到普通悬停
  const pressed = hoverTipState.pressedAnchor;
  if (pressed && (!pressed.isConnected || !pressed.contains(event.target))) {
    hoverTipState.pressedAnchor = null;
  }
  const target = event.target.closest?.("[data-tip]");
  if (!target) return;
  // 同一元素里从一段文字挪到另一段时也更新落点，提示才不会停在进入元素时的位置
  hoverTipState.x = event.clientX;
  hoverTipState.y = event.clientY;
  // 点过的元素，指针离开前不再弹：点击的目的是操作，不是读解释。
  // 否则点完鼠标还停在原处，轻微挪动会重新起 450ms 计时，提示又自己冒出来。
  if (hoverTipState.pressedAnchor) {
    clearTimeout(hoverTipState.timer);
    hoverTipState.timer = 0;
    return;
  }
  if (target === hoverTipState.anchor) return;
  clearTimeout(hoverTipState.timer);
  hoverTipState.timer = setTimeout(() => showHoverTip(target), TIP_SHOW_DELAY_MS);
});
document.addEventListener("mouseout", (event) => {
  // 指针彻底离开按下的元素（或移出窗口）：解除抑制
  const pressed = hoverTipState.pressedAnchor;
  if (pressed && (!event.relatedTarget || !pressed.contains(event.relatedTarget))) {
    hoverTipState.pressedAnchor = null;
  }
  const target = event.target.closest?.("[data-tip]");
  if (!target) return;
  // 同一元素内部挪动（穿过 svg/文字）不算离开
  if (event.relatedTarget && target.contains(event.relatedTarget)) return;
  hideHoverTip();
});
/* 指针按下就收（2026-11-17）：原来只收在 click 上，但 mousedown 的默认动作会先给按钮
 * 聚焦，focusin 的「键盘可达」分支立刻弹提示，按住到松开之间就闪一下。
 * 这里同时记住按下的是哪个提示元素：点完指针常还停在原地，离开它之前不再弹。 */
document.addEventListener("pointerdown", (event) => {
  hoverTipState.pointerDownAt = Date.now();
  hoverTipState.pressedAnchor = event.target instanceof Element ? event.target.closest("[data-tip]") : null;
  hideHoverTip();
}, true);
// 右键菜单弹出的同一刻也收（pointerdown 已收一次，这里是兜底：部分场景只来 contextmenu）
document.addEventListener("contextmenu", hideHoverTip);
// 键盘可达：Tab 聚焦立即出（不等延迟），移走即收。
// 鼠标/触屏点出来的焦点不走这条，判据是刚发生过 pointerdown。
document.addEventListener("focusin", (event) => {
  adoptTitleTip(event.target.closest?.("[title]"));
  if (Date.now() - hoverTipState.pointerDownAt < POINTER_FOCUS_GUARD_MS) return;
  const target = event.target.closest?.("[data-tip]");
  if (target && target !== hoverTipState.anchor) {
    // 键盘聚焦没有鼠标落点，别沿用上一次悬停的位置
    hoverTipState.x = null;
    hoverTipState.y = null;
    showHoverTip(target);
  }
});
document.addEventListener("focusout", hideHoverTip);
// 点了就走：别让提示压在刚打开的弹层/新页面上面；滚动/缩放时锚点已经不对了，直接收
document.addEventListener("click", hideHoverTip);
window.addEventListener("resize", hideHoverTip);
window.addEventListener("scroll", hideHoverTip, true);

async function fetchModelCatalog() {
  const response = await request("/api/v1/agent/model", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** pill 文字：只留模型名（2026-11-13 用户口径：供应商不必显示，思考档也不再挂小点） */
function modelLabel(catalog) {
  const current = catalog && catalog.current;
  if (!current) return "未配置模型";
  return current.modelId;
}

/** 完整标签（供应商 + 模型）：只给悬停 title / 提示用，不进 pill 文字 */
function modelFullLabel(catalog) {
  const current = catalog && catalog.current;
  if (!current) return "未配置模型";
  const provider = (catalog.providers || []).find((item) => item.id === current.providerId);
  return `${provider ? provider.name : current.providerId} · ${current.modelId}`;
}

/** pill 文字滚动（2026-11-05，ZCode RollingToolbarLabel 同拍 200ms）：
 *  换模型时旧字向上滚出淡去、新字从下方滚入。外层 span 是裁切罩
 *  （沿用 .composer-pill > span 的 overflow），真正动的是内层 .pill-label-text。
 *  文字没变（例行刷新）不播。 */
function setModelPillLabel(text) {
  const wrap = el.modelPillLabel;
  if (!wrap) return;
  const current = wrap.querySelector(".pill-label-text");
  if ((current ? current.textContent : wrap.textContent) === text) return;
  const enter = document.createElement("span");
  enter.className = "pill-label-text";
  enter.textContent = text;
  if (!current || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    wrap.replaceChildren(enter);
    return;
  }
  const exit = document.createElement("span");
  exit.className = "pill-label-text pill-label-exit";
  exit.setAttribute("aria-hidden", "true");
  exit.textContent = current.textContent;
  enter.classList.add("pill-label-enter");
  wrap.replaceChildren(enter, exit);
  // 播完归位：enter 摘掉动画类，exit 拆走；定时器兜底 animationend 丢失
  const clean = () => {
    enter.classList.remove("pill-label-enter");
    exit.remove();
  };
  enter.addEventListener("animationend", clean, { once: true });
  setTimeout(() => { if (exit.isConnected) clean(); }, 300);
}

function updateModelPill(catalog = state.modelCatalog) {
  if (!el.modelPillLabel) return;
  setModelPillLabel(modelLabel(catalog));
  if (el.modelPill) {
    // 2026-11-14：全站悬停提示统一走 data-tip；这里仍写 title 会被收编器转过去，
    // 但直接写 data-tip 更明确，也不再依赖收编时序。
    if (catalog && catalog.current) {
      el.modelPill.setAttribute(
        "data-tip",
        `当前：${modelFullLabel(catalog)} · 思考强度：${THINKING_LABELS[currentThinking()] || "关"}（点击切换，下一轮生效）`,
      );
    } else {
      el.modelPill.setAttribute("data-tip", "还没有可用的模型");
    }
  }
}

async function refreshModelPill() {
  try {
    state.modelCatalog = await fetchModelCatalog();
    updateModelPill();
  } catch (error) {
    if (error.message !== "forbidden") updateModelPill(null);
  }
}

function closeModelMenu() {
  if (!el.modelMenu) return;
  closePopover(el.modelMenu, el.modelPill);
}

/** 模型行兼容两种形状：新的 `{id, thinkingLevels}` 与旧的裸字符串（后端未上线时兜底） */
function normalizeModelRow(row) {
  if (typeof row === "string") {
    return { id: row, thinkingLevels: ["off", "low", "high"], contextWindow: null, maxTokens: null };
  }
  if (!row || typeof row.id !== "string") return null;
  const declared = Array.isArray(row.thinkingLevels) ? row.thinkingLevels : [];
  const levels = THINKING_LEVELS.filter((level) => declared.includes(level));
  return {
    id: row.id,
    thinkingLevels: levels.length ? levels : ["off", "low", "high"],
    contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : null,
    maxTokens: Number.isFinite(row.maxTokens) ? row.maxTokens : null,
  };
}

/** 菜单里能上分段行的供应商：凡有模型的都上（2026-11-05）。
 *  没 key 的段照常显示，沿用「缺 env」徽标；点它的模型也能切（服务端允许），
 *  成功后 toast 提醒去环境里补 key。全家都 keyless 时菜单照样能看。 */
function menuProviders(catalog) {
  return (catalog.providers || []).filter(
    (provider) => Array.isArray(provider.models) && provider.models.length > 0,
  );
}

/** 打开时的落点：当前供应商 > 上次看的 > 第一家；点段则钉在点的那家 */
function resolveMenuProvider(catalog, providers, preferredId) {
  const currentId = (catalog.current && catalog.current.providerId) || "";
  const wanted = preferredId || currentId || localStorage.getItem(KEY_MODEL_PROVIDER) || "";
  return providers.find((provider) => provider.id === wanted) || providers[0];
}

function renderModelMenu(catalog, preferredProviderId, menu = el.modelMenu) {
  if (!menu) return;
  menu.replaceChildren();  const current = catalog.current || null;
  const providers = menuProviders(catalog);
  if (!providers.length) {
    const row = document.createElement("div");
    row.className = "model-menu-empty";
    row.textContent = "还没有可选模型：到设置 → 模型里添加供应商";
    menu.append(row);
    return;
  }
  const active = resolveMenuProvider(catalog, providers, preferredProviderId);

  // 供应商分段（D2）：一次只看一家，点段只换筛、不发请求；没有「全部」段
  const rail = document.createElement("div");
  rail.className = "provider-seg";
  rail.setAttribute("role", "group");
  rail.setAttribute("aria-label", "供应商");
  for (const provider of providers) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "provider-opt";
    opt.dataset.provider = provider.id;
    opt.setAttribute("aria-pressed", String(provider.id === active.id));
    opt.setAttribute("data-tip", provider.name || provider.id);
    const name = document.createElement("span");
    name.textContent = provider.name || provider.id;
    opt.append(name);
    if (!provider.hasKey) {
      const badge = document.createElement("span");
      badge.className = "model-menu-warn";
      badge.textContent = "缺 env";
      opt.append(badge);
    }
    opt.addEventListener("click", () => {
      if (provider.id === active.id) return;
      localStorage.setItem(KEY_MODEL_PROVIDER, provider.id);
      renderModelMenu(catalog, provider.id, menu);
      // 重渲染换掉了刚点的按钮：焦点跟到新段上，键盘 Tab 还能继续走
      menu.querySelector('.provider-opt[aria-pressed="true"]')?.focus();
      // 宿主（对话快捷设置面板）靠这个事件同步「加到：某家」标签；模型菜单无人监听，无害
      menu.dispatchEvent(new CustomEvent("providerchange", { bubbles: true }));
    });
    rail.append(opt);
  }
  menu.append(rail);

  // 只列这一家的模型：分组头省了，段上已经写明是哪家
  for (const raw of active.models) {
    const model = normalizeModelRow(raw);
    if (!model) continue;
    const selected = Boolean(current && current.providerId === active.id && current.modelId === model.id);

    // 行 = 模型名（可点）；思考强度不再挂在行里，统一进菜单底部的常驻条
    const row = document.createElement("div");
    row.className = "model-row";
    // 统一写 "1"/"0"：CSS 当前行样式与 syncThinkingSegments / 焦点回位选择器都按 "1" 找
    // （原来写 "true"/"false"，那两处从来没命中过）
    row.dataset.current = selected ? "1" : "0";
    row.setAttribute("role", "none");

    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-item";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(Boolean(selected)));
    const contextText = model.contextWindow ? formatTokenCount(model.contextWindow) : "";
    item.setAttribute(
      "data-tip",
      `${active.name || active.id} · ${model.id}${contextText ? ` · ${contextText} 上下文` : ""}`,
    );
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = model.id;
    item.append(name);
    if (contextText) {
      const meta = document.createElement("span");
      meta.className = "model-meta";
      meta.textContent = `上下文 ${contextText}`;
      item.append(meta);
    }
    // 选中行不放 ✓（2026-11-05 用户口径，同 cindy UnifiedModelRow 的裁决）：
    // 选中态已有强调色 + 加粗，再挂勾是重复信号
    // 选中后菜单不关：就地重渲染，档位分段跟着当前模型刷新（D2 的「先选模型再选强度」）
    item.addEventListener("click", () => {
      void chooseModel(active, model.id, model.thinkingLevels, { keepOpen: true, menu });
    });
    row.append(item);
    menu.append(row);
  }

  /* 思考强度（2026-11-14 用户口径：选模型时一定要在这个界面看得见）。
   * 原来分段只挂在「当前模型那一行」里，浏览别家供应商时整块消失，只剩四个没有标题的
   * 小按钮；现在改成菜单底部常驻一条，带「思考强度」标签、跟着当前模型的支持域重建。
   * 位置 sticky 贴底：模型再多也不用滚到底才看得见。设置页的「更换」弹层仍标
   * data-no-thinking（那里只换默认模型，思考强度是会话级偏好），不进这条。 */
  const foot = thinkingFoot(catalog, menu);
  if (foot) {
    // 常驻条是 sticky 覆盖在滚动口底部的：末尾垫一段等高空白，最后一行才能滚到
    // 条上方，不会被永久裁掉半行（2026-11-14 实测 7 行时最后一行的下沿被压住）。
    const spacer = document.createElement("div");
    spacer.className = "think-spacer";
    spacer.setAttribute("aria-hidden", "true");
    spacer.hidden = true;
    menu.append(spacer, foot);
    scheduleThinkSpacerSync(menu);
  }
}

/** 只有内容真的溢出时才给末尾留白：短菜单不摆一截空档。
 *  先量「没有 spacer」时是否溢出，再决定显不显示，避免 spacer 自己把高度撑出溢出。 */
function syncThinkSpacer(menu) {
  const spacer = menu?.querySelector?.(".think-spacer");
  if (!spacer || !menu.getClientRects().length) return;
  spacer.hidden = true;
  const overflow = menu.scrollHeight > menu.clientHeight + 1;
  spacer.hidden = !overflow;
}

function scheduleThinkSpacerSync(menu) {
  if (!menu || menu.hidden) return;
  requestAnimationFrame(() => syncThinkSpacer(menu));
}

/** 当前模型在整份目录里的行：浏览别家供应商时，档位仍按当前模型的支持域画 */
function findCatalogModel(catalog, current) {
  if (!current) return null;
  for (const provider of catalog.providers || []) {
    for (const raw of provider.models || []) {
      const model = normalizeModelRow(raw);
      if (model && model.id === current.modelId) return model;
    }
  }
  return null;
}

/** 菜单底部的常驻档位条；只有「能调」的模型才出现（单档 / 无档不摆假按钮） */
function thinkingFoot(catalog, menu) {
  if (!menu || menu.dataset.noThinking === "1") return null;
  const model = findCatalogModel(catalog, catalog.current);
  const levels = model && Array.isArray(model.thinkingLevels) ? model.thinkingLevels : [];
  if (levels.length < 2) return null;
  const level = currentThinking();

  const foot = document.createElement("div");
  foot.className = "think-foot";
  foot.setAttribute("role", "group");
  foot.setAttribute("aria-label", "思考强度");

  const label = document.createElement("span");
  label.className = "think-foot-label";
  label.textContent = "思考强度";
  label.setAttribute(
    "data-tip",
    "只作用于当前会话：关 = 直接答；低 / 中 / 高 = 让模型多想几步。改完下一轮生效。",
  );

  const seg = document.createElement("div");
  seg.className = "think-seg";
  for (const optionLevel of levels) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "think-opt";
    option.dataset.level = optionLevel;
    option.textContent = THINKING_LABELS[optionLevel];
    option.setAttribute("aria-pressed", String(level === optionLevel));
    option.addEventListener("click", () => void chooseCurrentThinking(optionLevel));
    seg.append(option);
  }
  foot.append(label, seg);
  return foot;
}

async function toggleModelMenu() {
  if (!el.modelMenu) return;
  if (popoverOpen(el.modelMenu)) {
    closeModelMenu();
    return;
  }
  el.modelPill.disabled = true;
  try {
    // 每次打开都现拉：不缓存陈旧目录（审查 S2）
    const catalog = await fetchModelCatalog();
    state.modelCatalog = catalog;
    updateModelPill();
    renderModelMenu(catalog);
    openPopover(el.modelMenu, el.modelPill);
    scheduleThinkSpacerSync(el.modelMenu);
  } catch (error) {
    if (error.message !== "forbidden") toast("拿不到模型清单");
  } finally {
    el.modelPill.disabled = false;
  }
}

async function chooseModel(provider, modelId, levels, { keepOpen = false, menu = null } = {}) {
  if (!keepOpen) closeModelMenu();
  try {
    const response = await request("/api/v1/agent/model", {
      method: "POST",
      body: JSON.stringify({ providerId: provider.id, modelId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(`没切成：${data.message || data.error || `HTTP ${response.status}`}`);
      return false;
    }
    const providerId = data.provider || provider.id;
    state.modelCatalog = {
      ...(state.modelCatalog || {}),
      current: { providerId, modelId: data.model || modelId },
    };
    // 服务端换模型会把不支持的档位落回 ≤ 当前档（off 兜底），本地跟着对齐。
    // levels 缺省（模型不在清单里、支持域未知）就不动本地档——宁可保留也不静默清成 off
    if (Array.isArray(levels) && levels.length) {
      localStorage.setItem(KEY_THINKING, clampThinking(currentThinking(), levels));
    }
    updateModelPill();
    // 菜单没关就就地重渲染：✓ 挪到新行、档位分段出现（D2：先选模型再选强度）
    const host = menu || el.modelMenu;
    if (keepOpen && host) {
      renderModelMenu(state.modelCatalog, providerId, host);
      // 重渲染把刚点的按钮换掉了：焦点跟到新行，键盘 Tab 能直接进档位
      host.querySelector('.model-row[data-current="1"] .model-item')?.focus();
    }
    // 宿主同步钩子（2026-11-08）：抽屉主选的触发钮靠 modelchange 把名字跟上去
    host?.dispatchEvent(new CustomEvent("modelchange", { bubbles: true }));
    toast(
      provider.hasKey === false
        ? "已切换；该供应商缺 API Key，聊天前请在服务端环境设置对应变量"
        : `下一轮起用 ${provider.name || providerId} · ${modelId}`,
    );
    return true;
  } catch (error) {
    if (error.message !== "forbidden") toast(`没切成：${error.message}`);
    return false;
  }
}

/** 当前模型换档：菜单不关，选中态就地刷新；pill 的悬停文案跟着改（别停在旧档位） */
async function chooseCurrentThinking(level) {
  if (level === currentThinking()) return;
  await setThinkingLevel(level);
  updateModelPill();
}

export { TIP_SHOW_DELAY_MS, adoptAllTitleTips, adoptTitleTip, chooseCurrentThinking, chooseModel, closeModelMenu, fetchModelCatalog, findCatalogModel, hideHoverTip, hoverTipState, menuProviders, modelFullLabel, modelLabel, normalizeModelRow, refreshModelPill, renderModelMenu, resolveMenuProvider, setModelPillLabel, showHoverTip, thinkingFoot, toggleModelMenu, updateModelPill, watchTitleAttribute };
