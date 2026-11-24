/**
 * 思考强度填充滑块（2026-11-23 从模型菜单底栏抽出，设置页「默认模型」卡复用同一件控件）
 *
 * 轨道等分到该模型支持的档位上，旋钮吸附：点轨道 / 拖旋钮 / 方向键都行；拖动过程只画
 * 不发包，松手才提交。点按与键盘跳档带过渡（.is-animating），拖动挂 .is-dragging 关过渡
 * 跟手；已选段用 scaleX 填满（compositor 变换，不碰布局——用户担心的"卡"就防这里）。
 * 视觉样式在 style-12-drawer.css 的 .think-slider 一节，两处摆位共用。
 *
 * 外部同步走 think-sync 事件：shell.js 在 /mode 被 clamp 改写实际档时发，滑块跟回实际档。
 * 设置页（全局默认档）没有这条：它的真相来自 POST /agent/model 的回值，回调里 setLevel。
 */

import { THINKING_LABELS } from "./shell.js";

/**
 * @param {{
 *   levels: string[],
 *   level?: string | null,
 *   ariaLabel?: string,
 *   onCommit?: (level: string) => void,
 * }} options
 * @returns {{ slider: HTMLElement, setLevel: (level: string, animate?: boolean) => void }}
 */
function createThinkingSlider({ levels, level = null, ariaLabel = "思考强度", onCommit } = {}) {
  const list = Array.isArray(levels) ? levels : [];

  const slider = document.createElement("div");
  slider.className = "think-slider";
  slider.setAttribute("role", "slider");
  slider.setAttribute("aria-label", ariaLabel);
  slider.setAttribute("aria-valuemin", "0");
  slider.setAttribute("aria-valuemax", String(Math.max(0, list.length - 1)));
  slider.tabIndex = 0;

  const track = document.createElement("div");
  track.className = "think-slider-track";
  const rail = document.createElement("div");
  rail.className = "think-slider-rail";
  const fill = document.createElement("div");
  fill.className = "think-slider-fill";
  const knob = document.createElement("div");
  knob.className = "think-slider-knob";
  track.append(rail, fill, knob);

  const value = document.createElement("span");
  value.className = "think-slider-value";

  let index = Math.max(0, list.indexOf(level));
  let committed = index;

  const place = (animate) => {
    const ratio = list.length > 1 ? index / (list.length - 1) : 0;
    slider.classList.toggle("is-animating", animate !== false);
    knob.style.left = `calc(7px + (100% - 14px) * ${ratio})`;
    // 整条 transform 内联（含 translateY 居中），别把 CSS 里的位移顶掉
    fill.style.transform = `translateY(-50%) scaleX(${list.length > 1 ? ratio : 0})`;
    value.textContent = THINKING_LABELS[list[index]] || list[index];
    slider.setAttribute("aria-valuenow", String(index));
    slider.setAttribute("aria-valuetext", value.textContent);
    slider.dataset.level = list[index];
  };

  const commit = () => {
    if (index === committed) return;
    committed = index;
    onCommit?.(list[index]);
  };

  const indexAt = (clientX) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return index;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * (list.length - 1));
  };

  // 外部改档（服务端 clamp 回值 / think-sync）：带过渡跟过去，同时认下服务端的档
  const setLevel = (next, animate = true) => {
    const found = list.indexOf(next);
    if (found < 0) return;
    index = found;
    committed = found;
    place(animate);
  };

  // 点轨道 / 拖旋钮：按下先不抢跳（单击留到松手带过渡滑过去），真拖动才关过渡跟手
  track.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    track.setPointerCapture?.(event.pointerId);
    slider.classList.add("is-dragging");
    const startX = event.clientX;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      const next = indexAt(ev.clientX);
      if (next === index) return;
      index = next;
      place(false);
    };
    const up = (ev) => {
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", up);
      track.removeEventListener("pointercancel", up);
      // 先摘 is-dragging 再 place：过渡规则挂在 is-animating 上，别被拖动态的 none 压住
      slider.classList.remove("is-dragging");
      if (!moved && ev.type !== "pointercancel") {
        index = indexAt(ev.clientX);
        place(true);
      }
      commit();
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", up);
    track.addEventListener("pointercancel", up);
  });

  slider.addEventListener("keydown", (event) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    if (!delta) return;
    event.preventDefault();
    index = Math.min(list.length - 1, Math.max(0, index + delta));
    place(true);
    commit();
  });

  slider.addEventListener("think-sync", (event) => {
    setLevel(event.detail?.level);
  });

  place(false);
  slider.append(track, value);
  return { slider, setLevel };
}

export { createThinkingSlider };
