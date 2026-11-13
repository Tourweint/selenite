/**
 * 群设置抽屉：首页 / 基本 / 头图
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar } from "./avatar.js";
import { el } from "./dom.js";
import { groupMemberAvatar, groups, initGroups } from "./groups-base.js";
import { confirmDeleteGroup, renderGroupSettingsMembers, renderGroupSettingsReply } from "./groups-settings-panels.js";
import { openGroupChat } from "./groups-topics.js";
import { CS_ICONS } from "./icons.js";
import { request } from "./net.js";
import { csSvg } from "./settings-drawer.js";
import { state } from "./state.js";
import { noMotion, toast } from "./ui-atoms.js";


/* ── 群设置抽屉（2026-11-07 重建）──────────────────────────
 * 原实现是居中 modal：改名/公告/值日/成员增减/删除全塞进一列，输入框和勾选胶囊混排，
 * 看不出层级，也不像设置。现在改成与「对话设置」同一副骨架的右侧抽屉：
 *   首页 = 群身份 + 三行（群资料 / 成员 / 回应口径）+ 页尾删除
 *   二级页 = 一次只管一件事，返回箭头回首页，抽屉不关
 * 群名/公告这类长文本在二级页给足高度；成员页一行一人，值日和移出各自独立按钮
 * （原来「点一下移出」既无提示也无撤销，误点就得关掉重来）。
 *
 * 状态全在 drawer 内的局部闭包：取消/关抽屉即丢弃，不写回 groups.current。
 * 保存成功才 initGroups + openGroupChat 重拉，失败原地留输入。 */

const GS_MS = 250;
const gs = {
  node: null, // drawer 元素
  overlay: null,
  page: "home", // home | basic | members | reply
  group: null, // 打开时的群快照（保存后由 openGroupChat 重拉覆盖）
  partners: [], // 可选执事（含已在群里的，成员页按 in/out 分组）
  draft: { name: "", notice: "" },
  timer: 0,
};

function groupSettingsOpen() {
  return Boolean(gs.node) && !gs.node.hidden && !gs.node.classList.contains("pop-closing");
}

function openGroupSettingsDrawer() {
  if (!groups.current) return;
  const overlay = el.groupSettingsOverlay;
  const drawer = el.groupSettingsDrawer;
  if (!overlay || !drawer) return;
  gs.node = drawer;
  gs.overlay = overlay;
  gs.group = groups.current;
  gs.page = "home";
  gs.draft = { name: gs.group.name, notice: gs.group.notice || "" };
  // 执事清单：加成员要用；先吃花名册缓存，随后再拉一次全量（不拦抽屉）
  gs.partners = state.partners.filter((p) => p.status === "active");
  void loadGroupPartnerOptions();

  clearTimeout(gs.timer);
  drawer.classList.remove("pop-closing");
  overlay.classList.remove("pop-closing");
  overlay.hidden = false;
  drawer.hidden = false;
  el.groupSettingsBtn?.setAttribute("aria-expanded", "true");
  renderGroupSettings();
  if (!noMotion.matches) {
    drawer.classList.remove("pop-open");
    overlay.classList.remove("pop-open");
    void drawer.offsetWidth;
    drawer.classList.add("pop-open");
    overlay.classList.add("pop-open");
  }
  gs.node.querySelector(".cs-icon-btn, .gs-row, .set-input")?.focus?.();
}

function closeGroupSettingsDrawer() {
  const drawer = gs.node;
  const overlay = gs.overlay;
  if (!drawer || drawer.hidden) return;
  el.groupSettingsBtn?.setAttribute("aria-expanded", "false");
  clearTimeout(gs.timer);
  const finish = () => {
    drawer.hidden = true;
    if (overlay) overlay.hidden = true;
    drawer.classList.remove("pop-open", "pop-closing");
    overlay?.classList.remove("pop-open", "pop-closing");
    drawer.replaceChildren();
    gs.page = "home";
    gs.group = null;
  };
  if (noMotion.matches) {
    finish();
    return;
  }
  drawer.classList.remove("pop-open");
  overlay?.classList.remove("pop-open");
  void drawer.offsetWidth;
  drawer.classList.add("pop-closing");
  overlay?.classList.add("pop-closing");
  gs.timer = setTimeout(finish, GS_MS);
}

/** 加人清单重拉：state.partners 可能只是一部分（花名册接口） */
async function loadGroupPartnerOptions() {
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    const list = (Array.isArray(data.partners) ? data.partners : []).filter((p) => p.status === "active");
    if (!list.length) return;
    gs.partners = list;
    if (groupSettingsOpen() && gs.page === "members") renderGroupSettings();
  } catch {
    /* 拉不到就维持现有成员视图 */
  }
}

