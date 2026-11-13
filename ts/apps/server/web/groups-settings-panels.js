/**
 * 群设置抽屉：成员 / 回复 + 保存动作
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar } from "./avatar.js";
import { el } from "./dom.js";
import { groupMemberAvatar, groups, initGroups } from "./groups-base.js";
import { clearGroupAtHint, closeGroupAtPop, groupAt, pickGroupAt, resizeGroupInput, sendGroupMessage, stopGroupRoundWeb, updateGroupAtPop, updateGroupSendState } from "./groups-composer.js";
import { openCreateGroupModal } from "./groups-create.js";
import { closeGroupSettingsDrawer, groupSettingsOpen, gs, gsHead, openGroupSettingsDrawer, renderGroupSettings } from "./groups-settings.js";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "./groups-thread.js";
import { loadTopicsSidebar, openGroupChat } from "./groups-topics.js";
import { request } from "./net.js";
import { go, groupRouteId } from "./route.js";
import { sectionClosed } from "./shell.js";
import { openConfirm, toast } from "./ui-atoms.js";

function renderGroupSettingsMembers(drawer) {
  drawer.append(gsHead("成员", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  const group = gs.group;
  const inGroup = new Set(group.members.map((m) => m.partnerId));
  const candidates = gs.partners
    .filter((p) => p.id !== "chief" || !inGroup.has("chief"))
    .filter((p) => !inGroup.has(p.id));
  const hint = document.createElement("p");
  hint.className = "set-hint";
  hint.style.padding = "12px 16px 4px";

  const render = () => {
    body.replaceChildren();
    const count = group.members.length;
    hint.textContent =
      `${count} / ${GROUP_MEMBER_MAX} 人。值日执事在不 @ 时回话；群至少保留 ${GROUP_MEMBER_MIN} 人。` +
      (count >= GROUP_MEMBER_MAX ? "已满员，先移出一位才能加人。" : "");
    body.append(hint);

    for (const member of group.members) {
      const isDuty = member.partnerId === group.responderPartnerId && group.responderKind === "member";
      const row = document.createElement("div");
      row.className = "gs-member-row";
      const avatar = document.createElement("span");
      avatar.className = "pt-avatar";
      paintAvatar(avatar, groupMemberAvatar(member), member.name);
      const main = document.createElement("div");
      main.className = "gs-member-main";
      const nameNode = document.createElement("div");
      nameNode.className = "gs-member-name";
      nameNode.textContent = member.name;
      const sub = document.createElement("div");
      sub.className = "gs-member-sub";
      sub.textContent = isDuty
        ? "值日执事 · 不 @ 时他回"
        : member.status === "active"
          ? "群成员"
          : "当前暂停或归档";
      main.append(nameNode, sub);

      const actions = document.createElement("div");
      actions.className = "gs-member-actions";
      if (group.responderKind === "member") {
        const dutyBtn = document.createElement("button");
        dutyBtn.type = "button";
        dutyBtn.className = "gs-chip-btn";
        dutyBtn.setAttribute("aria-pressed", isDuty ? "true" : "false");
        dutyBtn.textContent = isDuty ? "值日" : "设为值日";
        dutyBtn.disabled = isDuty;
        dutyBtn.addEventListener("click", () => void patchGroup({ responderPartnerId: member.partnerId }));
        actions.append(dutyBtn);
      }
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "gs-chip-btn is-danger";
      removeBtn.textContent = "移出";
      removeBtn.disabled = count <= GROUP_MEMBER_MIN;
      if (removeBtn.disabled) removeBtn.title = `群至少保留 ${GROUP_MEMBER_MIN} 人`;
      removeBtn.addEventListener("click", async () => {
        if (count <= GROUP_MEMBER_MIN) {
          toast(`群至少保留 ${GROUP_MEMBER_MIN} 人`);
          return;
        }
        const ok = await openConfirm({
          title: "移出群",
          message: `把「${member.name}」移出群？`,
          detail: "群里的历史消息会保留。",
          confirmText: "移出",
        });
        if (!ok) return;
        void patchGroup({ removeMemberIds: [member.partnerId] });
      });
      actions.append(removeBtn);
      row.append(avatar, main, actions);
      body.append(row);
    }

    const label = document.createElement("div");
    label.className = "gs-section-label";
    label.textContent = candidates.length ? "加人" : "可加的执事都已在这个群里";
    body.append(label);

    if (candidates.length) {
      const list = document.createElement("div");
      list.className = "gs-add-list";
      const full = group.members.length >= GROUP_MEMBER_MAX;
      for (const partner of candidates) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gs-add-row";
        button.disabled = full;
        const avatar = document.createElement("span");
        avatar.className = "pt-avatar";
        paintAvatar(avatar, partner.avatar || null, partner.name);
        const nameNode = document.createElement("span");
        nameNode.textContent = partner.name;
        const plus = document.createElement("span");
        plus.className = "gs-add-plus";
        plus.textContent = full ? "已满员" : "加入";
        button.append(avatar, nameNode, plus);
        if (partner.id === "chief") {
          button.title = "总管进群后就是普通成员，不参与路由（值日 / @ 都照常）";
        }
        button.addEventListener("click", () => {
          void patchGroup({ addMemberIds: [partner.id] });
        });
        list.append(button);
      }
      body.append(list);
    }
  };
  render();
  drawer.append(body);
}

/** 二级页：回应口径（三选一，写清代价） */
function renderGroupSettingsReply(drawer) {
  drawer.append(gsHead("回应口径", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  const group = gs.group;
  const hint = document.createElement("p");
  hint.className = "set-hint";
  hint.style.padding = "12px 16px 8px";
  hint.textContent = "只管「这条消息没有 @ 任何人」时怎么办；@ 点名与 @所有人 永远优先。";

  const options = [
    {
      kind: "member",
      title: "值日执事回",
      sub: "最省：只叫一位。@点名 仍然可以点别人。",
    },
    {
      kind: "everyone",
      title: "全员按顺序回",
      sub: "最贵：每位成员一次完整模型调用，人多时明显慢。",
    },
    {
      kind: "mentions",
      title: "只回点名",
      sub: "没有 @ 就没人接话（会留一行系统提示）。",
    },
  ];

  body.append(hint);
  for (const option of options) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "gs-row";
    row.setAttribute("aria-pressed", group.responderKind === option.kind ? "true" : "false");
    const main = document.createElement("span");
    main.className = "gs-row-main";
    const title = document.createElement("span");
    title.className = "gs-row-title";
    title.textContent = option.title;
    const sub = document.createElement("span");
    sub.className = "gs-row-sub";
    sub.textContent = option.sub;
    main.append(title, sub);
    row.append(main);
    if (group.responderKind === option.kind) {
      const check = document.createElement("span");
      check.className = "gs-row-value";
      check.textContent = "当前";
      row.append(check);
    }
    row.addEventListener("click", async () => {
      if (group.responderKind === option.kind) return;
      if (option.kind === "everyone") {
        const ok = await openConfirm({
          title: "改成全员回",
          message: `「${group.name}」改成不 @ 就全员回？`,
          detail: "每位成员都会各跑一次模型，账单和等待都会随人数增长。",
          confirmText: "改成全员回",
        });
        if (!ok) return;
      }
      const payload = { responderKind: option.kind };
      // 换成 member 而没有值日时，顺手把第一位设成值日（否则服务端 400）
      if (option.kind === "member" && !group.responderPartnerId) {
        const first = group.members[0];
        if (first) payload.responderPartnerId = first.partnerId;
      }
      void patchGroup(payload);
    });
    body.append(row);
    const divider = document.createElement("div");
    divider.className = "gs-divider";
    body.append(divider);
  }
  if (group.responderKind === "member") {
    const label = document.createElement("div");
    label.className = "gs-section-label";
    label.textContent = "值日执事";
    body.append(label);
    for (const member of group.members) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "gs-row";
      const avatar = document.createElement("span");
      avatar.className = "pt-avatar";
      paintAvatar(avatar, groupMemberAvatar(member), member.name);
      const main = document.createElement("span");
      main.className = "gs-row-main";
      const title = document.createElement("span");
      title.className = "gs-row-title";
      title.textContent = member.name;
      main.append(title);
      row.append(avatar, main);
      if (member.partnerId === group.responderPartnerId) {
        const check = document.createElement("span");
        check.className = "gs-row-value";
        check.textContent = "值日";
        row.append(check);
      }
      row.addEventListener("click", () => {
        if (member.partnerId === group.responderPartnerId) return;
        void patchGroup({ responderPartnerId: member.partnerId });
      });
      body.append(row);
    }
  }
  drawer.append(body);
}

