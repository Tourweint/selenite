/**
 * 看板：打手列、统计、归档、直派、空态
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { currentRoute, currentTicketId, writeTasksHash } from "./route.js";
import { state } from "./state.js";
import { childTicketsOf, conversationTickets, employeeName, groupByConversation, lampHtml, renderTasksMini, ticketLamp, ticketText, workRowsOf } from "./tasks-cards.js";
import { TASK_BADGE_STATUSES, TASK_HITTERS, TASK_STATUS, relativeTime, stalenessHint } from "./tasks-model.js";
import { renderTasksView } from "./tasks-redesign.js";

function renderSideListEmpty() {
  if (!el.chats) return;
  el.chats.querySelector(".chats-empty")?.remove();
  const taskRows = el.tasksMini?.querySelectorAll(".task-row").length || 0;
  if (el.chats.querySelector(".chat") || taskRows) return;
  const hint = document.createElement("div");
  hint.className = "chats-empty";
  hint.textContent = "还没有对话。点「对话」右边的 ⋯ 新建一条。";
  el.chats.append(hint);
}

function syncTasksBadge() {
  // 徽标口径跟看板一致：数「还有活在跑/在等」的对话卡；直派单没有卡，自己算一个。
  // 注意 alive 收的是**单张票**：direct.filter(alive) 直接可用；卡内用 .some(alive)。
  // （E5 实测：原来 alive 写成收数组，遇到直派单会抛错，把后面的总管计数一起带掉。）
  const { cards, direct } = groupByConversation(state.tickets);
  const alive = (ticket) => TASK_BADGE_STATUSES.has(ticket.status);
  const active =
    cards.filter((card) => conversationTickets(card).some(alive)).length + direct.filter(alive).length;
  el.tasksBadge.hidden = active === 0;
  el.tasksBadge.textContent = active > 99 ? "99+" : String(active);

  // E5：无 domain 的活跃单 = 总管直接派给无主工人的活，挂在总管条目右侧。
  // 不可点击（总管没有 domain 筛选入口），为 0 时不显示。
  if (el.chiefCount) {
    const chiefActive = state.tickets.filter(
      (ticket) => !ticket.domain && TASK_BADGE_STATUSES.has(ticket.status),
    ).length;
    el.chiefCount.hidden = chiefActive === 0;
    el.chiefCount.textContent = chiefActive > 99 ? "99+ 单" : `${chiefActive} 单`;
  }

  // 侧栏「任务中心」分区的简版列表跟着同一份数据走（不另拉接口）
  renderTasksMini();
}

/**
 * 外部打手小卡（L3）：只读聚合，四张固定，数据全部来自现有 tickets 列表。
 * 「未完结」= 还没 done / aborted 的单（failed 也算没完，得有人看）。
 */
function hitterCards() {
  const open = state.tickets.filter(
    (ticket) => ticket.status !== "done" && ticket.status !== "aborted",
  );
  return TASK_HITTERS.map(({ id, label }) => {
    const mine = open
      .filter((ticket) => ticket.employee === id)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return { id, label, count: mine.length, latest: mine[0] || null };
  });
}

function renderHitters() {
  el.tasksHitters.replaceChildren();
  el.tasksHitters.hidden = false;
  for (const hitter of hitterCards()) {
    const active = state.tasksEmployeeFilter === hitter.id;
    const latest = hitter.latest;
    const brief = latest ? String(latest.prompt || "").replace(/\s+/g, " ").trim() : "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tk-hitter";
    button.dataset.employee = hitter.id;
    button.dataset.active = active ? "1" : "0";
    button.setAttribute("aria-pressed", String(active));
    button.title = hitter.count
      ? `只看「${hitter.label}」派出去的活（再点一次取消）`
      : `${hitter.label} 当前空闲`;
    button.innerHTML = `
      <span class="tk-hitter-head">
        <span class="tk-hitter-name">${esc(hitter.label)}</span>
        ${hitter.count ? `<span class="tk-hitter-count">${hitter.count}</span>` : ""}
      </span>
      ${
        hitter.count
          ? `<span class="tk-hitter-brief">${esc(brief.slice(0, 40) || "（没有说明）")}</span>
             <span class="tk-hitter-foot">${lampHtml(ticketLamp(latest))}<span class="tk-hitter-time">${esc(relativeTime(latest.updated_at))}</span></span>`
          : `<span class="tk-hitter-idle">空闲</span>`
      }
    `;
    el.tasksHitters.append(button);
  }
}

