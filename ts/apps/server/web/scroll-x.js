/**
 * 横向滚动排的滚轮 / 拖拽辅助（2026-11-15）
 *
 * 全站滚动条只留主对话（style-11 顶部口径），溢出的横排没有条子可拖，
 * 所以这里补两条手势：滚轮直转横滚、按住拖拽滑动。做法与记忆页 people tabs
 * （memory-page.js 里那份内联实现）同一条路，那边先做的；等下次动到它再收编过来。
 *
 * 拖过 6px 就吃掉落点 click——拖完松手那一下不算点卡，防止误触。
 * 纵向分量才转横滚：触控板自带的横向分量照原生走，别叠一份。
 * 没溢出（scrollWidth ≤ clientWidth）就不拦滚轮也不抢按住，宽屏原样。
 */

export function wireDragScroll(box) {
  if (!box || box.dataset.scrollX === "1") return;
  box.dataset.scrollX = "1";

  box.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const max = box.scrollWidth - box.clientWidth;
    if (max <= 0) return;
    event.preventDefault();
    box.scrollLeft += event.deltaY;
  }, { passive: false });

  let dragFrom = 0;
  let dragStart = 0;
  let dragged = 0;
  box.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return; // 触屏原生能滑
    if (box.scrollWidth <= box.clientWidth) return; // 没得滚就不抢按住
    dragFrom = event.clientX;
    dragStart = box.scrollLeft;
    dragged = 0;
    const onMove = (moveEvent) => {
      dragged = moveEvent.clientX - dragFrom;
      if (Math.abs(dragged) > 4) box.scrollLeft = dragStart - dragged;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (Math.abs(dragged) > 6) {
        box.addEventListener("click", (clickEvent) => {
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
        }, { capture: true, once: true });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}
