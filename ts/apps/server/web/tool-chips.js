/**
 * 工具调用的小灰块（2026-11-13，用户拍板 E1 方案）。
 *
 * 形状：每个工具一枚 24px 高的灰块，icon + 动词 + 目标；跑完打勾留在原地。
 * 主界面**不写"几步/几秒"**——步数、耗时、命令、输出、diff 全部收进点击后的详情。
 *
 * 细节两种形态，用户在 设置 → 外观 → 工具详情 里选，默认内联：
 * - inline：在那一行下面原地展开（对应 ZCode 的 Collapsible 做法）；
 * - popover：灰块旁边弹一张小卡，点外面 / Esc / 滚动关闭。
 *
 * 两条硬约束（用户 2026-11-13 明确提的）：
 * 1. **详情面板限高**：输出/思考再多也不许无限撑开，超出部分面板内部滚动。
 * 2. **块太多先收起**：超过 MAX_VISIBLE 个时只留前几个，其余收进「+N」，点开才铺。
 */

/** 主界面最多直接显示的块数；多出来的收进「+N」。 */
const MAX_VISIBLE_CHIPS = 8;
/** 详情面板最大高度（px）：超过就在面板里滚，不撑正文。 */
const DETAIL_MAX_HEIGHT = 260;

let detailMode = "inline";
const listeners = new Set();

/** 设置页改完调一次：所有已渲染的块下次点击用新形态。 */
export function setDetailMode(mode) {
  detailMode = mode === "popover" ? "popover" : "inline";
  for (const listener of listeners) listener(detailMode);
}

export function getDetailMode() {
  return detailMode;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * 一枚灰块的 DOM。
 * @param {object} spec {id, verb, target, iconSvg, diff, state}
 * @param {object} hooks {onOpen(spec, chip), onClose(), canOpen}
 */
export function createChip(spec, hooks = {}) {
  const chip = el("button", "tchip");
  chip.type = "button";
  chip.dataset.state = spec.state || "run";
  if (spec.id) chip.dataset.tool = spec.id;
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");
  chip.title = "查看细节";

  const icon = el("span", "tchip-icon");
  icon.innerHTML = spec.iconSvg || "";
  const verb = el("span", "tchip-verb", spec.verb || "");
  const target = el("span", "tchip-target", spec.target || "");
  const check = el("span", "tchip-check");
  check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>';
  const sweep = el("span", "tchip-sweep");
  chip.append(icon, verb, target, check, sweep);

  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    hooks.onOpen?.(spec, chip);
  });
  return chip;
}

/** 详情卡：命令 / 用时 / 改动 / 输出（或 diff）。限高由 CSS 的 max-height 兜。 */
export function buildDetailCard(spec, { onClose } = {}) {
  const card = el("div", "tdetail-card");
  const head = el("div", "tdetail-head");
  const title = el("span", "tdetail-title", `${spec.verb || ""}${spec.target ? ` · ${spec.target}` : ""}`);
  const state = el("span", "tdetail-state", spec.state === "run" ? "运行中" : spec.state === "err" ? "失败" : "完成");
  const close = el("button", "tdetail-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "关闭细节");
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    onClose?.();
  });
  head.append(title, state, close);
  card.append(head);

  const rows = el("div", "tdetail-rows");
  const addRow = (key, value) => {
    if (!value) return;
    const row = el("div", "tdetail-row");
    row.append(el("b", null, key), el("span", null, value));
    rows.append(row);
  };
  addRow("命令", spec.command || spec.args || spec.target);
  addRow("用时", spec.duration);
  addRow("改动", spec.diffSummary);
  if (rows.children.length) card.append(rows);

  if (spec.diff) {
    card.append(el("div", "tdetail-label", "diff"));
    const pre = el("pre", "tdetail-pre");
    for (const line of String(spec.diff).split(/\r?\n/)) {
      const span = el("span", line.startsWith("+") ? "d-add" : line.startsWith("-") ? "d-del" : "", `${line}\n`);
      pre.append(span);
    }
    card.append(pre);
  } else if (spec.output) {
    card.append(el("div", "tdetail-label", "输出"));
    card.append(el("pre", "tdetail-pre", spec.output));
  } else if (spec.state === "run") {
    card.append(el("div", "tdetail-label", "输出"));
    card.append(el("pre", "tdetail-pre tdetail-wait", "还在跑，结果出来会补在这里。"));
  }
  return card;
}

/**
 * 一条消息里的工具块容器。
 *
 * 调用方：`push(spec)` 一次工具开始，`settle(id, patch)` 工具结束，
 * `reset()` 中间话折走后清空（下一段重新开始）。
 */
