/**
 * 布局调试（2026-11-24，开发期工具，纯前端）
 *
 * 两件事，都只服务「隔着屏幕调布局」：
 *   1. 描边：插件中心「布局调试描边」（DEV_LAYOUT_INSPECT）开着时给 <html> 加 class
 *      `dev-box`，样式在 style-29-dev-inspect.css；关掉刷新页面即完全恢复。
 *   2. 盒树：`window.__boxTree()` 返回一张文本盒树表（层级 / 选择器 / 位置尺寸 /
 *      padding / margin / gap / overflow），可以直接贴进对话让 agent 量测。
 *      只读、不渲染，所以不设开关，页面里随时可调。
 *
 * 为什么是文本表而不是截图：截图只能看个大概，容器一多就分不清内边距是谁的；
 * 文本表能直接对着数字改 CSS，也方便整段贴给模型。
 *
 * 刻意不做：
 * - 不给盒子编号：DOM 是 JS 动态拼的，编号刷新就漂，反而误导定位；
 * - 不做点击拾取器：要挂全局事件、和页面既有交互打架，而一次盒树表通常已经够用；
 * - 不做 URL 参数开关：入口只留插件中心，开关口径与回滚都走同一处。
 */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]);

/** 间距统一保留 1 位小数：rem 换算常带小数，整数化会把 0.5px 抹成 0。 */
function fmt(value) {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded === 0 ? 0 : rounded);
}

function readPx(style, property) {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

/**
 * 四边压成 CSS 简写：全同 1 个值、上下 / 左右各自相同 2 个值、否则 4 个值（上右下左）。
 * 全零返回空串，调用方据此整段不输出（`p:0` 没有信息量）。
 */
function sidesText(style, kind) {
  const top = readPx(style, `${kind}-top`);
  const right = readPx(style, `${kind}-right`);
  const bottom = readPx(style, `${kind}-bottom`);
  const left = readPx(style, `${kind}-left`);
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return "";
  if (top === bottom && right === left) {
    return top === left ? fmt(top) : `${fmt(top)} ${fmt(left)}`;
  }
  return `${fmt(top)} ${fmt(right)} ${fmt(bottom)} ${fmt(left)}`;
}

/** 只在有间距时输出；row / column 不同则按 `gap:row column`（CSS gap 简写的顺序）。 */
function gapText(style) {
  const row = readPx(style, "row-gap");
  const column = readPx(style, "column-gap");
  if (row === 0 && column === 0) return "";
  return row === column ? fmt(row) : `${fmt(row)} ${fmt(column)}`;
}

/** 只在任一轴不是 visible 时输出；相同写一个值，不同按 `ov:x y`。 */
function overflowText(style) {
  const x = style.getPropertyValue("overflow-x");
  const y = style.getPropertyValue("overflow-y");
  if (x === "visible" && y === "visible") return "";
  return x === y ? x : `${x} ${y}`;
}

/** 选择器只用于辨认，不保证能 querySelector 回来：id + 前 3 个 class，多出的记 +N。 */
function selectorText(el) {
  let out = el.tagName.toLowerCase();
  if (el.id) out += `#${el.id}`;
  const classes = Array.from(el.classList);
  if (classes.length > 0) {
    out += `.${classes.slice(0, 3).join(".")}`;
    if (classes.length > 3) out += `+${classes.length - 3}`;
  }
  return out;
}

/** 一个盒子一行；不渲染（display:none / visibility:hidden / 尺寸≈0）返回 null。 */
function nodeLine(el, depth) {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;
  // 一个节点只量一次：量测期间不改 DOM，不会触发重排循环。
  const rect = el.getBoundingClientRect();
  if (rect.width < 0.5 || rect.height < 0.5) return null;

  const parts = [
    selectorText(el),
    `[${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}×${Math.round(rect.height)}]`,
  ];
  const padding = sidesText(style, "padding");
  if (padding) parts.push(`p:${padding}`);
  const margin = sidesText(style, "margin");
  if (margin) parts.push(`m:${margin}`);
  const gap = gapText(style);
  if (gap) parts.push(`gap:${gap}`);
  const overflow = overflowText(style);
  if (overflow) parts.push(`ov:${overflow}`);

  return `${"  ".repeat(depth)}${parts.join(" ")}`;
}

function walk(el, depth, options) {
  if (options.truncated) return;
  if (!el.isConnected) return;

  const overDepth = depth > options.maxDepth;
  let line = null;
  if (!SKIP_TAGS.has(el.tagName)) line = nodeLine(el, depth);
  if (line !== null) {
    if (options.lines.length >= options.maxLines) {
      options.truncated = true;
      return;
    }
    options.lines.push(overDepth ? `${line} …` : line);
  }
  if (overDepth) return;

  // 没盒子的节点（display:contents、零高容器、visibility:hidden）只跳过它自己这一行，
  // 子节点仍要下钻：可见子节点可能还在（绝对定位、子元素覆盖 visibility）。
  for (const child of el.children) walk(child, depth + 1, options);
}

function boxTree(rawOptions = {}) {
  const opts = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const selector = typeof opts.selector === "string" && opts.selector ? opts.selector : "body";
  const maxDepthRaw = Number(opts.maxDepth);
  const maxLinesRaw = Number(opts.maxLines);
  const maxDepth = Number.isFinite(maxDepthRaw) ? Math.max(0, Math.floor(maxDepthRaw)) : 8;
  const maxLines = Number.isFinite(maxLinesRaw) ? Math.max(1, Math.floor(maxLinesRaw)) : 400;

  const root = document.querySelector(selector);
  if (!root) return `未找到：${selector}`;

  const options = { maxDepth, maxLines, lines: [], truncated: false };
  walk(root, 0, options);

  const text = options.lines.join("\n");
  if (!options.truncated) return text;
  return `${text}\n…（已截断，已输出 ${options.lines.length} 行；调大 __boxTree({maxLines: 2000})）`;
}

/**
 * 页面入口：`initDevInspect({ outline: true })` 画描边；不传参数只挂盒树探针。
 * 重复调用无副作用（class 与全局函数都是幂等的）。
 */
export function initDevInspect(options = {}) {
  if (options && options.outline === true) {
    document.documentElement.classList.add("dev-box");
  }
  window.__boxTree = boxTree;
}