/** 统一的 PATCH：成功就把新群写回并重渲染当前页；失败只 toast，草稿不丢 */
async function patchGroup(payload) {
  const group = gs.group;
  if (!group) return;
  const response = await request(`/api/v1/groups/${encodeURIComponent(group.id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  }).catch(() => null);
  const data = await response?.json().catch(() => ({}));
  if (!response?.ok) {
    toast(data?.message || "没保存成功");
    return;
  }
  gs.group = data.group ?? gs.group;
  groups.current = gs.group;
  gs.draft = { name: gs.group.name, notice: gs.group.notice || "" };
  await initGroups();
  await openGroupChat(gs.group.id);
  renderGroupSettings();
}

async function confirmDeleteGroup(group) {
  const ok = await openConfirm({
    title: "删除群组",
    message: `删群「${group.name}」？`,
    detail: "消息和成员关系一起删，不可恢复。",
    confirmText: "删群",
    danger: true,
  });
  if (!ok) return;
  const response = await request(`/api/v1/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" }).catch(() => null);
  if (!response?.ok) {
    toast("删群失败");
    return;
  }
  closeGroupSettingsDrawer();
  toast("群已删除");
  await initGroups();
  location.hash = "#/groups";
}

/**
 * 执事选项（建群/加人用）；拿不到返回 null（弹窗里 toast 提示）
 *
 * 2026-11-07：**总管也要能进群**。总管在库里就是一行 partner（固定 id `chief`），
 * 服务端建群/加人一路都接受他（方案 §2.1「总管可被拉进群当普通成员，不做路由者」），
 * 之前这里 `.filter(p => p.id !== "chief")` 把它挡在前端，用户看到的就是「加不了总管」。
 * 现在只按状态筛；总管排在最前，并在界面上标注他的身份差异（普通成员，不路由）。
 */
async function fetchPartnerOptions() {
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const list = (Array.isArray(data.partners) ? data.partners : [])
      .filter((p) => p.status === "active")
      .sort((a, b) => Number(b.id === "chief") - Number(a.id === "chief"));
    // 重名在群里是 @ 歧义源：建群入口就拦（服务端同样校验）
    const seen = new Set();
    for (const partner of list) {
      if (seen.has(partner.name)) {
        toast(`有重名执事「${partner.name}」，先改名再建群`);
        return null;
      }
      seen.add(partner.name);
    }
    return list;
  } catch {
    return null;
  }
}

