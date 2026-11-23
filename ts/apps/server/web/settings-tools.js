/**
 * 设置 → 工具（2026-11-17 全局工具池）
 *
 * 一页管所有模型可见工具：常驻（每轮带完整定义）还是按需（初始不进请求，
 * 模型要用先 tool_search 搜出来）。存 `.data/tool-pool.json` 的按需名单。
 *
 * **生效边界**：内核的 deferred 是工具注册期属性，保存后必须重启服务
 * （重开 Harness）才生效；服务端 GET 回 `restartPending`，本页据此挂一条提示。
 *
 * 按人覆盖仍在「人设 → 某人 → 能用的工具」：勾选 = 能不能用，按需/常驻胶囊 = 提升。
 *
 * 2026-11-17 版式调整（用户反馈）：解释性文字收进标题/表头的悬停，不再常驻；
 * 行可点开看描述原文（列表里那行只放 80 字摘要）；「定义 / 用量 / 池」三列居中。
 */

import { chevSvg } from "./icons.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { sectionMarkup } from "./settings-atoms.js";

const TOOL_POOL_PATH = "/api/v1/agent/tool-pool";

const POOL_TIP =
  "常驻 = 每轮请求都带完整定义，占固定前缀；按需 = 初始不带，模型要用先 tool_search 搜出来。" +
  "这份名单全局生效；按人能不能用去「注入 → 人设 → 某人 → 能用的工具」。" +
  "工具的名字、描述和参数是代码资产，这里不能改文案。保存后需重启服务生效。";

/** 页面骨架：标题悬停讲口径 + 待重启提示 + 表格卡；标题右侧「恢复默认 / 保存」。 */
function toolPoolMarkup() {
  return sectionMarkup(
    `<span data-tip="${attr(POOL_TIP)}">工具池</span>`,
    `<p class="set-hint" id="tool-pool-pending" hidden></p>
     <div class="card use-detail" id="tool-pool-card"><div class="use-loading">读取中…</div></div>`,
    "",
    `<span class="tool-pool-actions">
       <span class="use-foot" id="tool-pool-dirty" hidden>有改动</span>
       <button class="ghost" type="button" id="tool-pool-defaults" disabled data-tip="恢复成代码默认的 8 个按需工具">恢复默认</button>
       <button class="btn-primary" type="button" id="tool-pool-save" disabled data-tip="按需是注册期属性：保存后重启服务才生效">保存</button>
     </span>`,
  );
}

