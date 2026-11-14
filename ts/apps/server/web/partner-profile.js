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
 *   岗位：PUT /partners/:id/contract（版本化）+ PATCH currentGoal / dispatchAuthority / diary
 *   能力：mountChainEditor（备选链）+ routines 列表/新建 + skills 只读
 *
 * 刻意不做：不在这一页做删除执事（列表页才有）、不把记忆的增删搬来（设置 → 记忆是唯一真相）、
 * 不再显示这个人的履历 / 记忆（统一去设置 → 记忆看）。
 */

import { paintAvatar } from "./avatar.js";
import { el } from "./dom.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { openAvatarPanel } from "./partner-editor.js";
import { PT_STATUS, ptTogglePartner } from "./partner-modals.js";
import { openRunPartnerModal, ptRenderRoutineList, ptRoutineFormMarkup, ptWireRoutineForm } from "./partner-routines.js";
import { loadRoster, syncChiefAvatar } from "./partners-status.js";
import { CS_CONTRACT_TEMPLATE } from "./settings-contract.js";
import { csLoadProfileSkills, csProfileWhen } from "./settings-employee.js";
import { mountChainEditor } from "./settings-model.js";
import { state } from "./state.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

/* 领域标签的服务端口径（companion-api.ts PATCH）：小写 ASCII + 连字符。
   前端先拦一道，不然用户按旧 placeholder 填「写作」会拿到一句 400。 */
const PF_DOMAIN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PF_NAME_LIMIT = 40;

/* ── 人格模块（2026-11-14 员工人格模块 · 批1）────────────────────────────
 *
 * 一个员工 = 必选核心（身份 / 数据红线 / 教诲通道，不可关）+ 可开关模块。
 * 这里只上架**批1 生效**的八个模块；批2（印象 / 心情 / 日记）与批3（学习 / 主动性 / 人设库）
 * 的行不显示——一行写着"即将生效"又点不动，比不显示更吵（用户口径：以简洁为准）。
 * 解释文字不常驻：模块名挂 data-tip，悬停才出（与设置页其它标签同一口径）。
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
];

const PF_PERSONA_PRESETS = [
  { id: "work", name: "岗位", tip: "只留岗位相关：契约 / 纪律 / 目标 / 履历 / 在办。口吻、里子、处境全关——干活的人不需要这些。" },
  { id: "companion", name: "陪伴", tip: "口吻、里子、处境、目标开；岗位类关（主人数据红线照旧在）。" },
  { id: "custom", name: "自定义", tip: "自己配。八个开关随便摆，服务端只强制数据红线。" },
];

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

/* ── 页面骨架 ─────────────────────────────────────────────── */

