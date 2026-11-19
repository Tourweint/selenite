/**
 * 记忆设置（旧版 A/B 页）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { rowMarkup, sectionMarkup } from "./settings-atoms.js";
import { renderSettings } from "./settings-router.js";
import { openConfirm, toast } from "./ui-atoms.js";

/* ── 记忆设置（2026-11-06；2026-11-08 扫尾批 6 补整理与导入；2026-11-13 A 版）──
 * A 版 = 大字概览 + 分类计数片（唯一筛选）+ 搜索 + 分组折叠 + 可恢复的整理状态。
 * 旧版整套 DOM/逻辑保留在 *Legacy 函数里，`MEMORY_PAGE_A=false` 时回落。
 * 数据形状见 memory-api.ts：GET /api/v1/agent/memory。
 * 「整理记忆」只出建议，人在卡片上逐条点「应用」才动库（D18）；导入本轮只占位。 */

const MEMORY_KIND_LABEL = {
  preference: "偏好",
  intention: "打算",
  fact: "事实",
  experience: "经验",
  episode: "经历",
  entity: "人事物",
  work: "履历",
};
const MEMORY_KIND_ORDER = ["preference", "intention", "fact", "experience", "entity", "episode", "work"];
/* 组头悬停解释（2026-11-08）：组标题挪到卡片外，"经历是干啥的"这类疑问悬停即答 */
const MEMORY_KIND_TIPS = {
  preference: "你的喜好与习惯（例如「喜欢简洁的汇报」）。召回时排在前面成段，不相关时不会带。",
  intention: "还没兑现的打算（例如「下周开始跑步」）。未过期时优先想起；到期后自动变成普通事实。",
  fact: "关于你和你的生活的客观事实（例如「家里有两只猫」），按相关度召回。",
  experience: "这类活下次可以怎么做。从你的纠正里提炼出来，不会过期。",
  entity: "重要的人、项目、东西的条目，聊到相关的就会想起。",
  episode: "聊过、经历过的事的记录，帮你想起「上次……」。日常经过，默认收起。",
  work: "派单结算留下的履历，只增不改；记忆页下方「工作履历」里看。",
};

/** 当前查看 / 整理 / 导入的 scope。进页固定回 global，避免下拉与数据不同步。 */
let memoryScope = "global";
/** 本轮整理的结果计数（应用 / 忽略），只用于结果行。 */
let memoryReviewStats = { applied: 0, ignored: 0, total: 0 };

function memorySettingsMarkupLegacy() {
  return `${sectionMarkup(
    "记忆",
    `<div class="card">
      ${rowMarkup(
        "当前状态",
        "记忆按相关度召回；命中的偏好排在前面成段，不相关时不会带。",
        `<span class="kv" id="mem-status">读取中…</span>`,
      )}
      <div class="divider"></div>
      ${rowMarkup(
        "抽取方式",
        "auto = 有模型时用模型识别偏好，其余仍走规则；rule = 完全规则版（回滚档）",
        `<span class="kv is-mono" id="mem-extract">—</span>`,
      )}
      <div class="divider"></div>
      ${rowMarkup(
        "范围",
        "总管用 global；每个执事有自己的记忆库，互不可见",
        `<select class="mem-select" id="mem-scope" aria-label="选择记忆范围">
          <option value="global">总管（global）</option>
        </select>`,
      )}
      <div class="divider"></div>
      ${rowMarkup(
        "整理与导入",
        "整理只给建议，逐条确认才会标记过时；导入只增不改，重复的跳过",
        `<div class="mem-tools">
          <button class="ghost mem-act" type="button" id="mem-consolidate" hidden>整理记忆</button>
          <button class="ghost mem-act" type="button" id="mem-import" hidden>导入记忆</button>
          <input type="file" id="mem-import-file" accept=".json,application/json" hidden>
        </div>`,
      )}
      <div class="mem-result" id="mem-import-result" hidden></div>
    </div>
    <div class="card" id="mem-proposals-card" hidden>
      <div class="mem-prop-head">
        <div class="set-card-title" data-tip="这些都是模型给的建议，不会自动改。应用 = 被收编那条标为过时（记录还留着，可追溯）。">整理建议<span class="mem-count" id="mem-prop-count"></span></div>
      </div>
      <div class="mem-props" id="mem-props"></div>
      <div class="mem-result" id="mem-prop-result" hidden></div>
    </div>
    <div id="mem-list-card">
      <div class="set-hint" id="mem-empty" hidden>
        还没有记忆。聊几次之后，偏好会自动出现在这里；也可以直接对助手说「记住：……」。
      </div>
      <div class="mem-list" id="mem-list"><div class="set-hint">读取中…</div></div>
    </div>`,
  )}`;
}

