/**
 * 群聊时间线：四形态
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar } from "./avatar.js";
import { el } from "./dom.js";
import { groupMemberAvatar, groups } from "./groups-base.js";
import { clearGroupAtHint, resizeGroupInput, scrollGroupThread, updateGroupSendState } from "./groups-composer.js";
import { state } from "./state.js";
import { toast } from "./ui-atoms.js";


/* ── 时间线渲染：四形态 ──────────────────────────────────
 * 主人右对齐气泡 / 成员左对齐（头像+名字+时间）/ 系统行居中发丝线 /
 * 5 分钟内同作者合并（名字行只画一次）+ 跨天分割线。 */

const GROUP_MERGE_MS = 5 * 60 * 1000;
/** 成员数上下限：与 shared 的 GROUP_MEMBER_MIN/MAX 同值（web 端无构建，不 import 包） */
const GROUP_MEMBER_MIN = 2;
const GROUP_MEMBER_MAX = 6;


function renderGroupTimeline() {
  el.groupThread.replaceChildren();
  groups.lastMeta = null;
  for (const message of groups.messages) appendGroupMessageToThread(message);
  scrollGroupThread();
}

function groupAuthorKey(message) {
  return message.kind === "system" ? `system:${message.id}` : `${message.authorKind}:${message.authorId ?? message.authorName}`;
}

/**
 * 本地日历日（通用，2026-11-13 从群聊抽出来）：`at` 可以是 epoch 毫秒或 ISO 串。
 * 解析不了 / 时间戳缺失返回空串——调用方据此跳过日界，不硬编一个 1970 出来。
 */