/** 抽屉顶部：标题 + 返回（二级页）+ 关闭 */
function gsHead(title, { back = false } = {}) {
  const head = document.createElement("div");
  head.className = "cs-head";
  if (back) {
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "cs-icon-btn";
    backBtn.setAttribute("aria-label", "返回");
    backBtn.title = "返回";
    backBtn.append(csSvg(CS_ICONS.back));
    backBtn.addEventListener("click", () => {
      gs.page = "home";
      renderGroupSettings();
    });
    head.append(backBtn);
  }
  const titleNode = document.createElement("div");
  titleNode.className = "cs-head-title";
  titleNode.textContent = title;
  head.append(titleNode);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cs-icon-btn";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.title = "关闭 (Esc)";
  closeBtn.append(csSvg(CS_ICONS.x));
  closeBtn.addEventListener("click", closeGroupSettingsDrawer);
  head.append(closeBtn);
  return head;
}

function gsIcon(paths) {
  const span = document.createElement("span");
  span.className = "gs-row-icon";
  span.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return span;
}

const GS_ICONS = {
  // 群资料 = 文本框 + 笔
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  // 成员 = 两个人
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  // 回应口径 = 对话气泡 + 回声
  reply: '<path d="M8 9h8"/><path d="M8 13h6"/><path d="M20 15a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v1a3 3 0 0 0 3 3h2l3 3v-3h5a3 3 0 0 0 3-3z"/>',
  chevron: CS_ICONS.chevron,
};

function renderGroupSettings() {
  const drawer = gs.node;
  if (!drawer) return;
  const group = gs.group;
  if (!group) return;
  const scrollTop = drawer.querySelector(".cs-body")?.scrollTop ?? 0;
  drawer.replaceChildren();
  if (gs.page === "basic") renderGroupSettingsBasic(drawer);
  else if (gs.page === "members") renderGroupSettingsMembers(drawer);
  else if (gs.page === "reply") renderGroupSettingsReply(drawer);
  else renderGroupSettingsHome(drawer);
  const body = drawer.querySelector(".cs-body");
  if (body) body.scrollTop = scrollTop;
}

/** 首页：群身份 + 三行 + 删除 */
function renderGroupSettingsHome(drawer) {
  const group = gs.group;
  drawer.append(gsHead("群设置"));

  const body = document.createElement("div");
  body.className = "cs-body";

  const identity = document.createElement("div");
  identity.className = "gs-identity";
  const avatars = document.createElement("div");
  avatars.className = "gs-identity-avatars";
  for (const member of group.members.slice(0, 5)) {
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar";
    paintAvatar(avatar, groupMemberAvatar(member), member.name);
    avatar.title = member.name;
    avatars.append(avatar);
  }
  const name = document.createElement("div");
  name.className = "gs-identity-name";
  name.textContent = group.name;
  const meta = document.createElement("div");
  meta.className = "gs-identity-meta";
  const duty = group.members.find((m) => m.partnerId === group.responderPartnerId);
  meta.textContent = `${group.members.length} 名成员 · ${gsResponderLabel(group, duty)}`;
  identity.append(avatars, name, meta);
  body.append(identity);

  const row = (icon, title, sub, value, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gs-row";
    button.append(gsIcon(icon));
    const main = document.createElement("span");
    main.className = "gs-row-main";
    const titleNode = document.createElement("span");
    titleNode.className = "gs-row-title";
    titleNode.textContent = title;
    main.append(titleNode);
    if (sub) {
      const subNode = document.createElement("span");
      subNode.className = "gs-row-sub";
      subNode.textContent = sub;
      main.append(subNode);
    }
    button.append(main);
    if (value) {
      const valueNode = document.createElement("span");
      valueNode.className = "gs-row-value";
      valueNode.textContent = value;
      button.append(valueNode);
    }
    const chevron = document.createElement("span");
    chevron.className = "gs-row-chevron";
    chevron.append(csSvg(GS_ICONS.chevron));
    button.append(chevron);
    button.addEventListener("click", onClick);
    return button;
  };

  body.append(
    row(GS_ICONS.edit, "群资料", "群名和公告，公告随每轮输入带给成员", "查看", () => {
      gs.page = "basic";
      renderGroupSettings();
    }),
    (() => {
      const divider = document.createElement("div");
      divider.className = "gs-divider";
      return divider;
    })(),
    row(GS_ICONS.users, "成员", "2–6 名执事；值日执事在不 @ 时回话", `${group.members.length} 人`, () => {
      gs.page = "members";
      renderGroupSettings();
    }),
    (() => {
      const divider = document.createElement("div");
      divider.className = "gs-divider";
      return divider;
    })(),
    row(GS_ICONS.reply, "回应口径", "不 @ 时谁回：值日 / 全员 / 只回点名", gsResponderShort(group), () => {
      gs.page = "reply";
      renderGroupSettings();
    }),
  );

  const footer = document.createElement("div");
  footer.className = "gs-footer";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "gs-danger";
  del.textContent = "删除这个群…";
  del.addEventListener("click", () => confirmDeleteGroup(group));
  footer.append(del);
  body.append(footer);
  drawer.append(body);
}

