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
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { syncRosterBusy } from "./partners-status.js";
import { state } from "./state.js";
import { openConfirm, showAlert, toast } from "./ui-atoms.js";

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

/** 连接方式 → 人话（2026-11-14 连接页两分）：短标签给行首，长标签给说明行。 */
const TRANSPORT_BADGE = {
  usb: "本地连接",
  local: "本地连接",
  direct: "远程连接",
  relay: "远程连接",
};
const TRANSPORT_LABEL = {
  usb: "本地连接（数据线）",
  local: "本地连接（同一 WiFi）",
  direct: "远程连接（公网直连）",
  relay: "远程连接（经中继）",
};
const RELAY_PLATFORM_TEXT = {
  android: "手机",
  web: "网页",
  desktop: "电脑",
  win32: "电脑",
  darwin: "电脑",
  linux: "电脑",
};

/** "上次"：拿不到当前方式之外、最近一次的时刻（页面用来解释"它以前是怎么连的"） */
function previousTransport(transportAt, current) {
  if (!transportAt) return null;
  let best = null;
  for (const [transport, at] of Object.entries(transportAt)) {
    if (transport === current || typeof at !== "number" || !at) continue;
    if (!best || at > best.at) best = { transport, at };
  }
  return best;
}

/** 合并键（2026-11-14 星形拓扑与设备身份）：两套名册唯一能对上的键就是设备名。 */
function deviceKeyOf(name) {
  return (name || "").trim().toLowerCase().replace(/\s+/g, "") || "未命名设备";
}

/** 设备短码：# + 前 8 位（配对 id 与中继 deviceId 都是 16 位 hex，人眼能核又不喧宾夺主） */
function shortIdOf(id) {
  return id ? `#${id.slice(0, 8)}` : "";
}

/** 多久没连就算"久未使用"（页面标一枚提示，方便下决心移除） */
const CONN_IDLE_DAYS = 7;

/**
 * 已连接的设备（2026-11-14 星形拓扑与设备身份）：
 * 一份列表把本地配对名册与中继名册**按设备名合并成一行**（两套 id 都留着），
 * 外加两类"没名分"的事实：用主令牌直连未配对的、以及已撤销的。
 *
 * 合并只合并**展示行**，不合并主键：配对 id 归电脑端，deviceId 归中继，移除时各按各的接口撤销。
 */
