/**
 * 执事状态点 / 忙因胶囊 / 头像同步（含花名册领域缓存）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { parseGroupMemberConversation } from "./approval-card.js";
import { approvalPopItems, approvalPopKnown } from "./approval-pop.js";
import { paintAvatar, partnerDotClass } from "./avatar.js";
import { openChat, startNewChat } from "./chat-open.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { renderRoster } from "./partner-roster.js";
import { currentRoute, go } from "./route.js";
import { csResolveTarget } from "./settings-drawer.js";
import { state } from "./state.js";

/* ── 忙因胶囊（2026-11-10 批 18 §二）────────────────────────
 * 优先级：等审批 > 跑任务 > 等回答 > 空闲。
 * 数据只用现成两路：`/api/v1/partners`（status / domain）+ `/api/v1/domains`（activeTickets）
 * + 全局待办 `/api/v1/agent/approvals`（不带 conversationId，快照在 refreshApprovalPopups 里刷）。
 * 拿不到待办快照时**不猜**「不在等审批」，降级成只分忙/空闲（七原则⑤诚实状态）。
 */

/** 某执事挂着的待办条数（主会话 `partner-<id>` 与群成员轮 `partner-<id>-group-<g>` 都算） */
function partnerPendingCounts(partnerId) {
  let approvals = 0;
  let questions = 0;
  const self = `partner-${partnerId}`;
  for (const item of approvalPopItems) {
    const conversationId = String(item?.conversationId || "");
    const owner =
      conversationId === self
        ? partnerId
        : (parseGroupMemberConversation(conversationId)?.partnerId || "");
    if (owner !== partnerId) continue;
    if (item.kind === "ask_user" || item.tool === "ask_user") questions += 1;
    else approvals += 1;
  }
  return { approvals, questions };
}

/** 忙因胶囊内容；空闲返回 null（不占地方，七原则⑥） */
function partnerBusyOf(partner, activeTickets) {
  const active = Number(activeTickets) || 0;
  if (!approvalPopKnown) {
    return active > 0 ? { label: "忙", kind: "work", title: "有在办的任务单" } : null;
  }
  const { approvals, questions } = partnerPendingCounts(String(partner.id || ""));
  if (approvals > 0) {
    return {
      label: "等审批",
      kind: "wait",
      title: `${approvals} 个写操作在等确认（去浮窗或设置 → 权限处理）`,
    };
  }
  if (active > 0) {
    return { label: "跑任务", kind: "work", title: `有 ${active} 张任务单没结束` };
  }
  if (questions > 0) {
    return {
      label: "等回答",
      kind: "ask",
      title: `${questions} 个问题在等你回答`,
    };
  }
  return null;
}

function paintBusyChip(node, busy) {
  if (!node) return;
  if (!busy) {
    node.hidden = true;
    node.textContent = "";
    node.removeAttribute("data-kind");
    node.removeAttribute("title");
    return;
  }
  node.hidden = false;
  node.dataset.kind = busy.kind;
  node.textContent = busy.label;
  node.title = busy.title;
}

/** 待办快照变了就地改胶囊，不重绘整份花名册（不打断 hover / 焦点） */
function syncRosterBusy() {
  for (const row of document.querySelectorAll("#partner-roster [data-partner-id]")) {
    const partner = state.partners.find((item) => item.id === row.dataset.partnerId);
    if (!partner) continue;
    const domain = String(partner.domain || "").trim();
    const active = domain ? rosterDomain.active.get(domain) || 0 : 0;
    const busy = partnerBusyOf(partner, active);
    paintBusyChip(row.querySelector(".roster-busy"), busy);
    // 「空闲」与忙因互斥：只在没有任务单、也没胶囊时露出来
    const idle = row.querySelector(".roster-idle");
    if (idle && !row.querySelector(".roster-count")) idle.hidden = Boolean(busy);
  }
}

function syncChiefDot() {
  if (!el.chiefDot) return;
  el.chiefDot.className = `status-dot ${partnerDotClass(state.chiefStatus || "active")}`;
}

/** 服务状态变化时就地改点，不重绘整份花名册（不打断 hover / 焦点） */
function syncPartnerDots() {
  syncChiefDot();
  for (const row of document.querySelectorAll("#partner-roster [data-partner-id]")) {
    const partner = state.partners.find((item) => item.id === row.dataset.partnerId);
    const dot = row.querySelector(".status-dot");
    if (partner && dot) dot.className = `status-dot ${partnerDotClass(partner.status)}`;
  }
  for (const dot of document.querySelectorAll("[data-pt-dot]")) {
    const partner = state.partners.find((item) => item.id === dot.dataset.ptDot);
    if (partner) dot.className = `status-dot ${partnerDotClass(partner.status)}`;
  }
}

/** 总管头像 / 名字 / 状态同步到展开条目与收起轨道（2026-11-13：只画，不再挂编辑语义） */
function syncChiefAvatar() {
  const chief = state.partners.find((item) => item.id === "chief");
  const name = String(chief?.name || "总管").trim() || "总管";
  state.chiefStatus = chief?.status || "active";
  const avatar = chief?.avatar || null;
  if (el.chiefAvatar) {
    paintAvatar(el.chiefAvatar, avatar, name);
    el.chiefAvatar.removeAttribute("aria-label");
    el.chiefAvatar.removeAttribute("title");
  }
  const railSlot = el.railChief?.querySelector(".pt-avatar");
  if (railSlot) paintAvatar(railSlot, avatar, name);
  syncChiefDot();
}

