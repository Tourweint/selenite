/**
 * 记忆页 A 版：条目、复盘、提案、整理
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { MEMORY_A_PAGE_SIZE, loadMemorySummary, memoryElapsedSeconds, memoryGroupOf, memoryPageAlive, memoryPageState, memoryShortDate, memorySourceLabel, memoryStatusTime, renderMemoryGroupBody, startMemoryPolling, stopMemoryPolling, switchMemoryScope, updateMemoryControls } from "./memory-page.js";
import { request } from "./net.js";
import { closeModal, openConfirm, openModal, toast } from "./ui-atoms.js";

async function loadMemoryGroup(kind, gen, { append = false } = {}) {
  if (!kind) return;
  const group = memoryGroupOf(kind);
  if (group.loading) return;
  group.loading = true;
  if (!append) group.error = "";
  renderMemoryGroupBody(kind);
  const offset = append ? group.items.length : 0;
  const scope = memoryPageState.scope;
  const q = memoryPageState.q;
  const query = q ? `&q=${encodeURIComponent(q)}` : "";
  try {
    const response = await request(
      `/api/v1/agent/memory?scope=${encodeURIComponent(scope)}&kind=${encodeURIComponent(kind)}&limit=${MEMORY_A_PAGE_SIZE}&offset=${offset}&excludeKinds=work${query}`,
      { cache: "no-store" },
    );
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope || memoryPageState.q !== q) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    const items = Array.isArray(data.items) ? data.items : [];
    group.items = append ? [...group.items, ...items] : items;
    group.total = Number(data.total) || group.items.length;
    group.loaded = true;
  } catch (error) {
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope || memoryPageState.q !== q) return;
    if (error.message === "forbidden") return;
    group.error = `读不到记忆：${error.message}`;
  } finally {
    group.loading = false;
    if (memoryPageAlive(gen)) renderMemoryGroupBody(kind);
  }
}

function memoryItemMarkupA(item) {
  const raw = String(item.content || "");
  const lines = raw.split("\n");
  let head = lines[0] || "";
  const extra = lines.slice(1).filter(Boolean);
  let contentDate = "";
  if (item.kind === "episode") {
    const match = /^(\d{4}-\d{2}-\d{2})：\s*/.exec(head);
    if (match) {
      contentDate = match[1];
      head = head.slice(match[0].length);
    }
  }
  const when = memoryShortDate(contentDate || item.createdAt);
  const source = memorySourceLabel(item.source);
  const recalled = Number(item.recallCount) > 0 ? ` · 想起 ${Number(item.recallCount)} 次` : "";
  let expiry = "";
  if (item.kind === "intention" && item.expiresAt) {
    const days = Math.ceil((Date.parse(item.expiresAt) - Date.now()) / 86_400_000);
    if (Number.isFinite(days)) expiry = days >= 0 ? ` · 还有 ${days} 天` : " · 已过期";
  }
  return `<div class="mem-a-item" data-memory-id="${esc(item.id)}">
    <div class="mem-a-item-main">
      <div class="mem-a-item-text">${esc(head)}</div>
      ${extra.length ? `<div class="mem-a-item-why">${extra.map((line) => esc(line)).join("<br>")}</div>` : ""}
      <div class="mem-a-item-meta">${esc(when)} · ${esc(source)}${esc(recalled)}${esc(expiry)}</div>
    </div>
    <div class="mem-a-item-actions">
      <button class="mem-a-icon" type="button" data-mem-supersede="${esc(item.id)}" title="标为过时" aria-label="标为过时">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>
      </button>
      <button class="mem-a-icon" type="button" data-mem-forget="${esc(item.id)}" title="删除" aria-label="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  </div>`;
}

