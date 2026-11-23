/**
 * 二级页 · 人设（C 版，2026-11-14）
 *
 * 用户口径：「改人设」不该是一张要塞下所有东西的弹窗——一个同事有一整套档案：
 * 它是谁、岗位怎么定、会什么。所以从「设置 → 人设」的卡片点进去 = 换一页，
 * 面包屑回得去，一页从上往下看全。入口仍是 #/settings/partners/<id>。
 *
 * 三段与数据来源（全部已有端点，零新接口）：
 *   人设：GET /partners/:id（soul/soulVersion/avatar/name/domain）→ 一次 PATCH 打包存
 *   人格：GET/PUT /partners/:id/persona（2026-11-14 批1：预设 + 八个开关 + 静态内容）
 *   岗位：PUT /partners/:id/contract（版本化）+ PATCH currentGoal / tool_projection / diary
 *        （接派单卡 2026-11-15 退役：领域这套没用起来；机制与 env 总闸不动，想找回走 PATCH）
 *   能力：mountChainEditor（备选链）+ routines 列表/新建 + skills 只读
 *
 * 刻意不做：不在这一页做删除执事（列表页才有）、不把记忆的增删搬来（设置 → 注入 → 索引是唯一真相）、
 * 不再显示这个人的履历 / 记忆（统一去设置 → 注入 → 索引看）。
 */

import { paintAvatar } from "./avatar.js";
import { el } from "./dom.js";
import { chevSvg } from "./icons.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { openSecMenu } from "./sec-menu.js";
import { openAvatarPanel } from "./partner-editor.js";
import { PT_STATUS, ptTogglePartner } from "./partner-modals.js";
import { ptRenderRoutineList, ptRoutineFormMarkup, ptWireRoutineForm } from "./partner-routines.js";
import { loadRoster, openChiefChat, syncChiefAvatar } from "./partners-status.js";
import { openCreateSkillModal } from "./skills-modals.js";
import { setModalHint } from "./project-modal.js";
import { switchMarkup } from "./settings-atoms.js";
import { CS_CONTRACT_TEMPLATE } from "./settings-contract.js";
import { openScheduledTaskModal } from "./settings-reminders.js";
import { csLoadProfileSkills, csProfileWhen } from "./settings-employee.js";
import { mountChainEditor } from "./settings-model.js";
import { applyRoute, setRouteGuard } from "./route.js";
import { state } from "./state.js";
import { showRollbackOffer } from "./soul-rollback.js";
import { closeModal, openConfirm, openModal, toast } from "./ui-atoms.js";

/* 领域标签的服务端口径（companion-api.ts PATCH）：小写 ASCII + 连字符。
   前端先拦一道，不然用户按旧 placeholder 填「写作」会拿到一句 400。 */
const PF_NAME_LIMIT = 40;

/* ── 人格模块（2026-11-14 员工人格模块 · 批1 / 批2 / 批3）────────────────
 *
 * 一个员工 = 必选核心（身份 / 数据红线 / 教诲通道，不可关）+ 可开关模块。
 * 批1 八个模块、批2 三个活模块、批3 学习 / 主动性 / 人设库；解释文字不常驻（data-tip），
 * 预设三选一 = 一键填开关；开关改完立即 PUT，不回滚草稿（与会话设置里的开关同款）。 */

const PF_PERSONA_MODULES = [
  { id: "expression", name: "口吻", tip: "说话风格、句长、口癖、忌用语、示例对话、开场白。填了才进提示词。", editable: "style" },
  { id: "values", name: "里子", tip: "他在乎什么、守什么底线、怕什么、喜欢和厌恶什么。", editable: "values" },
  { id: "scenario", name: "处境", tip: "眼下在忙什么、知识边界（知道什么 / 不知道什么）、和别人的关系。", editable: "scenario" },
  { id: "contract", name: "岗位契约", tip: "职责范围、决策分级、验收标准、汇报对象（人设页「岗位」那张卡）。" },
  { id: "discipline", name: "纪律", tip: "验证铁律、裁决口径、干活期间的安静、提问纪律。主人数据红线不受这个开关影响。" },
  { id: "goal", name: "当前目标", tip: "这一阵在奔什么（人设页「岗位」里的那行）。" },
  { id: "workHistory", name: "履历摘要", tip: "近 10 单完成 / 失败 / 中止的条数，挂在在办段末尾。" },
  { id: "currentWork", name: "在办状态", tip: "在办的单、等你批的、最近一单结果。" },
  // 批2 活模块（2026-11-15）：关 = 不注入、停止更新，已有内容保留（重开即回）。
  { id: "impression", name: "印象", tip: "他对你和群里同事的印象，以及「关系温度」五档。结算时只从真发生过的事提炼。", living: "impression" },
  { id: "mood", name: "心情", tip: "此刻状态 + 近况一句。规则可见（被谢 → 愉悦、连败 → 低落、久无单 → 平静），可手改。", living: "mood" },
  { id: "heart", name: "内心生活", tip: "他的日记、周报末尾那句「他自己的话」、成长笔记与愿望。成长笔记永不回写人设。", living: "heart" },
  // 批3（2026-11-15）：学习只落规则与 ≤40 字例句，不进日志 / 导出。
  { id: "learning", name: "学习", tip: "学主人说话习惯与黑话；只存提炼后的规则和 ≤40 字短例句，不进日志 / 导出。", learning: true },
  // 主动性 = 只做追问（2026-11-15 用户口径：挂念拆出去独立成卡，两个开关不许并排）。
  { id: "proactivity", name: "主动性", tip: "回话末尾可以自然追问一句。只加这一句提示，不新起调度、不自己找时机。", proactive: true },
  { id: "profiles", name: "人设库", tip: "存整套人格快照（≤5 份），一键切回；应用快照不会改人设正文（SOUL）。", profiles: true },
];

const PF_PERSONA_PRESETS = [
  { id: "work", name: "岗位", tip: "只留岗位相关：契约 / 纪律 / 目标。口吻、里子、处境全关——干活的人不需要这些。" },
  { id: "companion", name: "陪伴", tip: "口吻、里子、处境、目标开；岗位类关（主人数据红线照旧在）。" },
  { id: "allrounder", name: "全才", tip: "岗位类 + 口吻 / 里子 / 处境 + 内心三件全开——干活也有感情的执事。学习 / 挂念 / 人设库仍默认关。" },
  { id: "apprentice", name: "学徒", tip: "在学你说话习惯的实验位：口吻 / 学习 / 挂念 / 人设库开，其余最小。" },
  { id: "custom", name: "自定义", tip: "自己配。开关随便摆，服务端只强制数据红线；改了任一开关会自动跳到这档，改回预设的原样会自动跳回去。" },
];

/* 预设默认表（2026-11-16 草稿模式）：与服务端 partner-persona.ts 的 `PERSONA_PRESETS` 同步。
   为什么前端也要一份：点预设必须先把开关画出来，不能等保存才看到结果；服务端仍是最终口径
   （保存时按最终开关表推导 preset）。改服务端那张表时，这里同步改。 */
const PF_PERSONA_PRESET_MODULES = {
  work: {
    expression: false, values: false, scenario: false,
    contract: true, discipline: true, goal: true,
    workHistory: true, currentWork: true,
    impression: false, mood: false, heart: false,
    learning: false, proactivity: false, profiles: false,
  },
  companion: {
    expression: true, values: true, scenario: true,
    contract: false, discipline: false, goal: true,
    workHistory: false, currentWork: false,
    impression: true, mood: true, heart: true,
    learning: false, proactivity: false, profiles: false,
  },
  allrounder: {
    expression: true, values: true, scenario: true,
    contract: true, discipline: true, goal: true,
    workHistory: true, currentWork: true,
    impression: true, mood: true, heart: true,
    learning: false, proactivity: false, profiles: false,
  },
  apprentice: {
    expression: true, values: false, scenario: false,
    contract: false, discipline: false, goal: false,
    workHistory: true, currentWork: true,
    impression: false, mood: false, heart: false,
    learning: true, proactivity: true, profiles: true,
  },
  custom: {
    expression: false, values: false, scenario: false,
    contract: false, discipline: false, goal: false,
    workHistory: false, currentWork: false,
    impression: false, mood: false, heart: false,
    learning: false, proactivity: false, profiles: false,
  },
};

/** 预设推导只比较这 12 个（履历 / 在办固定注入，不参与）——与服务端口径一致。 */
const PF_PERSONA_PRESET_MATCH_IDS = PF_PERSONA_MODULES
  .map((module) => module.id)
  .filter((id) => id !== "workHistory" && id !== "currentWork");

/** 按最终开关表推导预设名（与服务端 `derivePresetFromModules` 同一口径）。 */
function pfDerivePreset(modules) {
  for (const preset of ["work", "companion", "allrounder", "apprentice"]) {
    const table = PF_PERSONA_PRESET_MODULES[preset];
    if (PF_PERSONA_PRESET_MATCH_IDS.every((id) => (modules?.[id] === true) === (table[id] === true))) {
      return preset;
    }
  }
  return "custom";
}

/* 当前详情页的未保存守卫（2026-11-16）：给 route.js 与 beforeunload 共用。
   页面重新渲染会换一个新的；放行导航时守卫自己清空。 */
let activeProfileGuard = null;
let pfLeavePromptOpen = false;

/* 刷新 / 关窗：浏览器自己的确认框（文字不可定制），只有草稿脏的时候才拦。
   页面内切路由由 route.js 的 setRouteGuard + 「保存并退出」弹层负责。 */
window.addEventListener("beforeunload", (event) => {
  if (!activeProfileGuard?.isDirty()) return;
  event.preventDefault();
  event.returnValue = "";
});


/* 静态模块编辑弹层的字段表：上限数字与 shared 的 PARTNER_PERSONA_LIMITS 对齐，
   服务端仍会二次校验（前端只是先拦，避免填完才被打回）。 */
const PF_PERSONA_EDITORS = {
  style: {
    title: "口吻",
    desc: "他怎么开口。空着的字段不会进提示词；填得越具体，越像这个人。",
    fields: [
      { key: "speakStyle", label: "说话风格", kind: "textarea", limit: 300, rows: 3, hint: "先给结论还是先铺垫、用不用比喻、多克制" },
      { key: "sentenceLength", label: "句子长度", kind: "select", options: ["不限", "短", "中", "长"] },
      { key: "catchphrases", label: "口癖", kind: "lines", max: 8, each: 24, hint: "一行一条，最多 8 条" },
      { key: "taboos", label: "忌用语", kind: "lines", max: 6, each: 48, hint: "一行一条，最多 6 条" },
      { key: "exampleDialogues", label: "示例对话", kind: "lines", max: 3, each: 400, hint: "一行一段，最多 3 段；示例对话是各家验证过最有效的口吻锚" },
      { key: "altStyle", label: "备用风格", kind: "textarea", limit: 300, rows: 2, hint: "什么时候换成另一种说法" },
      { key: "switchProbability", label: "切换概率", kind: "number", min: 0, max: 100, hint: "0–100；只有填了备用风格才有意义" },
      { key: "emojiHabit", label: "表情习惯", kind: "text", limit: 80, hint: "用不用表情、用哪几个" },
      { key: "openingLine", label: "开场白", kind: "text", limit: 120, hint: "第一句话怎么说" },
    ],
  },
  values: {
    title: "里子",
    desc: "他在乎什么、守什么。这一栏决定他像不像一个有主见的人，而不是回声。",
    fields: [
      { key: "cares", label: "在乎什么", kind: "textarea", limit: 200, rows: 2 },
      { key: "bottomLines", label: "底线", kind: "textarea", limit: 200, rows: 2, hint: "他不会做的事" },
      { key: "fears", label: "怕什么", kind: "text", limit: 120, hint: "软肋，可以写小一点的事" },
      { key: "likes", label: "喜好", kind: "lines", max: 10, each: 30, hint: "一行一条，最多 10 条" },
      { key: "dislikes", label: "厌恶", kind: "lines", max: 10, each: 30, hint: "一行一条，最多 10 条" },
      { key: "motivator", label: "来劲的事", kind: "text", limit: 100 },
      { key: "valueKeywords", label: "关键词", kind: "keywords", max: 3, each: 8, hint: "最多 3 个，用顿号或逗号隔开" },
    ],
  },
  scenario: {
    title: "处境",
    desc: "他现在站在哪。知道什么、不知道什么，比多写十句性格更能约束胡说。",
    fields: [
      { key: "situation", label: "眼下处境", kind: "textarea", limit: 300, rows: 3 },
      { key: "knowledgeBoundary", label: "知识边界", kind: "textarea", limit: 300, rows: 3, hint: "知道什么 / 不知道什么" },
      { key: "relations", label: "人物关系", kind: "lines", max: 10, each: 60, hint: "一行一条，最多 10 条" },
    ],
  },
};

function pfPersonaValue(field, raw) {
  if (field.kind === "lines" || field.kind === "keywords") {
    const parts = field.kind === "keywords" ? String(raw).split(/[,，、]/) : String(raw).split(/\r?\n/);
    const items = parts.map((item) => item.trim()).filter(Boolean);
    if (items.length > field.max) return { problem: `${field.label}最多 ${field.max} 条` };
    const tooLong = items.find((item) => [...item].length > field.each);
    if (tooLong) return { problem: `${field.label}每条不超过 ${field.each} 字` };
    return { value: items };
  }
  if (field.kind === "number") {
    const text = String(raw).trim();
    if (!text) return { value: undefined };
    const num = Number(text);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < field.min || num > field.max) {
      return { problem: `${field.label}是 ${field.min}–${field.max} 的整数` };
    }
    return { value: num };
  }
  const text = String(raw).trim();
  if (field.limit && [...text].length > field.limit) {
    return { problem: `${field.label}不超过 ${field.limit} 字` };
  }
  return { value: text };
}

function pfPersonaFieldMarkup(field, current) {
  const value = current?.[field.key];
  const note = field.hint ? `<em>${esc(field.hint)}</em>` : "";
  if (field.kind === "select") {
    const selected = typeof value === "string" && value ? value : field.options[0];
    const options = field.options
      .map((option) => `<option value="${attr(option)}"${option === selected ? " selected" : ""}>${esc(option)}</option>`)
      .join("");
    return `<label class="modal-field"><span>${esc(field.label)}${note}</span>
      <select class="modal-input" data-pf-field="${attr(field.key)}">${options}</select></label>`;
  }
  if (field.kind === "textarea") {
    const text = typeof value === "string" ? value : "";
    return `<label class="modal-field"><span>${esc(field.label)}<em>≤${field.limit} 字</em>${note}</span>
      <textarea class="pt-ta" rows="${field.rows || 3}" maxlength="${field.limit}" data-pf-field="${attr(field.key)}"
                spellcheck="false">${esc(text)}</textarea></label>`;
  }
  if (field.kind === "lines" || field.kind === "keywords") {
    const text = Array.isArray(value) ? value.join(field.kind === "keywords" ? "、" : "\n") : "";
    const rows = Math.min(6, Math.max(2, field.max > 6 ? 3 : field.max));
    return `<label class="modal-field"><span>${esc(field.label)}<em>≤${field.max} 条</em>${note}</span>
      <textarea class="pt-ta" rows="${rows}" data-pf-field="${attr(field.key)}" spellcheck="false"
                placeholder="${field.kind === "keywords" ? "准确、克制" : "一行一条"}">${esc(text)}</textarea></label>`;
  }
  if (field.kind === "number") {
    const text = typeof value === "number" ? String(value) : "";
    return `<label class="modal-field"><span>${esc(field.label)}${note}</span>
      <input class="modal-input" type="number" min="${field.min}" max="${field.max}" step="1"
             value="${attr(text)}" data-pf-field="${attr(field.key)}" placeholder="0–100" /></label>`;
  }
  const text = typeof value === "string" ? value : "";
  return `<label class="modal-field"><span>${esc(field.label)}<em>≤${field.limit} 字</em>${note}</span>
    <input class="modal-input" type="text" maxlength="${field.limit}" value="${attr(text)}"
           data-pf-field="${attr(field.key)}" /></label>`;
}


/** 当前地址里的详情页目标；不在详情路由 / 已经切走时返回空串。 */
function pfRouteId() {
  const match = /^#\/settings\/partners\/([A-Za-z0-9-]+)/.exec(location.hash);
  return match ? match[1] : "";
}

/** 详情页地址（列表卡与面包屑共用）。 */
function pfHash(partnerId) {
  return `#/settings/partners/${encodeURIComponent(partnerId)}`;
}

function pfOpen(partnerId) {
  const next = pfHash(partnerId);
  if (location.hash === next) return;
  location.hash = next;
}

/** 头像上的箭头：告诉用户「这个圈能点」。 */
const PF_CHEV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
const PF_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`;
/* 顶栏只留一个小图标钮（2026-11-15 人设页打磨：试跑退役、暂停/恢复收成图标） */
const PF_PAUSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>`;
const PF_PLAY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;

/* ── 页面骨架 ─────────────────────────────────────────────── */