/** 总管在界面上的名字（用户可能给人设改过名，缺省「总管」） */
function chiefDisplayName() {
  const chief = state.partners.find((item) => item.id === "chief");
  return String(chief?.name || "总管").trim() || "总管";
}

/** 执事会话表头用名字，不叫“新对话” */
function partnerDisplayName(partnerId) {
  const partner = state.partners.find((item) => item.id === partnerId);
  return String(partner?.name || "执事").trim() || "执事";
}

/**
 * 对话顶栏「跟谁在说话」（2026-11-13）：执事专线摆该执事的头像，名字仍在 #title。
 *
 * 口径：头像只属于「某个人」。总管不退化成一张脸——他的名字在这条会话里就是会话自己的
 * 标题；普通 worker 会话也没有角色。两者都不摆头像，整块收起，标题照旧顶在最左。
 * 离屏头像与花名册共用同一份 state.partners，花名册晚到 / 重拉（改头像）时由 loadRoster 补同步。
 */
function syncChatHeadAvatar() {
  const host = el.chatHeadAvatar;
  if (!host) return;
  const target = csResolveTarget();
  const partner =
    target && target !== "chief" ? state.partners.find((item) => item.id === target) : null;
  if (!partner) {
    host.hidden = true;
    host.replaceChildren();
    host.removeAttribute("title");
    delete host.dataset.partnerId;
    return;
  }
  const name = partnerDisplayName(target);
  paintAvatar(host, partner.avatar || null, name);
  host.hidden = false;
  host.title = name;
  host.dataset.partnerId = target;
}

/**
 * 总管固定条目 = 打开总管主对话。
 * 实现取方案 A 的 a：总管条目点击 = 打开最近一条「总管」会话，没有就新开一轮。
 * 行为不变：仍走既有 go("chat") + openChat / startNewChat 流程，历史列表仍能恢复。
 * 这里排除 partner-* 的执事 canonical 会话，避免把执事会话当成总管主对话。
 */
function openChiefChat() {
  // 只认 chatKind=chief 的历史（缺字段的旧会话按 chief，保住老数据）；
  // 不靠 partner- 前缀之外的东西猜身份。没有就新开一条总管会话。
  const ordered = state.chats
    .filter((chat) => !String(chat.conversationId || "").startsWith("partner-"))
    .filter((chat) => (chat.chatKind || "chief") === "chief")
    .reverse()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const recent = ordered[0];
  go("chat");
  if (recent) void openChat(recent.conversationId);
  else startNewChat("chief");
}

el.chiefEntry.addEventListener("click", openChiefChat);
el.chiefEntry.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openChiefChat();
  }
});

// 2026-11-13：总管头像不再是编辑入口——侧栏只负责「打开会话」，
// 改头像 / 改名字去右侧对话设置的人设页或设置→执事（用户报「侧栏里能改，跟设置里重复」）。

/* 执事花名册：GET /api/v1/partners（过滤 chief + archived）
   + GET /api/v1/domains（domain → activeTickets）。两个端点各自容错，
   一个读不到不拖累另一个；403 交给令牌门，不把花名册刷成空。 */
async function loadRoster() {
  const box = el.partnerRoster;
  if (!box) return;
  let partners = null;
  let domains = [];
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (response.ok) partners = (await response.json().catch(() => ({}))).partners || [];
  } catch (error) {
    if (error.message === "forbidden") return;
  }
  try {
    const response = await request("/api/v1/domains", { cache: "no-store" });
    if (response.ok) domains = (await response.json().catch(() => ({}))).domains || [];
  } catch (error) {
    if (error.message === "forbidden") return;
  }
  // 拉失败保留上一次的档案（头像 / 名字不闪没）
  if (Array.isArray(partners)) state.partners = partners;
  // 最近一份领域在办单：收起轨道的执事悬停卡开卡时用同一份现渲（2026-11-13）
  if (Array.isArray(domains)) rosterDomain.rows = domains;
  renderRoster(
    Array.isArray(partners) ? partners : state.partners,
    Array.isArray(domains) ? domains : [],
  );
  syncChiefAvatar();
  syncPartnerDots();
  // 名册晚于会话加载时，把执事专线的表头补成名字（之前只有占位「执事」）
  if (state.conversationId.startsWith("partner-") && currentRoute() === "chat") {
    el.title.textContent = partnerDisplayName(state.conversationId.slice("partner-".length));
  }
  // 总管的名字也可能在人设里改过：总管会话的表头跟着名册一起刷新（2026-11-13）
  if (
    currentRoute() === "chat" &&
    !state.conversationId.startsWith("partner-") &&
    (state.chatKind || "chief") === "chief"
  ) {
    el.title.textContent = chiefDisplayName();
  }
  // 头像与名字同一批到位（2026-11-13）：名册首帧晚到时补脸，改完头像重拉也在这里刷新
  if (currentRoute() === "chat") syncChatHeadAvatar();
}

/* 最近一次花名册的领域行与在办单数：忙因胶囊就地重算、执事悬停卡现渲都用这份；
   拆成多模块后 loadRoster 与 renderRoster 分别写一个字段，故收进对象。 */
const rosterDomain = { active: new Map(), rows: [] };

export { chiefDisplayName, loadRoster, openChiefChat, paintBusyChip, partnerBusyOf, partnerDisplayName, partnerPendingCounts, rosterDomain, syncChatHeadAvatar, syncChiefAvatar, syncChiefDot, syncPartnerDots, syncRosterBusy };
