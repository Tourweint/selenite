/**
 * 群组路由与列表（2026-11-20 从 groups-topics.js 拆出）。
 *
 * 2026-11-13 从 web/app.js 按职责拆出时与课题共处一文件；2026-11-20 课题退役，
 * 这里只留群组列表 / 群会话入口，正文是原文搬运，未改写行为。
 *
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { groups, initGroups, paintGroupAvatar, renderGroupPulse, renderGroupSidebar, startGroupPulse, stopGroupPulse } from "./groups-base.js";
import { closeGroupAtPop, resizeGroupInput, updateGroupSendState } from "./groups-composer.js";
import { gsResponderShort } from "./groups-settings.js";
import { renderGroupMembersBar, renderGroupTimeline } from "./groups-thread.js";
import { request } from "./net.js";
import { groupRouteId } from "./route.js";
import { toast } from "./ui-atoms.js";

/** 群组路由入口：#/groups 列表态，#/group/:id 会话态。 */
async function openGroupsView() {
  if (groups.available === null) await initGroups();
  closeGroupAtPop();
  const id = groupRouteId();
  if (!id) {
    el.groupsTitleText.textContent = "群组";
    el.groupsTitleSub.textContent = "";
    el.groupSettingsBtn.hidden = true;
    el.groupCreate.hidden = groups.available !== true;
    el.groupChat.hidden = true;
    el.groupsBody.hidden = false;
    if (el.groupHeadAvatar) el.groupHeadAvatar.hidden = true;
    // 列表态没有"谁在忙"可看：停掉轮询，别在后台空转
    stopGroupPulse();
    if (el.groupPulse) {
      el.groupPulse.replaceChildren();
      el.groupPulse.hidden = true;
    }
    await renderGroupsListPage();
    return;
  }
  el.groupCreate.hidden = true;
  el.groupsBody.hidden = true;
  el.groupChat.hidden = false;
  await openGroupChat(id);
}

async function renderGroupsListPage() {
  if (groups.available !== true) {
    el.groupsBody.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.textContent = "群组未启用（GROUPS_ENABLED / COMPANIONS_ENABLED）。";
    el.groupsBody.append(empty);
    return;
  }
  // 现拉一次：建群/删群回来列表要新
  const response = await request("/api/v1/groups", { cache: "no-store" }).catch(() => null);
  if (response?.ok) {
    const data = await response.json().catch(() => ({}));
    groups.list = Array.isArray(data.groups) ? data.groups : [];
    renderGroupSidebar();
  }

  el.groupsBody.replaceChildren();
  if (!groups.list.length) {
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.innerHTML = [
      "<h2>还没有群组</h2>",
      // 措辞与建群弹窗同一套（那里也说"成员"）：群里的可以是指挥官，也可以是执事
      "<p>把 2–6 位成员拉进同一条会话：@名字 点名谁回，不 @ 就发给值日。</p>",
    ].join("");
    el.groupsBody.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "group-list";
  for (const group of groups.list) {
    // 一行一群（2026-11-07）：原来是自适应网格卡片，1–2 个群时被撑成一大块孤卡。
    const row = document.createElement("button");
    row.type = "button";
    row.className = "group-item";
    row.dataset.groupId = group.id;

    const avatar = document.createElement("span");
    avatar.className = "pt-avatar group-item-avatar";
    avatar.setAttribute("aria-hidden", "true");
    paintGroupAvatar(avatar, group.members);

    const main = document.createElement("span");
    main.className = "group-item-main";
    const name = document.createElement("span");
    name.className = "group-item-name";
    name.textContent = group.name;
    const sub = document.createElement("span");
    sub.className = "group-item-sub";
    const who = group.members.map((m) => m.name).join("、");
    // 口径直接复用设置抽屉的 gsResponderShort（值日 阅读助手 / 全员都回 / 只回点名）：
    // 同一个概念在两处出现，就不该有两套措辞——原来这里拼「不 @ 阅读助手 回」，
    // 断句会读成"不要 @ 阅读助手"，而设置页写的是「值日 阅读助手」。
    sub.textContent = `${who} · ${gsResponderShort(group)}`;
    main.append(name, sub);

    const count = document.createElement("span");
    count.className = "group-item-count";
    count.textContent = `${group.members.length} 人`;

    const chevron = document.createElement("span");
    chevron.className = "group-item-chevron";
    chevron.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

    row.append(avatar, main, count, chevron);
    row.addEventListener("click", () => {
      location.hash = `#/group/${group.id}`;
    });
    list.append(row);
  }
  el.groupsBody.append(list);
}

/** 打开群会话视图：群资料 + 时间线，composer 就绪。 */
async function openGroupChat(groupId) {
  const response = await request(`/api/v1/groups/${encodeURIComponent(groupId)}`, { cache: "no-store" }).catch(() => null);
  if (!response || !response.ok) {
    toast("这个群不存在或已被删除");
    location.hash = "#/groups";
    return;
  }
  const data = await response.json().catch(() => ({}));
  groups.current = data.group ?? null;
  groups.messages = [];
  groups.streamSender = null;
  groups.streamBubble = null;

  if (!groups.current) {
    toast("这个群不存在或已被删除");
    location.hash = "#/groups";
    return;
  }
  el.groupsTitleText.textContent = groups.current.name;
  // 会话头复合头像（2026-11-08 批三）：列表态没有它，进群才画
  if (el.groupHeadAvatar) {
    el.groupHeadAvatar.hidden = false;
    paintGroupAvatar(el.groupHeadAvatar, groups.current.members);
  }
  const duty = groups.current.members.find((m) => m.partnerId === groups.current.responderPartnerId);
  el.groupsTitleSub.textContent = duty
    ? ` · 值日 ${duty.name}`
    : groups.current.responderKind === "everyone"
      ? " · 不 @ 全员回"
      : groups.current.responderKind === "mentions"
        ? " · 只回点名"
        : "";
  el.groupSettingsBtn.hidden = false;
  el.groupNotice.hidden = !groups.current.notice?.trim();
  el.groupNotice.textContent = groups.current.notice?.trim() ? `公告：${groups.current.notice.trim()}` : "";
  renderGroupMembersBar();

  el.groupThread.replaceChildren();
  const msgResponse = await request(`/api/v1/groups/${encodeURIComponent(groupId)}/messages?limit=200`, { cache: "no-store" }).catch(() => null);
  if (msgResponse?.ok) {
    const msgData = await msgResponse.json().catch(() => ({}));
    groups.messages = Array.isArray(msgData.messages) ? msgData.messages : [];
    groups.lastSeq = Number(msgData.lastSeq ?? 0);
    renderGroupTimeline();
  }
  el.groupInput.value = "";
  resizeGroupInput();
  // 状态胶囊（2026-11-08 批三）：先按详情里的轮次状态画一帧，再开轮询
  groups.round = groups.current.round ?? null;
  groups.pending = [];
  updateGroupSendState();
  renderGroupPulse();
  startGroupPulse();
  el.groupInput.focus();
}

export { openGroupChat, openGroupsView, renderGroupsListPage };
