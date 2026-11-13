/**
 * 建群弹窗
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar } from "./avatar.js";
import { groups, initGroups } from "./groups-base.js";
import { fetchPartnerOptions } from "./groups-settings-panels.js";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN } from "./groups-thread.js";
import { request } from "./net.js";
import { clearModalHint, setModalHint } from "./project-modal.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";


/* ── 建群弹窗（2026-11-07 统一语言）──────────────────────────
 * 原实现挂的是 `text-input`——这个类在 style.css 里根本不存在，于是群名/公告退化成
 * 浏览器默认控件（2px 直角灰框、14px），和同项目「新建执事」的 .modal-input 并排像两个产品；
 * 成员勾选是 13px 原生复选框（Windows 蓝勾），值日执事在勾人前是一块空白。
 *
 * 现在回到模态既有语言（.modal-field + .modal-input + .modal-desc + .modal-actions）：
 *   群名 / 成员 / 公告 三个字段，成员一行一人（头像 + 名字 + 右侧「加入/值日」），
 *   值日不再是独立区域——就在成员行里选，勾人不用再理解一个方框，也不多一块空区。
 * 元素只减不加：原先是「输入框 + 提示 + 勾选块 + 值日块 + 公告 + 按钮」，现在少两块。 */

async function openCreateGroupModal() {
  const partners = await fetchPartnerOptions();
  if (!partners) return;
  if (partners.length < 2) {
    toast("至少要有 2 名执事才能建群，先去侧栏「执事」新建。");
    return;
  }
  groups.picked = [];
  openModal("新建群组", (body) => {
    const desc = document.createElement("p");
    desc.className = "modal-desc";
    desc.textContent = "拉 2–6 位成员进同一条会话。不 @ 就发给值日，@名字 点名谁回。";

    // ── 群名 ──
    const nameField = document.createElement("label");
    nameField.className = "modal-field";
    const nameLabel = document.createElement("span");
    nameLabel.textContent = "群名";
    const nameInput = document.createElement("input");
    nameInput.className = "modal-input";
    nameInput.type = "text";
    nameInput.maxLength = 40;
    nameInput.placeholder = "例如：书房小事";
    nameField.append(nameLabel, nameInput);

    // ── 成员：一行一人，右侧是「加入 / 值日」两个互斥态 ──
    const memberField = document.createElement("div");
    memberField.className = "modal-field";
    const memberLabel = document.createElement("span");
    memberLabel.className = "gcf-label";
    const memberCount = document.createElement("span");
    memberCount.className = "gcf-count";
    memberLabel.append("成员", memberCount);

    const list = document.createElement("div");
    list.className = "gcf-list";
    let dutyChoice = "";

    const validate = () => {
      const count = groups.picked.length;
      memberCount.textContent = `${count} / ${GROUP_MEMBER_MAX}`;
      // 值日必须还在群里：把人移出去时顺手清掉，不让"值日指向已移出的人"这种半截状态存在
      if (dutyChoice && !groups.picked.includes(dutyChoice)) dutyChoice = "";
      submit.disabled = count < GROUP_MEMBER_MIN || count > GROUP_MEMBER_MAX;
      submit.title = submit.disabled ? `需要 ${GROUP_MEMBER_MIN}–${GROUP_MEMBER_MAX} 名成员` : "";
    };

    const rowOf = (partner) => {
      const row = document.createElement("div");
      row.className = "gcf-row";
      row.dataset.partner = partner.id;
      const avatar = document.createElement("span");
      avatar.className = "pt-avatar";
      paintAvatar(avatar, partner.avatar || null, partner.name);
      const name = document.createElement("span");
      name.className = "gcf-name";
      name.textContent = partner.name;
      const role = document.createElement("div");
      role.className = "gcf-role";

      const toggle = () => {
        const picked = groups.picked.includes(partner.id);
        if (picked) {
          groups.picked = groups.picked.filter((id) => id !== partner.id);
          // 值日只在成员之间传递，不留空：移走值日就把值日交给还在群里的第一位。
          // 若留着空，「不 @ 时谁回」在提交前就没人能答（提交会默默补第一位，界面与结果不一致）。
          if (dutyChoice === partner.id) dutyChoice = groups.picked[0] ?? "";
        } else if (groups.picked.length < GROUP_MEMBER_MAX) {
          groups.picked.push(partner.id);
          if (!dutyChoice) dutyChoice = partner.id;
        } else toast(`最多 ${GROUP_MEMBER_MAX} 名成员，先移出一位`);
        renderRows(partner.id);
      };

      const isMember = groups.picked.includes(partner.id);
      // 已在群里时「移除」收成一个 ×：两个文字并排（移除 / 设为值日）会读成一串动作，
      // 而移出是低频、次要、且不可撤销的那一个——图标最省字也最不容易误读。
      const joinBtn = document.createElement("button");
      joinBtn.type = "button";
      joinBtn.className = isMember ? "gcf-chip is-leave" : "gcf-chip is-join";
      if (isMember) {
        joinBtn.setAttribute("aria-label", `把 ${partner.name} 移出群`);
        joinBtn.title = "移出群";
        joinBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      } else {
        joinBtn.textContent = "加入";
      }
      joinBtn.addEventListener("click", toggle);

      if (isMember) {
        // 值日只做"指向"，不做"关掉"：群建出来必须有一个人接不 @ 的话，
        // 所以当前值日是不可点标记（点掉它就出现"谁都不值日"的假状态），
        // 换人请点别人那行的「设为值日」。省一个按钮态，也省一次误操作。
        if (dutyChoice === partner.id) {
          const badge = document.createElement("span");
          badge.className = "gcf-duty";
          badge.textContent = "值日";
          badge.title = "不 @ 任何人时，由这位回话";
          role.append(badge);
        } else {
          const dutyBtn = document.createElement("button");
          dutyBtn.type = "button";
          dutyBtn.className = "gcf-chip is-duty";
          dutyBtn.textContent = "设为值日";
          dutyBtn.title = "不 @ 任何人时，由这位回话";
          dutyBtn.addEventListener("click", () => {
            dutyChoice = partner.id;
            renderRows(partner.id);
          });
          role.append(dutyBtn);
        }
      }
      // 总管进群就是普通成员（方案 §2.1）：名字旁边不再挂一个同字的「总管」标签，
      // 那既重复又像头衔；身份差异放在 title 里，只在需要时出现。
      if (partner.id === "chief") {
        row.title = "总管进群后是普通成员，与其他人一样可以被 @、被设为值日";
      }
      // 四列定宽：头像 | 名字 | 动作槽（加入/设为值日，右对齐）| 移出槽（固定 22px）。
      // 两列分开而不是塞进同一个 flex，"加入/移除" 宽度差就不会把 × 推来推去。
      if (!isMember) {
        role.append(joinBtn);
        const spacer = document.createElement("span");
        spacer.className = "gcf-x-slot";
        row.append(avatar, name, role, spacer);
      } else {
        row.append(avatar, name, role, joinBtn);
      }
      return row;
    };

    const renderRows = (focusId) => {
      list.replaceChildren();
      for (const partner of partners) list.append(rowOf(partner));
      validate();
      // 整块重建会丢焦点：点完「加入」光标飞回弹窗顶部，键盘用户得重新 Tab 一遍。
      // 有明确操作对象时把焦点落回他那一行（优先「加入/移除」，其次「值日」）。
      if (focusId) {
        const row = list.querySelector(`[data-partner="${CSS.escape(focusId)}"]`);
        const target = row?.querySelector(".gcf-chip");
        if (target instanceof HTMLElement) target.focus();
      }
    };

    memberField.append(memberLabel, list);

    // ── 公告 ──
    const noticeField = document.createElement("label");
    noticeField.className = "modal-field";
    const noticeLabel = document.createElement("span");
    noticeLabel.textContent = "群公告（可选）";
    const noticeInput = document.createElement("input");
    noticeInput.className = "modal-input";
    noticeInput.type = "text";
    noticeInput.maxLength = 500;
    noticeInput.placeholder = "一句话说清这个群是干什么的";
    noticeField.append(noticeLabel, noticeInput);

    // ── 动作条 ──
    const row = document.createElement("div");
    row.className = "modal-actions";
    const hint = document.createElement("p");
    hint.className = "modal-hint";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "取消";
    cancel.addEventListener("click", closeModal);
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "modal-primary";
    submit.textContent = "建群";
    submit.disabled = true;

    submit.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        setModalHint(hint, "先给群起个名字。");
        nameInput.focus();
        return;
      }
      if (groups.picked.length < GROUP_MEMBER_MIN || groups.picked.length > GROUP_MEMBER_MAX) {
        setModalHint(hint, `成员要 ${GROUP_MEMBER_MIN}–${GROUP_MEMBER_MAX} 名执事`);
        return;
      }
      // 值日缺省取第一位成员：建群的主路径不该卡在一个"还得再点一下"的必填项上
      const duty = dutyChoice || groups.picked[0] || "";
      submit.disabled = true;
      setModalHint(hint, "建群中…", false);
      const response = await request("/api/v1/groups", {
        method: "POST",
        body: JSON.stringify({
          name,
          memberIds: groups.picked,
          responderKind: "member",
          responderPartnerId: duty,
          notice: noticeInput.value.trim(),
        }),
      }).catch(() => null);
      const data = await response?.json().catch(() => ({}));
      if (!response?.ok) {
        submit.disabled = false;
        setModalHint(hint, data?.message || data?.error || "建群失败");
        return;
      }
      closeModal();
      toast("群组建好了");
      await initGroups();
      location.hash = `#/group/${data.group.id}`;
    });

    nameInput.addEventListener("input", () => clearModalHint(hint));
    row.append(hint, cancel, submit);
    body.append(desc, nameField, memberField, noticeField, row);
    renderRows();
    nameInput.focus();
  });
}

export { openCreateGroupModal };
