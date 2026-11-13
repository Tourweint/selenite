/**
 * 流式回答的逐字 / 逐词浮现（2026-11-13，对齐 ZCode 的 streaming reveal）。
 *
 * 为什么单独一个文件：app.js 已经两万多行，而且这段是唯一需要"跨帧保留 DOM"的逻辑——
 * 旧版每帧 `body.innerHTML = renderMarkdown(answer)`，任何挂在正文子节点上的动画都会
 * 在下一帧被整段替换杀掉，所以文字只能成块蹦出来。这里把"排期"和"DOM 增量"分开，
 * 纯函数可以直接用 node --test 跑，DOM 部分只在浏览器里工作。
 *
 * 三条纪律（照 ZCode 踩过的坑）：
 * 1. 正文从第一帧起就是完整的，只让 opacity 变；不生成第二份逐步变长的正文，
 *    否则高度逐帧增长会撞进滚动跟随和虚拟测高。
 * 2. 旧 span 不重建：新内容只追加，单词补全（wor → world）只改旧 span 的文本。
 *    这样 transition 不会因为元素被下一帧替换而中断。
 * 3. 时长固定 300ms，只排 delay。能不能看出淡入取决于单个字有几帧在渐变，
 *    与模型吐字速度无关；按速度缩短时长会让快模型看起来"没有动画"。
 */

/* ── 排期常量（移植自 ZCode message.tsx 的 REVEAL_*）──────────── */

/** 相邻两个单元开始淡入的最大间隔：吐得慢时按这个节奏逐字出现。 */
const REVEAL_MAX_INTERVAL_MS = 40;
/** 最大滞后：任何单元最晚在到达后这么久开始淡入，也封住单帧大批量的累计延迟。 */
const REVEAL_MAX_LAG_MS = 250;
/** 快模型的目标滞后下限：再小就没有缓冲，突发会挤成一块。 */
const REVEAL_MIN_LAG_MS = 80;
/** 目标滞后 ≈ 这么多个单元的到达时间。 */
const REVEAL_LAG_UNITS = 6;
/** 同时不小于相邻两批到达间隔的这么多倍，盖住批间空档。 */
const REVEAL_LAG_GAP_FACTOR = 1.5;
/** 队列已超过目标滞后时，每批至少铺开这么久，逐步回落，不同时起跳。 */
const REVEAL_MIN_SPREAD_MS = 15;
/** 两批到达间隔超过它视为停顿，不更新到达速度。 */
const REVEAL_PAUSE_MS = 300;
/** 到达速度 EWMA 的系数。 */
const REVEAL_RATE_ALPHA = 0.3;
/** 两轮提交挨得太近时按这个间隔估速，避免瞬时速度虚高。 */
const REVEAL_MIN_GAP_MS = 10;
/** 还没有速度参照时，按一帧估这批单元的到达间隔。 */
const REVEAL_FIRST_WINDOW_MS = 30;
/** 单帧源文本增量超过它就不是 live delta（而是回填 / 切会话），整条不动画。 */
const REVEAL_MAX_DELTA_CHARS = 600;
/** 超过这个长度整条退回静态渲染：每次 delta 重建 reveal 树在长文上不值得。 */
const REVEAL_MAX_CHARS = 8000;
/** 自适应降级：连续几次更新超过这个耗时，就认定这台机器/这段正文吃不下逐字。 */
const REVEAL_SLOW_MS = 28;
const REVEAL_SLOW_STREAK = 3;
/** 不逐字的位置：代码块、SVG、公式。 */
const REVEAL_SKIP_TAGS = new Set(["pre", "svg", "math"]);
/** 兜底分词（没有 Intl.Segmenter 时）。 */
const REVEAL_FALLBACK_WORD_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
/** 只合并"拉丁词续写"：中文没有空格，按非空白合并会把整段吸进一个 span。 */
const REVEAL_LATIN_WORD_RE = /^[A-Za-z0-9_]+$/;
/** 中日文字符：即使 ICU 把「拍板」切成一个词，也要拆成单字。 */
const REVEAL_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** 不该被 reveal 包住的元素：复制按钮 / 语言标签的文本不是正文。 */
const REVEAL_OPAQUE_SELECTOR = "pre, svg, math, button, .code-lang";

