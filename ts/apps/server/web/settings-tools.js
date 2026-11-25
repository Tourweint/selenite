/**
 * 设置 → 工具（2026-11-17 全局工具池；2026-11-23 双栏泳池版式）
 *
 * 一页管所有模型可见工具：常驻（每轮带完整定义）还是按需（初始不进请求，
 * 模型要用先 tool_search 搜出来）。存 `.data/tool-pool.json` 的按需名单。
 *
 * **生效边界**：内核的 deferred 是工具注册期属性，保存后必须重启服务
 * （重开 Harness）才生效；服务端 GET 回 `restartPending`，本页据此挂一条提示。
 *
 * 按人覆盖仍在「人设 → 某人 → 能用的工具」：勾选 = 能不能用，按需/常驻胶囊 = 提升。
 *
 * 2026-11-23 版式（用户拍板「双栏泳池」）：左常驻右按需，栏头直接报个数与 token；
 * 卡片可点开看说明原文与参数。池归属是这一页的第一信息，不再是一枚行尾小胶囊。
 */

import { chevSvg } from "./icons.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { sectionMarkup } from "./settings-atoms.js";
// 2026-11-24 M4：异常处理只做只读回显 + 打开插件页同一个弹层，不在这页做第二套保存逻辑。
import { loadToolPolicy, openToolPolicyModal, toolPolicyConfigurable, toolPolicyLine } from "./settings-tool-policy.js";
// 2026-11-25 界面显隐注册表：用量列是渲染期才知道的（注册表抓不到动态产物），这里自己按开关判。
import { flagOn, loadSurfaceFlags } from "./surfaces.js";

const TOOL_POOL_PATH = "/api/v1/agent/tool-pool";

/** 唯一不能进按需池的工具：它是加载按需工具的唯一入口，服务端也会 400。 */
const LOCKED_TOOL = "tool_search";

const POOL_TIP =
  "常驻 = 每轮请求都带完整定义，占固定前缀；按需 = 初始不带，模型要用先 tool_search 搜出来。" +
  "这份名单全局生效；按人能不能用去「注入 → 人设 → 某人 → 能用的工具」。" +
  "工具的名字、描述和参数是代码资产，这里不能改文案。保存后需重启服务生效。";

/** 页面骨架：标题悬停讲口径 + 待重启提示 + 双栏泳池；标题右侧「恢复默认 / 保存」。 */
function toolPoolMarkup() {
  return sectionMarkup(
    `<span data-tip="${attr(POOL_TIP)}">工具池</span>`,
    `<p class="set-hint" id="tool-pool-pending" hidden></p>
     <div class="tool-pool-board" id="tool-pool-card"><div class="use-loading">读取中…</div></div>`,
    "",
    `<span class="tool-pool-actions">
       <span class="use-foot" id="tool-pool-dirty" hidden>有改动</span>
       <button class="ghost" type="button" id="tool-pool-defaults" data-tip="恢复成代码默认的 9 个按需工具">恢复默认</button>
       <button class="btn-primary" type="button" id="tool-pool-save" disabled data-tip="按需是注册期属性：保存后重启服务才生效">保存</button>
     </span>`,
  );
}

/**
 * 页内状态。`configured` = 正在编辑的按需名单；`initial` = 打开时（或上次保存后）的名单，
 * 用来算"有没有改动"。服务端返回的 payload 只在 apply 时整体落进 state，画板只读 state。
 * `open` = 展开了哪几张卡（重画后保持展开状态）。
 */
const state = {
  configured: new Set(),
  initial: [],
  defaults: [],
  usage: new Map(),
  enabled: true,
  tools: [],
  payload: null,
  open: new Set(),
};

/** 把服务端 payload 落进 state（不动 DOM）。 */
function applyPayload(payload) {
  state.payload = payload;
  state.enabled = payload?.enabled !== false;
  state.tools = Array.isArray(payload?.tools) ? payload.tools : [];
  state.defaults = Array.isArray(payload?.defaults) ? payload.defaults : [];
  state.configured = new Set(Array.isArray(payload?.deferred) ? payload.deferred : []);
  state.initial = [...state.configured];
}

function syncDirty() {
  const save = document.getElementById("tool-pool-save");
  const dirtyTag = document.getElementById("tool-pool-dirty");
  const restore = document.getElementById("tool-pool-defaults");
  const current = [...state.configured];
  const changed =
    current.length !== state.initial.length ||
    current.some((name) => !state.initial.includes(name));
  if (save) save.disabled = !changed;
  // 恢复默认一直可用（2026-11-23 修）：旧版把 disabled 写死在标签上，按钮从没点得动过。
  if (restore) restore.disabled = !state.enabled;
  if (dirtyTag) dirtyTag.hidden = !changed;
}