function dayKeyOfAt(at) {
  const value = typeof at === "number" ? at : Date.parse(String(at || ""));
  if (!Number.isFinite(value) || value <= 0) return "";
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function groupDayOf(message) {
  // 跨天分割按**本地**日历日算：at 是 ISO UTC 串，直接 slice(0,10) 在凌晨时段会标错天（实测踩过）
  const value = Date.parse(message.at || "");
  if (!Number.isFinite(value)) return String(message.at || "").slice(0, 10);
  return dayKeyOfAt(value);
}

/** 日期分割的可读标签（2026-11-08 批三）：今天 / 昨天 / M月D日（跨年才带年份） */
function dayLabelOf(day) {
  const [year, month, date] = String(day || "").split("-").map(Number);
  if (!year || !month || !date) return String(day || "");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(year, month - 1, date);
  const diffDays = Math.round((today - that) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  return year === now.getFullYear() ? `${month}月${date}日` : `${year}年${month}月${date}日`;
}

function groupDayLabel(day) {
  return dayLabelOf(day);
}

/** 一条消息的渲染元信息（合并 / 日界判据）：回读与实时追加共用同一份 */
function groupMetaOf(message) {
  return {
    key: groupAuthorKey(message),
    day: groupDayOf(message),
    at: Date.parse(message.at || "") || 0,
  };
}

function appendGroupDayDivider(day) {
  const divider = document.createElement("div");
  divider.className = "group-day";
  divider.textContent = groupDayLabel(day);
  divider.title = day;
  el.groupThread.append(divider);
}

/**
 * 追加一条消息（回读与实时追加同一条路）。
 * 合并条件：同作者 + 中间没有别人 + 同一天 + 间隔 <5 分钟；跨天绝不合并（否则会跨过日界）。
 * 每条消息渲染后把游标写回 groups.lastMeta，两条路径行为一致。
 */
function appendGroupMessageToThread(message) {
  const meta = groupMetaOf(message);
  const lastRendered = groups.lastMeta;
  if (!lastRendered || lastRendered.day !== meta.day) appendGroupDayDivider(meta.day);
  const merge =
    Boolean(lastRendered) &&
    lastRendered.key === meta.key &&
    lastRendered.day === meta.day &&
    message.kind === "message" &&
    meta.at - (lastRendered.at || 0) < GROUP_MERGE_MS;

  if (message.kind === "system") {
    const line = document.createElement("div");
    line.className = "group-sys";
    line.textContent = message.content;
    el.groupThread.append(line);
    groups.lastMeta = meta;
    return;
  }

  const mine = message.authorKind === "user";
  const bubble = document.createElement("div");
  bubble.className = `gmsg ${mine ? "me" : "them"}${merge ? " merged" : ""}`;
  bubble.dataset.msgId = message.id;
  bubble.dataset.authorName = mine ? "主人" : message.authorName || "";

  if (!mine) {
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar gmsg-avatar";
    paintAvatar(avatar, groupMemberAvatarOf(message.authorId), message.authorName || "");
    bubble.append(avatar);
  }
  const stack = document.createElement("div");
  stack.className = "gmsg-stack";
  if (!merge) {
    const head = document.createElement("div");
    head.className = "gmsg-head";
    const who = document.createElement("span");
    who.className = "gmsg-who";
    who.textContent = mine ? "主人" : message.authorName || "执事";
    const when = document.createElement("span");
    when.className = "gmsg-at";
    when.textContent = formatGroupTime(message.at);
    head.append(who, when);
    stack.append(head);
  }
  const body = document.createElement("div");
  body.className = "gmsg-body";
  paintMentionText(body, message.content);
  stack.append(body);
  bubble.append(stack);
  el.groupThread.append(bubble);
  groups.lastMeta = meta;
}

/** 群成员头像（按 partnerId 从花名册取；外侧缓存由 state.partners 负责） */
function groupMemberAvatarOf(partnerId) {
  if (!partnerId) return null;
  return state.partners.find((item) => item.id === partnerId)?.avatar || null;
}

/**
 * 正文里的 @点名 上色（2026-11-07；2026-11-08 批三补长标签）。纯文本发送、发送时服务端
 * 重解析的口径不变，这里只做**显示**：把命中成员名的那段包一层 <span>，不改变 textContent。
 * 长标签 `@名字·domain` 整体上色；`@名字·打错的域` 不是点名，按普通文本留白（与服务端同判据）。
 * 用 DOM 拼节点而不是 innerHTML —— 正文是用户/模型产出，绝不拼 HTML。
 */
function paintMentionText(host, text) {
  const source = String(text ?? "");
  const members = groups.current?.members ?? [];
  if (!members.length || !source.includes("@")) {
    host.textContent = source;
    return;
  }
  // 长标签优先：`小双·math` 排在 `小双` 前，避免只染半截
  const labels = [];
  for (const member of members) {
    if (!member.name) continue;
    if (member.domain) labels.push(`${member.name}·${member.domain}`);
    labels.push(member.name);
  }
  labels.sort((a, b) => b.length - a.length);
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf("@", cursor);
    if (at === -1) break;
    const prev = at > 0 ? source[at - 1] : "";
    if (/[A-Za-z0-9_@]/.test(prev)) {
      // 邮箱/路径里的 @ 不是点名：原样吞掉这个字符继续扫
      fragment.append(document.createTextNode(source.slice(cursor, at + 1)));
      cursor = at + 1;
      continue;
    }
    const hit = labels.find((label) => source.startsWith(label, at + 1));
    // 短名后面跟着 `·域` 但整体没命中长标签 = 打错的域：不是点名，整段留白
    const looksLong = hit && !hit.includes("·") && source[at + 1 + hit.length] === "·";
    if (!hit || looksLong) {
      fragment.append(document.createTextNode(source.slice(cursor, at + 1)));
      cursor = at + 1;
      continue;
    }
    fragment.append(document.createTextNode(source.slice(cursor, at)));
    const mark = document.createElement("span");
    mark.className = "gmsg-mention";
    mark.textContent = `@${hit}`;
    fragment.append(mark);
    cursor = at + 1 + hit.length;
  }
  if (cursor < source.length) fragment.append(document.createTextNode(source.slice(cursor)));
  host.replaceChildren(fragment);
}

/**
 * 群成员条（2026-11-07）：头像 + 名字 + 值日标记。
 * 点 = 把 @名字 插进输入框（补全 @ 的发现性）；右键 = 同一个操作菜单（@他 / 复制名字）。
 */
function renderGroupMembersBar() {
  if (!el.groupMembers) return;
  el.groupMembers.replaceChildren();
  const group = groups.current;
  if (!group) {
    el.groupMembers.hidden = true;
    return;
  }
  el.groupMembers.hidden = false;
  for (const member of group.members) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "group-member";
    chip.dataset.memberId = member.partnerId;
    const isDuty = member.partnerId === group.responderPartnerId && group.responderKind === "member";
    chip.title = isDuty ? `${member.name} · 值日执事（不 @ 时他回）` : `${member.name} · 点一下 @ 他`;
    chip.setAttribute("aria-label", chip.title);

    const avatar = document.createElement("span");
    avatar.className = "pt-avatar group-member-avatar";
    paintAvatar(avatar, groupMemberAvatar(member), member.name);
    const name = document.createElement("span");
    name.className = "group-member-name";
    name.textContent = member.name;
    chip.append(avatar, name);
    if (isDuty) {
      const duty = document.createElement("span");
      duty.className = "group-member-duty";
      duty.textContent = "值日";
      chip.append(duty);
    }
    if (member.status && member.status !== "active") {
      chip.classList.add("is-off");
      chip.title = `${member.name} · 当前不在服务（发言会被跳过）`;
    }

    chip.addEventListener("click", () => insertGroupMention(member));
    chip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openGroupMemberMenu(event, member, isDuty);
    });
    el.groupMembers.append(chip);
  }
}

