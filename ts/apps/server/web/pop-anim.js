/**
 * 挂载 / 卸载式浮层（菜单、浮卡）的统一进出场动画（2026-11-25）
 *
 * 为什么走 WAAPI 而不是 CSS transition：这类浮层是「open 时 append 到 body、
 * close 时 remove」，全局 `[hidden]{display:none!important}` 和拔节点都会杀掉
 * CSS transition，只能靠 Web Animations API 在拔节点之前把动画跑完。
 *
 * 几何前提：节点挂在 document.body 下、position:fixed、left/top 内联定位。
 * 动画只改 opacity / transform，不动 left/top，所以不会破坏已有定位与边界翻转。
 *
 * 用法：
 *   展开 popAnimateIn(node)（不 await，节点已经在 DOM 且定位完成）；
 *   收起 popAnimateOut(node).then(() => node.remove())。
 * 时长取 POP_IN_MS / POP_OUT_MS：入场比出场略长，收起要快一拍（同 tokens 的
 * 「退比进快」口径）；easing 用 style-01-tokens.css 的 decelerate / accelerate 曲线。
 *
 * 取消约定：两个函数都先 cancel 掉节点上还在跑的动画（快速连点时防堆叠），
 * 再返回 `animation.finished.catch(() => {})`——关到一半被下一张开场打断时，
 * 调用方的 .then 不会因为 rejection 断掉，也不会抛未处理 rejection。
 */

export const POP_IN_MS = 160;
export const POP_OUT_MS = 140;

const IN_KEYFRAMES = [
  { opacity: "0", transform: "translateY(-4px) scale(.98)" },
  { opacity: "1", transform: "none" },
];

const OUT_KEYFRAMES = [
  { opacity: "1", transform: "none" },
  { opacity: "0", transform: "translateY(-4px) scale(.98)" },
];

function prefersReducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 展开：淡入 + 从上方 4px 落下 + 轻微放大。reduced-motion 时直接完成。 */
export function popAnimateIn(el) {
  if (!el) return Promise.resolve();
  el.getAnimations().forEach((animation) => animation.cancel());
  if (prefersReducedMotion()) return Promise.resolve();
  const animation = el.animate(IN_KEYFRAMES, {
    duration: POP_IN_MS,
    easing: "cubic-bezier(0,0,.2,1)",
    fill: "backwards",
  });
  return animation.finished.catch(() => {});
}

/** 收起：反向，结束后由调用方 remove。reduced-motion 时直接完成。 */
export function popAnimateOut(el) {
  if (!el) return Promise.resolve();
  el.getAnimations().forEach((animation) => animation.cancel());
  if (prefersReducedMotion()) return Promise.resolve();
  const animation = el.animate(OUT_KEYFRAMES, {
    duration: POP_OUT_MS,
    easing: "cubic-bezier(.4,0,1,1)",
    fill: "forwards",
  });
  return animation.finished.catch(() => {});
}
