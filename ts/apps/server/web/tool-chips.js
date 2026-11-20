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
 * 两条硬约束：
 * 1. **详情面板限高**：输出/思考再多也不许无限撑开，超出部分面板内部滚动。
 * 2. **最多一行**（2026-11-19 用户改口径）：一行装得下就全部摊开，装不下才收进「+N」。
 *
 * 判定方式换过一次：以前数**块数**（MAX_VISIBLE=8），但块宽是随内容变的，
 * 写死个数跟真实排布对不上——8 枚短块能挤两行、5 枚长块第一行就满了。
 * 现在量**真实宽度**：加起来塞得进容器就摆全部，塞不进就退到一行成立为止。
 */

/** 详情面板最大高度（px）：超过就在面板里滚，不撑正文。 */
const DETAIL_MAX_HEIGHT = 260;

/** 设置 → 外观 → 工具详情 的选择落在这个键上（纯前端，同字体/主题做法） */
const KEY_TOOL_DETAIL = "lifediary.toolDetail";
let detailMode = "inline";
try {
  detailMode = localStorage.getItem(KEY_TOOL_DETAIL) === "popover" ? "popover" : "inline";
} catch {
  /* 隐私模式下读不到 localStorage：按默认内联 */
}
const listeners = new Set();

/** 设置页改完调一次：所有已渲染的块下次点击用新形态。 */
export function setDetailMode(mode) {
  detailMode = mode === "popover" ? "popover" : "inline";
  for (const listener of listeners) listener(detailMode);
}

export function getDetailMode() {
  return detailMode;
}

/** 设置页切完调：落 localStorage + 更新当前形态（已渲染的块下次点击即用新形态）。 */
export function chooseDetailMode(mode) {
  setDetailMode(mode);
  try {
    localStorage.setItem(KEY_TOOL_DETAIL, detailMode);
  } catch {
    /* 写不进去也不影响本次会话 */
  }
  return detailMode;
}

export { KEY_TOOL_DETAIL };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * 一行里留几枚灰块（纯函数，排版和单测共用）。
 *
 * flex 换行是"整块下落"：块不会被压缩，所以"能不能排在一行"等价于
 * 所有要显示的块宽 + 间隙不越界。容差 0.5px 防亚像素宽度在临界点上反复跳。
 *
 * @param {object} input
 * @param {number[]} input.widths 每枚的真实像素宽（按当前容器量出来）
 * @param {number} input.containerWidth 这一行的可用宽（.tchips 的 clientWidth）
 * @param {number} [input.gap] 块间距，取 CSS 的 columnGap
 * @param {number} [input.moreWidth] 「+N」按钮的宽（按最宽编号量）
 * @param {number[]} [input.pinned] 运行中的块下标：不能被「+N」收走
 * @returns {{keep:number, folded:boolean}} keep=显示前几枚；folded=是否收了尾巴
 */
export function planRowChips({ widths, containerWidth, gap = 5, moreWidth = 0, pinned = [] }) {
  const n = widths.length;
  if (!n) return { keep: 0, folded: false };
  const all = widths.reduce((sum, width) => sum + width, 0) + gap * (n - 1);
  // 容器还没量出来（未挂载 / 宽度 0）：先按"不收起"处理，等 ResizeObserver 再来一次。
  if (!containerWidth || all <= containerWidth + 0.5) return { keep: n, folded: false };

  // 放不下：先把「+N」的位置让出来，再一枚枚往前退，退到一行成立为止。
  for (let keep = n - 1; keep >= 0; keep -= 1) {
    const shown = widths.slice(0, keep);
    for (const index of pinned) {
      if (index >= keep && index < n) shown.push(widths[index]);
    }
    if (!shown.length) continue;
    const total = shown.reduce((sum, width) => sum + width, 0) + moreWidth + gap * shown.length;
    if (total <= containerWidth + 0.5) return { keep, folded: true };
  }
  // 窄到连一枚都放不下：只留「+N」，运行中的那枚照旧显示（宁可两行也不藏掉"现在在干嘛"）。
  return { keep: 0, folded: true };
}