function pfMarkup(partnerId, partner, detail) {
  const name = String(partner.name || "").trim() || partnerId;
  const domain = String(partner.domain || "");
  const soul = String(detail.soul ?? "");
  const version = detail.soulVersion ?? null;
  const status = PT_STATUS[partner.status] || { text: partner.status || "未知", cls: "" };
  const contractOn = "contract" in detail;
  const contract = String(detail.contract ?? "");
  const contractVersion = detail.contractVersion ?? null;
  const goal = detail.currentGoal != null ? String(detail.currentGoal) : "";
  const hasDispatch = typeof partner.dispatchAuthority === "boolean";
  const diary = partner.diary === true;
  const isChief = partnerId === "chief";
  const chain = Array.isArray(detail.modelChain) ? detail.modelChain : [];

  return `
  <div class="pf" data-pf-id="${attr(partnerId)}">
    <button class="pf-back" type="button" id="pf-back">${PF_BACK}<span>人设与执事</span></button>

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
          <span class="pf-sep">·</span>
          <span id="pf-ver">${version == null ? "人设 —" : `人设 v${esc(String(version))}`}</span>
          ${domain ? `<span class="pf-sep">·</span><span class="pf-domain-tag">${esc(domain)}</span>` : ""}
        </div>
      </div>
      <div class="pf-hero-actions">
        <button class="ghost" type="button" id="pf-run">试跑</button>
        ${isChief ? "" : `<button class="ghost" type="button" id="pf-pause">${partner.status === "active" ? "暂停" : "恢复"}</button>`}
      </div>
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
          <label class="pf-field">
            <span>领域 <em class="pf-tag">只用于派单</em></span>
            <input class="set-input is-mono" id="pf-domain" type="text" value="${attr(domain)}"
                   placeholder="如 frontend" spellcheck="false" />
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

    <!-- ①·五 人格模块（2026-11-14 批1）：预设 + 开关 + 静态模块编辑入口。
         整块默认 hidden，读到 persona 端点且 enabled=true 才显示；开关关着时端到端隐藏（方案 §八）。 -->
    <section class="pf-sec" id="pf-persona" hidden>
      <div class="pf-sec-head">
        <h2 class="pf-sec-title">人格模块</h2>
        <span class="pf-sec-note">关 = 不进提示词，内容保留</span>
      </div>
      <div class="card pf-panel">
        <div class="pf-presets" id="pf-persona-presets" role="group" aria-label="人格预设"></div>
        <div class="pf-persona-list" id="pf-persona-list"></div>
        <p class="pf-hint" id="pf-persona-hint"></p>
      </div>
    </section>

    <!-- ② 岗位：契约（折叠）/ 目标 / 两枚开关 -->
    <section class="pf-sec">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title">岗位</h2>
        <span class="pf-sec-note">下一轮起用</span>
      </div>
      <div class="card pf-panel">
        ${
          contractOn
            ? `<details class="pf-fold">
                 <summary>
                   <span class="pf-fold-title">岗位契约</span>
                   <em class="pf-tag">每轮进提示词</em>
                   <span class="pf-kv" id="pf-contract-ver">${contractVersion == null ? "—" : `v${esc(String(contractVersion))}`}</span>
                   <span class="pf-fold-chev" aria-hidden="true">${PF_CHEV}</span>
                 </summary>
                 <div class="pf-fold-body">
                   <div class="pf-fold-tools">
                     <button class="pf-mini" type="button" id="pf-contract-tpl">套用模板</button>
                   </div>
                   <textarea class="pf-contract" id="pf-contract" rows="9" spellcheck="false" aria-label="岗位契约"
                     placeholder="写清管什么、怎么定、怎么验收、向谁汇报">${esc(contract)}</textarea>
                   <div class="pf-foot is-tight" id="pf-contract-foot" hidden>
                     <div class="pf-state" id="pf-contract-state"><i aria-hidden="true"></i><span>没有改动</span></div>
                     <button class="ghost" type="button" id="pf-contract-reset" disabled>撤销</button>
                     <button class="btn-primary" type="button" id="pf-contract-save" disabled>保存</button>
                   </div>
                   <p class="pf-hint" id="pf-contract-hint"></p>
                 </div>
               </details>`
            : `<div class="pf-block">
                 <div class="pf-block-head">
                   <span class="pf-block-title">岗位契约</span>
                   <span class="pf-kv">未启用</span>
                 </div>
               </div>`
        }

        <div class="pf-div"></div>

        <div class="pf-block">
          <div class="pf-block-head">
            <span class="pf-block-title">当前目标 <em class="pf-tag">每轮进提示词</em></span>
          </div>
          <div class="pf-inline">
            <input class="set-input" id="pf-goal" type="text" maxlength="1000" value="${attr(goal)}"
                   placeholder="本季度要奔的事，留空 = 清除" />
            <button class="ghost" type="button" id="pf-goal-save">保存</button>
          </div>
          <p class="pf-hint" id="pf-goal-hint"></p>
        </div>

        <div class="pf-div"></div>

        <div class="pf-block">
          ${
            hasDispatch
              ? `<div class="pf-row">
                   <div class="pf-row-label">接派单</div>
                   <button class="switch" type="button" role="switch" id="pf-dispatch"
                           aria-checked="${partner.dispatchAuthority ? "true" : "false"}" aria-label="接派单">
                     <span class="switch-thumb" aria-hidden="true"></span>
                   </button>
                 </div>`
              : ""
          }
          <div class="pf-row">
            <div class="pf-row-label">日记执事</div>
            <button class="switch" type="button" role="switch" id="pf-diary"
                    aria-checked="${diary ? "true" : "false"}" aria-label="日记执事">
              <span class="switch-thumb" aria-hidden="true"></span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- ③ 能力：备选链 / 例行任务 / 技能，全折叠，摘要带条数 -->
    <section class="pf-sec">
      <div class="pf-sec-head">
        <h2 class="pf-sec-title">能力</h2>
      </div>
      <div class="card pf-panel">
        <details class="pf-fold">
          <summary>
            <span class="pf-fold-title">备选模型</span>
            <span class="pf-kv" id="pf-chain-count">${chain.length} 条</span>
            <span class="pf-fold-chev" aria-hidden="true">${PF_CHEV}</span>
          </summary>
          <div class="pf-fold-body"><div id="pf-chain"></div></div>
        </details>

        <details class="pf-fold">
          <summary>
            <span class="pf-fold-title">例行任务</span>
            <span class="pf-kv" id="pf-routine-count">0 条</span>
            <span class="pf-fold-chev" aria-hidden="true">${PF_CHEV}</span>
          </summary>
          <div class="pf-fold-body">
            <div class="pt-routine-list" id="pf-routines"><p class="pf-hint">读取中…</p></div>
            <details class="pf-new">
              <summary>新建例行任务</summary>
              ${ptRoutineFormMarkup()}
            </details>
          </div>
        </details>

        <details class="pf-fold">
          <summary>
            <span class="pf-fold-title">技能</span>
            <span class="pf-kv" id="pf-skill-count">读取中…</span>
            <span class="pf-fold-chev" aria-hidden="true">${PF_CHEV}</span>
          </summary>
          <div class="pf-fold-body"><div class="pf-skills" id="pf-skills"></div></div>
        </details>
      </div>
    </section>
  </div>`;
}

