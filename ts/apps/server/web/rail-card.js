/**
 * 收起轨道悬停浮卡
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar, partnerDotClass } from "./avatar.js";
import { openConversation, startNewChat } from "./chat-open.js";
import { RECENTS_LIMIT, attachChatContextMenu, chatLabel, loadChats, recentChatsOrdered } from "./chats-list.js";
import { el } from "./dom.js";
import { groups, renderGroupRows } from "./groups-base.js";
import { closeGroupSettingsDrawer } from "./groups-settings.js";
import { toggleModelMenu } from "./hover-tip.js";
import { renderRoster } from "./partner-roster.js";
import { openChiefChat, rosterDomain } from "./partners-status.js";
import { closeProjectMenu, ensureProjectMenuOpen, placeRailMenu } from "./project-modal.js";
import { go } from "./route.js";
import { closeChatSettings, toggleChatSettings } from "./settings-drawer.js";
import { state } from "./state.js";
import { closePopover, openPopover, popoverOpen } from "./ui-atoms.js";

/* ── 收起轨道悬停浮卡（2026-11-13）────────────────────────────
 * 收起态悬停 总管 / 执事 / 对话 / 项目 / 群组 → 对应卡片浮到主界面，
 * 顺序与展开态分区一一对应（2026-11-13 用户拍板：任务中心与今日回顾退出轨道）。
 * 点击是同一个开关（键盘 / 触屏路径；总管头像例外：点击直接开对话，悬停才是卡）。
 * 轨道按钮的 title/data-tip 悬停说明整体退役：悬停出来的就是卡本身，不再有第二层文字。
 * 与 2026-11-08 当天退役的「侧栏悬停 peek」不是一回事——那次是整块侧栏
 * 扫过就压内容；这里只弹单张小卡，指针离开按钮+卡就收，不留常驻遮盖。
 * 参数：350ms 悬停意图（扫过不弹）；220ms 收起宽限（按钮→卡之间隔着 8px 缝）。 */
const RAIL_HOVER_OPEN_MS = 350;
const RAIL_HOVER_CLOSE_MS = 220;
const railHover = { openTimer: 0, closeTimer: 0, btn: null, trigger: null, menu: null, suppress: null };

function railHoverArmed() {
  // 收起态轨道才可交互（applySidebarA11y）：展开时 inert，窄屏展开也是覆盖层
  // （2026-11-15）——所以只有收起态出悬停卡，窄屏收起算收起
  return Boolean(el.sideRail) && !el.sideRail.hasAttribute("inert");
}

/** 收掉悬停卡（含清定时器）。谁都可以调：路由切换 / 展开侧栏 / Esc / 点外。 */
function closeRailCards() {
  clearTimeout(railHover.openTimer);
  clearTimeout(railHover.closeTimer);
  railHover.openTimer = 0;
  railHover.closeTimer = 0;
  const { menu, trigger } = railHover;
  railHover.btn = null;
  railHover.trigger = null;
  railHover.menu = null;
  if (menu) closePopover(menu, trigger);
}

function railCardShow(btn, menu, build) {
  // 已开着（比如点击刚打开、悬停定时又到点）就不再重放动画
  if (popoverOpen(menu)) return;
  build();
  openPopover(menu, btn);
  placeRailMenu(menu, btn);
}

function scheduleRailCard(btn, menu, build, show) {
  clearTimeout(railHover.openTimer);
  clearTimeout(railHover.closeTimer);
  // 别的卡还开着：先收，轨道同刻只挂一张卡
  if (railHover.menu && railHover.menu !== menu && popoverOpen(railHover.menu)) {
    closePopover(railHover.menu, railHover.trigger);
  }
  railHover.btn = btn;
  railHover.trigger = btn;
  railHover.menu = menu;
  railHover.openTimer = setTimeout(() => {
    railHover.openTimer = 0;
    show();
  }, RAIL_HOVER_OPEN_MS);
}

function scheduleRailCardClose() {
  clearTimeout(railHover.closeTimer);
  railHover.closeTimer = setTimeout(() => {
    railHover.closeTimer = 0;
    closeRailCards();
  }, RAIL_HOVER_CLOSE_MS);
}