function gsResponderShort(group) {
  if (group.responderKind === "everyone") return "全员都回";
  if (group.responderKind === "mentions") return "只回点名";
  const duty = group.members.find((m) => m.partnerId === group.responderPartnerId);
  return duty ? `值日 ${duty.name}` : "值日未设";
}

function gsResponderLabel(group, duty) {
  if (group.responderKind === "everyone") return "不 @ 时全员按顺序回";
  if (group.responderKind === "mentions") return "只有 @ 点名才有人回";
  return duty ? `不 @ 时 ${duty.name} 回` : "值日执事未设";
}

/** 二级页：群名 + 公告 */
function renderGroupSettingsBasic(drawer) {
  drawer.append(gsHead("群资料", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  const form = document.createElement("div");
  form.className = "gs-form";

  const nameField = document.createElement("label");
  nameField.className = "gs-field";
  const nameLabel = document.createElement("span");
  nameLabel.className = "gs-field-label";
  nameLabel.textContent = "群名";
  const nameInput = document.createElement("input");
  nameInput.className = "set-input";
  nameInput.type = "text";
  nameInput.maxLength = 40;
  nameInput.value = gs.draft.name;
  nameInput.addEventListener("input", () => {
    gs.draft.name = nameInput.value;
  });
  nameField.append(nameLabel, nameInput);

  const noticeField = document.createElement("label");
  noticeField.className = "gs-field";
  const noticeLabel = document.createElement("span");
  noticeLabel.className = "gs-field-label";
  noticeLabel.textContent = "群公告";
  const noticeInput = document.createElement("textarea");
  noticeInput.className = "set-input";
  noticeInput.maxLength = 500;
  noticeInput.placeholder = "可选。会随每轮输入带给发言的成员，适合写这个群是干什么的、有什么约定。";
  noticeInput.value = gs.draft.notice;
  noticeInput.addEventListener("input", () => {
    gs.draft.notice = noticeInput.value;
  });
  const note = document.createElement("div");
  note.className = "gs-pick-note";
  note.textContent = "公告是群级背景，不是指令；它不会给成员任何新权限。";
  noticeField.append(noticeLabel, noticeInput, note);

  const actions = document.createElement("div");
  actions.className = "gs-actions";
  const hint = document.createElement("p");
  hint.className = "set-hint";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn-primary";
  save.textContent = "保存";
  save.addEventListener("click", async () => {
    const nextName = nameInput.value.trim();
    if (!nextName) {
      hint.textContent = "群名不能为空。";
      hint.classList.add("is-error");
      return;
    }
    save.disabled = true;
    hint.textContent = "保存中…";
    hint.classList.remove("is-error");
    const response = await request(`/api/v1/groups/${encodeURIComponent(gs.group.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: nextName, notice: noticeInput.value }),
    }).catch(() => null);
    const data = await response?.json().catch(() => ({}));
    save.disabled = false;
    if (!response?.ok) {
      hint.textContent = data?.message || "保存失败";
      hint.classList.add("is-error");
      return;
    }
    gs.group = data.group ?? gs.group;
    groups.current = gs.group;
    gs.draft = { name: gs.group.name, notice: gs.group.notice || "" };
    await initGroups();
    await openGroupChat(gs.group.id);
    gs.page = "home";
    renderGroupSettings();
    toast("群资料已保存");
  });
  actions.append(hint, save);
  form.append(nameField, noticeField, actions);
  body.append(form);
  drawer.append(body);
  nameInput.focus();
}

/** 二级页：成员（一行一人；值日 / 移出各自独立；下方候选加人） */

export { GS_ICONS, GS_MS, closeGroupSettingsDrawer, groupSettingsOpen, gs, gsHead, gsIcon, gsResponderLabel, gsResponderShort, loadGroupPartnerOptions, openGroupSettingsDrawer, renderGroupSettings, renderGroupSettingsBasic, renderGroupSettingsHome };
