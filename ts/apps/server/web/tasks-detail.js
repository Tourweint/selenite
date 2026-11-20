/**
 * 任务详情页 + 专线回读回话
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openConversation } from "./chat-open.js";
import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { go } from "./route.js";
import { state } from "./state.js";
import { ticketActionButtons } from "./tasks-board.js";
import { hideTasksState } from "./tasks-cards.js";
import { SUBTASK_STATUS, TASK_STATUS, employeeText, relativeTime, stalenessHint, statusError, ticketStagesHtml } from "./tasks-model.js";
import { toast } from "./ui-atoms.js";

async function showTicketDetail(ticketId) {
  hideTasksState();
  // 详情页压住两张看板（新视图 / 旧看板），回来时由 renderTasksView 按开关决定显示哪张
  el.tasksRedesign.hidden = true;
  el.tasksLegacy.hidden = true;
  el.tasksBoard.hidden = true;
  el.tasksArchive.hidden = true;
  el.tasksDirect.hidden = true;
  el.tasksHitters.hidden = true;
  el.tasksStats.hidden = true;
  el.tasksFilters.hidden = true;
  el.tasksDetail.hidden = false;
  el.tasksBack.hidden = false;
  el.tasksTitleText.textContent = "任务单";
  el.tasksTitleSub.textContent = ticketId;
  const loading = document.createElement("p");
  loading.className = "td-note";
  loading.textContent = "正在读取任务单…";
  el.tasksDetail.replaceChildren(loading);

  try {
    const response = await request(`/api/v1/tickets/${encodeURIComponent(ticketId)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw statusError(response.status);
    const data = await response.json();
    renderTicketDetail(data, ticketId);
  } catch (error) {
    const notFound = error && error.status === 404;
    const wrap = document.createElement("div");
    wrap.className = "td-card";
    const note = document.createElement("p");
    note.className = "td-note";
    note.dataset.tone = "fail";
    note.textContent = notFound
      ? "找不到这张任务单，可能已经被清理了。"
      : "任务单详情没读出来，稍后再试一次。";
    const row = document.createElement("div");
    row.className = "tasks-actions";
    row.style.marginTop = "12px";
    if (!notFound) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ghost";
      retry.textContent = "重试";
      retry.addEventListener("click", () => void showTicketDetail(ticketId));
      row.append(retry);
    }
    const back = document.createElement("button");
    back.type = "button";
    back.className = "ghost";
    back.textContent = "返回看板";
    back.addEventListener("click", () => go("tasks"));
    row.append(back);
    wrap.append(note, row);
    el.tasksDetail.replaceChildren(wrap);
  }
}

function renderTicketDetail(data, fallbackId) {
  const ticket = data.ticket || {};
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  const children = Array.isArray(data.children) ? data.children : [];
  const [statusLabel, statusTone] = TASK_STATUS[ticket.status] || [ticket.status || "未知", "idle"];
  const total = tasks.length;
  const passed = tasks.filter((task) => task.status === "passed").length;
  const percent = total > 0 ? Math.min(100, Math.round((passed / total) * 100)) : 0;
  const employee = employeeText(ticket.employee || ticket.options?.employee);
  const project = data.project?.name || ticket.options?.project?.name || "";
  const error = ticket.error ? String(ticket.error).trim() : "";
  // 接口带回这三项后才显示；现在没有就完全不渲染（等后端落盘）
  const lastAction = String(ticket.lastAction || data.lastAction || "").trim();
  const waitingOn = String(ticket.waitingOn || data.waitingOn || "").trim();
  const heartbeat = ticket.lastHeartbeat || data.lastHeartbeat || "";
  // 计划附件（2026-11-09 §2.4）：没有 steps 时整块不渲染（零影响）。
  // "现在到哪一步"按已过任务数估（任务中心没有逐 step 状态，不编一个假进度）。
  const steps = Array.isArray(data.steps)
    ? data.steps
    : Array.isArray(ticket.steps)
      ? ticket.steps
      : [];
  const stepIndex = steps.length > 0 ? Math.min(passed, steps.length - 1) : -1;

  const taskRows = tasks.length
    ? tasks
        .map((task) => {
          const [label, tone] = SUBTASK_STATUS[task.status] || [task.status || "未知", "idle"];
          return `<li class="td-task">
            <span class="td-seq">${String(task.seq).padStart(2, "0")}</span>
            <span class="td-task-title">${esc(task.title || task.slug || "")}</span>
            <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
          </li>`;
        })
        .join("")
    : `<div class="td-note">任务还没拆出来；等负责人规划后会出现在这里。</div>`;

  const childRows = children.length
    ? `<section class="td-section">
        <h3>子任务单<span>${children.length}</span></h3>
        ${children
          .map((child) => {
            const [label, tone] = TASK_STATUS[child.status] || [child.status || "未知", "idle"];
            return `<a class="td-child" href="#/tasks?ticket=${encodeURIComponent(child.id)}">
              <span>任务单</span>
              <span class="td-child-id">${esc(child.id)}</span>
              <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
            </a>`;
          })
          .join("")}
      </section>`
    : "";


  // 迟到的回报（E2 #2）：父单终态后才回来的子单结果，只读记账，不自动并入。
  // 空数组整节不渲染；每行照 reviewRows 的写法：子单 id · 状态 pill · note · 时间。
  const deadLetters = Array.isArray(data.deadLetters) ? data.deadLetters : [];
  const deadLetterRows = deadLetters.length
    ? `<section class="td-section">
        <h3>迟到的回报<span>${deadLetters.length}</span></h3>
        <p class="td-sec-hint">父单已终态后子单才回的结果，记账在此，不会自动并入。</p>
        ${deadLetters
          .map((letter) => {
            const [label, tone] = TASK_STATUS[letter.childStatus] || [letter.childStatus || "未知", "idle"];
            return `<div class="td-review">
              <div class="td-review-top">
                <span class="td-deadletter-id">${esc(letter.childTicketId || "")}</span>
                <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
                <span class="td-stage" title="${esc(letter.createdAt || "")}">${esc(relativeTime(letter.createdAt))}</span>
              </div>
              <p>${esc(letter.note || "（没有说明）")}</p>
            </div>`;
          })
          .join("")}
      </section>`
    : "";

  // 派活留言（2026-11-07）：把"谁在什么时候说了什么"摆在需求正文之前。
  // 以前详情只有 ticket.prompt 一段裸文本，看不出是总管说的还是别人转的。
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const SENDER_LABEL = { chief: "总管", partner: "", worker: "执行端", system: "系统" };
  const messageRows = messages.length
    ? `<section class="td-section td-messages">
        <h3>派活往来<span>${messages.length}</span></h3>
        ${messages
          .map((message) => {
            const who =
              message.fromKind === "partner"
                ? message.fromName || "执事"
                : message.fromName || SENDER_LABEL[message.fromKind] || "系统";
            const isOut = message.direction === "out";
            return `<div class="td-msg" data-dir="${esc(message.direction || "out")}">
              <div class="td-msg-top">
                <span class="td-msg-who">${isOut ? "来自" : "回到"} ${esc(who)}</span>
                <span class="td-stage" title="${esc(message.createdAt || "")}">${esc(relativeTime(message.createdAt))}</span>
              </div>
              <p class="td-msg-body">${esc(message.body || "")}</p>
            </div>`;
          })
          .join("")}
      </section>`
    : "";

  // 动作区（扫尾批 1 A1）：详情与行内共用一套按钮；开关随本页响应下发。
  const actionButtons = ticketActionButtons(
    ticket,
    data.cancelEnabled === true || state.ticketsCancelEnabled,
  );

  // 任务专线（2026-11-08 扫尾批 8g「任务即对话」）：一张单一条 `task-<票号>` 会话。
  // 旧留言区保留（过渡期兜底），这里只加"回话 + 回读"；打开对话走通用会话页。
  const taskConversationEnabled = data.taskConversationEnabled === true;
  const taskConversationId =
    typeof data.taskConversationId === "string" ? data.taskConversationId : "";
  const conversationSection = taskConversationEnabled
    ? `<section class="td-section td-task-convo" data-conv="${esc(taskConversationId)}">
        <h3>任务对话</h3>
        <p class="td-sec-hint">这张单的专线会话；在这里回话会直接转给执行端。</p>
        <div class="td-convo-list" id="td-convo-list"><p class="td-note">正在读专线…</p></div>
        <div class="td-convo-form">
          <textarea class="cs-textarea" id="td-convo-input" rows="2" placeholder="在这张单里回话…"></textarea>
          <div class="td-convo-actions">
            <button class="primary" type="button" id="td-convo-send">发送</button>
            <button class="ghost" type="button" id="td-convo-open" hidden>打开对话</button>
          </div>
        </div>
      </section>`
    : "";

  // 计划附件（2026-11-09 §2.4）：默认只显示"现在到哪一步"，点开才展开全部 steps。
  // 没有 steps 就整块不出现；返工单在行尾带上轮次，避免"怎么又回到第一步"的困惑。
  const stepsSection =
    steps.length > 0
      ? `<details class="td-steps">
          <summary>
            <span class="td-step-label">现在到哪一步</span>
            <span class="td-step-now">第 ${stepIndex + 1}/${steps.length} 步：${esc(steps[stepIndex] || "")}</span>
          </summary>
          <ol class="td-step-list">
            ${steps.map((step) => `<li>${esc(step)}</li>`).join("")}
          </ol>
        </details>`
      : "";

  el.tasksDetail.innerHTML = `
    <div class="td-card"${ticket.status === "needs_you" ? ' data-attn="1"' : ""}>
      <div class="td-head">
        <span class="tk-chip" data-tone="${statusTone}">${esc(statusLabel)}</span>
        <span class="td-domain">${esc(data.domain || ticket.options?.domain || "")}</span>
        ${project ? `<span class="td-proj">项目 ${esc(project)}</span>` : ""}
        <span class="td-time">${esc(relativeTime(ticket.updated_at))}${esc(stalenessHint(ticket.status, ticket.updated_at))}</span>
      </div>
      <h2 class="td-prompt">${esc(String(ticket.prompt || "").trim() || "（没有说明）")}</h2>
      ${ticketStagesHtml(ticket.status)}
      ${stepsSection}
      <div class="td-meta">
        <span>任务 <b>${passed}/${total}</b></span>
        ${employee ? `<span>执行者 ${esc(employee)}</span>` : ""}
        <span>任务单 ${esc(ticket.id || fallbackId)}</span>
        ${lastAction ? `<span>最近 ${esc(lastAction)}</span>` : ""}
        ${waitingOn ? `<span>等文件 ${esc(waitingOn)}</span>` : ""}
        ${heartbeat ? `<span>心跳 ${esc(relativeTime(heartbeat))}${esc(stalenessHint(ticket.status, heartbeat))}</span>` : ""}
      </div>
      ${total > 0 ? `<div class="tk-bar"><i style="width:${percent}%"></i></div>` : ""}
      ${error ? `<p class="td-note" data-tone="${ticket.status === "failed" || ticket.status === "aborted" ? "fail" : "ask"}">${esc(error)}</p>` : ""}
    </div>
    ${actionButtons ? `<div class="td-actions">${actionButtons}</div>` : ""}
    ${conversationSection}
    <section class="td-section">
      <h3>任务<span>${passed}/${total}</span></h3>
      <ul class="td-tasks">${taskRows}</ul>
    </section>
    ${childRows}
    ${deadLetterRows}
    ${messageRows}
  `;

  if (taskConversationEnabled) {
    wireTicketConversation(String(ticket.id || fallbackId || ""), taskConversationId);
  }
}

/* ── 任务专线：回读 + 回话（2026-11-08 扫尾批 8g）────────────
 * 回读走既有 GET messages（没建过会话 = 404，按"还没有记录"展示）；
 * 回话走 POST /tickets/:id/say，成功后重绘详情（服务端会带回新的会话 id）。
 * 不在详情页维护 SSE：专线是慢通道，发完重读一次足够。 */