async function supersedeMemoryItem(id, gen) {
  if (!id) return;
  const ok = await openConfirm({
    title: "标为过时",
    message: "把这条标成过时？",
    detail: "之后不会再被想起，但记录还留着。",
    confirmText: "标为过时",
  });
  if (!ok) return;
  try {
    const response = await request(`/api/v1/agent/memory/${encodeURIComponent(id)}/supersede`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(String(response.status));
    toast("已标为过时");
    await refreshMemoryGroups(gen);
  } catch (error) {
    if (error.message !== "forbidden") toast(`操作失败：${error.message}`);
  }
}

async function forgetMemoryItem(id, gen) {
  if (!id) return;
  const ok = await openConfirm({
    title: "删除记忆",
    message: "删掉这条记忆？",
    detail: "删了就找不回来了。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    const response = await request(`/api/v1/agent/memory/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(String(response.status));
    toast("已删除");
    await refreshMemoryGroups(gen);
  } catch (error) {
    if (error.message !== "forbidden") toast(`删除失败：${error.message}`);
  }
}

async function refreshMemoryGroups(gen) {
  for (const group of memoryPageState.groups.values()) {
    group.items = [];
    group.loaded = false;
    group.loading = false;
    group.error = "";
  }
  await loadMemorySummary(gen);
}

async function loadMemoryReviewState(gen) {
  const statusEl = document.getElementById("mem-a-status");
  if (!statusEl) return;
  const scope = memoryPageState.scope;
  try {
    const response = await request(
      `/api/v1/agent/memory/consolidate/state?scope=${encodeURIComponent(scope)}`,
      { cache: "no-store" },
    );
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope) return;
    if (response.status === 404) {
      memoryPageState.canConsolidate = false;
      updateMemoryControls();
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    memoryPageState.status = {
      running: data.running === true,
      startedAt: data.startedAt || null,
      generatedAt: data.generatedAt || null,
      proposals: Array.isArray(data.proposals) ? data.proposals : [],
      source: data.source || "none",
      error: data.error || null,
      audit: data.audit || null,
    };
    if (memoryPageState.status.running) startMemoryPolling(gen);
    else stopMemoryPolling();
    renderMemoryReviewState();
  } catch (error) {
    if (!memoryPageAlive(gen) || error.message === "forbidden") return;
    statusEl.textContent = `整理状态读取失败：${error.message}`;
  }
}

function renderMemoryReviewState() {
  const status = memoryPageState.status;
  const batch = memoryPageState.batch;
  const statusEl = document.getElementById("mem-a-status");
  const auditEl = document.getElementById("mem-a-audit");
  const runEl = document.getElementById("mem-a-run");
  if (!statusEl) return;

  if (batch?.running) {
    const current = Math.min(batch.done + 1, batch.total);
    statusEl.textContent = `正在逐个整理 ${current}/${batch.total}${batch.label ? ` · ${batch.label}` : ""}…`;
    if (auditEl) auditEl.hidden = true;
    if (runEl) {
      runEl.hidden = false;
      const text = document.getElementById("mem-a-run-text");
      const elapsed = document.getElementById("mem-a-elapsed");
      if (text) text.textContent = "逐个整理每个人的记忆 · 只出建议，不会自动改";
      if (elapsed) elapsed.textContent = `已 ${memoryElapsedSeconds(batch.startedAt)}s`;
    }
    updateMemoryControls();
    renderMemoryProposalCards();
    return;
  }

  if (batch) {
    const failed = batch.errors.length ? ` · ${batch.errors.length} 个范围失败` : "";
    statusEl.textContent = batch.proposals.length
      ? `全部整理完成 · ${batch.proposals.length} 条建议待看${failed}`
      : `全部整理完成 · 暂无建议${failed}`;
  } else if (status?.running) {
    statusEl.textContent = `正在整理… 已 ${memoryElapsedSeconds(status.startedAt)} 秒`;
  } else if (status?.error) {
    const pending = status.proposals?.length || 0;
    const reason = status.error.message || status.error.error || "未知原因";
    statusEl.textContent = pending
      ? `${pending} 条旧建议待看 · 上次整理失败：${reason}`
      : `上次整理失败：${reason}`;
  } else if (status?.proposals?.length) {
    statusEl.textContent = `上次整理 ${memoryStatusTime(status.generatedAt)} · ${status.proposals.length} 条建议待看`;
  } else if (status?.generatedAt) {
    statusEl.textContent = `上次整理 ${memoryStatusTime(status.generatedAt)} · 暂无待处理建议`;
  } else if (!batch) {
    statusEl.textContent = "还没整理过";
  }

  if (auditEl) {
    const merged = Array.isArray(status?.audit?.merged) ? status.audit.merged.length : 0;
    const retired = Array.isArray(status?.audit?.retired) ? status.audit.retired.length : 0;
    if (merged + retired > 0) {
      auditEl.hidden = false;
      auditEl.textContent = `系统自检：${merged} 条完全重复${retired ? ` · ${retired} 条 90 天没用到` : ""}`;
    } else {
      auditEl.hidden = true;
      auditEl.textContent = "";
    }
  }

  if (runEl) {
    runEl.hidden = !status?.running;
    if (status?.running) {
      const text = document.getElementById("mem-a-run-text");
      const elapsed = document.getElementById("mem-a-elapsed");
      if (text) text.textContent = "正在整理这个范围的记忆 · 找重复、找过时、回原始对话找证据";
      if (elapsed) elapsed.textContent = `已 ${memoryElapsedSeconds(status.startedAt)}s`;
    }
  }

  updateMemoryControls();
  renderMemoryProposalCards();
}

function clearMemoryProposalCard() {
  const card = document.getElementById("mem-a-props-card");
  const box = document.getElementById("mem-a-props");
  if (card) card.hidden = true;
  if (box) box.replaceChildren();
}

function renderMemoryProposalCards() {
  const card = document.getElementById("mem-a-props-card");
  const box = document.getElementById("mem-a-props");
  const count = document.getElementById("mem-a-prop-count");
  const note = document.getElementById("mem-a-prop-note");
  if (!card || !box) return;
  const proposals = memoryPageState.batch?.proposals?.length
    ? memoryPageState.batch.proposals
    : (memoryPageState.status?.proposals ?? []);
  if (!proposals.length) {
    card.hidden = true;
    box.replaceChildren();
    if (count) count.textContent = "";
    return;
  }
  card.hidden = false;
  if (count) count.textContent = `${proposals.length} 条`;
  if (note) {
    note.textContent = memoryPageState.batch?.proposals?.length
      ? "全部整理 · 只建议，不会自动改"
      : memoryPageState.status?.source === "pending"
        ? "存档建议 · 出处引文不再显示"
        : "只建议，不会自动改";
  }
  box.innerHTML = proposals.map((item) => memoryProposalMarkupA(item)).join("");
}

function memoryProposalMarkupA(item) {
  const keep = String(item.keep?.content || item.keepId || "");
  const drop = String(item.drop?.content || item.dropId || "");
  const reason = String(item.reason || "");
  const scope = String(item.scope || memoryPageState.scope);
  const scopeLabel = String(item.scopeLabel || "");
  let evidenceBlock = "";
  if (item.evidence !== undefined) {
    const ev = item.evidence && typeof item.evidence === "object" ? item.evidence : null;
    if (ev && ev.text) {
      evidenceBlock = `<button class="mem-prop-evidence is-hit" type="button"${
        ev.conversationId ? ` data-conv="${attr(ev.conversationId)}"` : ""
      } data-tip="原始出处${ev.conversationId ? "，点击跳回原对话" : ""}">${esc(ev.text)}</button>`;
    } else {
      evidenceBlock = `<div class="mem-prop-evidence is-miss">未找到原始出处（导入或日记来源的记录不在对话里），不挡应用</div>`;
    }
  }
  return `<div class="mem-prop" data-keep="${esc(item.keepId)}" data-drop="${esc(item.dropId)}" data-scope="${attr(scope)}">
    ${scopeLabel ? `<div class="mem-prop-scope">来自：${esc(scopeLabel)}</div>` : ""}
    <div class="mem-prop-line"><span class="mem-prop-tag is-keep">保留</span><span class="mem-prop-text">${esc(keep)}</span></div>
    <div class="mem-prop-line"><span class="mem-prop-tag is-drop">收编</span><span class="mem-prop-text">${esc(drop)}</span></div>
    ${reason ? `<div class="mem-prop-reason">${esc(reason)}</div>` : ""}
    ${evidenceBlock}
    <div class="mem-prop-actions">
      <button class="ghost mem-act" type="button" data-prop-apply>应用</button>
      <button class="ghost mem-act" type="button" data-prop-ignore>忽略</button>
    </div>
  </div>`;
}

async function applyMemoryProposalA(card, gen) {
  if (!card || card.classList.contains("is-done")) return;
  const keepId = card.getAttribute("data-keep") || "";
  const dropId = card.getAttribute("data-drop") || "";
  const scope = card.getAttribute("data-scope") || memoryPageState.scope;
  if (!keepId || !dropId) return;
  const apply = card.querySelector("[data-prop-apply]");
  const ignore = card.querySelector("[data-prop-ignore]");
  if (apply) apply.disabled = true;
  if (ignore) ignore.disabled = true;
  try {
    const response = await request("/api/v1/agent/memory/consolidate/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, keepId, dropId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    card.classList.add("is-done");
    const actions = card.querySelector(".mem-prop-actions");
    if (actions) {
      actions.innerHTML = `<span class="mem-prop-status">已应用${data.alreadyApplied ? "（之前已应用过）" : ""}</span>`;
    }
    removeMemoryProposalLocally(keepId, dropId);
    const remaining = memoryProposalCount();
    const count = document.getElementById("mem-a-prop-count");
    if (count) count.textContent = remaining ? `${remaining} 条` : "";
    if (remaining === 0) clearMemoryProposalCard();
    else renderMemoryProposalCards();
    renderMemoryReviewState();
    await refreshMemoryGroups(gen);
  } catch (error) {
    if (error.message !== "forbidden") toast(`应用失败：${error.message}`);
    if (apply) apply.disabled = false;
    if (ignore) ignore.disabled = false;
  }
}

async function dismissMemoryProposalA(card, gen) {
  if (!card) return;
  const keepId = card.getAttribute("data-keep") || "";
  const dropId = card.getAttribute("data-drop") || "";
  const scope = card.getAttribute("data-scope") || memoryPageState.scope;
  if (!keepId || !dropId) return;
  try {
    const response = await request("/api/v1/agent/memory/consolidate/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, keepId, dropId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    card.remove();
    removeMemoryProposalLocally(keepId, dropId);
    const remaining = memoryProposalCount();
    const count = document.getElementById("mem-a-prop-count");
    if (count) count.textContent = remaining ? `${remaining} 条` : "";
    if (remaining === 0) clearMemoryProposalCard();
    if (memoryPageAlive(gen)) renderMemoryReviewState();
  } catch (error) {
    if (error.message !== "forbidden") toast(`忽略失败：${error.message}`);
  }
}

/** 建议计数：全部整理优先看 batch，否则看当前 scope 的 status。 */
function memoryProposalCount() {
  const batch = memoryPageState.batch;
  if (batch?.proposals?.length) return batch.proposals.length;
  return memoryPageState.status?.proposals?.length ?? 0;
}

/** 应用 / 忽略后本地摘掉同一条：两份列表都清，避免切来切去又冒出来。 */
function removeMemoryProposalLocally(keepId, dropId) {
  const keep = (item) => !(item.keepId === keepId && item.dropId === dropId);
  if (memoryPageState.status?.proposals) {
    memoryPageState.status.proposals = memoryPageState.status.proposals.filter(keep);
  }
  if (memoryPageState.batch?.proposals) {
    memoryPageState.batch.proposals = memoryPageState.batch.proposals.filter(keep);
  }
}

/** 整理入口：先问"整理谁的"（我的 / 某个同事 / 全部），再决定跑单人或逐个。 */
async function openMemoryConsolidateDialog(gen) {
  if (memoryPageState.batch?.running || memoryPageState.status?.running) {
    toast("正在整理，等它跑完");
    return;
  }
  const pending = memoryPageState.status?.proposals?.length || 0;
  const people = memoryPageState.people?.length
    ? memoryPageState.people
    : [{ scope: "global", label: "我的记忆", count: memoryPageState.counts.all }];
  const total = people.reduce((sum, person) => sum + (Number(person.count) || 0), 0);
  // 默认选"当前正在看的这个人"，省一次点选；当前 scope 不在清单里就落第一个
  const defaultScope = people.some((person) => person.scope === memoryPageState.scope)
    ? memoryPageState.scope
    : people[0]?.scope || "global";
  openModal("整理谁的记忆", (body) => {
    body.innerHTML = `<div class="mem-pick">
      <p class="set-hint">只出建议，不会自动改；应用要你逐条点。</p>
      ${pending ? `<p class="set-hint">上次还有 ${pending} 条没处理；重新整理会替换它们，已应用的不受影响。</p>` : ""}
      ${people
        .map(
          (person) => `<label class="mem-pick-row">
            <input type="radio" name="mem-pick" value="${attr(person.scope)}" ${person.scope === defaultScope ? "checked" : ""}>
            <span class="mem-pick-name">${esc(person.label)}${person.kind === "partner" ? `<span class="mem-a-person-tag">同事</span>` : ""}</span>
            <b>${Number(person.count) || 0}</b>
          </label>`,
        )
        .join("")}
      <label class="mem-pick-row is-all">
        <input type="radio" name="mem-pick" value="__all__">
        <span class="mem-pick-name">全部（逐个整理）</span><b>${total}</b>
      </label>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" type="button" data-modal-start>开始整理</button>
      </div>
    </div>`;
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    body.querySelector("[data-modal-start]")?.addEventListener("click", () => {
      const picked = body.querySelector('input[name="mem-pick"]:checked')?.value || "global";
      closeModal();
      if (picked === "__all__") {
        void runMemoryConsolidateAll(gen, people);
        return;
      }
      if (picked !== memoryPageState.scope) {
        // 先打这一枪再切页：切页后的状态轮询能看到 running，避免先用旧 scope 渲染。
        void startScopeReview(picked)
          .then((outcome) => {
            switchMemoryScope(picked, gen);
            if (outcome.kind === "sync") {
              memoryPageState.status = {
                running: false,
                startedAt: null,
                generatedAt: outcome.generatedAt || null,
                proposals: outcome.proposals || [],
                source: "live",
                error: null,
                audit: null,
              };
              renderMemoryReviewState();
            }
          })
          .catch((error) => showReviewError(error));
        return;
      }
      void runMemoryConsolidateA(gen);
    });
  });
}

/** 单 scope：POST 一次 review，返回 202/409/200/404 的归一结果。 */
async function startScopeReview(scope) {
  const response = await request(
    `/api/v1/agent/memory/consolidate/review${memoryPageState.consolidateJob ? "?background=1" : ""}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (response.status === 404) return { kind: "disabled" };
  if (response.status === 202) return { kind: "background", startedAt: data.startedAt || null };
  if (response.status === 409) return { kind: "background", startedAt: data.startedAt || null, already: true };
  if (!response.ok) throw new Error(data.message || String(response.status));
  return {
    kind: "sync",
    generatedAt: data.generatedAt || null,
    proposals: Array.isArray(data.proposals) ? data.proposals : [],
  };
}

function showReviewError(error) {
  if (error?.message === "forbidden") return;
  toast(`整理失败：${error?.message || error}`);
  const statusEl = document.getElementById("mem-a-status");
  if (statusEl) statusEl.textContent = `整理失败：${error?.message || error}`;
}

async function runMemoryConsolidateA(gen) {
  const scope = memoryPageState.scope;
  if (memoryPageState.batch?.running || memoryPageState.status?.running) {
    toast("正在整理，等它跑完");
    return;
  }
  memoryPageState.batch = null;
  const button = document.getElementById("mem-consolidate");
  if (button) {
    button.disabled = true;
    button.textContent = "整理中…";
  }
  try {
    const outcome = await startScopeReview(scope);
    if (!memoryPageAlive(gen) || memoryPageState.scope !== scope) return;
    if (outcome.kind === "disabled") {
      toast("整理记忆未启用（服务端 MEMORY_CONSOLIDATE_LLM=false）");
      memoryPageState.canConsolidate = false;
      updateMemoryControls();
      return;
    }
    if (outcome.kind === "background") {
      memoryPageState.status = {
        running: true,
        startedAt: outcome.startedAt || new Date().toISOString(),
        generatedAt: null,
        proposals: [],
        source: "none",
        error: null,
        audit: memoryPageState.status?.audit ?? null,
      };
      renderMemoryReviewState();
      startMemoryPolling(gen);
      return;
    }
    // MEMORY_CONSOLIDATE_JOB=false / 旧服务端：同步结果直接上屏。
    memoryPageState.status = {
      running: false,
      startedAt: null,
      generatedAt: outcome.generatedAt || null,
      proposals: outcome.proposals || [],
      source: "live",
      error: null,
      audit: memoryPageState.status?.audit ?? null,
    };
    renderMemoryReviewState();
  } catch (error) {
    showReviewError(error);
  } finally {
    if (memoryPageAlive(gen)) updateMemoryControls();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等某个 scope 的整理跑完（最多约 2 分钟），返回建议。 */
async function waitScopeProposals(gen, scope) {
  for (let tick = 0; tick < 80; tick += 1) {
    await sleep(1500);
    if (!memoryPageAlive(gen)) return [];
    const response = await request(
      `/api/v1/agent/memory/consolidate/state?scope=${encodeURIComponent(scope)}`,
      { cache: "no-store" },
    );
    if (response.status === 404) return [];
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    if (data.running !== true) return Array.isArray(data.proposals) ? data.proposals : [];
  }
  throw new Error("等整理结果超时");
}

/** 全部：逐个 scope 跑，建议汇总到 batch，卡片按"来自谁"标注；一个失败不影响下一个。 */
async function runMemoryConsolidateAll(gen, people) {
  if (!people?.length) return;
  if (memoryPageState.batch?.running) {
    toast("正在逐个整理，等它跑完");
    return;
  }
  memoryPageState.status = null;
  memoryPageState.batch = {
    running: true,
    startedAt: new Date().toISOString(),
    total: people.length,
    done: 0,
    label: "",
    proposals: [],
    errors: [],
  };
  renderMemoryReviewState();
  updateMemoryControls();
  try {
    for (const person of people) {
      if (!memoryPageAlive(gen)) return;
      memoryPageState.batch.label = person.label;
      renderMemoryReviewState();
      try {
        const outcome = await startScopeReview(person.scope);
        if (outcome.kind === "disabled") {
          memoryPageState.batch.errors.push({ label: person.label, error: "整理未启用" });
          break;
        }
        const proposals =
          outcome.kind === "sync" ? outcome.proposals || [] : await waitScopeProposals(gen, person.scope);
        for (const proposal of proposals) {
          memoryPageState.batch.proposals.push({
            ...proposal,
            scope: person.scope,
            scopeLabel: person.label,
          });
        }
      } catch (error) {
        memoryPageState.batch.errors.push({
          label: person.label,
          error: error?.message || String(error),
        });
      }
      memoryPageState.batch.done += 1;
      memoryPageState.batch.label = "";
      renderMemoryReviewState();
      updateMemoryControls();
    }
  } finally {
    if (memoryPageAlive(gen)) {
      memoryPageState.batch.running = false;
      renderMemoryReviewState();
      updateMemoryControls();
    } else if (memoryPageState.batch) {
      memoryPageState.batch.running = false;
    }
  }
}

async function loadMemoryExternal(gen) {
  const section = document.getElementById("mem-a-external");
  if (!section) return;
  try {
    const response = await request("/api/v1/agent/memory/external", { cache: "no-store" });
    if (!memoryPageAlive(gen)) return;
    if (response.status === 404) {
      section.hidden = true;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    section.hidden = false;
    const line = document.getElementById("mem-a-external-line");
    const open = document.getElementById("mem-a-ext-open");
    const lines = Array.isArray(data.catalog?.lines) ? data.catalog.lines : [];
    memoryPageState.externalLines = lines;
    if (line) {
      // 页脚只留库的规模；来源/常提的人等细节收进「查看」弹层，别在页面上铺一长行。
      if (data.ready) line.textContent = (lines[0] || "已连接").split("；")[0];
      else if (!data.configured) line.textContent = "未连接 · 在 .env 配 PERSONA_MEMORY_ASK 后重启";
      else if (data.reason === "disabled") line.textContent = "已关闭 · PERSONA_MEMORY_ENABLED=false";
      else line.textContent = "连不上 · 检查 PERSONA_PYTHON 与 ask.py 路径";
    }
    if (open) open.hidden = lines.length <= 1;
  } catch (error) {
    if (!memoryPageAlive(gen) || error.message === "forbidden") return;
    section.hidden = false;
    const line = document.getElementById("mem-a-external-line");
    if (line) line.textContent = "读取失败";
  }
}

/* 头像预设图库（2026-11-06 落地，2026-11-07 改挂到「人设」弹窗里）：
 * 30 张 PNG（10 男 / 20 女）由 web.ts 的 /assets/preset/:file 白名单路由供图。
 * 原来这里还有一整页「设置 → 头像」（选对象 + 网格 + 上传 + 保存），
 * 2026-11-07 合并进人设弹窗后整页删除——头像不是独立设置项，是这个角色的一部分。 */

export { applyMemoryProposalA, clearMemoryProposalCard, dismissMemoryProposalA, forgetMemoryItem, loadMemoryExternal, loadMemoryGroup, loadMemoryReviewState, memoryItemMarkupA, memoryProposalMarkupA, openMemoryConsolidateDialog, refreshMemoryGroups, renderMemoryProposalCards, renderMemoryReviewState, runMemoryConsolidateA, supersedeMemoryItem };