function syncDomainOptions() {
  const domains = [...new Set(state.tickets.map((ticket) => ticket.domain).filter(Boolean))].sort();
  const previous = state.domainFilter;
  el.tasksDomain.replaceChildren(new Option("全部领域", ""));
  for (const domain of domains) el.tasksDomain.append(new Option(domain, domain));
  if (state.tickets.some((ticket) => !ticket.domain)) {
    // E5 口径：无 domain 的单 = 总管直接派发给无主工人的活，不叫「未分领域」。
    el.tasksDomain.append(new Option("总管（未分配）", "__none__"));
  }
  const values = new Set([...el.tasksDomain.options].map((option) => option.value));
  el.tasksDomain.value = values.has(previous) ? previous : "";
  state.domainFilter = el.tasksDomain.value;
}

/**
 * 项目筛选选项：优先 GET /api/v1/projects，接口不可用时用任务单里的项目名兜底；
 * 已归档但仍有历史单的项目也要保留，否则那些单会筛不出来。
 */
function syncProjectOptions() {
  const names = new Set();
  for (const project of state.projects) {
    if (!project.archived) names.add(project.name);
  }
  for (const ticket of state.tickets) {
    if (ticket.project) names.add(ticket.project);
  }
  const previous = state.projectFilter;
  el.tasksProject.replaceChildren(new Option("全部项目", ""));
  for (const name of [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    el.tasksProject.append(new Option(name, name));
  }
  const values = new Set([...el.tasksProject.options].map((option) => option.value));
  el.tasksProject.value = values.has(previous) ? previous : "";
  state.projectFilter = el.tasksProject.value;
}

async function loadProjects({ force = false } = {}) {
  if (!force && state.projectsFetchedAt && Date.now() - state.projectsFetchedAt < 60000) {
    return;
  }
  try {
    const response = await request("/api/v1/projects", { cache: "no-store" });
    if (!response.ok) return; // 筛选是附加能力：接口不在就当没有，不打断看板
    const data = await response.json();
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    state.projectsFetchedAt = Date.now();
    if (currentRoute() === "tasks" && !currentTicketId() && state.tickets.length) {
      syncProjectOptions();
    }
  } catch {
    // 静默：项目接口失败不影响任务列表
  }
}

/** 派活行：一单一行。摘要 / 状态 / 执行者 / 时间 + 「子单 N」展开区（两层收拢） */
/** 取消/重试（扫尾批 1 A1）：只在该单可操作时渲染；开关关着一律不渲染。 */
const RETRYABLE_TICKET_STATUS = new Set(["failed", "aborted", "canceled"]);
// 服务端 cancel 只对这三个终态回 400，其余（含 needs_you / idle）都能作废。
const CANCEL_BLOCKED_STATUS = new Set(["done", "failed", "aborted"]);
function ticketActionButtons(ticket, enabled = state.ticketsCancelEnabled) {
  if (!enabled) return "";
  const status = String(ticket.status || "");
  const canceled = Boolean(ticket.canceled) || status === "canceled";
  const id = attr(ticket.id || "");
  if (canceled || RETRYABLE_TICKET_STATUS.has(status)) {
    return `<span class="tk-row-actions"><button class="tk-act" type="button" data-ticket-action="retry" data-ticket="${id}">重试</button></span>`;
  }
  if (!CANCEL_BLOCKED_STATUS.has(status)) {
    return `<span class="tk-row-actions"><button class="tk-act" type="button" data-ticket-action="cancel" data-ticket="${id}">取消</button></span>`;
  }
  return "";
}

/**
 * 多副本归并（2026-11-10 批 19 §五）：同一 groupId（= requestId）的派活行收成一行。
 * 只做展示归并；不等待、不自动消费——副本各自照常跑、照常结算。
 * 只有 ≥2 张同组才折叠；单张仍按普通派活行渲染（老服务端不带 groupId 时零变化）。
 */
function fanoutLayout(tickets) {
  const groups = new Map();
  const layout = [];
  for (const ticket of tickets) {
    const groupId = ticketText(ticket, "groupId");
    if (!groupId) {
      layout.push({ ticket });
      continue;
    }
    let group = groups.get(groupId);
    if (!group) {
      group = { groupId, tickets: [] };
      groups.set(groupId, group);
      layout.push({ group });
    }
    group.tickets.push(ticket);
  }
  const result = [];
  for (const entry of layout) {
    if (!entry.group) {
      result.push(entry);
      continue;
    }
    if (entry.group.tickets.length > 1) result.push(entry);
    else for (const ticket of entry.group.tickets) result.push({ ticket });
  }
  return result;
}

/** 同组副本折叠行：「3 个副本，已完成 2」，点开逐张看。 */
function fanoutRow(group) {
  const total = group.tickets.length;
  const done = group.tickets.filter((ticket) => String(ticket.status || "") === "done").length;
  const open = state.tasksFanoutOpen.has(group.groupId);
  const row = document.createElement("div");
  row.className = "tk-row tk-fanout";
  row.dataset.group = group.groupId;
  row.innerHTML = `
    <div class="tk-row-top">
      <span class="tk-row-prompt">${esc(`${total} 个副本，已完成 ${done}`)}</span>
      <span class="tk-chip" data-tone="${done === total ? "done" : "run"}">${done}/${total}</span>
    </div>
    <button class="tk-children-toggle" type="button" aria-expanded="${open ? "true" : "false"}">
      <span>${total} 张单</span><span class="tk-child-caret" aria-hidden="true">▸</span>
    </button>
    <div class="tk-children"${open ? "" : " hidden"}></div>
  `;
  const body = row.querySelector(".tk-children");
  for (const ticket of group.tickets) body.append(workRow(ticket));
  row.querySelector(".tk-children-toggle").addEventListener("click", () => {
    const next = !state.tasksFanoutOpen.has(group.groupId);
    if (next) state.tasksFanoutOpen.add(group.groupId);
    else state.tasksFanoutOpen.delete(group.groupId);
    body.hidden = !next;
    row
      .querySelector(".tk-children-toggle")
      .setAttribute("aria-expanded", next ? "true" : "false");
  });
  return row;
}

function workRow(ticket) {
  const children = childTicketsOf(ticket.id);
  const [label, tone] = TASK_STATUS[ticket.status] || [ticket.status || "未知", "idle"];
  const prompt = String(ticket.prompt || "").replace(/\s+/g, " ").trim();
  const brief = prompt ? (prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt) : "（没有说明）";
  const childrenOpen = state.tasksChildrenOpen.has(ticket.id);

  const childRows = children
    .map((child) => {
      const [childLabel, childTone] = TASK_STATUS[child.status] || [child.status || "未知", "idle"];
      return `<a class="tk-child-row" href="#/tasks?ticket=${encodeURIComponent(child.id)}">
        <span class="tk-child-id">${esc(child.id)}</span>
        <span class="tk-chip" data-tone="${childTone}">${esc(childLabel)}</span>
        <span class="tk-child-time">${esc(relativeTime(child.updated_at))}</span>
      </a>`;
    })
    .join("");

  // 行根是 div[role=button]：行内还要放「子单 N」按钮，按钮里嵌按钮是非法 HTML。
  // 键盘行为由 tasksBody 上的 keydown 补齐。展开态 key = 派活行（父单）id。
  const row = document.createElement("div");
  row.className = "tk-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.dataset.ticket = ticket.id;
  row.dataset.lamp = ticketLamp(ticket);
  row.innerHTML = `
    <div class="tk-row-top">
      <span class="tk-row-prompt">${esc(brief)}</span>
      <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
    </div>
    <div class="tk-row-meta">
      <span class="tk-row-who">${esc(employeeName(ticket.employee))}</span>
      <span class="tk-row-time">${esc(relativeTime(ticket.updated_at))}${esc(stalenessHint(ticket.status, ticket.updated_at))}</span>
    </div>
    ${ticketActionButtons(ticket)}
    ${
      children.length
        ? `<button class="tk-children-toggle" type="button" data-ticket="${attr(ticket.id)}" aria-expanded="${childrenOpen ? "true" : "false"}">
            <span>子单 ${children.length}</span><span class="tk-child-caret" aria-hidden="true">▸</span>
          </button>
          <div class="tk-children"${childrenOpen ? "" : " hidden"}>${childRows}</div>`
        : ""
    }
  `;
  return row;
}

/** 对话卡：卡头 = 对话（可点回原对话），卡身 = 这条对话派出去的每次活 */
function conversationCard(card) {
  const badges = [
    card.chiefName ? `<span class="tk-badge">总管 ${esc(card.chiefName)}</span>` : "",
    card.project ? `<span class="tk-badge">区域 ${esc(card.project)}</span>` : "",
  ].join("");
  const element = document.createElement("article");
  element.className = "tk-card";
  element.dataset.lamp = card.lamp;
  // 全 done 的卡不进主视图；万一进来也不挂灯，只留时间（灯只在有话要说时才亮）
  const lamp = card.lamp === "done" ? "" : lampHtml(card.lamp);
  element.innerHTML = `
    <button class="tk-conv-head" type="button" data-conv="${attr(card.conversationId)}" title="回到这条对话">
      <span class="tk-conv-title">${esc(card.title || "未命名对话")}</span>
      <span class="tk-conv-badges">${badges}</span>
      <span class="tk-conv-tail">${lamp}<span class="tk-conv-time">${esc(relativeTime(card.updated_at))}${esc(card.lamp === "run" ? stalenessHint("run", card.updated_at) : "")}</span></span>
    </button>
    <div class="tk-rows"></div>
  `;
  const rows = element.querySelector(".tk-rows");
  for (const entry of fanoutLayout(workRowsOf(card))) {
    rows.append(entry.group ? fanoutRow(entry.group) : workRow(entry.ticket));
  }
  return element;
}

/**
 * 「派活」次数的唯一算法（批 18 七原则⑤）：父单一行算一次，子单不算。
 * 统计条与标题副行都走它——两处各算一份就会互相矛盾。
 */
function dispatchedCount(cards, direct) {
  return (
    cards.reduce((sum, card) => sum + workRowsOf(card).length, 0) +
    direct.filter((ticket) => !ticket.parentTicketId).length
  );
}

function renderStats(cards, direct) {
  const count = (lamp) => cards.filter((card) => card.lamp === lamp).length;
  // 「派活」数的是派活行（父单），子单不算一次派活
  const dispatched = dispatchedCount(cards, direct);
  const stats = [
    ["进行中", count("run"), "run"],
    ["等你处理", count("ask"), "ask"],
    ["有单出错", count("fail"), "fail"],
    // 已作废的单也收在「已完结」折叠区：叫「已完成」会把作废说成干完了（七原则⑤）
    ["已完结", count("done"), ""],
    ["派活", dispatched, ""],
  ];
  el.tasksStats.replaceChildren();
  for (const [label, value, tone] of stats) {
    const tile = document.createElement("div");
    tile.className = "tk-stat";
    if (tone) tile.dataset.tone = tone;
    tile.innerHTML = `<div class="tk-stat-label">${esc(label)}</div><div class="tk-stat-value">${value}</div>`;
    el.tasksStats.append(tile);
  }
}

/** 旧行式简卡（直派单用）：单号 + prompt 截断 + 状态徽章 + 相对时间；不带进度条与错误详情 */
function archiveRow(ticket) {
  const [label, tone] = TASK_STATUS[ticket.status] || [ticket.status || "未知", "idle"];
  const prompt = String(ticket.prompt || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tk-arch-row";
  row.dataset.ticket = ticket.id;
  row.dataset.status = ticket.status;
  row.innerHTML = `
    <span class="tk-arch-id">${esc(ticket.id)}</span>
    <span class="tk-arch-prompt">${esc(prompt || "（没有说明）")}</span>
    <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
    <span class="tk-arch-time">${esc(relativeTime(ticket.updated_at))}</span>
  `;
  return row;
}

/** 已完结简卡：对话卡样式（标题 + 聚合灯 + 时间），点它回原对话 */
function archiveCard(card) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tk-arch-conv";
  row.dataset.conv = card.conversationId;
  row.title = "回到这条对话";
  row.innerHTML = `
    <span class="tk-arch-title">${esc(card.title || "未命名对话")}</span>
    <span class="tk-arch-count">${workRowsOf(card).length} 次派活</span>
    ${lampHtml("done")}
    <span class="tk-arch-time">${esc(relativeTime(card.updated_at))}</span>
  `;
  return row;
}

/**
 * 折叠条：已完结区与「更早的直派」共用一套外观，但各自记展开态。
 * 结构 = 一条横条 + 一段列表；横条点一下就地收放，不重绘整板。
 */
function foldSection({ count, label, emptyText, open, onToggle, renderRow }) {
  if (!count) {
    const bar = document.createElement("div");
    bar.className = "tk-archive-bar is-empty";
    bar.textContent = emptyText;
    return bar;
  }
  const items = document.createElement("div");
  items.className = "tk-arch-list";
  items.hidden = !open;
  for (const item of renderRow()) items.append(item);

  const bar = document.createElement("button");
  bar.type = "button";
  bar.className = "tk-archive-bar";
  bar.setAttribute("aria-expanded", String(open));
  bar.innerHTML = `<span>${esc(label)}</span><span class="tk-arch-caret" aria-hidden="true">▸</span>`;
  bar.addEventListener("click", () => {
    const next = !items.hidden;
    items.hidden = !next;
    bar.setAttribute("aria-expanded", String(next));
    onToggle(next);
  });
  // 容器本身是 .tk-archive（flex 列 + gap），这里只交出「横条 + 列表」两段
  const fragment = document.createDocumentFragment();
  fragment.append(bar, items);
  return fragment;
}

/**
 * 已完结折叠区（K1/L3）：全 done 的对话卡从三列退场，只留底部一条低调横条。
 * 放在看板网格外（见 index.html），窄屏不必横向滚到最右才点得到。
 * 展开态记 state.tasksArchiveOpen —— 会话内存，刷新回到收合。
 */
function renderArchive(cards) {
  el.tasksArchive.replaceChildren();
  el.tasksArchive.hidden = false;
  el.tasksArchive.append(
    foldSection({
      count: cards.length,
      // 这一区收的是「已完结」：done 与已作废都在里面，别写「已完成」（七原则⑤）
      label: `已完结 ${cards.length} 个对话`,
      emptyText: "已完结 0 个对话",
      open: state.tasksArchiveOpen,
      onToggle: (next) => {
        state.tasksArchiveOpen = next;
      },
      renderRow: () => cards.map(archiveCard),
    }),
  );
}

/**
 * 「更早的直派」（L3）：没有 conversationId 的旧单/探针单不进三列，
 * 沿用已完结的折叠样式摆在最下面，默认收起。清库后正常情况下这里是空的。
 */
function renderDirect(rows) {
  el.tasksDirect.replaceChildren();
  if (!rows.length) {
    el.tasksDirect.hidden = true;
    return;
  }
  el.tasksDirect.hidden = false;
  el.tasksDirect.append(
    foldSection({
      count: rows.length,
      label: `更早的直派 ${rows.length} 单（没有来源对话）`,
      emptyText: "",
      open: state.tasksDirectOpen,
      onToggle: (next) => {
        state.tasksDirectOpen = next;
      },
      renderRow: () => rows.map(archiveRow),
    }),
  );
}

function boardEmptyNote(hasTickets) {
  const note = document.createElement("div");
  note.className = "tk-board-empty";
  note.innerHTML = hasTickets
    ? `<h2>没有正在跑的活</h2>
       <p>派出去后按对话收成一张卡；已经完结的在下方「已完结」里</p>`
    : `<h2>还没有派出去的活</h2>
       <p>在对话里派活后，这里会按对话收成一张卡，卡身是每次派活</p>`;
  return note;
}

/** 清除筛选：领域 / 项目 / 执行者 / 排序一起回到默认，并同步 hash 与下拉框 */
function clearTaskFilters() {
  state.domainFilter = "";
  state.projectFilter = "";
  state.tasksEmployeeFilter = "";
  state.sort = "recent";
  el.tasksDomain.value = "";
  el.tasksProject.value = "";
  el.tasksSort.value = "recent";
  writeTasksHash("");
  renderTasksView();
}

/** 筛选筛空：就地提示 + 一键清除；打手四卡留在上方，点错执行者也能自己点回来 */
function filterEmptyNote() {
  const note = document.createElement("div");
  note.className = "tk-board-empty";
  const heading = document.createElement("h2");
  heading.textContent = "没有符合筛选的任务单";
  const text = document.createElement("p");
  text.textContent = "换个领域、项目或执行者，或者清除筛选看看全部任务。";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = "清除筛选";
  button.addEventListener("click", clearTaskFilters);
  note.append(heading, text, button);
  return note;
}

export { CANCEL_BLOCKED_STATUS, RETRYABLE_TICKET_STATUS, archiveCard, archiveRow, boardEmptyNote, clearTaskFilters, conversationCard, dispatchedCount, fanoutLayout, fanoutRow, filterEmptyNote, foldSection, hitterCards, loadProjects, renderArchive, renderDirect, renderHitters, renderSideListEmpty, renderStats, syncDomainOptions, syncProjectOptions, syncTasksBadge, ticketActionButtons, workRow };
