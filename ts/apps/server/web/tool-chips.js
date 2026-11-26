/**
 * 工具调用的小灰块（2026-11-13，用户拍板 E1 方案）。
 *
 * 形状：每个工具一枚 24px 高的灰块，icon + 动词 + 目标；跑完打勾留在原地。
 * 块上只写"干了哪类事"，不写秒数、命令、输出——这些全收进点击后的详情；
 * 步数只有一处：行首「工作 N 步」折叠条（2026-11-21 起常驻报数）。
 *
 * 细节两种形态，用户在 设置 → 外观 → 工具详情 里选，默认内联：
 * - inline：在那一行下面原地展开（对应 ZCode 的 Collapsible 做法）；
 * - popover：灰块旁边弹一张小卡，点外面 / Esc / 滚动关闭。
 *
 * 两条硬约束：
 * 1. **详情面板限高**：输出/思考再多也不许无限撑开，超出部分面板内部滚动。
 * 2. **最多一行**（2026-11-19 用户改口径）：一行装得下就全部摊开，装不下才收起来。
 *
 * 开合开关只有一处（2026-11-21 用户口径）：行首一枚「工作 N 步」折叠条——
 * 跑动中就常驻报数（每次思考过程都看得到干到第几步），点开铺第一页、再点收回去；
 * 位置永远在行首不动，鼠标不用挪去找「收起」。行尾「收起」按钮已退役。
 *
 * 分页展开（2026-11-24 用户拍板）：行尾「+N」以分页形式回归——展开态一次只铺
 * CHIP_PAGE（30）枚，点「+N」再要下一批，到顶消失；跑动中那一行装不下的块也数进「+N」。
 * 2026-11-21 退役的是固定枚数（以前最多 8 枚）与行尾「收起」按钮，不是「+N」本身。
 * 点「+N」时先把「+N」克隆钉在旧位置，发完牌再滑到新位置（否则牌会从"水下"往上飞）。
 * 回滚开关 `TOOL_CHIP_PAGING=false`：展开就是全部、跑动行没有「+N」，即 2026-11-24 之前的形态。
 *
 * 一轮一份状态（2026-11-25 用户口径）：一轮里"说一句 / 动一次手"会切成几组灰块，
 * 以前每组各报各的步数，同一轮会出现「工作 1 步」「工作 7 步」两枚折叠条。现在
 * 计数、开合、收尾归整轮一份（见 createTurnWork）：只有第一组承载折叠条，文案报
 * 整轮总数；收起时整轮所有组一起藏（跑动中也收得起来），展开时各组在原位置铺开。
 * 收起会顺手关掉展开的详情卡；跑动中收起来时折叠条自己带扫光，别让"还在跑"消失。
 *
 * 判定方式换过一次：以前数**块数**（MAX_VISIBLE=8），但块宽是随内容变的，
 * 写死个数跟真实排布对不上——8 枚短块能挤两行、5 枚长块第一行就满了。
 * 现在量**真实宽度**：加起来塞得进容器就摆全部，塞不进就退到一行成立为止。
 */

import { chevSvg } from "./icons.js";

/** 详情面板最大高度（px）：超过就在面板里滚，不撑正文。 */
const DETAIL_MAX_HEIGHT = 260;

/**
 * 分页展开的固定长度（2026-11-24 用户拍板）：一次只铺 30 枚，行尾留一枚「+N」，
 * 点一次再要下一批。运行中和展开态都是 30，不做每页枚数设置。
 */
const CHIP_PAGE = 30;

/**
 * 分页展开开关（2026-11-24）：默认开；关 = 回到「展开就是全部、没有行尾 +N」的旧形态。
 * 首屏 app.js 与设置页 settings-switches.js 调 setChipPagingEnabled；
 * 排版时读模块变量，下一帧 / 下一次交互生效（不强行重排已经铺开的组）。
 */
let chipPagingEnabled = true;

export function setChipPagingEnabled(value) {
  // 设置页传布尔；env / 字符串口径也认（false / "false" / 0 / "0" / off 都算关）。
  chipPagingEnabled = !(
    value === false ||
    value === "false" ||
    value === 0 ||
    value === "0" ||
    value === "off"
  );
}

/**
 * 分页展开的下一档枚数（纯函数，排版和单测共用；2026-11-24）。
 * `revealed = 0` 时就是第一页；之后每次再加 page，到顶停在 total。
 */
export function nextRevealCount(revealed, total, page = CHIP_PAGE) {
  const count = Math.max(0, Math.round(Number(total) || 0));
  const shown = Math.min(Math.max(0, Math.round(Number(revealed) || 0)), count);
  const step = Math.max(1, Math.round(Number(page) || CHIP_PAGE));
  return Math.min(count, shown + step);
}

/** 发牌动画总时长：最后一枚的排队延迟 + 飞行 0.24s + 一点余量。 */
function dealDuration(count) {
  return 240 + Math.min(Math.max(count - 1, 0), 24) * 16 + 60;
}

/** 系统开了「减少动态效果」：高度过渡与发牌都不播（CSS 侧同样有关掉规则）。 */
function reduceMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

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
 * @param {number} [input.moreWidth] 行首固定占位（折叠条）连一个 gap 的宽；分页开着时
 *        再加上行尾「+N」一格（2026-11-21 固定枚数「+N」退役，2026-11-24 分页回归）
 * @param {number[]} [input.pinned] 运行中的块下标：优先保留，但不能把一行挤成两行
 * @returns {{keep:number, folded:boolean, pinnedShown:number[]}} keep=显示前几枚；
 *          folded=是否收了尾巴；pinnedShown=这次真正留在一行里的运行块下标
 *          （装不下的旧运行块也要让位——"最多一行"优先于"每一枚运行块都露脸"）
 */