/**
 * 把 @名字 插到光标处（不留双空格；已有 @ 就只补名字）。
 * 带 domain 的成员插**长标签** `@名字·domain`（2026-11-08 批三）：
 * 重名时短名会被后端 400 拒绝，长标签是那个唯一能写对的表达形式。
 */
function insertGroupMention(member) {
  if (!el.groupInput) return;
  const name = typeof member === "string" ? member : member?.name;
  const domain = typeof member === "string" ? "" : member?.domain || "";
  if (!name) return;
  const tag = domain ? `${name}·${domain}` : name;
  const value = el.groupInput.value;
  const caret = el.groupInput.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  // 光标前已有 @（含半截名字 / 半截长标签）就替换掉这段，接上选中的成员
  const partial = /(^|\s)@([^\s@]*)$/.exec(before);
  const head = partial ? before.slice(0, caret - partial[2].length - 1) : before;
  const pad = head && !head.endsWith(" ") ? " " : "";
  const insert = `${pad}@${tag} `;
  el.groupInput.value = head + insert + after;
  const next = head.length + insert.length;
  el.groupInput.setSelectionRange(next, next);
  el.groupInput.focus();
  resizeGroupInput();
  updateGroupSendState();
  clearGroupAtHint();
}

/**
 * 成员右键菜单（2026-11-07）：右键在群成员上不是「浏览器菜单」，而是这个人的操作清单。
 *
 * 为什么要它：@ 是纯文本，用户不知道有哪些人可以点、也不知道点谁会发生什么。
 * 菜单里给出「@ 他」与「复制名字」两条，`@所有人` 另给一条广播项并明示它会叫醒全员。
 * 几何照 .proj-pop（fixed 定位、贴边翻转、点外关闭、Esc 关闭），不引入新交互范式。
 */
const groupMemberMenu = { node: null, anchor: null };

function closeGroupMemberMenu() {
  if (!groupMemberMenu.node) return;
  groupMemberMenu.node.remove();
  groupMemberMenu.node = null;
  groupMemberMenu.anchor = null;
}

