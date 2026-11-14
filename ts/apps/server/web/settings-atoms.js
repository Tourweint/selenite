/**
 * 设置页原子：row / switch / segmented / section
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { attr } from "./markdown.js";

function rowMarkup(label, hint, control, { inlineHint = false } = {}) {
  const tipAttr = hint && !inlineHint ? ` data-tip="${attr(hint)}"` : "";
  return `<div class="row">
    <div class="row-main">
      <div class="row-label"${tipAttr}>${label}</div>
      ${hint && inlineHint ? `<div class="row-hint">${hint}</div>` : ""}
    </div>
    <div class="row-control">${control}</div>
  </div>`;
}

/** 通用开关（2026-11-05 G1）：设置页所有布尔项共用这一份结构，
 *  几何/形变对齐 CINDY components/ui/switch（36×20 轨道、16px thumb、
 *  hover 17px / 按下 18×14）。行为（写哪个 key、要不要打接口）由各自的 click 监听决定。 */
function switchMarkup(checked, { label, attrs = "" } = {}) {
  return `<button class="switch" type="button" role="switch"
    aria-checked="${checked ? "true" : "false"}" aria-label="${label || ""}" ${attrs}>
    <span class="switch-thumb" aria-hidden="true"></span>
  </button>`;
}

/** 程序化回填开关状态（不是用户点的那一下）：默认不跑过渡。
 *  设置页每次进子页都重建 DOM，先按缺省描一版、等 flags 回来再回填真值——走过渡的话
 *  每次进页都滑一次，被误读成"它自己又开了一次"。写法同 syncSegmented 的首帧：
 *  先挂 data-no-anim 关过渡、写值、强制回流，再摘掉，终态就地落地。 */
function setSwitchChecked(switchEl, checked, { animate = false } = {}) {
  if (!switchEl) return;
  if (animate) {
    switchEl.setAttribute("aria-checked", String(Boolean(checked)));
    return;
  }
  switchEl.setAttribute("data-no-anim", "1");
  switchEl.setAttribute("aria-checked", String(Boolean(checked)));
  void switchEl.offsetWidth; // 强制回流：无过渡的终态先落地，摘掉标记时才不会补跑动画
  switchEl.removeAttribute("data-no-anim");
}

/*
 * 分段控件共享滑行高亮（2026-11-05 H1）。
 * 结构照 CINDY components/ui/segmented-control.tsx：容器 relative，第一个子元素是
 * aria-hidden 的绝对定位小胶囊；选中按钮的 offset 量出来写进 transform / width / height，
 * 由 CSS 的 200ms ease-move 过渡负责滑动。任何 `.segmented.slide` 都能复用，
 * 不绑定权限那一处；没加 .slide 的老分段控件仍是原来的瞬时高亮。
 */
function segmentedPlateOf(root) {
  let plate = root.querySelector(":scope > .segmented-plate");
  if (!plate) {
    plate = document.createElement("span");
    plate.className = "segmented-plate";
    plate.setAttribute("aria-hidden", "true");
    root.insertBefore(plate, root.firstChild);
  }
  return plate;
}

/** 把胶囊挪到当前 aria-checked=true 的按钮上；没有选中项就藏起来 */
function syncSegmented(root, { animate = true } = {}) {
  if (!root) return;
  const plate = segmentedPlateOf(root);
  const active = Array.from(root.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-checked") === "true",
  );
  if (!active) {
    root.removeAttribute("data-plate");
    return;
  }
  const rootRect = root.getBoundingClientRect();
  const buttonRect = active.getBoundingClientRect();
  // 面板隐藏时量出来全是 0：先不定位，等 ResizeObserver 在可见时再量
  if (!buttonRect.width || !buttonRect.height) return;
  // 绝对定位的 left/top 原点是 padding box，getBoundingClientRect 是 border box，
  // 所以减掉容器 border（clientLeft/clientTop），否则会差 1px。
  const x = buttonRect.left - rootRect.left - root.clientLeft;
  const y = buttonRect.top - rootRect.top - root.clientTop;
  const first = !root.hasAttribute("data-plate");
  if (first || !animate) {
    // 首帧/无动画：先关过渡再写值，写完强制回流，然后恢复过渡（不会从 (0,0) 滑进来）
    plate.style.transition = "none";
  }
  plate.style.transform = `translate(${x}px, ${y}px)`;
  plate.style.width = `${buttonRect.width}px`;
  plate.style.height = `${buttonRect.height}px`;
  if (first || !animate) {
    void plate.offsetWidth;
    plate.style.transition = "";
    root.setAttribute("data-plate", "ready");
  }
}

/** 只挂一次：首次定位 + 窗口/字体/标签变化时重新量（尺寸变化不做滑行动画） */
function mountSegmented(root) {
  if (!root || root.dataset.segmentedMounted === "1") return;
  root.dataset.segmentedMounted = "1";
  syncSegmented(root, { animate: false });
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => syncSegmented(root, { animate: false }));
    observer.observe(root);
    for (const button of root.querySelectorAll("button")) observer.observe(button);
  } else {
    window.addEventListener("resize", () => syncSegmented(root, { animate: false }));
  }
}

/** 一节 = 标题在卡片外 + 卡片；节距/标题-卡片间距由 .set-sec 定（cindy 的节律） */
/** 分节标题；`action` 是标题右边那一颗钮（同一行，别把动作甩到下一行去）。 */
function sectionMarkup(title, body, attrs = "", action = "") {
  const head = action
    ? `<div class="set-sec-head"><h2 class="set-sec-title">${title}</h2>${action}</div>`
    : `<h2 class="set-sec-title">${title}</h2>`;
  return `<section class="set-sec" ${attrs}>
    ${head}
    ${body}
  </section>`;
}

/** 切页进场重放：150ms 纯 opacity（.set-page.enter），瞬时回顶不做平滑 */
function replayPageEnter() {
  el.settingsScroll.scrollTop = 0;
  el.settingsInner.classList.remove("enter");
  void el.settingsInner.offsetWidth; // 强制 reflow，让同页连点也能重放
  el.settingsInner.classList.add("enter");
}

/*
 * 设置按子页渲染：左侧导航点哪个分区，这里就只挂哪个分区的 DOM。
 * 分区 → 子页映射见 SETTINGS_SECTIONS；每个子页内部再按「节」分组。
 */

export { mountSegmented, replayPageEnter, rowMarkup, sectionMarkup, segmentedPlateOf, setSwitchChecked, switchMarkup, syncSegmented };