function pfMarkup(partnerId, partner, detail) {
  const name = String(partner.name || "").trim() || partnerId;
  const soul = String(detail.soul ?? "");
  const status = PT_STATUS[partner.status] || { text: partner.status || "未知", cls: "" };
  const isChief = partnerId === "chief";

  return `
  <div class="pf" data-pf-id="${attr(partnerId)}">
    <button class="pf-back" type="button" id="pf-back">${PF_BACK}<span>总管与执事</span></button>

    <header class="pf-hero">
      <div class="pf-ava-wrap">
        <button class="pf-ava" type="button" id="pf-avatar" aria-label="更换头像" title="更换头像"></button>
        <span class="pf-ava-chev" aria-hidden="true">${PF_CHEV}</span>
      </div>
      <div class="pf-hero-main">
        <h1 class="pf-title" id="pf-title">${esc(name)}</h1>
        <div class="pf-meta">
          <span class="status-dot ${status.cls}" aria-hidden="true"></span>
          <span id="pf-status-text">${esc(status.text)}</span>
        </div>
      </div>
      ${isChief ? "" : `<div class="pf-hero-actions">
        <button class="pf-iconbtn" type="button" id="pf-pause" data-tip="${partner.status === "active" ? "暂停：他不再接活、专线打不开" : "恢复：他重新接活"}" aria-label="${partner.status === "active" ? "暂停" : "恢复"}">${partner.status === "active" ? PF_PAUSE_ICON : PF_PLAY_ICON}</button>
      </div>`}
    </header>

    <!-- ① 人设：名字 / 领域 / 头像 / 正文，一次保存（服务端 PATCH 本就收多槽位） -->
    <section class="pf-sec">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title">人设</h2>
        <span class="pf-sec-note" id="pf-soul-note">${soul.length} 字</span>
      </div>
      <div class="card pf-panel">
        <div class="pf-id-row">
          <label class="pf-field">
            <span>名字</span>
            <input class="set-input" id="pf-name" type="text" maxlength="${PF_NAME_LIMIT}" value="${attr(name)}" />
          </label>
        </div>

        <div class="pf-soul-head">
          <span class="pf-block-title">正文</span>
          <em class="pf-tag">每轮进提示词</em>
        </div>
        <textarea class="pf-soul" id="pf-soul" spellcheck="false" aria-label="人设正文"
                  placeholder="例：你是这个家的总管。先给结论，再给理由；不确定就说不知道。">${esc(soul)}</textarea>

        <div class="pf-foot" id="pf-identity-foot" hidden>
          <div class="pf-state" id="pf-state"><i aria-hidden="true"></i><span>没有改动</span></div>
          <button class="ghost" type="button" id="pf-reset" disabled>撤销</button>
          <button class="btn-primary" type="button" id="pf-save" disabled>保存</button>
        </div>
        <p class="pf-hint" id="pf-hint"></p>
      </div>
    </section>

    <!-- ①·五 人格模块（2026-11-15 二次重构：岗位 + 能力并入，全部卡片化）
         一列模块卡，组标题只做扫读锚：
         - 带开关的卡：开 = 可点开编辑 + 进提示词；关 = 不能改、不进提示词（内容保留）；
         - 必做项与能力项没有"注入开关"语义，不带开关，点开即用（用户口径：必须做的直接放外边）。
         卡片全部由 pfWirePersona 统一画（数据三路：persona 端点 / partner 行 / detail）。
         2026-11-15 打磨：右侧常驻解释删掉，收进标题的悬停黑框（data-tip）。 -->
    <section class="pf-sec" id="pf-persona">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="开 = 进提示词、可编辑；关 = 不进、不可改（内容保留）">人格模块</h2>
      </div>
      <div class="card pf-panel">
        <div class="pf-presets" id="pf-persona-presets" role="group" aria-label="人格预设"></div>
        <div class="pf-mod-cards" id="pf-persona-cards"></div>
        <p class="pf-hint" id="pf-persona-hint"></p>
      </div>
    </section>

    <!-- ①·六 每轮固定注入（2026-11-15 人设页打磨二轮改名）：100% 每句话都带，不带筛。
         纪律（默认可看、行为纪律可覆盖；红线固定）/ 在办 / 履历（现查现拼，点卡看实际注入原文）+ 负责项目（每轮带一行项目索引）。
         与下面「按相关度召回」是两种机制，别混：这里是恒定下发，那边是先打分再决定。 -->
    <section class="pf-sec" id="pf-injected">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="100% 都进：不管你聊什么，每句话都带着这几段（不带筛选）。点卡看每轮实际注入的原文">每轮固定注入</h2>
      </div>
      <div class="card pf-panel">
        <div class="pf-mod-cards" id="pf-injected-cards"></div>
      </div>
    </section>

    <!-- ①·六·二 按相关度召回（2026-11-15 打磨二轮）：记忆四类 + 挂载项目的记忆。
         不是恒定注入——同一句话不同时间浮出来的不一样；点卡说明机制与开关。 -->
    <section class="pf-sec" id="pf-recall">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="先打分再决定进不进：按你这轮说的话算相关度，够线的才浮出，不相关不占位">按相关度召回</h2>
      </div>
      <div class="card pf-panel">
        <div class="pf-mod-cards" id="pf-recall-cards"></div>
      </div>
    </section>

    <!-- ①·七 高级开关（2026-11-15 人设页打磨）：结果整理 + 日记执事另起一块。
         不写"默认全开"——结果整理默认跟随全局（开），日记执事是"全家只有一位"的指派。 -->
    <!-- ①·六·三 能用的工具（2026-11-16 工具裁剪 B）：逐项勾选这个模型能看到哪些工具。
         存"取消名单"、默认全开；取消后下一轮起生效。PARTNER_TOOLS_ENABLED=false 时整段隐藏。 -->
    <section class="pf-sec" id="pf-tools">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="勾上 = 他看得到、调得动；取消 = 下一轮起看不到；默认全开">能用的工具</h2>
      </div>
      <div class="card pf-panel">
        <div class="pf-mod-cards" id="pf-tools-cards"></div>
      </div>
    </section>

    <section class="pf-sec" id="pf-advanced">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title" data-tip="只影响他一个人：结果整理默认跟随全局（开）；日记执事全家只有一位，选了他别人就自动退出">高级开关</h2>
      </div>
      <div class="card pf-panel">
        <div class="pf-mod-cards" id="pf-advanced-cards"></div>
      </div>
    </section>

    <!-- 统一保存条（2026-11-16）：人格模块 / 高级开关只改草稿，点这里才落库；
         离开页面前还有未保存改动会弹「保存并退出 / 不保存退出 / 取消」，避免误触后忘掉。 -->
    <div class="pf-savebar" id="pf-savebar" hidden>
      <div class="pf-state" id="pf-savebar-state"><i aria-hidden="true"></i><span>没有改动</span></div>
      <button class="ghost" type="button" id="pf-savebar-reset" disabled>撤销</button>
      <button class="btn-primary" type="button" id="pf-savebar-save" disabled>保存</button>
    </div>
  </div>`;
}

/* ── ① 人设：一次保存 ──────────────────────────────────────── */

function pfWireIdentity(root, partnerId, partner, detail, onDirty) {
  const nameInput = root.querySelector("#pf-name");
  const soulArea = root.querySelector("#pf-soul");
  const save = root.querySelector("#pf-save");
  const reset = root.querySelector("#pf-reset");
  const foot = root.querySelector("#pf-identity-foot");
  const stateNode = root.querySelector("#pf-state");
  const hint = root.querySelector("#pf-hint");
  const note = root.querySelector("#pf-soul-note");
  const title = root.querySelector("#pf-title");
  const avatarBtn = root.querySelector("#pf-avatar");
  if (!nameInput || !soulArea || !avatarBtn) return null;

  const base = {
    name: String(partner.name || "").trim(),
    avatar: partner.avatar || null,
    soul: String(detail.soul ?? ""),
  };
  const draft = { ...base };
  let decoding = false;
  let saving = false;

  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", Boolean(isError && text));
  };

  const paintAvatarNow = () => {
    paintAvatar(avatarBtn, draft.avatar, draft.name || base.name || "执事");
    avatarBtn.classList.toggle("has-image", Boolean(draft.avatar));
  };

  const dirtyCount = () =>
    Object.keys(base).filter((key) => draft[key] !== base[key]).length;

  const refresh = () => {
    const dirty = dirtyCount();
    save.disabled = saving || decoding || dirty === 0;
    reset.disabled = saving || decoding || dirty === 0;
    stateNode.classList.toggle("is-dirty", dirty > 0);
    stateNode.querySelector("span").textContent = dirty ? `${dirty} 处改动未保存` : "没有改动";
    if (foot) foot.hidden = dirty === 0;
    note.textContent = `${soulArea.value.length} 字`;
    avatarBtn.disabled = saving;
    onDirty?.();
  };

  paintAvatarNow();
  refresh();

  avatarBtn.addEventListener("click", () => {
    if (saving || decoding) return;
    openAvatarPanel({
      anchor: avatarBtn,
      current: draft.avatar,
      onPick: (dataUrl) => {
        draft.avatar = dataUrl;
        paintAvatarNow();
        refresh();
        setHint(dataUrl ? "头像已选好，点保存生效。" : "已改为不用头像，保存后显示名字首字。");
      },
      onBusy: (busy, message) => {
        decoding = busy;
        if (message) setHint(message, true);
        refresh();
      },
    });
  });

  nameInput.addEventListener("input", () => {
    draft.name = nameInput.value;
    paintAvatarNow();
    setHint("");
    refresh();
  });
  soulArea.addEventListener("input", () => {
    draft.soul = soulArea.value;
    // 待保存时先说清代价：只有总管人设进 system 固定前缀。
    setHint(
      partnerId === "chief" && draft.soul !== base.soul
        ? "保存后下一轮起用；总管人设在固定前缀里，本会话下一次请求会重建一次。换风格/立场建议开新会话：旧回答还在历史里。"
        : "",
    );
    refresh();
  });

  const resetDraft = () => {
    Object.assign(draft, base);
    nameInput.value = base.name;
    soulArea.value = base.soul;
    paintAvatarNow();
    setHint("");
    refresh();
  };

  const saveNow = async () => {
    if (saving || decoding) return false;
    const name = draft.name.trim();
    if (!name) {
      setHint("名字不能空。", true);
      nameInput.focus();
      return false;
    }
    if (!draft.soul.trim()) {
      setHint("人设不能是空的。", true);
      soulArea.focus();
      return false;
    }
    const payload = {};
    if (name !== base.name) payload.name = name;
    if (draft.avatar !== base.avatar) payload.avatar = draft.avatar;
    if (draft.soul !== base.soul) payload.soul = draft.soul;
    if (!Object.keys(payload).length) return true;

    saving = true;
    refresh();
    setHint("保存中…");
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
        return false;
      }
      // 以服务端回读值为新基准：再点保存不会重复提交同样的内容
      base.name = String(data.partner?.name ?? name);
      base.avatar = data.partner?.avatar ?? null;
      base.soul = draft.soul;
      Object.assign(draft, base);
      nameInput.value = base.name;
      paintAvatarNow();
      title.textContent = base.name;
      // 侧栏花名册与设置列表都吃 state.partners 这份缓存
      const cached = state.partners.find((item) => item.id === partnerId);
      if (cached) {
        cached.name = base.name;
        cached.avatar = base.avatar;
        if (data.soulVersion != null) cached.soulVersion = data.soulVersion;
      }
      syncChiefAvatar();
      void loadRoster();
      // 快照退役（2026-11-15）：保存成功后给一次「回到上一版」，不展示版本号
      // 只有总管的人设进 system 固定前缀；执事 SOUL 走每轮尾部消息，不改前缀（别误报缓存）。
      setHint(
        payload.soul !== undefined && partnerId === "chief"
          ? "已保存，下一轮起用。总管人设在固定前缀里，本会话下次请求会重建一次（缓存掉一截属正常）。"
          : "已保存，下一轮起用。",
      );
      showRollbackOffer(hint, partnerId, (restored) => {
        base.soul = restored;
        draft.soul = restored;
        soulArea.value = restored;
        note.textContent = `${restored.length} 字`;
        toast("已回到上一版");
      });
      toast("人设已保存");
      return true;
    } catch (error) {
      if (error.message !== "forbidden") setHint(`没存成：${error.message}`, true);
      return false;
    } finally {
      saving = false;
      refresh();
    }
  };

  reset.addEventListener("click", resetDraft);
  save.addEventListener("click", () => {
    void saveNow();
  });

  return {
    isDirty: () => dirtyCount() > 0,
    dirtyCount,
    save: saveNow,
    reset: resetDraft,
  };
}

/* ── ②③ 岗位与能力的卡片编辑层（2026-11-15 并入人格模块）──────
   原就地编辑（契约折叠 / 目标行 / 项目行 / 岗位三开关 / 能力三折叠）全部搬进弹层；
   卡片本体由 pfWirePersona 统一画。 */

/** partner 行字段 PATCH 公共路（接派单 / 结果契约 / 日记执事 / 负责项目共用）。 */
async function pfPatchPartner(partnerId, patchBody) {
  const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
    method: "PATCH",
    body: JSON.stringify(patchBody),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data;
}

