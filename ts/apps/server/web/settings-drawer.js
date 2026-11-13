/**
 * 对话右上角快捷设置抽屉
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { paintAvatar } from "./avatar.js";
import { el } from "./dom.js";
import { fetchModelCatalog, updateModelPill } from "./hover-tip.js";
import { CS_ICONS } from "./icons.js";
import { request } from "./net.js";
import { CS_PROFILE_PAGES, csPrimeArchive, renderCsArchivesPage } from "./settings-employee.js";
import { renderCsModelPage } from "./settings-model.js";
import { renderCsPolicyPage } from "./settings-permission.js";
import { renderCsPersonaPage } from "./settings-persona.js";
import { state } from "./state.js";
import { noMotion, toast } from "./ui-atoms.js";

/* ── 对话右上角快捷设置（2026-11-07 抽屉；2026-11-13 按 B 版重排）──
 * 右上角图标 → 右侧全高抽屉。2026-11-13 用户口径三条：
 *   ① 主选模型 / 备选模型两个入口进的是同一页，太绕 → 合成一行「模型」，一页里分两段；
 *   ② 通知不用单独设，跟随全局 → 抽屉里整条移除，只留一句脚注；
 *   ③ 权限确实有必要 → 保留一行一页；
 *   ④ 工作履历 / 记忆 / 例行规则 / 技能四类都改不了 → 只读，合成一页四个分段。
 * 首页 = 身份 + 模型/权限两个值格 + 四条档案行（条数 + 最近一条）+ 全部设置 + 脚注。
 * 底层聊天不卸载只挂浮层，滚动位置与输入内容天然保持。
 * 关闭三通道：Esc（输入法豁免）/ X / 点遮罩；关闭动画播完再卸载（照 popTimers 模式）。 */

const DRAWER_MS = 250;
/* 二级页 / 快捷设置抽屉的页状态：拆成多模块后由四处读写，收进一个对象（ESM 导入的绑定不能赋值）。
   字段沿用原变量名的后半段：csPage → cs.page。 */
const cs = {
  page: "home", archiveTab: "records", timer: 0,
  catalog: null, policy: null, target: null,
  detail: null, providers: null, archive: null, archiveJob: null,
};




const CS_POLICY_LABEL = { full: "完全访问", "read-only": "只读", "no-shell": "不跑命令" };
const CS_APPROVAL_LABEL = { "ask-all": "全部问我", "ask-critical": "只问重要的", none: "全不问" };

function drawerOpen() {
  return Boolean(el.chatSettingsDrawer) && !el.chatSettingsDrawer.hidden &&
    !el.chatSettingsDrawer.classList.contains("pop-closing");
}

function openDrawer() {
  const drawer = el.chatSettingsDrawer;
  const overlay = el.chatSettingsOverlay;
  if (!drawer || !overlay) return;
  clearTimeout(cs.timer);
  drawer.classList.remove("pop-closing");
  overlay.classList.remove("pop-closing");
  drawer.hidden = false;
  overlay.hidden = false;
  el.chatSettingsBtn.setAttribute("aria-expanded", "true");
  if (noMotion.matches) return;
  // 先摘 class 并强制重排，连续开关时动画才会重放（同 openPopover）
  drawer.classList.remove("pop-open");
  overlay.classList.remove("pop-open");
  void drawer.offsetWidth;
  drawer.classList.add("pop-open");
  overlay.classList.add("pop-open");
}

function closeDrawer() {
  const drawer = el.chatSettingsDrawer;
  const overlay = el.chatSettingsOverlay;
  if (!drawer || drawer.hidden) return;
  el.chatSettingsBtn.setAttribute("aria-expanded", "false");
  clearTimeout(cs.timer);
  const finish = () => {
    drawer.hidden = true;
    overlay.hidden = true;
    drawer.classList.remove("pop-open", "pop-closing");
    overlay.classList.remove("pop-open", "pop-closing");
    cs.page = "home";
  };
  if (noMotion.matches) {
    finish();
    return;
  }
  drawer.classList.remove("pop-open");
  overlay.classList.remove("pop-open");
  void drawer.offsetWidth;
  drawer.classList.add("pop-closing");
  overlay.classList.add("pop-closing");
  cs.timer = setTimeout(finish, DRAWER_MS);
}

function closeChatSettings() {
  closeDrawer();
}

/**
 * 打开抽屉并落在指定页（2026-11-09 从 toggleChatSettings 抽出）。
 * 目标与页面都由调用方给：常规入口传 csResolveTarget() / home，
 * 花名册「档案」直达传 partnerId / 某个档案页，不靠猜当前会话。
 */