function openGroupMemberMenu(event, member, isDuty) {
  closeGroupMemberMenu();
  if (!groups.current) return;
  const menu = document.createElement("div");
  menu.className = "gmenu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `${member.name} 的操作`);

  const header = document.createElement("div");
  header.className = "gmenu-head";
  const headerAvatar = document.createElement("span");
  headerAvatar.className = "pt-avatar gmenu-avatar";
  paintAvatar(headerAvatar, groupMemberAvatar(member), member.name);
  const headerMain = document.createElement("div");
  headerMain.className = "gmenu-head-main";
  const headerName = document.createElement("div");
  headerName.className = "gmenu-head-name";
  headerName.textContent = member.name;
  const headerSub = document.createElement("div");
  headerSub.className = "gmenu-head-sub";
  headerSub.textContent = isDuty ? "值日执事 · 不 @ 时由他回" : "群成员";
  headerMain.append(headerName, headerSub);
  header.append(headerAvatar, headerMain);
  menu.append(header);

  const item = (label, hint, run, { danger = false } = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gmenu-item${danger ? " is-danger" : ""}`;
    button.setAttribute("role", "menuitem");
    const main = document.createElement("span");
    main.className = "gmenu-item-label";
    main.textContent = label;
    button.append(main);
    if (hint) {
      const sub = document.createElement("span");
      sub.className = "gmenu-item-hint";
      sub.textContent = hint;
      button.append(sub);
    }
    button.addEventListener("click", () => {
      closeGroupMemberMenu();
      run();
    });
    menu.append(button);
  };

  const mentionTag = member.domain ? `${member.name}·${member.domain}` : member.name;
  item("＠ 他", `插入 @${mentionTag} 到输入框`, () => insertGroupMention(member));
  item("复制名字", member.name, () => {
    navigator.clipboard
      ?.writeText(member.name)
      .then(() => toast(`已复制「${member.name}」`))
      .catch(() => toast("复制失败"));
  });
  item("＠ 所有人", "叫醒全员，按成员顺序逐个回（最贵）", () => insertGroupBroadcastMention());

  document.body.append(menu);
  // 定位：贴光标，越界往回翻（同 .proj-pop 的口径：先右后翻）
  const rect = menu.getBoundingClientRect();
  const gap = 6;
  let left = event.clientX;
  let top = event.clientY;
  if (left + rect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - rect.width);
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, event.clientY - rect.height);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  groupMemberMenu.node = menu;
  groupMemberMenu.anchor = event.currentTarget;
  menu.querySelector(".gmenu-item")?.focus();
}

/** 右键菜单里的广播项：@所有人 不是成员，所以单独给一条并写清代价 */
function insertGroupBroadcastMention() {
  if (!el.groupInput) return;
  const value = el.groupInput.value;
  const caret = el.groupInput.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const partial = /(^|\s)@([^\s@]*)$/.exec(before);
  const head = partial ? before.slice(0, caret - partial[2].length - 1) : before;
  const pad = head && !head.endsWith(" ") ? " " : "";
  const insert = `${pad}@所有人 `;
  el.groupInput.value = head + insert + value.slice(caret);
  const next = head.length + insert.length;
  el.groupInput.setSelectionRange(next, next);
  el.groupInput.focus();
  resizeGroupInput();
  updateGroupSendState();
}

document.addEventListener("pointerdown", (event) => {
  if (!groupMemberMenu.node) return;
  if (groupMemberMenu.node.contains(event.target)) return;
  closeGroupMemberMenu();
});
document.addEventListener("keydown", (event) => {
  if (!groupMemberMenu.node) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeGroupMemberMenu();
    groupMemberMenu.anchor?.focus?.();
  }
});
window.addEventListener("resize", closeGroupMemberMenu);

function formatGroupTime(at) {
  const value = Date.parse(at || "");
  if (!Number.isFinite(value)) return "";
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN, GROUP_MERGE_MS, appendGroupDayDivider, appendGroupMessageToThread, closeGroupMemberMenu, dayKeyOfAt, dayLabelOf, formatGroupTime, groupAuthorKey, groupDayLabel, groupDayOf, groupMemberAvatarOf, groupMemberMenu, groupMetaOf, insertGroupBroadcastMention, insertGroupMention, openGroupMemberMenu, paintMentionText, renderGroupMembersBar, renderGroupTimeline };
