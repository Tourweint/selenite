/**
 * 记忆页 A 版：骨架、分组、摘要
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { attr, esc } from "./markdown.js";
import { applyMemoryProposalA, clearMemoryProposalCard, dismissMemoryProposalA, forgetMemoryItem, loadMemoryExternal, loadMemoryGroup, loadMemoryReviewState, memoryItemMarkupA, openMemoryConsolidateDialog, openMemorySplitDialog, supersedeMemoryItem } from "./memory-items.js";
import { request } from "./net.js";
// 提醒沉淀（2026-11-19 批4）：入口动作与建议卡（采纳/忽略）走同一个轻模块。
import { runReminderDistill } from "./reminder-distill.js";
import { currentSettingsPage } from "./route.js";
import { sectionMarkup } from "./settings-atoms.js";
import { MEMORY_KIND_LABEL, MEMORY_KIND_ORDER, MEMORY_KIND_TIPS } from "./settings-memory.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

/* ── 记忆页 A 版（2026-11-13）──────────────────────────────
 * 大字概览 + 分类计数片（唯一筛选）+ 搜索 + 分组折叠 + 可恢复的整理状态。
 * 2026-11-14：工作履历从对话设置档案卡搬进来，作为记忆分组下方的一条独立折叠；
 * 只对 partner scope 显示，不混进「N 条记忆」计数。
 * 旧版整套保持原样（*Legacy），`MEMORY_PAGE_A=false` 时回落。
 * 整理：?background=1 立即 202，页面轮询 /consolidate/state；
 * 切页回来能看见"正在整理 / 上次建议 / 失败原因"，同一 scope 在跑时不会重复调模型。 */

const MEMORY_A_PAGE_SIZE = 20;
// 所有分组默认收起（2026-11-15 用户拍板，原 preference/intention 默认展开）：
// 页面只留分组头与计数，展开才按需拉正文；搜索命中时仍会展开（见 memoryGroupOf）。
const MEMORY_A_DEFAULT_OPEN = new Set();

const memoryPageState = {
  gen: 0,
  scope: "global",
  q: "",
  kind: "",
  counts: { all: 0, byKind: {}, superseded: 0 },
  total: 0,
  groups: new Map(),
  status: null,
  /** 一排人：{ scope, label, count, kind }；null = 还没读回来。 */
  people: null,
  /** "全部整理"的聚合状态：{ running, total, done, label, proposals, errors }。 */
  batch: null,
  canConsolidate: false,
  canImport: false,
  canSplit: false,
  consolidateJob: false,
  /** 原文档案列表（拆分后可看，不参与召回） */
  docs: null,
  externalLines: [],
  pollTimer: 0,
};

/** 记忆页「回到顶部」按钮的 scroll 监听；随记忆页装卸（离开设置页/重进时摘掉）。 */
let memoryBacktopHandler = null;

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

/** 卸掉「回到顶部」监听。只在记忆页重新装配时调（wireMemorySettings / renderSettings 离页），
 *  不能塞进 stopMemoryPolling —— 后者每次读整理状态都会调，会把回顶监听一起摘掉。 */