/** 项目卡的数据是现拉的（async），群组/执事卡用缓存现渲（sync）——show 各自定义。 */
function attachRailCard(btn, menu, build, { asyncShow = null } = {}) {
  if (!btn || !menu) return;
  const show = () => {
    if (asyncShow) void asyncShow();
    else railCardShow(btn, menu, build);
  };
  btn.addEventListener("pointerenter", () => {
    // 刚点收过且指针没离开过：不重新悬停弹出（否则点击关闭会被紧跟着的
    // enter 立刻弹回去——合成派发/快速输入设备都会造出这种边界事件）
    if (railHover.suppress === btn) return;
    if (!railHoverArmed() || btn.disabled) return;
    if (popoverOpen(menu)) {
      // 已经开着：只取消收起倒计时，别重放动画
      clearTimeout(railHover.openTimer);
      clearTimeout(railHover.closeTimer);
      railHover.btn = btn;
      railHover.trigger = btn;
      railHover.menu = menu;
      return;
    }
    scheduleRailCard(btn, menu, build, show);
  });
  btn.addEventListener("pointerleave", () => {
    // 离开按钮即解除点击关闭后的悬停抑制
    if (railHover.suppress === btn) railHover.suppress = null;
    if (railHover.btn !== btn) return;
    clearTimeout(railHover.openTimer);
    railHover.openTimer = 0;
    if (popoverOpen(menu)) scheduleRailCardClose();
    else closeRailCards();
  });
  // 指针从按钮挪进卡：路过 8px 缝靠 220ms 宽限兜住；进了卡就稳了
  menu.addEventListener("pointerenter", () => clearTimeout(railHover.closeTimer));
  menu.addEventListener("pointerleave", () => {
    if (railHover.menu === menu) scheduleRailCardClose();
  });
  return show;
}

const railProjectShow = attachRailCard(
  el.railProj,
  el.projectMenu,
  null,
  { asyncShow: () => ensureProjectMenuOpen(el.railProj, { hoverOnly: true }) },
);

/** 群组悬停卡：与展开态分区同一份行渲染 + 底部「所有群聊」进列表页。 */
function renderRailGroupsCard() {
  const menu = el.railGroupsMenu;
  if (!menu) return;
  menu.replaceChildren();
  const list = document.createElement("div");
  list.className = "roster";
  menu.append(list);
  if (groups.available !== true) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = "群组未启用。";
    list.append(empty);
    return;
  }
  renderGroupRows(list, "还没有群组。");
  const foot = document.createElement("div");
  foot.className = "proj-foot";
  const all = document.createElement("button");
  all.type = "button";
  all.className = "sec-foot-link";
  all.textContent = "所有群聊 ";
  const arrow = document.createElement("span");
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";
  all.append(arrow);
  all.addEventListener("click", () => {
    closeRailCards();
    go("groups");
  });
  foot.append(all);
  menu.append(foot);
}

/** 执事悬停卡：与展开态花名册同一份行渲染（头像/领域/派发权/在办单全带）。 */
function renderRailPartnersCard() {
  const menu = el.railPartnersMenu;
  if (!menu) return;
  menu.replaceChildren();
  const list = document.createElement("div");
  list.className = "roster";
  menu.append(list);
  renderRoster(state.partners, rosterDomain.rows, list);
}

/** 卡底入口行：与展开态分区底部的 `.sec-foot-link` 同一套皮，可挂多条。 */
function railCardFoot(items) {
  const foot = document.createElement("div");
  foot.className = "proj-foot";
  for (const [text, onClick] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sec-foot-link";
    button.textContent = `${text} `;
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    button.append(arrow);
    button.addEventListener("click", onClick);
    foot.append(button);
  }
  return foot;
}

/** 总管悬停卡（2026-11-13）：与展开态总管条目同一份信息（头像/名字/总管标记/状态点）。
    头像按钮的点击仍是直接开对话（与展开态条目一致），卡只做悬停一览 + 底部同一动作。 */
function renderRailChiefCard() {
  const menu = el.railChiefMenu;
  if (!menu) return;
  menu.replaceChildren();
  const chief = state.partners.find((partner) => partner && partner.id === "chief") || {};
  const name = String(chief.name || "总管").trim() || "总管";
  const list = document.createElement("div");
  list.className = "roster";

  const row = document.createElement("div");
  row.className = "side-item roster-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.title = name;

  const avatar = document.createElement("span");
  avatar.className = "pt-avatar";
  avatar.setAttribute("aria-hidden", "true");
  paintAvatar(avatar, chief.avatar || null, name);

  const label = document.createElement("span");
  label.className = "roster-name";
  label.textContent = name;

  const tag = document.createElement("span");
  tag.className = "pill-tag";
  tag.textContent = "总管";

  const dot = document.createElement("i");
  dot.className = `status-dot ${partnerDotClass(state.chiefStatus || "active")}`;
  dot.setAttribute("aria-hidden", "true");

  row.append(avatar, label, tag, dot);
  const open = () => {
    closeRailCards();
    openChiefChat();
  };
  row.addEventListener("click", open);
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  });
  list.append(row);
  menu.append(list, railCardFoot([["打开对话", open]]));
}

/** 对话悬停卡（2026-11-13）：与展开态「对话」分区同一份最近会话（前 5 条，
    过滤/排序口径见 recentChatsOrdered）。行点开即进那条对话；卡底保留分区的
    两个入口（新建 / 搜索），与分区头行尾的两颗按钮一一对应。 */