let cachedWordSegmenter;

function getWordSegmenter() {
  if (cachedWordSegmenter !== undefined) return cachedWordSegmenter;
  cachedWordSegmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
  return cachedWordSegmenter;
}

/**
 * 拉丁文按单词，中日文按单字。
 * Segmenter 按模块缓存：每帧 new 一个的构造成本在流式里不可接受。
 */
export function segmentRevealUnits(text) {
  const source = String(text || "");
  if (!source) return [];
  const segmenter = getWordSegmenter();
  const words = segmenter
    ? Array.from(segmenter.segment(source), ({ segment }) => segment)
    : source.match(REVEAL_FALLBACK_WORD_RE) || [source];
  const units = [];
  for (const word of words) {
    if (REVEAL_CJK_RE.test(word)) units.push(...Array.from(word));
    else units.push(word);
  }
  return units;
}

/**
 * 只有"纯追加、增量不过大"才逐字；回填 / 切会话 / 模型重写整段不动画。
 * 首帧 previous 为空串，算追加。
 */
export function isIncrementalRevealSource(previous, next) {
  const before = String(previous || "");
  const after = String(next || "");
  return (
    after.length > before.length &&
    after.length - before.length <= REVEAL_MAX_DELTA_CHARS &&
    after.startsWith(before)
  );
}