async function wireMemorySettingsLegacy() {
  const list = document.getElementById("mem-list");
  const status = document.getElementById("mem-status");
  if (!list || !status) return;

  memoryScope = "global";
  memoryReviewStats = { applied: 0, ignored: 0, total: 0 };
  const scopeSelect = document.getElementById("mem-scope");
  if (scopeSelect) {
    await fillMemoryScopes(scopeSelect);
    scopeSelect.value = memoryScope;
    scopeSelect.addEventListener("change", () => {
      memoryScope = scopeSelect.value || "global";
      clearProposalCards();
      const importResult = document.getElementById("mem-import-result");
      if (importResult) importResult.hidden = true;
      void loadMemoryScope();
    });
  }

  const consolidateButton = document.getElementById("mem-consolidate");
  const importButton = document.getElementById("mem-import");
  const fileInput = document.getElementById("mem-import-file");
  consolidateButton?.addEventListener("click", () => void runMemoryConsolidate(consolidateButton));
  importButton?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => void runMemoryImport(fileInput));

  await loadMemoryScope();
}

/** 范围的候选：总管 + 未归档的执事。执事接口不可用（COMPANIONS_ENABLED=false）时只有总管。 */
async function fillMemoryScopes(select) {
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    for (const partner of Array.isArray(data.partners) ? data.partners : []) {
      if (!partner || !partner.id || partner.id === "chief") continue;
      if (partner.status === "archived") continue;
      const option = document.createElement("option");
      option.value = `partner:${partner.id}`;
      option.textContent = `${partner.name || "执事"}（执事）`;
      select.append(option);
    }
  } catch (error) {
    // 读不到执事就只留 global：范围选择不该把整页卡死
    if (error.message === "forbidden") return;
  }
}

async function loadMemoryScope() {
  const list = document.getElementById("mem-list");
  const status = document.getElementById("mem-status");
  const extract = document.getElementById("mem-extract");
  const empty = document.getElementById("mem-empty");
  if (!list || !status) return;

  list.innerHTML = `<div class="set-hint">读取中…</div>`;
  try {
    const response = await request(
      `/api/v1/agent/memory?scope=${encodeURIComponent(memoryScope)}&limit=300`,
      { cache: "no-store" },
    );
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) {
      status.textContent = "未启用";
      if (extract) extract.textContent = "—";
      toggleMemoryTools(false, false);
      list.innerHTML = `<div class="set-hint">记忆未启用（服务端 MEMORY_ENABLED=false）。</div>`;
      return;
    }
    if (!response.ok) throw new Error(String(response.status));

    // 能力位（2026-11-08）：开关关着时按钮不渲染（端点也会 404）
    toggleMemoryTools(data.canConsolidate === true, data.canImport === true);

    const items = Array.isArray(data.items) ? data.items : [];
    status.textContent = items.length > 0 ? `${items.length} 条` : "空";
    if (extract) extract.textContent = data.extract === "off" ? "不抽取" : data.extract === "llm" ? "模型 + 规则" : "规则";
    if (items.length === 0) {
      list.replaceChildren();
      if (empty) {
        empty.hidden = false;
        empty.textContent =
          memoryScope === "global"
            ? "还没有记忆。聊几次之后，偏好会自动出现在这里；也可以直接对助手说「记住：……」"
            : "这个执事还没有记忆。和它聊几次，或从这页导入。";
      }
      return;
    }
    if (empty) empty.hidden = true;
    renderMemoryList(list, items);
  } catch (error) {
    if (error.message === "forbidden") return;
    status.textContent = "读取失败";
    list.innerHTML = `<div class="set-hint is-error">读不到记忆：${esc(error.message)}</div>`;
  }
}