/**
 * 页内状态。`configured` = 正在编辑的按需名单；`initial` = 打开时（或上次保存后）的名单，
 * 用来算"有没有改动"。服务端返回的 payload 只在 apply 时整体落进 state，画表只读 state。
 * `open` = 展开了哪几行（重画后保持展开状态）。
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
  if (dirtyTag) dirtyTag.hidden = !changed;
}

/** 只重画表格（切换 / 恢复默认都走这条，不重新拉数据）。 */
function drawToolPool() {
  const card = document.getElementById("tool-pool-card");
  if (!card) return;
  if (!state.tools.length) {
    card.innerHTML = `<div class="use-empty"><div class="use-empty-title">没有可配置的工具</div><div class="use-empty-hint">服务端没回工具目录；工具面为空时没有可调的池子。</div></div>`;
    return;
  }
  const rows = state.tools
    .map((tool) => {
      const usage = state.usage.get(tool.name);
      const usageText = usage
        ? `用过 ${Number(usage.count) || 0}${usage.loads ? ` · 搜出 ${usage.loads}` : ""}`
        : "—";
      const deferred = state.configured.has(tool.name);
      const open = state.open.has(tool.name);
      // 原文保留全文，只去掉 Markdown 强调 / 行内码符号（同摘要的清洗口径，别在页面上露出 **）
      const full = String(tool.description || tool.summary || "").replace(/\*\*|__|`/g, "");
      const params = JSON.stringify(tool.parameters ?? {}, null, 2);
      return `<tr class="tool-pool-row${open ? " is-open" : ""}" data-tool-row="${attr(tool.name)}" aria-expanded="${open ? "true" : "false"}">
        <td class="model">
          <div class="use-model-line">
            ${chevSvg("tool-pool-caret chev")}
            <span class="use-mono">${esc(tool.name)}</span>
          </div>
          <div class="tool-pool-sum">${esc(String(tool.summary || ""))}</div>
        </td>
        <td class="tool-pool-col">${Number(tool.tokens) || 0} token</td>
        <td class="tool-pool-col">${esc(usageText)}</td>
        <td class="tool-pool-col">
          <button class="pf-tool-mode" type="button" data-pool-for="${attr(tool.name)}" data-on="${deferred ? "1" : "0"}"${state.enabled ? "" : " disabled"}>${deferred ? "按需" : "常驻"}</button>
        </td>
      </tr>
      <tr class="tool-pool-detail" data-detail-for="${attr(tool.name)}"${open ? "" : " hidden"}>
        <td colspan="4">
          <div class="tool-pool-detail-inner">
            <div class="tool-pool-detail-block">
              <div class="tool-pool-detail-label">说明原文</div>
              <div class="tool-pool-desc">${esc(full)}</div>
            </div>
            <div class="tool-pool-detail-block">
              <div class="tool-pool-detail-label">参数（JSON Schema）</div>
              <pre class="tool-pool-params">${esc(params)}</pre>
            </div>
          </div>
        </td>
      </tr>`;
    })
    .join("");
  card.innerHTML = `
    <div class="use-table-wrap">
      <table class="use-table tool-pool-table">
        <thead><tr>
          <th scope="col">工具</th>
          <th scope="col" class="tool-pool-col" data-tip="工具名 + 描述 + 参数的精简 JSON 估算（口径同设置→上下文）">定义</th>
          <th scope="col" class="tool-pool-col" data-tip="模型真实执行完的次数 · 被 tool_search 搜出来的次数">用量</th>
          <th scope="col" class="tool-pool-col" data-tip="${attr(POOL_TIP)}">池</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="use-foot">共 ${state.tools.length} 个工具，按需 ${state.configured.size} 个。点一行看完整定义（说明 + 参数）。</div>`;
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
    const [payload, usage] = await Promise.all([fetchToolPool(), fetchToolUsage()]);
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
 * 动的是详情行里的 `.tool-pool-detail-inner`，不是 `<tr>`：表格行本身不能可靠地做
 * 高度过渡。动画只走一遍、**不写内联终态**——结束时自然回落到 CSS 的真实高度与透明度，
 * 不必依赖 onfinish 清理，动画对象被取消也不会留下「高度 0、内容看不见」的坏状态。
 * 收起才需要 onfinish 把整行藏掉；万一它没跑到（页面被挂起），留下的也只是完整内容。
 * 连点先取消上一段，不叠动画。
 */
const detailAnimations = new WeakMap();

function setRowOpen(detail, open) {
  const inner = detail.querySelector(".tool-pool-detail-inner");
  if (!inner) {
    detail.hidden = !open;
    return;
  }
  const previous = detailAnimations.get(inner);
  if (previous) previous.cancel();
  // 先让行可见（收起动画要从有高度开始量）
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
    // 先藏行再取消动画：同一任务内完成，中间不会有一次「高度回到完整值」的绘制
    if (!open) detail.hidden = true;
    animation.cancel();
    detailAnimations.delete(inner);
  };
}

/** 展开 / 收起一行：只动这一行 + 它的详情行，不重画整表。 */
function toggleRow(card, row) {
  const name = row.dataset.toolRow;
  if (!name) return;
  const detail = row.nextElementSibling;
  if (!detail || detail.dataset.detailFor !== name) return;
  const open = !state.open.has(name);
  if (open) state.open.add(name);
  else state.open.delete(name);
  row.classList.toggle("is-open", open);
  row.setAttribute("aria-expanded", open ? "true" : "false");
  setRowOpen(detail, open);
}

function wireToolPool() {
  const card = document.getElementById("tool-pool-card");
  const save = document.getElementById("tool-pool-save");
  const restore = document.getElementById("tool-pool-defaults");
  if (!card || !save) return;

  card.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const chip = target?.closest(".pf-tool-mode");
    // 池胶囊优先：点它只切池，不展开行。
    if (chip && card.contains(chip)) {
      const name = chip.dataset.poolFor;
      if (!name) return;
      if (state.configured.has(name)) state.configured.delete(name);
      else state.configured.add(name);
      // 只改这一枚胶囊，不整表重画（避免打断滚动位置）。
      const deferred = state.configured.has(name);
      chip.dataset.on = deferred ? "1" : "0";
      chip.textContent = deferred ? "按需" : "常驻";
      syncDirty();
      return;
    }
    const row = target?.closest("tr[data-tool-row]");
    if (row && card.contains(row)) toggleRow(card, row);
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