/* ── 索引段 token 估算（页头那一行小字）──────────────────
 * 与服务端 tool-index.ts 的文本、token-estimate.ts 的口径同一份：
 * CJK 1 token/字，其它 1 token/4 字符。工具摘要直接用 payload 里的 summary
 * （服务端就是 toolSummaryOf(description) 的结果）。这里只做展示，不改任何注入。 */
const INDEX_TITLE =
  '按需工具（初始不加载）：要用下面某个工具时，先调 tool_search({name:"工具名"}) 取完整定义，下一轮起它才可用。';
const INDEX_TAIL = "先调 tool_search({name}) 取完整定义，下一轮起它才可用。";
const CJK_CHAR =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const char of String(text)) {
    if (CJK_CHAR.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

function indexTokensOf(items) {
  if (!items.length) return 0;
  return estimateTokens(
    [
      INDEX_TITLE,
      ...items.map((tool) => `- ${tool.name}：${String(tool.summary || "")}`),
      INDEX_TAIL,
    ].join("\n"),
  );
}

function usageText(tool) {
  const usage = state.usage.get(tool.name);
  if (!usage) return "—";
  const count = Number(usage.count) || 0;
  const loads = Number(usage.loads) || 0;
  if (!count && !loads) return "没用过";
  return [count ? `用过 ${count} 次` : "", loads ? `搜出 ${loads} 次` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** 一张工具卡：名字当主角，池状态由所在栏 + 底部动作表达；点开看说明原文与参数。 */
function cardHtml(tool, deferred) {
  const open = state.open.has(tool.name);
  const locked = tool.name === LOCKED_TOOL;
  const name = String(tool.name || "");
  const tokens = Number(tool.tokens) || 0;
  const summaryText = String(tool.summary || "（没有摘要）");
  // 原文保留全文，只去掉 Markdown 强调 / 行内码符号（同摘要的清洗口径，别在页面上露出 **）
  const full = String(tool.description || tool.summary || "").replace(/\*\*|__|`/g, "");
  const params = JSON.stringify(tool.parameters ?? {}, null, 2);
  const policyLine = toolPolicyLine(name);
  const policyBlock = policyLine
    ? `<div class="tool-pool-detail-block tool-pool-policy">
          <div class="tool-pool-detail-label">异常处理</div>
          <div class="tool-pool-policy-row">
            <span class="tool-pool-policy-text" data-tool-policy-line="${attr(name)}">${esc(policyLine)}</span>
            <button class="ghost is-mini" type="button" data-tool-policy-open="${attr(name)}">${
              toolPolicyConfigurable(name) ? "调整" : "说明"
            }</button>
          </div>
        </div>`
    : "";
  const moveLabel = deferred ? "← 移到常驻" : "移到按需 →";
  const moveTip = deferred
    ? "移到常驻：每轮请求都带完整定义"
    : "移到按需：初始不进请求，模型要用先 tool_search 搜出来";
  // 用量列（2026-11-25）：TOOL_USAGE 关着时整列不渲染（服务端同时 404，见 index.ts 同一行回滚）。
  const usageRow = flagOn("TOOL_USAGE") ? `<span class="tool-pool-usage">${esc(usageText(tool))}</span>` : "";
  const move = locked
    ? `<span class="tool-pool-lock" title="tool_search 是加载按需工具的唯一入口，不能进按需池">加载入口</span>`
    : `<button class="tool-pool-move" type="button" data-pool-for="${attr(name)}" data-on="${deferred ? "1" : "0"}" title="${attr(moveTip)}"${state.enabled ? "" : " disabled"}>${moveLabel}</button>`;
  return `<article class="tool-pool-card${open ? " is-open" : ""}" data-tool-card="${attr(name)}">
    <button class="tool-pool-open" type="button" data-tool-open="${attr(name)}" aria-expanded="${open ? "true" : "false"}" title="点开看说明原文与参数">
      <span class="tool-pool-top">
        ${chevSvg("tool-pool-caret chev")}
        <span class="tool-pool-name">${esc(name)}</span>
        <span class="tool-pool-card-cost" title="完整定义约 ${tokens} token">${tokens} token</span>
      </span>
      <span class="tool-pool-summary" title="${attr(summaryText)}">${esc(summaryText)}</span>
    </button>
    <div class="tool-pool-foot">
      ${usageRow}
      ${move}
    </div>
    <div class="tool-pool-detail"${open ? "" : " hidden"}>
      <div class="tool-pool-detail-inner">
        ${policyBlock}
        <div class="tool-pool-detail-block">
          <div class="tool-pool-detail-label">说明原文</div>
          <div class="tool-pool-desc">${esc(full)}</div>
        </div>
        <div class="tool-pool-detail-block">
          <div class="tool-pool-detail-label">参数（JSON Schema）</div>
          <pre class="tool-pool-params">${esc(params)}</pre>
        </div>
      </div>
    </div>
  </article>`;
}

/** 一栏（常驻 / 按需）：栏头报个数与 token；空栏也保留，页面骨架不跳。 */
function columnHtml(items, deferred) {
  const on = !deferred;
  const tokens = on
    ? items.reduce((sum, tool) => sum + (Number(tool.tokens) || 0), 0)
    : indexTokensOf(items);
  const cost = on
    ? `${tokens.toLocaleString("zh-CN")} token / 轮`
    : items.length
      ? `工具索引 ${tokens.toLocaleString("zh-CN")} token`
      : "空";
  const empty = on ? "没有常驻工具，所有工具都要先搜一次。" : "没有按需工具，工具面全部常驻。";
  return `<section class="tool-pool-col" data-pool="${on ? "on" : "off"}">
    <div class="tool-pool-head">
      <span class="tool-pool-dot is-${on ? "on" : "off"}"></span>
      <span class="tool-pool-title">${on ? "常驻池" : "按需池"}</span>
      <span class="tool-pool-count">${items.length}</span>
      <span class="tool-pool-cost">${cost}</span>
    </div>
    <div class="tool-pool-cards">${
      items.length ? items.map((tool) => cardHtml(tool, deferred)).join("") : `<div class="tool-pool-empty">${empty}</div>`
    }</div>
  </section>`;
}

/** 只重画泳池（切池 / 恢复默认都走这条，不重新拉数据）。 */
function drawToolPool() {
  const card = document.getElementById("tool-pool-card");
  if (!card) return;
  if (!state.tools.length) {
    card.innerHTML = `<div class="use-empty"><div class="use-empty-title">没有可配置的工具</div><div class="use-empty-hint">服务端没回工具目录；工具面为空时没有可调的池子。</div></div>`;
    return;
  }
  const on = state.tools.filter((tool) => !state.configured.has(tool.name));
  const off = state.tools.filter((tool) => state.configured.has(tool.name));
  card.innerHTML = `${columnHtml(on, false)}${columnHtml(off, true)}`;
  syncDirty();
}

function setPending(text) {
  const pending = document.getElementById("tool-pool-pending");
  if (!pending) return;
  pending.hidden = !text;
  pending.textContent = text || "";
}

function pendingTextOf(payload) {
  if (payload?.restartPending !== true) return "";
  const runtime = Array.isArray(payload.applied) ? payload.applied.join("、") : "";
  return `已保存，待重启生效：当前运行用的仍是旧名单${runtime ? `（${runtime}）` : ""}。`;
}

async function fetchToolPool() {
  const response = await request(TOOL_POOL_PATH, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new Error(data.message || String(response.status));
  return data;
}

/** 用量是旁路：读不到就当没有，绝不挡页面。 */
async function fetchToolUsage() {
  // TOOL_USAGE 关着：端点会 404、用量列也不渲染，这里连请求都不发（2026-11-25 同一条回滚）。
  // 读不到开关时 flagOn 按「开」，行为与之前一致。
  if (!flagOn("TOOL_USAGE")) return new Map();
  try {
    const response = await request("/api/v1/agent/tool-usage", { cache: "no-store" });
    if (!response.ok) return new Map();
    const data = await response.json().catch(() => ({}));
    const map = new Map();
    for (const row of Array.isArray(data?.tools) ? data.tools : []) {
      if (row && typeof row.name === "string") map.set(row.name, row);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function loadToolPool() {
  const card = document.getElementById("tool-pool-card");
  if (!card) return;
  card.innerHTML = `<div class="use-loading">读取中…</div>`;
  try {
    // 先把 flags 拿到（缓存已有就不发请求）：用量列的显隐与「要不要请求 /tool-usage」
    // 都在第一帧就按真实开关判，避免先画出一列再撤掉。
    await loadSurfaceFlags();
    const [payload, usage] = await Promise.all([
      fetchToolPool(),
      fetchToolUsage(),
      // 异常处理是旁路：端点 404（总开关关）或读失败都只让那一行不出现，不挡工具池本体。
      loadToolPolicy({ fresh: true }).catch(() => null),
    ]);
    state.usage = usage;
    applyPayload(payload);
    setPending(pendingTextOf(payload));
    drawToolPool();
  } catch (error) {
    if (error.message !== "forbidden") {
      card.innerHTML = `<div class="use-empty"><div class="use-empty-title">读取失败</div><div class="use-empty-hint">${esc(error.message)}</div></div>`;
    }
  }
}

/**
 * 展开 / 收起的过渡（2026-11-18 用户口径：不要求流式，渐显 + 高度撑开就够）。
 * 动的是卡内 `.tool-pool-detail-inner`，不是卡片本身：收起时动画跑完再把整块藏掉。
 * 动画只走一遍、**不写内联终态**——结束时自然回落到 CSS 的真实高度与透明度，
 * 不必依赖 onfinish 清理，动画对象被取消也不会留下「高度 0、内容看不见」的坏状态。
 * 连点先取消上一段，不叠动画。
 */
const detailAnimations = new WeakMap();

function setCardOpen(detail, open) {
  const inner = detail.querySelector(".tool-pool-detail-inner");
  if (!inner) {
    detail.hidden = !open;
    return;
  }
  const previous = detailAnimations.get(inner);
  if (previous) previous.cancel();
  // 先让块可见（收起动画要从有高度开始量）
  if (open) detail.hidden = false;

  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    if (!open) detail.hidden = true;
    return;
  }

  const full = inner.scrollHeight;
  const from = open ? 0 : full;
  const to = open ? full : 0;
  // fill: forwards —— 动画跑完先保住终态（撑开的高度 / 收起的 0 高度），
  // 等 onfinish 再把控制权交回 CSS；这样 onfinish 晚一拍也不会闪回旧高度。
  const animation = inner.animate(
    [
      { height: `${from}px`, opacity: open ? 0 : 1 },
      { height: `${to}px`, opacity: open ? 1 : 0 },
    ],
    { duration: 220, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "forwards" },
  );
  detailAnimations.set(inner, animation);
  animation.onfinish = () => {
    // 先藏块再取消动画：同一任务内完成，中间不会有一次「高度回到完整值」的绘制
    if (!open) detail.hidden = true;
    animation.cancel();
    detailAnimations.delete(inner);
  };
}

/** 展开 / 收起一张卡：只动这张卡，不重画整个泳池。 */
function toggleCard(card) {
  const name = card.getAttribute("data-tool-card");
  if (!name) return;
  const open = !state.open.has(name);
  if (open) state.open.add(name);
  else state.open.delete(name);
  card.classList.toggle("is-open", open);
  card.querySelector("[data-tool-open]")?.setAttribute("aria-expanded", open ? "true" : "false");
  const detail = card.querySelector(".tool-pool-detail");
  if (detail) setCardOpen(detail, open);
}

function wireToolPool() {
  const card = document.getElementById("tool-pool-card");
  const save = document.getElementById("tool-pool-save");
  const restore = document.getElementById("tool-pool-defaults");
  if (!card || !save) return;

  card.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    // 异常处理「调整」：打开插件页同一个弹层，保存逻辑只有一份（2026-11-24 M4）。
    const policyOpen = target?.closest("[data-tool-policy-open]");
    if (policyOpen && card.contains(policyOpen)) {
      event.stopPropagation();
      void openToolPolicyModal(policyOpen.getAttribute("data-tool-policy-open") || "");
      return;
    }
    // 池动作优先：点它只切池，不展开卡。
    const move = target?.closest("[data-pool-for]");
    if (move && card.contains(move)) {
      const name = move.getAttribute("data-pool-for");
      if (!name) return;
      if (state.configured.has(name)) state.configured.delete(name);
      else state.configured.add(name);
      // 换栏后不保持展开：卡换了一栏，展开态跟着内容走反而更难找。
      state.open.delete(name);
      drawToolPool();
      // 整板重画后把焦点送回这张卡的池动作上，键盘连续操作不会掉回页面顶部。
      card.querySelector(`[data-tool-card="${name}"] [data-pool-for="${name}"]`)?.focus();
      return;
    }
    const open = target?.closest("[data-tool-open]");
    const article = open?.closest("[data-tool-card]");
    if (open && article && card.contains(article)) toggleCard(article);
  });

  restore?.addEventListener("click", () => {
    state.configured = new Set(state.defaults);
    drawToolPool();
  });

  save.addEventListener("click", async () => {
    if (save.disabled) return;
    save.disabled = true;
    setPending("保存中…");
    try {
      const response = await request(TOOL_POOL_PATH, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deferred: [...state.configured] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.message || String(response.status));
      applyPayload(data);
      drawToolPool();
      setPending(pendingTextOf(data) || "已保存。重启服务后生效（设置 → 本机 → Node 服务 → 重启）。");
    } catch (error) {
      if (error.message !== "forbidden") setPending(`没存成：${error.message}`);
      syncDirty();
    }
  });

  void loadToolPool();
}

export { toolPoolMarkup, wireToolPool };