function toggleMemoryTools(consolidate, importable) {
  const consolidateButton = document.getElementById("mem-consolidate");
  const importButton = document.getElementById("mem-import");
  if (consolidateButton) consolidateButton.hidden = !consolidate;
  if (importButton) importButton.hidden = !importable;
}

function clearProposalCards() {
  const card = document.getElementById("mem-proposals-card");
  const box = document.getElementById("mem-props");
  const line = document.getElementById("mem-prop-result");
  const count = document.getElementById("mem-prop-count");
  memoryReviewStats = { applied: 0, ignored: 0, total: 0 };
  if (card) card.hidden = true;
  if (box) box.replaceChildren();
  if (line) { line.hidden = true; line.textContent = ""; }
  if (count) count.textContent = "";
}

/**
 * 「整理记忆」：一次模型调用只产出建议。
 * 一条建议都不自动执行 —— 人在卡片上逐条点「应用」才走 supersede（D18）。
 */
async function runMemoryConsolidate(button) {
  const card = document.getElementById("mem-proposals-card");
  const box = document.getElementById("mem-props");
  if (!card || !box) return;

  clearProposalCards();
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "整理中…";
  try {
    const response = await request("/api/v1/agent/memory/consolidate/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: memoryScope }),
    });
    if (response.status === 404) {
      toast("整理记忆未启用（服务端 MEMORY_CONSOLIDATE_LLM=false）");
      button.hidden = true;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));

    const proposals = Array.isArray(data.proposals) ? data.proposals : [];
    card.hidden = false;
    memoryReviewStats = { applied: 0, ignored: 0, total: proposals.length };
    const count = document.getElementById("mem-prop-count");
    if (count) count.textContent = proposals.length > 0 ? `${proposals.length} 条` : "";
    if (proposals.length === 0) {
      box.innerHTML = `<div class="set-hint">没有发现可整理的重复记忆。</div>`;
      return;
    }
    box.innerHTML = proposals.map(memoryProposalMarkup).join("");
    wireMemoryProposalActions(box);
  } catch (error) {
    if (error.message === "forbidden") return;
    card.hidden = false;
    box.innerHTML = `<div class="set-hint is-error">整理失败：${esc(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function memoryProposalMarkup(item) {
  const keep = String(item.keep?.content || item.keepId || "");
  const drop = String(item.drop?.content || item.dropId || "");
  const reason = String(item.reason || "");
  // 证据引文（原始出处反查）已退役（2026-11-17）：原子化后逐字匹配条条落空，服务端不再下发 evidence。
  return `<div class="mem-prop" data-keep="${esc(item.keepId)}" data-drop="${esc(item.dropId)}">
    <div class="mem-prop-line"><span class="mem-prop-tag is-keep">保留</span><span class="mem-prop-text">${esc(keep)}</span></div>
    <div class="mem-prop-line"><span class="mem-prop-tag is-drop">收编</span><span class="mem-prop-text">${esc(drop)}</span></div>
    ${reason ? `<div class="mem-prop-reason">${esc(reason)}</div>` : ""}
    <div class="mem-prop-actions">
      <button class="ghost mem-act" type="button" data-prop-apply>应用</button>
      <button class="ghost mem-act" type="button" data-prop-ignore>忽略</button>
    </div>
  </div>`;
}

function wireMemoryProposalActions(box) {
  for (const card of box.querySelectorAll(".mem-prop")) {
    const apply = card.querySelector("[data-prop-apply]");
    const ignore = card.querySelector("[data-prop-ignore]");
    apply?.addEventListener("click", async () => {
      const keepId = card.dataset.keep;
      const dropId = card.dataset.drop;
      if (!keepId || !dropId) return;
      if (apply.disabled) return;
      apply.disabled = true;
      if (ignore) ignore.disabled = true;
      try {
        const response = await request("/api/v1/agent/memory/consolidate/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: memoryScope, keepId, dropId }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || String(response.status));
        card.classList.add("is-done");
        const actions = card.querySelector(".mem-prop-actions");
        if (actions) {
          actions.innerHTML = `<span class="mem-prop-status">已应用${
            data.alreadyApplied ? "（之前已应用过）" : ""
          }</span>`;
        }
        memoryReviewStats.applied += 1;
        updateMemoryProposalResult();
        // 被收编的那条已经从召回里下线，列表跟着刷新
        await loadMemoryScope();
      } catch (error) {
        if (error.message === "forbidden") return;
        apply.disabled = false;
        if (ignore) ignore.disabled = false;
        toast(`应用失败：${error.message}`);
      }
    });
    ignore?.addEventListener("click", () => {
      card.remove();
      memoryReviewStats.ignored += 1;
      updateMemoryProposalResult();
    });
  }
}

/** 结果行："已应用 N / 忽略 M"；一条都没处理时不占位。 */
function updateMemoryProposalResult() {
  const line = document.getElementById("mem-prop-result");
  if (!line) return;
  const { applied, ignored, total } = memoryReviewStats;
  if (applied + ignored === 0) {
    line.hidden = true;
    line.textContent = "";
    return;
  }
  line.hidden = false;
  line.textContent = `本次建议 ${total} 条：已应用 ${applied} / 忽略 ${ignored}`;
}

/**
 * 「导入记忆」：前端只解析 + 计数（不做内容预检），确认后整份交给服务端校验。
 * 文件格式（接口文档 §2.15）：裸数组，或 `{items:[…]}`，条目 `{text, kind?, createdAt?, importance?}`。
 */
async function runMemoryImport(input) {
  const file = input?.files?.[0];
  if (input) input.value = ""; // 允许连续选同一个文件
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast("这个文件不是合法 JSON");
    return;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : null;
  if (!items) {
    toast('文件格式不对：需要一个数组，或 {"items": [...]}');
    return;
  }
  if (items.length === 0) {
    toast("这个文件里没有记忆条目");
    return;
  }

  const select = document.getElementById("mem-scope");
  const label = select?.selectedOptions?.[0]?.textContent || memoryScope;
  const ok = await openConfirm({
    title: "导入记忆",
    message: `把 ${items.length} 条记忆导入「${label}」？`,
    detail: "只增不改，重复的会跳过。",
    confirmText: "导入",
  });
  if (!ok) return;

  const button = document.getElementById("mem-import");
  const line = document.getElementById("mem-import-result");
  if (button) button.disabled = true;
  try {
    const response = await request("/api/v1/agent/memory/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: memoryScope, items }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) {
      toast("导入未启用（服务端 MEMORY_IMPORT=false）");
      if (button) button.hidden = true;
      return;
    }
    if (!response.ok) throw new Error(data.message || String(response.status));
    if (line) {
      line.hidden = false;
      line.textContent = `新增 ${data.added} 条 / 跳过 ${data.skipped} 条（共 ${data.total} 条）`;
    }
    await loadMemoryScope();
  } catch (error) {
    if (error.message === "forbidden") return;
    toast(`导入失败：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderMemoryList(box, items) {
  const groups = new Map();
  for (const item of items) {
    const kind = MEMORY_KIND_LABEL[item.kind] ? item.kind : "fact";
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(item);
  }
  const order = [
    ...MEMORY_KIND_ORDER.filter((kind) => groups.has(kind)),
    ...[...groups.keys()].filter((kind) => !MEMORY_KIND_ORDER.includes(kind)),
  ];
  // 2026-11-08 重排：分组标题从大卡内部挪到**卡片外**（与「记忆」节标题同一节律），
  // 每类一张自己的卡；空分组不出现。组头悬停有一句"这是干啥的"（MEMORY_KIND_TIPS）。
  box.innerHTML = order
    .map((kind) => {
      const rows = groups.get(kind);
      const tip = MEMORY_KIND_TIPS[kind] || "";
      const label = esc(MEMORY_KIND_LABEL[kind] || kind);
      return `<div class="mem-sec">
        <div class="mem-sec-head">
          <h3 class="mem-sec-title"${tip ? ` data-tip="${attr(tip)}"` : ""}>${label}</h3>
          <span class="mem-count">${rows.length}</span>
        </div>
        <div class="card">${rows.map((item) => memoryItemMarkup(item)).join("")}</div>
      </div>`;
    })
    .join("");
  wireMemoryActions(box);
}

function memoryItemMarkup(item) {
  const lines = String(item.content || "").split("\n");
  const head = lines[0] || "";
  // Why / How 是给人和模型看的两段（cindy feedback 类的硬要求）：展开时整段显示
  const extra = lines.slice(1).filter(Boolean);
  const when = String(item.createdAt || "").slice(0, 10);
  const recalled = Number(item.recallCount) > 0 ? ` · 想起 ${Number(item.recallCount)} 次` : "";
  // 2026-11-09 T4 §3：只给 intention 一个徽章，其余 kind 的展示不动。
  const badge = item.kind === "intention" ? `<span class="mem-item-badge">打算</span>` : "";
  return `<div class="mem-item" data-memory-id="${esc(item.id)}">
    <div class="mem-item-main">
      <div class="mem-item-text">${esc(head)}</div>
      ${extra.length ? `<div class="mem-item-why">${extra.map((line) => esc(line)).join("<br>")}</div>` : ""}
      <div class="mem-item-meta">${badge}${esc(when)}${esc(recalled)}</div>
    </div>
    <div class="mem-item-actions">
      <button class="ghost mem-act" type="button" data-mem-supersede="${esc(item.id)}"
              title="这条已经不对了？把它标成过时，以后不再想起">标过时</button>
      <button class="ghost mem-act" type="button" data-mem-forget="${esc(item.id)}">删除</button>
    </div>
  </div>`;
}

function wireMemoryActions(box) {
  for (const button of box.querySelectorAll("[data-mem-supersede]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.memSupersede;
      if (!id) return;
      const ok = await openConfirm({
        title: "标为过时",
        message: "把这条标成过时？",
        detail: "之后不会再被想起，但记录还留着。",
        confirmText: "标为过时",
      });
      if (!ok) return;
      button.disabled = true;
      try {
        // 只下线、不指定替代者：语义冲突的自动判断留给"人"，这里只表达"这条不算数了"
        const response = await request(`/api/v1/agent/memory/${encodeURIComponent(id)}/supersede`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(String(response.status));
        toast("已标为过时");
        await renderSettings();
      } catch (error) {
        if (error.message !== "forbidden") {
          button.disabled = false;
          toast(`操作失败：${error.message}`);
        }
      }
    });
  }
  for (const button of box.querySelectorAll("[data-mem-forget]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.memForget;
      if (!id) return;
      const ok = await openConfirm({
        title: "删除记忆",
        message: "删掉这条记忆？",
        detail: "删了就找不回来了。",
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      button.disabled = true;
      try {
        const response = await request(`/api/v1/agent/memory/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error(String(response.status));
        toast("已删除");
        await renderSettings();
      } catch (error) {
        if (error.message !== "forbidden") {
          button.disabled = false;
          toast(`删除失败：${error.message}`);
        }
      }
    });
  }
}

export { MEMORY_KIND_LABEL, MEMORY_KIND_ORDER, MEMORY_KIND_TIPS, clearProposalCards, fillMemoryScopes, loadMemoryScope, memoryItemMarkup, memoryProposalMarkup, memoryReviewStats, memoryScope, memorySettingsMarkupLegacy, renderMemoryList, runMemoryConsolidate, runMemoryImport, toggleMemoryTools, updateMemoryProposalResult, wireMemoryActions, wireMemoryProposalActions, wireMemorySettingsLegacy };