/** 取容器当前的块间距（CSS 里写的是 5px；量出来更稳，主题若改这里跟着走）。 */
function gapOf(node) {
  const css = getComputedStyle(node);
  const raw = css.columnGap && css.columnGap !== "normal" ? css.columnGap : css.gap;
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
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
  // 块类别落进 DOM（2026-11-20）：CSS 只给「思考」这种在跑时换成转圈环，
  // 别的工具块仍用原来的扫光，不动它们的观感。
  if (spec.kind) chip.dataset.kind = spec.kind;
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");
  // 块上只写"干了哪类事"（读取 / 执行 / 思考…），具体命令和路径不进正文：
  // 一条命令一个长目标会把块撑到 200px，十几个就铺满屏（2026-11-19 用户口径）。
  // 完整目标留在这里的 title 和点开后的详情里，两处都不占版面。
  chip.title = `${spec.verb || ""}${spec.target ? ` · ${spec.target}` : ""}`;

  const icon = el("span", "tchip-icon");
  icon.innerHTML = spec.iconSvg || "";
  const verb = el("span", "tchip-verb", spec.verb || "");
  const check = el("span", "tchip-check");
  check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>';
  const sweep = el("span", "tchip-sweep");
  chip.append(icon, verb, check, sweep);

  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    hooks.onOpen?.(spec, chip);
  });
  return chip;
}

