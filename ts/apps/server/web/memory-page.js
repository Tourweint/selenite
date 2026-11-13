/**
 * 记忆页 A 版：骨架、分组、摘要
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openConversation } from "./chat-open.js";
import { attr, esc } from "./markdown.js";
import { applyMemoryProposalA, clearMemoryProposalCard, dismissMemoryProposalA, forgetMemoryItem, loadMemoryExternal, loadMemoryGroup, loadMemoryReviewState, memoryItemMarkupA, runMemoryConsolidateA, supersedeMemoryItem } from "./memory-items.js";
import { request } from "./net.js";
import { currentSettingsPage } from "./route.js";
import { sectionMarkup } from "./settings-atoms.js";
import { MEMORY_KIND_LABEL, MEMORY_KIND_ORDER, MEMORY_KIND_TIPS, fillMemoryScopes } from "./settings-memory.js";
import { closeModal, openModal, showAlert } from "./ui-atoms.js";

/* ── 记忆页 A 版（2026-11-13）──────────────────────────────
 * 大字概览 + 分类计数片（唯一筛选）+ 搜索 + 分组折叠 + 可恢复的整理状态。
 * 旧版整套保持原样（*Legacy），`MEMORY_PAGE_A=false` 时回落。
 * 整理：?background=1 立即 202，页面轮询 /consolidate/state；
 * 切页回来能看见"正在整理 / 上次建议 / 失败原因"，同一 scope 在跑时不会重复调模型。 */

const MEMORY_A_PAGE_SIZE = 20;
const MEMORY_A_DEFAULT_OPEN = new Set(["preference", "intention"]);

const memoryPageState = {
  gen: 0,
  scope: "global",
  q: "",
  kind: "",
  counts: { all: 0, byKind: {}, superseded: 0 },
  total: 0,
  groups: new Map(),
  status: null,
  canConsolidate: false,
  canImport: false,
  consolidateJob: false,
  externalLines: [],
  pollTimer: 0,
};

function memoryPageAlive(gen) {
  return (
    memoryPageState.gen === gen &&
    currentSettingsPage() === "memory" &&
    Boolean(document.getElementById("mem-a-groups"))
  );
}

function stopMemoryPolling() {
  if (memoryPageState.pollTimer) {
    clearInterval(memoryPageState.pollTimer);
    memoryPageState.pollTimer = 0;
  }
}

function startMemoryPolling(gen) {
  if (memoryPageState.pollTimer) return;
  if (!memoryPageAlive(gen)) return;
  memoryPageState.pollTimer = window.setInterval(() => {
    void loadMemoryReviewState(gen);
  }, 1500);
}

function memoryShortDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const date = /^\d{4}-\d{2}-\d{2}/.test(raw) ? new Date(`${raw.slice(0, 10)}T00:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
  const now = new Date();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() === now.getFullYear()
    ? `${mm}-${dd}`
    : `${date.getFullYear()}-${mm}-${dd}`;
}

function memoryStatusTime(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return date.toDateString() === now.toDateString()
    ? `今天 ${hh}:${mm}`
    : `${memoryShortDate(date.toISOString())} ${hh}:${mm}`;
}

function memoryElapsedSeconds(value) {
  const started = Date.parse(String(value || ""));
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

function memorySourceLabel(source) {
  const value = String(source || "");
  if (value === "diary") return "日记";
  if (value === "user") return "你说";
  if (value === "taught") return "你教的";
  if (value === "imported") return "导入";
  if (value === "work") return "派单";
  if (value === "persona") return "长期库";
  if (value.startsWith("extract")) return "对话";
  return value || "—";
}

function memoryGroupOf(kind, total = 0) {
  let group = memoryPageState.groups.get(kind);
  if (!group) {
    group = {
      items: [],
      total,
      loaded: false,
      loading: false,
      error: "",
      open: MEMORY_A_DEFAULT_OPEN.has(kind) || Boolean(memoryPageState.q),
    };
    memoryPageState.groups.set(kind, group);
  }
  if (total > 0) group.total = total;
  return group;
}

function memoryGroupHint(kind) {
  if (kind === "preference") return "每轮都会想起";
  if (kind === "intention") return "未兑现的，优先想起";
  if (kind === "episode") return "日常经过 · 默认收起";
  return "";
}

function memorySettingsMarkup() {
  return sectionMarkup(
    "记忆",
    `<div class="card mem-a-overview">
      <div class="mem-a-overview-main">
        <div class="mem-a-total"><b id="mem-a-total">—</b><span>条记忆</span></div>
        <div class="mem-a-chips" id="mem-a-chips"></div>
      </div>
      <div class="mem-a-overview-side">
        <div class="mem-a-status" id="mem-a-status">读取中…</div>
        <div class="mem-a-audit" id="mem-a-audit" hidden></div>
      </div>
    </div>
    <div class="mem-a-run" id="mem-a-run" hidden>
      <span class="mem-a-spinner" aria-hidden="true"></span>
      <span id="mem-a-run-text">正在整理…</span>
      <span class="mem-a-elapsed" id="mem-a-elapsed"></span>
    </div>
    <div class="card mem-a-props" id="mem-a-props-card" hidden>
      <div class="mem-a-props-head">
        <span class="mem-a-props-title">整理建议</span>
        <span class="mem-a-count" id="mem-a-prop-count"></span>
        <span class="mem-a-prop-note" id="mem-a-prop-note"></span>
      </div>
      <div class="mem-a-props-list" id="mem-a-props"></div>
    </div>
    <div class="mem-a-toolbar">
      <label class="mem-a-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="mem-a-search" type="search" spellcheck="false"
               placeholder="搜记忆内容，比如「猫」「汇报」「跑步」" aria-label="搜索记忆" />
      </label>
      <select class="mem-select" id="mem-scope" aria-label="选择记忆范围">
        <option value="global">总管（global）</option>
      </select>
    </div>
    <div class="mem-a-groups" id="mem-a-groups"><div class="set-hint">读取中…</div></div>
    <div class="mem-a-external" id="mem-a-external" hidden>
      <div class="mem-a-external-main">
        <div class="mem-a-external-title">一生记忆库</div>
        <div class="mem-a-external-line" id="mem-a-external-line"></div>
      </div>
      <button class="ghost mem-act" type="button" id="mem-a-ext-open" hidden>查看</button>
    </div>`,
    "",
    `<div class="mem-a-head-actions">
      <button class="ghost mem-act" type="button" id="mem-import" hidden>导入</button>
      <button class="btn-primary mem-a-consolidate" type="button" id="mem-consolidate" hidden
        data-tip="整理记忆 = 让模型回看最近的记忆和原始对话，找出重复、过时、说法不一致的条目。&#10;&#10;它只给建议：你逐条点「应用」才会把旧的那条标成过时；不会自动删，也没有「全部应用」。">整理记忆 <span class="mem-a-q" aria-hidden="true">?</span></button>
    </div>`,
  );
}

async function wireMemorySettings() {
  const gen = ++memoryPageState.gen;
  stopMemoryPolling();
  memoryPageState.scope = "global";
  memoryPageState.q = "";
  memoryPageState.kind = "";
  memoryPageState.counts = { all: 0, byKind: {}, superseded: 0 };
  memoryPageState.total = 0;
  memoryPageState.groups.clear();
  memoryPageState.status = null;
  memoryPageState.externalLines = [];

  const scopeSelect = document.getElementById("mem-scope");
  if (scopeSelect) {
    await fillMemoryScopes(scopeSelect);
    scopeSelect.value = memoryPageState.scope;
    scopeSelect.addEventListener("change", () => {
      memoryPageState.scope = scopeSelect.value || "global";
      memoryPageState.groups.clear();
      memoryPageState.status = null;
      clearMemoryProposalCard();
      void loadMemorySummary(gen);
      void loadMemoryReviewState(gen);
    });
  }

  const search = document.getElementById("mem-a-search");
  let searchTimer = 0;
  search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      memoryPageState.q = search.value.trim();
      memoryPageState.groups.clear();
      void loadMemorySummary(gen);
    }, 250);
  });

  document.getElementById("mem-import")?.addEventListener("click", openMemoryImportPlaceholder);
  document.getElementById("mem-consolidate")?.addEventListener("click", () => {
    void runMemoryConsolidateA(gen);
  });

  const chips = document.getElementById("mem-a-chips");
  chips?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-mem-kind]");
    if (!button) return;
    const kind = button.getAttribute("data-mem-kind") || "all";
    memoryPageState.kind = kind === "all" || kind === memoryPageState.kind ? "" : kind;
    if (memoryPageState.kind) memoryGroupOf(memoryPageState.kind).open = true;
    renderMemoryChips();
    renderMemoryGroups(gen);
  });

  const groups = document.getElementById("mem-a-groups");
  groups?.addEventListener("click", (event) => {
    const head = event.target.closest?.(".mem-a-ghead");
    if (head) {
      const kind = head.closest("[data-mem-group]")?.getAttribute("data-mem-group") || "";
      const group = memoryGroupOf(kind);
      group.open = !group.open;
      const section = head.closest(".mem-a-group");
      section?.classList.toggle("open", group.open);
      const body = section?.querySelector(".mem-a-gbody");
      if (group.open) body?.removeAttribute("hidden");
      else body?.setAttribute("hidden", "true");
      head.setAttribute("aria-expanded", String(group.open));
      if (group.open && !group.loaded) void loadMemoryGroup(kind, gen);
      return;
    }
    const more = event.target.closest?.("[data-mem-more]");
    if (more) {
      void loadMemoryGroup(more.getAttribute("data-mem-more") || "", gen, { append: true });
      return;
    }
    const supersede = event.target.closest?.("[data-mem-supersede]");
    if (supersede) {
      void supersedeMemoryItem(supersede.getAttribute("data-mem-supersede") || "", gen);
      return;
    }
    const forget = event.target.closest?.("[data-mem-forget]");
    if (forget) void forgetMemoryItem(forget.getAttribute("data-mem-forget") || "", gen);
  });

  const props = document.getElementById("mem-a-props");
  props?.addEventListener("click", (event) => {
    const evidence = event.target.closest?.(".mem-prop-evidence.is-hit[data-conv]");
    if (evidence) {
      const conversationId = evidence.getAttribute("data-conv");
      if (conversationId) void openConversation(conversationId);
      return;
    }
    const apply = event.target.closest?.("[data-prop-apply]");
    if (apply) {
      void applyMemoryProposalA(apply.closest(".mem-prop"), gen);
      return;
    }
    const ignore = event.target.closest?.("[data-prop-ignore]");
    if (ignore) void dismissMemoryProposalA(ignore.closest(".mem-prop"), gen);
  });

  document.getElementById("mem-a-ext-open")?.addEventListener("click", () => {
    const lines = memoryPageState.externalLines;
    openModal("一生记忆库", (body) => {
      body.innerHTML = `<div class="mem-a-ext-lines">${lines
        .map((line) => `<p>${esc(line)}</p>`)
        .join("")}</div>
        <div class="modal-actions"><button class="modal-primary" type="button" data-modal-ok>知道了</button></div>`;
      body.querySelector("[data-modal-ok]")?.addEventListener("click", closeModal);
    });
  });

  await Promise.all([
    loadMemorySummary(gen),
    loadMemoryReviewState(gen),
    loadMemoryExternal(gen),
  ]);
}

function openMemoryImportPlaceholder() {
  // 导入先占位（2026-11-13 用户拍板）：现在没有统一的记忆格式，等格式定了再接。
  showAlert("导入记忆", "这块先占个位：目前还没有统一的记忆格式，等格式定了再做。");
}

async function loadMemorySummary(gen) {
  const totalEl = document.getElementById("mem-a-total");
  const chipsEl = document.getElementById("mem-a-chips");
  if (!totalEl || !chipsEl) return;
  const scope = memoryPageState.scope;
  const q = memoryPageState.q;
  const query = q ? `&q=${encodeURIComponent(q)}` : "";
  try {
    const response = await request(
      `/api/v1/agent/memory?scope=${encodeURIComponent(scope)}&limit=0&excludeKinds=work${query}`,
      { cache: "no-store" },
    );
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope || memoryPageState.q !== q) return;
    if (response.status === 404) {
      totalEl.textContent = "—";
      chipsEl.replaceChildren();
      const groups = document.getElementById("mem-a-groups");
      if (groups) groups.innerHTML = `<div class="set-hint">记忆未启用（服务端 MEMORY_ENABLED=false）。</div>`;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    const counts = data.counts && typeof data.counts === "object"
      ? data.counts
      : { all: Number(data.total) || 0, byKind: data.byKind || {}, superseded: 0 };
    memoryPageState.counts = {
      all: Number(counts.all) || 0,
      byKind: counts.byKind && typeof counts.byKind === "object" ? counts.byKind : {},
      superseded: Number(counts.superseded) || 0,
    };
    memoryPageState.total = Number(data.total) || memoryPageState.counts.all;
    memoryPageState.canConsolidate = data.canConsolidate === true;
    memoryPageState.canImport = data.canImport === true;
    memoryPageState.consolidateJob = data.consolidateJob === true;
    totalEl.textContent = String(memoryPageState.counts.all);
    updateMemoryControls();
    renderMemoryChips();
    renderMemoryGroups(gen);
  } catch (error) {
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope || memoryPageState.q !== q) return;
    if (error.message === "forbidden") return;
    totalEl.textContent = "—";
    chipsEl.replaceChildren();
    const groups = document.getElementById("mem-a-groups");
    if (groups) groups.innerHTML = `<div class="set-hint is-error">读不到记忆：${esc(error.message)}</div>`;
  }
}

function updateMemoryControls() {
  const consolidate = document.getElementById("mem-consolidate");
  const importButton = document.getElementById("mem-import");
  if (consolidate) consolidate.hidden = !memoryPageState.canConsolidate;
  if (importButton) importButton.hidden = !memoryPageState.canImport;
  const running = memoryPageState.status?.running === true;
  if (consolidate) {
    consolidate.disabled = running;
    consolidate.innerHTML = running
      ? "整理中…"
      : '整理记忆 <span class="mem-a-q" aria-hidden="true">?</span>';
  }
}

function renderMemoryChips() {
  const box = document.getElementById("mem-a-chips");
  if (!box) return;
  const counts = memoryPageState.counts;
  const parts = [
    `<button class="mem-a-chip ${memoryPageState.kind ? "" : "on"}" type="button" data-mem-kind="all">全部<b>${counts.all}</b></button>`,
  ];
  for (const kind of MEMORY_KIND_ORDER) {
    if (kind === "work") continue;
    const count = Number(counts.byKind[kind]) || 0;
    if (count <= 0 && memoryPageState.kind !== kind) continue;
    const on = memoryPageState.kind === kind ? "on" : "";
    parts.push(
      `<button class="mem-a-chip ${on}" type="button" data-mem-kind="${kind}">${esc(MEMORY_KIND_LABEL[kind] || kind)}<b>${count}</b></button>`,
    );
  }
  box.innerHTML = parts.join("");
}

function renderMemoryGroups(gen) {
  const box = document.getElementById("mem-a-groups");
  if (!box) return;
  const counts = memoryPageState.counts.byKind;
  const kinds = memoryPageState.kind
    ? [memoryPageState.kind]
    : MEMORY_KIND_ORDER.filter((kind) => kind !== "work" && (Number(counts[kind]) || 0) > 0);
  if (kinds.length === 0) {
    box.innerHTML = memoryPageState.q
      ? `<div class="set-hint">没有匹配「${esc(memoryPageState.q)}」的记忆。</div>`
      : `<div class="set-hint">还没有记忆。聊几次之后，偏好会自动出现在这里；也可以直接对助手说「记住：……」。</div>`;
    return;
  }
  box.innerHTML = kinds
    .map((kind) => {
      const total = Number(counts[kind]) || 0;
      const group = memoryGroupOf(kind, total);
      if (memoryPageState.kind === kind) group.open = true;
      const label = esc(MEMORY_KIND_LABEL[kind] || kind);
      const tip = MEMORY_KIND_TIPS[kind] || "";
      const hint = memoryGroupHint(kind);
      return `<section class="mem-a-group ${group.open ? "open" : ""}" data-mem-group="${kind}">
        <button class="mem-a-ghead" type="button" aria-expanded="${group.open}">
          <svg class="mem-a-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          <span class="mem-a-gtitle"${tip ? ` data-tip="${attr(tip)}"` : ""}>${label}</span>
          <span class="mem-a-gcount">${total}</span>
          ${hint ? `<span class="mem-a-ghint">${hint}</span>` : ""}
        </button>
        <div class="mem-a-gbody"${group.open ? "" : " hidden"}>${memoryGroupBodyMarkup(group, kind)}</div>
      </section>`;
    })
    .join("");
  for (const kind of kinds) {
    const group = memoryGroupOf(kind);
    if (group.open && !group.loaded && !group.loading) void loadMemoryGroup(kind, gen);
  }
}

function memoryGroupBodyMarkup(group, kind) {
  if (group.loading && group.items.length === 0) return `<div class="set-hint">读取中…</div>`;
  if (group.error) return `<div class="set-hint is-error">${esc(group.error)}</div>`;
  if (group.items.length === 0) return `<div class="set-hint">还没有这类记忆。</div>`;
  const more =
    group.items.length < group.total
      ? `<button class="mem-a-more" type="button" data-mem-more="${kind}">还有 ${group.total - group.items.length} 条 · 加载更多</button>`
      : "";
  return group.items.map((item) => memoryItemMarkupA(item)).join("") + more;
}

function renderMemoryGroupBody(kind) {
  const section = document.querySelector(`.mem-a-group[data-mem-group="${CSS.escape(kind)}"]`);
  const body = section?.querySelector(".mem-a-gbody");
  if (!body) return;
  body.innerHTML = memoryGroupBodyMarkup(memoryGroupOf(kind), kind);
}

export { MEMORY_A_DEFAULT_OPEN, MEMORY_A_PAGE_SIZE, loadMemorySummary, memoryElapsedSeconds, memoryGroupBodyMarkup, memoryGroupHint, memoryGroupOf, memoryPageAlive, memoryPageState, memorySettingsMarkup, memoryShortDate, memorySourceLabel, memoryStatusTime, openMemoryImportPlaceholder, renderMemoryChips, renderMemoryGroupBody, renderMemoryGroups, startMemoryPolling, stopMemoryPolling, updateMemoryControls, wireMemorySettings };