/** 岗位契约编辑弹层（原岗位卡的折叠编辑整段搬进来；契约与 SOUL 共用身份版本号）。 */
function pfOpenContractEditor(partnerId, detail, onChanged) {
  if (!("contract" in detail)) {
    toast("岗位契约未启用（PARTNER_CONTRACT=false）");
    return;
  }
  openModal("岗位契约", (body) => {
    const original = String(detail.contract ?? "");
    body.innerHTML = `
      <p class="modal-desc">调岗用：职责 / 决策分级 / 验收标准 / 汇报对象。改完下一轮起用。</p>
      <div class="pf-fold-tools">
        <button class="pf-mini" type="button" id="pf-contract-tpl">套用模板</button>
      </div>
      <textarea class="pf-contract" id="pf-contract" rows="9" spellcheck="false" aria-label="岗位契约"
        placeholder="写清管什么、怎么定、怎么验收、向谁汇报">${esc(original)}</textarea>
      <p class="modal-hint" id="pf-contract-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>关闭</button>
        <button class="ghost" type="button" id="pf-contract-reset" disabled>撤销</button>
        <button class="modal-primary" type="button" id="pf-contract-save" disabled>保存</button>
      </div>`;
    const area = body.querySelector("#pf-contract");
    const save = body.querySelector("#pf-contract-save");
    const reset = body.querySelector("#pf-contract-reset");
    const hint = body.querySelector("#pf-contract-hint");
    const tpl = body.querySelector("#pf-contract-tpl");
    let saving = false;
    const refresh = () => {
      const dirty = area.value !== original;
      save.disabled = saving || !dirty;
      reset.disabled = saving || !dirty;
      if (tpl) tpl.hidden = Boolean(area.value.trim());
    };
    refresh();
    tpl?.addEventListener("click", () => {
      area.value = CS_CONTRACT_TEMPLATE;
      setModalHint(hint, "模板已填好：按四节改成它自己的口径，再保存。", false);
      refresh();
    });
    area.addEventListener("input", () => {
      setModalHint(hint, "", false);
      refresh();
    });
    reset.addEventListener("click", () => {
      area.value = original;
      setModalHint(hint, "", false);
      refresh();
    });
    save.addEventListener("click", async () => {
      if (saving || area.value === original) return;
      saving = true;
      refresh();
      setModalHint(hint, "保存中…", false);
      try {
        const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/contract`, {
          method: "PUT",
          body: JSON.stringify({ contract: area.value }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, data.message || data.error || `没存成：HTTP ${response.status}`, true);
          return;
        }
        detail.contract = data.contract ?? area.value;
        detail.contractVersion = data.contractVersion ?? detail.contractVersion;
        // 快照退役（2026-11-15）：契约刻意不做上一份/回滚（低频慎重、有弹窗确认），只报生效时机
        setModalHint(hint, "已保存，下一轮起用。", false);
        toast("岗位契约已保存");
        saving = false;
        refresh();
        if (typeof onChanged === "function") onChanged();
      } catch (error) {
        if (error.message !== "forbidden") setModalHint(hint, `没存成：${error.message}`, true);
        saving = false;
        refresh();
      }
    });
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
  });
}

/** 当前目标编辑弹层（2026-11-15 打磨：与岗位契约同一弹层结构——大框 + 撤销/保存 + 关闭）。 */
function pfOpenGoalEditor(partnerId, current, onChanged) {
  openModal("当前目标", (body) => {
    const original = String(current ?? "");
    body.innerHTML = `
      <p class="modal-desc">这一阵在奔什么。留空 = 清除；写了他每轮都记得。</p>
      <textarea class="pf-contract" id="pf-goal" maxlength="1000" spellcheck="false"
                placeholder="本季度要奔的事">${esc(original)}</textarea>
      <p class="modal-hint" id="pf-goal-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>关闭</button>
        <button class="ghost" type="button" id="pf-goal-reset" disabled>撤销</button>
        <button class="modal-primary" type="button" id="pf-goal-save" disabled>保存</button>
      </div>`;
    const input = body.querySelector("#pf-goal");
    const save = body.querySelector("#pf-goal-save");
    const reset = body.querySelector("#pf-goal-reset");
    const hint = body.querySelector("#pf-goal-hint");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
    let saving = false;
    const refresh = () => {
      const dirty = input.value !== original;
      save.disabled = saving || !dirty;
      reset.disabled = saving || !dirty;
    };
    refresh();
    input.addEventListener("input", () => {
      setModalHint(hint, "", false);
      refresh();
    });
    reset.addEventListener("click", () => {
      input.value = original;
      setModalHint(hint, "", false);
      refresh();
    });
    save.addEventListener("click", async () => {
      if (save.disabled) return;
      saving = true;
      refresh();
      setModalHint(hint, "保存中…", false);
      try {
        const data = await pfPatchPartner(partnerId, { currentGoal: input.value });
        setModalHint(hint, input.value.trim() ? "已保存，下次对话起生效。" : "已清除目标。", false);
        toast("当前目标已更新");
        saving = false;
        if (typeof onChanged === "function") onChanged(data.partner?.currentGoal ?? input.value);
      } catch (error) {
        if (error.message !== "forbidden") setModalHint(hint, `没存成：${error.message}`, true);
        saving = false;
      } finally {
        refresh();
      }
    });
  });
}

/* ── 注入预览（2026-11-15 人设页打磨）────────────────────── */

const PF_VIEW_FIELDS = {
  discipline: {
    title: "纪律",
    empty: "纪律模块关着：这段现在不注入（主人数据红线照旧强制，只是不在这段里）。",
  },
  currentWork: {
    title: "在办状态",
    empty: "现在没有在办的单：这段整段不会注入。",
  },
  workHistory: {
    title: "履历摘要",
    empty: "还没有干活记录：这段整段不会注入。",
  },
};

/** 纪律编辑的七个固定节；顺序与宿主注入顺序一致。主人数据红线单独只读。 */
const PF_DISCIPLINE_SECTIONS = [
  { key: "partner_verification", title: "验证铁律" },
  { key: "partner_ruling", title: "裁决纪律" },
  { key: "partner_work_silence", title: "干活期间" },
  { key: "partner_grounding", title: "答案接地" },
  { key: "partner_artifact_handoff", title: "产物交接" },
  { key: "partner_brief_card", title: "汇报卡" },
  { key: "partner_attention", title: "提问纪律" },
];
const PF_DISCIPLINE_TITLE_SET = new Set(PF_DISCIPLINE_SECTIONS.map((section) => section.title));

/** 把人写的 `DISCIPLINE.md` 按固定标题拆开；未知标题忽略。 */
function pfParseDisciplineSource(source) {
  const sections = new Map();
  let current = null;
  let buffer = [];
  const flush = () => {
    if (!current) return;
    sections.set(current, buffer.join("\n").trim());
    buffer = [];
  };
  for (const line of String(source || "").split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = PF_DISCIPLINE_TITLE_SET.has(heading[1]) ? heading[1] : null;
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return sections;
}

/** 序列化覆盖：只写已经覆盖的节；空内容写成空标题（服务端按“删掉这一条”处理）。 */
function pfSerializeDisciplineSource(sections) {
  const blocks = [];
  for (const section of PF_DISCIPLINE_SECTIONS) {
    if (!sections.has(section.title)) continue;
    blocks.push(`## ${section.title}\n${sections.get(section.title) || ""}`.trimEnd());
  }
  return blocks.join("\n\n");
}

function pfDisciplineRowMarkup(section, value, hasOverride) {
  const chars = value.length;
  return `<section class="pf-disc-section" data-pf-disc-key="${esc(section.key)}" data-pf-disc-title="${esc(section.title)}">
      <div class="pf-disc-head">
        <span class="pf-disc-name">${esc(section.title)}</span>
        <span class="pf-disc-state">${hasOverride ? "覆盖" : "默认"} · ${chars} 字</span>
      </div>
      <textarea class="pf-contract pf-disc-text" rows="4" spellcheck="false" aria-label="${esc(section.title)}"
        placeholder="写这一节的正文">${esc(value)}</textarea>
      <div class="pf-disc-actions">
        <button class="pf-mini" type="button" data-pf-disc-restore${hasOverride ? "" : " disabled"}>恢复这一节默认</button>
        <button class="modal-primary pf-disc-save" type="button" data-pf-disc-save disabled>保存这一节</button>
      </div>
    </section>`;
}

function pfUpdateDisciplineRow(row, value, hasOverride, saving, keepOriginal = false) {
  const area = row.querySelector("textarea");
  if (!area) return;
  area.value = value;
  if (!keepOriginal) row._pfOriginal = value;
  const state = row.querySelector(".pf-disc-state");
  if (state) state.textContent = `${hasOverride ? "覆盖" : "默认"} · ${value.length} 字`;
  const restore = row.querySelector("[data-pf-disc-restore]");
  if (restore) restore.disabled = saving || !hasOverride;
  const save = row.querySelector("[data-pf-disc-save]");
  if (save) save.disabled = saving || area.value === row._pfOriginal;
}

function pfRefreshDisciplineRow(row, saving) {
  const area = row.querySelector("textarea");
  if (!area) return;
  const save = row.querySelector("[data-pf-disc-save]");
  if (save) save.disabled = saving || area.value === row._pfOriginal;
}

function pfDisciplineRedMarkup(redLine) {
  return `<section class="pf-disc-section" aria-label="主人数据红线（固定）">
      <div class="pf-disc-head">
        <span class="pf-disc-name">主人数据红线</span>
        <span class="pf-disc-state">固定 · ${redLine.length} 字</span>
      </div>
      <pre class="pf-disc-red">${esc(redLine)}</pre>
    </section>`;
}

/** 纪律逐节编辑弹层：七个行为节 + 主人数据红线（只读）同在一列，整体交给弹层滚。 */
function pfOpenDisciplineEditor(partnerId, onChanged) {
  openModal("纪律", (body) => {
    body.innerHTML = `
      <div id="pf-discipline-loading" class="modal-hint">读取中…</div>
      <div id="pf-discipline-editor" hidden>
        <div class="pf-disc-list" id="pf-discipline-sections"></div>
        <p class="modal-hint" id="pf-discipline-hint"></p>
      </div>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>关闭</button>
        <button class="modal-primary" type="button" id="pf-discipline-save-all" disabled>保存</button>
      </div>`;
    const loading = body.querySelector("#pf-discipline-loading");
    const editor = body.querySelector("#pf-discipline-editor");
    const list = body.querySelector("#pf-discipline-sections");
    const hint = body.querySelector("#pf-discipline-hint");
    const saveAllButton = body.querySelector("#pf-discipline-save-all");
    let defaults = new Map();
    let overrides = new Map();
    let redLine = "";
    let saving = false;

    const refreshSaveAll = () => {
      if (!saveAllButton) return;
      saveAllButton.disabled =
        saving ||
        ![...list.querySelectorAll("[data-pf-disc-key]")].some((row) => {
          const area = row.querySelector("textarea");
          return area && area.value !== row._pfOriginal;
        });
    };

    body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
    saveAllButton?.addEventListener("click", () => {
      void saveAllSections();
    });

    const renderRows = () => {
      const rows = PF_DISCIPLINE_SECTIONS.map((section) => {
        const hasOverride = overrides.has(section.title);
        const value = hasOverride ? overrides.get(section.title) || "" : defaults.get(section.title) || "";
        return pfDisciplineRowMarkup(section, value, hasOverride);
      }).join("");
      list.innerHTML = `${rows}${redLine.trim() ? pfDisciplineRedMarkup(redLine) : ""}`;
      for (const row of list.querySelectorAll("[data-pf-disc-key]")) {
        const area = row.querySelector("textarea");
        if (!area) continue;
        row._pfOriginal = area.value;
        area.addEventListener("input", () => {
          pfRefreshDisciplineRow(row, saving);
          refreshSaveAll();
        });
      }
      refreshSaveAll();
    };

    const rowOf = (target) => target?.closest?.("[data-pf-disc-key]") || null;
    const putSource = async (nextSource, title, successText, { updateAll = false } = {}) => {
      const response = await request(
        `/api/v1/partners/${encodeURIComponent(partnerId)}/discipline`,
        { method: "PUT", body: JSON.stringify({ discipline: nextSource }) },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.message || data.error || `HTTP ${response.status}`);
      }
      overrides = pfParseDisciplineSource(data.override || "");
      defaults = pfParseDisciplineSource(data.defaultDiscipline || "");
      if (updateAll) {
        for (const row of list.querySelectorAll("[data-pf-disc-key]")) {
          const rowTitle = row.dataset.pfDiscTitle;
          const value = overrides.has(rowTitle) ? overrides.get(rowTitle) || "" : defaults.get(rowTitle) || "";
          pfUpdateDisciplineRow(row, value, overrides.has(rowTitle), saving);
        }
      } else {
        const row = list.querySelector(`[data-pf-disc-title="${esc(title)}"]`);
        const value = overrides.has(title) ? overrides.get(title) || "" : defaults.get(title) || "";
        if (row) pfUpdateDisciplineRow(row, value, overrides.has(title), saving);
      }
      setModalHint(hint, successText, false);
      refreshSaveAll();
      if (typeof onChanged === "function") onChanged();
    };

    const saveSection = async (row) => {
      if (saving) return;
      const title = row?.dataset.pfDiscTitle || "";
      const area = row?.querySelector("textarea");
      if (!title || !area || area.value === row._pfOriginal) return;
      const next = new Map(overrides);
      next.set(title, area.value.trim());
      const drafts = new Map();
      for (const item of list.querySelectorAll("[data-pf-disc-key]")) {
        const textarea = item.querySelector("textarea");
        if (textarea) drafts.set(item.dataset.pfDiscTitle, textarea.value);
      }
      let ok = false;
      saving = true;
      setModalHint(hint, "保存中…", false);
      for (const item of list.querySelectorAll("[data-pf-disc-save], [data-pf-disc-restore]")) item.disabled = true;
      if (saveAllButton) saveAllButton.disabled = true;
      try {
        await putSource(pfSerializeDisciplineSource(next), title, "已保存这一节，下一轮起用。");
        ok = true;
        toast(`已保存「${title}」`);
      } catch (error) {
        if (error.message !== "forbidden") setModalHint(hint, `没存成：${error.message}`, true);
      } finally {
        saving = false;
        for (const item of list.querySelectorAll("[data-pf-disc-key]")) {
          const rowTitle = item.dataset.pfDiscTitle;
          const keep = !ok || rowTitle !== title;
          const value = keep
            ? drafts.get(rowTitle) ?? item.querySelector("textarea")?.value ?? ""
            : overrides.has(rowTitle)
              ? overrides.get(rowTitle) || ""
              : defaults.get(rowTitle) || "";
          pfUpdateDisciplineRow(item, value, overrides.has(rowTitle), saving, keep);
        }
        refreshSaveAll();
      }
    };

    const restoreSection = async (row) => {
      if (saving) return;
      const title = row?.dataset.pfDiscTitle || "";
      if (!title || !overrides.has(title)) return;
      const next = new Map(overrides);
      next.delete(title);
      const drafts = new Map();
      for (const item of list.querySelectorAll("[data-pf-disc-key]")) {
        const textarea = item.querySelector("textarea");
        if (textarea) drafts.set(item.dataset.pfDiscTitle, textarea.value);
      }
      let ok = false;
      saving = true;
      setModalHint(hint, "恢复中…", false);
      for (const item of list.querySelectorAll("[data-pf-disc-save], [data-pf-disc-restore]")) item.disabled = true;
      if (saveAllButton) saveAllButton.disabled = true;
      try {
        await putSource(pfSerializeDisciplineSource(next), title, "已恢复这一节默认，下一轮起用。");
        ok = true;
        toast(`已恢复「${title}」默认`);
      } catch (error) {
        if (error.message !== "forbidden") setModalHint(hint, `没恢复成：${error.message}`, true);
      } finally {
        saving = false;
        for (const item of list.querySelectorAll("[data-pf-disc-key]")) {
          const rowTitle = item.dataset.pfDiscTitle;
          const keep = !ok || rowTitle !== title;
          const value = keep
            ? drafts.get(rowTitle) ?? item.querySelector("textarea")?.value ?? ""
            : overrides.has(rowTitle)
              ? overrides.get(rowTitle) || ""
              : defaults.get(rowTitle) || "";
          pfUpdateDisciplineRow(item, value, overrides.has(rowTitle), saving, keep);
        }
        refreshSaveAll();
      }
    };

    /** 底部「保存」：把所有改过的节合并成一次 PUT；单节保存仍可用。 */
    const saveAllSections = async () => {
      if (saving) return;
      const next = new Map(overrides);
      let changed = 0;
      for (const row of list.querySelectorAll("[data-pf-disc-key]")) {
        const area = row.querySelector("textarea");
        if (!area || area.value === row._pfOriginal) continue;
        next.set(row.dataset.pfDiscTitle || "", area.value.trim());
        changed += 1;
      }
      if (!changed) return;
      saving = true;
      setModalHint(hint, "保存中…", false);
      for (const item of list.querySelectorAll("[data-pf-disc-save], [data-pf-disc-restore]")) item.disabled = true;
      if (saveAllButton) saveAllButton.disabled = true;
      let ok = false;
      try {
        await putSource(pfSerializeDisciplineSource(next), "", "已保存全部改动，下一轮起用。", { updateAll: true });
        ok = true;
        toast("纪律已保存");
      } catch (error) {
        if (error.message !== "forbidden") setModalHint(hint, `没存成：${error.message}`, true);
      } finally {
        saving = false;
        for (const row of list.querySelectorAll("[data-pf-disc-key]")) {
          const rowTitle = row.dataset.pfDiscTitle;
          if (ok) {
            const value = overrides.has(rowTitle) ? overrides.get(rowTitle) || "" : defaults.get(rowTitle) || "";
            pfUpdateDisciplineRow(row, value, overrides.has(rowTitle), saving);
          } else {
            // 没存成：保留用户草稿，只把按钮恢复到可再试
            pfRefreshDisciplineRow(row, saving);
            const restore = row.querySelector("[data-pf-disc-restore]");
            if (restore) restore.disabled = !overrides.has(rowTitle);
          }
        }
        refreshSaveAll();
      }
    };

    list.addEventListener("click", (event) => {
      const row = rowOf(event.target);
      if (!row) return;
      if (event.target.closest("[data-pf-disc-save]")) {
        event.preventDefault();
        void saveSection(row);
      } else if (event.target.closest("[data-pf-disc-restore]")) {
        event.preventDefault();
        void restoreSection(row);
      }
    });

    void (async () => {
      try {
        const response = await request(
          `/api/v1/partners/${encodeURIComponent(partnerId)}/discipline`,
          { cache: "no-store" },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          throw new Error(data.message || data.error || `HTTP ${response.status}`);
        }
        if (!editor.isConnected) return;
        defaults = pfParseDisciplineSource(data.defaultDiscipline || "");
        overrides = pfParseDisciplineSource(data.override || "");
        redLine = String(data.redLine || "");
        renderRows();
        if (loading) loading.hidden = true;
        editor.hidden = false;
        if (!data.editable) setModalHint(hint, "纪律覆盖当前由服务端关掉了，只能看默认。", true);
        else setModalHint(hint, "", false);
      } catch (error) {
        if (error.message === "forbidden") return;
        if (!body.isConnected) return;
        if (loading) loading.textContent = `读不到：${error.message}`;
      }
    })();
  }, { className: "modal-wide" });
}

/** 注入预览入口：纪律走编辑弹层，记忆走说明，在办 / 履历走原文。 */
function pfOpenInjectionViewer(partnerId, kind, onChanged) {
  if (kind === "discipline") {
    pfOpenDisciplineEditor(partnerId, onChanged);
    return;
  }
  // 记忆不是固定段：每轮按你说的话现查，没有"原文"可预览——如实说明 + 给去记忆页的入口。
  if (kind === "memory") {
    openModal("记忆怎么被召回", (body) => {
      body.innerHTML = `
        <p class="modal-desc">这一块不是恒定注入：记忆（经历 / 事实 / 偏好 / 人和物）和挂载项目的记忆，每轮都按你这句话算一遍相关度，够线的才浮出，不相关不占位。</p>
        <ul class="pf-inject-list">
          <li>所以这里没有「原文」可看——同一句话不同时间，浮出来的记忆不一样。</li>
          <li>关掉这一项：这一位不再自动带记忆（项目记忆也不带）；他仍可以用 recall 工具主动查。</li>
          <li>想让某个项目的记忆进这个打分池，去上面「每轮固定注入 → 负责项目」挂上它。</li>
          <li>想看具体记了些什么、改哪条，去「设置 → 注入 → 索引」。</li>
        </ul>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>关闭</button>
          <button class="modal-primary" type="button" id="pf-go-memory">去索引页</button>
        </div>`;
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
      body.querySelector("#pf-go-memory")?.addEventListener("click", () => {
        closeModal();
        location.hash = "#/settings/memory";
      });
    });
    return;
  }
  const def = PF_VIEW_FIELDS[kind];
  if (!def) return;
  openModal(
    `注入预览 · ${def.title}`,
    (body) => {
      body.innerHTML = `
        <p class="modal-desc">这是他现在每轮实际收到的原文。「等你批的」按会话算，预览里看不到；改不了的注释卡片上写了。</p>
        <pre class="pf-inject-text" id="pf-inject-text">读取中…</pre>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>关闭</button>
        </div>`;
      const box = body.querySelector("#pf-inject-text");
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
      void (async () => {
        try {
          const response = await request(
            `/api/v1/partners/${encodeURIComponent(partnerId)}/injection-preview`,
            { cache: "no-store" },
          );
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) {
            throw new Error(data.message || data.error || `HTTP ${response.status}`);
          }
          if (!box.isConnected) return; // 用户已经关掉弹层
          const text = typeof data[kind] === "string" ? data[kind] : "";
          box.textContent = text.trim() ? text : def.empty;
          box.classList.toggle("is-empty", !text.trim());
        } catch (error) {
          if (error.message === "forbidden") return;
          if (!box.isConnected) return;
          box.textContent = `读不到：${error.message}`;
          box.classList.add("is-empty");
        }
      })();
    },
    { className: "modal-wide" },
  );
}

/** 负责项目弹层（2026-11-15 多挂载：单选下拉改勾选清单；PARTNER_PROJECT_MEMORY 关时卡片不渲染）。 */
async function pfOpenProjectEditor(partnerId, partner, onChanged) {
  if (!("projectIds" in partner)) {
    toast("项目记忆未启用（PARTNER_PROJECT_MEMORY=false）");
    return;
  }
  const attached = Array.isArray(partner.projectIds) ? partner.projectIds : [];
  openModal("负责项目", async (body) => {
    body.innerHTML = `
      <p class="modal-desc">挂上项目只影响记忆，不限定他能改哪些目录：①他每轮固定收到一行「你负责的项目：…」（和纪律一样，100% 每句话都带）；②这些项目的记忆进召回池，按你这轮说的话打分，够相关的才浮出；往项目记忆里写也只写进挂上的这些项目。执事自己的私人记忆照旧。</p>
      <p class="modal-hint">总管 / 执事对所有已登记的工作区 / 项目本来就能读写（文件边界是登记根并集）；派出去的 worker 才由单子绑定的项目限定，一个单子只在一个项目里动。</p>
      <p class="modal-hint" id="pf-project-line" hidden></p>
      <div class="export-list" id="pf-project-list"><label class="export-part"><input type="checkbox" disabled /><span class="export-part-main"><span class="export-part-name">读取中…</span></span></label></div>
      <p class="modal-hint" id="pf-project-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>关闭</button>
        <button class="modal-primary" id="pf-project-save" type="button">保存</button>
      </div>`;
    const list = body.querySelector("#pf-project-list");
    const hint = body.querySelector("#pf-project-hint");
    const save = body.querySelector("#pf-project-save");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
    // 项目列表现拉（同模型菜单口径）：项目可能刚建 / 归档，或另一台设备改的。
    // 已归档的项目只在现挂着时补进清单（取消勾选就回不来，别给选项）。
    try {
      const response = await request("/api/v1/projects?includeArchived=1", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      const projects = (Array.isArray(data.projects) ? data.projects : [])
        .filter((project) => project && typeof project.id === "string")
        .filter((project) => !project.archived || attached.includes(project.id))
        .map((project) => ({
          id: project.id,
          name: project.name || project.id,
          archived: project.archived === true,
        }));
      // 现挂的项目已从库里移除：补一行占位（勾死），保存时不送这个 id——
      // 服务端对登记外的 uuid 一律 400，留着只会让保存永远失败。
      const rows = [...projects];
      for (const id of attached) {
        if (!rows.some((project) => project.id === id)) {
          rows.push({ id, name: "（已移除的项目）", archived: false, removed: true });
        }
      }
      list.innerHTML = rows
        .map((project) => {
          const checked = project.removed || attached.includes(project.id);
          const label = project.archived ? `${project.name}（已归档）` : project.name;
          return `<label class="export-part${project.removed ? " export-part-sub" : ""}">
            <input type="checkbox" data-project-id="${attr(project.id)}"${checked ? " checked" : ""}${project.removed ? " disabled" : ""} />
            <span class="export-part-main"><span class="export-part-name">${esc(label)}</span></span>
          </label>`;
        })
        .join("");
      if (rows.length === 0) {
        list.innerHTML = `<p class="modal-hint">还没有登记项目。先到 设置 →项目 里登记。</p>`;
        save.disabled = true;
      }
      // 「每轮会收到哪一行」实时跟着勾选走（100% 注入那半，别让人只在文档里听说）
      const line = body.querySelector("#pf-project-line");
      const refreshLine = () => {
        if (!line) return;
        const names = [...list.querySelectorAll("input[data-project-id]:checked")]
          .map((input) => rows.find((row) => row.id === input.dataset.projectId)?.name)
          .filter(Boolean);
        line.hidden = false;
        line.textContent = names.length
          ? `他现在每轮固定收到：你负责的项目：${names.join("、")}。`
          : "现在没挂项目：这一行不出现。";
      };
      refreshLine();
      list.addEventListener("change", refreshLine);
    } catch (error) {
      if (error.message === "forbidden") return;
      setModalHint(hint, "读不到项目接口，重启服务后再试", true);
      save.disabled = true;
    }
    save.addEventListener("click", async () => {
      if (save.disabled) return;
      save.disabled = true;
      setModalHint(hint, "保存中…", false);
      try {
        const next = [...list.querySelectorAll("input[data-project-id]:checked")].map(
          (input) => input.dataset.projectId,
        );
        const data = await pfPatchPartner(partnerId, { projectIds: next });
        const saved = Array.isArray(data.partner?.projectIds) ? data.partner.projectIds : [];
        partner.projectIds = saved;
        const cached = state.partners.find((item) => item.id === partnerId);
        if (cached) cached.projectIds = saved;
        setModalHint(
          hint,
          saved.length
            ? `已挂 ${saved.length} 个：他够得着这些项目的记忆，下一轮起生效。`
            : "已清空：不再带项目记忆。",
          false,
        );
        toast("负责项目已更新");
        save.disabled = false;
        if (typeof onChanged === "function") onChanged(saved);
      } catch (error) {
        if (error.message !== "forbidden") setModalHint(hint, `没存成：${error.message}`, true);
        save.disabled = false;
      }
    });
  });
}

/**
 * 负责项目摘要（2026-11-15 多挂载）：uuid 数组 → 项目名清单。≤2 个连着写，
 * 更多给「首个 等 N 个」——卡片摘要一行放不下整列。已移除的项目给占位词。
 */
function pfProjectNamesOf(partner, projects) {
  const mounted = Array.isArray(partner.projectIds) ? partner.projectIds : [];
  if (mounted.length === 0) return "";
  const pool = Array.isArray(projects) ? projects : [];
  const names = mounted.map(
    (id) => pool.find((project) => project?.id === id)?.name ?? "已移除的项目",
  );
  return names.length <= 2 ? names.join("、") : `${names[0]} 等 ${names.length} 个`;
}

/** 备选模型弹层（原能力卡的备选链折叠搬进来；编辑器 mountChainEditor 原样复用）。 */
function pfOpenChainModal(partnerId, detail, onChanged) {
  openModal(
    "备选模型",
    (body) => {
    body.innerHTML = `
      <p class="modal-desc">主模型不可用时按序降级。只含 keyEnv 名，不含密钥。</p>
      <div id="pf-chain"></div>
      <p class="modal-hint" id="pf-chain-hint"></p>`;
    mountChainEditor(body.querySelector("#pf-chain"), {
      partnerId,
      chain: Array.isArray(detail.modelChain) ? detail.modelChain : [],
      onSaved: (next) => {
        detail.modelChain = next;
        if (typeof onChanged === "function") onChanged(next);
      },
    });
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
  },
  { className: "modal-wide" },
  );
}

/* ── 能力两卡的统一口径（2026-11-15「编辑这个人」）──────────────
 *
 * 「例行任务」不只 routines 表：每晚「整理记忆」是进程内调度器，不在表里
 * （2026-11-14 定时任务页已经把它和例行合成一张清单）。这一页按人把两处合起来：
 * routines 来自 /api/v1/routines?partnerId=，整理记忆来自 /api/v1/agent/memory/nightly 的 scopes。
 * 总管（chief）的记忆 scope 是 global，其余执事是 partner:<id>。
 *
 * 「技能」也分两层：全局技能库（设置 → 注入 → 技能，所有会话共用）+ 他自带的技能
 * （家目录 skills/*.md，只对他生效）。之前只数第二层，看起来像"没用全局技能"。
 */

function pfMemoryScopeOf(partnerId) {
  return partnerId === "chief" ? "global" : `partner:${partnerId}`;
}

async function pfLoadMemoryNightly() {
  try {
    const response = await request("/api/v1/agent/memory/nightly", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

function pfMemoryTaskOf(nightly, partnerId) {
  if (!nightly) return null;
  const scope = pfMemoryScopeOf(partnerId);
  const task =
    (Array.isArray(nightly.scopes) ? nightly.scopes : []).find((item) => item?.scope === scope) || null;
  return {
    scope,
    task,
    at: String(nightly.at || "03:30"),
    master: nightly.enabled !== false,
    nextAt: nightly.nextAt || null,
  };
}

function pfMemorySummaryOf(nightly, partnerId) {
  const info = pfMemoryTaskOf(nightly, partnerId);
  if (!info) return "每晚整理读不到";
  if (!info.task) return "每晚整理已删除";
  if (!info.master) return "每晚整理总开关关";
  if (info.task.enabled === false) return "每晚整理已暂停";
  return `每晚整理 ${info.at}`;
}

async function pfLoadGlobalSkills(partnerId) {
  try {
    const query = partnerId ? `?partnerId=${encodeURIComponent(partnerId)}` : "";
    const response = await request(`/api/v1/agent/skills${query}`, { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return Array.isArray(data?.items) ? data.items : null;
  } catch {
    return null;
  }
}

/** 定时任务弹层：整理记忆 + 这个人的 routines / reminders（清单与编辑器两页共用）。 */
async function pfOpenRoutinesModal(partnerId, onChanged) {
  let nightly = await pfLoadMemoryNightly();

  openModal(
    "定时任务",
    (body) => {
      body.innerHTML = `
      <p class="modal-desc">到点让 TA 自己跑一轮的活：内容、时间、暂停都能改；例行规则与手动新建的任务在同一张清单。</p>
      <div class="pf-live-block" id="pf-memory-task"></div>
      <div class="pf-live-block">
        <div class="pf-live-head"><span>他自己的定时任务</span><span class="pf-tag" id="pf-routine-count"></span></div>
        <div class="pt-routine-list" id="pf-routines"><p class="pf-hint">读取中…</p></div>
        <details class="pf-new">
          <summary>${chevSvg("pf-new-chev chev")}<span>新建定时任务</span></summary>
          ${ptRoutineFormMarkup()}
        </details>
      </div>`;

      const memoryBox = body.querySelector("#pf-memory-task");
      const listBox = body.querySelector("#pf-routines");
      const countTag = body.querySelector("#pf-routine-count");

      const report = (routineCount) => {
        if (typeof onChanged === "function") {
          onChanged({ routineCount, memorySummary: pfMemorySummaryOf(nightly, partnerId) });
        }
      };

      const paintMemory = () => {
        if (!nightly) {
          memoryBox.innerHTML = `<p class="pf-hint is-error">读不到每晚整理（记忆功能未启用？）</p>`;
          return;
        }
        const info = pfMemoryTaskOf(nightly, partnerId);
        const tag = !info?.task
          ? "不在列表里"
          : !info.master
            ? "总开关关"
            : info.task.enabled === false
              ? "已暂停"
              : `每天 ${info.at}`;
        // 说明收进标题悬停；动作只留一颗 ⋯，跟下面那张清单同一形态（2026-11-18）。
        const tip =
          "到点先把自己的长记忆拆成短原子（完整原文存进原文档案，不删除），再回看重复、过时、说法不一致的条目。拆分是机械动作，不需要模型；对账只出建议，你逐条点应用才会改。改时间改的是全家共用的时刻，所有人一起变。";
        const head = (tail) =>
          `<div class="pf-live-head"><span data-tip="${attr(tip)}">每晚整理记忆（拆分 + 对账）</span>${tail}</div>`;
        if (!info?.task) {
          memoryBox.innerHTML = `${head(`<span class="pf-tag">${esc(tag)}</span>`)}<p class="pf-hint">这个人的每晚整理任务已被删除；删除不可恢复。</p>`;
          return;
        }
        if (!info.master) {
          memoryBox.innerHTML = `${head(`<span class="pf-tag">${esc(tag)}</span>`)}<p class="pf-hint">每晚整理的总开关关着，单个任务改不了。</p>`;
          return;
        }
        memoryBox.innerHTML = head(
          `<span class="pf-memory-tail"><span class="pf-tag">${esc(tag)}</span><span id="pf-memory-actions"></span></span>`,
        );
        const tools = memoryBox.querySelector("#pf-memory-actions");
        const openTimeEditor = () => {
          openScheduledTaskModal(
            {
              mode: "edit",
              item: {
                kind: "memory",
                id: info.scope,
                memoryScope: info.scope,
                partnerId: partnerId === "chief" ? "chief" : partnerId,
                title: "整理记忆",
                instruction: "整理记忆",
                nextAt: Date.parse(nightly?.nextAt || "") || Date.now(),
                enabled: info.task.enabled !== false,
                visibility: "",
                raw: info.task,
              },
            },
            () => {
              void pfOpenRoutinesModal(partnerId, onChanged);
            },
          );
        };
        const toggleMemory = async () => {
          try {
            const response = await request(
              `/api/v1/agent/memory/nightly/${encodeURIComponent(info.scope)}`,
              { method: "PATCH", body: JSON.stringify({ enabled: info.task.enabled === false }) },
            );
            if (!response.ok) throw new Error(String(response.status));
            const next = await pfLoadMemoryNightly();
            if (next) nightly = next;
            paintMemory();
            report(listBox.querySelectorAll(".rm-item").length);
          } catch (error) {
            if (error.message !== "forbidden") toast(`没改到：${error.message}`);
          }
        };
        // 2026-11-18：跟下面那张清单同一形态——动作收进右侧 ⋯，不再并排两颗文字按钮。
        const actions = document.createElement("button");
        actions.type = "button";
        actions.className = "rm-dots";
        actions.textContent = "⋯";
        actions.setAttribute("aria-haspopup", "menu");
        actions.setAttribute("aria-expanded", "false");
        actions.setAttribute("aria-label", "每晚整理的更多操作");
        actions.setAttribute("data-tip", "更多操作");
        actions.addEventListener("click", () => {
          openSecMenu(actions, [
            { label: "改时间", run: openTimeEditor },
            {
              label: info.task.enabled === false ? "启用" : "暂停",
              run: () => void toggleMemory(),
            },
          ]);
        });
        tools.append(actions);
      };
      paintMemory();

      ptWireRoutineForm(body, partnerId, listBox, {
        // 编辑器换掉了当前弹层：保存/删完后重新打开这张任务清单，卡片计数也一并刷新。
        onChanged: () => void pfOpenRoutinesModal(partnerId, onChanged),
      });
      const render = () =>
        ptRenderRoutineList(listBox, partnerId, {
          // 列表自己在改动后重拉；这里只回报计数（不再整页重画，弹层还开着）。
          onCount: (count) => {
            if (countTag) countTag.textContent = `${count} 条`;
            report(count);
          },
          onChanged: () => void pfOpenRoutinesModal(partnerId, onChanged),
        });
      void render();
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
    },
    { className: "modal-wide" },
  );
}

/**
 * 把一句话预填进对话输入框：不替用户发，只把要说的放好。
 * 总管走 openChiefChat；其他执事动态 import openPartnerChat（避免 partner-profile ↔ partner-roster 的 ESM 环）。
 */
async function pfGuideChat(partnerId, text) {
  const fill = () => {
    const input = document.getElementById("input");
    if (!input) return false;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    return true;
  };
  try {
    if (partnerId === "chief") {
      openChiefChat();
      // openChiefChat 是同步的：openChat / startNewChat 可能晚一步才清空输入框，
      // 所以总管这条统一延后填，别刚填完又被清掉。
      setTimeout(fill, 300);
      return;
    }
    const { openPartnerChat } = await import("./partner-roster.js");
    await openPartnerChat(partnerId);
  } catch (error) {
    toast(`没打开他的会话：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // 会话刚打开时输入框可能还没挂好；下一帧再试一次，不阻塞
  if (!fill()) setTimeout(fill, 250);
}

/**
 * 技能弹层（2026-11-15 个人技能可见性）：
 *   1) 全局已开：所有人都有，个人页锁死只读；
 *   2) 全局未开：可以只给这个人开，不影响别人；
 *   3) 他自带的：只对他生效，正文编辑走「让他改」对话。
 * 新建先落全局库（默认关），成功后自动只给这个人开。
 */
/** 技能弹层的代次：连点 / 新建后重开时，只让最后一次请求回填，避免旧响应盖新弹层。 */
let pfSkillsModalSeq = 0;

async function pfOpenSkillsModal(partnerId, onChanged) {
  const seq = ++pfSkillsModalSeq;
  let ownSkills = null;
  let globalSkills = null;
  let modalBody = null;
  // 先把弹层亮出来：全局技能多时读接口要一两秒，不能让点击看起来没反应。
  openModal(
    "技能",
    (body) => {
      modalBody = body;
      body.innerHTML = `<p class="modal-desc">正在读取技能…</p>
        <p class="pf-hint">全局技能多时可能要一两秒。</p>`;
    },
    { className: "modal-wide", closeOnMask: false },
  );

  try {
    [ownSkills, globalSkills] = await Promise.all([
      csLoadProfileSkills(partnerId).catch(() => null),
      pfLoadGlobalSkills(partnerId),
    ]);
  } catch {
    /* 读不到也照常出弹层，下面按空处理 */
  }

  // 连点 / 新建后重开：旧请求回来时不要再回填，否则会盖掉新弹层。
  if (seq !== pfSkillsModalSeq) return;

  const report = (items = globalSkills) => {
    if (typeof onChanged !== "function") return;
    try {
      onChanged({
        skillCount: Array.isArray(ownSkills) ? ownSkills.length : null,
        globalSkillTotal: Array.isArray(items) ? items.length : null,
        globalSkillEnabled: Array.isArray(items)
          ? items.filter((skill) => skill?.enabled === true).length
          : null,
        globalSkillOverride: Array.isArray(items)
          ? items.filter((skill) => skill?.partnerOverride === true).length
          : null,
      });
    } catch {
      /* 卡片摘要刷新失败不能挡住弹层 */
    }
  };
  report();

  if (seq !== pfSkillsModalSeq) return;

  const render = (body) => {
      body.innerHTML = `
      <p class="modal-desc">技能分三层：<strong>全局已开</strong>所有人都有，这里锁死只读；<strong>全局未开</strong>可以只给这个人开，不影响别人；<strong>他自带的</strong>只对他生效。新建技能会先建到全局库（默认关），再给这个人打开。名字是索引，正文按需取。想让他自己写/改，点下面的对话按钮；全局技能正文去「设置 → 注入 → 技能」改。</p>
      <div class="pf-skill-tools">
        <button class="pf-mini" id="pf-skill-guide" type="button">让他自己写</button>
        <button class="pf-mini" id="pf-skill-new" type="button">手动新建全局技能</button>
      </div>
      <div class="pf-live-block">
        <div class="pf-live-head"><span>全局已开（所有人都有）</span><span class="pf-tag" id="pf-global-on-count"></span></div>
        <div class="pf-skills" id="pf-global-on"><p class="pf-hint">读取中…</p></div>
      </div>
      <div class="pf-live-block">
        <div class="pf-live-head"><span>全局未开（只给这个人开）</span><span class="pf-tag" id="pf-global-off-count"></span></div>
        <div class="pf-skills" id="pf-global-off"><p class="pf-hint">读取中…</p></div>
      </div>
      <div class="pf-live-block">
        <div class="pf-live-head"><span>他自带的技能</span><span class="pf-tag" id="pf-own-count"></span></div>
        <div class="pf-skills" id="pf-own-skills"><p class="pf-hint">读取中…</p></div>
      </div>`;

      const globalOnBox = body.querySelector("#pf-global-on");
      const globalOffBox = body.querySelector("#pf-global-off");
      const ownBox = body.querySelector("#pf-own-skills");
      const globalOnCount = body.querySelector("#pf-global-on-count");
      const globalOffCount = body.querySelector("#pf-global-off-count");
      const ownCount = body.querySelector("#pf-own-count");

      const skillRow = (name, summary, right) => {
        const row = document.createElement("div");
        row.className = "pf-skill";
        row.innerHTML = `<span class="pf-skill-name">${esc(String(name || ""))}</span>
          <span class="pf-skill-sum">${esc(String(summary || ""))}</span>
          <span class="pf-skill-when">${esc(String(right || ""))}</span>`;
        return row;
      };

      const paintGlobalOn = () => {
        if (!Array.isArray(globalSkills)) {
          if (globalOnCount) globalOnCount.textContent = "—";
          globalOnBox.innerHTML = `<p class="pf-hint is-error">读不到全局技能库</p>`;
          return;
        }
        const items = globalSkills
          .filter((skill) => skill?.enabled === true)
          .slice()
          .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
        if (globalOnCount) globalOnCount.textContent = `${items.length} 本`;
        globalOnBox.replaceChildren();
        if (!items.length) {
          globalOnBox.innerHTML = `<p class="pf-hint">全局技能现在全关；下面从没开的里面挑。</p>`;
          return;
        }
        for (const skill of items) {
          globalOnBox.append(skillRow(skill.name, skill.summary, "已开 · 锁"));
        }
      };

      const paintGlobalOff = () => {
        if (!Array.isArray(globalSkills)) {
          if (globalOffCount) globalOffCount.textContent = "—";
          globalOffBox.innerHTML = `<p class="pf-hint is-error">读不到全局技能库</p>`;
          return;
        }
        const items = globalSkills
          .filter((skill) => skill?.enabled !== true)
          .slice()
          .sort(
            (a, b) =>
              Number(b?.partnerOverride === true) - Number(a?.partnerOverride === true) ||
              String(a?.name || "").localeCompare(String(b?.name || "")),
          );
        const overridden = items.filter((skill) => skill?.partnerOverride === true).length;
        if (globalOffCount) {
          globalOffCount.textContent = `共 ${items.length} 本 · 已给他开 ${overridden}`;
        }
        globalOffBox.replaceChildren();
        if (!items.length) {
          globalOffBox.innerHTML = `<p class="pf-hint">没有没开的全局技能。</p>`;
          return;
        }
        for (const skill of items) {
          const row = skillRow(skill.name, skill.summary, "");
          const slot = row.querySelector(".pf-skill-when");
          if (!slot) continue;
          slot.className = "pf-skill-switch";
          slot.innerHTML = switchMarkup(skill?.partnerOverride === true, {
            label: `给「${esc(String(skill?.name || ""))}」开`,
          });
          const sw = slot.querySelector(".switch");
          if (!sw) continue;
          sw.addEventListener("click", async () => {
            if (sw.disabled) return;
            const next = sw.getAttribute("aria-checked") !== "true";
            sw.disabled = true;
            try {
              const response = await request(
                `/api/v1/partners/${encodeURIComponent(partnerId)}/skills/${encodeURIComponent(skill.name)}/enabled`,
                { method: "PUT", body: JSON.stringify({ enabled: next }) },
              );
              const data = await response.json().catch(() => ({}));
              if (!response.ok) {
                toast(data.message || `改不了这个开关：HTTP ${response.status}`);
                return;
              }
              skill.partnerOverride = next;
              skill.partnerEnabled = next;
              paintGlobalOff();
              report(globalSkills);
            } catch (error) {
              toast(`改不了这个开关：${error instanceof Error ? error.message : String(error)}`);
            } finally {
              sw.disabled = false;
            }
          });
          globalOffBox.append(row);
        }
      };

      const paintOwn = () => {
        if (!Array.isArray(ownSkills)) {
          if (ownCount) ownCount.textContent = "—";
          ownBox.innerHTML = `<p class="pf-hint is-error">读不到他自带的技能</p>`;
          return;
        }
        if (ownCount) ownCount.textContent = `${ownSkills.length} 本`;
        ownBox.replaceChildren();
        if (!ownSkills.length) {
          ownBox.innerHTML = `<p class="pf-hint">还没有。点「让他自己写」，他把流程讲清楚就会落成技能。</p>`;
          return;
        }
        const sorted = ownSkills
          .slice()
          .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
        for (const skill of sorted) {
          const row = skillRow(skill.name, skill.summary, csProfileWhen(skill.updatedAt).slice(5, 10));
          const slot = row.querySelector(".pf-skill-when");
          if (slot) {
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "pf-mini";
            edit.textContent = "让他改";
            edit.addEventListener("click", () => {
              closeModal();
              void pfGuideChat(
                partnerId,
                `帮我改一下技能「${skill.name}」：先读一遍，再问我哪里要改。`,
              );
            });
            slot.append(edit);
          }
          ownBox.append(row);
        }
      };

      paintGlobalOn();
      paintGlobalOff();
      paintOwn();

      body.querySelector("#pf-skill-new")?.addEventListener("click", () => {
        openCreateSkillModal({
          existingHint:
            "已有同名全局技能。改正文去「设置 → 注入 → 技能」；只想让他按新流程做，用「让他自己写」。",
          onCreated: async (name) => {
            try {
              const response = await request(
                `/api/v1/partners/${encodeURIComponent(partnerId)}/skills/${encodeURIComponent(name)}/enabled`,
                { method: "PUT", body: JSON.stringify({ enabled: true }) },
              );
              const data = await response.json().catch(() => ({}));
              if (!response.ok) {
                toast(
                  data.message ||
                    "技能已建到全局库，但没给他打开；在「全局未开」里手动开一下。",
                );
              } else {
                toast(`已新建「${name}」，并只给这个人打开`);
              }
            } catch (error) {
              toast(
                `技能已建到全局库，但没给他打开：${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
            void pfOpenSkillsModal(partnerId, onChanged);
          },
        });
      });

      body.querySelector("#pf-skill-guide")?.addEventListener("click", () => {
        closeModal();
        void pfGuideChat(
          partnerId,
          "帮我写一份技能：先把这套流程的步骤、判据和常见坑问清楚，再落成技能；第一行写一句摘要。",
        );
      });

      body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
  };

  if (!modalBody) return;
  const modal = modalBody.closest("#modal");
  const title = document.getElementById("modal-title");
  if (!modal || modal.hidden || title?.textContent !== "技能") return;
  render(modalBody);
}

/** 卡片摘要的异步计数（例行 / 整理记忆 / 技能 / 项目名）：先画"读取中…"，回来就地改字。 */
async function pfPrefetchCardSummaries(partnerId, partner, apply) {
  const [routinesRes, remindersRes, skills, projectsRes, nightly, globalSkills] = await Promise.all([
    request(`/api/v1/routines?partnerId=${encodeURIComponent(partnerId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null),
    request("/api/v1/agent/reminders?includePaused=1", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null),
    csLoadProfileSkills(partnerId).catch(() => null),
    request("/api/v1/projects?includeArchived=1", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => null),
    pfLoadMemoryNightly(),
    pfLoadGlobalSkills(partnerId),
  ]);
  const routineCount = Array.isArray(routinesRes?.routines) ? routinesRes.routines.length : null;
  const reminderCount = Array.isArray(remindersRes?.reminders)
    ? remindersRes.reminders.filter((reminder) => {
        if (reminder.status === "terminal") return false;
        if (partnerId === "chief") return !reminder.partnerId || reminder.partnerId === "chief";
        return reminder.partnerId === partnerId;
      }).length
    : 0;
  apply({
    routineCount: routineCount === null ? null : routineCount + reminderCount,
    memorySummary: pfMemorySummaryOf(nightly, partnerId),
    skillCount: Array.isArray(skills) ? skills.length : null,
    globalSkillTotal: Array.isArray(globalSkills) ? globalSkills.length : null,
    globalSkillEnabled: Array.isArray(globalSkills)
      ? globalSkills.filter((skill) => skill?.enabled === true).length
      : null,
    globalSkillOverride: Array.isArray(globalSkills)
      ? globalSkills.filter((skill) => skill?.partnerOverride === true).length
      : null,
    projectName: pfProjectNamesOf(partner, projectsRes?.projects),
  });
}

/* ── ①·五 人格模块：预设 / 开关 / 静态内容 ───────────────────── */

/**
 * 静态模块编辑弹层：复用 modal-field / modal-input / pt-ta 这套现成样式（与人设编辑窗同族）。
 * 字段上限来自 PF_PERSONA_EDITORS（与 shared 的 limits 对齐），前端先拦一道，服务端仍全量复核。
 */
function pfOpenPersonaEditor(partnerId, persona, moduleKey, onSaved) {
  const editor = PF_PERSONA_EDITORS[moduleKey];
  if (!editor) return;
  const current = persona.contents?.[moduleKey] || {};
  openModal(
    `人格 · ${editor.title}`,
    (body) => {
      body.innerHTML = `
        <p class="modal-desc">${esc(editor.desc)}</p>
        <div class="pf-edit-grid">
          ${editor.fields.map((field) => pfPersonaFieldMarkup(field, current)).join("")}
        </div>
        <p class="modal-hint" id="pf-edit-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>取消</button>
          <button class="modal-primary" id="pf-edit-save" type="button">保存</button>
        </div>`;

      const hint = body.querySelector("#pf-edit-hint");
      const save = body.querySelector("#pf-edit-save");
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());

      save.addEventListener("click", async () => {
        if (save.disabled) return;
        const values = {};
        for (const field of editor.fields) {
          const node = body.querySelector(`[data-pf-field="${field.key}"]`);
          if (!node) continue;
          const parsed = pfPersonaValue(field, node.value);
          if (parsed.problem) {
            hint.textContent = parsed.problem;
            hint.classList.add("is-error");
            node.focus();
            return;
          }
          // 空字符串 = 清空该字段（服务端按字段合并，省略的字段不动）。
          values[field.key] = parsed.value;
        }
        save.disabled = true;
        hint.textContent = "保存中…";
        hint.classList.remove("is-error");
        try {
          const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/persona`, {
            method: "PUT",
            body: JSON.stringify({ contents: { [moduleKey]: values } }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            hint.textContent = data.message || data.error || `没存成：HTTP ${response.status}`;
            hint.classList.add("is-error");
            return;
          }
          // 草稿模式（2026-11-16）：这里只存内容。preset / modules 是页面上的未保存草稿，
          // 不能用服务端回读的旧开关把它们冲掉；底部保存时才一起落库。
          persona.contents = data.contents || persona.contents;
          closeModal();
          onSaved?.(moduleKey, persona.contents?.[moduleKey] || {});
          toast(`${editor.title}已保存`);
        } catch (error) {
          if (error.message === "forbidden") return;
          hint.textContent = `没存成：${error.message}`;
          hint.classList.add("is-error");
        } finally {
          save.disabled = false;
        }
      });
    },
    { className: "modal-wide" },
  );
}

/* ── ①·五 人格模块 · 活状态（2026-11-15 批2）──────────────────
 *
 * 三行活模块的展示与手改：印象（温度 + 全部条目）、心情（状态 + 原因 + 近况）、
 * 内心生活（日记 / 愿望 / 成长笔记）。都走同一个 PUT /persona 的 `living` 段，
 * 服务端写前过 zod；这里只是前端先拦输入长度，避免填完才被打回。
 * 刻意不做：数值好感度条、写成长笔记（它是生成的，只读展示）、改 SOUL。 */

const PF_OWNER_TIERS = ["生疏", "认识", "熟络", "亲近", "像家人"];
const PF_MOODS = ["平静", "愉悦", "低落", "烦躁", "疲惫"];

function pfShortTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 静态模块卡的状态摘要（口吻 / 里子 / 处境）：已填几项，没有就"没填"。 */
function pfStaticSummary(key, contents) {
  const data = contents?.[key] ?? {};
  let filled = 0;
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) {
      if (value.length) filled += 1;
    } else if (typeof value === "number") {
      filled += 1;
    } else {
      const text = String(value ?? "").trim();
      if (text && text !== "不限") filled += 1;
    }
  }
  return filled ? `已填 ${filled} 项` : "没填";
}

function pfLivingSummary(kind, living) {
  if (!living) return "—";
  if (kind === "impression") {
    return `${living.ownerTier} · ${living.impressions.length} 条`;
  }
  if (kind === "mood") {
    const reason = living.mood.reason ? ` · ${living.mood.reason}` : "";
    const at = pfShortTime(living.mood.updatedAt);
    return `${living.mood.mood}${reason}${at ? ` · ${at}` : ""}`;
  }
  if (kind === "heart") {
    const preview = living.diary.latestText ? ` · ${living.diary.latestText}` : "";
    return `日记 ${living.diary.count} 条${preview}`;
  }
  return "—";
}

/** 批3 三行的状态摘要（学习 / 主动性 / 人设库）。 */
function pfModuleStatus(module, persona) {
  if (module.learning) return `${persona.voice?.ruleCount ?? 0} 条表达习惯`;
  // 主动性只做追问（2026-11-15 打磨二轮：挂念已拆成独立卡，这里不再报挂念状态）
  if (module.proactive) return "回话末尾可追问";
  if (module.profiles) {
    const count = persona.profiles?.items?.length ?? 0;
    return `${count}/${persona.profiles?.limit ?? 5} 份`;
  }
  return "";
}

const PF_PRESET_NAMES = { work: "岗位", companion: "陪伴", allrounder: "全才", apprentice: "学徒", custom: "自定义" };

/**
 * 人设库/学习弹层共用的 PUT：只发 persona 段，返回最新 persona（失败时把话说在 hint）。
 * 不走 pfWirePersona 的 save 闭包，避免弹层和页面各存一份状态。
 */
async function pfPutPersona(partnerId, payload, hint) {
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/persona`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (hint) {
        hint.textContent = data.message || data.error || `没存成：HTTP ${response.status}`;
        hint.classList.add("is-error");
      }
      return null;
    }
    return data;
  } catch (error) {
    if (error.message !== "forbidden" && hint) {
      hint.textContent = `没存成：${error.message}`;
      hint.classList.add("is-error");
    }
    return null;
  }
}

function pfApplyPersonaData(persona, data, keepSwitches = false) {
  // 草稿模式（2026-11-16）：活状态 / 静态内容弹层只改内容，返回的 preset/modules/switches
  // 仍是服务端旧值；保留本地未保存的开关，别把页面草稿冲掉。
  const preset = persona.preset;
  const modules = persona.modules;
  const switches = persona.switches;
  persona.preset = data.preset ?? persona.preset;
  persona.modules = data.modules ?? persona.modules;
  persona.contents = data.contents ?? persona.contents;
  persona.switches = data.switches ?? persona.switches;
  persona.living = data.living ?? persona.living;
  persona.voice = data.voice ?? persona.voice;
  persona.proactivity = data.proactivity ?? persona.proactivity;
  persona.profiles = data.profiles ?? persona.profiles;
  if (keepSwitches) {
    persona.preset = preset;
    persona.modules = modules;
    persona.switches = switches;
  }
  return persona;
}

/** 学习弹层：只读展示已学规则（规则由结算 / 盘点时提炼，不在这里手改）。 */
function pfOpenVoiceModal(persona) {
  const voice = persona.voice;
  openModal(
    "人格 · 学习",
    (body) => {
      body.innerHTML = `
        <p class="modal-desc">这些是从主人说话里提炼出的表达习惯，只会存规则和 ≤40 字短例句，不存整段对话，也不进日志 / 导出。模型不可用时只保留确定性统计。</p>
        <div class="pf-live-list" id="pf-voice-list"></div>
        <p class="modal-hint" id="pf-voice-hint"></p>
        <div class="modal-actions">
          <button class="modal-primary" type="button" data-modal-cancel>关闭</button>
        </div>`;
      const list = body.querySelector("#pf-voice-list");
      const rules = voice?.rules ?? [];
      if (rules.length === 0) {
        list.innerHTML = `<p class="pf-hint">还没学到。开着他和主人相处一阵，结算时会自己长出来。</p>`;
      }
      for (const rule of rules) {
        const item = document.createElement("div");
        item.className = "pf-live-item";
        item.innerHTML = `
          <div class="pf-live-head">
            <span>${esc(PF_VOICE_KIND_NAMES[rule.kind] || "表达习惯")}</span>
            <span class="pf-live-at">${esc(pfShortTime(rule.at))}</span>
          </div>
          <p class="pf-live-text">${esc(rule.text)}${rule.example ? `<br><em class="pf-voice-eg">例：${esc(rule.example)}</em>` : ""}</p>`;
        list.append(item);
      }
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
    },
    { className: "modal-wide" },
  );
}

const PF_VOICE_KIND_NAMES = {
  sentenceLength: "句长",
  address: "称呼",
  interjection: "语气词",
  jargon: "黑话 / 新词",
};

/** 人设库弹层：存当前整套 / 应用某份 / 删某份。应用快照不碰 SOUL（服务端保证）。 */
function pfOpenProfilesModal(partnerId, persona, onChanged) {
  openModal(
    "人格 · 人设库",
    (body) => {
      body.innerHTML = `
        <p class="modal-desc">快照存的是整套人格（口吻 / 里子 / 处境 + 开关 + 预设）。应用会整份覆盖当前内容，但人设正文（SOUL）一个字节都不动。</p>
        <div class="pf-live-list" id="pf-profile-list"></div>
        <label class="modal-field"><span>再存一份当前的（≤${persona.profiles?.limit ?? 5} 份，名称 ≤24 字）</span>
          <input class="modal-input" id="pf-profile-name" type="text" maxlength="24" placeholder="如：工作态 / 陪伴态" />
        </label>
        <p class="modal-hint" id="pf-profile-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>关闭</button>
          <button class="modal-primary" id="pf-profile-save" type="button">存一份</button>
        </div>`;
      const hint = body.querySelector("#pf-profile-hint");
      const list = body.querySelector("#pf-profile-list");
      const paint = () => {
        list.replaceChildren();
        const items = persona.profiles?.items ?? [];
        if (items.length === 0) {
          list.innerHTML = `<p class="pf-hint">还没有快照。先配好这一套，再在下面存一份。</p>`;
          return;
        }
        for (const item of items) {
          const row = document.createElement("div");
          row.className = "pf-live-item";
          row.innerHTML = `
            <div class="pf-live-head">
              <span>${esc(item.name)}</span>
              <span class="pf-live-at">${esc(PF_PRESET_NAMES[item.preset] || item.preset)} · ${esc(pfShortTime(item.createdAt))}</span>
            </div>
            <div class="pf-live-tools">
              <button class="pf-mini" type="button" data-pf-apply>应用</button>
              <button class="pf-mini" type="button" data-pf-remove>删掉</button>
            </div>`;
          row.querySelector("[data-pf-apply]").addEventListener("click", async () => {
            const data = await pfPutPersona(partnerId, { profiles: { apply: { id: item.id } } }, hint);
            if (!data) return;
            // 应用快照 = 服务端整份替换；通知父层把草稿基线一起换掉。
            pfApplyPersonaData(persona, data);
            closeModal();
            toast(`已应用「${item.name}」`);
            onChanged?.(true);
          });
          row.querySelector("[data-pf-remove]").addEventListener("click", async () => {
            const data = await pfPutPersona(partnerId, { profiles: { remove: { id: item.id } } }, hint);
            if (!data) return;
            // 只删快照：保留页面里未保存的开关草稿。
            pfApplyPersonaData(persona, data, true);
            paint();
            onChanged?.();
          });
          list.append(row);
        }
      };
      paint();
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
      body.querySelector("#pf-profile-save")?.addEventListener("click", async () => {
        const save = body.querySelector("#pf-profile-save");
        if (save.disabled) return;
        const name = body.querySelector("#pf-profile-name")?.value.trim() ?? "";
        if (!name) {
          hint.textContent = "先给这份人设起个名字";
          hint.classList.add("is-error");
          return;
        }
        save.disabled = true;
        hint.textContent = "保存中…";
        hint.classList.remove("is-error");
        const data = await pfPutPersona(partnerId, { profiles: { save: { name } } }, hint);
        save.disabled = false;
        if (!data) return;
        // 只存快照：保留页面里未保存的开关草稿。
        pfApplyPersonaData(persona, data, true);
        body.querySelector("#pf-profile-name").value = "";
        hint.textContent = "已存一份。";
        paint();
        onChanged?.();
      });
    },
    { className: "modal-wide" },
  );
}

async function pfReloadPersona(partnerId) {
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/persona`, {
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) return null;
    return data;
  } catch {
    return null;
  }
}

/** 手改活状态的一次 PUT；成功回调 `onOk`（拿到最新 persona），失败把话说在弹层里。 */
async function pfPutLiving(partnerId, living, hint, onOk) {
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/persona`, {
      method: "PUT",
      body: JSON.stringify({ living }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (hint) {
        hint.textContent = data.message || data.error || `没存成：HTTP ${response.status}`;
        hint.classList.add("is-error");
      }
      return null;
    }
    onOk?.(data);
    return data;
  } catch (error) {
    if (error.message !== "forbidden" && hint) {
      hint.textContent = `没存成：${error.message}`;
      hint.classList.add("is-error");
    }
    return null;
  }
}

/** 印象弹层：温度五档 + 全部条目（可改 / 可删）+ 加一条对主人的印象。 */
function pfOpenImpressionModal(partnerId, persona, onChanged) {
  const living = persona.living;
  if (!living) return;
  openModal(
    "人格 · 印象",
    (body) => {
      body.innerHTML = `
        <p class="modal-desc">这些是他对具体的人的真实判断，只从结算时真发生的事提炼。温度只有五档文字；跨档会留一条变化账。</p>
        <label class="modal-field"><span>关系温度</span>
          <select class="set-input" id="pf-tier">
            ${PF_OWNER_TIERS.map((tier) => `<option value="${tier}"${tier === living.ownerTier ? " selected" : ""}>${tier}</option>`).join("")}
          </select>
        </label>
        ${living.tierNote ? `<p class="modal-hint">最近一次变化：${esc(living.tierNote)}</p>` : ""}
        <div class="pf-live-list" id="pf-imp-list"></div>
        <label class="modal-field"><span>再加一条对主人的印象（≤120 字）</span>
          <textarea class="pt-ta" id="pf-imp-new" rows="2" maxlength="120"></textarea>
        </label>
        <p class="modal-hint" id="pf-imp-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>关闭</button>
          <button class="modal-primary" id="pf-imp-save" type="button">保存改动</button>
        </div>`;
      const hint = body.querySelector("#pf-imp-hint");
      const list = body.querySelector("#pf-imp-list");
      const removed = new Set();
      if (living.impressions.length === 0) {
        list.innerHTML = `<p class="pf-hint">还没有印象。开着他相处一阵，结算时会自己长出来。</p>`;
      }
      for (const entry of living.impressions) {
        const item = document.createElement("div");
        item.className = "pf-live-item";
        item.dataset.id = entry.id;
        item.innerHTML = `
          <div class="pf-live-head">
            <span>对${esc(entry.subjectName)}${entry.tierChange ? ` · 温度到「${esc(entry.tierChange)}」` : ""}</span>
            <span class="pf-live-at">${esc(pfShortTime(entry.at))}${entry.source === "manual" ? " · 手写" : ""}</span>
          </div>
          <textarea class="pt-ta" rows="2" maxlength="120">${esc(entry.text)}</textarea>
          <div class="pf-live-tools">
            <button class="pf-mini" type="button" data-pf-drop>删掉这条</button>
          </div>`;
        item.querySelector("[data-pf-drop]").addEventListener("click", () => {
          removed.add(entry.id);
          item.remove();
        });
        list.append(item);
      }
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
      body.querySelector("#pf-imp-save")?.addEventListener("click", async () => {
        const save = body.querySelector("#pf-imp-save");
        if (save.disabled) return;
        save.disabled = true;
        hint.textContent = "保存中…";
        hint.classList.remove("is-error");
        // 温度先落（一次可解释的手改事件），再逐条改 / 删，最后加新条目。
        const tier = body.querySelector("#pf-tier")?.value;
        if (tier && tier !== living.ownerTier) {
          await pfPutLiving(partnerId, { ownerTier: tier }, hint);
        }
        for (const entry of living.impressions) {
          const node = list.querySelector(`[data-id="${entry.id}"]`);
          if (removed.has(entry.id)) {
            await pfPutLiving(partnerId, { impression: { remove: entry.id } }, hint);
            continue;
          }
          const text = node?.querySelector("textarea")?.value.trim();
          if (text && text !== entry.text) {
            await pfPutLiving(partnerId, { impression: { update: { id: entry.id, text } } }, hint);
          }
        }
        const added = body.querySelector("#pf-imp-new")?.value.trim();
        if (added) {
          await pfPutLiving(
            partnerId,
            { impression: { add: { subject: "owner", text: added.slice(0, 120) } } },
            hint,
          );
        }
        save.disabled = false;
        if (hint.classList.contains("is-error")) return;
        closeModal();
        toast("印象已保存");
        onChanged?.();
      });
    },
    { className: "modal-wide" },
  );
}

/** 心情弹层：五种枚举 + 原因 + 近况（手改 = manual，规则下次仍可再改）。 */
function pfOpenMoodModal(partnerId, persona, onChanged) {
  const living = persona.living;
  if (!living) return;
  openModal("人格 · 心情", (body) => {
    body.innerHTML = `
      <p class="modal-desc">心情只有五种。规则是可见的：被明确致谢 → 愉悦；连续两单失败或中止 → 低落；72 小时没有新单落账 → 平静。手改随时生效，下一次规则事件仍可以再改。</p>
      <label class="modal-field"><span>此刻</span>
        <select class="set-input" id="pf-mood">
          ${PF_MOODS.map((mood) => `<option value="${mood}"${mood === living.mood.mood ? " selected" : ""}>${mood}</option>`).join("")}
        </select>
      </label>
      <label class="modal-field"><span>原因（≤60 字，可空）</span>
        <input class="set-input" id="pf-mood-reason" maxlength="60" value="${attr(living.mood.reason)}" />
      </label>
      <label class="modal-field"><span>近况一句（≤60 字，可空）</span>
        <input class="set-input" id="pf-nearby" maxlength="60" value="${attr(living.mood.nearby)}" />
      </label>
      <p class="modal-hint" id="pf-mood-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="pf-mood-save" type="button">保存</button>
      </div>`;
    const hint = body.querySelector("#pf-mood-hint");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
    body.querySelector("#pf-mood-save")?.addEventListener("click", async () => {
      const save = body.querySelector("#pf-mood-save");
      if (save.disabled) return;
      save.disabled = true;
      hint.textContent = "保存中…";
      hint.classList.remove("is-error");
      const data = await pfPutLiving(
        partnerId,
        {
          mood: body.querySelector("#pf-mood")?.value,
          moodReason: body.querySelector("#pf-mood-reason")?.value.trim() ?? "",
          nearby: body.querySelector("#pf-nearby")?.value.trim() ?? "",
        },
        hint,
      );
      save.disabled = false;
      if (!data) return;
      closeModal();
      toast("心情已保存");
      onChanged?.();
    });
  });
}

/** 内心生活弹层：愿望清单（可改）+ 日记列表（赞 / 删 / 补一条）+ 成长笔记（只读）。 */
function pfOpenHeartModal(partnerId, persona, onChanged) {
  const living = persona.living;
  if (!living) return;
  openModal(
    "人格 · 内心生活",
    (body) => {
      body.innerHTML = `
        <p class="modal-desc">日记与成长笔记是他在盘点时自己写的；你可以点赞、删掉、补一条，但成长笔记不会回写人设正文。</p>
        <div class="pf-live-block">
          <div class="pf-live-head"><span>愿望清单（≤${10} 条，每条 ≤40 字）</span></div>
          <textarea class="pt-ta" id="pf-wishes" rows="4" placeholder="一行一条">${esc(living.wishes.join("\n"))}</textarea>
          <div class="pf-live-tools"><button class="pf-mini" type="button" id="pf-wishes-save">保存愿望</button></div>
        </div>
        <div class="pf-live-block">
          <div class="pf-live-head"><span>日记（${living.diary.count} 条）</span></div>
          <div class="pf-live-list" id="pf-diary-list"></div>
          <label class="modal-field"><span>补一条日记（≤300 字）</span>
            <textarea class="pt-ta" id="pf-diary-new" rows="2" maxlength="300"></textarea>
          </label>
          <div class="pf-live-tools"><button class="pf-mini" type="button" id="pf-diary-add">写进去</button></div>
        </div>
        <div class="pf-live-block">
          <div class="pf-live-head"><span>成长笔记（最近一节，只读）</span></div>
          <p class="pf-live-text">${living.growth ? esc(living.growth) : "还没有。"}</p>
        </div>
        <p class="modal-hint" id="pf-heart-hint"></p>
        <div class="modal-actions">
          <button class="modal-primary" type="button" data-modal-cancel>关闭</button>
        </div>`;
      const hint = body.querySelector("#pf-heart-hint");
      const list = body.querySelector("#pf-diary-list");
      const paintDiary = (entries) => {
        list.replaceChildren();
        if (entries.length === 0) {
          list.innerHTML = `<p class="pf-hint">还没有日记。每周盘点跑完，他会自己写一条。</p>`;
          return;
        }
        for (const entry of entries) {
          const item = document.createElement("div");
          item.className = "pf-live-item";
          item.innerHTML = `
            <div class="pf-live-head">
              <span>${esc(pfShortTime(entry.at))}${entry.source === "manual" ? " · 手写" : ""}</span>
              <span class="pf-live-tools">
                <button class="pf-mini${entry.liked ? " is-on" : ""}" type="button" data-pf-like>${entry.liked ? "已赞" : "赞"}</button>
                <button class="pf-mini" type="button" data-pf-del>删</button>
              </span>
            </div>
            <p class="pf-live-text">${esc(entry.text)}</p>`;
          item.querySelector("[data-pf-like]").addEventListener("click", async () => {
            const data = await pfPutLiving(
              partnerId,
              { diary: entry.liked ? { unlike: entry.id } : { like: entry.id } },
              hint,
            );
            if (data?.living) paintDiary(data.living.diary.entries);
            onChanged?.();
          });
          item.querySelector("[data-pf-del]").addEventListener("click", async () => {
            const data = await pfPutLiving(partnerId, { diary: { remove: entry.id } }, hint);
            if (data?.living) paintDiary(data.living.diary.entries);
            onChanged?.();
          });
          list.append(item);
        }
      };
      paintDiary(living.diary.entries);
      body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
      body.querySelector("#pf-wishes-save")?.addEventListener("click", async () => {
        const wishes = String(body.querySelector("#pf-wishes")?.value ?? "")
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean);
        if (wishes.length > 10 || wishes.some((item) => [...item].length > 40)) {
          hint.textContent = "愿望最多 10 条、每条不超过 40 字";
          hint.classList.add("is-error");
          return;
        }
        const data = await pfPutLiving(partnerId, { wishes }, hint);
        if (data) toast("愿望已保存");
        onChanged?.();
      });
      body.querySelector("#pf-diary-add")?.addEventListener("click", async () => {
        const text = body.querySelector("#pf-diary-new")?.value.trim();
        if (!text) return;
        const data = await pfPutLiving(partnerId, { diary: { add: text } }, hint);
        if (data?.living) {
          body.querySelector("#pf-diary-new").value = "";
          paintDiary(data.living.diary.entries);
        }
        onChanged?.();
      });
    },
    { className: "modal-wide" },
  );
}

function pfOpenLivingEditor(partnerId, persona, kind, onChanged) {
  if (kind === "impression") pfOpenImpressionModal(partnerId, persona, onChanged);
  else if (kind === "mood") pfOpenMoodModal(partnerId, persona, onChanged);
  else if (kind === "heart") pfOpenHeartModal(partnerId, persona, onChanged);
}

/** 读插件页的父子锁态（2026-11-16）：人设页只关心 effectiveValue / lockedBy；
 *  端点不可用 / 没令牌就返回空 Map，页面按旧行为不锁。 */
async function pfLoadPluginFlags() {
	const rows = new Map();
	try {
		const response = await request("/api/v1/agent/flags", { cache: "no-store" });
		if (!response.ok) return rows;
		const data = await response.json().catch(() => ({}));
		for (const flag of Array.isArray(data.flags) ? data.flags : []) {
			if (flag && typeof flag.key === "string") rows.set(flag.key, flag);
		}
	} catch {
		/* 403 / 网络错误：不锁，照旧可用 */
	}
	return rows;
}

async function pfWirePersona(root, partnerId, partner, detail, onDraftChange) {
  const section = root.querySelector("#pf-persona");
  const presetBox = root.querySelector("#pf-persona-presets");
  const cardsBox = root.querySelector("#pf-persona-cards");
  const injectedBox = root.querySelector("#pf-injected-cards");
  const recallBox = root.querySelector("#pf-recall-cards");
  const advancedBox = root.querySelector("#pf-advanced-cards");
  const hint = root.querySelector("#pf-persona-hint");
  if (!section || !presetBox || !cardsBox || !hint || !injectedBox || !recallBox || !advancedBox) return;

  /** 端点形状与 shared 的 PartnerPersonaView 一致；这里只留界面要用的三样。
   *  persona = null 时（还没读到 / 总开关关）只画岗位动作卡与能力卡（2026-11-15 并入口径）。 */
  let persona = null;
  let personaEnabled = false;
  let saving = false;
  /** 上一次服务端确认的 persona（草稿的对照）；页面级保存成功后整体替换。 */
  let baseline = null;
  const baselinePartner = {
    toolProjection: partner.toolProjection ?? null,
    diary: partner.diary === true,
  };
  const MODULE_IDS = PF_PERSONA_MODULES.map((module) => module.id);
  const SWITCH_IDS = ["moodAffectTone", "nudgeEnabled", "memoryRecallEnabled"];
  const moduleDirty = (id) =>
    Boolean(persona && baseline) && persona.modules?.[id] !== baseline.modules?.[id];
  const switchDirty = (key) =>
    Boolean(persona && baseline) &&
    Boolean(persona.switches?.[key]) !== Boolean(baseline.switches?.[key]);
  const dirtyCount = () => {
    if (!persona || !baseline) return 0;
    let count = 0;
    if (persona.preset !== baseline.preset) count += 1;
    for (const id of MODULE_IDS) if (moduleDirty(id)) count += 1;
    for (const key of SWITCH_IDS) if (switchDirty(key)) count += 1;
    if ((partner.toolProjection ?? null) !== baselinePartner.toolProjection) count += 1;
    if ((partner.diary === true) !== baselinePartner.diary) count += 1;
    return count;
  };
  const notify = () => onDraftChange?.();
  // 跨层父子门（2026-11-16）：人设页的子开关不在 FLAG_DEFS 里，只能读插件页返回的
  // effectiveValue / lockedBy，再决定控件锁不锁。读不到就按旧行为（不锁），不挡页面。
  const pluginFlags = await pfLoadPluginFlags();
  const PF_PARENT_LABELS = {
    MEMORY_ENABLED: "记忆总闸",
    PARTNER_MEMORY_RECALL: "记忆召回（总闸）",
    TOOL_PROJECTION: "工具结果整理",
    COMPANIONS_ENABLED: "执事体系",
  };
  const flagRowOf = (key) => pluginFlags.get(key);
  const flagLockOf = (key) => {
    const row = flagRowOf(key);
    if (!row) return null;
    return row.lockedBy || (row.effectiveValue === "false" || row.value === "false" ? key : null);
  };
  const flagNameOf = (key) => PF_PARENT_LABELS[key] || key;
  const memoryRecallLock = flagLockOf("PARTNER_MEMORY_RECALL");
  const memoryLock = flagLockOf("MEMORY_ENABLED");
  const projectionLock = flagLockOf("TOOL_PROJECTION");
  // 卡片摘要的异步计数（例行 / 整理记忆 / 技能 / 项目名）：回来就重画一次
  const counts = {
    routineCount: null,
    memorySummary: "",
    skillCount: null,
    globalSkillTotal: null,
    globalSkillEnabled: null,
    globalSkillOverride: null,
    projectName: "",
  };

  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", Boolean(isError && text));
  };

  /* ── 卡片定义 ──
     persona 模块卡：开关 = persona.modules[id]；contract/goal 带编辑弹层，
     discipline/workHistory/currentWork 是纯注入开关（点卡 = 切开关）；纪律卡另外带编辑层。
     row 卡：开关挂在 partner 行字段（PATCH）；plain 卡：无开关，点开即用。 */
  const mod = (id) => PF_PERSONA_MODULES.find((item) => item.id === id);

  const moduleSummary = (module) => {
    if (!persona) return "—";
    if (module.editable) return pfStaticSummary(module.editable, persona.contents);
    if (module.living) return pfLivingSummary(module.living, persona.living);
    if (module.id === "contract") {
      if (!("contract" in detail)) return "未启用";
      return String(detail.contract ?? "").length > 0 ? `${String(detail.contract ?? "").length} 字` : "没写";
    }
    if (module.id === "goal") {
      const goal = String(detail.currentGoal ?? "").trim();
      return goal ? [...goal].slice(0, 14).join("") + (goal.length > 14 ? "…" : "") : "没设";
    }
    return pfModuleStatus(module, persona);
  };

  const moduleCard = (module) => {
    const on = persona ? persona.modules?.[module.id] === true : null;
    // 学习模块的父闸是记忆总闸：总闸关着时它不跑，但 persona.modules.learning 的存储值保留。
    const lock = module.id === "learning" ? memoryLock : null;
    const hasEditor =
      Boolean(module.editable) ||
      Boolean(module.living) ||
      module.id === "contract" ||
      module.id === "goal" ||
      module.id === "learning" ||
      module.id === "profiles";
    const switchOnly = !hasEditor; // 纯注入开关：点卡 = 切开关
    const card = document.createElement("div");
    card.className = "pf-mod-card";
    const clickable = hasEditor || switchOnly;
    if (clickable) {
      card.classList.add("is-clickable");
      card.dataset.pfCard = module.id;
    }
    // 关 = 不能改、不进提示词（内容保留）：内容卡降半档视觉，点了说一句
    if ((hasEditor && persona && !on) || lock) card.classList.add("is-off");
    const label = document.createElement("div");
    label.className = "pf-mod-label";
    const name = document.createElement("span");
    name.className = "pf-mod-name";
    name.dataset.tip = lock
      ? `${module.tip} 当前「${flagNameOf(lock)}」关着：显示关、不能打开；原设置保留，总闸重开后恢复。`
      : module.tip;
    name.textContent = module.name;
    label.append(name);
    const sum = document.createElement("span");
    sum.className = "pf-mod-sum";
    const baseSummary = moduleSummary(module);
    sum.textContent = lock ? `${baseSummary === "—" ? "" : `${baseSummary} · `}关（${flagNameOf(lock)}关闭）` : baseSummary;
    label.append(sum);
    if (persona) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "switch";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", module.name);
      toggle.setAttribute("aria-checked", String(lock ? false : on === true));
      if (lock) {
        toggle.disabled = true;
        toggle.setAttribute("aria-disabled", "true");
      }
      toggle.dataset.pfMod = module.id;
      toggle.innerHTML = `<span class="switch-thumb" aria-hidden="true"></span>`;
      card.append(label, toggle);
    } else {
      // 总开关关着（PARTNER_PERSONA_MODULES=false）= 旧行为"谁也不裁"：卡不带开关，恒可编辑
      card.append(label);
    }
    return card;
  };

  const rowCard = (def) => {
    const card = document.createElement("div");
    card.className = "pf-mod-card is-clickable";
    card.dataset.pfRow = def.id;
    // 结果整理的父闸 = 插件页 TOOL_PROJECTION；关着时这张行也显示关、不能单独开。
    const lock = def.id === "projection" ? projectionLock : null;
    if (lock) {
      card.classList.add("is-off");
      card.dataset.pfLocked = "1";
      card.setAttribute("aria-disabled", "true");
    }
    const label = document.createElement("div");
    label.className = "pf-mod-label";
    const name = document.createElement("span");
    name.className = "pf-mod-name";
    name.dataset.tip = lock
      ? `${def.tip} 当前「${flagNameOf(lock)}」关着：显示关、不能单独打开；原设置保留，总闸重开后恢复。`
      : def.tip;
    name.textContent = def.name;
    label.append(name);
    const sum = document.createElement("span");
    sum.className = "pf-mod-sum";
    sum.textContent = lock ? `关（${flagNameOf(lock)}关闭）` : def.summary();
    label.append(sum);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "switch";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", def.name);
    toggle.setAttribute("aria-checked", String(lock ? false : def.checked() === true));
    if (lock) {
      toggle.disabled = true;
      toggle.setAttribute("aria-disabled", "true");
    }
    toggle.innerHTML = `<span class="switch-thumb" aria-hidden="true"></span>`;
    card.append(label, toggle);
    return card;
  };

  const plainCard = (def) => {
    const card = document.createElement("div");
    card.className = "pf-mod-card is-clickable";
    card.dataset.pfPlain = def.id;
    const label = document.createElement("div");
    label.className = "pf-mod-label";
    const name = document.createElement("span");
    name.className = "pf-mod-name";
    name.dataset.tip = def.tip;
    name.textContent = def.name;
    label.append(name);
    const sum = document.createElement("span");
    sum.className = "pf-mod-sum";
    sum.textContent = def.summary();
    label.append(sum);
    card.append(label);
    return card;
  };

  const ROW_DEFS = {
    // 结果整理（2026-11-15 打磨：原「结果契约」改名 + 三态循环改两态）。
    // 全局 TOOL_PROJECTION 默认开；这张卡只做"对他一个人强制关"的例外，
    // 所以界面上就两态：开（跟随全局默认）↔ 关（只他一个回原始结果）。
    projection: {
      id: "projection",
      name: "结果整理",
      tip: "他汇报干活结果时，把工具的原始输出整理成人能读的文件卡 / 改动摘要。子开关，只管他一个：关了就他自己回原始结果；总闸在 设置 → 插件（TOOL_PROJECTION）。",
      summary: () => (partner.toolProjection === 0 ? "关（只他一个回原始结果）" : "开"),
      checked: () => partner.toolProjection !== 0,
    },
    diary: {
      id: "diary",
      name: "日记执事",
      tip: "手机端记日记走他（原文归档 + 周报）。全家只有一位。",
      summary: () => (partner.diary ? "是他" : "不是"),
      checked: () => partner.diary === true,
    },
  };

  // 每轮固定注入（2026-11-15 打磨二轮命名）：100% 每句话都带，不带筛。
  // 纪律：宿主默认可看、行为纪律可写覆盖；主人数据红线固定。在办 / 履历现查现拼，
  // 点卡看实际注入原文；负责项目在这一区，是因为挂载会让他每轮收到一行项目索引（100%），
  // 而「项目记忆」是另一件事——那些进下面「按相关度召回」的打分池。
  const VIEW_DEFS = [
    {
      id: "discipline",
      name: "纪律",
      tip: "宿主给了一份默认行为纪律；验证铁律、裁决口径、干活期间的安静、提问纪律等七节在弹层里逐节改，每节单独保存。主人数据红线固定注入，不可覆盖。点开编辑或看默认原文。",
      switchKind: "module",
      switchKey: "discipline",
      summary: () => (persona ? (persona.modules?.discipline === true ? "开 · 七节" : "关") : ""),
      checked: () => persona?.modules?.discipline === true,
    },
    {
      id: "currentWork",
      name: "在办状态",
      tip: "在办的单、最近一单结果——现查任务记录现拼，固定注入；没活干时整段不出现。点开看现在实际注入的原文。",
      summary: () => "",
    },
    {
      id: "workHistory",
      name: "履历摘要",
      tip: "近 10 单完成 / 失败 / 中止的条数——从干活记录现查现拼，固定注入；没干过活时整段不出现。点开看现在实际注入的原文。",
      summary: () => "",
    },
  ];

  // 按相关度召回（2026-11-15 打磨二轮）：记忆四类 + 挂载项目的记忆。先打分再决定进不进，
  // 所以这里没有"原文"可预览——点卡是机制说明 + 去记忆页。开关 = 关掉这一位自动带记忆。
  const RECALL_DEFS = [
    {
      id: "memory",
      name: "记忆 + 项目记忆",
      tip: "经历 / 事实 / 偏好 / 人和物，加上挂载项目的记忆——每轮按你这句话打分，够相关的才浮出。这是子开关：关了这一位不再自动带（还能用 recall 主动查）；总闸在 设置 → 插件（PARTNER_MEMORY_RECALL）。",
      switchKind: "persona",
      switchKey: "memoryRecallEnabled",
      summary: () => (persona ? (persona.switches?.memoryRecallEnabled === false ? "关" : "开") : ""),
      checked: () => persona?.switches?.memoryRecallEnabled !== false,
    },
  ];

  // 独立子开关卡（2026-11-15 打磨二轮）：开关落在 persona.switches，不挂模块。
  // 点卡体 = 切开关（没有编辑层），所以整张卡就是开关的热区。
  const plainSwitchCard = (def) => {
    const card = document.createElement("div");
    card.className = "pf-mod-card is-clickable";
    card.dataset.pfSwitchCard = def.id;
    const label = document.createElement("div");
    label.className = "pf-mod-label";
    const name = document.createElement("span");
    name.className = "pf-mod-name";
    name.dataset.tip = def.tip;
    name.textContent = def.name;
    label.append(name);
    const sum = document.createElement("span");
    sum.className = "pf-mod-sum";
    sum.textContent = def.summary();
    label.append(sum);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "switch";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", def.name);
    toggle.setAttribute("aria-checked", String(def.checked() === true));
    toggle.dataset.pfSwitch = def.id === "nudge" ? "nudgeEnabled" : def.id;
    toggle.innerHTML = `<span class="switch-thumb" aria-hidden="true"></span>`;
    card.append(label, toggle);
    return card;
  };

  const viewCard = (def) => {
    const card = document.createElement("div");
    card.className = "pf-mod-card is-clickable";
    card.dataset.pfView = def.id;
    // 记忆 + 项目记忆：父 = 插件页的记忆召回总闸（它自己还受记忆总闸约束）。
    const lock = def.switchKey === "memoryRecallEnabled" ? memoryRecallLock : null;
    if (lock) card.classList.add("is-off");
    const label = document.createElement("div");
    label.className = "pf-mod-label";
    const name = document.createElement("span");
    name.className = "pf-mod-name";
    name.dataset.tip = lock
      ? `${def.tip} 当前「${flagNameOf(lock)}」关着：显示关、不能单独打开；原设置保留，总闸重开后恢复。`
      : def.tip;
    name.textContent = def.name;
    label.append(name);
    const sum = document.createElement("span");
    sum.className = "pf-mod-sum";
    sum.textContent = lock ? `关（${flagNameOf(lock)}关闭）` : def.summary();
    label.append(sum);
    if (def.switchKey && persona) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "switch";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", def.name);
      toggle.setAttribute("aria-checked", String(lock ? false : def.checked() === true));
      if (lock) {
        toggle.disabled = true;
        toggle.setAttribute("aria-disabled", "true");
      }
      // 开关落点两种：人格模块开关（纪律）/ 人格子开关（记忆召回）
      if (def.switchKind === "persona") toggle.dataset.pfSwitch = def.switchKey;
      else toggle.dataset.pfMod = def.switchKey;
      toggle.innerHTML = `<span class="switch-thumb" aria-hidden="true"></span>`;
      card.append(label, toggle);
    } else {
      card.append(label);
    }
    // 小箭头 = "点得开"（点卡看原文）；纯装饰，点击照旧冒到卡上
    const chev = document.createElement("span");
    chev.className = "pf-mod-chev";
    chev.setAttribute("aria-hidden", "true");
    chev.innerHTML = PF_CHEV;
    card.append(chev);
    return card;
  };

  const PLAIN_DEFS = {
    project: {
      id: "project",
      name: "负责项目",
      tip: "只管记忆，不限定他能改哪些目录：挂上项目 = ①每轮固定收到一行「你负责的项目：…」（100% 注入）；②这些项目的记忆进召回池，按你这轮的话打分。所有已登记的工作区 / 项目本来就都能读写（文件边界是登记根并集），挂不挂都一样；派出去的 worker 才按单子绑定的项目限定在单个项目里。总闸是部署配置 PARTNER_PROJECT_MEMORY，不在插件页（缺省开）。",
      summary: () =>
        (Array.isArray(partner.projectIds) && partner.projectIds.length
          ? counts.projectName || "挂着"
          : "没挂"),
    },
    chain: {
      id: "chain",
      name: "备选模型",
      tip: "主模型不可用时按序降级。",
      summary: () => `${Array.isArray(detail.modelChain) ? detail.modelChain.length : 0} 条`,
    },
    routines: {
      id: "routines",
      name: "定时任务",
      tip: "到点让 TA 自己跑一轮的活：内容、时间、暂停都能改。每晚「整理记忆」也在他名下，但它单独调度，不在这张任务列表里。",
      summary: () =>
        counts.routineCount == null
          ? "读取中…"
          : `${counts.routineCount} 条 · ${counts.memorySummary || "整理记忆…"}`,
    },
    skills: {
      id: "skills",
      name: "技能",
      tip: "三层：全局已开人人都有（个人页锁死）；全局未开可只给他开；他自带的只对他生效。",
      summary: () => {
        if (counts.skillCount == null) return "读取中…";
        if (counts.globalSkillTotal == null) return `自带 ${counts.skillCount} 本`;
        return `全局 ${counts.globalSkillEnabled ?? 0} · 独开 ${counts.globalSkillOverride ?? 0} · 自带 ${counts.skillCount}`;
      },
    },
  };

  const paint = () => {
    // 预设条（persona 读到了才画）
    presetBox.replaceChildren();
    if (persona && personaEnabled) {
      for (const preset of PF_PERSONA_PRESETS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pf-preset";
        button.dataset.pfPreset = preset.id;
        button.dataset.tip = preset.tip;
        button.setAttribute("aria-pressed", String(persona.preset === preset.id));
        button.textContent = preset.name;
        presetBox.append(button);
      }
    }

    // 统一卡片区（组标题只做扫读锚）：怎么说 → 岗位 → 心里长的 → 能力
    cardsBox.replaceChildren();
    const groupTitle = (text) => {
      const title = document.createElement("p");
      title.className = "pf-group-title";
      title.textContent = text;
      cardsBox.append(title);
    };

    groupTitle("怎么说");
    for (const id of ["expression", "values", "scenario"]) cardsBox.append(moduleCard(mod(id)));

    // 岗位组（2026-11-15 打磨）：纪律 / 履历 / 在办搬去下面的「注入的内容」，
    // 接派单退役（领域这套没用起来；机制与 env 总闸不动），结果整理 / 日记执事挪「高级开关」。
    // 岗位组：契约 / 目标（负责项目已移到下面「每轮固定注入」——它是 100% 注入的一行索引）
    groupTitle("岗位");
    for (const id of ["contract", "goal"]) cardsBox.append(moduleCard(mod(id)));

    groupTitle("心里长的");
    for (const id of ["impression", "mood", "heart", "learning", "proactivity"]) {
      cardsBox.append(moduleCard(mod(id)));
    }
    // 挂念（2026-11-15 打磨二轮）：从主动性卡里拆出来独立成卡——两个开关不许并排。
    // 它依赖主动性在跑（服务端 nudge 判 proactivity 模块 + 这个子开关），
    // 所以点它时若主动性关着就一起打开（一次 PUT 两件事，不做"点了没反应"）。
    cardsBox.append(
      plainSwitchCard({
        id: "nudge",
        name: "挂念",
        tip: "他会自己想起你提过的事：在你忙完一轮、或者周盘点时，挑一条今天相关的，用他的名字提醒你一句。一天最多一条，默认关。要先有「主动性」才跑得起来。",
        summary: () => (persona ? (persona.switches?.nudgeEnabled ? "开 · 一天最多一条" : "关") : ""),
        checked: () => persona?.switches?.nudgeEnabled === true,
      }),
    );
    cardsBox.append(moduleCard(mod("profiles")));

    groupTitle("能力");
    cardsBox.append(plainCard(PLAIN_DEFS.chain), plainCard(PLAIN_DEFS.routines), plainCard(PLAIN_DEFS.skills));

    // 每轮固定注入（100% 每句都带）：纪律 / 在办 / 履历（看原文）+ 负责项目（管挂载）。
    // 项目放这里讲清两件事：挂载 → 每轮带一行项目索引；项目记忆 → 进下面召回池打分。
    injectedBox.replaceChildren();
    for (const def of VIEW_DEFS) injectedBox.append(viewCard(def));
    if ("projectIds" in partner) injectedBox.append(plainCard(PLAIN_DEFS.project));

    // 按相关度召回（打分后才进）：记忆四类 + 挂载项目的记忆
    recallBox.replaceChildren();
    for (const def of RECALL_DEFS) recallBox.append(viewCard({ ...def, recall: true }));

    // 高级开关区（默认全开，只做"对他一个人"的例外）
    advancedBox.replaceChildren();
    advancedBox.append(rowCard(ROW_DEFS.projection), rowCard(ROW_DEFS.diary));
  };

  // persona 卡的编辑层路由（点卡进弹层；无编辑器的卡在别处处理）
  const openModuleCard = (module) => {
    if (module.id === "contract") {
      pfOpenContractEditor(partnerId, detail, () => {
        paint();
      });
      return;
    }
    if (module.id === "goal") {
      pfOpenGoalEditor(partnerId, detail.currentGoal ?? "", () => {
        paint();
      });
      return;
    }
    if (!persona) return;
    if (module.editable) {
      pfOpenPersonaEditor(partnerId, persona, module.editable, () => paint());
      return;
    }
    if (module.living) {
      pfOpenLivingEditor(partnerId, persona, module.living, () => {
        void pfReloadPersona(partnerId).then((next) => {
          if (next) {
            // 弹层只改活状态：保留页面里还没保存的开关草稿。
            applyServerPersona(next, true);
            paint();
            notify();
          }
        });
      });
      return;
    }
    if (module.learning) {
      pfOpenVoiceModal(persona);
      return;
    }
    if (module.profiles) {
      if (persona.modules?.profiles !== true) {
        toast("先打开「人设库」模块");
        return;
      }
      pfOpenProfilesModal(partnerId, persona, (applied) => {
        if (applied) {
          // 应用快照是服务端整份替换：草稿基线跟着换，页面不该显示成"一堆未保存"。
          baseline = JSON.parse(JSON.stringify(persona));
        }
        paint();
        notify();
      });
    }
  };

  /**
   * 接住服务端回读的 persona，作为新基准。
   * `keepDraft = true` 用于弹层里的即时保存（静态内容 / 活状态）：它们只改内容，
   * 不能把页面里还没保存的开关草稿冲掉——只把脏字段叠回新基准之上。
   */
  const applyServerPersona = (data, keepDraft = false) => {
    if (!data) return;
    const keep =
      keepDraft && persona && baseline
        ? {
            preset: persona.preset !== baseline.preset ? persona.preset : undefined,
            modules: Object.fromEntries(
              MODULE_IDS.filter((id) => moduleDirty(id)).map((id) => [id, persona.modules[id]]),
            ),
            switches: Object.fromEntries(
              SWITCH_IDS.filter((key) => switchDirty(key)).map((key) => [key, persona.switches?.[key]]),
            ),
          }
        : null;
    persona = { ...data };
    baseline = JSON.parse(JSON.stringify(data));
    if (keep) {
      if (keep.preset !== undefined) persona.preset = keep.preset;
      persona.modules = { ...(data.modules || {}), ...keep.modules };
      persona.switches = { ...(data.switches || {}), ...keep.switches };
    }
  };

  /** 页面级保存：一次把人设草稿与高级行开关落库；成功才算干净。 */
  const savePage = async () => {
    if (saving || !persona || !baseline) return false;
    const personaDirty =
      persona.preset !== baseline.preset ||
      MODULE_IDS.some((id) => moduleDirty(id)) ||
      SWITCH_IDS.some((key) => switchDirty(key));
    const projectionChanged = (partner.toolProjection ?? null) !== baselinePartner.toolProjection;
    const diaryChanged = (partner.diary === true) !== baselinePartner.diary;
    if (!personaDirty && !projectionChanged && !diaryChanged) return true;

    saving = true;
    setHint("保存中…");
    try {
      if (personaDirty) {
        const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/persona`, {
          method: "PUT",
          body: JSON.stringify({
            preset: persona.preset,
            modules: persona.modules,
            switches: persona.switches,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
          setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
          return false;
        }
        applyServerPersona(data);
      }
      if (projectionChanged || diaryChanged) {
        const patch = {};
        if (projectionChanged) patch.tool_projection = partner.toolProjection ?? null;
        if (diaryChanged) patch.diary = partner.diary === true;
        const data = await pfPatchPartner(partnerId, patch);
        if (data.partner) {
          partner.toolProjection = data.partner.toolProjection ?? null;
          partner.diary = data.partner.diary === true;
        }
        baselinePartner.toolProjection = partner.toolProjection ?? null;
        baselinePartner.diary = partner.diary === true;
        const cached = state.partners.find((item) => item.id === partnerId);
        if (cached) {
          cached.toolProjection = partner.toolProjection;
          cached.diary = partner.diary;
        }
        // 日记执事是唯一位：开了别人，别人的开关要跟着灭
        if (partner.diary === true) {
          for (const item of state.partners) {
            if (item.id !== partnerId && item.diary) item.diary = false;
          }
          void loadRoster();
        }
      }
      paint();
      setHint("已保存，下一轮起用。");
      return true;
    } catch (error) {
      if (error.message !== "forbidden") setHint(`没存成：${error.message}`, true);
      return false;
    } finally {
      saving = false;
      notify();
    }
  };

  /** 撤销草稿：开关 / 预设 / 高级行回到上次保存的状态；弹层里已保存的内容不动。 */
  const discardPage = () => {
    if (!persona || !baseline) return;
    persona.preset = baseline.preset;
    persona.modules = { ...baseline.modules };
    persona.switches = { ...baseline.switches };
    partner.toolProjection = baselinePartner.toolProjection;
    partner.diary = baselinePartner.diary;
    paint();
    notify();
  };

  presetBox.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pf-preset]");
    if (!button || !persona) return;
    const preset = button.dataset.pfPreset;
    if (preset === persona.preset) return;
    // 草稿模式（2026-11-16）：只改本地开关，点底部保存才落库。
    const table = PF_PERSONA_PRESET_MODULES[preset];
    persona.preset = preset;
    if (table) {
      for (const id of MODULE_IDS) persona.modules[id] = table[id] === true;
      // 履历 / 在办固定注入（服务端也强制 true），预设表里的 false 不生效。
      persona.modules.workHistory = true;
      persona.modules.currentWork = true;
    }
    paint();
    notify();
  });

  // 统一委托（2026-11-15 打磨：挂到整页容器上，三个区共用）：
  // 人格子开关（挂念 / 记忆）→ 模块开关（含注入区的纪律）→ 行开关（高级区）→ 注入内容卡 → 无开关卡 → 模块卡本体
  const page = section.closest(".pf") || section;
  page.addEventListener("click", async (event) => {
    // 独立开关卡：点卡体（不是开关本身）= 切那个开关，全卡都是热区
    const cardSwitch = event.target.closest("[data-pf-switch-card]");
    if (cardSwitch && !event.target.closest("[data-pf-switch]")) {
      cardSwitch.querySelector("[data-pf-switch]")?.click();
      return;
    }
    const switchEl = event.target.closest("[data-pf-switch]");
    if (switchEl) {
      if (!persona) return;
      const key = switchEl.dataset.pfSwitch;
      const next = switchEl.getAttribute("aria-checked") !== "true";
      // 草稿模式：挂念依赖主动性在跑（服务端 nudge 判 proactivity 模块 + 这个子开关），
      // 点挂念时若主动性关着就一起打开——同一次草稿，保存时一起落。
      if (key === "nudgeEnabled" && next && persona.modules?.proactivity !== true) {
        persona.modules.proactivity = true;
        persona.preset = pfDerivePreset(persona.modules);
      }
      persona.switches = { ...(persona.switches || {}), [key]: next };
      paint();
      notify();
      return;
    }
    const toggle = event.target.closest("[data-pf-mod]");
    if (toggle) {
      if (!persona) return;
      const next = toggle.getAttribute("aria-checked") !== "true";
      const id = toggle.dataset.pfMod;
      persona.modules[id] = next;
      // 改任一开关都按最终表推导预设（与服务端保存时同一口径），页面上的高亮不会说谎。
      persona.preset = pfDerivePreset(persona.modules);
      paint();
      notify();
      return;
    }
    const rowEl = event.target.closest("[data-pf-row]");
    if (rowEl) {
      if (rowEl.dataset.pfLocked === "1") {
        setHint(`「${flagNameOf(projectionLock)}」关闭时，结果整理显示关且不能单独打开；原设置保留。`, true);
        return;
      }
      const def = ROW_DEFS[rowEl.dataset.pfRow];
      if (!def) return;
      // 草稿模式（2026-11-16）：先只改本地值，点底部保存才 PATCH。
      if (def.id === "projection") {
        // 两态：开（跟随全局默认）↔ 关（只他一个回原始结果）；行上仍是三态值：关 = 0，开回 null。
        partner.toolProjection = partner.toolProjection === 0 ? null : 0;
      } else if (def.id === "diary") {
        partner.diary = partner.diary !== true;
      }
      paint();
      notify();
      return;
    }
    const plainEl = event.target.closest("[data-pf-plain]");
    if (plainEl) {
      const id = plainEl.dataset.pfPlain;
      if (id === "project") {
        void pfOpenProjectEditor(partnerId, partner, () => paint());
      } else if (id === "chain") {
        pfOpenChainModal(partnerId, detail, () => paint());
      } else if (id === "routines") {
        void pfOpenRoutinesModal(partnerId, (next) => {
          Object.assign(counts, next);
          paint();
        });
      } else if (id === "skills") {
        void pfOpenSkillsModal(partnerId, (next) => {
          Object.assign(counts, next);
          paint();
        });
      }
      return;
    }
    const viewEl = event.target.closest("[data-pf-view]");
    if (viewEl) {
      pfOpenInjectionViewer(partnerId, viewEl.dataset.pfView, () => paint());
      return;
    }
    const cardEl = event.target.closest("[data-pf-card]");
    if (!cardEl) return;
    const module = mod(cardEl.dataset.pfCard);
    if (!module) return;
    // 学习模块：记忆总闸关着时先别开编辑层，显示关且不能动。
    if (module.id === "learning" && memoryLock) {
      setHint(`「${flagNameOf(memoryLock)}」关闭时，「学习」显示关且不能打开；原设置保留。`, true);
      return;
    }
    // 关 = 不能改（内容保留）：点了弹一枚小窗问要不要打开，不再只在页脚留一行字
    if (persona && persona.modules?.[module.id] !== true) {
      void openConfirm({
        title: `「${module.name}」还关着`,
        message: "打开之后才能改内容；关着改了也不进提示词。",
        confirmText: "打开并编辑",
        cancelText: "先不",
      }).then((ok) => {
        if (!ok) return;
        // 草稿模式：先只把开关打开（底部保存才落库），再进编辑层；
        // 编辑层保存内容时会保留这个未保存的开关（applyServerPersona 的 keepDraft）。
        persona.modules[module.id] = true;
        persona.preset = pfDerivePreset(persona.modules);
        paint();
        notify();
        openModuleCard(module);
      });
      return;
    }
    openModuleCard(module);
  });

  // 先画一遍岗位动作卡与能力卡（不等 persona）+ 拉异步计数
  paint();
  void pfPrefetchCardSummaries(partnerId, partner, (next) => {
    Object.assign(counts, next);
    paint();
  });

  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/persona`, {
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(String(response.status));
    // 晚到的响应不盖掉用户已经切走的页
    if (pfRouteId() !== partnerId) return;
    applyServerPersona(data);
    personaEnabled = data.enabled === true;
    if (!personaEnabled) {
      // 总开关关着（PARTNER_PERSONA_MODULES=false）：老行为"谁也不裁"——
      // 模块卡不带开关、恒可编辑；预设条不出现。
      persona = null;
      setHint("人格模块总开关关着（高级开关 PARTNER_PERSONA_MODULES=false）：内容照旧注入，卡片只管编辑。");
    }
    paint();
    notify();
  } catch (error) {
    if (error.message !== "forbidden" && pfRouteId() === partnerId) {
      setHint(`人格模块读不到：${error.message}（岗位与能力照常可用）`, true);
    }
  }
  return {
    isDirty: () => dirtyCount() > 0,
    dirtyCount,
    save: savePage,
    discard: discardPage,
  };
}

/* ── ① 能用的工具（2026-11-16 工具裁剪 B）─────────────────────
 * 按人勾选模型可见工具：存"取消名单"、默认全开，取消后下一轮起生效。
 * 数据与弹层都现拉 GET /partners/:id/tools（不拿页面加载时的旧数据）：
 * 页面加载拉一次更新卡片计数，点卡再拉一次打开弹层。 */

const PF_TOOLS_PATH = (partnerId) => `/api/v1/partners/${encodeURIComponent(partnerId)}/tools`;

async function pfFetchTools(partnerId) {
  const response = await request(PF_TOOLS_PATH(partnerId), { cache: "no-store" });
  if (!response.ok) throw new Error(String(response.status));
  const data = await response.json().catch(() => ({}));
  if (data.ok === false) throw new Error(data.error || String(response.status));
  return data;
}

async function pfOpenToolsModal(root, partnerId, onSaved) {
  const partnerName = root.querySelector("#pf-title")?.textContent?.trim() || "这个人";
  openModal("工具 · " + partnerName, async (body) => {
    body.innerHTML = `
      <div class="pf-tool-groups" id="pf-tools-groups"><p class="modal-hint">读取中…</p></div>
      <p class="pf-hint" id="pf-tools-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>关闭</button>
        <button class="ghost" type="button" id="pf-tools-all">全选</button>
        <button class="ghost" type="button" id="pf-tools-none">全不选</button>
        <button class="btn-primary" type="button" id="pf-tools-save" disabled>保存</button>
      </div>`;
    const groupsBox = body.querySelector("#pf-tools-groups");
    const hint = body.querySelector("#pf-tools-hint");
    const save = body.querySelector("#pf-tools-save");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());

    let initialDisabled = [];
    let initialPromoted = [];
    let view = null;
    // 常驻提升（2026-11-17）：按需工具可以被人点成常驻（下一轮起就在工具面里，不用再搜）。
    const promotedSet = new Set();
    // 保存按钮只在"勾选态 / 常驻态相对打开时变了"才亮；全选 / 全不选也走这条。
    const markDirty = () => {
      const disabled = [...groupsBox.querySelectorAll("input[data-tool]:not(:checked)")]
        .map((input) => input.dataset.tool);
      const promoted = [...promotedSet];
      const disabledChanged =
        disabled.length !== initialDisabled.length ||
        disabled.some((name) => !initialDisabled.includes(name));
      const promotedChanged =
        promoted.length !== initialPromoted.length ||
        promoted.some((name) => !initialPromoted.includes(name));
      save.disabled = !disabledChanged && !promotedChanged;
    };

    // 弹层打开时现拉一次：页面加载后可能有别的设备改过，别用旧数据。
    // 用量账并行拉（2026-11-17）：给"该不该提升"一个看得见的判据；读不到就不显示，不挡保存。
    let usageByName = new Map();
    const usagePromise = request("/api/v1/agent/tool-usage", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        for (const row of Array.isArray(data?.tools) ? data.tools : []) {
          if (row && typeof row.name === "string") usageByName.set(row.name, row);
        }
      })
      .catch(() => undefined);
    try {
      view = await pfFetchTools(partnerId);
    } catch (error) {
      if (error.message !== "forbidden") setModalHint(hint, `读不到工具目录：${error.message}`, true);
      save.disabled = true;
      return;
    }
    if (view.enabled === false) {
      groupsBox.innerHTML = `<p class="modal-hint">工具选择未启用（PARTNER_TOOLS_ENABLED=false）。</p>`;
      save.disabled = true;
      return;
    }

    initialDisabled = Array.isArray(view.disabled) ? [...view.disabled] : [];
    initialPromoted = Array.isArray(view.promoted) ? [...view.promoted] : [];
    for (const name of initialPromoted) promotedSet.add(name);
    const byGroup = new Map();
    for (const tool of Array.isArray(view.tools) ? view.tools : []) {
      if (!tool || typeof tool.name !== "string") continue;
      const group = typeof tool.group === "string" ? tool.group : "其他";
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(tool);
    }
    const order = Array.isArray(view.groups) && view.groups.length ? view.groups : [...byGroup.keys()];
    const html = [];
    // 用量文案：用过 N 次；被搜出来过再补一句（帮人判断"藏错了"还是"该关掉"）。
    const usageText = (name) => {
      const row = usageByName.get(name);
      if (!row || typeof row.count !== "number") return "";
      const bits = [`用过 ${row.count} 次`];
      if (row.loads > 0) bits.push(`搜出 ${row.loads} 次`);
      return bits.join(" · ");
    };
    for (const group of order) {
      const items = byGroup.get(group);
      if (!items || !items.length) continue;
      html.push(`<div class="pf-tool-group"><div class="pf-tool-group-title">${esc(group)}</div>`);
      for (const tool of items) {
        const deferred = tool.deferred === true;
        const usage = deferred ? usageText(tool.name) : "";
        html.push(`<label class="pf-tool-row">
          <input type="checkbox" data-tool="${attr(tool.name)}"${tool.enabled === true ? " checked" : ""} />
          <span class="pf-tool-name">${esc(tool.name)}</span>
          <span class="pf-tool-sum">${esc(String(tool.summary || ""))}</span>
          ${usage ? `<span class="pf-tool-use">${esc(usage)}</span>` : ""}
          ${deferred ? `<span class="pf-tool-mode" role="button" tabindex="0" data-mode-for="${attr(tool.name)}" data-on="${promotedSet.has(tool.name) ? "1" : "0"}" data-tip="按需 = 初始不进请求，模型要用得先 tool_search；常驻 = 每轮都带完整定义（多花前缀 token）">${promotedSet.has(tool.name) ? "常驻" : "按需"}</span>` : ""}
        </label>`);
      }
      html.push(`</div>`);
    }
    groupsBox.innerHTML = html.join("") || `<p class="modal-hint">没有可用的模型工具。</p>`;
    // 用量账晚到也不影响：回来后才把数字补进已渲染的行（不重画，避免打断已做的勾选）。
    void usagePromise.then(() => {
      for (const chip of groupsBox.querySelectorAll(".pf-tool-mode")) {
        const name = chip.dataset.modeFor;
        const text = usageText(name);
        if (!text) continue;
        const row = chip.closest(".pf-tool-row");
        if (!row || row.querySelector(".pf-tool-use")) continue;
        const use = document.createElement("span");
        use.className = "pf-tool-use";
        use.textContent = text;
        row.insertBefore(use, chip);
      }
    });
    groupsBox.addEventListener("change", markDirty);
    // 点「按需 / 常驻」胶囊：切这个人的提升状态（不碰勾选；下一轮生效）。
    const togglePromoted = (chip) => {
      if (!chip || !chip.dataset.modeFor) return;
      const name = chip.dataset.modeFor;
      const next = !promotedSet.has(name);
      if (next) promotedSet.add(name);
      else promotedSet.delete(name);
      chip.dataset.on = next ? "1" : "0";
      chip.textContent = next ? "常驻" : "按需";
      markDirty();
    };
    groupsBox.addEventListener("click", (event) => {
      const chip = event.target instanceof Element ? event.target.closest(".pf-tool-mode") : null;
      if (!chip || !groupsBox.contains(chip)) return;
      // 行是 label：不拦一下会把点击变成"勾/取消勾"。
      event.preventDefault();
      event.stopPropagation();
      togglePromoted(chip);
    });
    groupsBox.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const chip = event.target instanceof Element ? event.target.closest(".pf-tool-mode") : null;
      if (!chip || !groupsBox.contains(chip)) return;
      event.preventDefault();
      togglePromoted(chip);
    });

    body.querySelector("#pf-tools-all")?.addEventListener("click", () => {
      for (const input of groupsBox.querySelectorAll("input[data-tool]")) input.checked = true;
      markDirty();
    });
    body.querySelector("#pf-tools-none")?.addEventListener("click", () => {
      for (const input of groupsBox.querySelectorAll("input[data-tool]")) input.checked = false;
      markDirty();
    });

    save.addEventListener("click", async () => {
      if (save.disabled) return;
      save.disabled = true;
      setModalHint(hint, "保存中…", false);
      try {
        // 收集**未勾选**的名字 = 取消名单；空数组 = 全开（恢复默认）。
        const disabled = [...groupsBox.querySelectorAll("input[data-tool]:not(:checked)")]
          .map((input) => input.dataset.tool);
        const response = await request(PF_TOOLS_PATH(partnerId), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // promoted 一起提交（2026-11-17）：服务端按"带了就全量替换"处理。
          body: JSON.stringify({ disabled, promoted: [...promotedSet] }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.message || String(response.status));
        toast("已保存，下一轮生效");
        closeModal();
        if (typeof onSaved === "function") onSaved(data);
      } catch (error) {
        if (error.message !== "forbidden") setModalHint(hint, `没存成：${error.message}`, true);
        save.disabled = false;
      }
    });
  }, { className: "modal-wide" });
}

async function pfWireTools(root, partnerId) {
  const section = root.querySelector("#pf-tools");
  const cards = root.querySelector("#pf-tools-cards");
  if (!section || !cards) return;

  const card = document.createElement("div");
  card.className = "pf-mod-card is-clickable";
  card.dataset.pfToolsCard = "1";
  card.innerHTML = `<div class="pf-mod-label">
    <span class="pf-mod-name" data-tip="勾上 = 他看得到、调得动；取消 = 下一轮起看不到；默认全开">工具</span>
    <span class="pf-mod-sum" id="pf-tools-sum">读取中…</span>
  </div>`;
  const chev = document.createElement("span");
  chev.className = "pf-mod-chev";
  chev.setAttribute("aria-hidden", "true");
  chev.innerHTML = PF_CHEV;
  card.append(chev);
  cards.replaceChildren(card);

  const sum = card.querySelector("#pf-tools-sum");
  const paint = (view, errorText) => {
    if (errorText) {
      sum.classList.add("is-error");
      sum.textContent = errorText;
      return;
    }
    sum.classList.remove("is-error");
    const tools = Array.isArray(view.tools) ? view.tools : [];
    const on = tools.filter((tool) => tool.enabled === true).length;
    sum.textContent = `已开 ${on} / ${tools.length}`;
  };

  try {
    const view = await pfFetchTools(partnerId);
    if (pfRouteId() !== partnerId) return;
    if (view.enabled === false) {
      section.hidden = true; // 总开关关着：整段隐藏（data-tip 也不用解释）
      return;
    }
    section.hidden = false;
    paint(view);
  } catch (error) {
    if (error.message === "forbidden" || pfRouteId() !== partnerId) return;
    // 失败给一句原因 + 可重试：点击卡片会再拉一次 GET 开弹层。
    paint(null, `读不到工具目录：${error.message}（点击重试）`);
  }

  card.addEventListener("click", () => {
    void pfOpenToolsModal(root, partnerId, (view) => {
      if (pfRouteId() === partnerId) paint(view);
    });
  });
}

/* ── 页面装配 ─────────────────────────────────────────────── */

/**
 * 离开页面时的三选一（2026-11-16 用户口径：「还没保存，是否保存并退出？」）。
 *
 * - 取消 / 点遮罩 / Esc：用 replaceState 把地址改回详情页——**不触发 hashchange**，
 *   所以页面不重渲染，草稿原样保留；
 * - 不保存退出：丢掉草稿后放行；
 * - 保存并退出：保存成功才放行；失败留在弹层里，给一句原因。
 */
function pfPromptLeave({ partnerId, dirtyCount, save, discard }) {
  if (pfLeavePromptOpen) return;
  pfLeavePromptOpen = true;
  const ownHash = pfHash(partnerId);
  let decided = false;
  openModal(
    "还没保存",
    (body) => {
      body.innerHTML = `
        <p class="modal-desc">这个页面还有 ${dirtyCount} 处改动没保存。是否保存并退出？</p>
        <p class="modal-hint" id="pf-leave-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-leave-cancel>取消</button>
          <button class="ghost" type="button" data-leave-discard>不保存退出</button>
          <button class="modal-primary" type="button" data-leave-save>保存并退出</button>
        </div>`;
      const hint = body.querySelector("#pf-leave-hint");
      const cancel = body.querySelector("[data-leave-cancel]");
      const discardBtn = body.querySelector("[data-leave-discard]");
      const saveBtn = body.querySelector("[data-leave-save]");
      cancel?.addEventListener("click", () => {
        decided = true;
        closeModal();
        state.selfNavHash = "";
        if (location.hash !== ownHash) history.replaceState(null, "", ownHash);
      });
      discardBtn?.addEventListener("click", () => {
        decided = true;
        discard();
        closeModal();
        applyRoute();
      });
      saveBtn?.addEventListener("click", async () => {
        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        discardBtn.disabled = true;
        cancel.disabled = true;
        if (hint) {
          hint.textContent = "保存中…";
          hint.classList.remove("is-error");
        }
        const ok = await save();
        if (!ok) {
          if (hint) {
            hint.textContent = "没存成，先别退出；改一下再试。";
            hint.classList.add("is-error");
          }
          saveBtn.disabled = false;
          discardBtn.disabled = false;
          cancel.disabled = false;
          return;
        }
        decided = true;
        closeModal();
        applyRoute();
      });
    },
    {
      onClose: () => {
        pfLeavePromptOpen = false;
        // 点遮罩 / Esc 关掉 = 取消：还留在详情页，地址要改回来。
        if (!decided && location.hash !== ownHash) {
          state.selfNavHash = "";
          history.replaceState(null, "", ownHash);
        }
      },
    },
  );
}

async function renderPartnerProfilePage(partnerId) {
  const root = el.settingsInner;
  if (!root) return;
  root.classList.add("is-partner-profile");
  root.innerHTML = `<div class="pf"><p class="set-hint">读取中…</p></div>`;

  let detail;
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, { cache: "no-store" });
    detail = await response.json().catch(() => ({}));
    if (!response.ok || !detail.ok) throw new Error(String(response.status));
  } catch (error) {
    if (error.message === "forbidden") return;
    if (pfRouteId() !== partnerId) return;
    root.innerHTML = `<div class="pf"><button class="pf-back" type="button" id="pf-back">${PF_BACK}<span>总管与执事</span></button>
      <p class="set-hint is-error">读不到这个人：${esc(error.message)}</p></div>`;
    root.querySelector("#pf-back")?.addEventListener("click", () => pfOpenTo());
    return;
  }
  // 晚到的响应不盖掉用户已经切走的页
  if (pfRouteId() !== partnerId) return;

  const partner = detail.partner || {};
  root.innerHTML = pfMarkup(partnerId, partner, detail);

  root.querySelector("#pf-back")?.addEventListener("click", () => {
    location.hash = "#/settings/partners";
  });
  // 试跑按钮退役（2026-11-15 人设页打磨）：列表页 ⋯ 菜单还有入口；顶栏只留暂停/恢复小图标钮。
  root.querySelector("#pf-pause")?.addEventListener("click", () => {
    // 暂停会整页重渲染（状态变了要重画），草稿会被冲掉：有未保存改动就先拦一下。
    if (activeProfileGuard?.isDirty()) {
      toast("先保存或撤销改动，再暂停/恢复");
      return;
    }
    const next = partner.status === "active" ? "paused" : "active";
    const button = root.querySelector("#pf-pause");
    void ptTogglePartner(partnerId, next, button).then(() => {
      if (pfRouteId() === partnerId) void renderPartnerProfilePage(partnerId);
    });
  });

  // 页面级草稿（2026-11-16）：人格模块 / 高级开关只改本地，点底部保存才落库。
  let identityCtl = null;
  let personaCtl = null;
  let savingAll = false;
  const bar = root.querySelector("#pf-savebar");
  const barState = root.querySelector("#pf-savebar-state");
  const barSave = root.querySelector("#pf-savebar-save");
  const barReset = root.querySelector("#pf-savebar-reset");
  const pageDirty = () => (identityCtl?.dirtyCount() ?? 0) + (personaCtl?.dirtyCount() ?? 0);
  const anyDirty = () => pageDirty() > 0;
  const refreshBar = () => {
    if (!bar) return;
    const count = pageDirty();
    bar.hidden = count === 0;
    if (barSave) barSave.disabled = savingAll || count === 0;
    if (barReset) barReset.disabled = savingAll || count === 0;
    barState?.classList.toggle("is-dirty", count > 0);
    const label = barState?.querySelector("span");
    if (label) label.textContent = count ? `${count} 处改动未保存` : "没有改动";
  };
  const saveDraft = async () => {
    if (savingAll) return false;
    savingAll = true;
    refreshBar();
    let ok = true;
    if (identityCtl?.isDirty()) ok = await identityCtl.save();
    if (ok && personaCtl?.isDirty()) ok = await personaCtl.save();
    savingAll = false;
    refreshBar();
    return ok;
  };
  const discardDraft = () => {
    identityCtl?.reset();
    personaCtl?.discard();
    refreshBar();
  };
  barSave?.addEventListener("click", () => {
    void saveDraft();
  });
  barReset?.addEventListener("click", discardDraft);

  identityCtl = pfWireIdentity(root, partnerId, partner, detail, refreshBar);
  // 岗位与能力已并入人格模块卡片区（2026-11-15 二次重构）：契约/目标/项目/三开关/备选链/
  // 例行/技能全部由 pfWirePersona 统一画卡、弹层编辑。
  void pfWirePersona(root, partnerId, partner, detail, refreshBar).then((ctl) => {
    personaCtl = ctl || null;
    refreshBar();
  });
  // 人设页工具勾选（2026-11-16 工具裁剪 B）：总管（partnerId === "chief"）同样显示，不特殊隐藏。
  void pfWireTools(root, partnerId);

  /* 离开守卫（2026-11-16）：路由切换先经过 route.js；有草稿就弹三选一。
     放行一次即卸任（route.js 负责），同页重渲染会由本次 render 重新注册。 */
  activeProfileGuard = { isDirty: anyDirty };
  setRouteGuard(() => {
    const ownHash = pfHash(partnerId);
    if (!anyDirty()) {
      activeProfileGuard = null;
      return true;
    }
    // 同页重渲染（地址已经是这一页）：不弹"离开"提示，但也别重渲染把草稿冲掉。
    if (location.hash === ownHash) return false;
    void pfPromptLeave({
      partnerId,
      dirtyCount: pageDirty(),
      save: saveDraft,
      discard: discardDraft,
    });
    return false;
  });
}

/** 面包屑回列表（离开详情页时把窄栏标记摘掉由下一页自己管） */
function pfOpenTo() {
  location.hash = "#/settings/partners";
}

export { PF_PERSONA_EDITORS, pfHash, pfMarkup, pfOpen, pfPersonaFieldMarkup, pfPersonaValue, pfRouteId, renderPartnerProfilePage };
