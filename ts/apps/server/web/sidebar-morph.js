/**
 * 侧栏收起/展开的图标飞行（2026-11-25）
 *
 * 展开层（.sidebar-inner）与收起轨道（.side-rail）是两套元素，宽度动画期间本来靠
 * 交叉淡入淡出交接：旧图标先淡出、新图标再淡入，看起来就是「消失后重新生成一个」。
 * 用户口径：同一个图标要全程可见，跟着侧栏走。
 *
 * 做法：动画期间把 .side-rail 锁成收起宽度（不然它居中，图标会随列宽右移）、强制可见，
 * 只让图标本体按测得的位移/缩放飞向展开层自己的槽位；展开层对应的图标先藏住（占位不撤，
 * 布局不跳）。落定那一帧同一位置交换两层，动画里始终只有一个图标。
 *
 * 回滚：`?iconflight=off`，或 localStorage `lifediary.sidebarIconFlight = "off"`，
 * 刷新后回到原来的交叉淡入淡出。prefers-reduced-motion 同样直接跳过。
 */

import { el } from "./dom.js";

/* 轨道按钮里的图标本体 ↔ 展开层同一图标的槽位。
   顺序与 index.html 的注释一致；项目图标在无项目时 hidden，量不到就整对跳过。 */
const PAIRS = [
  ["#rail-chief .pt-avatar", "#chief-avatar"],
  ["#rail-partners svg", "#sec-partners-toggle .sec-ico"],
  ["#rail-chats svg", "#sec-chats-toggle .sec-ico"],
  ["#rail-proj svg", "#sec-projects-toggle .sec-ico"],
  ["#rail-groups svg", "#sec-groups-toggle .sec-ico"],
  ["#rail-settings svg", "#open-settings svg"],
];

/* 与 style-02-sidebar.css 里 .sidebar 的宽度过渡成对：展开 360ms 减速、收起 250ms 加速。 */
const OPEN_MS = 360;
const CLOSE_MS = 250;
const OPEN_EASE = "cubic-bezier(0, 0, .2, 1)";
const CLOSE_EASE = "cubic-bezier(.16, 1, .3, 1)";

const noMotion = matchMedia("(prefers-reduced-motion: reduce)");
let flight = null;
let sequence = 0;

function flightEnabled() {
  if (noMotion.matches) return false;
  if (localStorage.getItem("lifediary.sidebarIconFlight") === "off") return false;
  return new URLSearchParams(location.search).get("iconflight") !== "off";
}

function layoutPairs() {
  return PAIRS.map(([rail, inner]) => ({
    rail: document.querySelector(rail),
    inner: document.querySelector(inner),
  })).filter(({ rail, inner }) => rail && inner);
}

function laidOut(node) {
  return node.getClientRects().length > 0;
}

/** 以中心点 + 宽度描述盒子：translate 按中心算，scale 绕中心缩放，两者互不干扰。 */
function boxOf(node) {
  const r = node.getBoundingClientRect();
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width };
}

function offsetOf(base, target) {
  const scale = base.w > 0 ? target.w / base.w : 1;
  const dx = (target.cx - base.cx).toFixed(2);
  const dy = (target.cy - base.cy).toFixed(2);
  return `translate(${dx}px, ${dy}px) scale(${scale.toFixed(4)})`;
}

/**
 * 图标的「有效透明度」= 自己到所在层为止的 opacity 乘积。
 * 轨道层与展开层的层本身在动画里各自淡入淡出，不参与比较；
 * 只算按钮/分区头这一级（禁用的群组：轨道 .38、展开头 .5）。
 */
function effectiveOpacity(node) {
  let opacity = 1;
  for (let n = node; n; n = n.parentElement) {
    if (n.classList.contains("side-rail") || n.classList.contains("sidebar-inner")) break;
    // 占位类是飞行自己挂的（opacity:0），反向切换时它还在，不能当成目标的真实透明度
    if (!n.classList.contains("is-flight-hidden")) {
      opacity *= Number(getComputedStyle(n).opacity);
    }
  }
  return opacity;
}

/**
 * 窄屏收起态 .sidebar-inner 是 display:none，展开槽位量不到；
 * 临时摊开、量完立刻还原——同一个任务里完成，不会画出来。
 */
function measureInner(fn) {
  const inner = el.sidebarInner;
  const hidden = getComputedStyle(inner).display === "none";
  if (!hidden) return fn();
  const prevDisplay = inner.style.display;
  const prevVisibility = inner.style.visibility;
  inner.style.display = "flex";
  inner.style.visibility = "hidden";
  try {
    return fn();
  } finally {
    inner.style.display = prevDisplay;
    inner.style.visibility = prevVisibility;
  }
}

function clearGlyphs() {
  for (const { rail, inner } of layoutPairs()) {
    const button = rail.closest(".rail-btn");
    if (button) button.style.opacity = "";
    rail.style.transition = "none";
    rail.style.transform = "";
    rail.style.transformOrigin = "";
    rail.style.color = "";
    rail.style.opacity = "";
    rail.style.willChange = "";
    inner.classList.remove("is-flight-hidden");
  }
}

/**
 * 落定：先交换图层、再恢复普通过渡。
 * 展开时轨道层要立刻变成不可见；若先摘类再改 opacity，CSS 的 180ms 淡出会跑起来，
 * 在轨道槽位留下一批正在淡出的重影——所以用 .is-icon-flight-end 把它钉在 opacity:0，
 * 强制一次样式后摘类（前后值相同，不触发过渡）。
 */