export function planRowChips({ widths, containerWidth, gap = 5, moreWidth = 0, pinned = [] }) {
  const n = widths.length;
  if (!n) return { keep: 0, folded: false, pinnedShown: [] };
  const all = widths.reduce((sum, width) => sum + width, 0) + gap * (n - 1);
  // 容器还没量出来（未挂载 / 宽度 0）：先按"不收起"处理，等 ResizeObserver 再来一次。
  if (!containerWidth || all <= containerWidth + 0.5) return { keep: n, folded: false, pinnedShown: [] };

  // 运行中的块优先保留，但只留装得下的（2026-11-25 用户口径「最多一行」）：
  // 最新的排前面，先保"现在在干嘛"；旧运行块让位进行尾「+N」，绝不折到第二行。
  const pinnedOrder = [...new Set(pinned)].sort((a, b) => b - a);

  // 放不下：先把行首折叠条的位置让出来，再一枚枚往前退，退到一行成立为止。
  for (let keep = n - 1; keep >= 0; keep -= 1) {
    let total = moreWidth + gap * keep;
    for (let index = 0; index < keep; index += 1) total += widths[index];
    if (total > containerWidth + 0.5) continue;
    const pinnedShown = [];
    for (const index of pinnedOrder) {
      if (index < keep) continue;
      const add = widths[index] + gap;
      if (total + add > containerWidth + 0.5) continue;
      total += add;
      pinnedShown.push(index);
    }
    // 最新一枚运行块必须露脸（"现在在干嘛"）：这一档装不下它就再往前退，
    // 拿更少的普通块换它；实在窄到装不下才作罢（只留折叠条）。
    const newest = pinnedOrder[0];
    const newestVisible = newest === undefined || newest < keep || pinnedShown.includes(newest);
    if (!newestVisible) continue;
    if (keep > 0 || pinnedShown.length > 0) return { keep, folded: true, pinnedShown };
  }
  // 窄到连一枚都放不下：只留行首计数条，运行中的那枚也不硬塞（宁可少露脸，不折行）。
  return { keep: 0, folded: true, pinnedShown: [] };
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
 * 一轮的共享工作状态（2026-11-25 用户口径：一轮只留一枚「工作 N 步」）。
 *
 * 一条回答里可能有多组灰块（说一句、动一次手、再说、再动）。以前每组各持一份
 * 开合状态、各报各的步数，同一轮会同时出现「工作 1 步」「工作 7 步」。现在
 * 计数 / 收起 / 展开 / 收尾都归整轮一份：
 * - 第一组（master）承载唯一的折叠条，文案报整轮总步数；
 * - 其余组不画折叠条，只保留自己的块行与「+N」；
 * - 收起时所有组一起藏（跑动中也收得起来），展开时各组在原位置铺开。
 */
export function createTurnWork() {
  const groups = new Set();
  const turn = {
    groups,
    master: null,
    collapsed: false,
    expanded: false,
    finished: false,
    total() {
      let total = 0;
      for (const group of groups) total += group.chipCount();
      return total;
    },
    running() {
      for (const group of groups) if (group.hasRunning()) return true;
      return false;
    },
    relayout() {
      for (const group of groups) group.queueLayout();
    },
    closeDetails() {
      for (const group of groups) group.closeDetail();
    },
    syncFold() {
      turn.master?.syncFold(turn.expanded);
    },
    /**
     * 展开前的一步：每一组都按这次点击的锚点准备「发牌」，排队号整轮连号
     * （2026-11-25 用户口径：后几组也要发牌，不许闪出来）。
     */
    prepareOpen(rect) {
      let offset = 0;
      for (const group of groups) offset = group.prepareOpen(rect, offset);
    },
    /**
     * 收起前的一步：记下折叠条的位置（收牌都飞回这里），并给当前露着的块
     * 按整轮顺序写逆序排队号 `--ci`——最后发出去的先收，一路卷回折叠条
     * （2026-11-25 用户口径：收起也按发牌的收牌）。
     */
    collapseRect: null,
    everShown: false,
    prepareCollapse(rect) {
      turn.collapseRect = rect || null;
      const all = [];
      for (const group of groups) all.push(...group.shownChips());
      let maxCi = 0;
      all.forEach((chip, index) => {
        const order = Math.min(Math.max(all.length - 1 - index, 0), 24);
        chip.style.setProperty("--ci", String(order));
        if (order > maxCi) maxCi = order;
      });
      // 整轮同一个收行时刻（用户口径：收牌走到 80–90% 就开始，别等完全落定才冷场）。
      // 缓动是 decelerate，85% 时牌已经基本贴回折叠条、近乎全透明，重叠看不出来。
      turn.collapseDelay = all.length ? Math.round((maxCi * 16 + 220) * 0.85) : 0;
    },
  };
  return turn;
}

/**
 * 一条消息里的工具块容器。
 *
 * 调用方：`push(spec)` 一次工具开始，`settle(id, patch)` 工具结束，
 * `seal()` 一段话结束（下一组另起），`finish()` 整轮收尾。
 * `options.turn` 是整轮共享状态（tool-flow 建一份传给同轮的所有组）。
 */
export function createToolChips(host, options = {}) {
  const turn = options.turn || createTurnWork();
  const isMaster = !turn.master;
  const wrap = el("div", "tchips-wrap");
  // 只有现场这一轮播新块入场；历史回读几十枚块不该在打开会话时一起动。
  if (options.live) wrap.classList.add("is-live");
  const line = el("div", "tchips");
  // 折叠条 = 整轮唯一的开合开关（2026-11-21 用户口径：鼠标只点一处；
  // 2026-11-25 起一轮一份，只有第一组画它）。行首常驻：跑动中报数「工作 N 步」，
  // 点开铺第一页、再点收回去；收尾后整轮只剩它。位置从头到尾不动。
  // 行尾「+N」只负责翻页（2026-11-24 分页回归），不承担开合。
  // 箭头走全站统一的 chevSvg（icons.js），旋转行为在 style-27-chevron.css。
  const fold = el("button", "tchips-fold");
  fold.type = "button";
  fold.hidden = true;
  fold.setAttribute("aria-expanded", "false");
  fold.innerHTML = chevSvg("chev");
  const foldText = el("span", "tchips-fold-text");
  fold.append(foldText);
  const inlineHost = el("div", "tchips-inline");
  line.append(fold);
  // 整条块行包一层：收起/展开时对它做高度过渡（行数会变，量真实高度比猜 max-height 准）。
  const row = el("div", "tchips-row");
  row.append(line);
  wrap.append(row, inlineHost);
  host.append(wrap);

  const chips = [];
  const specs = new Map();
  // 分页展开（2026-11-24）：展开态一次只铺 CHIP_PAGE 枚，行尾留一枚「+N」。
  // 收起再展开从第一页重新开始；展开后新到的块一律压进「+N」，不自动铺开——
  // revealed 是每组自己的（分页按组翻），开合状态在 turn 上共享。
  let revealed = 0;
  // 这次展开里本组最后一枚的排队号（整轮连号，2026-11-25）与发牌收尾计时器。
  let dealMaxIndex = 0;
  let dealTimer = 0;
  // 收牌（收起）的落定计时器：牌飞完再把块真正藏起来。
  let collapseTimer = 0;
  // 收牌/收行进行中：这期间任何重排都不许把块藏掉，否则行高过渡被掐掉、正文瞬移。
  let collapsing = false;
  // 上一次行高过渡：收合/展开连点时先取消旧的，否则量到的"目标高度"是旧动画的中间值。
  let rowAnim = null;
  // 收牌时同时把这一组占的间隙/外边距收掉（见 collapseAway），落定时再交还。
  let wrapAnim = null;
  // 点开那一刻的屏幕坐标：必须在改布局之前量，改了以后折叠条/「+N」已经挪位。
  let openAnchorRect = null;
  // 发牌期间钉在旧位置的「+N」克隆；真身留在新位置占位但不显示。
  let pagerGhost = null;
  let pagerGhostTimer = 0;
  let openChip = null;
  let openPanel = null;
  let popover = null;

  // 行尾的「+N」：和工具块同一套小灰块皮，但只负责翻页，不弹详情。
  const pager = el("button", "tchip tchip-more");
  pager.type = "button";
  pager.hidden = true;
  pager.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!chipPagingEnabled) return;
    if (!turn.expanded) {
      // 跑动中那一行点的「+N」：不直接全铺，先进展开态的第一页。
      // 「+N」先钉在旧位置，发完牌再挪到第一页末尾——否则先挪位、牌从水下往上飞。
      const rect = freezePager();
      turn.collapsed = false;
      turn.expanded = true;
      turn.prepareOpen(rect);
      if (rect) pagerGhostTimer = setTimeout(() => releasePager(), dealDuration(dealMaxIndex + 1));
      turn.relayout();
      return;
    }
    revealMore();
  });
  line.append(pager);

  let pagerCount = 0;
  /**
   * 行尾「+N」的数字与显隐。数字一变就弹一下（180ms 小弹跳）——
   * 跑动中每多一步，让人看见"后面又压了一枚"。
   */
  const setPagerCount = (count) => {
    const next = Math.max(0, Math.round(Number(count) || 0));
    if (next <= 0) {
      pager.hidden = true;
      pagerCount = 0;
      return;
    }
    pager.hidden = false;
    const changed = next !== pagerCount;
    pager.textContent = `+${next}`;
    pager.title = `还有 ${next} 步，点开下一批（每次 ${CHIP_PAGE} 步）`;
    pager.setAttribute("aria-label", `还有 ${next} 步，展开下一批`);
    pagerCount = next;
    if (pagerGhost) {
      // 发牌期间露在旧位置的是克隆：数字也要跟着换，不能停在旧值。
      pagerGhost.textContent = pager.textContent;
      pagerGhost.title = pager.title;
    }
    if (changed && typeof pager.animate === "function") {
      // 数字变了：小灰块向上弹一下再落回，让人看见"后面又压了一步"。
      pager.animate(
        [
          { transform: "translateY(0) scale(1)" },
          { transform: "translateY(-1px) scale(1.14)" },
          { transform: "translateY(0) scale(1)" },
        ],
        { duration: 180, easing: "cubic-bezier(.2, .8, .2, 1)" },
      );
    }
  };

  const cleanupPagerGhost = () => {
    if (pagerGhostTimer) {
      clearTimeout(pagerGhostTimer);
      pagerGhostTimer = 0;
    }
    if (pagerGhost) {
      pagerGhost.remove();
      pagerGhost = null;
    }
    pager.style.removeProperty("visibility");
  };

  /**
   * 把「+N」钉在旧位置：真身在流里占新位置但先不显示，页面上放一枚克隆
   * 继续露在旧位置。发牌动画从克隆那里发出，发完再由 releasePager 挪到新位置。
   */
  const freezePager = () => {
    cleanupPagerGhost();
    const rect = pager.getBoundingClientRect();
    if (!rect.width) return null;
    // 挂进这条消息里（不是 body）：对话区滚动时克隆跟着内容走，不会浮在屏幕上。
    const host = wrap.closest(".msg") || wrap.parentElement || document.body;
    const hostRect = host.getBoundingClientRect();
    const ghost = pager.cloneNode(true);
    ghost.hidden = false;
    ghost.classList.add("tchip-more-ghost");
    ghost.removeAttribute("aria-label");
    // 发牌期间先隐藏：旧数字不能留在旧位置干等；牌发完再把新数字滑过去。
    ghost.style.cssText =
      `position:absolute;left:${rect.left - hostRect.left}px;top:${rect.top - hostRect.top}px;` +
      "margin:0;z-index:70;pointer-events:none;opacity:0;";
    host.append(ghost);
    pager.style.visibility = "hidden";
    pagerGhost = ghost;
    return rect;
  };

  /** 发牌结束再把「+N」挪到新位置：克隆滑过去，落定后换成真身。 */
  const releasePager = () => {
    const ghost = pagerGhost;
    pagerGhostTimer = 0;
    if (!ghost) {
      pager.style.removeProperty("visibility");
      return;
    }
    const settle = () => {
      if (pagerGhost !== ghost) return;
      ghost.remove();
      pagerGhost = null;
      pager.style.removeProperty("visibility");
    };
    ghost.textContent = pager.textContent;
    ghost.title = pager.title;
    const from = ghost.getBoundingClientRect();
    const target = pager.hidden ? null : pager.getBoundingClientRect();
    if (!target || !target.width) {
      // 没有下一批了（+N 已消失）：克隆一直是隐藏的，直接收掉。
      settle();
      return;
    }
    const dx = target.left - from.left;
    const dy = target.top - from.top;
    // 发牌完再把「+N」交给新位置：先淡入（避免旧数字留存），边淡入边滑过去。
    ghost
      .animate(
        [
          { transform: "translate(0, 0)", opacity: 0 },
          { transform: "translate(0, 0)", opacity: 1, offset: 0.2 },
          { transform: `translate(${dx}px, ${dy}px)`, opacity: 1 },
        ],
        { duration: 260, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "forwards" },
      )
      .addEventListener("finish", settle, { once: true });
    pagerGhostTimer = setTimeout(settle, 340);
  };

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
   * 折叠条的文案与开合状态。
   * 2026-11-19 用户口径（第三版）：收起后不按"工具调用"记账，按"工作了几步"——
   * 思考和执行是同一件事的两半（想一下、做一下、再想、再做），分开数会让人以为
   * 思考不算工作量。点开仍是逐段真实顺序，不合并。
   * 收起态不染红：失败是展开后才该看的事，这一枚只负责"点开看"。
   * 2026-11-21：文字恒为「工作 N 步」，开合只换箭头转向（aria-expanded 驱动
   * style-27 的旋转）——它既是计数条也是开关，一个字都不用变。
   * 2026-11-24：分页展开后文案照旧报**总步数**，不是当前铺开的枚数；
   * 余下几枚由行尾「+N」自己报。
   * 2026-11-25：总步数 = **整轮所有组**之和（一轮只留这一枚折叠条）；
   * 收起时若还有块在跑，折叠条自己带扫光（style-06 的 [data-running]），
   * 别让"还在跑"随着块一起被收没。
   * 2026-11-24：不再挂 title——原生提示会悬在计数条上不消失、挡住下面的步骤；
   * 开合语义由 aria-expanded 与 aria-label 承担。
   */
  const syncFold = (isExpanded) => {
    if (!isMaster) return;
    const total = turn.total();
    foldText.textContent = `工作 ${total} 步`;
    fold.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    fold.setAttribute(
      "aria-label",
      isExpanded ? `收起这一轮的 ${total} 步` : `展开这一轮的 ${total} 步`,
    );
    if (turn.running()) fold.dataset.running = "1";
    else delete fold.dataset.running;
  };

  /** 发牌结束（或中途收起）：恢复裁剪，别让合拢动画也被"不裁"漏出去。 */
  const endDeal = () => {
    if (dealTimer) {
      clearTimeout(dealTimer);
      dealTimer = 0;
    }
    row.classList.remove("is-dealing");
  };

  /**
   * 发牌期间先让行不裁（.is-dealing），发完再合上裁剪：
   * 后几组的牌要从折叠条飞回自己那一格，途中会越过上面的正文——裁着就只看得见
   * 落地那一下，等于没发。时长按本组最后一枚的排队号算，晚落的牌不会被切掉半边。
   */
  const startDeal = () => {
    if (reduceMotion()) return;
    endDeal();
    row.classList.add("is-dealing");
    dealTimer = setTimeout(() => {
      dealTimer = 0;
      row.classList.remove("is-dealing");
    }, dealDuration(dealMaxIndex + 1));
  };

  /**
   * 「涌出」铺开：点开那一刻这一页块从点击处飞回自己这一格
   * （位移实量进 --dx/--dy，排队号在 prepareOpen 里按整轮顺序写好）。
   * 2026-11-25 用户口径：一轮的牌按顺序发完——以前只有首组有锚点，
   * 后几组直接铺开、闪出来；现在每组都从同一个锚点飞出去。
   */
  const playDeal = () => {
    const anchor = openAnchorRect;
    if (!anchor) return;
    openAnchorRect = null;
    line.classList.remove("expand-in");
    void line.offsetWidth; // 重置动画：再开再播
    for (const chip of chips.slice(0, Math.min(revealed, chips.length))) {
      const rect = chip.getBoundingClientRect();
      chip.style.setProperty("--dx", `${anchor.left - rect.left}px`);
      chip.style.setProperty("--dy", `${anchor.top - rect.top}px`);
    }
    startDeal();
    line.classList.add("expand-in");
  };

  /** 收起时清掉收牌计时器与动画类（展开接管时也调，别让旧的隐藏/类跟过去）。 */
  const stopCollapse = () => {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = 0;
    }
    line.classList.remove("collapse-out");
    row.classList.remove("is-collapsing");
    collapsing = false;
    wrapAnim?.cancel();
    wrapAnim = null;
  };

  /** 收牌落定：牌都飞回去了，再把块真正藏起来，行高交还自然值。 */
  const settleCollapse = () => {
    collapseTimer = 0;
    if (!turn.collapsed) return; // 途中被展开接管：保持现状
    line.classList.remove("collapse-out");
    row.classList.remove("is-collapsing");
    for (const chip of chips) {
      chip.hidden = true;
      chip.style.removeProperty("animation");
    }
    if (!isMaster) wrap.hidden = true;
    collapsing = false;
    rowAnim?.cancel();
    rowAnim = null;
    wrapAnim?.cancel();
    wrapAnim = null;
  };

  /**
   * 「收牌」（2026-11-25 用户口径）：收起时展开的牌按发牌的反序飞回折叠条，
   * **飞完再收行**（collapseAway）——两段分开，正文不会先挪上来跟牌叠在一起。
   * 排队号 `--ci` 在收起那刻由 turn.prepareCollapse 按整轮逆序写好；
   * 牌要越过正文，行先不裁（.is-collapsing）。
   */
  const playCollapse = () => {
    const anchor = turn.collapseRect;
    const shown = chips.filter((chip) => !chip.hidden);
    // 上一次发牌/翻页可能还在飞：先清掉类与 inline 动画，按布局位置重新量。
    line.classList.remove("expand-in");
    for (const chip of chips) chip.style.removeProperty("animation");
    if (!anchor || !shown.length) {
      collapseAway();
      return;
    }
    void line.offsetWidth;
    for (const chip of shown) {
      const rect = chip.getBoundingClientRect();
      chip.style.setProperty("--dx", `${anchor.left - rect.left}px`);
      chip.style.setProperty("--dy", `${anchor.top - rect.top}px`);
    }
    row.classList.add("is-collapsing");
    line.classList.add("collapse-out");
    collapsing = true;
    if (collapseTimer) clearTimeout(collapseTimer);
    // 整轮同一时刻收行（turn.collapseDelay）：最后一枚落地前布局不动；
    // 各组不再各收各的，否则前面的牌还在飞、下面正文就先挪了。
    const delay = Number.isFinite(turn.collapseDelay)
      ? turn.collapseDelay
      : 220 + 24 * 16 + 40;
    collapseTimer = setTimeout(collapseAway, delay);
  };

  /**
   * 收牌落定（阶段二）：牌都飞回去了，先把块藏掉，再把行高与间隙平滑收完。
   * 两段是用户口径（2026-11-25）：先收牌、再让主对话回来——同时跑的话正文会
   * 先挪到位置，跟还在飞的牌叠在一起。
   *
   * 非首组还要把「藏起来之后会一起消失的那点空间」一起收掉：flex 的 gap 与
   * wrap 的下外边距只在 display:none 那一刻才消失，光做行高的话正文会在
   * 落定时再跳 12px（实测）。所以同步把 margin-bottom 收到 -(margin-top + gap)。
   */
  const collapseAway = () => {
    collapseTimer = 0;
    if (!turn.collapsed) return; // 途中被展开接管：保持现状
    collapsing = true;
    line.classList.remove("collapse-out");
    row.classList.remove("is-collapsing");
    // 先量还挂着牌时的高度，再藏（藏完自然高度就变了）。
    const from = row.getBoundingClientRect().height;
    for (const chip of chips) {
      chip.hidden = true;
      chip.style.removeProperty("animation");
    }
    if (!isMaster) {
      const parent = wrap.parentElement;
      const parentStyle = parent ? getComputedStyle(parent) : null;
      const gap = parentStyle
        ? parseFloat(parentStyle.rowGap || parentStyle.gap || "0") || 0
        : 0;
      const style = getComputedStyle(wrap);
      const marginTop = parseFloat(style.marginTop) || 0;
      const marginBottom = parseFloat(style.marginBottom) || 0;
      // 只有一个孩子时没有相邻间隙可省，隐藏只省下外边距。
      const savedGap = parent && parent.children.length > 1 ? gap : 0;
      const bottomTarget = -(marginTop + savedGap);
      wrapAnim?.cancel();
      wrapAnim = null;
      if (Math.abs(bottomTarget - marginBottom) >= 0.5) {
        wrapAnim = wrap.animate(
          [{ marginBottom: `${marginBottom}px` }, { marginBottom: `${bottomTarget}px` }],
          { duration: 240, easing: "cubic-bezier(0, 0, .2, 1)", fill: "forwards" },
        );
      }
    }
    const to = isMaster ? fold.getBoundingClientRect().height : 0;
    rowAnim?.cancel();
    rowAnim = null;
    if (Math.abs(to - from) >= 1) {
      rowAnim = row.animate(
        [{ height: `${from}px` }, { height: `${to}px` }],
        { duration: 240, easing: "cubic-bezier(0, 0, .2, 1)", fill: "forwards" },
      );
    }
    collapseTimer = setTimeout(settleCollapse, 300);
  };

  /** 收起/展开时给整条块行做高度过渡；行数会变，只能量真实高度（max-height 猜不准）。 */
  const animateRow = (mutate) => {
    const from = row.getBoundingClientRect().height;
    rowAnim?.cancel();
    rowAnim = null;
    mutate();
    const to = row.getBoundingClientRect().height;
    // from=0 也是真的变化：非首组收起时整条 wrap 是 hidden，展开那一下得从 0 长出来，
    // 否则后几组连同下面的正文一起闪出来（2026-11-25 用户口径）。
    if (Math.abs(to - from) < 1 || reduceMotion()) return;
    rowAnim = row.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: 240, easing: "cubic-bezier(0, 0, .2, 1)" },
    );
  };

  /**
   * 收尾排版：跑动中一行装得下就全摊，装不下就收进「+N」；
   * 展开态只铺前 revealed 枚（每页 CHIP_PAGE），余下数进「+N」。
   *
   * 只在动画帧里量一次（流式时 push 很密集，每枚都量会把布局反复推翻）；
   * 量的都是真实宽度——块宽随目标文本变，任何写死的个数都对不上。
   */
  let layoutQueued = false;
  // 上一帧的开合状态：只在状态切换时播高度过渡，流式新增块不该跟着动。
  let wasCollapsed = false;
  let wasExpanded = false;
  const queueLayout = () => {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layoutRow();
    });
  };

  const layoutRow = () => {
    const total = turn.total();
    if (!chips.length) {
      pager.hidden = true;
      pagerCount = 0;
      // 第一组即使自己没块，只要整轮还有别的组，就继续承载那一枚折叠条。
      if (isMaster && total > 0) {
        wrap.hidden = false;
        fold.hidden = false;
        syncFold(turn.expanded);
      } else {
        fold.hidden = true;
        wrap.hidden = true;
      }
      wasCollapsed = false;
      wasExpanded = false;
      return;
    }
    const changed = turn.collapsed !== wasCollapsed || turn.expanded !== wasExpanded;
    // 从收起态打开的这一刻（「涌出」要在这时实量位移、重播排队动画）。
    const opening = turn.expanded && !wasExpanded;
    // 从露着块收起：收牌只在这时播（历史回读从没露过块，直接收，打开旧会话不闪）。
    const closing = turn.collapsed && !wasCollapsed && turn.everShown && !reduceMotion();
    wasCollapsed = turn.collapsed;
    wasExpanded = turn.expanded;

    const apply = () => {
      wrap.hidden = false;
      if (!turn.collapsed) turn.everShown = true;
      // 整轮收起（收尾后的默认形态）：正文里只剩一枚「工作 N 步」。
      // 思考和执行一起收（2026-11-19 用户口径）：它们是一件事的两半，
      // 单把思考留在外面反而把"想一下做一下"的节奏拆成了两处；
      // 点开就是逐段的真实顺序。
      // 2026-11-25：跑动中也允许收起（用户口径「需要能把它合上」），
      // 整轮所有组一起藏——不是只藏到"一行报数"。
      if (turn.collapsed) {
        cleanupPagerGhost();
        endDeal();
        line.classList.remove("expand-in");
        pager.hidden = true;
        pagerCount = 0;
        if (isMaster) {
          wrap.hidden = false;
          fold.hidden = false;
          syncFold(false);
        } else {
          fold.hidden = true;
          // 非首组收起时不占位置：整轮只留首组那一枚折叠条。
          // 收牌期间先留着（牌还在飞），收完（collapseAway）再藏。
        }
        if (closing) {
          // 收起也发牌：牌按逆序飞回折叠条，飞完再藏（2026-11-25 用户口径）。
          playCollapse();
          return;
        }
        // 收牌/收行进行中：这期间的重排（块一藏 line 尺寸就变，ResizeObserver 会
        // 再来一次）不许抢先藏，否则行高过渡直接被掐掉、正文瞬移。等 settleCollapse。
        if (collapsing) return;
        for (const chip of chips) {
          chip.hidden = true;
          // 清掉分页时写在块上的发牌动画，下次展开才能重新播。
          chip.style.removeProperty("animation");
        }
        if (!isMaster) wrap.hidden = true;
        return;
      }
      // 展开态不再一次铺全部：只铺前 revealed 枚，余下的数进行尾「+N」。
      // 折叠条留在首组行首当标题，再点它收回去。
      if (turn.expanded) {
        // 收牌途中又点开：先停掉收牌，剩下的交给下面的发牌。
        stopCollapse();
        // 分页关掉（TOOL_CHIP_PAGING=false）：回到旧形态——展开就是全部，没有「+N」。
        if (!chipPagingEnabled) {
          cleanupPagerGhost();
          for (const chip of chips) chip.hidden = false;
          pager.hidden = true;
          pagerCount = 0;
          fold.hidden = !isMaster;
          syncFold(true);
          if (opening) playDeal();
          return;
        }
        // revealed 还是 0 说明开关是这一帧才打开的（之前走的是全铺旧形态）：
        // 也按第一页起算，别让首次排版把整组藏光。
        if (opening || !revealed) revealed = nextRevealCount(0, chips.length);
        chips.forEach((chip, index) => {
          chip.hidden = index >= revealed;
        });
        const remaining = chips.length - revealed;
        setPagerCount(remaining);
        fold.hidden = !isMaster;
        syncFold(true);
        // 「涌出」铺开：点开那一刻这一页块从点击处飞回自己这一格。
        // 只在从收起态打开这一刻播一次；已摊开的组里新进的块不跟着重播。
        if (opening) playDeal();
        return;
      }
      // 跑动中的默认形态（2026-11-21 用户口径：每次思考过程都看得到干到第几步，
      // 一枚块也算一步——单步轮同样有「工作 1 步」，不给它藏起来）：
      // 折叠条常驻行首报数（首组），块最多一行——装不下的收着，行尾「+N」说还剩几枚。
      const width = line.clientWidth;
      // 还没挂到页面上（历史回读先建后插）：让 ResizeObserver 的首次回调来接。
      if (!width) {
        for (const chip of chips) chip.hidden = false;
        pager.hidden = true;
        pagerCount = 0;
        fold.hidden = !isMaster;
        syncFold(false);
        return;
      }
      for (const chip of chips) chip.hidden = false;
      fold.hidden = !isMaster;
      syncFold(false);
      // 折叠条占掉行首一段宽：连同它与首块之间的一个 gap 一起让出来。
      // 非首组没有折叠条，不必让位。
      const gap = gapOf(line);
      const foldReserved = isMaster ? fold.getBoundingClientRect().width + gap : 0;
      // 分页关掉（TOOL_CHIP_PAGING=false）：旧形态只给折叠条让位，不摆「+N」。
      if (!chipPagingEnabled) {
        pager.hidden = true;
        pagerCount = 0;
        const widths = chips.map((chip) => chip.getBoundingClientRect().width);
        const pinned = [];
        chips.forEach((chip, index) => {
          // 运行中的块优先保留（它是"现在在干嘛"），但装不下就让位，绝不折成两行。
          if (chip.dataset.state === "run") pinned.push(index);
        });
        const plan = planRowChips({ widths, containerWidth: width, gap, moreWidth: foldReserved, pinned });
        chips.forEach((chip, index) => {
          chip.hidden = plan.folded && index >= plan.keep && !plan.pinnedShown.includes(index);
        });
        return;
      }
      // 「+N」也要占一格：先按最大位数把宽度量出来，再和折叠条一起让位。
      pager.hidden = false;
      pager.textContent = `+${chips.length}`;
      const pagerReserved = pager.getBoundingClientRect().width + gap;
      const widths = chips.map((chip) => chip.getBoundingClientRect().width);
      const pinned = [];
      chips.forEach((chip, index) => {
        // 运行中的块优先保留（它是"现在在干嘛"），但装不下就让位，绝不折成两行。
        if (chip.dataset.state === "run") pinned.push(index);
      });
      const plan = planRowChips({
        widths,
        containerWidth: width,
        gap,
        moreWidth: foldReserved + pagerReserved,
        pinned,
      });
      let hiddenCount = 0;
      chips.forEach((chip, index) => {
        chip.hidden = plan.folded && index >= plan.keep && !plan.pinnedShown.includes(index);
        if (chip.hidden) hiddenCount += 1;
      });
      if (hiddenCount > 0) {
        setPagerCount(hiddenCount);
      } else {
        pager.hidden = true;
        pagerCount = 0;
      }
    };

    // 收起时布局先不动（牌在飞），行高由 collapseAway 在收牌结束后再收——
    // 这里走普通排版即可：块还挂着，animateRow 量不到高度变化会自然跳过。
    if (changed) animateRow(apply);
    else apply();
  };

  /**
   * 「+N」翻页：再铺 CHIP_PAGE 枚。只给新出现的这批播发牌动画——
   * 起点实量「+N」原来的位置（用户点的那一格），位移与排队号现写，
   * 已经铺着的旧块不重播。
   */
  const revealMore = () => {
    if (!turn.expanded || !chipPagingEnabled) return;
    const from = revealed;
    const next = nextRevealCount(revealed, chips.length);
    if (next <= from) return;
    // 先钉住「+N」再改布局：否则它先落到页尾，牌从它新位置往上游。
    const anchor = freezePager();
    if (!anchor) return;
    const before = row.getBoundingClientRect().height;
    // 摘掉整组动画：否则新块 display 复现时，类上的动画会把旧块也带一遍。
    line.classList.remove("expand-in");
    revealed = next;
    chips.forEach((chip, index) => {
      chip.hidden = index >= revealed;
    });
    const remaining = chips.length - revealed;
    setPagerCount(remaining);
    const added = chips.slice(from, next);
    added.forEach((chip, index) => {
      const rect = chip.getBoundingClientRect();
      chip.style.setProperty("--dx", `${anchor.left - rect.left}px`);
      chip.style.setProperty("--dy", `${anchor.top - rect.top}px`);
      chip.style.animation = "none";
      void chip.offsetWidth;
      chip.style.animation = `tchipFanOut .24s var(--ease-decelerate) ${Math.min(index, 24) * 16}ms both`;
    });
    const after = row.getBoundingClientRect().height;
    if (after !== before) {
      row.animate(
        [{ height: `${before}px` }, { height: `${after}px` }],
        { duration: 240, easing: "cubic-bezier(0, 0, .2, 1)" },
      );
    }
    // 牌发完再把「+N」滑到新位置。
    pagerGhostTimer = setTimeout(() => releasePager(), dealDuration(added.length));
  };

  // 容器宽度变了（窗口缩放 / 侧栏开合 / 气泡宽度滑杆）→ 这一行能放几枚跟着变。
  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => queueLayout());
    resizeObserver.observe(line);
  }

  /**
   * 段封口（2026-11-25）：这段话说完、下一组工具要动手时，把这组里还在跑的块
   * 标成失败（不能画成成功），但**不动整轮的开合状态**——下一组马上接着干，
   * 进度得看得见。整轮收尾走 finish()。
   */
  const seal = () => {
    for (const chip of chips) {
      // 派活是后台长任务：可能跨过这一组、跨过这一轮，不能因为封组就判失败；
      // 它的终态由 delegate 事件 / handoff 决定。
      if (chip.dataset.state === "run" && !String(chip.__spec?.id || "").startsWith("delegate:")) {
        chip.__spec.state = "err";
        chip.dataset.state = "err";
        chip.__refresh?.();
      }
    }
    turn.syncFold();
    queueLayout();
  };

  const api = {
    root: wrap,
    /** 本组块数（整轮总数由 turn.total() 汇总） */
    chipCount: () => chips.length,
    /** 当前露在外面的块（收牌按它们逆序飞回折叠条，2026-11-25）。 */
    shownChips: () => chips.filter((chip) => !chip.hidden),
    /** 本组是否还有运行中的块（折叠条的扫光看整轮） */
    hasRunning: () => chips.some((chip) => chip.dataset.state === "run"),
    queueLayout,
    syncFold,
    /**
     * 展开前的一次性准备：分页回到第一页；记下锚点（「涌出」从那里发起）；
     * 把这一页的排队号写成**整轮连号**（`startIndex` 是前面几组已经发掉的枚数），
     * 这样后几组的牌接着首组一枚枚发，不会同时涌出来。返回下一组的起始号。
     */
    prepareOpen(rect = null, startIndex = 0) {
      revealed = chipPagingEnabled ? nextRevealCount(0, chips.length) : chips.length;
      if (rect) openAnchorRect = rect;
      const shown = Math.min(revealed, chips.length);
      dealMaxIndex = 0;
      for (let index = 0; index < shown; index += 1) {
        const order = Math.min(startIndex + index, 24);
        chips[index].style.setProperty("--i", String(order));
        if (order > dealMaxIndex) dealMaxIndex = order;
      }
      return startIndex + shown;
    },
    closeDetail,
    seal,
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
        turn.syncFold();
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
      // 折叠条钉在行首：块直接排到行尾，新块永远在最右；「+N」恒排最后。
      // 展开后新到的块不再自动铺开（2026-11-24 用户口径）：全部压进「+N」，
      // 下一次点「+N」仍然只加 30 枚；否则跑动中点第二下就会把后面全放出来。
      line.insertBefore(chip, pager);
      chips.push(chip);
      // 排队号给「涌出」展开用：点开那刻按 --i 逐枚延迟（16ms 一枚，24 号封顶，
      // 长轮也在半秒内铺完）。已摊开的组里新进的块排 0 号——就地浮现，进度不等动画。
      chip.style.setProperty("--i", String(turn.expanded ? 0 : Math.min(chips.length - 1, 24)));
      specs.set(record.id || String(chips.length), record);
      // 计数条报整轮总步数：别的组新进块也要让首组那枚跟着涨。
      turn.syncFold();
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
      turn.syncFold();
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
      // 不再是"运行中"了，pinned 名单与折叠条的扫光都要变：重算。
      turn.syncFold();
      queueLayout();
    },
    /** 中间话折走后清空：下一段重新开始排块。 */
    reset() {
      cleanupPagerGhost();
      closeDetail();
      chips.length = 0;
      specs.clear();
      // 折叠条钉在行首，清空时留在原地，否则整条行连同按钮一起没了。
      line.replaceChildren(fold, pager);
      pager.hidden = true;
      pager.textContent = "";
      pagerCount = 0;
      fold.hidden = true;
      fold.setAttribute("aria-expanded", "false");
      line.classList.remove("expand-in"); // 新组重新开始，别带上上一组的铺开态
      inlineHost.replaceChildren();
      revealed = 0;
      openAnchorRect = null;
      wasCollapsed = false;
      wasExpanded = false;
      turn.relayout();
    },
    /**
     * 一轮收尾：还开着的详情关掉；没等到结果的运行块标失败（不能画成成功）。
     *
     * `collapse` 默认 true（2026-11-19）：整轮跑完后整轮收成一枚折叠条。
     * 2026-11-25 起一轮一份：任何一个组调都作用于整轮（tool-flow 只调一次）。
     */
    finish(options = {}) {
      const collapse = options.collapse !== false;
      turn.closeDetails();
      for (const group of turn.groups) group.seal();
      turn.finished = true;
      // 用户手动摊开的整轮不强行收（2026-11-21 用户口径「工作 N 步不要隐藏」）：
      // 他正看着的过程，收尾时保持原样，想合上自己再点一下折叠条。
      // 没动过的整轮折回折叠条——1 枚也算一步（「工作 1 步」），不给它藏起来。
      if (!turn.expanded) {
        const shouldCollapse = collapse && turn.total() > 0;
        // 收尾自动收起也走收牌：锚点是折叠条的位置（首组才调 finish）。
        if (shouldCollapse && isMaster) turn.prepareCollapse(fold.getBoundingClientRect());
        turn.collapsed = shouldCollapse;
      }
      turn.relayout();
      turn.syncFold();
    },
  };

  fold.addEventListener("click", (event) => {
    event.stopPropagation();
    cleanupPagerGhost();
    // 行首这枚既是「工作 N 步」的计数条，也是整轮唯一的开合开关
    // （2026-11-21 用户口径：鼠标只点一处）。2026-11-25 用户口径：
    // 只要块还露在外面（含跑动中的一行报数），点它就整轮收起；
    // 已经收起的，点它铺开第一页。收起时顺手关掉展开的详情卡。
    if (turn.collapsed) {
      const rect = fold.getBoundingClientRect();
      turn.collapsed = false;
      turn.expanded = true;
      turn.prepareOpen(rect);
    } else {
      turn.closeDetails();
      // 收牌锚点：点下去那一刻折叠条在哪，牌就飞回哪（展开态下它在首组行首不动）。
      turn.prepareCollapse(fold.getBoundingClientRect());
      turn.collapsed = true;
      turn.expanded = false;
    }
    turn.relayout();
  });

  turn.groups.add(api);
  if (isMaster) turn.master = api;
  return api;
}
