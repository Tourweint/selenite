/**
 * 审批浮窗（含全局待办快照标记 connPhoneCount）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { approvalCards, approvalSourceLabel, parseAskUserPayload } from "./approval-card.js";
import { openConversation } from "./chat-open.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { syncRosterBusy } from "./partners-status.js";
import { updateConnectionHint } from "./settings-connection.js";
import { state } from "./state.js";
import { toast } from "./ui-atoms.js";

let approvalPopKnown = false;

/* ── 审批浮窗（2026-11-08）：人在别的会话/别的页也能当场批 ─────────
 * 全局待审批 5 秒一拉，一份数据多处分用（浮窗 / 群胶囊）。浮窗只弹「当前看不见的」：
 * 当前会话已有的对话流卡、点过「忽略」的都不重复。同屏最多 3 张，余下收成一行计数。
 * 原设置页「待处理审批」块与抽屉入口退役：bury 在设置里难找，审批不点头 agent 就干等。 */
const APPROVAL_POP_POLL_MS = 5000;
const APPROVAL_POP_MAX = 3;
const APPROVAL_POP_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
let approvalPopTimer = 0;
let approvalPopTicker = 0;
let approvalPopItems = [];
const approvalPopDismissed = new Set(); // 本次会话期内点过「忽略」的 callId

function approvalPopHost() {
  let host = document.getElementById("approval-popups");
  if (!host) {
    host = document.createElement("div");
    host.id = "approval-popups";
    document.body.append(host);
  }
  return host;
}

/** 弹不弹这一条：被忽略过、当前会话的对话流卡已经挂着 → 都不弹 */
function approvalPopVisible(item) {
  if (approvalPopDismissed.has(item.callId)) return false;
  const card = approvalCards.get(item.callId);
  if (card?.root?.isConnected) return false;
  return true;
}

/** blocking 形态给倒计时，async 形态只写「等待处理」（同对话流卡的口径） */
function approvalPopRemainText(deadlineAt) {
  if (state.capabilities.approvalMode !== "blocking") return "等待处理";
  const deadline = Date.parse(deadlineAt || "");
  if (!Number.isFinite(deadline)) return "";
  const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  return left > 0 ? `剩余 ${left} 秒，超时按拒绝处理` : "已超时";
}

function renderApprovalPopups() {
  const host = approvalPopHost();
  const visible = approvalPopItems.filter(approvalPopVisible);
  host.replaceChildren();
  if (!visible.length) {
    host.hidden = true;
    syncApprovalPopTicker();
    return;
  }
  host.hidden = false;
  for (const item of visible.slice(0, APPROVAL_POP_MAX)) host.append(approvalPopupCard(item));
  if (visible.length > APPROVAL_POP_MAX) {
    const more = document.createElement("div");
    more.className = "approval-pop-more";
    more.textContent = `还有 ${visible.length - APPROVAL_POP_MAX} 条待处理`;
    host.append(more);
  }
  syncApprovalPopTicker();
}

function approvalPopupCard(item) {
  const source = approvalSourceLabel(item.conversationId) || item.chatTitle || "未命名会话";
  const card = document.createElement("div");
  card.className = "approval-pop";
  if (item.tool === "ask_user" || item.kind === "ask_user") {
    return askUserPopupCard(card, item, source);
  }
  const deadline = Date.parse(item.deadlineAt || "");
  card.innerHTML = `
    <div class="approval-pop-head">
      <span class="approval-pop-tool">${esc(item.tool || "工具")}${item.origin === "autonomous" ? '<span class="pill-tag">例行任务</span>' : ""}</span>
      <button class="approval-pop-close" type="button" title="忽略（这条不再弹；审批还在，超时按拒绝处理）" aria-label="忽略">${APPROVAL_POP_X}</button>
    </div>
    <div class="approval-pop-source">${esc(source)}</div>
    ${String(item.args || "").trim() ? `<pre class="approval-pop-args">${esc(String(item.args).slice(0, 160))}</pre>` : ""}
    <div class="approval-pop-foot">
      <span class="approval-pop-time" data-deadline="${Number.isFinite(deadline) ? deadline : ""}">${esc(approvalPopRemainText(item.deadlineAt))}</span>
      <button class="approval-more" type="button" data-pop-more="${esc(item.callId)}">带说明拒绝</button>
      <button class="ghost" type="button" data-pop-approve="${esc(item.callId)}">批准</button>
      <button class="ghost" type="button" data-pop-reject="${esc(item.callId)}">拒绝</button>
    </div>
    <div class="approval-feedback" data-pop-feedback="${esc(item.callId)}" hidden>
      <textarea class="cs-textarea" rows="2" placeholder="告诉他怎么改（可选，不填就是普通拒绝）"></textarea>
      <button class="ghost" type="button" data-pop-reject-note="${esc(item.callId)}">拒绝并说明</button>
    </div>`;
  card.querySelector("[data-pop-approve]")?.addEventListener("click", () => void decideGlobalApproval(item.callId, "approve"));
  card.querySelector("[data-pop-reject]")?.addEventListener("click", () => void decideGlobalApproval(item.callId, "reject"));
  card.querySelector("[data-pop-more]")?.addEventListener("click", () => {
    const row = card.querySelector("[data-pop-feedback]");
    if (row) row.hidden = !row.hidden;
  });
  card.querySelector("[data-pop-reject-note]")?.addEventListener("click", () => {
    const input = card.querySelector("[data-pop-feedback] textarea");
    void decideGlobalApproval(item.callId, "reject", input ? input.value : "");
  });
  card.querySelector(".approval-pop-close")?.addEventListener("click", () => {
    approvalPopDismissed.add(item.callId);
    renderApprovalPopups();
  });
  // 点卡片跳到那条会话（按钮上的点击不算）
  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    if (item.conversationId) void openConversation(item.conversationId);
  });
  return card;
}

