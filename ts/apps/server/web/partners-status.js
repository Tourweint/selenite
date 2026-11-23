/**
 * 执事状态点 / 忙因胶囊 / 头像同步（含花名册领域缓存）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { approvalPopItems, approvalPopKnown } from "./approval-pop.js";
import { paintAvatar, partnerDotClass } from "./avatar.js";
import { openChat, startNewChat, syncTitleSessionAffordance } from "./chat-open.js";
import { el } from "./dom.js";
import { CS_ICONS } from "./icons.js";
import { request } from "./net.js";
import { renderRoster } from "./partner-roster.js";
import { partnerIdOfConversation, parsePartnerExternalId } from "./partner-sessions.js";
import { ensureSideSessionsFlag, openPartnerSessions } from "./partner-sessions-ui.js";
import { currentRoute, go } from "./route.js";
import { csResolveTarget, csSvg } from "./settings-drawer.js";
import { state } from "./state.js";

/* ── 忙因胶囊（2026-11-10 批 18 §二）────────────────────────
 * 优先级：等审批 > 跑任务 > 等回答 > 空闲。
 * 数据只用现成两路：`/api/v1/partners`（status / domain）+ `/api/v1/domains`（activeTickets）
 * + 全局待办 `/api/v1/agent/approvals`（不带 conversationId，快照在 refreshApprovalPopups 里刷）。
 * 拿不到待办快照时**不猜**「不在等审批」，降级成只分忙/空闲（七原则⑤诚实状态）。
 */