/* 群组事件接线 */
el.groupsBack?.addEventListener("click", () => {
  location.hash = groupRouteId() ? "#/groups" : "#/";
});
el.groupCreate?.addEventListener("click", () => void openCreateGroupModal());
el.groupSettingsBtn?.addEventListener("click", () => {
  if (groupSettingsOpen()) closeGroupSettingsDrawer();
  else openGroupSettingsDrawer();
});
el.groupSend?.addEventListener("click", () => void sendGroupMessage());
el.groupStop?.addEventListener("click", () => void stopGroupRoundWeb());
el.groupInput?.addEventListener("input", () => {
  resizeGroupInput();
  updateGroupSendState();
  updateGroupAtPop();
  // 用户开始改正文：上一轮重名候选条已经过时，收掉（2026-11-08 批三）
  clearGroupAtHint();
});
el.groupInput?.addEventListener("keydown", (event) => {
  if (groupAt.open) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      groupAt.index = (groupAt.index + 1) % groupAt.items.length;
      updateGroupAtPop();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      groupAt.index = (groupAt.index - 1 + groupAt.items.length) % groupAt.items.length;
      updateGroupAtPop();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.isComposing) {
      event.preventDefault();
      pickGroupAt(groupAt.index);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeGroupAtPop();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendGroupMessage();
  }
});
// @ 按钮（2026-11-07 修接线）：把 @ 打到光标处并弹候选——与手输 @ 走同一条
// updateGroupAtPop 路径；光标前已有半截 @（含空 @）就不重复插，直接把候选弹出来。
el.groupAtBtn?.addEventListener("click", () => {
  if (!el.groupInput) return;
  const value = el.groupInput.value;
  const caret = el.groupInput.selectionStart ?? value.length;
  if (!/(^|\s)@([^\s@]*)$/.test(value.slice(0, caret))) {
    el.groupInput.value = value.slice(0, caret) + "@" + value.slice(caret);
    const next = caret + 1;
    el.groupInput.setSelectionRange(next, next);
  }
  el.groupInput.focus();
  updateGroupAtPop();
});
// 群组轨道钮的点击改挂悬停卡开关（见轨道悬停浮卡段，2026-11-13）——
// 原「点一下直接进群组列表页」退役，进列表的入口留在卡的「所有群聊 →」与展开态分区。
// 分组头的折叠由上面 SIDE_SECTIONS 那个循环统一注册；**这里不要再绑一次**——
// 同一元素上两个 toggleSection 会互相抵消（点一下收起、紧接着又展开），
// 表现成"群组点了没反应、也没有动画"（2026-11-07 实测踩到）。
// 进整页的入口都挂在分区体内的链接行 / 群行上。
el.secGroupsAdd?.addEventListener("click", () => {
  go("groups");
  void openCreateGroupModal();
});
/* 「所有群聊」：分区底部那一行（2026-11-07 用户口径「放在群组展开之后的底下，
   不要放在返回之后」）。它只负责去列表态；群会话里点它同样落到 #/groups，
   不必先按顶栏返回键再找入口。 */
el.secGroupsAll?.addEventListener("click", () => go("groups"));

/* 课题（2026-11-07 批二 / 2026-11-13 浮卡）：轨道钮点击挂悬停卡开关（见轨道悬停浮卡段）；
   「展开侧栏落到课题分区」的老行为保留在 openTopicsInSidebar()，入口是卡底那一行。 */
// 分区头由 SIDE_SECTIONS 的循环统一折叠；这里只补「展开时现拉一次」，不再 toggle。
el.secTopicsToggle?.addEventListener("click", () => {
  if (!sectionClosed("topics")) void loadTopicsSidebar();
});

export { confirmDeleteGroup, fetchPartnerOptions, patchGroup, renderGroupSettingsMembers, renderGroupSettingsReply };