export function createToolChips(host, options = {}) {
  const wrap = el("div", "tchips-wrap");
  const line = el("div", "tchips");
  const more = el("button", "tchips-more");
  more.type = "button";
  more.hidden = true;
  const inlineHost = el("div", "tchips-inline");
  wrap.append(line, more, inlineHost);
  host.append(wrap);

  const chips = [];
  const specs = new Map();
  let expanded = false;
  let openChip = null;
  let openPanel = null;
  let popover = null;

  const closeDetail = () => {
    if (openChip) openChip.setAttribute("aria-expanded", "false");
    openChip = null;
    if (openPanel) {
      openPanel.classList.remove("is-open");
      const panel = openPanel;
      setTimeout(() => panel.remove(), 240);
      openPanel = null;
    }
    if (popover) {
      popover.remove();
      popover = null;
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onEsc);
      document.querySelector(".thread")?.removeEventListener("scroll", onScroll, true);
    }
  };

  const onDocClick = (event) => {
    if (popover && !popover.contains(event.target) && !openChip?.contains(event.target)) closeDetail();
  };
  const onEsc = (event) => {
    if (event.key === "Escape") closeDetail();
  };
  const onScroll = () => closeDetail();

  const placePopover = (chip, pop) => {
    const rect = chip.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.min(window.innerWidth - width - 12, Math.max(12, rect.left))}px`;
    const height = pop.offsetHeight;
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 8);
    pop.style.top = `${top}px`;
  };

  const openDetail = (spec, chip) => {
    if (openChip === chip) {
      closeDetail();
      return;
    }
    closeDetail();
    openChip = chip;
    chip.setAttribute("aria-expanded", "true");
    const card = buildDetailCard(spec, { onClose: closeDetail });

    if (detailMode === "popover") {
      const pop = el("div", "tchips-pop");
      pop.setAttribute("role", "dialog");
      pop.append(card);
      document.body.append(pop);
      popover = pop;
      placePopover(chip, pop);
      setTimeout(() => document.addEventListener("click", onDocClick), 0);
      document.addEventListener("keydown", onEsc);
      document.querySelector(".thread")?.addEventListener("scroll", onScroll, true);
      return;
    }

    const panel = el("div", "tchips-detail");
    const inner = el("div", "tchips-detail-inner");
    inner.append(card);
    panel.append(inner);
    inlineHost.append(panel);
    openPanel = panel;
    requestAnimationFrame(() => {
      panel.classList.add("is-open");
      setTimeout(() => panel.scrollIntoView({ block: "nearest", behavior: "smooth" }), 80);
    });
  };

  const renderVisibility = () => {
    const limit = expanded ? chips.length : MAX_VISIBLE_CHIPS;
    let hidden = 0;
    chips.forEach((chip, index) => {
      const show = index < limit;
      chip.hidden = !show;
      if (!show) hidden += 1;
    });
    if (hidden > 0) {
      more.hidden = false;
      more.textContent = `+${hidden}`;
      more.title = `还有 ${hidden} 个工具调用，点开看`;
      more.setAttribute("aria-label", `还有 ${hidden} 个工具调用`);
    } else if (!expanded && chips.length > MAX_VISIBLE_CHIPS) {
      more.hidden = false;
      more.textContent = "收起";
    } else {
      more.hidden = true;
    }
    if (expanded && chips.length > MAX_VISIBLE_CHIPS) {
      more.hidden = false;
      more.textContent = "收起";
    }
  };

  more.addEventListener("click", (event) => {
    event.stopPropagation();
    expanded = !expanded;
    renderVisibility();
  });

  return {
    root: wrap,
    /** 工具开始：加一枚运行中的灰块。 */
    push(spec) {
      const record = Object.assign({ startedAt: performance.now() }, spec);
      const chip = createChip(record, { onOpen: openDetail });
      chip.__spec = record;
      // 派活行要随进度帧改标签/状态：块自己带三个小口子，不把整个 spec 暴露给调用方。
      chip.__setTarget = (text) => {
        record.target = text;
        chip.querySelector(".tchip-target").textContent = text;
      };
      chip.__setState = (state) => {
        record.state = state;
        chip.dataset.state = state;
      };
      chip.__setDetail = (patch) => Object.assign(record, patch);
      line.append(chip);
      chips.push(chip);
      specs.set(record.id || String(chips.length), record);
      renderVisibility();
      return chip;
    },
    /** 取某个工具已跑的毫秒数（现场用来算详情里的"用时"）。 */
    durationOf(id) {
      const record = [...specs.values()].reverse().find((item) => item.id === id);
      if (!record) return 0;
      if (typeof record.ms === "number") return record.ms;
      return Math.max(0, performance.now() - (record.startedAt || 0));
    },
    /** 工具结束：定状态、补结果。`patch` 可带 output / diff / diffSummary / duration / state。 */
    settle(id, patch = {}) {
      const chip = chips.find((item) => item.__spec && item.__spec.id === id && item.dataset.state === "run");
      if (!chip) return;
      Object.assign(chip.__spec, patch);
      chip.dataset.state = patch.state || (patch.ok === false ? "err" : "ok");
      if (chip.dataset.state === "ok") chip.classList.add("is-settled");
      if (openChip === chip) {
        const card = buildDetailCard(chip.__spec, { onClose: closeDetail });
        if (openPanel) {
          openPanel.querySelector(".tdetail-card")?.replaceWith(card);
        } else if (popover) {
          popover.querySelector(".tdetail-card")?.replaceWith(card);
          placePopover(chip, popover);
        }
      }
    },
    /** 中间话折走后清空：下一段重新开始排块。 */
    reset() {
      closeDetail();
      chips.length = 0;
      specs.clear();
      line.replaceChildren();
      inlineHost.replaceChildren();
      expanded = false;
      renderVisibility();
    },
    /** 一轮收尾：还开着的详情关掉，避免盖住后面的回答。 */
    finish() {
      closeDetail();
    },
    closeDetail,
  };
}

export const CHIP_LIMITS = { MAX_VISIBLE_CHIPS, DETAIL_MAX_HEIGHT };