/** 某执事挂着的待办条数（canonical / side / 群成员轮都算到这个执事头上） */
function partnerPendingCounts(partnerId) {
  let approvals = 0;
  let questions = 0;
  for (const item of approvalPopItems) {
    // 用解析器取真正的 partnerId：canonical / side / group 都算到该执事头上。
    // 不能用 partnerIdOfConversation —— 它对 group 返回 ""（那是专线选中态的口径）。
    const owner = parsePartnerExternalId(item?.conversationId)?.partnerId || "";
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

/** 总管条目的「选择会话」按钮（2026-11-17 批2）：插件关时整枚不挂，开时点它不开主会话。 */
function syncChiefSessionsButton() {
  if (!el.chiefEntry) return;
  let btn = el.chiefEntry.querySelector(".chief-sessions");
  if (!state.sideSessionsEnabled) {
    if (btn) btn.remove();
    return;
  }
  if (btn) return;
  btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chief-sessions";
  btn.setAttribute("aria-label", "选择会话");
  btn.title = "选择会话";
  btn.append(csSvg(CS_ICONS.layers));
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    openPartnerSessions("chief");
  });
  btn.addEventListener("keydown", (event) => event.stopPropagation());
  el.chiefEntry.append(btn);
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
 * 普通 worker 会话的固定称呼（2026-11-16）。
 *
 * 这一档此前没有名字：work 走常量 WORKER_PERSONA，不在 partners 表里，没有 name 也没有
 * 头像，界面只能落到「普通对话」这个种类词。空态要写「在跟 X 说话」，就必须先有个 X。
 * 只改这一行就换名字；若以后要让它像执事一样可改（进 partners 表），那属于存储结构改动。
 */
const WORKER_DISPLAY_NAME = "助手";

/**
 * 「这一屏在跟谁说话」——只回答身份，不回答会话名。
 *
 * 会话名在 #title，会随首句自动变（composer-send.js 第一轮写首句前 40 字），
 * 首页态那条顶栏还是 display:none，所以空态要自己算一份身份。
 * partner- 前缀当场就能定（执事专线），worker / chief 看回读来的 state.chatKind
 * ——缺字段的老会话按 chief，与 openChat 的口径一致。
 */
function chatIdentityName() {
  const partnerId = partnerIdOfConversation(state.conversationId);
  if (partnerId) return partnerDisplayName(partnerId);
  if ((state.chatKind || "chief") === "worker") return WORKER_DISPLAY_NAME;
  return chiefDisplayName();
}

/**
 * 空态起首那枚图标画谁（2026-11-16 四版）：有脸画脸，没脸画水晶。
 *
 * 名字写在句子里试过三版都被否（小字标签 / 「我是 X。」/ 「名字 · 话」），
 * 用户的判断是「图片比较直观」——把人直接放在图标上，比在句子里加一个词更快。
 * worker 不是某个人（不在 partners 表、没有头像），返回 null，回落成项目水晶。
 */
function chatIdentityFace() {
  const partnerId = partnerIdOfConversation(state.conversationId);
  if (partnerId) {
    const partner = state.partners.find((item) => item.id === partnerId);
    return { avatar: String(partner?.avatar || ""), name: partnerDisplayName(partnerId) };
  }
  if ((state.chatKind || "chief") === "worker") return null;
  const chief = state.partners.find((item) => item.id === "chief");
  return { avatar: String(chief?.avatar || ""), name: chiefDisplayName() };
}

const CRYSTAL_MARK_SRC = "/assets/crystal-mark.png";

/**
 * 把空态左首那枚图标换成当前身份的头像（2026-11-16 四版）。
 *
 * 传 null = 强制回水晶：clearThread 里先重置，免得切会话时还挂着上一个人的脸。
 * 头像晚到（花名册比会话慢）由 loadRoster 末尾补一次，不靠首帧。
 */
function syncEmptyMark(face = chatIdentityFace()) {
  const host = el.emptyMark;
  if (!host) return;
  const avatar = String(face?.avatar || "");
  const img = document.createElement("img");
  img.decoding = "async";
  img.alt = "";
  if (avatar) {
    img.src = avatar;
    host.dataset.kind = "face";
    if (face?.name) host.setAttribute("aria-label", `在跟 ${face.name} 说话`);
    else host.removeAttribute("aria-label");
  } else {
    img.src = CRYSTAL_MARK_SRC;
    img.setAttribute("aria-hidden", "true");
    host.dataset.kind = "mark";
    host.removeAttribute("aria-label");
  }
  host.replaceChildren(img);
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
  // 2026-11-17 修真 bug：原实现 .reverse() 再取 [0]，实际打开的是**最旧**一条。
  // state.chats 已是服务端 lastAt 倒序；这里按「置顶优先，其次 lastAt 最新」明确取第一条。
  const ordered = state.chats
    .filter((chat) => !String(chat.conversationId || "").startsWith("partner-"))
    .filter((chat) => (chat.chatKind || "chief") === "chief")
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        Number(b.lastAt) - Number(a.lastAt),
    );
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
  // 副会话入口开关：花名册首次加载取一次（缓存进 state.flagsCache），失败按关处理。
  state.sideSessionsEnabled = await ensureSideSessionsFlag();
  // 开关晚到：openChat 可能先于花名册跑完，这里补一次顶栏可点态。
  const identityNow = parsePartnerExternalId(state.conversationId);
  syncTitleSessionAffordance(
    identityNow && (identityNow.role === "canonical" || identityNow.role === "side")
      ? identityNow.partnerId
      : "",
  );
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
  syncChiefSessionsButton();
  syncPartnerDots();
  // 名册晚于会话加载时，把执事表头补成名字（canonical 与 side 都要）：
  // side 的首帧可能先用占位「执事」拼了「执事 · 标题」，这里用标题尾巴重建。
  const identity = parsePartnerExternalId(state.conversationId);
  if (identity && currentRoute() === "chat") {
    if (identity.role === "canonical") {
      el.title.textContent = partnerDisplayName(identity.partnerId);
    } else if (identity.role === "side") {
      const known = state.chats.find(
        (chat) => chat.conversationId === state.conversationId,
      )?.title;
      const tail = known || el.title.textContent.split(" · ").slice(1).join(" · ") || "新会话";
      el.title.textContent = `${partnerDisplayName(identity.partnerId)} · ${tail}`;
    }
    syncTitleSessionAffordance(identity.partnerId);
  }
  // 总管的名字也可能在人设里改过：总管会话的表头跟着名册一起刷新（2026-11-13）
  if (
    currentRoute() === "chat" &&
    !state.conversationId.startsWith("partner-") &&
    // 任务线程（2026-11-22）：服务端 chatKind 仍是 chief，但表头归任务自己，
    // 由 chat-open 的 task- 分支写；这里再写一次会把「任务 · …」冲成「总管」。
    !state.conversationId.startsWith("task-") &&
    (state.chatKind || "chief") === "chief"
  ) {
    el.title.textContent = chiefDisplayName();
  }
  // 头像与名字同一批到位（2026-11-13）：名册首帧晚到时补脸，改完头像重拉也在这里刷新
  if (currentRoute() === "chat") syncChatHeadAvatar();
  // 空态那枚图标同理（2026-11-16）：首屏先画了水晶，头像这会儿才到，补一次
  if (currentRoute() === "chat") syncEmptyMark();
}

/* 最近一次花名册的领域行与在办单数：忙因胶囊就地重算、执事悬停卡现渲都用这份；
   拆成多模块后 loadRoster 与 renderRoster 分别写一个字段，故收进对象。 */
const rosterDomain = { active: new Map(), rows: [] };

export { chiefDisplayName, chatIdentityFace, chatIdentityName, loadRoster, openChiefChat, paintBusyChip, partnerBusyOf, partnerDisplayName, partnerPendingCounts, rosterDomain, syncChatHeadAvatar, syncChiefAvatar, syncChiefDot, syncChiefSessionsButton, syncEmptyMark, syncPartnerDots, syncRosterBusy, WORKER_DISPLAY_NAME };