/** 提问的浮窗卡（2026-11-09 §3）：选项即答复，也可以自己写。 */
function askUserPopupCard(card, item, source) {
  const payload = parseAskUserPayload(item.args);
  card.innerHTML = `
    <div class="approval-pop-head">
      <span class="approval-pop-tool">有个问题等你回答</span>
      <button class="approval-pop-close" type="button" title="忽略" aria-label="忽略">${APPROVAL_POP_X}</button>
    </div>
    <div class="approval-pop-source">${esc(source)}</div>
    <div class="approval-pop-question">${esc(payload.question || "（问题正文缺失）")}</div>
    ${
      payload.options.length
        ? `<div class="approval-actions">${payload.options
            .map((text, index) => {
              const label = index === payload.recommended ? `${text}（建议）` : text;
              return `<button class="ghost" type="button" data-answer="${index}">${esc(label)}</button>`;
            })
            .join("")}</div>`
        : ""
    }
    <div class="approval-feedback">
      <textarea class="cs-textarea" rows="2" placeholder="直接回答…"></textarea>
      <button class="ghost" type="button" data-answer-send="1">回答</button>
    </div>`;
  card.querySelectorAll("[data-answer]").forEach((button, index) => {
    button.addEventListener("click", () =>
      void answerGlobalQuestion(item.callId, payload.options[index] || ""),
    );
  });
  card.querySelector("[data-answer-send]")?.addEventListener("click", () => {
    const input = card.querySelector(".approval-feedback textarea");
    void answerGlobalQuestion(item.callId, input ? input.value : "");
  });
  card.querySelector(".approval-pop-close")?.addEventListener("click", () => {
    approvalPopDismissed.add(item.callId);
    renderApprovalPopups();
  });
  return card;
}

/** 倒计时一秒一跳；没有可见卡片就停表 */
function syncApprovalPopTicker() {
  const need = Boolean(document.querySelector(".approval-pop"));
  if (need && !approvalPopTicker) {
    approvalPopTicker = setInterval(() => {
      for (const node of document.querySelectorAll(".approval-pop-time")) {
        const deadline = Number(node.dataset.deadline);
        node.textContent = Number.isFinite(deadline) && deadline
          ? approvalPopRemainText(new Date(deadline).toISOString())
          : approvalPopRemainText("");
      }
    }, 1000);
  } else if (!need && approvalPopTicker) {
    clearInterval(approvalPopTicker);
    approvalPopTicker = 0;
  }
}

async function refreshApprovalPopups() {
  // 用户自己停了 runtime：别把浮窗刷成错误态（同 checkHealth 的口径）
  if (document.body.dataset.runtime === "stopped") {
    approvalPopItems = [];
    approvalPopKnown = false;
    renderApprovalPopups();
    syncRosterBusy();
    return;
  }
  try {
    const response = await request("/api/v1/agent/approvals", { cache: "no-store" });
    const data = response.ok ? await response.json().catch(() => ({})) : {};
    approvalPopItems = Array.isArray(data.approvals) ? data.approvals : [];
    // 只有服务端明确回了清单，才敢说「这个执事不在等审批」（批 18 §2.2 降级口径）
    approvalPopKnown = response.ok && data.ok !== false;
  } catch (error) {
    if (error.message !== "forbidden") approvalPopItems = [];
    approvalPopKnown = false;
  }
  renderApprovalPopups();
  // 同一份快照也喂侧栏忙因胶囊（不额外打一次接口）
  syncRosterBusy();
}

function startApprovalPopWatch() {
  if (approvalPopTimer) return;
  approvalPopTimer = setInterval(() => void refreshApprovalPopups(), APPROVAL_POP_POLL_MS);
}

