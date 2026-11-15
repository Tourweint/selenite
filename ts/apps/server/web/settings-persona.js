/**
 * 二级页 · 人设
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar } from "./avatar.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { openAvatarPanel } from "./partner-editor.js";
import { loadRoster, syncChiefAvatar } from "./partners-status.js";
import { appendCsContractCard, appendCsGoalCard } from "./settings-contract.js";
import { cs, csCard, csHead, drawerOpen, refreshCsDetail, renderCsPage } from "./settings-drawer.js";
import { state } from "./state.js";
import { showRollbackOffer } from "./soul-rollback.js";

/* ── 二级页 · 人设：头像 + 名字 + 正文，一次保存 ──────────────
 * 用户口径（2026-11-07）：「调整人设这里都应该加到右上角这里头」「换头像啥的其实无所谓，
 * 但是也可以换，就在设置里」「调整人物的页面，和打开一个人后点击右上角那个设置页面，
 * 这两个应该是差不多的，都可以用 EP（API）接口」。
 *
 * 所以这一页与「全部设置 → 人设 → 改人设」是**同一件事、同一批接口**：
 *   GET   /api/v1/partners/:id      → soul / soulVersion / modelChain
 *   PATCH /api/v1/partners/:id      → 头像 + 名字 + 正文同一次提交（服务端本来就支持多槽位，
 *                                      任一不合法整批 400，不会半写）
 * 头像是人设的一部分（2026-11-07 用户已合并过一次），所以这里头像按钮与正文同页，
 * 不另开「换头像」入口。头像预设面板与弹窗共用同一份实现（openAvatarPanel）。
 */