/** 详情卡：命令 / 用时 / 改动 / 输出（或 diff）。限高由 CSS 的 max-height 兜。 */
export function buildDetailCard(spec, { onClose } = {}) {
  const card = el("div", "tdetail-card");
  // JS 里也限一次：CSS 被别的页面覆盖/遗漏时，面板也不会无限撑开。
  card.style.maxHeight = `${DETAIL_MAX_HEIGHT}px`;
  const head = el("div", "tdetail-head");
  const title = el("span", "tdetail-title", `${spec.verb || ""}${spec.target ? ` · ${spec.target}` : ""}`);
  const state = el(
    "span",
    "tdetail-state",
    spec.state === "run"
      ? spec.kind === "think" ? "思考中" : "运行中"
      : spec.state === "err" ? "失败" : spec.state === "back" ? "后台继续" : "完成",
  );
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
  const args = String(spec.args || "").trim();
  // 思考块没有命令：正文就是它本身，一行行数对它没意义。
  if (spec.kind !== "think") {
    // read/write 这类工具的 args 是 JSON，不假装它是 shell 命令。
    addRow(/^[{[]/.test(args) ? "参数" : "命令", spec.command || args || spec.target);
  }
  addRow("用时", spec.duration);
  addRow("改动", spec.diffSummary);
  if (rows.children.length) card.append(rows);

  if (spec.kind === "think") {
    // 思考正文：和输出同一套限高，边想边长也只动面板内部。
    // 小标题用「过程」而不是「思考」——卡头已经写着思考，重复一遍只是噪音。
    card.append(el("div", "tdetail-label", "过程"));
    const pre = el(
      "pre",
      spec.output ? "tdetail-pre" : "tdetail-pre tdetail-wait",
      spec.output || (spec.state === "run" ? "还在想，内容出来会补在这里。" : "这段没留下正文。"),
    );
    card.append(pre);
    return card;
  }

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
  // 只有现场这一轮播新块入场；历史回读几十枚块不该在打开会话时一起动。
  if (options.live) wrap.classList.add("is-live");
  const line = el("div", "tchips");
  const more = el("button", "tchips-more");
  more.type = "button";
  more.hidden = true;
  // 一轮跑完的折叠条（2026-11-19 用户口径：工作执行完默认收起）：
  // 整组收成一枚「工作 N 步」，点开才铺。跑的过程中不出现，进度该看得到。
  // 显隐不靠 hidden：它跟块行各自占一个 grid 槽位，收起/展开是高度过渡。
  const fold = el("button", "tchips-fold");
  fold.type = "button";
  const foldText = el("span", "tchips-fold-text");
  fold.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  fold.append(foldText);
  const inlineHost = el("div", "tchips-inline");
  // 「+N」跟着块一起排在 .tchips 里（2026-11-19）：以前它是 wrap 的兄弟节点，
  // 一折叠就必然掉到第二行——用户要去掉的正是这多出来的一行。
  // 折叠条也排在这一行末尾：收起时正文里只剩这枚「工作 N 步」，不额外占一行。
  line.append(more, fold);
  // 整条块行包一层：收起/展开时对它做高度过渡（行数会变，量真实高度比猜 max-height 准）。
  const row = el("div", "tchips-row");
  row.append(line);
  wrap.append(row, inlineHost);
  host.append(wrap);

  const chips = [];
  const specs = new Map();
  let expanded = false;
  // 整组收起（跑完的默认形态）：只留一枚折叠条，块全部不进正文。
  let collapsed = false;
  // 这组是否已经收尾过：决定点「收起」是回到折叠条，还是回到一行。
  let finished = false;
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

  /**
   * 折叠条的文案。
   * 2026-11-19 用户口径（第三版）：收起后不按"工具调用"记账，按"工作了几步"——
   * 思考和执行是同一件事的两半（想一下、做一下、再想、再做），分开数会让人以为
   * 思考不算工作量。点开仍是逐段真实顺序，不合并。
   * 收起态不染红：失败是展开后才该看的事，这一枚只负责"点开看"。
   */
  const syncFold = () => {
    foldText.textContent = `工作 ${chips.length} 步`;
    fold.title = "展开这一轮的完整过程";
    fold.setAttribute("aria-label", `展开这一轮的 ${chips.length} 步`);
  };

  /** 收起/展开时给整条块行做高度过渡；行数会变，只能量真实高度（max-height 猜不准）。 */
  const animateRow = (mutate) => {
    const from = row.getBoundingClientRect().height;
    mutate();
    const to = row.getBoundingClientRect().height;
    if (!from || Math.abs(to - from) < 1) return;
    row.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: 240, easing: "cubic-bezier(0, 0, .2, 1)" },
    );
  };

  /**
   * 收尾排版：一行装得下就全摊，装不下就收进「+N」。
   *
   * 只在动画帧里量一次（流式时 push 很密集，每枚都量会把布局反复推翻）；
   * 量的都是真实宽度——块宽随目标文本变，任何写死的个数都对不上。
   */
  let layoutQueued = false;
  // 上一帧是不是收起态：只在状态切换时播高度过渡，流式新增块不该跟着动。
  let wasCollapsed = false;
  const queueLayout = () => {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layoutRow();
    });
  };

  const layoutRow = () => {
    if (!chips.length) {
      more.hidden = true;
      fold.hidden = true;
      wasCollapsed = false;
      return;
    }
    const changed = collapsed !== wasCollapsed;
    wasCollapsed = collapsed;

    const apply = () => {
      // 整组收起（收尾后的默认形态）：正文里只剩一枚「工作 N 步」。
      // 思考和执行一起收（2026-11-19 用户口径）：它们是一件事的两半，
      // 单把思考留在外面反而把"想一下做一下"的节奏拆成了两处；
      // 点开就是逐段的真实顺序。
      if (collapsed) {
        for (const chip of chips) chip.hidden = true;
        more.hidden = true;
        fold.hidden = false;
        syncFold();
        return;
      }
      fold.hidden = true;
      // 展开态是用户点名要"看全部"：多行正是他要的，别在这里按一行收回去。
      if (expanded) {
        for (const chip of chips) chip.hidden = false;
        more.hidden = false;
        more.textContent = "收起";
        more.title = "收起这一轮的步骤";
        more.setAttribute("aria-label", "收起步骤");
        return;
      }
      const width = line.clientWidth;
      // 还没挂到页面上（历史回读先建后插）：让 ResizeObserver 的首次回调来接。
      if (!width) {
        for (const chip of chips) chip.hidden = false;
        more.hidden = true;
        return;
      }
      for (const chip of chips) chip.hidden = false;
      const widths = chips.map((chip) => chip.getBoundingClientRect().width);
      const pinned = [];
      chips.forEach((chip, index) => {
        // 运行中的那块永远可见：它是"现在在干嘛"，不能被 +N 收起来。
        if (chip.dataset.state === "run") pinned.push(index);
      });
      // 「+N」的宽随数字位数变（+12 比 +7 宽）。先按最宽的估，
      // 估完拿真实的收起枚数再量一轮——不然会白少放一枚。
      const measureMore = (label) => {
        more.hidden = false;
        more.textContent = label;
        return more.getBoundingClientRect().width;
      };
      const gap = gapOf(line);
      let moreWidth = measureMore(`+${chips.length}`);
      let plan = planRowChips({ widths, containerWidth: width, gap, moreWidth, pinned });
      for (let round = 0; round < 3 && plan.folded; round += 1) {
        const label = `+${chips.length - plan.keep}`;
        const actual = measureMore(label);
        if (actual >= moreWidth) break;
        moreWidth = actual;
        const next = planRowChips({ widths, containerWidth: width, gap, moreWidth, pinned });
        if (next.keep <= plan.keep) break;
        plan = next;
      }

      chips.forEach((chip, index) => {
        chip.hidden = plan.folded && index >= plan.keep && !pinned.includes(index);
      });
      if (!plan.folded) {
        more.hidden = true;
        return;
      }
      const rest = chips.filter((chip) => chip.hidden).length;
      more.hidden = false;
      more.textContent = `+${rest}`;
      more.title = `还有 ${rest} 步，点开看`;
      more.setAttribute("aria-label", `还有 ${rest} 步`);
    };

    if (changed) animateRow(apply);
    else apply();
  };

  // 容器宽度变了（窗口缩放 / 侧栏开合 / 气泡宽度滑杆）→ 这一行能放几枚跟着变。
  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => queueLayout());
    resizeObserver.observe(line);
  }

  more.addEventListener("click", (event) => {
    event.stopPropagation();
    if (expanded) {
      // 「收起」两档：已经收尾的组收回折叠条；还在跑的只回到一行（+N）。
      expanded = false;
      if (finished && chips.length > 1) collapsed = true;
    } else {
      expanded = true;
      collapsed = false;
    }
    queueLayout();
  });

  fold.addEventListener("click", (event) => {
    event.stopPropagation();
    // 点开就是看全部：跟「+N」点开同一个形态，不给第三种中间态。
    collapsed = false;
    expanded = true;
    queueLayout();
  });

  return {
    root: wrap,
    /** 工具开始：加一枚运行中的灰块。 */
    push(spec) {
      // 上一次撤空了这组（见 remove）：再用时把容器放回来。
      wrap.hidden = false;
      const record = Object.assign({ startedAt: performance.now() }, spec);
      const chip = createChip(record, { onOpen: openDetail });
      chip.__spec = record;
      // 派活行要随进度帧改标签/状态：块自己带三个小口子，不把整个 spec 暴露给调用方。
      chip.__setTarget = (text) => {
        record.target = text;
        // 目标不再画在块上，只更新悬停提示（宽度不变，不必重排）。
        chip.title = `${record.verb || ""}${text ? ` · ${text}` : ""}`;
      };
      chip.__setState = (state) => {
        record.state = state;
        chip.dataset.state = state;
        queueLayout();
      };
      chip.__setDetail = (patch) => Object.assign(record, patch);
      // 思考正文在流：只改已打开面板里的那段文本，不重建卡——
      // 重建会把滚动位置和用户选中的文字一起冲掉。
      chip.__streamText = (text) => {
        record.output = text;
        if (openChip !== chip) return;
        const pre = (openPanel || popover)?.querySelector(".tdetail-pre");
        if (!pre) return;
        pre.classList.remove("tdetail-wait");
        pre.textContent = text || "还在想，内容出来会补在这里。";
        pre.scrollTop = pre.scrollHeight; // 边想边看最新一句
      };
      // 已打开的面板按最新 record 重画一次（终态补用时；流式中走 __streamText）。
      chip.__refresh = () => {
        if (openChip !== chip) return;
        const card = buildDetailCard(record, { onClose: closeDetail });
        if (openPanel) {
          openPanel.querySelector(".tdetail-card")?.replaceWith(card);
        } else if (popover) {
          popover.querySelector(".tdetail-card")?.replaceWith(card);
          placePopover(chip, popover);
        }
      };
      // 「+N」要永远排在最后一枚后面，所以插到它前面而不是整条尾巴。
      line.insertBefore(chip, more);
      chips.push(chip);
      specs.set(record.id || String(chips.length), record);
      queueLayout();
      return chip;
    },
    /** 取某个工具已跑的毫秒数（现场用来算详情里的"用时"）。 */
    durationOf(id) {
      const record = [...specs.values()].reverse().find((item) => item.id === id);
      if (!record) return 0;
      if (typeof record.ms === "number") return record.ms;
      return Math.max(0, performance.now() - (record.startedAt || 0));
    },
    /**
     * 撤掉一枚块（2026-11-20）：发消息时先立的「思考」转圈占位，如果一路没等到
     * 真思考正文，进入正文 / 收尾时整枚撤掉，别在历史里留一枚空块。
     * 组空了就把整条块行藏起来——否则正文前会留一道空行。
     */
    remove(id) {
      const index = chips.findIndex((item) => item.__spec && item.__spec.id === id);
      if (index < 0) return;
      const chip = chips[index];
      if (openChip === chip) closeDetail();
      chip.remove();
      chips.splice(index, 1);
      specs.delete(chip.__spec?.id || id);
      if (!chips.length) wrap.hidden = true;
      queueLayout();
    },
    /** 工具结束：定状态、补结果。`patch` 可带 output / diff / diffSummary / duration / state。 */
    settle(id, patch = {}) {
      const chip = chips.find((item) => item.__spec && item.__spec.id === id && item.dataset.state === "run");
      if (!chip) return;
      Object.assign(chip.__spec, patch);
      chip.dataset.state = patch.state || (patch.ok === false ? "err" : "ok");
      // 详情的状态文案读 spec.state：补回去，别让块上画着"失败"、面板里还写"运行中"。
      chip.__spec.state = chip.dataset.state;
      chip.__refresh?.();
      // 不再是"运行中"了，pinned 名单就变了：这一行该收几枚得重算。
      queueLayout();
    },
    /** 中间话折走后清空：下一段重新开始排块。 */
    reset() {
      closeDetail();
      chips.length = 0;
      specs.clear();
      // 「+N」现在住在 .tchips 里，清空时得把它留下，否则整条行连同按钮一起没了。
      line.replaceChildren(more, fold);
      more.hidden = true;
      fold.hidden = true;
      inlineHost.replaceChildren();
      expanded = false;
      collapsed = false;
      finished = false;
      wasCollapsed = false;
    },
    /**
     * 一轮收尾：还开着的详情关掉；没等到结果的运行块标失败（不能画成成功）。
     *
     * `collapse` 默认 true（2026-11-19）：整轮跑完后整组收成一枚折叠条。
     * 段间切组传 false——那会儿下一枚工具马上就要动手，进度得看得见。
     */
    finish(options = {}) {
      const collapse = options.collapse !== false;
      closeDetail();
      for (const chip of chips) {
        // 派活是后台长任务：可能跨过这一组、跨过这一轮，不能因为封组就判失败；
        // 它的终态由 delegate 事件 / handoff 决定。
        if (chip.dataset.state === "run" && !String(chip.__spec?.id || "").startsWith("delegate:")) {
          chip.__spec.state = "err";
          chip.dataset.state = "err";
        }
      }
      finished = true;
      // 只有一枚块不值得再折一层：它本身就一行，收起来只是多点一下。
      collapsed = collapse && chips.length > 1;
      if (collapsed) {
        expanded = false;
        syncFold();
      }
      queueLayout();
    },
    closeDetail,
  };
}