/** 跨帧浮现时钟的状态。纯数据，方便单测。 */
export function createRevealClock() {
  return {
    /** 最后一个已排定单元的开始时间（performance.now 时间线）。 */
    clock: Number.NEGATIVE_INFINITY,
    /** 到达速度（单元 / ms）的 EWMA；还没有参照时为 undefined。 */
    rate: undefined,
    /** 相邻两轮新单元到达间隔（ms）的 EWMA。 */
    gap: undefined,
    /** 上一轮新单元到达的时间。 */
    arrival: Number.NEGATIVE_INFINITY,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 给本帧新到的 count 个单元排期，返回第一个单元开始时间与相邻间隔。
 *
 * - 吐得慢：可用时间充裕，间隔取上限 40ms，逐字可辨；
 * - 积压变多：可用时间变少，间隔自动缩短；队列超过目标滞后时每批仍至少铺开 15ms，
 *   逐步回落，不同时起跳；
 * - 目标滞后按到达速度缩放，缓冲约 6 个单元，快模型不会被积压拖到 460ms 才看清。
 *
 * 只排 delay，不跑 rAF / timer；DOM 文本仍然一次性完整。
 */
export function planRevealSchedule(state, count, now = performance.now()) {
  const units = Math.max(0, Math.floor(count));
  if (units === 0) return null;
  const perUnit = state.rate !== undefined ? 1 / state.rate : REVEAL_FIRST_WINDOW_MS / units;
  const lag = clamp(
    Math.max(REVEAL_LAG_UNITS * perUnit, REVEAL_LAG_GAP_FACTOR * (state.gap ?? 0)),
    REVEAL_MIN_LAG_MS,
    REVEAL_MAX_LAG_MS,
  );
  // 队尾：最后一个已排定单元的开始时间，不早于现在。
  const tail = Math.max(state.clock, now);
  const ceiling = Math.max(0, now + REVEAL_MAX_LAG_MS - tail);
  const available = Math.min(ceiling, Math.max(now + lag - tail, REVEAL_MIN_SPREAD_MS));
  const interval = Math.min(REVEAL_MAX_INTERVAL_MS, available / units);
  const start = Math.max(now, state.clock + interval);
  const end = start + (units - 1) * interval;

  // 到达速度只在连续输出时更新：停顿后的第一批沿用停顿前的速度，
  // 否则停顿会把速度估成极慢，突发的整句又被按慢节奏排满。
  const gap = now - state.arrival;
  if (gap <= REVEAL_PAUSE_MS) {
    const instant = units / Math.max(gap, REVEAL_MIN_GAP_MS);
    state.rate = state.rate === undefined
      ? instant
      : state.rate + (instant - state.rate) * REVEAL_RATE_ALPHA;
    state.gap = state.gap === undefined
      ? gap
      : state.gap + (gap - state.gap) * REVEAL_RATE_ALPHA;
  }
  state.arrival = now;
  state.clock = Math.max(state.clock, end);
  return { now, start, interval, end, count: units };
}

/* ── DOM 部分 ───────────────────────────────────────────────── */

function isRevealSpan(node) {
  return node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-reveal");
}

function isRunPart(node) {
  return node.nodeType === Node.TEXT_NODE || isRevealSpan(node);
}

function nodesText(nodes) {
  let text = "";
  for (const node of nodes) text += node.textContent || "";
  return text;
}

function isOpaque(element) {
  return element.nodeType === Node.ELEMENT_NODE && element.matches(REVEAL_OPAQUE_SELECTOR);
}

function sameElement(left, right) {
  if (left.tagName !== right.tagName) return false;
  if (left.attributes.length !== right.attributes.length) return false;
  for (const attribute of left.attributes) {
    if (right.getAttribute(attribute.name) !== attribute.value) return false;
  }
  return true;
}

/**
 * 把 renderMarkdown 的输出变成"每个非空白单元一个 span"的 reveal 树。
 * 每个 span 记绝对文本偏移；偏移用来判断"这是上一轮已有的文字，还是新到的"。
 * pre / svg / math / 按钮 / 语言标签只计偏移、不包 span。
 */
function buildRevealTree(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = template.content;
  let offset = 0;

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue || "";
      if (!text) return;
      const parent = node.parentNode;
      if (!parent || (parent.nodeType === Node.ELEMENT_NODE && parent.matches(REVEAL_OPAQUE_SELECTOR))) {
        offset += text.length;
        return;
      }
      const units = segmentRevealUnits(text);
      const replacement = document.createDocumentFragment();
      let cursor = 0;
      for (const unit of units) {
        if (!unit) continue;
        if (!unit.trim()) {
          replacement.append(document.createTextNode(unit));
        } else {
          const span = document.createElement("span");
          span.dataset.reveal = "settled";
          span.dataset.offset = String(offset + cursor);
          span.textContent = unit;
          replacement.append(span);
        }
        cursor += unit.length;
      }
      offset += text.length;
      node.replaceWith(replacement);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (REVEAL_SKIP_TAGS.has(tag) || node.matches("button, .code-lang")) {
      offset += node.textContent.length;
      return;
    }
    // 行内 code 整个作为一个单元淡入；代码块（pre > code）已在上面整段跳过。
    if (tag === "code" && !node.closest("pre")) {
      const text = node.textContent || "";
      if (text) {
        node.textContent = "";
        const span = document.createElement("span");
        span.dataset.reveal = "settled";
        span.dataset.offset = String(offset);
        span.textContent = text;
        node.append(span);
        offset += text.length;
      }
      return;
    }
    for (const child of [...node.childNodes]) walk(child);
  };

  for (const child of [...fragment.childNodes]) walk(child);
  fragment.__textLength = offset;
  return fragment;
}

function collectItems(parent) {
  const items = [];
  let run = null;
  for (const child of [...parent.childNodes]) {
    if (isRunPart(child)) {
      if (!run) {
        run = { kind: "run", nodes: [] };
        items.push(run);
      }
      run.nodes.push(child);
    } else {
      run = null;
      items.push({ kind: "node", node: child });
    }
  }
  return items;
}

function buildRunNodes(text, offset, fresh) {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const unit of segmentRevealUnits(text)) {
    if (!unit) continue;
    if (!unit.trim()) {
      fragment.append(document.createTextNode(unit));
    } else {
      const span = document.createElement("span");
      span.dataset.reveal = "new";
      span.dataset.offset = String(offset + cursor);
      span.textContent = unit;
      fresh.push(span);
      fragment.append(span);
    }
    cursor += unit.length;
  }
  return fragment;
}

