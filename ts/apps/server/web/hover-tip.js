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
import { closePopover, openPopover, popoverOpen, toast } from "./ui-atoms.js";

/* ── 全局悬停提示（2026-11-08，原「收起轨道 tooltip」泛化）──────────
 * 任何带 data-tip 的元素（轨道按钮 / 侧栏分区头 / 设置页 ⓘ / 记忆组头…）
 * 悬停 ~450ms 后弹出小签，离开即收。Cindy 同款参数：12px 圆角、纯 opacity 进场、无箭头。
 * 挂 body 下（fixed 定位）：侧栏收起动画靠 overflow:hidden 裁内容，伪元素会被一起裁掉，
 * 设置页的分区滚动容器同理——fixed + body 挂载躲开一切裁切。 */
const TIP_SHOW_DELAY_MS = 450;
const hoverTipState = { timer: 0, anchor: null };

function hideHoverTip() {
  clearTimeout(hoverTipState.timer);
  hoverTipState.timer = 0;
  hoverTipState.anchor = null;
  if (el.hoverTip) el.hoverTip.hidden = true;
}

function showHoverTip(target) {
  const tipEl = el.hoverTip;
  if (!tipEl || !target) return;
  const text = target.getAttribute("data-tip");
  if (!text) return;
  // 展开态轨道整体 pointer-events:none；键盘 Tab 进来时也别弹一个看不见的提示
  const rail = target.closest(".side-rail");
  if (rail && getComputedStyle(rail).pointerEvents === "none") return;
  hoverTipState.anchor = target;
  tipEl.textContent = text;
  tipEl.hidden = false;
  const box = target.getBoundingClientRect();
  const tipBox = tipEl.getBoundingClientRect();
  const gap = 8;
  // 垂直：默认元素上方，顶上放不下翻到下方；水平：跟元素左缘，右侧贴边兜底
  let top = box.top - tipBox.height - gap;
  if (top < 8) top = box.bottom + gap;
  let left = box.left;
  if (left + tipBox.width > window.innerWidth - 8) left = window.innerWidth - 8 - tipBox.width;
  tipEl.style.left = `${Math.round(Math.max(8, left))}px`;
  tipEl.style.top = `${Math.round(Math.max(8, top))}px`;
}

document.addEventListener("mouseover", (event) => {
  const target = event.target.closest?.("[data-tip]");
  if (!target || target === hoverTipState.anchor) return;
  clearTimeout(hoverTipState.timer);
  hoverTipState.timer = setTimeout(() => showHoverTip(target), TIP_SHOW_DELAY_MS);
});
document.addEventListener("mouseout", (event) => {
  const target = event.target.closest?.("[data-tip]");
  if (!target) return;
  // 同一元素内部挪动（穿过 svg/文字）不算离开
  if (event.relatedTarget && target.contains(event.relatedTarget)) return;
  hideHoverTip();
});
// 键盘可达：Tab 聚焦立即出（不等延迟），移走即收
document.addEventListener("focusin", (event) => {
  const target = event.target.closest?.("[data-tip]");
  if (target && target !== hoverTipState.anchor) showHoverTip(target);
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
    el.modelPill.title = catalog && catalog.current
      ? `当前：${modelFullLabel(catalog)} · 思考强度：${THINKING_LABELS[currentThinking()] || "关"}（点击切换，下一轮生效）`
      : "还没有可用的模型";
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
  menu.replaceChildren();
  const current = catalog.current || null;
  const level = currentThinking();
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
    opt.title = provider.name || provider.id;
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

    // 行 = 模型名（可点，选中行 ✓）；只有当前行额外挂档位分段（2026-11-05）
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
    item.title = `${active.name || active.id} · ${model.id}${contextText ? ` · ${contextText} 上下文` : ""}`;
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
    // 选中态已有强调色 + 加粗 + 档位分段，再挂勾是重复信号
    // 选中后菜单不关：重渲染出档位分段，接着选强度（D2 的「先选模型再选强度」）
    item.addEventListener("click", () => {
      void chooseModel(active, model.id, model.thinkingLevels, { keepOpen: true, menu });
    });
    row.append(item);

    // 档位分段只属于当前模型（2026-11-05 第二次强调）：非当前行完全不渲染，
    // 比禁用更干净，也杜绝「先点别家的档位再偷偷切模型」的两段请求。
    // 2026-11-12：设置页的「更换」弹层标了 data-no-thinking——那里只选模型，
    // 思考强度是会话级偏好，不属于"换默认模型"这件事。
    if (selected && menu.dataset.noThinking !== "1") {
      const seg = document.createElement("div");
      seg.className = "think-seg";
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", `${model.id} 的思考强度`);
      for (const optionLevel of model.thinkingLevels) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "think-opt";
        option.dataset.level = optionLevel;
        option.textContent = THINKING_LABELS[optionLevel];
        option.title = `思考强度：${THINKING_LABELS[optionLevel]}`;
        option.setAttribute("aria-pressed", String(level === optionLevel));
        option.addEventListener("click", () => void chooseCurrentThinking(optionLevel));
        seg.append(option);
      }
      row.append(seg);
    }
    menu.append(row);
  }
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

/** 当前模型行内换档：菜单不关，选中态就地刷新 */
async function chooseCurrentThinking(level) {
  if (level === currentThinking()) return;
  await setThinkingLevel(level);
}

export { TIP_SHOW_DELAY_MS, chooseCurrentThinking, chooseModel, closeModelMenu, fetchModelCatalog, hideHoverTip, hoverTipState, menuProviders, modelFullLabel, modelLabel, normalizeModelRow, refreshModelPill, renderModelMenu, resolveMenuProvider, setModelPillLabel, showHoverTip, toggleModelMenu, updateModelPill };
