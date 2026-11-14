/**
 * 群组可用性 / 侧栏行 / 状态胶囊
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { parseGroupMemberConversation } from "./approval-card.js";
import { paintAvatar } from "./avatar.js";
import { el } from "./dom.js";
import { groupMemberAvatarOf } from "./groups-thread.js";
import { request } from "./net.js";
import { currentRoute, groupRouteId } from "./route.js";


/* ── 群组（2026-11-06 群组方案批二）────────────────────────
 * #/groups 列表 + #/group/:id 会话视图；时间线四形态 + @picker + 建群/群设置。
 * 数据面：GET /groups、GET /groups/:id/messages、POST /groups/:id/chat（SSE）、
 * POST /groups/:id/stop。发言顺序服务端定（@点名 > @所有人 > 值日），前端只渲染。
 * 端点未启用（404）= 按钮回占位态，一切入口保持禁用。 */

const groups = {
  available: null, // null = 还没探测过
  list: [],
  current: null, // 当前打开的群（含 members / 成员头像与领域）
  messages: [],
  lastSeq: 0,
  sending: false,
  streamSender: null, // 正在流式的那位（start 帧的 sender）
  streamBubble: null, // 正在流式的气泡 DOM
  streamText: "",
  picked: [], // 建群弹窗里勾中的成员 id（弹窗期间的状态）
  // 时间线渲染游标（2026-11-08 批三）：回读与实时追加共用，合并/日界都看它
  lastMeta: null, // { key, day, at }
  round: null, // 群详情投影的轮次状态 { running, speaker }
  pending: [], // 全局待审批（映射到本群成员用）
  pulseTimer: 0,
};

/** 探测群组可用性 + 侧栏「群组」节首帧。404 = 未启用，一切入口回占位。 */
async function initGroups() {
  try {
    const response = await request("/api/v1/groups", { cache: "no-store" });
    if (!response.ok) {
      groups.available = false;
    } else {
      const data = await response.json().catch(() => ({}));
      groups.available = true;
      groups.list = Array.isArray(data.groups) ? data.groups : [];
    }
  } catch {
    groups.available = false;
  }
  applyGroupsAvailability();
  renderGroupSidebar();
}

function applyGroupsAvailability() {
  const on = groups.available === true;
  // 侧栏「群组」分区（2026-11-07 统一批）：折叠头 + 行尾 ⋯（2026-11-14 由 ＋ 改）是两个独立按钮，
  // 旧的一体式 #side-group 已从 HTML 移除（折叠箭头随四改一并退役）。
  // 入口一起跟可用性走：轨道圆钮（悬停/点开悬停卡，2026-11-13）/ 分区名（进群组页）/
  // 行尾 ⋯（菜单里建群）/ 分区底部的「所有群聊」。
  // 2026-11-14 用户口径：分区头、⋯、底部文字入口都不再挂浮签——文字已经自解释。
  for (const button of [el.secGroupsToggle, el.secGroupsMore, el.secGroupsAll]) {
    if (!button) continue;
    button.disabled = !on;
  }
  if (el.railGroups) el.railGroups.disabled = !on;
  if (el.groupList) el.groupList.hidden = !on;
  if (el.groupCreate) el.groupCreate.hidden = !on;
  // 「所有群聊」这一行跟整节可用性走：群组没启用时它和折叠头一起灰掉，
  // 不留一条点进去必然空页的入口。
  if (el.secGroupsAll) el.secGroupsAll.hidden = !on;
}

/** 群成员头像：成员投影自带 avatar 就用它（2026-11-08 批三），老服务端回落到花名册缓存 */
function groupMemberAvatar(member) {
  if (!member) return null;
  return member.avatar || groupMemberAvatarOf(member.partnerId);
}

/**
 * 复合头像（2026-11-08 批三）：群不是一个人，头像就用成员头像拼。
 * 1 人直出（直接用其头像/首字）；2–4 人 2×2；>4 人取前 3 + 右下角 +N。
 * host 保留 .pt-avatar（圆形容器），.gavatar 只覆盖内部布局；不复用首字逻辑。
 */
function paintGroupAvatar(host, members) {
  if (!host) return;
  const all = (Array.isArray(members) ? members : []).filter(Boolean);
  host.replaceChildren();
  host.classList.remove("gavatar", "gavatar-n2", "gavatar-n3", "gavatar-n4");
  if (!all.length) {
    host.textContent = "群";
    return;
  }
  if (all.length === 1) {
    paintAvatar(host, groupMemberAvatar(all[0]), all[0].name);
    return;
  }
  const shown = all.length > 4 ? all.slice(0, 3) : all;
  const cells = shown.length + (all.length > 4 ? 1 : 0);
  host.textContent = "";
  host.classList.add("gavatar", `gavatar-n${cells}`);
  for (const member of shown) {
    const cell = document.createElement("span");
    cell.className = "gavatar-cell";
    paintAvatar(cell, groupMemberAvatar(member), member.name);
    host.append(cell);
  }
  if (all.length > 4) {
    const more = document.createElement("span");
    more.className = "gavatar-cell gavatar-more";
    more.textContent = `+${all.length - 3}`;
    host.append(more);
  }
}

/** 侧栏「群组」节：群名 + 成员数；点击进会话视图。
 *  行清单抽成 renderGroupRows：收起轨道的群组悬停卡（2026-11-13）渲同一份。 */