/** 把新树里偏移越过上一轮文本长度的 span 标成 new；旧文字保持 settled，不重播。 */
function collectFresh(root, context) {
  const visit = (node) => {
    if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-reveal")) {
      if (Number(node.dataset.offset) >= context.previousTextLength) {
        node.dataset.reveal = "new";
        context.fresh.push(node);
      }
      return;
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(root);
}

function reconcileRun(oldItem, newItem, context) {
  const oldNodes = oldItem.nodes;
  const newNodes = newItem.nodes;
  const oldText = nodesText(oldNodes);
  const newText = nodesText(newNodes);
  if (newText === oldText) return;

  if (newText.startsWith(oldText)) {
    let delta = newText.slice(oldText.length);
    const last = oldNodes[oldNodes.length - 1];
    // 拉丁词常被拆成几段送达：最后一个旧 span 直接吸收本次增量里的拉丁词前缀，
    // 不新建 span，这样 "wor" → "world" 不会把一个词拆成两段不同步的淡入。
    // 只认拉丁：[A-Za-z0-9_]。中文没有空格，若按"非空白"合并，"你好世界" 会整段
    // 吸进一个 span，逐字效果直接消失（2026-11-13 实测抓到的 bug）。
    if (isRevealSpan(last) && delta && !/^\s/.test(delta)) {
      const head = delta.match(/^\S+/)?.[0] || "";
      const latin = head.match(/^[A-Za-z0-9_]+/)?.[0] || "";
      if (latin && REVEAL_LATIN_WORD_RE.test(last.textContent)) {
        last.textContent += latin;
        delta = delta.slice(latin.length);
      }
    }
    if (delta) {
      const offset = context.previousTextLength + oldText.length;
      last.after(buildRunNodes(delta, offset, context.fresh));
    }
    return;
  }

  // 非前缀：只替换这一段文字（例如 ** 闭合后结构变了）。旧文字按偏移标 settled，
  // 只有越过上一轮长度的单元才淡入；整块 DOM 被重建，已有文字的透明度不重播。
  const reference = oldNodes[0];
  if (!reference || !reference.parentNode) return;
  const replacement = document.createDocumentFragment();
  for (const node of newNodes) {
    collectFresh(node, context);
    replacement.append(node);
  }
  reference.replaceWith(replacement);
  for (let index = 1; index < oldNodes.length; index += 1) oldNodes[index].remove();
}

function reconcileNode(oldNode, newNode, context) {
  if (oldNode.nodeType === Node.TEXT_NODE && newNode.nodeType === Node.TEXT_NODE) {
    const before = oldNode.nodeValue || "";
    const after = newNode.nodeValue || "";
    if (after === before) return;
    if (after.startsWith(before)) {
      oldNode.nodeValue = after;
      return;
    }
    oldNode.replaceWith(newNode);
    return;
  }
  if (oldNode.nodeType !== Node.ELEMENT_NODE || newNode.nodeType !== Node.ELEMENT_NODE) {
    if (oldNode.outerHTML !== newNode.outerHTML) oldNode.replaceWith(newNode);
    return;
  }
  if (isOpaque(oldNode) || !sameElement(oldNode, newNode)) {
    if (oldNode.outerHTML !== newNode.outerHTML) {
      collectFresh(newNode, context);
      oldNode.replaceWith(newNode);
    }
    return;
  }
  reconcileChildren(oldNode, newNode, context);
}

function replaceItem(oldItem, newItem, context) {
  const oldNodes = oldItem.kind === "run" ? oldItem.nodes : [oldItem.node];
  const reference = oldNodes[0];
  if (!reference || !reference.parentNode) return;
  const replacement = document.createDocumentFragment();
  const newNodes = newItem.kind === "run" ? newItem.nodes : [newItem.node];
  for (const node of newNodes) {
    collectFresh(node, context);
    replacement.append(node);
  }
  reference.replaceWith(replacement);
  for (let index = 1; index < oldNodes.length; index += 1) oldNodes[index].remove();
}

function appendItem(parent, item, context) {
  const newNodes = item.kind === "run" ? item.nodes : [item.node];
  for (const node of newNodes) {
    collectFresh(node, context);
    parent.append(node);
  }
}

function removeItem(item) {
  const nodes = item.kind === "run" ? item.nodes : [item.node];
  for (const node of nodes) node.remove();
}

function reconcileChildren(oldParent, newParent, context) {
  const oldItems = collectItems(oldParent);
  const newItems = collectItems(newParent);
  let oldIndex = 0;
  let newIndex = 0;
  while (newIndex < newItems.length) {
    const oldItem = oldItems[oldIndex];
    const newItem = newItems[newIndex];
    if (!oldItem) {
      appendItem(oldParent, newItem, context);
      newIndex += 1;
      continue;
    }
    if (oldItem.kind === "run" && newItem.kind === "run") {
      reconcileRun(oldItem, newItem, context);
    } else if (oldItem.kind === "node" && newItem.kind === "node") {
      reconcileNode(oldItem.node, newItem.node, context);
    } else {
      replaceItem(oldItem, newItem, context);
    }
    oldIndex += 1;
    newIndex += 1;
  }
  while (oldIndex < oldItems.length) {
    removeItem(oldItems[oldIndex]);
    oldIndex += 1;
  }
}

/**
 * 创建一条助手消息的流式渲染器。
 *
 * @param {HTMLElement} body 助手消息的正文容器（只会被塞 markdown 节点）
 * @param {(source: string) => string} renderHtml 现有 renderMarkdown
 * @param {() => boolean} canAnimate 运行时可动开关（flag / prefers-reduced-motion）
 */
export function createStreamRevealer({ body, renderHtml, canAnimate }) {
  let previousSource = "";
  let textLength = 0;
  let clock = createRevealClock();
  let staticMode = false;
  let slowStreak = 0;

  const renderStatic = (source) => {
    staticMode = true;
    body.innerHTML = renderHtml(source);
    previousSource = source;
    textLength = 0;
  };

  return {
    update(source) {
      const next = String(source || "");
      if (next === previousSource) return;
      if (
        staticMode ||
        next.length > REVEAL_MAX_CHARS ||
        !isIncrementalRevealSource(previousSource, next) ||
        (canAnimate && !canAnimate())
      ) {
        renderStatic(next);
        return;
      }

      const startedAt = performance.now();
      const tree = buildRevealTree(renderHtml(next));
      const context = { previousTextLength: textLength, fresh: [] };
      reconcileChildren(body, tree, context);
      previousSource = next;
      textLength = tree.__textLength || 0;

      if (context.fresh.length) {
        const plan = planRevealSchedule(clock, context.fresh.length, performance.now());
        if (plan) {
          for (let index = 0; index < context.fresh.length; index += 1) {
            const delay = plan.start + index * plan.interval - plan.now;
            context.fresh[index].style.setProperty("--reveal-delay", `${delay.toFixed(1)}ms`);
          }
        }
      }

      // 长段落 / 慢机器兜底：连续三次更新超过 20ms，说明逐字已经会影响顺滑，
      // 立刻整段落定成静态。文字本来就是完整的，切换不会丢内容，只少一段尾巴。
      slowStreak = performance.now() - startedAt > REVEAL_SLOW_MS ? slowStreak + 1 : 0;
      if (slowStreak >= REVEAL_SLOW_STREAK) {
        slowStreak = 0;
        renderStatic(next);
      }
    },

    /** 收尾：完整重渲染一次，去掉所有 span；与 ZCode 结束后切 static 一致。 */
    finish(source) {
      body.innerHTML = renderHtml(String(source || ""));
      previousSource = String(source || "");
      textLength = 0;
    },

    /** 中间话折进工作过程后正文清零：下一段从新状态重新开始。 */
    reset() {
      body.replaceChildren();
      previousSource = "";
      textLength = 0;
      clock = createRevealClock();
      staticMode = false;
      slowStreak = 0;
    },
  };
}