async function openDrawerAt(target, page) {
  el.chatSettingsBtn.disabled = true;
  try {
    // 每次打开都现拉：不缓存陈旧目录（同模型菜单口径）
    cs.catalog = await fetchModelCatalog();
    state.modelCatalog = cs.catalog;
    updateModelPill();
    cs.target = target;
    cs.page = page;
    cs.detail = null;
    // 档案数据每次开抽屉现拉：条数可能刚被一轮对话改过，不吃上次的缓存
    cs.archive = null;
    cs.archiveJob = null;
    renderCsPage();
    openDrawer();
    // 权限档 / 人设详情顺带拉；回来若还停在对应页就重渲染补上
    void refreshCsPolicy();
    void refreshCsDetail();
  } catch (error) {
    if (error.message !== "forbidden") toast("拿不到模型清单");
  } finally {
    el.chatSettingsBtn.disabled = false;
  }
}

async function toggleChatSettings() {
  if (drawerOpen()) {
    closeChatSettings();
    return;
  }
  await openDrawerAt(csResolveTarget(), "home");
}

/**
 * 当前角色的详情（SOUL / 版本 / 候选链）。模型目录与供应商投影都不含这些，
 * 而「人设」和「备选模型」都要用，所以打开抽屉时拉一次、保存后再拉。
 */
async function refreshCsDetail({ after } = {}) {
  if (!cs.target) return;
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(cs.target)}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    if (!data?.ok) return;
    cs.detail = data;
    // 花名册里的头像 / 名字可能比详情旧，就手同步一份（侧栏也用这份缓存）
    const cached = state.partners.find((item) => item.id === cs.target);
    if (cached && data.partner) Object.assign(cached, data.partner);
    // 只在首页重渲染补副文本；人设页不整体重画——用户可能已经进去在打字了，
    // 详情恰好晚到会把草稿整个换掉。人设页确实在等数据时，走 after 回调自己重画一次。
    if (drawerOpen() && cs.page === "home") renderCsPage();
    after?.();
  } catch {
    /* 拉不到就维持现有副文本，不拦抽屉 */
  }
}

/** 供应商全量投影：备选链每项要 keyEnv，模型目录（/agent/model）里没有这个字段 */
async function csLoadProviders() {
  if (cs.providers) return cs.providers;
  try {
    const response = await request("/api/v1/agent/providers", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    cs.providers = Array.isArray(data.providers) ? data.providers : [];
    return cs.providers;
  } catch {
    return null;
  }
}

/** 执事详情里的候选链（详情没拉到时回落到空，避免副文本报错） */
function partnerModelChain() {
  const chain = cs.detail && Array.isArray(cs.detail.modelChain) ? cs.detail.modelChain : [];
  return chain;
}

async function refreshCsPolicy() {
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    if (response.ok) {
      cs.policy = await response.json();
      if (cs.page === "home" && drawerOpen()) renderCsHome();
      // 写失败回滚：重渲染权限档页，用服务端真值覆盖乐观切档
      else if (cs.page === "policy" && drawerOpen()) renderCsPolicyPage();
    }
  } catch {
    /* 拉不到就显示 —，不拦抽屉 */
  }
}

function csSvg(paths) {
  const span = document.createElement("span");
  span.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return span;
}

function csHead(title, { back = false } = {}) {
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
      cs.page = "home";
      renderCsPage();
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
  closeBtn.addEventListener("click", () => closeChatSettings());
  head.append(closeBtn);
  return head;
}

function csRow({ icon, title, sub, value, onClick, current = false }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "cs-row";
  if (current) row.setAttribute("aria-current", "true");
  if (icon) {
    const iconNode = document.createElement("span");
    iconNode.className = "cs-row-icon";
    iconNode.append(csSvg(CS_ICONS[icon] || ""));
    row.append(iconNode);
  }
  const main = document.createElement("span");
  main.className = "cs-row-main";
  const titleNode = document.createElement("span");
  titleNode.className = "cs-row-title";
  titleNode.textContent = title;
  main.append(titleNode);
  if (sub) {
    const subNode = document.createElement("span");
    subNode.className = "cs-row-sub";
    subNode.textContent = sub;
    subNode.title = sub;
    main.append(subNode);
  }
  row.append(main);
  if (value) {
    const valueNode = document.createElement("span");
    valueNode.className = "cs-row-value";
    valueNode.textContent = value;
    row.append(valueNode);
  }
  const chevron = document.createElement("span");
  chevron.className = "cs-row-chevron";
  chevron.append(csSvg(CS_ICONS.chevron));
  row.append(chevron);
  row.addEventListener("click", onClick);
  return row;
}