function renderGroupSidebar() {
  if (!el.groupList || groups.available !== true) return;
  renderGroupRows(el.groupList, "还没有群组。点分区右边的 ⋯ → 新建群组。");
}

function renderGroupRows(box, emptyText) {
  box.replaceChildren();
  if (!groups.list.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = emptyText;
    box.append(empty);
    return;
  }
  for (const group of groups.list) {
    const row = document.createElement("div");
    row.className = "side-item group-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.dataset.groupId = group.id;
    // 「你在这里」：正开着这个群（2026-11-13 选中态批；折叠卡与展开侧栏共用）
    if (currentRoute() === "group" && groupRouteId() === group.id) {
      row.setAttribute("aria-current", "true");
    }

    const avatar = document.createElement("span");
    avatar.className = "pt-avatar";
    avatar.setAttribute("aria-hidden", "true");
    paintGroupAvatar(avatar, group.members);

    const label = document.createElement("span");
    label.className = "roster-name";
    label.textContent = group.name;

    const count = document.createElement("span");
    count.className = "roster-idle";
    count.textContent = `${group.members.length}人`;

    row.append(avatar, label, count);
    const open = () => {
      location.hash = `#/group/${group.id}`;
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    box.append(row);
  }
}

/* ── 状态胶囊（2026-11-08 批三）：谁在忙 / 谁等审批 ────────
 * 数据全部来自既有端点：群详情（round）+ 全局待审批（conversationId 映射到成员）。
 * 轮询节奏跟群会话对齐（5s）——只有群会话打开时跑，离开就停。
 * 映射不来的一律不画：查不到成员/群的审批不写进胶囊，不拿名字猜。 */

const GROUP_PULSE_MS = 5000;

function startGroupPulse() {
  stopGroupPulse();
  groups.pulseTimer = setInterval(() => void refreshGroupPulse(), GROUP_PULSE_MS);
}

function stopGroupPulse() {
  if (!groups.pulseTimer) return;
  clearInterval(groups.pulseTimer);
  groups.pulseTimer = 0;
}

async function refreshGroupPulse() {
  const group = groups.current;
  const id = groupRouteId();
  if (!group || currentRoute() !== "group" || id !== group.id) {
    stopGroupPulse();
    return;
  }
  const [detail, pending] = await Promise.all([
    request(`/api/v1/groups/${encodeURIComponent(group.id)}`, { cache: "no-store" }).catch(() => null),
    request("/api/v1/agent/approvals", { cache: "no-store" }).catch(() => null),
  ]);
  // 请求期间切了群 / 离开了群路由：旧响应不许画到新群上
  if (!groups.current || groups.current.id !== group.id || groupRouteId() !== group.id) return;
  if (detail?.ok) {
    const data = await detail.json().catch(() => ({}));
    if (data.group) groups.round = data.group.round ?? null;
  }
  if (pending) {
    if (pending.ok) {
      const data = await pending.json().catch(() => ({}));
      if (Array.isArray(data.approvals)) groups.pending = data.approvals;
    } else {
      // 服务端明确拒绝（503 未配置模型 / 403）：待批清单不可信，宁可空着也不留旧的
      groups.pending = [];
    }
  }
  renderGroupPulse();
}

/** 本群成员里有哪些人挂着待批（按会话 id 反查；不是本群的一律忽略） */
function groupPendingMembers() {
  const group = groups.current;
  if (!group) return [];
  const waiting = new Set();
  for (const item of groups.pending) {
    const ref = parseGroupMemberConversation(item?.conversationId);
    if (ref && ref.groupId === group.id) waiting.add(ref.partnerId);
  }
  return group.members.filter((member) => waiting.has(member.partnerId));
}

function renderGroupPulse() {
  if (!el.groupPulse) return;
  const group = groups.current;
  if (!group) {
    el.groupPulse.hidden = true;
    el.groupPulse.replaceChildren();
    return;
  }
  const chips = [];
  const round = groups.round;
  if (round?.running) {
    chips.push({
      kind: "busy",
      text: round.speaker?.name ? `${round.speaker.name} 正在发言` : "群轮进行中",
      title: "这一轮还没跑完，发消息会被拒（可点停止）",
    });
  } else if (groups.sending) {
    chips.push({
      kind: "busy",
      text: groups.streamSender?.name ? `${groups.streamSender.name} 正在发言` : "正在回话",
      title: "这一轮还没跑完",
    });
  }
  for (const member of groupPendingMembers()) {
    chips.push({
      kind: "wait",
      text: `${member.name} 等审批`,
      title: `${member.name} 有个写操作在等确认（去设置 → 权限，或等这轮超时）`,
    });
  }
  el.groupPulse.replaceChildren();
  if (!chips.length) {
    el.groupPulse.hidden = true;
    return;
  }
  for (const chip of chips) {
    const node = document.createElement("span");
    node.className = `group-pulse-chip is-${chip.kind}`;
    node.textContent = chip.text;
    if (chip.title) node.title = chip.title;
    el.groupPulse.append(node);
  }
  el.groupPulse.hidden = false;
}

export { GROUP_PULSE_MS, applyGroupsAvailability, groupMemberAvatar, groupPendingMembers, groups, initGroups, paintGroupAvatar, refreshGroupPulse, renderGroupPulse, renderGroupRows, renderGroupSidebar, startGroupPulse, stopGroupPulse };