function renderRailChatsCard() {
  const menu = el.railChatsMenu;
  if (!menu) return;
  menu.replaceChildren();
  const list = document.createElement("div");
  list.className = "roster";
  menu.append(list);
  const recent = recentChatsOrdered().slice(0, RECENTS_LIMIT);
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = "还没有对话。";
    list.append(empty);
  }
  for (const chat of recent) {
    const row = document.createElement("div");
    row.className = "side-item roster-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");

    const label = document.createElement("span");
    label.className = "roster-name";
    label.textContent = `${chat.pinned ? "★ " : ""}${chatLabel(chat)}`;

    const meta = document.createElement("span");
    meta.className = "roster-idle";
    meta.textContent = `${chat.turns} 轮`;

    row.append(label, meta);
    const open = () => {
      closeRailCards();
      void openConversation(chat.conversationId);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    // 右键菜单与展开侧栏同一份（2026-11-16）：对象还是同一条会话
    row.dataset.conv = chat.conversationId;
    attachChatContextMenu(row, chat, { onOpen: open, compact: true });
    list.append(row);
  }
  menu.append(railCardFoot([
    ["新建对话", () => {
      closeRailCards();
      go("chat");
      startNewChat("worker");
    }],
    ["搜索旧对话", () => {
      closeRailCards();
      go("search");
    }],
  ]));
}

/** 对话卡的数据现拉一次（卡是「快速跳转」，列表不能比展开态旧）。等回来时指针若已离开就不再弹。 */
const railChatsShow = attachRailCard(el.railChats, el.railChatsMenu, renderRailChatsCard, {
  asyncShow: async () => {
    await loadChats();
    if (railHover.btn !== el.railChats) return;
    railCardShow(el.railChats, el.railChatsMenu, renderRailChatsCard);
  },
});

const railGroupsShow = attachRailCard(el.railGroups, el.railGroupsMenu, renderRailGroupsCard);
const railPartnersShow = attachRailCard(el.railPartners, el.railPartnersMenu, renderRailPartnersCard);
// 总管只有悬停卡，点击仍是直接开对话——不需要返回的 show 做开关
attachRailCard(el.railChief, el.railChiefMenu, renderRailChiefCard);

/** 点击轨道钮 = 同一个开关（悬停已开就收，没开就立刻开，不必等悬停定时）。 */
function toggleRailCard(btn, menu, build, show) {
  if (popoverOpen(menu)) {
    closeRailCards();
    // 指针还停在按钮上：压住悬停重弹，直到指针真离开（见 pointerenter 的 suppress 判）
    railHover.suppress = btn;
    return;
  }
  clearTimeout(railHover.openTimer);
  clearTimeout(railHover.closeTimer);
  // 别的卡还开着：先收，轨道同刻只挂一张卡
  if (railHover.menu && railHover.menu !== menu && popoverOpen(railHover.menu)) {
    closePopover(railHover.menu, railHover.trigger);
  }
  railHover.btn = btn;
  railHover.trigger = btn;
  railHover.menu = menu;
  if (show) show();
  else railCardShow(btn, menu, build);
}

el.railProj?.addEventListener("click", () => {
  if (popoverOpen(el.projectMenu)) closeProjectMenu();
  else void ensureProjectMenuOpen(el.railProj);
});
el.railGroups?.addEventListener("click", () => toggleRailCard(el.railGroups, el.railGroupsMenu, renderRailGroupsCard, railGroupsShow));
el.railPartners?.addEventListener("click", () => toggleRailCard(el.railPartners, el.railPartnersMenu, renderRailPartnersCard, railPartnersShow));
el.railChats?.addEventListener("click", () => toggleRailCard(el.railChats, el.railChatsMenu, renderRailChatsCard, railChatsShow));

el.modelPill?.addEventListener("click", () => void toggleModelMenu());
// 菜单里的点击不冒泡到「点外面就关」的判定：点供应商段会就地重渲染，
// 被替换掉的旧按钮已经脱离文档，冒泡到 document 时会被当成外部点击误关。
el.modelMenu?.addEventListener("click", (event) => event.stopPropagation());

// 对话右上角快捷设置（2026-11-07 抽屉改造）：三通道关闭 = Esc / X / 点遮罩。
// 2026-11-07 二次修：模型页改成卡片里的两个下拉，不再有供应商分段，
// 原来那条 providerchange → 同步批量区标签的接线随之删掉。
el.chatSettingsBtn?.addEventListener("click", () => void toggleChatSettings());
el.chatSettingsOverlay?.addEventListener("click", () => closeChatSettings());
el.groupSettingsOverlay?.addEventListener("click", () => closeGroupSettingsDrawer());

export { RAIL_HOVER_CLOSE_MS, RAIL_HOVER_OPEN_MS, attachRailCard, closeRailCards, railCardFoot, railCardShow, railChatsShow, railGroupsShow, railHover, railHoverArmed, railPartnersShow, railProjectShow, renderRailChatsCard, renderRailChiefCard, renderRailGroupsCard, renderRailPartnersCard, scheduleRailCard, scheduleRailCardClose, toggleRailCard };