/** 抽屉页面壳：换页只换内容，壳不卸载（抽屉开着时底层聊天与滚动不受影响） */
function renderCsPage() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  const body = drawer.querySelector(".cs-body");
  const keepScroll = body ? body.scrollTop : 0;
  // 四个档案页（含花名册「档案」直达传进来的 "records"）统一落到「档案」一页的对应分段，
  // 页面只有一页、分段记住上次看的是哪一类。
  if (CS_PROFILE_PAGES[cs.page]) {
    cs.archiveTab = cs.page;
    cs.page = "archives";
  }
  if (cs.page === "persona") renderCsPersonaPage();
  else if (cs.page === "model") renderCsModelPage();
  else if (cs.page === "policy") renderCsPolicyPage();
  else if (cs.page === "archives") void renderCsArchivesPage();
  else renderCsHome();
  const next = drawer.querySelector(".cs-body");
  if (next) next.scrollTop = cs.page === "home" ? keepScroll : 0;
}

/** 卡片容器：一组成设置行，行间 1px 分割（视觉与设置页同语言，只是收在 448px 里） */
function csCard(label) {
  const card = document.createElement("div");
  card.className = "cs-card";
  if (label) {
    const head = document.createElement("div");
    head.className = "cs-card-label";
    head.textContent = label;
    card.append(head);
  }
  return card;
}

/**
 * 当前这条对话归谁：决定首页「人设」改的是哪个角色。
 *  - `partner-<id>`：执事主会话 → 该执事；
 *  - `partner-<id>-group-<gid>`：群成员轮次 → 该成员（群设置另有入口）；
 *  - chief：总管。总管就是主对话的身份——侧栏统一批之后「主会话」不再单独存在；
 *  - worker：普通助手会话，**没有角色可改**（它的人格是服务端的 WORKER_PERSONA，
 *    不是某个执事也不是总管）→ 返回 null，界面不摆人设入口，避免「改了总管、
 *    却以为改的是当前这个助手」这种谎报。
 */
function csResolveTarget() {
  const id = state.conversationId || "";
  if (id.startsWith("partner-")) {
    const rest = id.slice("partner-".length);
    const groupAt = rest.indexOf("-group-");
    const partnerId = groupAt >= 0 ? rest.slice(0, groupAt) : rest;
    return partnerId || null;
  }
  // 身份以服务端回读的 chatKind 为准（缺字段的旧会话按 chief，保住老数据）
  return state.chatKind === "worker" ? null : "chief";
}

/**
 * 首页顶部身份块：**横排一行**（头像 + 名字/版本 + chevron），整块进「人设」。
 *
 * 2026-11-07 二次修：原来是居中竖排（大头像 + 名字 + 版本 + 改人设），
 * 在 448px 抽屉里占了近 1/5 屏高、下方还留一片空白，读起来像「个人主页」
 * 而不是设置面板。设置面板的账号区应当是**一行**，与下面的设置行同节奏。
 */
function csIdentityNode(partner) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "cs-identity";
  node.title = "改人设（头像 / 名字 / 正文）";

  const avatar = document.createElement("span");
  avatar.className = "pt-avatar";
  const name = String(partner?.name || "").trim() || "总管";
  paintAvatar(avatar, partner?.avatar || null, name);
  node.append(avatar);

  const main = document.createElement("span");
  main.className = "cs-identity-main";
  const nameNode = document.createElement("span");
  nameNode.className = "cs-identity-name";
  nameNode.textContent = name;
  main.append(nameNode);
  const sub = document.createElement("span");
  sub.className = "cs-identity-sub";
  const version = cs.detail ? cs.detail.soulVersion : partner?.soulVersion;
  sub.textContent = version != null ? `人设 v${version} · 点头像或名字改` : "还没写过人设 · 点这里写";
  main.append(sub);
  node.append(main);

  const chevron = document.createElement("span");
  chevron.className = "cs-row-chevron";
  chevron.append(csSvg(CS_ICONS.chevron));
  node.append(chevron);

  node.addEventListener("click", () => {
    cs.page = "persona";
    renderCsPage();
  });
  return node;
}