function renderCsPersonaPage() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  drawer.replaceChildren(csHead("人设", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）
  drawer.append(body);

  if (!cs.target) {
    const note = document.createElement("p");
    note.className = "cs-note";
    note.textContent =
      "这条是普通助手会话，它的身份由服务端固定，没有可改的人设。到「全部设置 → 人设」可以改总管和各个执事。";
    body.append(note);
    return;
  }

  const partner = state.partners.find((item) => item.id === cs.target) || null;
  const name = String(partner?.name || "").trim() || "总管";
  const soul = cs.detail ? String(cs.detail.soul ?? "") : "";

  if (!cs.detail) {
    const loading = document.createElement("p");
    loading.className = "cs-note";
    loading.textContent = "读取中…";
    body.append(loading);
    // 等这一次详情回来再画：此时还没进编辑状态，重画不会覆盖任何草稿
    void refreshCsDetail({
      after: () => {
        if (drawerOpen() && cs.page === "persona" && cs.detail) renderCsPage();
      },
    });
    return;
  }

  /* 头像 + 名字 */
  const headCard = csCard();
  const headField = document.createElement("div");
  headField.className = "cs-field";
  headField.style.flexDirection = "row";
  headField.style.alignItems = "center";
  headField.style.gap = "14px";

  const avatarBtn = document.createElement("button");
  avatarBtn.type = "button";
  avatarBtn.className = "pt-avatar avatar-edit pt-portrait-btn";
  avatarBtn.id = "cs-avatar";
  avatarBtn.title = "换一张头像";
  avatarBtn.setAttribute("aria-label", "更换头像");
  avatarBtn.setAttribute("aria-haspopup", "dialog");
  avatarBtn.setAttribute("aria-expanded", "false");
  avatarBtn.style.width = "56px";
  avatarBtn.style.height = "56px";
  avatarBtn.style.fontSize = "22px";
  const chev = document.createElement("span");
  chev.className = "pt-portrait-chev";
  chev.setAttribute("aria-hidden", "true");
  chev.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  avatarBtn.append(chev);

  const nameBox = document.createElement("div");
  nameBox.style.flex = "1";
  nameBox.style.minWidth = "0";
  nameBox.style.display = "flex";
  nameBox.style.flexDirection = "column";
  nameBox.style.gap = "6px";
  const nameLabel = document.createElement("span");
  nameLabel.className = "cs-field-label";
  nameLabel.textContent = "名字";
  const nameInput = document.createElement("input");
  nameInput.className = "cs-input";
  nameInput.id = "cs-persona-name";
  nameInput.type = "text";
  nameInput.maxLength = 40;
  nameInput.value = name;
  nameInput.setAttribute("aria-label", "名字");
  nameBox.append(nameLabel, nameInput);
  headField.append(avatarBtn, nameBox);
  headCard.append(headField);

  // 版本说明挂在名字框下面（同一个列里），不单独占一行卡片底边——
  // 原来它带 border-top 挂在卡片尾部，读起来像一条游离的脚注。
  const versionNode = document.createElement("span");
  versionNode.className = "cs-hint";
  versionNode.style.padding = "0";
  // 快照退役（2026-11-15）：不再展示版本号，只说生效时机
  versionNode.textContent = "改完下一轮起用";
  nameBox.append(versionNode);
  body.append(headCard);

  /* 正文 */
  const soulCard = csCard("它是谁、怎么说话、守什么规矩");
  const soulField = document.createElement("div");
  soulField.className = "cs-field";
  const soulArea = document.createElement("textarea");
  soulArea.className = "cs-textarea is-soul";
  soulArea.id = "cs-persona-soul";
  soulArea.rows = 8;
  soulArea.spellcheck = false;
  soulArea.value = soul;
  soulArea.style.minHeight = "168px";
  soulArea.style.fontFamily = "inherit";
  soulArea.style.fontSize = "13px";
  soulArea.style.lineHeight = "1.7";
  soulArea.setAttribute("aria-label", "人设正文");
  soulArea.placeholder = "例：你叫阿岚，是这个家的管事。说话短、先给结论；不确定就直说，不要编。";
  soulField.append(soulArea);
  soulCard.append(soulField);

  const hint = document.createElement("div");
  hint.className = "cs-hint";
  hint.id = "cs-persona-hint";
  hint.style.padding = "0 14px";
  soulCard.append(hint);

  const actions = document.createElement("div");
  actions.className = "cs-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ghost";
  reset.id = "cs-persona-reset";
  reset.textContent = "撤销改动";
  reset.disabled = true;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn-primary";
  save.id = "cs-persona-save";
  save.textContent = "保存";
  save.disabled = true;
  actions.append(reset, save);
  soulCard.append(actions);
  body.append(soulCard);

  // 岗位契约 / 当前目标：与 SOUL 同一套卡片语言，各自独立保存（2026-11-08 员工人格化刀三）
  appendCsContractCard(body);
  appendCsGoalCard(body);

  /* 头像草稿：点头像弹共用面板，选中只改预览，保存才写 */
  let avatarDraft = partner?.avatar || null;
  let saving = false;
  let decoding = false;
  const original = { avatar: partner?.avatar || null, name, soul };
  const shown = () => {
    const currentName = nameInput.value.trim() || "总管";
    paintAvatar(avatarBtn, avatarDraft, currentName);
  };
  // chev 是常驻子节点，paintAvatar 会 replaceChildren 把它清掉——每次重画后补回
  const paintAvatarWithChev = () => {
    shown();
    avatarBtn.append(chev);
  };
  const isDirty = () =>
    avatarDraft !== original.avatar ||
    (nameInput.value.trim() || "") !== original.name ||
    soulArea.value !== original.soul;
  const refresh = () => {
    const dirty = isDirty();
    const valid = Boolean(soulArea.value.trim()) && Boolean(nameInput.value.trim());
    save.disabled = saving || decoding || !dirty || !valid;
    reset.disabled = saving || decoding || !dirty;
    avatarBtn.disabled = saving;
    nameInput.disabled = saving;
    soulArea.disabled = saving;
  };
  paintAvatarWithChev();
  refresh();

  avatarBtn.addEventListener("click", () => {
    if (saving) return;
    openAvatarPanel({
      anchor: avatarBtn,
      current: avatarDraft,
      onPick: (dataUrl) => {
        avatarDraft = dataUrl;
        paintAvatarWithChev();
        hint.textContent = dataUrl ? "头像已选好，点「保存」一起生效。" : "已改为不使用头像：保存后显示名字首字。";
        hint.classList.remove("is-error");
        refresh();
      },
      onBusy: (busy, message) => {
        decoding = busy;
        if (message) {
          hint.textContent = message;
          hint.classList.toggle("is-error", message.includes("不能") || message.includes("读不出"));
        }
        refresh();
      },
    });
  });
  nameInput.addEventListener("input", () => {
    paintAvatarWithChev();
    hint.textContent = "";
    hint.classList.remove("is-error");
    refresh();
  });
  soulArea.addEventListener("input", () => {
    hint.textContent = "";
    hint.classList.remove("is-error");
    refresh();
  });
  reset.addEventListener("click", () => {
    avatarDraft = original.avatar;
    nameInput.value = original.name;
    soulArea.value = original.soul;
    paintAvatarWithChev();
    hint.textContent = "";
    hint.classList.remove("is-error");
    refresh();
  });

  save.addEventListener("click", async () => {
    const nextName = nameInput.value.trim();
    const nextSoul = soulArea.value;
    if (!nextName) {
      hint.textContent = "名字不能为空。";
      hint.classList.add("is-error");
      nameInput.focus();
      return;
    }
    if (!nextSoul.trim()) {
      hint.textContent = "人设不能是空的。";
      hint.classList.add("is-error");
      soulArea.focus();
      return;
    }
    if (saving || decoding) return;
    saving = true;
    refresh();
    hint.classList.remove("is-error");
    hint.textContent = "保存中…";
    // 同一个 PATCH 提交：服务端先整体校验再写，头像 / 名字 / 正文不会半写
    const payload = {};
    if (nextName !== original.name) payload.name = nextName;
    if (nextSoul !== original.soul) payload.soul = nextSoul;
    if (avatarDraft !== original.avatar) payload.avatar = avatarDraft;
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(cs.target)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        hint.textContent = data.message || data.error || `没存成：HTTP ${response.status}`;
        hint.classList.add("is-error");
        return;
      }
      // 基准推进到服务端回读值：再点保存不会重复提交同样内容
      original.name = nextName;
      original.soul = nextSoul;
      original.avatar = avatarDraft;
      const cached = state.partners.find((item) => item.id === cs.target);
      if (cached && data.partner) Object.assign(cached, data.partner);
      if (cs.detail) {
        cs.detail.soul = nextSoul;
        if (data.soulVersion != null) cs.detail.soulVersion = data.soulVersion;
        if (data.partner) cs.detail.partner = { ...(cs.detail.partner || {}), ...data.partner };
      }
      versionNode.textContent = "下一轮起用";
      // 快照退役（2026-11-15）：保存成功后给一次「回到上一版」，不展示版本号
      hint.textContent = "已保存，下一轮起用。";
      showRollbackOffer(hint, cs.target, (restored) => {
        soulArea.value = restored;
        original.soul = restored;
        if (cs.detail) cs.detail.soul = restored;
        refresh();
      });
      syncChiefAvatar();
      void loadRoster();
      refresh();
    } catch (error) {
      if (error.message === "forbidden") return;
      hint.textContent = `没存成：${error.message}`;
      hint.classList.add("is-error");
    } finally {
      saving = false;
      refresh();
    }
  });
}

export { renderCsPersonaPage };