/* ── ① 人设：一次保存 ──────────────────────────────────────── */

function pfWireIdentity(root, partnerId, partner, detail) {
  const nameInput = root.querySelector("#pf-name");
  const domainInput = root.querySelector("#pf-domain");
  const soulArea = root.querySelector("#pf-soul");
  const save = root.querySelector("#pf-save");
  const reset = root.querySelector("#pf-reset");
  const foot = root.querySelector("#pf-identity-foot");
  const stateNode = root.querySelector("#pf-state");
  const hint = root.querySelector("#pf-hint");
  const note = root.querySelector("#pf-soul-note");
  const title = root.querySelector("#pf-title");
  const verNode = root.querySelector("#pf-ver");
  const avatarBtn = root.querySelector("#pf-avatar");
  if (!nameInput || !soulArea || !avatarBtn) return;

  const base = {
    name: String(partner.name || "").trim(),
    domain: String(partner.domain || ""),
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

  // 领域只在服务端收小写 ASCII（正则前后端同一套）：输入时先拦，
  // 免得写完一整页、点了保存才被打回（placeholder 里那句「例如 frontend」就是这个意思）。
  const domainProblem = () => {
    const value = domainInput.value.trim();
    if (!value || PF_DOMAIN_RE.test(value)) return "";
    return "领域只能用小写字母、数字和连字符（例如 frontend）；中文会存不进去。";
  };
  let domainHint = false;

  const refresh = () => {
    const dirty = dirtyCount();
    const bad = domainProblem();
    save.disabled = saving || decoding || dirty === 0 || Boolean(bad);
    reset.disabled = saving || decoding || dirty === 0;
    stateNode.classList.toggle("is-dirty", dirty > 0);
    stateNode.querySelector("span").textContent = dirty ? `${dirty} 处改动未保存` : "没有改动";
    if (foot) foot.hidden = dirty === 0;
    note.textContent = `${soulArea.value.length} 字`;
    avatarBtn.disabled = saving;
    domainInput.classList.toggle("is-invalid", Boolean(bad));
    if (bad) {
      setHint(bad, true);
      domainHint = true;
    } else if (domainHint) {
      setHint("");
      domainHint = false;
    }
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
  domainInput.addEventListener("input", () => {
    draft.domain = domainInput.value;
    setHint("");
    refresh();
  });
  soulArea.addEventListener("input", () => {
    draft.soul = soulArea.value;
    setHint("");
    refresh();
  });

  reset.addEventListener("click", () => {
    Object.assign(draft, base);
    nameInput.value = base.name;
    domainInput.value = base.domain;
    soulArea.value = base.soul;
    paintAvatarNow();
    setHint("");
    refresh();
  });

  save.addEventListener("click", async () => {
    if (saving || decoding) return;
    const name = draft.name.trim();
    if (!name) {
      setHint("名字不能空。", true);
      nameInput.focus();
      return;
    }
    if (!draft.soul.trim()) {
      setHint("人设不能是空的。", true);
      soulArea.focus();
      return;
    }
    const domain = draft.domain.trim();
    if (domain && !PF_DOMAIN_RE.test(domain)) {
      setHint("领域只能用小写字母、数字和连字符（例如 frontend）；中文会存不进去。", true);
      domainInput.focus();
      return;
    }
    const payload = {};
    if (name !== base.name) payload.name = name;
    if (domain !== base.domain) payload.domain = domain;
    if (draft.avatar !== base.avatar) payload.avatar = draft.avatar;
    if (draft.soul !== base.soul) payload.soul = draft.soul;
    if (!Object.keys(payload).length) return;

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
        return;
      }
      // 以服务端回读值为新基准：再点保存不会重复提交同样的内容
      base.name = String(data.partner?.name ?? name);
      base.domain = String(data.partner?.domain ?? "");
      base.avatar = data.partner?.avatar ?? null;
      base.soul = draft.soul;
      Object.assign(draft, base);
      nameInput.value = base.name;
      domainInput.value = base.domain;
      paintAvatarNow();
      title.textContent = base.name;
      const nextVersion = data.soulVersion;
      if (verNode && nextVersion != null) verNode.textContent = `人设 v${nextVersion}`;
      // 侧栏花名册与设置列表都吃 state.partners 这份缓存
      const cached = state.partners.find((item) => item.id === partnerId);
      if (cached) {
        cached.name = base.name;
        cached.domain = base.domain || null;
        cached.avatar = base.avatar;
        if (nextVersion != null) cached.soulVersion = nextVersion;
      }
      syncChiefAvatar();
      void loadRoster();
      setHint(nextVersion != null ? `已保存为 v${nextVersion}，下一轮起用。` : "已保存，下一轮起用。");
      toast("人设已保存");
    } catch (error) {
      if (error.message !== "forbidden") setHint(`没存成：${error.message}`, true);
    } finally {
      saving = false;
      refresh();
    }
  });
}