async function loadDevices() {
  const card = document.getElementById("device-card");
  if (!card) return;
  const [pairData, relayData] = await Promise.all([
    request("/api/v1/pair/devices", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
    request("/api/v1/relay/overview", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
  ]);
  if (!pairData) {
    card.innerHTML = `<div class="row"><div class="row-main">
      <div class="row-hint">读不到设备列表</div></div></div>`;
    return;
  }

  const local = (pairData.devices || []).filter((device) => !device.revoked);
  const revoked = (pairData.devices || []).filter((device) => device.revoked);
  const selfRelayId = relayData?.selfDeviceId || "";
  const relay = relayData?.connected
    ? (relayData.devices || []).filter((device) => device.id !== selfRelayId)
    : [];
  const unpaired = pairData.unpaired || [];
  // 「此刻谁在说话」（2026-11-14 三次打磨）：服务端按设备身份记的 5 分钟活口。
  // 名册只记"配过谁"，它才回答"现在谁在用"——包括拿着已撤销凭据来敲门的那种。
  const live = pairData.live || [];
  // 「来过、但没登记」的凭据（2026-11-14 五次打磨）：平板隔几分钟才问一次，
  // 只看 5 分钟活口的话，用户点开这一页经常正好"它没在说话"——于是又是"找不到平板"。
  const unclaimed = pairData.unclaimed || [];
  connLiveOnly = [];
  connPhoneCount = local.length;

  /** key → 合并行；同一台设备（同名）出现在两套名册时落进同一行 */
  const merged = new Map();
  const rowOf = (name) => {
    const key = deviceKeyOf(name);
    let row = merged.get(key);
    if (!row) {
      row = {
        key,
        name: (name || "").trim() || "未命名设备",
        pairIds: [],
        relayIds: [],
        revokedIds: [],
        transports: [],
        platform: null,
        online: false,
        lastSeenAt: null,
        mergedRecords: 0,
      };
      merged.set(key, row);
    }
    return row;
  };

  for (const device of local) {
    const row = rowOf(device.name);
    row.pairIds.push(device.id);
    row.mergedRecords += 1;
    if (device.online) row.online = true;
    if (device.lastSeenAt && (!row.lastSeenAt || device.lastSeenAt > row.lastSeenAt)) {
      row.lastSeenAt = device.lastSeenAt;
    }
    if (device.lastTransport && !row.transports.includes(device.lastTransport)) {
      row.transports.push(device.lastTransport);
    }
  }
  for (const device of relay) {
    const row = rowOf(device.name);
    row.relayIds.push(device.id);
    row.mergedRecords += 1;
    if (device.online) row.online = true;
    if (device.lastSeenAt && (!row.lastSeenAt || device.lastSeenAt > row.lastSeenAt)) {
      row.lastSeenAt = device.lastSeenAt;
    }
    if (!row.transports.includes("relay")) row.transports.push("relay");
    row.platform = row.platform || device.platform || null;
  }

  // 撤销过的记录不再单开一行：**同名就并进上面那一行**（用户要的是"重复了合并"，把一台设备的旧凭据
  // 摊成第二行只会让人以为还有两台）。只剩撤销记录的名字才单独留一行标「已移除」。
  for (const device of revoked) {
    const key = deviceKeyOf(device.name);
    const existing = merged.get(key);
    if (existing) {
      existing.revokedIds.push(device.id);
      continue;
    }
    merged.set(key, {
      key,
      name: (device.name || "").trim() || "未命名设备",
      pairIds: [],
      relayIds: [],
      revokedIds: [device.id],
      transports: [],
      platform: null,
      online: false,
      lastSeenAt: device.lastSeenAt || null,
      mergedRecords: 0,
    });
  }

  connDeviceRows = [...merged.values()];
  // 活口落到行上（2026-11-14 三次打磨）：
  // ① 令牌有效 → 这一行就是在线的（哪怕 lastSeenAt 已经超出名册窗口）；
  // ② 令牌已撤销 → 这行标"正在连接、被拒"，别让人以为它凭空消失；
  // ③ 名册里根本没有的身份 → 后面单独补一行。
  const liveById = new Map();
  for (const entry of live) if (entry.id) liveById.set(entry.id, entry);
  const inRoster = new Set();
  for (const row of connDeviceRows) {
    for (const id of [...row.pairIds, ...row.relayIds]) inRoster.add(id);
    const byActive = [...row.pairIds, ...row.relayIds]
      .map((id) => liveById.get(id))
      .find((entry) => entry && !entry.revoked);
    if (byActive) {
      row.online = true;
      row.liveEntry = byActive;
    }
    const byRevoked = row.revokedIds.map((id) => liveById.get(id)).find(Boolean);
    if (byRevoked) row.attempt = byRevoked;
  }
  const rows = [];

  for (const row of connDeviceRows) {
    if (!row.pairIds.length && !row.relayIds.length) {
      // 只剩撤销记录：这枚凭据已经 403，藏起来只会让人以为"什么都没发生"
      rows.push(`<div class="row">
        <div class="row-main">
          <div class="row-label" data-tip="这枚凭据已撤销：它再连会被拒绝，重新扫一次码就能回来。"><i class="status-dot ${
            row.attempt ? "warn" : "idle"
          }"></i>${esc(row.name)}<span class="conn-badge">已移除</span>${
            row.attempt ? `<span class="conn-badge is-live">正在连接·被拒</span>` : ""
          }<span class="conn-id">${esc(shortIdOf(row.revokedIds[0]))}</span></div>
          <div class="row-hint">已撤销${row.attempt ? ` · ${ago(row.attempt.lastAt)}还在连（凭据失效，每次都会被拒）` : ""}${
            row.lastSeenAt ? ` · 上次用过 ${ago(row.lastSeenAt)}` : ""
          }</div>
        </div>
        <div class="row-control">
          <button class="ghost" type="button" data-purge="${esc(row.key)}" data-tip="只把这枚已撤销的残壳从名册里删掉；它的凭据早就作废了，删了不影响谁。">删除记录</button>
        </div>
      </div>`);
      continue;
    }
    const primaryId = row.relayIds[0] || row.pairIds[0] || "";
    // 「怎么进来的」（2026-11-14 二次打磨，用户问的就是这句）：本地 = 扫码配对，远程 = 经中继扫码加入。
    const sources = [];
    if (row.pairIds.length) sources.push("扫码配对");
    if (row.relayIds.length) sources.push("扫码加入中继");
    const badges = [];
    if (row.pairIds.length) badges.push("本地连接");
    if (row.relayIds.length) badges.push("远程连接");
    const badgeMarkup = badges
      .filter((label, index) => badges.indexOf(label) === index)
      .map((label) => `<span class="conn-badge">${label}</span>`)
      .join("");
    const parts = [sources.join(" + ")];
    const transports = row.transports.map((transport) => TRANSPORT_LABEL[transport] || transport);
    if (transports.length) {
      parts.push(`${row.online ? "现在" : "最近"}：${transports.join(" / ")}`);
    } else {
      parts.push(row.lastSeenAt ? "旧记录没记连接方式" : "还没连过");
    }
    if (row.lastSeenAt) parts.push(ago(row.lastSeenAt));
    if (row.mergedRecords > 1) parts.push(`合并 ${row.mergedRecords} 条记录`);
    if (row.revokedIds.length) parts.push(`另有 ${row.revokedIds.length} 条旧凭据已移除`);
    const idleDays = row.lastSeenAt ? Math.floor((Date.now() - row.lastSeenAt) / 86_400_000) : null;
    const idle = idleDays !== null && idleDays >= CONN_IDLE_DAYS ? `<span class="conn-badge is-idle">久未使用</span>` : "";
    const bothWays = row.relayIds.length && row.pairIds.length;
    // 解释性的话全进悬浮块（用户 2026-11-14：这一页解释性文字太多，挪到浮起的小块里）
    const tip = `${row.name}：# 后缀是区分同名设备的短 id。本地 = 扫码配对（同一 WiFi / 数据线 / USB 共享网络），远程 = 经中继扫码加入；两种都记着时同网络走本地（更快、不占中继），出门才走中继。绿点 = 在线（经中继真有连接，或最近活跃），灰点 = 离线。`;
    rows.push(`<div class="row">
      <div class="row-main">
        <div class="row-label" data-tip="${attr(tip)}"><i class="status-dot ${row.online ? "ok" : "idle"}"></i>${esc(row.name)}${badgeMarkup}${idle}<span class="conn-id">${esc(shortIdOf(primaryId))}</span></div>
        <div class="row-hint">${parts.join(" · ")}</div>
      </div>
      <div class="row-control">
        <button class="ghost" type="button" data-remove="${esc(row.key)}"${
          bothWays ? ` data-tip="这台设备两条路都有记录，移除会两边一起撤销"` : ""
        }>移除</button>
      </div>
    </div>`);
  }

  // 名册里没有、但**此刻正在说话**的身份（2026-11-14 三次打磨）：
  // 这类设备以前整条都看不见——平板用主令牌直连、或者拿着已撤销凭据敲门，就是这种情况。
  const renderedIds = new Set();
  for (const row of connDeviceRows) {
    for (const id of [...row.pairIds, ...row.relayIds, ...row.revokedIds]) renderedIds.add(id);
  }
  const liveOnly = live.filter((entry) => !entry.id || !renderedIds.has(entry.id));
  // 来过、没登记、而且此刻也没在说话的那几枚，并进同一条渲染路（只是标 stale）：
  // 它们回答的是同一个问题——"这台设备到底来过没有"。
  const liveHints = new Set(live.map((entry) => entry.tokenHint).filter(Boolean));
  const stalePeers = unclaimed
    .filter((item) => item.tokenHint && !liveHints.has(item.tokenHint))
    .map((item) => ({
      ...item,
      id: null,
      name: null,
      kind: "unknown",
      revoked: false,
      stale: true,
      path: "",
      firstAt: item.firstAt,
      lastAt: item.lastAt,
    }));
  connLiveOnly = [...liveOnly, ...stalePeers];
  for (const entry of connLiveOnly) {
    const revoked = entry.revoked;
    const stale = Boolean(entry.stale);
    const label = entry.kind === "main" ? "未配对的设备" : entry.kind === "unknown" ? "未知凭据" : entry.name || "设备";
    // "现在在线"只在真的刚说话时才算（2026-11-14 五次打磨）：服务端 5 分钟剪一次过期，
    // 页面这边也得把秒数如实写出来，否则一条二十分钟前的记录读起来像"它就在你面前"。
    const ageText = stale
      ? `上次回话 ${ago(entry.lastAt)}（没登记，每个请求都被拒）`
      : entry.secondsAgo < 60
        ? "现在在线"
        : `${Math.floor(entry.secondsAgo / 60)} 分钟前回话`;
    const howText = TRANSPORT_LABEL[entry.transport] || "未知方式";
    const tip = stale
      ? "它来过这台电脑，但手里那枚凭据不是这里发的，所以一直被拒。现在它没在说话，行里的时间是它最后一次回话。认领后这枚凭据立刻生效，它再来就正常了。"
      : entry.kind === "main"
        ? "用主令牌直连的设备：它其实能用，只是没走扫码配对——所以这里只有连接方式，没有名字和 ID。让它扫一次上方的本地连接码，就能变成正常一行。"
        : revoked
          ? "它的凭据已经撤销，请求被拒；重新扫一次码就能回来。"
          : "它正连着这台电脑，但手里那枚凭据不是这里发的（别处配的 / 中继发的 / 旧库留下的），所以每个请求都被拒。认领 = 把这枚凭据登记成本机设备，立刻生效，不用重新扫码。";
    // 每一行都得有个能动手的地方（用户 2026-11-14 的原话：「为什么只有它这个有移除」）：
    // 认不出的凭据 → 认领；主令牌直连 → 去出码；别的（被拒的）→ 交给上面的「已移除」行。
    const action =
      entry.kind === "unknown" && entry.tokenHint
        ? `<button class="ghost" type="button" data-adopt="${esc(entry.tokenHint)}" data-name="${esc(label)}" data-tip="把这枚凭据登记成一台设备，给它起个名字。认领后它就正常了，也随时能移除。">认领</button>`
        : entry.kind === "main"
          ? `<button class="ghost" type="button" data-pair="1" data-tip="让它扫一次上方的本地连接码，换一枚自己的设备凭据——之后就不用把主令牌留在设备里了。">去配对</button>`
          : "";
    rows.push(`<div class="row">
      <div class="row-main">
        <div class="row-label" data-tip="${attr(tip)}"><i class="status-dot ${revoked ? "warn" : stale ? "idle" : "ok"}"></i>${esc(label)}<span class="conn-badge">${
          TRANSPORT_BADGE[entry.transport] || "本地连接"
        }</span>${revoked ? `<span class="conn-badge is-live">被拒</span>` : ""}${
          stale ? `<span class="conn-badge is-idle">没登记</span>` : ""
        }${entry.id ? `<span class="conn-id">${esc(shortIdOf(entry.id))}</span>` : ""}${
          entry.tokenHint ? `<span class="conn-id">#${esc(entry.tokenHint)}</span>` : ""
        }</div>
        <div class="row-hint">${howText} · ${esc(ageText)}</div>
      </div>
      ${action ? `<div class="row-control">${action}</div>` : ""}
    </div>`);
  }

  // 服务端还没升级时（老响应没有 live / unclaimed），退回原来 unpaired 的口径
  if (!live.length && !unclaimed.length) {
    for (const peer of unpaired) {
      rows.push(`<div class="row">
        <div class="row-main">
          <div class="row-label" data-tip="用主令牌直连的设备：还没扫码配对，所以这里只有连接方式，没有名字和 ID；扫码配对后才会变成正常一行。"><i class="status-dot warn"></i>未配对的设备<span class="conn-badge">${TRANSPORT_BADGE[peer.transport] || "本地连接"}</span></div>
          <div class="row-hint">${TRANSPORT_LABEL[peer.transport] || "未知方式"} · ${ago(peer.lastAt)}</div>
        </div>
      </div>`);
    }
  }

  if (!rows.length) {
    card.innerHTML = `<div class="row"><div class="row-main">
      <div class="row-label">还没有设备连进来</div>
      <div class="row-hint">上面「本地连接」扫一次码，或「远程连接」点「添加手机」加一台</div>
    </div></div>`;
    return;
  }

  // 名册抬头（2026-11-14 二次打磨）删掉了：解释性的整句已经进每行的悬浮块，
  // 页面只留「名字 + 标签 + 数据」。
  card.innerHTML = rows.join('<div class="divider"></div>');
  for (const button of card.querySelectorAll("[data-remove]")) {
    button.addEventListener("click", () => void removeDeviceRow(button.dataset.remove, button));
  }
  // 已撤销残壳的「删除记录」（2026-11-14 五次打磨）：以前这种行只有一个标签，没有出口。
  for (const button of card.querySelectorAll("[data-purge]")) {
    button.addEventListener("click", () => void purgeDeviceRow(button.dataset.purge, button));
  }
  // 名册外、正连着的凭据的「认领」：不做这一步，用户永远只能看着一行"未知凭据"。
  for (const button of card.querySelectorAll("[data-adopt]")) {
    button.addEventListener("click", () => void adoptPeer(button.dataset.adopt || "", button));
  }
  // 用主令牌直连的设备：唯一正经出路是让它扫码。点了就把上面那张本地连接卡的码换新并滚到眼前。
  for (const button of card.querySelectorAll("[data-pair]")) {
    button.addEventListener("click", () => {
      document.getElementById("pair-refresh")?.click();
      document.getElementById("pair-qr")?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }
}

/** 移除一行（2026-11-14）：配对侧与中继侧都真撤销——"藏起来"会让凭据还活着。 */
async function removeDeviceRow(key, button) {
  const row = connDeviceRows.find((item) => item.key === key);
  if (!row) return;
  const ok = await openConfirm({
    title: "移除设备",
    message: `移除「${row.name}」？`,
    detail: row.relayIds.length && row.pairIds.length
      ? "这台设备在本地配对和中继名册里都有记录，两边会一起撤销。它再连会被拒绝，要恢复得重新扫码。"
      : row.revokedIds.length
        ? "它名下还有旧凭据（已撤销）会被一并清理；它再连会被拒绝，要恢复得重新扫码。"
        : "它的凭据会作废，再连会被拒绝；要恢复得重新扫码。",
    confirmText: "移除",
    danger: true,
  });
  if (!ok) return;
  button.disabled = true;
  const failures = [];
  // 旧凭据（已撤销的）也一起走一遍：接口是幂等的，顺手把它们从名册里彻底清干净
  for (const id of [...row.pairIds, ...row.revokedIds]) {
    const response = await request(`/api/v1/pair/devices/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
    }).catch(() => null);
    if (!response || !response.ok) failures.push("本地");
  }
  for (const id of row.relayIds) {
    const response = await request(`/api/v1/relay/devices/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
    }).catch(() => null);
    if (!response || !response.ok) failures.push("中继");
  }
  if (failures.length) showAlert("移除没完全成功", `${failures.join(" / ")} 侧撤销失败，稍后再试`);
  else toast(`已移除 ${row.name}`);
  void loadDevices();
}
/**
 * 删掉一条已撤销的设备记录（2026-11-14 五次打磨）。
 *
 * 和「移除」的区别要说清：移除 = 撤销（凭据作废、记录留着），删除 = 连这条记录一起抹掉。
 * 只对已撤销的行给这颗按钮（服务端也拦着：活动设备删除会 409 `still_active`）。
 */
async function purgeDeviceRow(key, button) {
  const row = connDeviceRows.find((item) => item.key === key);
  if (!row) return;
  const ok = await openConfirm({
    title: "删除记录",
    message: `把「${row.name}」这条已撤销的记录从名册里删掉？`,
    detail: "只删这条残壳，凭据早就作废了，不影响任何还在用的设备。它若再连过来，会以「未知凭据」重新出现。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  button.disabled = true;
  const failures = [];
  for (const id of row.revokedIds) {
    const response = await request(`/api/v1/pair/devices/${encodeURIComponent(id)}/delete`, {
      method: "POST",
    }).catch(() => null);
    if (!response || !response.ok) failures.push("本地");
  }
  if (failures.length) showAlert("删除没成功", `${failures.join(" / ")}侧删除失败，稍后再试`);
  else toast(`已删除 ${row.name} 的记录`);
  void loadDevices();
}

/**
 * 认领一枚正连着、但本机没登记的凭据（2026-11-14 五次打磨）。
 *
 * 用户的原话是"这个连接的设备找不到平板"：它确实连着，只是手里那枚令牌不是这台机器发的，
 * 所以每个请求都 403、页面上只剩一行「未知凭据」。认领把它的哈希登记成设备——不用重扫码。
 * 服务端只认 5 分钟内的活口，且只许本机页面调，过期就 404 `peer_gone`。
 */
async function adoptPeer(tokenHint, button) {
  const name = await openConfirm({
    title: "认领这台设备",
    message: "它正连着这台电脑，但手里那枚凭据不是这里发的——所以请求一直被拒。",
    detail: "认领 = 把这枚凭据登记成本机设备，立刻生效、不用重新扫码；之后它像别的设备一样，随时能移除。",
    confirmText: "认领",
    input: { label: "给它起个名字", value: "平板", placeholder: "例如：平板 / 备用机", maxLength: 40 },
  });
  if (!name) return;
  button.disabled = true;
  const response = await request("/api/v1/pair/devices/adopt", {
    method: "POST",
    body: JSON.stringify({ tokenHint, name }),
  }).catch(() => null);
  if (!response || !response.ok) {
    const error = response ? (await response.json().catch(() => null))?.error : null;
    showAlert(
      "认领没成功",
      error === "peer_gone"
        ? "它这会儿已经不连了（活口只保留 5 分钟）。等它再发一次请求，再点一次认领。"
        : error === "duplicate"
          ? "这枚凭据已经登记过了，刷新一下列表就能看到它。"
          : "服务端没接受这次认领，稍后再试。",
    );
    button.disabled = false;
    return;
  }
  toast(`已认领「${name}」`);
  void loadDevices();
}

let connPhoneCount = null;
/** 星形拓扑要用的同一份事实（2026-11-14）：由本模块算好，连接页直接画 */
let connDeviceRows = [];
/** 名册外、但此刻真在说话的身份（未配对的直连 / 认不出的凭据）：星形也要把它们画出来 */
let connLiveOnly = [];

export { APPROVAL_POP_MAX, APPROVAL_POP_POLL_MS, APPROVAL_POP_X, ago, answerGlobalQuestion, approvalPopDismissed, approvalPopHost, approvalPopItems, approvalPopKnown, approvalPopRemainText, approvalPopTicker, approvalPopTimer, approvalPopVisible, approvalPopupCard, askUserPopupCard, connDeviceRows, connLiveOnly, connPhoneCount, decideGlobalApproval, loadDevices, refreshApprovalPopups, renderApprovalPopups, startApprovalPopWatch, syncApprovalPopTicker };