/** 首页的值格：标签小字 + 值 + 一行副文本（B 版；两块并排，一眼看全「这一位」的两件事） */
function csTile({ label, value, sub, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cs-tile";
  const labelNode = document.createElement("span");
  labelNode.className = "cs-tile-label";
  labelNode.textContent = label;
  const valueNode = document.createElement("span");
  valueNode.className = "cs-tile-value";
  valueNode.textContent = value;
  valueNode.title = value;
  const subNode = document.createElement("span");
  subNode.className = "cs-tile-sub";
  subNode.textContent = sub;
  subNode.title = sub;
  button.append(labelNode, valueNode, subNode);
  button.addEventListener("click", onClick);
  return button;
}

function renderCsHome() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  drawer.replaceChildren(csHead("对话设置"));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）

  const current = cs.catalog && cs.catalog.current;
  const partner = state.partners.find((item) => item.id === cs.target) || null;
  const chain = cs.target ? partnerModelChain() : [];
  const archive = cs.archive && cs.archive.target === cs.target ? cs.archive : null;

  // 身份块 = 人设入口（点头像/名字整块进去）。它自己就是那一行，
  // 不再另立一条「这个角色 → 人设」——两个入口指同一页，只会让人多点一次。
  // 普通助手会话没有角色可改（人格在服务端），不摆身份块也不摆人设行。
  if (cs.target) body.append(csIdentityNode(partner));

  // 模型 / 权限 = 两个值格。主选与备选是同一件东西的两段（同一个页面），
  // 所以首页只留一个「模型」入口，段内的区分交给二级页（2026-11-13 用户口径）。
  const tiles = document.createElement("div");
  tiles.className = "cs-tiles";
  tiles.append(
    csTile({
      label: "模型",
      value: current ? current.modelId : "—",
      sub: cs.target
        ? chain.length
          ? `备选 ${chain.length} 条 · 只在试跑与例行任务换`
          : "没配备选 · 主对话只有这一条"
        : "全局模型，所有对话共用",
      onClick: () => {
        cs.page = "model";
        renderCsPage();
      },
    }),
    csTile({
      label: "权限",
      value: cs.policy && cs.policy.access ? CS_POLICY_LABEL[cs.policy.access] || cs.policy.access : "—",
      sub:
        cs.policy && cs.policy.approvalLevel
          ? `审批 · ${CS_APPROVAL_LABEL[cs.policy.approvalLevel] || cs.policy.approvalLevel}`
          : "—",
      onClick: () => {
        cs.page = "policy";
        renderCsPage();
      },
    }),
  );
  body.append(tiles);

  // 员工档案（2026-11-09；2026-11-13 合并成一页四个分段）：四条行显示条数与最近一条，
  // 点进去落到同一页的对应分段。普通助手会话没有角色（csTarget=null），不摆这组——
  // 摆了点进去只有说明，等于噪声（与「身份块」同口径）。
  if (cs.target) {
    const profileCard = csCard("档案 · 只读");
    for (const [key, config] of Object.entries(CS_PROFILE_PAGES)) {
      const count = archive ? config.count(archive) : null;
      profileCard.append(
        csRow({
          icon: config.icon,
          title: config.title,
          sub: archive ? config.preview(archive) || config.sub : config.sub,
          value: count == null ? "" : `${count} ${config.unit}`,
          onClick: () => {
            cs.page = key;
            renderCsPage();
          },
        }),
      );
    }
    body.append(profileCard);
  }

  const allCard = csCard();
  allCard.append(
    csRow({
      icon: "settings",
      title: "全部设置",
      sub: "供应商、密钥、记忆、连接手机…",
      onClick: () => {
        closeChatSettings();
        location.hash = "#/settings";
      },
    }),
  );
  body.append(allCard);

  // 通知与外观是全局的，抽屉里不再单设（2026-11-13 用户口径）——留一句脚注说明去处
  const foot = document.createElement("p");
  foot.className = "cs-note";
  foot.textContent = "通知与外观跟随全局设置，这里不再重复一遍。";
  body.append(foot);

  drawer.append(body);

  // 条数与「最近一条」首帧还没有：后台拉一次，回来只重画首页（失败就维持静态副文本）
  if (cs.target && !archive) void csPrimeArchive(cs.target);
}

export { CS_APPROVAL_LABEL, CS_POLICY_LABEL, DRAWER_MS, closeChatSettings, closeDrawer, cs, csCard, csHead, csIdentityNode, csLoadProviders, csResolveTarget, csRow, csSvg, csTile, drawerOpen, openDrawer, openDrawerAt, partnerModelChain, refreshCsDetail, refreshCsPolicy, renderCsHome, renderCsPage, toggleChatSettings };