function settle() {
  if (!flight) return;
  clearTimeout(flight.timer);
  flight = null;
  const sidebar = el.sideRail.parentElement;
  const open = document.documentElement.dataset.sidebar !== "closed";

  el.sideRail.style.transition = "none";
  el.sideRail.style.opacity = open ? "0" : "1";
  if (open) sidebar.classList.add("is-icon-flight-end");
  sidebar.classList.remove("is-icon-flight");

  clearGlyphs();

  void el.sideRail.offsetWidth;
  el.sideRail.style.transition = "";
  el.sideRail.style.opacity = "";
  sidebar.classList.remove("is-icon-flight-end");
  void el.sideRail.offsetWidth;
  /* transform 已落定，再把 clearGlyphs 里压过渡的 transition:none 收回，
     别把内联样式留在图标上（下一轮飞行会自己写 duration）。 */
  for (const { rail } of layoutPairs()) rail.style.transition = "";
}

/**
 * 由 shell.js 的 toggleSidebar 在写完 data-sidebar 后调用。
 * @param {boolean} expanding 目标态是否为展开（true = 收起 → 展开）
 */
export function animateSidebarIcons(expanding) {
  if (!el.sideRail || !el.sidebarInner) return;
  /* 内容淡入延后只跟飞行一起生效（样式在 style-02-sidebar.css 里按这个属性选）；
     回滚关掉飞行时淡入回到原来的 80ms 起跳，两处口径不拆开。 */
  const enabled = flightEnabled();
  document.documentElement.dataset.sidebarFlight = enabled ? "on" : "off";
  if (!enabled) {
    settle();
    return;
  }

  const sidebar = el.sideRail.parentElement;
  /* 反向切换（动画没完又点）：先记下当前帧，接着飞回去，图标不跳。 */
  const midRects = flight
    ? new Map(flight.items.map(({ rail }) => [rail, boxOf(rail)]))
    : null;

  const all = layoutPairs();
  const innerRects = measureInner(() =>
    new Map(all.map(({ inner }) => [inner, laidOut(inner) ? boxOf(inner) : null])),
  );

  const items = all.filter(({ rail, inner }) => laidOut(rail) && innerRects.get(inner));
  if (!items.length) {
    settle();
    return;
  }

  clearTimeout(flight?.timer);
  sidebar.classList.remove("is-icon-flight-end");
  sidebar.classList.add("is-icon-flight");

  /* 目标颜色/有效透明度必须在挂占位类之前取：is-flight-hidden 会把目标图标自己置 0，
     之后取会把「飞到 0」当成目标（2026-11-25 首版踩过）。 */
  const targetStyles = new Map(
    items.map(({ inner }) => [
      inner,
      { color: getComputedStyle(inner).color, opacity: effectiveOpacity(inner) },
    ]),
  );

  const hidden = new Set(items.map(({ inner }) => inner));
  for (const { inner } of all) {
    inner.classList.toggle("is-flight-hidden", hidden.has(inner));
  }

  /* 先摘掉上一轮的位移、量出「收起槽位」；反向切换的起点用 midRects 补回来。 */
  const participating = new Set(items.map(({ rail }) => rail));
  for (const { rail } of all) {
    rail.style.transition = "none";
    rail.style.transform = "";
    if (participating.has(rail)) continue;
    // 上一轮参与、这一轮被跳过的图标（例如项目钮转 hidden）：把颜色/透明度也收回
    const button = rail.closest(".rail-btn");
    if (button) button.style.opacity = "";
    rail.style.color = "";
    rail.style.opacity = "";
    rail.style.willChange = "";
  }
  void el.sideRail.offsetWidth;

  const entries = items.map(({ rail, inner }) => {
    const base = boxOf(rail);
    const innerRect = innerRects.get(inner);
    const from = midRects?.get(rail) ?? (expanding ? base : innerRect);
    const to = expanding ? innerRect : base;
    /* 颜色与有效透明度也一起过：分区图标轨道是 text-2、展开是 text-3；
       群组是禁用占位，两边 .38 / .5 不一样。只飞位置会在换手那一帧跳色。 */
    const fromColor = getComputedStyle(rail).color;
    const toColor = targetStyles.get(inner).color;
    const fromOpacity = effectiveOpacity(rail);
    const toOpacity = targetStyles.get(inner).opacity;
    const button = rail.closest(".rail-btn");
    // 轨道按钮自己的 opacity 先摘掉，改由图标本体承载，才能从 .38 过渡到 .5
    if (button) button.style.opacity = "1";
    rail.style.color = fromColor;
    rail.style.opacity = String(fromOpacity);
    rail.style.transformOrigin = "50% 50%";
    rail.style.willChange = "transform, color, opacity";
    rail.style.transform = offsetOf(base, from);
    return { rail, base, to, toColor, toOpacity };
  });
  void el.sideRail.offsetWidth;

  const duration = expanding ? OPEN_MS : CLOSE_MS;
  const ease = expanding ? OPEN_EASE : CLOSE_EASE;
  for (const entry of entries) {
    entry.rail.style.transition =
      `transform ${duration}ms ${ease}, color ${duration}ms ${ease}, opacity ${duration}ms ${ease}`;
    entry.rail.style.transform = offsetOf(entry.base, entry.to);
    entry.rail.style.color = entry.toColor;
    entry.rail.style.opacity = String(entry.toOpacity);
  }

  const token = ++sequence;
  flight = {
    token,
    items: items.map(({ rail }) => ({ rail })),
    timer: setTimeout(() => {
      if (flight?.token === token) settle();
    }, duration + 30),
  };
}