/* ── ② 岗位：契约 / 目标 / 开关 ─────────────────────────────── */

function pfWireContract(root, partnerId, detail) {
  const area = root.querySelector("#pf-contract");
  if (!area) return; // 开关关着：只读提示已在骨架里
  const save = root.querySelector("#pf-contract-save");
  const reset = root.querySelector("#pf-contract-reset");
  const stateNode = root.querySelector("#pf-contract-state");
  const foot = root.querySelector("#pf-contract-foot");
  const hint = root.querySelector("#pf-contract-hint");
  const verNode = root.querySelector("#pf-contract-ver");
  const tpl = root.querySelector("#pf-contract-tpl");
  let original = area.value;
  let saving = false;

  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", Boolean(isError && text));
  };
  const refresh = () => {
    const dirty = area.value !== original;
    save.disabled = saving || !dirty;
    reset.disabled = saving || !dirty;
    stateNode.classList.toggle("is-dirty", dirty);
    stateNode.querySelector("span").textContent = dirty ? "有改动未保存" : "没有改动";
    if (foot) foot.hidden = !dirty;
    area.disabled = saving;
    // 空着的时候给一句模板（placeholder 只是提示，真正要写四节；有内容就不再提供，免得盖掉草稿）
    if (tpl) tpl.hidden = Boolean(area.value.trim());
  };
  refresh();

  tpl?.addEventListener("click", () => {
    area.value = CS_CONTRACT_TEMPLATE;
    setHint("模板已填好：按四节改成它自己的口径，再保存。");
    area.focus();
    refresh();
  });

  area.addEventListener("input", () => {
    setHint("");
    refresh();
  });
  reset.addEventListener("click", () => {
    area.value = original;
    setHint("");
    refresh();
  });
  save.addEventListener("click", async () => {
    if (saving || area.value === original) return;
    saving = true;
    refresh();
    setHint("保存中…");
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/contract`, {
        method: "PUT",
        body: JSON.stringify({ contract: area.value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
        return;
      }
      original = area.value;
      if (verNode) verNode.textContent = data.contractVersion != null ? `v${data.contractVersion}` : "—";
      detail.contract = data.contract ?? area.value;
      detail.contractVersion = data.contractVersion ?? detail.contractVersion;
      setHint(`已保存${data.contractVersion != null ? `为 v${data.contractVersion}` : ""}，下一轮起用。`);
      toast("岗位契约已保存");
    } catch (error) {
      if (error.message !== "forbidden") setHint(`没存成：${error.message}`, true);
    } finally {
      saving = false;
      refresh();
    }
  });
}

function pfWireGoal(root, partnerId) {
  const input = root.querySelector("#pf-goal");
  if (!input) return;
  const button = root.querySelector("#pf-goal-save");
  const hint = root.querySelector("#pf-goal-hint");
  let saving = false;
  button.addEventListener("click", async () => {
    if (saving) return;
    saving = true;
    button.disabled = true;
    hint.textContent = "保存中…";
    hint.classList.remove("is-error");
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ currentGoal: input.value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        hint.textContent = data.message || data.error || `没存成：HTTP ${response.status}`;
        hint.classList.add("is-error");
        return;
      }
      hint.textContent = input.value.trim() ? "已保存，下次对话起生效。" : "已清除目标。";
      toast("当前目标已更新");
    } catch (error) {
      if (error.message !== "forbidden") {
        hint.textContent = `没存成：${error.message}`;
        hint.classList.add("is-error");
      }
    } finally {
      saving = false;
      button.disabled = false;
    }
  });
}

function pfWireSwitches(root, partnerId, partner) {
  const dispatch = root.querySelector("#pf-dispatch");
  dispatch?.addEventListener("click", async () => {
    const next = dispatch.getAttribute("aria-checked") !== "true";
    dispatch.disabled = true;
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ dispatchAuthority: next }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        toast(`没切成：${data.message || data.error || response.status}`);
        return;
      }
      partner.dispatchAuthority = next;
      dispatch.setAttribute("aria-checked", String(next));
      const cached = state.partners.find((item) => item.id === partnerId);
      if (cached) cached.dispatchAuthority = next;
      void loadRoster();
    } catch (error) {
      if (error.message !== "forbidden") toast(`没切成：${error.message}`);
    } finally {
      dispatch.disabled = false;
    }
  });

  const diary = root.querySelector("#pf-diary");
  diary?.addEventListener("click", async () => {
    const next = diary.getAttribute("aria-checked") !== "true";
    diary.disabled = true;
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ diary: next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(`没切成：${data.message || data.error || response.status}`);
        return;
      }
      diary.setAttribute("aria-checked", String(next));
      partner.diary = next;
      // 日记执事是唯一位：开了别人，别人的开关要跟着灭
      if (next) {
        for (const item of state.partners) {
          if (item.id !== partnerId && item.diary) item.diary = false;
        }
      }
      toast(next ? "已设为日记执事" : "已取消日记执事");
      void loadRoster();
    } catch (error) {
      if (error.message !== "forbidden") toast(`没切成：${error.message}`);
    } finally {
      diary.disabled = false;
    }
  });
}

/* ── ③ 能力：备选链 / 例行 / 技能 ───────────────────────────── */

async function pfLoadSkills(root, partnerId) {
  const box = root.querySelector("#pf-skills");
  const count = root.querySelector("#pf-skill-count");
  try {
    const skills = await csLoadProfileSkills(partnerId);
    if (count) count.textContent = `${skills.length} 本`;
    if (!box) return;
    box.replaceChildren();
    if (!skills.length) {
      box.innerHTML = `<p class="pf-hint">还没有技能</p>`;
      return;
    }
    const shown = skills
      .slice()
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 6);
    for (const skill of shown) {
      const row = document.createElement("div");
      row.className = "pf-skill";
      row.innerHTML = `<span class="pf-skill-name">${esc(String(skill.name || ""))}</span>
        <span class="pf-skill-sum">${esc(String(skill.summary || ""))}</span>
        <span class="pf-skill-when">${esc(csProfileWhen(skill.updatedAt).slice(5, 10))}</span>`;
      box.append(row);
    }
    if (skills.length > shown.length) {
      const more = document.createElement("p");
      more.className = "pf-hint";
      more.textContent = `还有 ${skills.length - shown.length} 本`;
      box.append(more);
    }
  } catch (error) {
    if (error.message === "forbidden") return;
    if (count) count.textContent = "读不到";
    if (box) box.innerHTML = `<p class="pf-hint is-error">技能读不到：${esc(error.message)}</p>`;
  }
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
          persona.contents = data.contents || persona.contents;
          persona.preset = data.preset || persona.preset;
          persona.modules = data.modules || persona.modules;
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

async function pfWirePersona(root, partnerId) {
  const section = root.querySelector("#pf-persona");
  const presetBox = root.querySelector("#pf-persona-presets");
  const listBox = root.querySelector("#pf-persona-list");
  const hint = root.querySelector("#pf-persona-hint");
  if (!section || !presetBox || !listBox || !hint) return;

  /** 端点形状与 shared 的 PartnerPersonaView 一致；这里只留界面要用的三样。 */
  let persona = null;
  let saving = false;

  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", Boolean(isError && text));
  };

  const paint = () => {
    if (!persona) return;
    presetBox.replaceChildren();
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

    listBox.replaceChildren();
    for (const module of PF_PERSONA_MODULES) {
      const row = document.createElement("div");
      row.className = "pf-row pf-mod";
      const label = document.createElement("div");
      label.className = "pf-mod-label";
      const name = document.createElement("span");
      name.className = "pf-mod-name";
      name.dataset.tip = module.tip;
      name.textContent = module.name;
      label.append(name);
      if (module.editable) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "pf-mini";
        edit.dataset.pfEdit = module.editable;
        edit.textContent = "编辑";
        label.append(edit);
      }
      if (module.living) {
        // 活模块这一行（2026-11-15 批2）：一行活状态 + 「查看」手改入口。
        const live = document.createElement("span");
        live.className = "pf-mod-live";
        live.textContent = pfLivingSummary(module.living, persona.living);
        label.append(live);
        const open = document.createElement("button");
        open.type = "button";
        open.className = "pf-mini";
        open.dataset.pfLiving = module.living;
        open.textContent = "查看";
        label.append(open);
      }
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "switch";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", module.name);
      toggle.setAttribute("aria-checked", String(persona.modules?.[module.id] === true));
      toggle.dataset.pfMod = module.id;
      toggle.innerHTML = `<span class="switch-thumb" aria-hidden="true"></span>`;
      row.append(label, toggle);
      listBox.append(row);
    }
  };

  const save = async (payload, anchor) => {
    if (saving) return;
    saving = true;
    if (anchor) anchor.disabled = true;
    setHint("");
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/persona`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
        return;
      }
      persona.preset = data.preset ?? persona.preset;
      persona.modules = data.modules ?? persona.modules;
      persona.contents = data.contents ?? persona.contents;
      persona.switches = data.switches ?? persona.switches;
      persona.living = data.living ?? persona.living;
      paint();
      setHint("已保存，下一轮起用。");
    } catch (error) {
      if (error.message !== "forbidden") setHint(`没存成：${error.message}`, true);
    } finally {
      saving = false;
      if (anchor?.isConnected) anchor.disabled = false;
    }
  };

  presetBox.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pf-preset]");
    if (!button || !persona) return;
    const preset = button.dataset.pfPreset;
    if (preset === persona.preset) return;
    void save({ preset }, button);
  });

  listBox.addEventListener("click", (event) => {
    if (!persona) return;
    const toggle = event.target.closest("[data-pf-mod]");
    if (toggle) {
      const next = toggle.getAttribute("aria-checked") !== "true";
      void save({ modules: { [toggle.dataset.pfMod]: next } }, toggle);
      return;
    }
    const edit = event.target.closest("[data-pf-edit]");
    if (edit) {
      pfOpenPersonaEditor(partnerId, persona, edit.dataset.pfEdit, () => paint());
      return;
    }
    const living = event.target.closest("[data-pf-living]");
    if (living) {
      pfOpenLivingEditor(partnerId, persona, living.dataset.pfLiving, () => {
        void pfReloadPersona(partnerId).then((next) => {
          if (next) {
            persona = next;
            paint();
          }
        });
      });
    }
  });

  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/persona`, {
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(String(response.status));
    // 晚到的响应不盖掉用户已经切走的页
    if (pfRouteId() !== partnerId) return;
    // 总开关关着（PARTNER_PERSONA_MODULES=false）：整块不出现（方案 §八）。
    if (!data.enabled) return;
    persona = data;
    section.hidden = false;
    paint();
  } catch (error) {
    if (error.message === "forbidden") return;
    if (pfRouteId() !== partnerId) return;
    section.hidden = false;
    setHint(`读不到人格模块：${error.message}`, true);
  }
}

/* ── 页面装配 ─────────────────────────────────────────────── */

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
    root.innerHTML = `<div class="pf"><button class="pf-back" type="button" id="pf-back">${PF_BACK}<span>人设与执事</span></button>
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
  root.querySelector("#pf-run")?.addEventListener("click", () =>
    openRunPartnerModal(partnerId, String(partner.name || ""),
  ));
  root.querySelector("#pf-pause")?.addEventListener("click", () => {
    const next = partner.status === "active" ? "paused" : "active";
    const button = root.querySelector("#pf-pause");
    void ptTogglePartner(partnerId, next, button).then(() => {
      if (pfRouteId() === partnerId) void renderPartnerProfilePage(partnerId);
    });
  });

  pfWireIdentity(root, partnerId, partner, detail);
  pfWireContract(root, partnerId, detail);
  pfWireGoal(root, partnerId);
  pfWireSwitches(root, partnerId, partner);
  void pfWirePersona(root, partnerId);

  mountChainEditor(root.querySelector("#pf-chain"), {
    partnerId,
    chain: Array.isArray(detail.modelChain) ? detail.modelChain : [],
    onSaved: (next) => {
      detail.modelChain = next;
      const count = root.querySelector("#pf-chain-count");
      if (count) count.textContent = next.length ? `${next.length} 条` : "0 条";
    },
  });

  const listBox = root.querySelector("#pf-routines");
  const routineCount = root.querySelector("#pf-routine-count");
  ptWireRoutineForm(root, partnerId, listBox);
  void ptRenderRoutineList(listBox, partnerId, {
    // 页面上删完不弹回编辑窗：就地重画这一页（弹窗版行为仍保留在默认分支）
    onDone: () => {
      if (pfRouteId() === partnerId) void renderPartnerProfilePage(partnerId);
    },
  }).then(() => {
    if (routineCount) routineCount.textContent = `${listBox.querySelectorAll(".pt-routine").length} 条`;
  });

  void pfLoadSkills(root, partnerId);
}

/** 面包屑回列表（离开详情页时把窄栏标记摘掉由下一页自己管） */
function pfOpenTo() {
  location.hash = "#/settings/partners";
}

export { pfHash, pfMarkup, pfOpen, pfRouteId, renderPartnerProfilePage };