function wireTicketConversation(ticketId, conversationId) {
  const list = document.getElementById("td-convo-list");
  const input = document.getElementById("td-convo-input");
  const send = document.getElementById("td-convo-send");
  const open = document.getElementById("td-convo-open");
  if (!list || !input || !send) return;

  if (open) {
    open.addEventListener("click", () => {
      if (conversationId) void openConversation(conversationId);
    });
  }

  const load = async () => {
    if (open) open.hidden = true;
    if (!conversationId) {
      list.innerHTML = `<p class="td-note">还没有专线记录；发第一句话会开一条。</p>`;
      return;
    }
    try {
      const response = await request(
        `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?limit=200`,
        { cache: "no-store" },
      );
      if (response.status === 404) {
        list.innerHTML = `<p class="td-note">还没有专线记录；发第一句话会开一条。</p>`;
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      // 会话确实存在（哪怕还是空的）才给"打开对话"，否则点了会掉进"新对话"。
      if (open) open.hidden = false;
      if (!messages.length) {
        list.innerHTML = `<p class="td-note">专线还是空的；进度、汇报和回话都会出现在这里。</p>`;
        return;
      }
      list.innerHTML = messages
        .map((message) => {
          const mine = message.role === "user";
          const at = message.at ? new Date(message.at).toISOString() : "";
          return `<div class="td-msg" data-dir="${mine ? "out" : "in"}">
            <div class="td-msg-top">
              <span class="td-msg-who">${mine ? "主人" : "任务专线"}</span>
              <span class="td-stage" title="${esc(at)}">${esc(at ? relativeTime(at) : "")}</span>
            </div>
            <p class="td-msg-body">${esc(message.text || "")}</p>
          </div>`;
        })
        .join("");
      list.scrollTop = list.scrollHeight;
    } catch (error) {
      list.innerHTML = `<p class="td-note" data-tone="fail">专线没读出来（${esc(error.message || "未知错误")}），稍后再试。</p>`;
    }
  };

  const submit = async () => {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    send.disabled = true;
    try {
      const response = await request(
        `/api/v1/tickets/${encodeURIComponent(ticketId)}/say`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(data?.message || `没发出去：HTTP ${response.status}`);
        return;
      }
      input.value = "";
      toast("已发到专线");
      // 重绘一次：服务端会把新建的专线 id 一起带回（首次回话时列表由它变成可读）。
      await showTicketDetail(ticketId);
    } catch (error) {
      if (error.message !== "forbidden") toast(`没发出去：${error.message}`);
    } finally {
      send.disabled = false;
    }
  };

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  });

  void load();
}

export { renderTicketDetail, showTicketDetail, wireTicketConversation };
