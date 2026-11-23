/**
 * 交互卡片挂载（2026-11-21，方案见 docs/设计方案/2026-11-21-表格渲染与交互消息/）
 *
 * renderMarkdown 只产出 `<div class="html-card" data-srcdoc="…">` 占位符（不产 iframe）：
 * 流式 reconciler（stream-reveal.js）按「元素+属性一致」保节点，renderMarkdown 产出的
 * 属性永远跟源文本对得上，挂载阶段加的任何属性都会让下一轮增量把卡换掉、iframe 反复重载。
 * 所以挂载收在这一层：全局 MutationObserver 发现新占位符 → 挂沙箱 iframe；
 * 高度由注入的报高脚本 postMessage 上报，按内容缓存，重建后免闪。
 *
 * 安全边界：模型产的 HTML 按不可信处理——allow-scripts 只开脚本，
 * 无 same-origin（拿不到 cookie / 存储 / 父页 DOM）、no-referrer、不开表单与弹窗。
 */

/* data-srcdoc 内容 → 已量出的高度。占位符被流式/整段重渲染重建时，
   iframe 会重新挂载，先给一版缓存高度再等重报，避免肉眼可见的塌一下。 */
const heights = new Map();
const HEIGHTS_MAX = 100;

/* 注进 srcdoc 末尾的报高脚本：load + 几次延时 + ResizeObserver 都报一遍，
   字体晚到 / 动画展开都能跟上。body.offsetHeight + 16 兜住默认 body 边距。 */
const HEIGHT_REPORTER =
  `<script>(function(){var d=document,b=d.body,p=function(){try{parent.postMessage({__artH:Math.max(d.documentElement.scrollHeight,b?b.offsetHeight+16:0)},'*')}catch(e){}};p();d.addEventListener('load',p);setTimeout(p,200);setTimeout(p,600);setTimeout(p,1200);if(window.ResizeObserver){new ResizeObserver(p).observe(d.documentElement)}})();</script>`;

function heightCap() {
  return Math.max(200, Math.round(window.innerHeight * 0.72));
}

function mountCard(card) {
  // 已挂过（iframe 在里面）就不动；重渲染会造出新的空占位符，各自挂各自的
  if (card.firstElementChild) return;
  const code = card.dataset.srcdoc || "";
  if (!code) return;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "交互卡片");
  const known = heights.get(code);
  if (known) frame.style.height = known + "px";
  // 模型没写 doctype 就补一个：srcdoc 缺 doctype 落 quirks 模式，
  // height:100% / scrollHeight 这类都会失真（2026-11-21 实测首报偏高）
  const doc = (/^\s*<!doctype/i.test(code) ? code : "<!DOCTYPE html>" + code) + HEIGHT_REPORTER;
  frame.srcdoc = doc;
  card.append(frame);
}

function mountCards() {
  const cards = document.querySelectorAll(".html-card");
  for (const card of cards) mountCard(card);
}

function onMessage(event) {
  const reported = event.data && event.data.__artH;
  if (!Number.isFinite(reported) || reported < 1) return;
  const frames = document.querySelectorAll(".html-card iframe");
  for (const frame of frames) {
    if (frame.contentWindow !== event.source) continue;
    const px = Math.min(Math.max(Math.ceil(reported), 24) + 2, heightCap());
    frame.style.height = px + "px";
    const card = frame.closest(".html-card");
    if (card) {
      if (heights.size >= HEIGHTS_MAX) heights.clear();
      heights.set(card.dataset.srcdoc || "", px);
    }
    return;
  }
}

let started = false;

/** 全局启动一次：报高监听 + 占位符观察。重复调用无害。 */
export function initHtmlCards() {
  if (started) return;
  started = true;
  window.addEventListener("message", onMessage);
  new MutationObserver(() => mountCards()).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