function stopMemoryBacktop() {
  if (memoryBacktopHandler) {
    el.settingsScroll?.removeEventListener("scroll", memoryBacktopHandler);
    memoryBacktopHandler = null;
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
  if (value === "imported" || value.startsWith("import:")) return "导入";
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

/** 外部导入区的来源分节（2026-11-15 当天撤回）：导入条目按 kind 落进普通分组，
 *  条目右上角照常带来源标（memorySourceLabel 把 import:* 标成「导入」），不再单开一区。 */

function memoryGroupHint(kind) {
  // 偏好不再标「每轮都会想起」：它只是召回时排在前面成段（engine.ts buildContext），
  // 不进当轮候选集时一样不会带（2026-11-16 用户纠正后摘掉这句解释）。
  if (kind === "intention") return "未兑现的，优先想起";
  // 「日常经过 · 默认收起」2026-11-15 摘掉：所有分组都默认收起了，这句成了废话
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
    <div class="mem-a-people" id="mem-a-people" role="tablist" aria-label="选择记忆范围"></div>
    <div class="mem-a-run" id="mem-a-run" hidden>
      <span class="mem-a-spinner" aria-hidden="true"></span>
      <span id="mem-a-run-text">正在整理…</span>
      <span class="mem-a-elapsed" id="mem-a-elapsed"></span>
    </div>
    <div class="card mem-a-props" id="mem-a-props-card" hidden>
      <div class="mem-a-props-head">
        <span class="mem-a-props-title" data-tip="整理 = 让模型回看最近的记忆，找出重复、过时、说法不一致的条目。它只给建议：你逐条点「应用」才会把旧的那条标成过时；不会自动改，也没有「全部应用」。">整理建议</span>
        <span class="mem-a-count" id="mem-a-prop-count"></span>
        <span class="mem-a-prop-note" id="mem-a-prop-note"></span>
      </div>
      <div class="mem-a-props-list" id="mem-a-props"></div>
    </div>
    <div class="card mem-a-props" id="mem-a-remcard" hidden>
      <div class="mem-a-props-head">
        <span class="mem-a-props-title" data-tip="沉淀建议 = 总管把你反复说的提醒蒸馏出来的教诲候选。点「采纳」才写进偏好（永不删）；「忽略」只是从清单划掉，不写库。">沉淀建议</span>
        <span class="mem-a-count" id="mem-a-rem-count"></span>
        <span class="mem-a-prop-note">总管蒸馏 · 你逐条采纳</span>
      </div>
      <div class="mem-a-props-list" id="mem-a-rem-list"></div>
    </div>
    <div class="mem-a-toolbar">
      <label class="mem-a-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="mem-a-search" type="search" spellcheck="false"
               placeholder="搜记忆内容，比如「猫」「汇报」「跑步」" aria-label="搜索记忆" />
      </label>
    </div>
    <div class="mem-a-groups" id="mem-a-groups"><div class="set-hint">读取中…</div></div>
    <details class="mem-a-work" id="mem-a-work" hidden>
      <summary class="mem-a-work-head">
        <svg class="mem-a-chev mem-a-work-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <span class="mem-a-gtitle">工作履历</span>
        <span class="mem-a-gcount" id="mem-a-work-count">0</span>
        <span class="mem-a-ghint">派单结算 · 只读</span>
      </summary>
      <div class="mem-a-work-body" id="mem-a-work-list"></div>
    </details>
    <details class="mem-a-work mem-a-docs" id="mem-a-docs" hidden>
      <summary class="mem-a-work-head">
        <svg class="mem-a-chev mem-a-work-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <span class="mem-a-gtitle">原文档案</span>
        <span class="mem-a-gcount" id="mem-a-docs-count">0</span>
        <span class="mem-a-ghint">拆分后的原文 · 只读</span>
      </summary>
      <div class="mem-a-work-body" id="mem-a-docs-list"></div>
    </details>
    <div class="mem-a-external" id="mem-a-external" hidden>
      <div class="mem-a-external-main">
        <div class="mem-a-external-title">一生记忆库</div>
        <div class="mem-a-external-line" id="mem-a-external-line"></div>
      </div>
      <button class="ghost mem-act" type="button" id="mem-a-ext-open" hidden>查看</button>
    </div>
    <button class="mem-a-backtop" type="button" id="mem-a-backtop" hidden
      aria-label="回到顶部" data-tip="回到顶部">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/><path d="M12 19V9"/></svg>
    </button>`,
    "",
    `<div class="mem-a-head-actions">
      <button class="ghost mem-act" type="button" id="mem-distill" hidden
        data-tip="沉淀提醒 = 代码先从最近 30 天收集你反复说过的话（0 token），跳总管蒸馏成教诲建议；你回这里逐条采纳才写进偏好（永不删）。">沉淀提醒</button>
      <button class="ghost mem-act" type="button" id="mem-migrate" hidden
        data-tip="迁移 = 把这个范围的记忆整体搬到另一个项目或「我的记忆」。只搬家，不去重、不调模型；搬迁后原范围就空了。">迁移</button>
      <button class="ghost mem-act" type="button" id="mem-import" hidden>导入</button>
      <button class="ghost mem-act" type="button" id="mem-consolidate" hidden
        data-tip="整理 = 让辅助模型回看最近的记忆，找出重复、过时、说法不一致的条目。&#10;&#10;它只给建议：你逐条点「应用」才会把旧的那条标成过时；不会自动删，也没有「全部应用」。&#10;&#10;这一步会调用一次辅助模型（单独请求，不占当前对话上下文），会消耗 token。">整理</button>
      <button class="btn-primary mem-a-split" type="button" id="mem-split" hidden
        data-tip="拆分记忆 = 把一条超过 200 字、记了很多事的长记忆，拆成几条短原子；完整原文会存进「原文档案」，不删任何东西。&#10;&#10;纯代码拆分，不调用模型、不消耗 token；按文件摘要或正文句子机械切分。">拆分记忆</button>
    </div>`,
  );
}

async function wireMemorySettings() {
  const gen = ++memoryPageState.gen;
  stopMemoryPolling();
  stopMemoryBacktop();
  wireMemoryBacktop(gen);
  memoryPageState.scope = "global";
  memoryPageState.q = "";
  memoryPageState.kind = "";
  memoryPageState.counts = { all: 0, byKind: {}, superseded: 0 };
  memoryPageState.total = 0;
  memoryPageState.groups.clear();
  memoryPageState.status = null;
  memoryPageState.people = null;
  memoryPageState.batch = null;
  memoryPageState.externalLines = [];

  document.getElementById("mem-a-people")?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-mem-scope]");
    if (!button) return;
    if (memoryPageState.batch?.running) {
      toast("正在逐个整理，等它跑完再切");
      return;
    }
    switchMemoryScope(button.getAttribute("data-mem-scope") || "global", gen);
  });

  // 范围 tabs 溢出横滚（2026-11-15 项目记忆之后一排能到 20 个）：滚动条刻意隐藏（A 版口径），
  // 所以把滚轮直转成横滚、并支持按住拖拽滑动；拖过 6px 就吃掉落点 click，防止拖完误触 tab。
  const peopleBox = document.getElementById("mem-a-people");
  if (peopleBox) {
    peopleBox.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const max = peopleBox.scrollWidth - peopleBox.clientWidth;
      if (max <= 0) return;
      event.preventDefault();
      peopleBox.scrollLeft += event.deltaY;
    }, { passive: false });
    let dragFrom = 0, dragStart = 0, dragged = 0;
    peopleBox.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") return; // 触屏原生能滑
      dragFrom = event.clientX;
      dragStart = peopleBox.scrollLeft;
      dragged = 0;
      const onMove = (moveEvent) => {
        dragged = moveEvent.clientX - dragFrom;
        if (Math.abs(dragged) > 4) peopleBox.scrollLeft = dragStart - dragged;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (Math.abs(dragged) > 6) {
          peopleBox.addEventListener("click", (clickEvent) => {
            clickEvent.stopPropagation();
            clickEvent.preventDefault();
          }, { capture: true, once: true });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
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

  document.getElementById("mem-import")?.addEventListener("click", () => void openMemoryImportDialog(gen));
  document.getElementById("mem-migrate")?.addEventListener("click", () => {
    void openMemoryMigrateDialog(gen);
  });
  document.getElementById("mem-split")?.addEventListener("click", () => {
    void openMemorySplitDialog(gen);
  });
  document.getElementById("mem-consolidate")?.addEventListener("click", () => {
    void openMemoryConsolidateDialog(gen);
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
    const doc = event.target.closest?.("[data-mem-doc]");
    if (doc) {
      void openMemoryDocument(doc.getAttribute("data-mem-doc") || "");
      return;
    }
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

  document.getElementById("mem-a-docs-list")?.addEventListener("click", (event) => {
    const doc = event.target.closest?.("[data-doc-id]");
    if (doc) void openMemoryDocument(doc.getAttribute("data-doc-id") || "");
  });

  const props = document.getElementById("mem-a-props");
  props?.addEventListener("click", (event) => {
    const apply = event.target.closest?.("[data-prop-apply]");
    if (apply) {
      void applyMemoryProposalA(apply.closest(".mem-prop"), gen);
      return;
    }
    const ignore = event.target.closest?.("[data-prop-ignore]");
    if (ignore) void dismissMemoryProposalA(ignore.closest(".mem-prop"), gen);
  });

  // 提醒沉淀（2026-11-19 批4）：入口 + 建议卡的采纳 / 忽略。
  document.getElementById("mem-distill")?.addEventListener("click", (event) => {
    void runReminderDistill(event.currentTarget);
  });
  const remList = document.getElementById("mem-a-rem-list");
  remList?.addEventListener("click", (event) => {
    const adopt = event.target.closest?.("[data-rem-adopt]");
    const dismiss = adopt ? null : event.target.closest?.("[data-rem-dismiss]");
    if (!adopt && !dismiss) return;
    const text = (adopt || dismiss)?.closest("[data-rem-item]")?.getAttribute("data-rem-item") || "";
    if (!text) return;
    void applyReminderAdviceRow(adopt ? "adopt" : "dismiss", text, gen);
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
    loadMemoryPeople(gen),
    loadMemorySummary(gen),
    loadMemoryWork(gen),
    loadMemoryDocuments(gen),
    loadMemoryReviewState(gen),
    loadMemoryExternal(gen),
    loadMemoryReminderAdvice(gen),
  ]);
}

/* ── 提醒沉淀（2026-11-19 批4）──────────────────────────────
 * 入口（mem-distill）动作在 web/reminder-distill.js（与设置抽屉人设页共用）；
 * 这里只管两件界面的事：入口显隐（跟建议端点是否 404 走）与建议卡（采纳/忽略）。
 * 建议端点是轻文件读（.data/reminder-advice.json），跟其它并行加载一起拉，不加重页面。 */

/** 待采纳建议卡 + 入口显隐：404（REMINDER_DISTILL_ENABLED=false）→ 都不出现。 */
async function loadMemoryReminderAdvice(gen) {
  const card = document.getElementById("mem-a-remcard");
  const distill = document.getElementById("mem-distill");
  if (!card && !distill) return;
  try {
    const response = await request("/api/v1/agent/reminder-advice", { cache: "no-store" });
    if (!memoryPageAlive(gen)) return;
    if (response.status === 404) {
      if (distill) distill.hidden = true;
      if (card) card.hidden = true;
      return;
    }
    if (distill) distill.hidden = false;
    const data = await response.json().catch(() => ({}));
    const items = Array.isArray(data.items) ? data.items : [];
    const count = document.getElementById("mem-a-rem-count");
    const list = document.getElementById("mem-a-rem-list");
    if (!card || !items.length) {
      if (card) card.hidden = true;
      if (list) list.replaceChildren();
      if (count) count.textContent = "";
      return;
    }
    card.hidden = false;
    if (count) count.textContent = `${items.length} 条`;
    if (list) {
      list.innerHTML = items
        .map((text) => `<div class="mem-prop" data-rem-item="${attr(String(text))}">
          <div class="mem-prop-line"><span class="mem-prop-tag is-keep">建议</span><span class="mem-prop-text">${esc(String(text))}</span></div>
          <div class="mem-prop-actions">
            <button class="ghost mem-act" type="button" data-rem-adopt>采纳</button>
            <button class="ghost mem-act" type="button" data-rem-dismiss>忽略</button>
          </div>
        </div>`)
        .join("");
    }
  } catch (error) {
    if (!memoryPageAlive(gen) || error.message === "forbidden") return;
    // 读失败不挡页面：卡片收起，入口照常（收集端点可能仍是好的）
    if (card) card.hidden = true;
  }
}

/** 采纳 / 忽略一条沉淀建议。采纳 = 服务端写偏好（taught，永不删）；忽略 = 只从清单划掉。 */
async function applyReminderAdviceRow(action, text, gen) {
  try {
    const response = await request("/api/v1/agent/reminder-advice", {
      method: "PUT",
      body: JSON.stringify({ actions: [{ text, action }] }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || `没存成：HTTP ${response.status}`);
      // 400 多半是清单变了（总管重新蒸馏过 / 之前已点过）：刷新一份新的
      if (response.status === 400) void loadMemoryReminderAdvice(gen);
      return;
    }
    if (action === "adopt") {
      toast(Number(data.duplicates) > 0 ? "这条已经在偏好里了，已从清单划掉" : "已采纳：写进偏好（永不删），下一轮召回可见");
    } else {
      toast("已忽略");
    }
    void loadMemorySummary(gen);
    void loadMemoryReminderAdvice(gen);
  } catch (error) {
    if (error.message === "forbidden") return;
    toast(`没存成：${error.message}`);
  }
}

/** 回到顶部（2026-11-16）：分组/原文档案一展开能滚很长，页内给一枚浮动按钮，
 *  跟随内容列滚动显隐；点在设置页自己的滚动容器上做 smooth 回顶。 */
function wireMemoryBacktop(gen) {
  const button = document.getElementById("mem-a-backtop");
  const scroll = el.settingsScroll;
  if (!button || !scroll) return;
  const update = () => {
    if (!memoryPageAlive(gen)) return;
    button.hidden = scroll.scrollTop < 240;
  };
  memoryBacktopHandler = update;
  scroll.addEventListener("scroll", update, { passive: true });
  button.addEventListener("click", () => {
    // 直接设 scrollTop：内嵌 webview 里平滑滚动（scrollTo smooth / rAF）都是 no-op，
    // 一步到顶最可靠；按钮随 scroll 事件自动收起。
    scroll.scrollTop = 0;
    update();
  });
  update();
}

/**
 * 迁移记忆（2026-11-17 项目合并与记忆迁移）：把当前 scope 整体搬到另一个项目或「我的记忆」。
 *
 * 只对 `project:` scope 显示（活项目与孤儿都能搬）。目标列表来自 `/api/v1/projects`（不含归档）：
 * 搬到归档项目等于搬进另一次封存，界面不给这个选项。
 * 服务端是纯搬家（不去重、不调模型）；搬完后源 scope 就空了，页面顺势切到目标范围。
 */
async function openMemoryMigrateDialog(gen) {
  const from = memoryPageState.scope;
  if (!from.startsWith("project:")) return;
  if (memoryPageState.batch?.running || memoryPageState.status?.running) {
    toast("正在整理，等它跑完");
    return;
  }
  let projects = [];
  try {
    const response = await request("/api/v1/projects", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    projects = Array.isArray(data.projects) ? data.projects : [];
  } catch (error) {
    if (error.message === "forbidden") return;
    toast(`读不到项目列表：${error.message}`);
    return;
  }
  const currentProjectId = from.slice("project:".length);
  const options = [
    `<option value="global">我的记忆（全局）</option>`,
    ...projects
      .filter((project) => project.id !== currentProjectId)
      .map((project) => `<option value="${attr(`project:${project.id}`)}">${esc(project.name)}</option>`),
  ].join("");
  const fromLabel = memoryPageState.people?.find((person) => person.scope === from)?.label || "当前范围";

  openModal("迁移记忆", (body) => {
    body.innerHTML = `
      <p class="modal-desc">把「${esc(fromLabel)}」里的记忆整体搬到另一个范围。<b>只搬家，不删、不去重</b>；搬完原范围就空了，重复内容之后可以用「整理」处理。</p>
      <div class="modal-field"><span>搬到</span>
        <select class="modal-input" id="mem-migrate-target">${options}</select>
      </div>
      <p class="modal-hint" id="mem-migrate-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="btn-primary" type="button" id="mem-migrate-confirm">开始迁移</button>
      </div>`;
    const hint = body.querySelector("#mem-migrate-hint");
    const confirm = body.querySelector("#mem-migrate-confirm");
    const select = body.querySelector("#mem-migrate-target");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    confirm?.addEventListener("click", async () => {
      if (confirm.disabled) return;
      const to = select?.value || "";
      if (!to) return;
      confirm.disabled = true;
      confirm.textContent = "迁移中…";
      try {
        const response = await request("/api/v1/agent/memory/scope/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, to }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (hint) {
            hint.textContent = data.message || `迁移失败：HTTP ${response.status}`;
            hint.classList.add("is-error");
          }
          confirm.disabled = false;
          confirm.textContent = "开始迁移";
          return;
        }
        closeModal();
        toast(`已迁移 ${Number(data.records) || 0} 条记忆`);
        if (memoryPageAlive(gen)) {
          // 源已空：先刷新「一排人」的计数（孤儿 tab 可能因此消失），再切到目标范围看结果
          await loadMemoryPeople(gen);
          if (!memoryPageAlive(gen)) return;
          if (to !== memoryPageState.scope) switchMemoryScope(to, gen);
          else void loadMemorySummary(gen);
        }
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        if (hint) {
          hint.textContent = `迁移失败：${error.message}`;
          hint.classList.add("is-error");
        }
        confirm.disabled = false;
        confirm.textContent = "开始迁移";
      }
    });
  });
}

/** 导入弹窗（2026-11-15 第二轮，方案 docs/设计方案/2026-11-15-记忆导入第二轮（全量来源与勾选批量）.md）：
 *  所有 Agent 一张清单，有货的勾选后底部一键批量导入；没检测到的只列灰态。
 *  同一 Agent 的「全局」与「项目」来源合成一个可展开组，不再并排成两张卡。
 *  文件导入第二轮删除——ChatGPT/Claude 的云端记忆本机本来就没有可读文件，按用户要求
 *  这两个来源也不再列出。全部只增不改、重复跳过，条目进「我的记忆」或对应项目。 */
async function openMemoryImportDialog(gen) {
  if (memoryPageState.batch?.running || memoryPageState.status?.running) {
    toast("正在整理，等它跑完");
    return;
  }
  openModal("导入记忆", (body) => {
    body.innerHTML = `<div class="mem-import-loading"><p class="set-hint">正在看这台机器上有哪些 Agent 的记忆…</p></div>`;
    void (async () => {
      let sources = [];
      try {
        const response = await request("/api/v1/agent/memory/import/sources", { cache: "no-store" });
        if (response.status === 404) {
          body.innerHTML = `<div class="mem-import-loading"><p class="set-hint">来源扫描未启用（服务端 MEMORY_IMPORT_SOURCES=false）。</p><div class="modal-actions"><button class="ghost" type="button" data-modal-cancel>关闭</button></div></div>`;
          wireImportDialogChrome(body);
          return;
        }
        if (!response.ok) throw new Error(String(response.status));
        sources = (await response.json().catch(() => ({})))?.sources || [];
      } catch (error) {
        if (error.message === "forbidden") return;
        body.innerHTML = `<div class="mem-import-loading"><p class="set-hint">读取来源失败：${esc(error.message)}</p><div class="modal-actions"><button class="ghost" type="button" data-modal-cancel>关闭</button></div></div>`;
        wireImportDialogChrome(body);
        return;
      }

      const available = sources.filter((source) => Number(source.count) > 0);
      const rest = sources.filter((source) => Number(source.count) <= 0);
      const total = available.reduce((sum, source) => sum + Number(source.count || 0), 0);
      const availableMarkup = available.length
        ? `<div class="mem-import-grid">${importSourceBlocks(available)}</div>`
        : `<p class="set-hint mem-import-empty">这台机器上没检测到可导入的记忆。下面仍然把支持检测的 Agent 都列出来。</p>`;
      const restMarkup = rest.length
        ? `<details class="mem-import-absent" open>
             <summary class="mem-import-sub">没检测到本地记忆（${rest.length}）</summary>
             <div class="mem-import-grid">${rest.map((source) => importSourceCard(source)).join("")}</div>
           </details>`
        : "";

      body.innerHTML = `<div class="mem-import-panel">
        <div class="mem-import-head">
          <div class="mem-import-summary"><b>${available.length}</b> 个来源可用 <span>·</span> 共 <b>${total}</b> 条</div>
          ${available.length ? `<button class="ghost mem-act" type="button" data-toggle-all>全不选</button>` : ""}
        </div>
        <p class="set-hint mem-import-tip">勾选要并进记忆库的来源。只增不改；本 scope 或其它全局/项目 scope 已有的重复条目自动跳过。</p>
        ${availableMarkup}
        ${restMarkup}
        <div class="mem-import-foot">
          <div class="mem-import-picked" data-picked>已选 ${available.length} 个 · 约 ${total} 条</div>
          <div class="modal-actions">
            <button class="ghost" type="button" data-modal-cancel>关闭</button>
            <button class="modal-primary" type="button" data-import-selected ${available.length ? "" : "disabled"}>一键导入</button>
          </div>
        </div>
      </div>`;
      wireImportDialogChrome(body);
      wireImportDialogActions(body, gen);
    })();
  }, { className: "modal-import" });
}

/** 来源 id / 名称里判断是不是项目级记忆：只有 `（项目）` 后缀或明确写「的项目记忆」才算，
 *  避免把 Qoder CLI 的「跨项目记忆」误判成项目 scope。 */
function importSourceIsProject(source) {
  const name = String(source?.name || "");
  const note = String(source?.note || "");
  return String(source?.id || "").endsWith("-projects") || /（项目）/.test(name) || /的项目记忆/.test(note);
}

/** 同一 Agent 的全局/项目来源共用 family：`qoder-cli-projects` → `qoder-cli`。 */
function importSourceFamily(source) {
  const id = String(source?.id || "");
  return id.endsWith("-projects") ? id.slice(0, -"-projects".length) : id;
}

/** 组头显示名：去掉「（项目）」后缀，组内再用「全局 / 项目」小标签区分。 */
function importSourceFamilyName(source) {
  return String(source?.name || "").replace(/（项目）$/, "");
}

/** 把有货来源按 family 分组；同一 family 同时有全局和项目时才折叠成一张组卡，
 *  单来源（ZCode、Claude Code 等）保持原样，不为了「统一」多套一层点击。 */
function importSourceBlocks(sources) {
  const groups = new Map();
  for (const source of sources) {
    const key = importSourceFamily(source);
    let group = groups.get(key);
    if (!group) {
      group = { key, name: importSourceFamilyName(source), all: [], global: [], project: [] };
      groups.set(key, group);
    }
    group.all.push(source);
    (importSourceIsProject(source) ? group.project : group.global).push(source);
  }
  return [...groups.values()]
    .map((group) =>
      group.global.length > 0 && group.project.length > 0
        ? importSourceFamilyMarkup(group)
        : group.all.map((source) => importSourceCard(source)).join(""),
    )
    .join("");
}

function importSourceFamilyMarkup(group) {
  const total = group.all.reduce((sum, source) => sum + Number(source.count || 0), 0);
  const scopeBits = [
    group.global.length ? `全局 ${group.global.reduce((sum, source) => sum + Number(source.count || 0), 0)}` : "",
    group.project.length ? `项目 ${group.project.reduce((sum, source) => sum + Number(source.count || 0), 0)}` : "",
  ].filter(Boolean).join(" · ");
  return `<details class="mem-import-family" data-family="${attr(group.key)}">
    <summary class="mem-import-family-head">
      <span class="mem-import-family-chev" aria-hidden="true"></span>
      <span class="mem-import-family-name">${esc(group.name)}</span>
      <span class="mem-import-family-count">${total} 条</span>
      <span class="mem-import-family-scopes">${esc(scopeBits)}</span>
    </summary>
    <div class="mem-import-family-body">${group.all.map((source) => importSourceCard(source, true)).join("")}</div>
  </details>`;
}

/** 一个来源一张小方框：复选框 + 名字 + 条数 + 一行说明；count=0 的 disabled 灰态。
 *  inFamily=true 时去掉名字里的「（项目）」，改用右上角的「全局 / 项目」小标签。 */
function importSourceCard(source, inFamily = false) {
  const count = Math.max(0, Number(source.count) || 0);
  const found = count > 0;
  const project = importSourceIsProject(source);
  const name = inFamily ? importSourceFamilyName(source) : String(source.name || "");
  const badge = found ? `${count} 条` : "没检测到";
  return `<label class="mem-import-card${found ? " is-on" : " is-off"}${inFamily ? " is-in-family" : ""}" data-source="${attr(source.id)}" data-count="${count}">
    <input type="checkbox" ${found ? "checked" : "disabled"} data-source-check aria-label="${attr(source.name)}">
    <span class="mem-import-box" aria-hidden="true"></span>
    <span class="mem-import-body">
      <span class="mem-import-name">${esc(name)}${inFamily ? `<span class="mem-import-scope-tag">${project ? "项目" : "全局"}</span>` : ""}<b>${badge}</b></span>
      <span class="mem-import-note">${esc(source.note)}</span>
      ${found ? `<span class="mem-import-state" data-import-state></span>` : ""}
    </span>
  </label>`;
}


/** 弹窗底部的关闭钮：内容渲染成败都要有。 */function wireImportDialogChrome(body) {
  body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
}

/** 勾选 + 一键批量。导完刷新当前列表；来源接口幂等（重复导只会全是跳过）。
 *  批量 = 按勾选顺序逐个 POST，不新增服务端批处理端点；一个失败不挡后面的。 */
function wireImportDialogActions(body, gen) {
  const checks = [...body.querySelectorAll("[data-source-check]:not(:disabled)")];
  const picked = body.querySelector("[data-picked]");
  const button = body.querySelector("[data-import-selected]");
  const toggleAll = body.querySelector("[data-toggle-all]");
  let running = false;
  let progressText = "";

  const update = () => {
    const selected = checks.filter((input) => input.checked);
    const total = selected.reduce(
      (sum, input) => sum + Number(input.closest("[data-source]")?.getAttribute("data-count") || 0),
      0,
    );
    if (picked) {
      picked.textContent = running
        ? progressText || "正在导入…"
        : selected.length
          ? `已选 ${selected.length} 个来源 · 约 ${total} 条`
          : "还没勾选来源";
    }
    if (button) {
      button.disabled = running || selected.length === 0;
      button.textContent = running ? "导入中…" : "一键导入";
    }
    if (toggleAll) toggleAll.textContent = checks.length > 0 && selected.length === checks.length ? "全不选" : "全选";
  };

  const panel = body.querySelector(".mem-import-panel") || body;
  panel.addEventListener("change", (event) => {
    const input = event.target.closest?.("[data-source-check]");
    if (!input || input.disabled) return;
    input.closest("[data-source]")?.classList.toggle("is-on", input.checked);
    update();
  });

  toggleAll?.addEventListener("click", () => {
    const allOn = checks.length > 0 && checks.every((input) => input.checked);
    checks.forEach((input) => {
      input.checked = !allOn;
      input.closest("[data-source]")?.classList.toggle("is-on", input.checked);
    });
    update();
  });

  button?.addEventListener("click", async () => {
    if (running) return;
    const selected = checks.filter((input) => input.checked);
    if (selected.length === 0) return;
    running = true;
    update();
    let added = 0;
    let skipped = 0;
    let failed = 0;

    for (let index = 0; index < selected.length; index += 1) {
      const card = selected[index].closest("[data-source]");
      const id = card?.getAttribute("data-source") || "";
      const state = card?.querySelector("[data-import-state]");
      progressText = `正在导入 ${index + 1}/${selected.length}…`;
      update();
      if (state) {
        state.className = "mem-import-state";
        state.textContent = `导入中…（${index + 1}/${selected.length}）`;
      }
      try {
        const response = await request(`/api/v1/agent/memory/import/sources/${encodeURIComponent(id)}`, {
          method: "POST",
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 404) {
          failed += 1;
          if (state) {
            state.textContent = "没检测到这个来源";
            state.classList.add("is-error");
          }
          continue;
        }
        if (!response.ok) throw new Error(data.message || String(response.status));
        added += Number(data.added) || 0;
        skipped += Number(data.skipped) || 0;
        if (state) state.textContent = `新增 ${Number(data.added) || 0} · 跳过 ${Number(data.skipped) || 0}`;
      } catch (error) {
        if (error.message === "forbidden") {
          running = false;
          progressText = "";
          update();
          return;
        }
        failed += 1;
        if (state) {
          state.textContent = `失败：${error.message}`;
          state.classList.add("is-error");
        }
      }
    }

    running = false;
    progressText = "";
    update();
    if (failed > 0) toast(`导入完成：新增 ${added} 条，${failed} 个来源失败`);
    else toast(`导入完成：新增 ${added} 条${skipped > 0 ? `，跳过 ${skipped} 条` : ""}`);
    void loadMemorySummary(gen);
  });

  update();
}


/** 一排人：一次请求拿全（我的 + 各在职执事 + 条数）。读不到就只剩"我的记忆"。 */
async function loadMemoryPeople(gen) {
  const box = document.getElementById("mem-a-people");
  if (!box) return;
  try {
    const response = await request("/api/v1/agent/memory/scopes", { cache: "no-store" });
    if (!memoryPageAlive(gen)) return;
    if (response.status === 404) {
      // 旧服务端没有 /memory/scopes（网页先于进程更新）：退回"执事列表 + 逐人计数"，
      // 页面不至于只剩一行"我的记忆"。新服务端上线后这里不会再走到。
      await loadMemoryPeopleFallback(gen);
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    const rows = Array.isArray(data.scopes) ? data.scopes : [];
    memoryPageState.people = rows
      .filter((row) => row && typeof row.scope === "string")
      // 外部导入伪 scope（__imported__）2026-11-15 已撤：老服务端可能还下发，直接滤掉
      .filter((row) => row.scope !== "__imported__")
      .map((row) => ({
        scope: row.scope,
        label: String(row.label || (row.scope === "global" ? "我的记忆" : "执事")),
        count: Number(row.count) || 0,
        // 2026-11-15：kind 扩了 project（项目记忆）；2026-11-17 扩 orphan（已删除项目的孤儿记忆）
        kind: ["partner", "project", "orphan"].includes(row.kind) ? row.kind : "mine",
      }));
    renderMemoryPeople();
  } catch (error) {
    if (!memoryPageAlive(gen) || error.message === "forbidden") return;
    // 范围清单读不到不挡页面：先按"我的记忆"渲染，正文照常加载
    memoryPageState.people = [];
    renderMemoryPeople();
  }
}

function renderMemoryPeople() {
  const box = document.getElementById("mem-a-people");
  if (!box) return;
  const people = memoryPageState.people;
  if (!people || people.length === 0) {
    box.innerHTML = `<button class="mem-a-person on" type="button" data-mem-scope="global" role="tab" aria-selected="true">我的记忆</button>`;
    return;
  }
  box.innerHTML = people
    .map((person) => {
      const on = person.scope === memoryPageState.scope;
      const badge =
        person.kind === "partner"
          ? `<span class="mem-a-person-tag">同事</span>`
          : person.kind === "project"
            ? `<span class="mem-a-person-tag">项目</span>`
            : person.kind === "orphan"
              ? `<span class="mem-a-person-tag">已删除</span>`
              : "";
      return `<button class="mem-a-person ${on ? "on" : ""}" type="button"
        data-mem-scope="${attr(person.scope)}" role="tab" aria-selected="${on}">
        ${esc(person.label)}${badge}<b>${person.count}</b>
      </button>`;
    })
    .join("");
}

async function scopeCount(scope) {
  const response = await request(
    `/api/v1/agent/memory?scope=${encodeURIComponent(scope)}&limit=0&excludeKinds=work`,
    { cache: "no-store" },
  );
  if (!response.ok) return 0;
  const data = await response.json().catch(() => ({}));
  const counts = data.counts && typeof data.counts === "object" ? data.counts : {};
  return Number(counts.all ?? data.total) || 0;
}

/** 旧服务端兼容：用 /partners + 逐 scope 计数拼出同一份"一排人"。 */
async function loadMemoryPeopleFallback(gen) {
  const rows = [{ scope: "global", label: "我的记忆", count: 0, kind: "mine" }];
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      for (const partner of Array.isArray(data.partners) ? data.partners : []) {
        if (!partner?.id || partner.id === "chief" || partner.status === "archived") continue;
        rows.push({
          scope: `partner:${partner.id}`,
          label: String(partner.name || "执事"),
          count: 0,
          kind: "partner",
        });
      }
    }
  } catch (error) {
    if (error.message === "forbidden") return;
  }
  for (const row of rows) {
    if (!memoryPageAlive(gen)) return;
    row.count = await scopeCount(row.scope);
  }
  memoryPageState.people = rows;
  renderMemoryPeople();
}

/** 切人：清筛选、清分组、重拉概览与整理状态；全部整理进行中时由调用方拦住。 */
function switchMemoryScope(scope, gen) {
  if (!scope || scope === memoryPageState.scope) return;
  memoryPageState.scope = scope;
  memoryPageState.q = "";
  memoryPageState.kind = "";
  memoryPageState.groups.clear();
  memoryPageState.status = null;
  // 单人视图不背"全部整理"的旧汇总；正在跑时上面已经拦住，不会走到这里
  if (memoryPageState.batch && !memoryPageState.batch.running) memoryPageState.batch = null;
  const search = document.getElementById("mem-a-search");
  if (search) search.value = "";
  clearMemoryProposalCard();
  renderMemoryPeople();
  renderMemoryChips();
  void loadMemorySummary(gen);
  void loadMemoryWork(gen);
  void loadMemoryDocuments(gen);
  void loadMemoryReviewState(gen);
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
    memoryPageState.canSplit = data.canSplit === true;
    memoryPageState.consolidateJob = data.consolidateJob === true;
    totalEl.textContent = String(memoryPageState.counts.all);
    // 搜索时计数是过滤后的，不能拿它覆盖"这个人一共有多少条"
    if (!q) {
      const person = memoryPageState.people?.find((item) => item.scope === scope);
      if (person) {
        person.count = memoryPageState.counts.all;
        renderMemoryPeople();
      }
    }
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

async function loadMemoryWork(gen) {
  const card = document.getElementById("mem-a-work");
  const countEl = document.getElementById("mem-a-work-count");
  const list = document.getElementById("mem-a-work-list");
  if (!card || !countEl || !list) return;
  const scope = memoryPageState.scope;
  // work 只落在执事的 partner scope；「我的记忆」没有派单履历，不摆这一块。
  if (!scope.startsWith("partner:")) {
    card.hidden = true;
    list.replaceChildren();
    return;
  }
  card.hidden = false;
  countEl.textContent = "…";
  try {
    const response = await request(
      `/api/v1/agent/memory?scope=${encodeURIComponent(scope)}&kind=work&limit=200`,
      { cache: "no-store" },
    );
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope) return;
    if (response.status === 404) {
      countEl.textContent = "—";
      list.innerHTML = `<div class="set-hint">记忆未启用，看不到工作履历。</div>`;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    const items = Array.isArray(data.items) ? data.items.slice() : [];
    const total = Number(data.total ?? items.length) || 0;
    countEl.textContent = String(total);
    if (!items.length) {
      list.innerHTML = `<div class="set-hint">还没有派单结算</div>`;
      return;
    }
    items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    list.innerHTML = items
      .map((item) => {
        const day = memoryShortDate(item.createdAt);
        const raw = String(item.content || "").replace(/\s+/g, " ").trim();
        const parts = raw.split("｜");
        if (parts[0]?.startsWith("work:")) parts.shift();
        const title = parts.shift() || raw || "（空）";
        const meta = parts.join(" · ");
        return `<div class="mem-a-work-row">
          <span class="mem-a-work-date">${esc(day || "—")}</span>
          <span class="mem-a-work-main">
            <span class="mem-a-work-text">${esc(title)}</span>
            ${meta ? `<span class="mem-a-work-meta">${esc(meta)}</span>` : ""}
          </span>
        </div>`;
      })
      .join("");
  } catch (error) {
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope || error.message === "forbidden") return;
    countEl.textContent = "—";
    list.innerHTML = `<div class="set-hint is-error">工作履历读不到：${esc(error.message)}</div>`;
  }
}

/** 原文档案（拆分后的长文）：列表只给标题/字数/来源，点开才拉正文。 */
async function loadMemoryDocuments(gen) {
  const card = document.getElementById("mem-a-docs");
  const countEl = document.getElementById("mem-a-docs-count");
  const list = document.getElementById("mem-a-docs-list");
  if (!card || !countEl || !list) return;
  const scope = memoryPageState.scope;
  card.hidden = false;
  countEl.textContent = "…";
  try {
    const response = await request(
      `/api/v1/agent/memory/documents?scope=${encodeURIComponent(scope)}&limit=200`,
      { cache: "no-store" },
    );
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope) return;
    if (response.status === 404) {
      card.hidden = true;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    const items = Array.isArray(data.items) ? data.items : [];
    const total = Number(data.total ?? items.length) || 0;
    memoryPageState.docs = items;
    countEl.textContent = String(total);
    card.hidden = total === 0;
    if (!items.length) {
      list.replaceChildren();
      return;
    }
    list.innerHTML = items
      .map((doc) => {
        const file = String(doc.sourceRef || "").split(/[\\/]/).pop() || "";
        return `<button class="mem-a-work-row mem-doc-row" type="button" data-doc-id="${attr(doc.id)}">
          <span class="mem-a-work-date">${esc(memoryShortDate(doc.createdAt) || "—")}</span>
          <span class="mem-a-work-main">
            <span class="mem-a-work-text">${esc(doc.title || "未命名原文")}</span>
            <span class="mem-a-work-meta">${esc(memorySourceLabel(doc.source))} · ${Number(doc.chars) || 0} 字${file ? ` · ${esc(file)}` : ""}</span>
          </span>
        </button>`;
      })
      .join("");
  } catch (error) {
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope || error.message === "forbidden") return;
    countEl.textContent = "—";
    list.innerHTML = `<div class="set-hint is-error">原文档案读不到：${esc(error.message)}</div>`;
  }
}

/** 读一份原文并弹层显示；只读，不提供编辑/删除。 */
async function openMemoryDocument(id) {
  if (!id) return;
  try {
    const response = await request(`/api/v1/agent/memory/documents/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    const doc = data.document || {};
    // 原文档案存的是整份文件（含 frontmatter，逐字引文的偏移依赖它）；
    // 给人阅读时剥掉 frontmatter，别让 name/description/metadata 抢正文的位置。
    const readable = String(doc.content || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    openModal(doc.title || "原文", (body) => {
      body.innerHTML = `<div class="mem-doc-meta">${esc(memorySourceLabel(doc.source))} · ${Number(doc.chars) || 0} 字 · ${esc(memoryShortDate(doc.createdAt) || "")}</div>
        <pre class="mem-doc-body">${esc(readable)}</pre>
        <div class="modal-actions"><button class="modal-primary" type="button" data-modal-ok>关闭</button></div>`;
      body.querySelector("[data-modal-ok]")?.addEventListener("click", closeModal);
    }, { className: "modal-doc" });
  } catch (error) {
    if (error.message !== "forbidden") toast(`原文读不到：${error.message}`);
  }
}

function updateMemoryControls() {
  const consolidate = document.getElementById("mem-consolidate");
  const importButton = document.getElementById("mem-import");
  const split = document.getElementById("mem-split");
  const migrate = document.getElementById("mem-migrate");
  if (consolidate) consolidate.hidden = !memoryPageState.canConsolidate;
  if (importButton) importButton.hidden = !memoryPageState.canImport;
  if (split) split.hidden = !memoryPageState.canSplit;
  // 迁移只对项目 scope 有意义（活项目与孤儿都能搬）；global / 执事不给这个入口。
  if (migrate) migrate.hidden = !memoryPageState.scope.startsWith("project:");
  const running = memoryPageState.status?.running === true || memoryPageState.batch?.running === true;
  if (consolidate) {
    consolidate.disabled = running;
    consolidate.textContent = running ? "整理中…" : "整理";
  }
  if (split) {
    split.disabled = running;
    split.textContent = running ? "拆分中…" : "拆分记忆";
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

export { MEMORY_A_DEFAULT_OPEN, MEMORY_A_PAGE_SIZE, loadMemoryDocuments, loadMemoryPeople, loadMemorySummary, memoryElapsedSeconds, memoryGroupBodyMarkup, memoryGroupHint, memoryGroupOf, memoryPageAlive, memoryPageState, memorySettingsMarkup, memoryShortDate, memorySourceLabel, memoryStatusTime, openMemoryImportDialog, renderMemoryChips, renderMemoryGroupBody, renderMemoryGroups, renderMemoryPeople, startMemoryPolling, stopMemoryPolling, switchMemoryScope, updateMemoryControls, wireMemorySettings };