async function decideGlobalApproval(callId, decision, feedback = "") {
  try {
    const response = await request(`/api/v1/agent/approvals/${encodeURIComponent(callId)}`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        ...(decision === "reject" && String(feedback || "").trim()
          ? { feedback: String(feedback).trim() }
          : {}),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || data.error || `答复失败：HTTP ${response.status}`);
      return;
    }
    toast(
      {
        approved: "已批准",
        rejected: "已拒绝",
        timeout: "已超时（按拒绝处理）",
        aborted: "本轮已停止",
      }[data.status] || "已处理",
    );
    // 聊天卡片上若挂着同一条，同步置灰，避免两处按钮各按一次
    const entry = approvalCards.get(callId);
    if (entry) {
      clearInterval(entry.timer);
      entry.root.classList.add("resolved");
      for (const button of entry.root.querySelectorAll("button")) button.disabled = true;
      approvalCards.delete(callId);
    }
    // 浮窗同步（2026-11-08）：把已答复的从待弹清单里去掉立刻重画，
    // 不等下一轮 5 秒轮询——批完还挂着一张可再点的卡会误导
    approvalPopItems = approvalPopItems.filter((item) => item.callId !== callId);
    renderApprovalPopups();
  } catch (error) {
    if (error.message !== "forbidden") toast(`答复失败：${error.message}`);
  }
}

/** ask_user 的答复（2026-11-09 §3）：浮窗与对话流卡片共用这一条路 */
async function answerGlobalQuestion(callId, text) {
  const answer = String(text || "").trim();
  if (!answer) return;
  try {
    const response = await request(
      `/api/v1/agent/approvals/${encodeURIComponent(callId)}/answer`,
      { method: "POST", body: JSON.stringify({ answer }) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || data.error || `答复失败：HTTP ${response.status}`);
      return;
    }
    toast("已回答");
    const entry = approvalCards.get(callId);
    if (entry) {
      entry.root.classList.add("resolved");
      for (const button of entry.root.querySelectorAll("button")) button.disabled = true;
      approvalCards.delete(callId);
    }
    approvalPopItems = approvalPopItems.filter((item) => item.callId !== callId);
    renderApprovalPopups();
  } catch (error) {
    if (error.message !== "forbidden") toast(`答复失败：${error.message}`);
  }
}

function ago(at) {
  if (!at) return "还没用过";
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚用过";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前用过`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前用过`;
  return `${Math.floor(diff / 86_400_000)} 天前用过`;
}

async function loadDevices() {
  const card = document.getElementById("device-card");
  if (!card) return;
  try {
    const response = await request("/api/v1/pair/devices", { cache: "no-store" });
    const data = await response.json();
    const devices = (data.devices || []).filter((device) => !device.revoked);
    // 链路图的「手机」格（2026-11-13）：台数 + 更新断点提示
    connPhoneCount = devices.length;
    const phoneNode = document.getElementById("conn-phones");
    if (phoneNode) phoneNode.textContent = devices.length ? `${devices.length} 台` : "0 台";
    updateConnectionHint();
    if (!devices.length) {
      card.innerHTML = `<div class="row"><div class="row-main">
        <div class="row-label">还没有手机</div>
        <div class="row-hint">上面扫一次码就会出现在这里</div>
      </div></div>`;
      return;
    }
    card.innerHTML = devices
      .map(
        (device, index) => `${index ? '<div class="divider"></div>' : ""}
        <div class="row">
          <div class="row-main">
            <div class="row-label">${esc(device.name || "手机")}</div>
            <div class="row-hint">${ago(device.lastSeenAt)}</div>
          </div>
          <div class="row-control">
            <button class="ghost" type="button" data-revoke="${esc(device.id)}">移除</button>
          </div>
        </div>`,
      )
      .join("");
    for (const button of card.querySelectorAll("[data-revoke]")) {
      button.addEventListener("click", async () => {
        button.disabled = true;
        await request(
          `/api/v1/pair/devices/${encodeURIComponent(button.dataset.revoke)}/revoke`,
          { method: "POST" },
        ).catch(() => undefined);
        void loadDevices();
      });
    }
  } catch {
    card.innerHTML = `<div class="row"><div class="row-main">
      <div class="row-hint">读不到设备列表</div></div></div>`;
  }
}
let connPhoneCount = null;

export { APPROVAL_POP_MAX, APPROVAL_POP_POLL_MS, APPROVAL_POP_X, ago, answerGlobalQuestion, approvalPopDismissed, approvalPopHost, approvalPopItems, approvalPopKnown, approvalPopRemainText, approvalPopTicker, approvalPopTimer, approvalPopVisible, approvalPopupCard, askUserPopupCard, connPhoneCount, decideGlobalApproval, loadDevices, refreshApprovalPopups, renderApprovalPopups, startApprovalPopWatch, syncApprovalPopTicker };
