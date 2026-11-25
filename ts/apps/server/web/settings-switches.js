/**
 * 插件页（行为开关，原「高级开关」）+ 自动归档设置区
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 2026-11-15：通用开关卡改成「工具活动 + 分组的全部开关」，名字从「高级开关」改成「行为开关」。
 * 2026-11-16：整页从「设置 → 服务」拆出，独立成「设置 → 插件」——这些开关就是做出来的功能，
 * 按插件卡片墙摆；服务页只留服务自身状态。本文件仍是这一页的唯一渲染入口。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import {
  pluginSettingsButtonMarkup,
  pluginSettingsPanelMarkup,
  wirePluginSettings,
} from "./plugin-settings.js";
import { request } from "./net.js";
import { mountSegmented, setSwitchChecked, switchMarkup, syncSegmented } from "./settings-atoms.js";
// 2026-11-24 M4：工具异常处理是独立模块（拉 /tool-policy、画卡片与弹层）；本文件只留挂载点，
// 外加总开关拨动后的即时刷新（不整页重画 flags）和浮层里的内嵌快捷面板。
import { refreshToolPolicySection, renderInlinePolicyPanel, renderToolPolicySection } from "./settings-tool-policy.js";
import { state } from "./state.js";
import { applySurfaces } from "./surfaces.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";
import { setChipPagingEnabled } from "./tool-chips.js";

/* ── 高级开关（2026-11-09）：服务端 env 行为开关搬进界面 ──────────
 * 清单 / 中文名 / 简介 / 分组 / 档位：服务端 `src/plugins.json`（2026-11-16 改从 JSON 读）；
 * 值：`GET/PUT /api/v1/agent/flags`（`.data/agent-flags.json` 覆盖 env，见 flags.ts）。
 * hot=true 改完即时生效；hot=false（路由挂载/工具注册类，启动时冻结）重启后生效——
 * toast 与悬停提示都写明，不装即时。密钥/路径/令牌类 env 不进这张表（密钥纪律）。 */

/** 多档开关的选项（键不在表里 = 布尔开关）。value 是写进 env 的真值，label 给人看。 */
/** 插件清单、中文名、简介、分组、档位全部来自服务端 plugins.json（GET /agent/flags）；
 *  前端不再维护 key / label / group / choice 四张表。2026-11-16 用户拍板：从 JSON 清单读。 */
async function loadFlagsSettings() {
  const card = document.getElementById("flags-card");
  if (!card) return;
  // 从别的页重新进插件页时清掉上一次的搜索串（不跨页面保留）；
  // 同一页内父开关回读时旧搜索框还在，查询与筛选结果保持不动。
  if (!card.querySelector("#flags-search")) flagQuery = "";
  try {
    const response = await request("/api/v1/agent/flags", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json().catch(() => ({}));
    renderFlagRows(
      card,
      Array.isArray(data.flags) ? data.flags : [],
      Array.isArray(data.groups) ? data.groups : [],
    );
    // 界面显隐注册表（2026-11-25）：renderFlagRows 刚把整份行写进 state.flagsCache，
    // 这里就着同一份缓存把注册表重铺一次（不再发第二次请求）。
    applySurfaces();
  } catch (error) {
    if (error.message === "forbidden") return;
    card.innerHTML = `<div class="card flag-empty"><p class="set-hint">读不到开关：${esc(String(error.message))}</p></div>`;
  }
}

/** 关档的取值口径与 flags.ts 的 flagIsOff 同源：false / 0 / off 都算关（布尔 / 旧清单兜底）。
 *  多档插件的关优先读清单的 `offValue`（2026-11-18）：关可以是某个既有档位——
 *  `CHANCELLOR_INTERNAL` 的关是 `qoder`（外部 CLI），`AGENT_TOOL_POLICY` 的关是 `full`（完全访问）。 */
const OFF_VALUES = new Set(["false", "0", "off"]);
function isOffValue(value) {
  return OFF_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function flagOffChoice(flag) {
  const choices = Array.isArray(flag?.choices) ? flag.choices : [];
  const explicit = String(flag?.offValue ?? "").trim();
  if (explicit) {
    return choices.find((choice) => String(choice.value) === explicit) || { value: explicit, label: "关" };
  }
  return choices.find((choice) => OFF_VALUES.has(String(choice.value).trim().toLowerCase())) || null;
}

function flagOffValue(flag) {
  return flagOffChoice(flag)?.value ?? null;
}

function flagOnChoices(flag) {
  const choices = Array.isArray(flag?.choices) ? flag.choices : [];
  const off = flagOffValue(flag);
  return off === null ? choices : choices.filter((choice) => String(choice.value) !== String(off));
}

/** 这个值算不算「关」：多档看清单的 offValue，布尔 / 旧清单看 false / 0 / off。 */
function flagIsOff(flag, value) {
  const off = flagOffValue(flag);
  return off === null ? isOffValue(value) : String(value) === String(off);
}

/** 本次打开插件页时的值基线（2026-11-24 用户口径）：「已改」只表示"这次打开页面后动过它"，
 *  刷新 / 重进页面 / 重启服务后基线重建，徽标自然消失。存下来的值照旧保留；
 *  「默认」仍是 plugins.json 里第一次安装时的出厂值，不随重启变化。 */
const flagBaseline = new Map();
function resetFlagBaseline() {
  flagBaseline.clear();
}

/** 开关从「关」拨回「开」时回到哪一档：记住本次页面里最后选过的开档，
 *  没选过就回默认值，再不行取第一个开档。 */
const lastOnChoice = new Map();
function rememberOnChoice(key, value, flag) {
  if (!flagIsOff(flag, value)) lastOnChoice.set(key, String(value));
}
function onChoiceValue(key, flag) {
  const remembered = lastOnChoice.get(key);
  if (remembered && !flagIsOff(flag, remembered)) return remembered;
  const fallback = String(flag?.defaultValue ?? "");
  if (fallback && !flagIsOff(flag, fallback)) return fallback;
  return flagOnChoices(flag)[0]?.value || "true";
}

/** 常开能力（不是开关）：只作为卡片解释，不参与计数，也不写服务端。
 *  2026-11-18 从卡尾一句话改成卡片（用户口径「顺手把这个工具活动也做成卡片」）；
 *  刻意不提供开关——工具活动是事后复核的凭据，不是可选项。 */
const ALWAYS_ON_PLUGINS = [
  {
    key: "__tool_activity__",
    label: "工具活动",
    summary:
      "对话里始终显示它读了哪个文件、跑了什么命令、花了多久。这是事后复核它到底动过什么的凭据，所以刻意不提供关闭；想看细节，点对话里的灰块。",
    alwaysOn: true,
  },
];

/** 本次渲染的完整详情表：服务端开关 + 常开卡。点卡开弹层时按 key 取最新一份。 */
let flagDetailByKey = new Map();
function flagByKey(key) {
  if (state.flagsCache instanceof Map && state.flagsCache.has(key)) return state.flagsCache.get(key);
  return flagDetailByKey.get(key) || null;
}

/* ── 级联层在不在（B1a 四端点，2026-11-25）──────────
 * enable-plan / enable / disable-plan / disable 整组由 FLAG_CASCADE_ENABLE 控制，门关着是 404，
 * 界面继续走原来那条 PUT。这里只缓存 Bool：null = 还没探测；policy 拉不到按在（true）处理，
 * 端点 404 再把它钉成 false。缓存只作用于本次页面，不跨会话。 */
let cascadeAvailable = null;

async function ensureCascadeAvailable() {
  if (cascadeAvailable !== null) return cascadeAvailable;
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    const data = response.ok ? await response.json().catch(() => ({})) : {};
    cascadeAvailable = data.flagCascade !== false;
  } catch {
    // 拉不到（离线 / 令牌被拒）就按「在」处理，真不在时端点自己会 404。
    cascadeAvailable = true;
  }
  return cascadeAvailable;
}

/** 把值翻成人话：布尔只有开 / 关，多档用服务端清单里的 choices。 */
function flagValueText(flag, value) {
  const choices = Array.isArray(flag?.choices) ? flag.choices : [];
  if (choices.length) return choices.find((choice) => choice.value === value)?.label || value;
  if (value === "true") return "开";
  if (value === "false") return "关";
  return value || "未设";
}

/** 父键的中文名：优先用服务端返回的 lockedByLabel，其次查本次清单缓存，不露 env key。 */
function flagParentLabel(key) {
  const row = state.flagsCache instanceof Map ? state.flagsCache.get(key) : null;
  return row?.label || key;
}

/** 徽标只标「例外」：系统核心、待重启、已改。状态（开 / 关 / 被父关 / 常开）另有一枚，见 flagStatusMarkup；
 *  默认值不在卡面另挂徽标，详情弹层里有「默认」一行（2026-11-25 晚卡片 v2.1：卡面不铺元信息文字）。
 *  「待重启」只在 hot:false 的改动还没被进程装载时出现（服务端 pendingRestart）；重启后自动消失，
 *  不再像旧版那样对所有 hot:false 开关常驻「需重启」——那个字与"这次是否生效"无关。
 *  「已改」只跟本次打开页面时读到的值比：它表示"这次进来动过它"，不是"它跟出厂默认不同"。
 *  后者刷新 / 重启后还在就变成永久标签（2026-11-24 用户口径：每次刷新重启都要回到没改过的样子）；
 *  与出厂默认的差异在详情弹层里看。 */
function flagTags(flag) {
  const tags = [];
  // 2026-11-16 用户拍板「一套展示、两层存储」：core 仍可拨，但明确标成系统核心，
  // 不跟普通插件混成一类；加载逻辑不拆，仍是同一份 GET /agent/flags。
  if (flag.scope === "core") {
    tags.push(
      '<span class="flag-tag core" data-tip="系统核心：服务端环境配置是缺省；这里改的值会保存，重启后仍保持。">系统核心</span>',
    );
  }
  if (flag.pendingRestart) tags.push('<span class="flag-tag warn">待重启</span>');
  if (!flag.lockedBy && flagBaseline.has(flag.key) && String(flag.value) !== flagBaseline.get(flag.key)) tags.push('<span class="flag-tag accent">已改</span>');
  return tags.join("");
}

const FLAG_LOCK_TIP = "「{name}」关闭时，这项显示关、拨不动；它自己的存储值保留，总闸重开后恢复。";

/** 数字型开关（如目标续跑轮数）：服务端 type === "number" 且没有档位表。它没有「开 / 关」，
 *  值是一个整数；别让它落进布尔兜底（2026-11-25 返工：之前徽标按「不是关」显示开、拨杆按 !== "true" 显示关）。 */
function isNumberFlag(flag) {
  return String(flag?.type || "") === "number" && !(Array.isArray(flag?.choices) && flag.choices.length);
}

/** 状态徽标（2026-11-25 卡片 v2）：开 / 关 / 被父关 / 常开。锁态看服务端 lockedBy，不自己推。
 *  数字型没有开关态，徽标写「数字」。 */
function flagStatusMarkup(flag) {
  if (flag.alwaysOn) return '<span class="flag-tag is-status always">常开</span>';
  if (flag.lockedBy) {
    const name = flag.lockedByLabel || flagParentLabel(flag.lockedBy);
    return `<span class="flag-tag is-status locked" data-tip="${attr(FLAG_LOCK_TIP.replace("{name}", name))}">被父关</span>`;
  }
  if (isNumberFlag(flag)) return '<span class="flag-tag is-status number">数字</span>';
  return flagIsOff(flag, String(flag.effectiveValue ?? flag.value ?? ""))
    ? '<span class="flag-tag is-status off">关</span>'
    : '<span class="flag-tag is-status on">开</span>';
}

/** 状态 + 例外徽标，包在一个固定容器里（data-flag-badges）：拨完开关只换容器内容，不动头部结构。
 *  例外徽标在前、状态在最后（2026-11-25 晚）：整组靠右，状态徽标永远贴着卡片右缘，不随例外徽标数量左右跑。 */
function flagBadges(flag) {
  const inner = flagTags(flag) + flagStatusMarkup(flag);
  return `<span class="flag-tags${inner ? "" : " is-empty"}" data-flag-badges="${attr(flag.key)}">${inner}</span>`;
}

/** 拨完开关就地更新这张卡（以及打开着的同键弹层）的徽标与「当前」值：值已写进 state.flagsCache，
 *  不整页重画，卡片墙的滚动位置不动。 */
function paintFlagTags(key) {
  const flag = flagByKey(key);
  if (!flag) return;
  for (const box of document.querySelectorAll(`[data-flag-badges="${key}"]`)) {
    box.innerHTML = flagTags(flag) + flagStatusMarkup(flag);
    box.classList.remove("is-empty");
  }
  for (const node of document.querySelectorAll(`[data-flag-current="${key}"]`)) {
    node.textContent = flagCurrentText(flag);
  }
}

/** 「当前」值的人话。被父关时显示关档的名字（多档的关档标签可能是「关」以外的字），不露 "false"。 */
function flagCurrentText(flag) {
  if (flag.alwaysOn) return "常开";
  if (flag.lockedBy) return flagOffChoice(flag)?.label || "关";
  if (isNumberFlag(flag)) {
    // 数字不走布尔口径：显示数值本身；没设过就显示默认值。
    return String(flag.effectiveValue ?? flag.value ?? "") || String(flag.defaultValue ?? "") || "未设";
  }
  return flagValueText(flag, String(flag.effectiveValue ?? flag.value ?? ""));
}

/** 存储那一格：面板写过（agent-flags.json 覆盖）/ 来自环境变量 / 出厂默认。
 *  只用接口现有字段推：overridden = 覆盖文件里有这个键；没覆盖但值 ≠ 默认 = env 里配了。 */
function flagStorageText(flag) {
  if (flag.overridden) return "面板覆盖";
  if (String(flag.value ?? "") !== String(flag.defaultValue ?? "")) return "env";
  return "默认";
}

/* ── 依赖（2026-11-25 晚卡片 v2.1）────────────────────────────
 * 卡面不再铺 chips：前置 / 被依赖的明细、每项开没开，全部收进详情弹层（点卡就开）。
 * 卡面只留两件能一眼用上的事：
 * - 状态徽标「被父关」= 有前置没开（服务端 lockedBy，不自己推）；
 * - 有子插件的卡在卡尾写「被 N 项依赖」——关它之前值得知道会连带多少。
 * 这样 12 个子项的总闸也不会把卡撑成一面墙，所有卡等高后卡尾自然对齐。 */
function flagChildrenNote(children) {
  if (!Array.isArray(children) || !children.length) return "";
  const names = children.map((key) => flagParentLabel(key)).join("、");
  return `<span class="flag-dep-count" data-tip="${attr(names)}">被 ${children.length} 项依赖</span>`;
}

/* ── 依赖 chips（2026-11-25 卡片 v2.1，只在详情弹层用）────────────
 * 「前置」= 自己的 requires；「被依赖」= requires 里带自己的那些插件（renderFlagRows 现算）。
 * 名字与开 / 关从 state.flagsCache 取；不认识的 key 原样显示 key、不能点。
 * 圆点三态：开（--ok）/ 关（灰）/ 被锁（--warn）；锁住自己的那个父插件整枚 chip 用警示色。 */
const FLAG_CHIP_STATE_TEXT = { on: "开", off: "关", locked: "被锁", unknown: "?" };

function flagChipState(key) {
  const row = flagByKey(key);
  if (!row) return "unknown";
  if (row.lockedBy) return "locked";
  return flagIsOff(row, String(row.effectiveValue ?? row.value ?? "")) ? "off" : "on";
}

function flagChipMarkup(key, kind, locker) {
  const row = flagByKey(key);
  const chipState = flagChipState(key);
  const name = row?.label || key;
  const onPage = Boolean(row) && row.surface !== "settings" && !row.alwaysOn;
  const classes = `flag-chip is-${chipState} ${kind === "child" ? "is-child" : "is-parent"}${locker ? " is-locker" : ""}`;
  const body = `<i class="flag-chip-dot" aria-hidden="true"></i>${esc(name)}<span class="flag-chip-state">${FLAG_CHIP_STATE_TEXT[chipState]}</span>`;
  if (!onPage) return `<span class="${classes} is-static">${body}</span>`;
  return `<button type="button" class="${classes}" data-flag-jump="${attr(key)}" title="点到这张卡">${body}</button>`;
}

/** 详情弹层里的依赖明细（2026-11-25 晚从卡面收进来）：前置 / 被依赖都按 chip 列，点一下关弹层滚到那张卡。 */
function flagDetailDepsMarkup(flag, children) {
  if (flag.alwaysOn) return "";
  const parents = Array.isArray(flag.requires) ? flag.requires : [];
  const groups = [];
  if (parents.length) {
    groups.push(
      `<span class="flag-deps-group"><span class="flag-deps-label">前置</span>${parents.map((key) => flagChipMarkup(key, "parent", key === flag.lockedBy)).join("")}</span>`,
    );
  }
  if (children.length) {
    groups.push(
      `<span class="flag-deps-group"><span class="flag-deps-label">被依赖</span>${children.map((key) => flagChipMarkup(key, "child", false)).join("")}</span>`,
    );
  }
  return groups.length ? `<div class="flag-detail-deps">${groups.join("")}</div>` : "";
}

/** 点 chip：滚到对应卡并闪一下边。目标被搜索过滤掉时先清空搜索再滚（不清就滚不到一张看不见的卡）。 */
function jumpToFlag(key) {
  const card = document.getElementById("flags-card");
  if (!card) return;
  const target = card.querySelector(`[data-flag-detail="${key}"]`)?.closest(".flag-item");
  if (!target) return;
  const section = target.closest("section.flag-section");
  if (target.hidden || section?.hidden) {
    flagQuery = "";
    const search = card.querySelector("#flags-search");
    if (search) search.value = "";
    applyFlagFilter(card);
  }
  target.scrollIntoView?.({ block: "center", behavior: "smooth" });
  target.classList.add("is-flash-hit");
  window.setTimeout(() => {
    if (target.isConnected) target.classList.remove("is-flash-hit");
  }, 1800);
}

/** 一张卡（2026-11-25 晚卡片 v2.1）：头部（名 + 状态徽标，靠右）+ 说明全文 + 卡尾（设置 / 被依赖计数 / 控件）。
 *  KEY、分组、类型 / 当前 / 默认 / 生效 / 存储、前置与被依赖明细都不在卡面——全在点卡打开的详情弹层里。
 *  同排卡等高、卡尾贴底（.flag-grid 的 align-items:stretch），卡面不铺会换行的文字，卡尾控件自然对齐。 */
function flagCardMarkup(flag, children) {
  const label = flag.label || flag.key;
  const locked = Boolean(flag.lockedBy);
  const alwaysOn = Boolean(flag.alwaysOn);
  // 卡内设置（2026-11-25）：登记在 plugin-settings.js 的插件才有「设置」按钮，放在卡尾最左。
  const settingsButton = alwaysOn ? "" : pluginSettingsButtonMarkup(flag.key);
  return `<div class="card flag-item${locked ? " is-locked" : ""}${flag.scope === "core" ? " is-core" : ""}${alwaysOn ? " is-always" : ""}${settingsButton ? " has-settings" : ""}">
    <button class="flag-item-main" type="button" data-flag-detail="${attr(flag.key)}" aria-haspopup="dialog" aria-label="查看「${attr(label)}」说明">
      <span class="flag-item-head">
        <span class="flag-item-name">${esc(label)}</span>
        ${flagBadges(flag)}
        <span class="flag-item-more" aria-hidden="true">›</span>
      </span>
      <span class="flag-item-brief">${esc(flag.summary || "")}</span>
    </button>
    <div class="flag-item-foot">${settingsButton}${alwaysOn ? '<span class="flag-always">常开 · 无开关</span>' : `${flagChildrenNote(children)}${flagControlMarkup(flag)}`}</div>
    ${settingsButton ? pluginSettingsPanelMarkup(flag.key) : ""}
  </div>`;
}

/** 一张卡的控件（2026-11-18 四版）：开关固定在右下角，档位往左放。
 *  - 布尔 = 单独拨杆；
 *  - 多档且清单给了 offValue = 档位（开态选项）在左 + 拨杆在右；
 *  - 多档只有一档开态（内部质检）= 当前档位文字在左 + 拨杆在右；
 *  - 旧清单没有 offValue 的多档（不该再有）= 退回纯分段选择器，不造开关。 */
/** 数字型控件：一个数字输入框 + 灰字默认值。回车或失焦提交（change 事件），留空 = 回到默认。
 *  上下界：接口现在不下发 min / max（listFlags 的返回里没有），所以 min 取 1、max 取 999999；
 *  哪天接口带了这两个字段，这里自动用上，不用再改。真正的上下界由服务端校验，越界时它的报错原样弹 toast。
 *  被父关时显示它自己存的值（接口这时 effectiveValue 是 "false"），禁用。 */
function numberControlMarkup(flag, locked) {
  const label = flag.label || flag.key;
  const shown = String((locked ? flag.value : flag.effectiveValue) ?? flag.value ?? "") || String(flag.defaultValue ?? "");
  return `<div class="flag-number-control">
    <input type="number" class="set-input flag-number-input" step="1" min="${Number(flag.min ?? 1)}" max="${Number(flag.max ?? 999999)}" inputmode="numeric"
      value="${attr(shown)}" data-flag-number="${attr(flag.key)}" aria-label="${attr(label)}"${locked ? " disabled" : ""} />
    <span class="flag-number-default">默认 ${esc(flagValueText(flag, flag.defaultValue))}</span>
  </div>`;
}

function flagControlMarkup(flag) {
  const label = flag.label || flag.key;
  const effective = String(flag.effectiveValue ?? flag.value ?? "");
  const choices = Array.isArray(flag.choices) ? flag.choices : [];
  if (isNumberFlag(flag)) return numberControlMarkup(flag, Boolean(flag.lockedBy));
  if (flag.lockedBy) {
    return switchMarkup(false, {
      label,
      attrs: `data-flag-switch="${attr(flag.key)}" disabled aria-disabled="true"`,
    });
  }
  const offChoice = flagOffChoice(flag);
  const onChoices = flagOnChoices(flag);
  if (offChoice && onChoices.length) {
    const on = !flagIsOff(flag, effective);
    const mode =
      onChoices.length === 1
        ? `<span class="flag-mode-current" data-flag-mode-current="${attr(flag.key)}">${esc(flagValueText(flag, on ? onChoices[0].value : offChoice.value))}</span>`
        : `<div class="segmented" role="radiogroup" aria-label="${attr(label)}档位" data-flag-select="${attr(flag.key)}" data-flag-modes="${attr(flag.key)}">
            ${onChoices.map((choice) => `<button type="button" data-value="${attr(choice.value)}" aria-checked="${on && effective === choice.value}"${on ? "" : " disabled"}>${esc(choice.label)}</button>`).join("")}
          </div>`;
    return `<div class="flag-mode-control${onChoices.length === 1 ? " is-single" : ""}">
      ${mode}
      ${switchMarkup(on, { label, attrs: `data-flag-switch="${attr(flag.key)}"` })}
    </div>`;
  }
  if (choices.length) {
    return `<div class="segmented" role="radiogroup" aria-label="${attr(label)}" data-flag-select="${attr(flag.key)}">
      ${choices.map((choice) => `<button type="button" data-value="${attr(choice.value)}" aria-checked="${effective === choice.value}">${esc(choice.label)}</button>`).join("")}
    </div>`;
  }
  return switchMarkup(effective === "true", {
    label,
    attrs: `data-flag-switch="${attr(flag.key)}"`,
  });
}

/** 点卡弹层：全文 + 状态徽标 + 当前 / 默认 / 生效方式 / 存储 / 前置与被依赖（chips） + 同一套控件。
 *  卡面上不展示的 KEY 与依赖明细都在这里；纯档位插件（没有关档）写明「没有单独开关、由谁控制」，不硬造假开关。 */
function openFlagDetail(flag) {
  const alwaysOn = Boolean(flag.alwaysOn);
  const locked = Boolean(flag.lockedBy);
  const label = flag.label || flag.key;
  const choices = Array.isArray(flag.choices) ? flag.choices : [];
  const offChoice = flagOffChoice(flag);
  const onChoices = flagOnChoices(flag);
  const modeOnly = !alwaysOn && choices.length > 0 && !offChoice;
  const parents = Array.isArray(flag.requires) ? flag.requires : [];
  const parentText = parents.map((key) => flagParentLabel(key)).join("、");
  // 被依赖：插件页上 requires 带自己的那些卡（会话页的 6 项不上插件页，不列）。
  const childKeys = flagChildrenKeys(flag.key);
  const rows = [
    ["当前", flagCurrentText(flag)],
    ["默认", alwaysOn ? "常开" : flagValueText(flag, flag.defaultValue)],
    ["生效", alwaysOn ? "始终生效" : flag.hot ? "改完即时生效" : "重启服务后生效"],
    ["存储", alwaysOn ? "不存储" : { 面板覆盖: "面板改过（agent-flags.json）", env: "环境变量", 默认: "出厂默认" }[flagStorageText(flag)]],
  ];
  if (!alwaysOn) rows.push(["标识", flag.key]);
  const depsBlock = flagDetailDepsMarkup(flag, childKeys);
  let note = "";
  if (locked) {
    note = `当前由「${flag.lockedByLabel || flagParentLabel(flag.lockedBy)}」关闭：显示关、拨不动；它自己的存储值保留，总闸重开后恢复。`;
  } else if (modeOnly) {
    note = parents.length
      ? `这是档位选择，没有单独的「关」：功能本身随「${parentText}」关闭。`
      : "这是档位选择，没有单独的「关」：它决定的是做法，不是这个功能开不开。";
  } else if (offChoice) {
    // offValue 可能指向某个既有档（内部质检的 qoder、工具权限的 full）：这时「关」不是功能停，
    // 而是换到那一档；只有标签是「关」的才是真正关停。
    note =
      String(offChoice.label) === "关"
        ? "开关决定这个插件开不开；打开后可以在下面选档位。"
        : `关 = 「${offChoice.label}」；打开后在下面选其余档位。`;
  }
  const controlLabel = alwaysOn
    ? ""
    : choices.length
      ? offChoice
        ? onChoices.length === 1
          ? "开关"
          : "开关 / 档位"
        : "档位"
      : "开关";
  const detailTags = flagBadges(flag);
  let modalBody = null;
  openModal(label, (body) => {
    modalBody = body;
    body.innerHTML = `<div class="flag-detail">
      ${detailTags ? `<div class="flag-detail-tags">${detailTags}</div>` : ""}
      <p class="flag-detail-summary">${esc(flag.summary || "")}</p>
      <div class="flag-detail-meta">
        ${rows.map(([name, value], index) => `<div class="flag-detail-row"><span class="flag-detail-label">${esc(name)}</span><span class="flag-detail-value"${index === 0 && !alwaysOn ? ` data-flag-current="${attr(flag.key)}"` : ""}>${esc(value)}</span></div>`).join("")}
      </div>
      ${depsBlock}
      ${alwaysOn ? "" : `<div class="flag-detail-control"><span class="flag-detail-label">${esc(controlLabel)}</span>${flagControlMarkup(flag)}</div>`}
      ${flag.key === "TOOL_TIMEOUT_POLICY" ? `<div class="flag-detail-tool-policy" data-tool-policy-inline></div>` : ""}
      ${note ? `<p class="flag-detail-note">${esc(note)}</p>` : ""}
    </div>
    <div class="modal-actions">${
      locked && cascadeAvailable !== false
        ? '<button class="btn-primary" type="button" data-flag-enable-plan>打开这些前置</button>'
        : ""
    }<button class="ghost" type="button" data-flag-close>关闭</button></div>`;
    body.querySelector("[data-flag-close]")?.addEventListener("click", closeModal);
    body.querySelector("[data-flag-enable-plan]")?.addEventListener("click", () => void openEnablePlan(flag.key));
    // 依赖 chips（2026-11-25 晚）：点一下先关弹层，再滚到那张卡并闪边。
    for (const chip of body.querySelectorAll("[data-flag-jump]")) {
      chip.addEventListener("click", () => {
        const targetKey = chip.dataset.flagJump || "";
        closeModal();
        window.setTimeout(() => jumpToFlag(targetKey), 0);
      });
    }
    // 还没探测过级联层：先按「在」把按钮画出来，policy 回话说关就当场摘掉。
    if (locked && cascadeAvailable === null) {
      void ensureCascadeAvailable().then((ok) => {
        if (!ok) body.querySelector("[data-flag-enable-plan]")?.remove();
      });
    }
    if (!alwaysOn) wireFlagControls(body);
    // 工具异常处理：浮层里直接列出可调工具（同一个弹层入口；master 关时是一行提示）。
    const inlinePolicy = body.querySelector("[data-tool-policy-inline]");
    if (inlinePolicy) void renderInlinePolicyPanel(inlinePolicy);
  });
  // 档位弹层里第一个获得焦点的分段按钮会被焦点环画成"像已选中"；锁态下禁用的拨杆也接不住焦点。
  // 有多个开档的分段弹层、以及这两种情况，把初始焦点放到关闭，让当前值的唯一视觉标记仍是控件本身。
  if ((modeOnly || locked || onChoices.length > 1) && modalBody) {
    modalBody.querySelector("[data-flag-close]")?.focus();
  }
}

/** 这次会写几项：missing 里真要写值的 + 目标自身（目标自己是关的也得写开）。 */
function planWriteCount(plan) {
  const missing = Array.isArray(plan?.missing) ? plan.missing : [];
  return missing.filter((node) => node.willWrite).length + (plan?.target?.willWrite ? 1 : 0);
}

/** 前置那一行右半边：写不写值 + 要不要重启。 */
function planNeedNote(node) {
  const parts = [node.willWrite ? "将写值" : "只解锁，不改值"];
  if (node.hot === false) parts.push("重启后生效");
  return parts.join(" · ");
}

/** 待选档位的 <select>：默认落在第一个「不是关」的档（关档选了等于没开）。 */
function planChoicesMarkup(need) {
  const choices = Array.isArray(need?.choices) ? need.choices : [];
  const flag = flagByKey(need.key);
  const off = flag ? flagOffValue(flag) : null;
  const usable = choices.filter((choice) => (off === null ? !isOffValue(choice.value) : String(choice.value) !== String(off)));
  const pick = usable[0] || choices[0];
  return choices
    .map((choice) => `<option value="${attr(choice.value)}"${choice === pick ? " selected" : ""}>${esc(choice.label)}</option>`)
    .join("");
}

/** 锁态卡「打开这些前置」：先读计划，再在弹层里列清单 + 选档位，确认后一次写齐。
 *  openModal 只有一层（后开的直接换掉前一层），所以确认成功关一次就够了。 */
async function openEnablePlan(key) {
  if ((await ensureCascadeAvailable()) === false) return;
  let plan = null;
  try {
    const response = await request(`/api/v1/agent/flags/${encodeURIComponent(key)}/enable-plan`, { cache: "no-store" });
    if (response.status === 404) {
      cascadeAvailable = false;
      document.querySelector("[data-flag-enable-plan]")?.remove();
      toast("前置连开未启用");
      return;
    }
    if (!response.ok) {
      toast(`读不到前置：HTTP ${response.status}`);
      return;
    }
    plan = await response.json().catch(() => null);
  } catch (error) {
    if (error.message !== "forbidden") toast(`读不到前置：${error.message}`);
    return;
  }
  if (!plan || typeof plan !== "object") {
    toast("读不到前置");
    return;
  }
  const missing = Array.isArray(plan.missing) ? plan.missing : [];
  const revive = Array.isArray(plan.revive) ? plan.revive : [];
  const needsValue = Array.isArray(plan.needsValue) ? plan.needsValue : [];
  const writeCount = planWriteCount(plan);
  if (!missing.length && !revive.length && !needsValue.length && !plan.target?.willWrite) {
    toast("没有要打开的项");
    return;
  }
  const confirmText = `打开 ${writeCount} 项${revive.length ? `，其中 ${revive.length} 项会连带恢复` : ""}`;
  openModal("打开前置", (body) => {
    body.innerHTML = `
      <div class="flag-detail">
        ${missing.length ? `<p class="modal-desc">需要打开</p>
        <div class="flag-detail-meta">${missing.map((node) => `<div class="flag-detail-row"><span class="flag-detail-label">${esc(node.label)}</span><span class="flag-detail-value">${esc(planNeedNote(node))}</span></div>`).join("")}</div>` : ""}
        ${revive.length ? `<p class="modal-desc">会一起恢复</p>
        <div class="flag-detail-meta">${revive.map((node) => `<div class="flag-detail-row"><span class="flag-detail-label">${esc(node.label)}</span><span class="flag-detail-value">${esc(flagValueText(flagByKey(node.key), node.value))}</span></div>`).join("")}</div>` : ""}
        ${needsValue.length ? `<p class="modal-desc">需要选档位</p>
        <div class="flag-detail-meta">${needsValue.map((need) => `<div class="flag-detail-row"><span class="flag-detail-label">${esc(need.label)}</span><select class="modal-input" aria-label="${attr(need.label)}档位" data-plan-value="${attr(need.key)}">${planChoicesMarkup(need)}</select></div>`).join("")}</div>` : ""}
      </div>
      <div class="modal-actions">
        <button class="ghost" type="button" data-plan-cancel>取消</button>
        <button class="modal-primary" type="button" data-plan-confirm>${esc(confirmText)}</button>
      </div>`;
    body.querySelector("[data-plan-cancel]")?.addEventListener("click", closeModal);
    const confirmBtn = body.querySelector("[data-plan-confirm]");
    confirmBtn?.addEventListener("click", async () => {
      const values = {};
      for (const select of body.querySelectorAll("[data-plan-value]")) {
        if (select instanceof HTMLSelectElement) values[select.dataset.planValue] = select.value;
      }
      confirmBtn.disabled = true;
      try {
        const response = await request(`/api/v1/agent/flags/${encodeURIComponent(key)}/enable`, {
          method: "POST",
          body: JSON.stringify({ confirm: true, values }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 400 && data.error === "needs_value") {
          toast("还有档位没选");
          return;
        }
        if (response.status === 500 || data.error === "partial") {
          closeModal();
          await loadFlagsSettings();
          applySurfaces();
          toast(`写入中断，已保存 ${Array.isArray(data.changed) ? data.changed.length : 0} 项`);
          return;
        }
        if (!response.ok) {
          toast(data.message || `没打开：HTTP ${response.status}`);
          return;
        }
        closeModal();
        await loadFlagsSettings();
        applySurfaces();
        const openedCount = Array.isArray(data.changed) ? data.changed.length : writeCount;
        toast(data.alreadyOn || !openedCount ? "这些已经是开的" : `已打开 ${openedCount} 项`);
      } catch (error) {
        if (error.message !== "forbidden") toast(`没打开：${error.message}`);
      } finally {
        confirmBtn.disabled = false;
      }
    });
  });
}

/** 卡面 / 弹层共用的事件：拨杆、档位按钮；data-wired 防重复挂（父开关回读会整页重画）。 */
function wireFlagControls(root) {
  for (const sw of root.querySelectorAll("[data-flag-switch]")) {
    if (sw.dataset.wired === "1") continue;
    sw.dataset.wired = "1";
    sw.addEventListener("click", () => {
      if (sw.disabled) return;
      const key = sw.dataset.flagSwitch;
      const flag = flagByKey(key);
      const offChoice = flagOffChoice(flag);
      // 带关档的多档插件：开关只负责开 / 关，开时回到上次选过的档。
      if (offChoice) {
        const next = sw.getAttribute("aria-checked") === "true" ? offChoice.value : onChoiceValue(key, flag);
        void changeFlag(key, next, sw, null);
        return;
      }
      void changeFlag(key, sw.getAttribute("aria-checked") !== "true", sw);
    });
  }
  for (const seg of root.querySelectorAll("[data-flag-select]")) {
    for (const button of seg.querySelectorAll("button")) {
      if (button.dataset.wired === "1") continue;
      button.dataset.wired = "1";
      button.addEventListener("click", () => {
        if (button.disabled || button.getAttribute("aria-checked") === "true") return;
        void changeFlag(seg.dataset.flagSelect, button.dataset.value, null, seg);
      });
    }
    mountSegmented(seg);
  }
  // 数字型（2026-11-25 返工）：change（回车 / 失焦 / 步进钮）提交；回车只是把焦点移走，真正提交仍走 change。
  for (const input of root.querySelectorAll("[data-flag-number]")) {
    if (input.dataset.wired === "1") continue;
    input.dataset.wired = "1";
    input.addEventListener("change", () => commitFlagNumber(input));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
  }
}

/** 提交数字型开关。非整数就地拦下（不提交）并把输入框回填成当前值；留空 = 回到默认（PUT 空串，服务端口径）。
 *  越界这里只知道接口给的上下界（现在是 1–999999），真正的范围由服务端判：它回 400 时 toast 里是它给的说明，
 *  toggleFlag 的收尾会把输入框回填成当前值。数字没有「关」的语义，所以直接走 toggleFlag，不进连带关闭那套。 */
function commitFlagNumber(input) {
  if (input.disabled) return;
  const key = input.dataset.flagNumber;
  const flag = flagByKey(key);
  const row = state.flagsCache instanceof Map ? state.flagsCache.get(key) : null;
  if (!flag || !row) return;
  const current = String(row.effectiveValue ?? row.value ?? "") || String(row.defaultValue ?? "");
  // type=number 的框里打进非数字时浏览器会把 value 清成空串，并置 badInput——那不是「留空回到默认」。
  if (input.validity?.badInput) {
    toast("请填一个整数");
    input.value = current;
    return;
  }
  const raw = String(input.value ?? "").trim();
  if (raw === String(input.dataset.saved ?? current)) return;
  if (raw === "") {
    input.dataset.saved = "";
    void toggleFlag(key, "", input, null);
    return;
  }
  const parsed = Number(raw);
  const min = Number(flag.min ?? 1);
  const max = flag.max === undefined || flag.max === null ? null : Number(flag.max);
  if (!Number.isInteger(parsed) || parsed < min || (max !== null && parsed > max)) {
    toast(max !== null ? `请填 ${min}–${max} 的整数` : `请填不小于 ${min} 的整数`);
    input.value = current;
    return;
  }
  input.dataset.saved = String(parsed);
  void toggleFlag(key, String(parsed), input, null);
}

/** 把同一个键的所有控件（卡面 + 打开着的弹层）同步到同一个值。
 *  带关档的分段在关态禁用并藏起滑动高亮，不让人在关着时还能点档位。 */
function applyFlagControlValue(key, value) {
  const flag = flagByKey(key);
  const off = flagIsOff(flag, value);
  for (const sw of document.querySelectorAll(`[data-flag-switch="${key}"]`)) {
    sw.setAttribute("aria-checked", String(!off));
  }
  for (const seg of document.querySelectorAll(`[data-flag-select="${key}"]`)) {
    const gated = seg.hasAttribute("data-flag-modes");
    for (const button of seg.querySelectorAll("button")) {
      button.setAttribute("aria-checked", String(button.dataset.value === String(value)));
      if (gated) button.disabled = off;
    }
    const plate = seg.querySelector(":scope > .segmented-plate");
    if (plate) plate.style.display = off && gated ? "none" : "";
    if (!off) syncSegmented(seg);
  }
  // 打开着的弹层里「当前」那一行跟着改：切档后不必关掉再开一次才能看到新值。
  for (const node of document.querySelectorAll(`[data-flag-current="${key}"]`)) {
    node.textContent = flag ? flagValueText(flag, String(value)) : String(value);
  }
  // 只有一档开态的多档（内部质检）在开关左边显示当前模式文字，关掉时要变成关档的标签。
  for (const node of document.querySelectorAll(`[data-flag-mode-current="${key}"]`)) {
    node.textContent = flag ? flagValueText(flag, String(value)) : String(value);
  }
  // 数字输入框跟着同一个值走（父开关回读、提交失败后的回填）。正在输入的那一个不动，别把人打的字冲掉。
  for (const input of document.querySelectorAll(`[data-flag-number="${key}"]`)) {
    // 被父关时 value 位置的 effectiveValue 是 "false"，数字框要显示它自己存的那个数。
    const shown = String(flag?.lockedBy ? flag.value : value ?? "") || String(flag?.defaultValue ?? "");
    if (input !== document.activeElement) input.value = shown;
    input.dataset.saved = shown;
  }
  rememberOnChoice(key, value, flag);
}

/* ── 插件页搜索（2026-11-24；2026-11-25 改显式 haystack）──────────
 * 输入即筛选，不持久化。每张卡的检索串 = 名字 / key / 说明 / 组名 / 父 key 与父名 / 子 key 与子名，
 * 渲染时一次算好（flagSearchIndex）；卡内设置面板里的链接文字、控件文字都不在里面。
 * 「工具与命令」组（settings-tool-policy.js 异步画）也参与：整组 textContent 现算，
 * 命中就整组显示（组标题一起），不命中整组连标题一起藏——与其它组同一套规则。
 * 查询串放模块里：flags 重画（父开关回读）后搜索框与筛选结果不丢。 */
let flagQuery = "";
/** key → 小写检索串；每次 renderFlagRows 重建。 */
let flagSearchIndex = new Map();

/** 谁依赖这个 key（只算上插件页的卡；会话页那 6 项没有卡可跳，不算）。 */
function flagChildrenKeys(key) {
  if (!(state.flagsCache instanceof Map)) return [];
  return [...state.flagsCache.values()]
    .filter((row) => row && row.surface !== "settings" && Array.isArray(row.requires) && row.requires.includes(key))
    .map((row) => row.key);
}

function flagSearchHaystack(flag, groupTitle) {
  const parents = Array.isArray(flag.requires) ? flag.requires : [];
  const related = [...parents, ...flagChildrenKeys(flag.key)].map((key) => `${key} ${flagParentLabel(key)}`);
  return [flag.label, flag.key, flag.summary, groupTitle, ...related]
    .filter((part) => typeof part === "string" && part)
    .join(" ")
    .toLowerCase();
}

function applyFlagFilter(card) {
  const query = flagQuery.trim().toLowerCase();
  let matchedSections = 0;
  for (const section of card.querySelectorAll("section.flag-section")) {
    if (section.classList.contains("tool-policy-section")) {
      // 工具组是异步插入的，不能用静态索引：现读整组可见文字（组标题 / 说明卡 /
      // 工具卡名与摘要 / 锁定原因都算）。命中 = 整组显示，否则整组含标题一起藏。
      const hit = !query || (section.textContent || "").toLowerCase().includes(query);
      section.hidden = !hit;
      if (hit) matchedSections += 1;
      continue;
    }
    let sectionShown = 0;
    for (const item of section.querySelectorAll(".flag-item")) {
      const key = item.querySelector("[data-flag-detail]")?.getAttribute("data-flag-detail") || "";
      const hit = !query || (flagSearchIndex.get(key) || "").includes(query);
      item.hidden = !hit;
      if (hit) sectionShown += 1;
    }
    // 组内一张都不剩，组标题也不留；查询为空时所有组恢复。
    section.hidden = sectionShown === 0;
    if (sectionShown > 0) matchedSections += 1;
  }
  // 所有组（含工具组）都无命中才显示空态。
  const empty = card.querySelector("[data-flags-empty]");
  if (empty) empty.hidden = matchedSections > 0;
}

function renderFlagRows(card, flags, groups) {
  card.replaceChildren();
  if (!flags.length) {
    card.innerHTML = `<div class="card flag-empty"><p class="set-hint">这台服务端没开放开关（AGENT_FLAGS_UI=false）。</p></div>`;
    return;
  }
  // 整份服务端行存在 state 里：父开关切换后要扫 requires 决定是否整页回读，
  // 也顺手让其它页的 ensureFlag 拿到 effective 口径。
  state.flagsCache = new Map(
    flags
      .filter((flag) => flag && typeof flag.key === "string")
      .map((flag) => [flag.key, flag]),
  );
  const visible = flags.filter((flag) => flag.surface !== "settings");
  // 本次进页的值基线只在第一次成功渲染时记一次：父开关拨动触发的整页回读不能重置基线，
  // 否则刚拨的那张卡会立刻被当成"没改过"，「已改」闪一下就没。
  if (!flagBaseline.size) {
    for (const flag of visible) flagBaseline.set(flag.key, String(flag.value ?? ""));
  }
  const byKey = new Map(visible.map((flag) => [flag.key, flag]));
  // 反向依赖（2026-11-25 卡片 v2）：key → 依赖它的那些插件，按清单顺序；只算上插件页的卡。
  const childrenByKey = new Map();
  for (const row of visible) {
    for (const parent of Array.isArray(row.requires) ? row.requires : []) {
      if (!childrenByKey.has(parent)) childrenByKey.set(parent, []);
      childrenByKey.get(parent).push(row.key);
    }
  }
  // 点卡时按 key 找完整行：服务端开关走 state.flagsCache，常开卡只有这份静态表。
  flagDetailByKey = new Map([
    ...visible.map((flag) => [flag.key, flag]),
    ...ALWAYS_ON_PLUGINS.map((flag) => [flag.key, flag]),
  ]);
  for (const flag of visible) rememberOnChoice(flag.key, flag.effectiveValue ?? flag.value, flag);
  // 数字型（如目标续跑轮数）没有开 / 关：不进「N 个开关」和两处开 / 关计数，单列一句（2026-11-25 返工）。
  const numeric = visible.filter((flag) => isNumberFlag(flag));
  const counted = visible.filter((flag) => !isNumberFlag(flag));
  const defaultOff = counted.filter((flag) => flag.defaultValue === "false").length;
  const currentOff = counted.filter((flag) => (flag.effectiveValue ?? flag.value) === "false").length;
  const lockedCount = visible.filter((flag) => flag.lockedBy).length;
  // 页首：搜索框 + 一行计数（2026-11-24）。搜索只过滤开关卡、输入即筛选，
  // 查询串不持久化；「工具与命令」由独立模块异步画，插好后会再跑一次同一套过滤。
  card.insertAdjacentHTML(
    "beforeend",
    `<div class="flag-search">
      <label class="mem-a-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="flags-search" type="search" spellcheck="false"
          placeholder="搜索插件 / 开关（名字、说明、key、分组、前置与子插件）" aria-label="搜索插件与开关"
          value="${attr(flagQuery)}" />
      </label>
    </div>
    <div class="flag-intro">
      <span class="flag-intro-count">${counted.length} 个开关${numeric.length ? ` · 另有 ${numeric.length} 项是数字` : ""} · ${counted.length - defaultOff} 默认开 / ${defaultOff} 默认关 · 当前 ${counted.length - currentOff} 开 / ${currentOff} 关${lockedCount ? ` · ${lockedCount} 个随总闸关闭` : ""}</span>
    </div>
    <div class="set-hint flag-search-empty" data-flags-empty hidden>没有匹配的插件</div>`,
  );
  // 工具活动从卡尾一句话改成「始终开启」分组里的一张卡（2026-11-18 用户口径）：
  // 它不是可配置项，但确实是一个能力，值得有自己的位置和说明；不参与上面的开关计数。
  const groupDefs = Array.isArray(groups) ? groups : [];
  // 搜索索引（显式 haystack）：名字 / key / 说明 / 组名 / 父与子的 key 和名字。没归组的按「其他」，清单缺 groups 时按「插件」。
  const groupTitleByKey = new Map();
  for (const group of groupDefs) {
    for (const key of Array.isArray(group.keys) ? group.keys : []) groupTitleByKey.set(key, group.title);
  }
  const fallbackGroupTitle = groupDefs.length ? "其他" : "插件";
  flagSearchIndex = new Map();
  for (const flag of visible) {
    flagSearchIndex.set(flag.key, flagSearchHaystack(flag, groupTitleByKey.get(flag.key) || fallbackGroupTitle));
  }
  for (const flag of ALWAYS_ON_PLUGINS) {
    flagSearchIndex.set(flag.key, flagSearchHaystack(flag, "始终开启"));
  }
  const paintGroup = (title, desc, items) => {
    const section = document.createElement("section");
    section.className = "flag-section";
    section.innerHTML = `<div class="flag-group-head">
        <div class="flag-group-title" data-tip="${attr(desc)}">${esc(title)}</div>
        <div class="flag-group-count">${items.length}</div>
      </div>
      <div class="flag-grid"></div>`;
    const grid = section.querySelector(".flag-grid");
    for (const flag of items) grid.insertAdjacentHTML("beforeend", flagCardMarkup(flag, childrenByKey.get(flag.key) || []));
    card.append(section);
  };
  if (!groupDefs.length) {
    // 清单缺 groups 时也不能让开关消失：按一整个兜底组列出来。
    paintGroup("插件", "服务端清单没有返回分组。", visible);
  } else {
    const grouped = new Set(groupDefs.flatMap((group) => (Array.isArray(group.keys) ? group.keys : [])));
    for (const group of groupDefs) {
      const groupKeys = Array.isArray(group.keys) ? group.keys : [];
      const items = groupKeys.map((key) => byKey.get(key)).filter(Boolean);
      if (items.length) paintGroup(group.title, group.desc, items);
    }
    // 兜底分组：清单里新增的键哪怕还没归组，也必须出现在界面上（不能变成「拨不到」）。
    const rest = visible.filter((flag) => !grouped.has(flag.key));
    if (rest.length) paintGroup("其他", "还没归组的开关；先按原样列出来，等下次整理。", rest);
  }
  paintGroup("始终开启", "这些不是开关，是固定行为；卡片只解释它是什么、为什么不给关。", ALWAYS_ON_PLUGINS);
  card.insertAdjacentHTML(
    "beforeend",
    `<div class="flag-foot">带「系统核心」的开关由服务端环境配置兜底，其余是普通功能插件；密钥 / 路径 / 令牌类 env 刻意不上面板——那些是部署配置，不是日常开关，要改请走 .env。</div>`,
  );
  wireFlagControls(card);
  // 卡内设置（2026-11-25）：事件委托挂在容器上，只挂一次；展开 / 收起都在 plugin-settings.js。
  wirePluginSettings(card);
  for (const main of card.querySelectorAll("[data-flag-detail]")) {
    main.addEventListener("click", () => {
      const flag = flagByKey(main.dataset.flagDetail);
      if (flag) openFlagDetail(flag);
    });
  }
  // 搜索：输入即筛选；flags 重画后按模块里的查询串恢复（不持久化、不动加载 / 保存）。
  const flagsSearch = card.querySelector("#flags-search");
  flagsSearch?.addEventListener("input", () => {
    flagQuery = flagsSearch.value;
    applyFlagFilter(card);
  });
  applyFlagFilter(card);
  // 工具异常处理（2026-11-24）：独立模块自己查位置，插在「始终开启」之前；
  // 端点 404（总开关关）时整组不出现，旧界面原样。逻辑不在本文件里长。
  // 该组是异步插入的：插好 / 没插成都重跑一次过滤，让它在当前搜索词下按同一套规则显示。
  void renderToolPolicySection(card).then(() => {
    if (card.isConnected) applyFlagFilter(card);
  });
}

async function toggleFlag(key, value, sw, seg) {
  const setBusy = (busy) => {
    if (sw) sw.disabled = busy;
    if (seg) for (const button of seg.querySelectorAll("button")) button.disabled = busy;
  };
  setBusy(true);
  try {
    const response = await request(`/api/v1/agent/flags/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value: String(value) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || `没存成：HTTP ${response.status}`);
      return;
    }
    // 同一个键可能有卡面 + 弹层两份控件：统一由 applyFlagControlValue 同步。
    // 带关档的多档插件拨杆看的是「是否开」，不能只看 value === "true"（observe 也是开）。
    applyFlagControlValue(key, String(value));
    // 对话框的逐字浮现开关下一轮要立刻看到变化，不能等刷新：同步内存投影 + 缓存行。
    if (key === "CHAT_STREAM_REVEAL") state.chatRevealFlag = String(value) !== "false";
    // 工具块分页（2026-11-24）：关 = 回到展开全部、无「+N」的旧形态；排版时读模块变量，
    // 下一次交互 / 下一帧生效（已铺开的组不强行重排）。
    if (key === "TOOL_CHIP_PAGING") {
      state.toolChipPagingFlag = String(value) !== "false";
      setChipPagingEnabled(state.toolChipPagingFlag);
    }
    // 工具与命令（2026-11-24 M4 体验项）：总开关一动，工具组即时出现 / 消失。
    // 只重画这一组，不整页重画 flags——卡片墙的滚动位置与其它开关的显隐都不动。
    // 画完 / 摘完再跑一次搜索过滤，让新出现的组也按当前查询词显示。
    if (key === "TOOL_TIMEOUT_POLICY") {
      void refreshToolPolicySection({ enabled: !isOffValue(value) }).then(() => {
        const flagsCard = document.getElementById("flags-card");
        if (flagsCard) applyFlagFilter(flagsCard);
      });
      // 浮层里拨的：内嵌面板原地换成工具列表 / 「先打开开关」提示（同一个弹层入口）。
      const inlinePolicy = document.querySelector("[data-tool-policy-inline]");
      if (inlinePolicy instanceof HTMLElement) void renderInlinePolicyPanel(inlinePolicy);
    }
    // 自动归档拨杆同步进快照：下次进「会话」子页直接按它描，不再走一遍回填动画。
    if (key === "ARCHIVE_AUTO_ENABLED") archiveAutoSnapshot.enabled = String(value) === "true";
    if (state.flagsCache instanceof Map) {
      const row = state.flagsCache.get(key);
      state.flagsCache.set(key, {
        ...(row || { key }),
        value: String(value),
        effectiveValue: String(value),
        hot: data.hot !== false,
      });
      // 父开关一动，所有 requires 里带它的子卡都要改显示 / 锁态；整页回读一次最省心。
      const hasChildren = [...state.flagsCache.values()].some(
        (item) => Array.isArray(item.requires) && item.requires.includes(key),
      );
      if (hasChildren && document.getElementById("flags-card")) void loadFlagsSettings();
    }
    // 界面显隐注册表（2026-11-25）：新值已同步进 state.flagsCache，按它把声明式显隐重铺一遍——
    // 被关掉的那个入口当场收起来，不用等重进页面；缓存在这里可能还不存在（没进过插件页），
    // 那种情况 flagOn 全按开，相当于什么都不动。
    applySurfaces();
    // 「已改」是本次进页后才有的状态：缓存行更新完就地重画徽标，不用刷新整页。
    paintFlagTags(key);
    toast(data.hot ? "已保存，即时生效" : "已保存，重启服务后生效");
    // 数字型「留空回到默认」：本地缓存里只知道存的是空串，真值（默认值还是 env 里的值、还算不算面板覆盖）
    // 只有服务端知道，所以回读一次整页，别拿猜的值描卡。
    if (String(value) === "" && isNumberFlag(flagByKey(key))) void loadFlagsSettings();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没存成：${error.message}`);
  } finally {
    setBusy(false);
    // 失败 / 关档 / 锁态都靠这次回填收口：先把忙态放开，再按当前真值重设禁用与高亮。
    const row = state.flagsCache instanceof Map ? state.flagsCache.get(key) : null;
    if (row) applyFlagControlValue(key, String(row.effectiveValue ?? row.value ?? ""));
  }
}

/* ── 父项连带关（B1a disable-plan / disable）──────────
 * 只有「这次是关」「有子项挂在这个键上」「级联层在」三件事同时成立才先看影响面；
 * 开、无子项、非关一律原样走 toggleFlag（这一层不碰 PUT 本身）。 */
async function changeFlag(key, value, sw, seg) {
  const flag = flagByKey(key);
  const turningOff = flagIsOff(flag, value);
  const hasChildren =
    state.flagsCache instanceof Map &&
    [...state.flagsCache.values()].some((item) => Array.isArray(item.requires) && item.requires.includes(key));
  if (!turningOff || !hasChildren) {
    void toggleFlag(key, value, sw, seg);
    return;
  }
  if ((await ensureCascadeAvailable()) === false) {
    void toggleFlag(key, value, sw, seg);
    return;
  }
  let plan = null;
  try {
    const response = await request(`/api/v1/agent/flags/${encodeURIComponent(key)}/disable-plan`, { cache: "no-store" });
    if (response.status === 404) {
      void toggleFlag(key, value, sw, seg);
      return;
    }
    if (!response.ok) {
      toast(`读不到影响面：HTTP ${response.status}`);
      return;
    }
    plan = await response.json().catch(() => null);
  } catch (error) {
    // 计划读不到就不动它：宁可没关，也不要静默连带关掉一串。
    if (error.message !== "forbidden") toast(`读不到影响面：${error.message}`);
    return;
  }
  if (!plan || typeof plan !== "object") {
    void toggleFlag(key, value, sw, seg);
    return;
  }
  if (plan.disableable === false) {
    toast("这一档没有『关』");
    return;
  }
  const affected = Array.isArray(plan.affected) ? plan.affected : [];
  if (!affected.length) {
    void toggleFlag(key, value, sw, seg);
    return;
  }
  const label = plan.label || flag?.label || key;
  const count = affected.length + 1;
  openModal(`关闭「${label}」`, (body) => {
    body.innerHTML = `
      <div class="flag-detail">
        <p class="modal-desc">这些会显示为关，存储值保留。</p>
        <div class="flag-detail-meta">${affected.map((item) => `<div class="flag-detail-row"><span class="flag-detail-label">${esc(item.label)}</span></div>`).join("")}</div>
      </div>
      <div class="modal-actions">
        <button class="ghost" type="button" data-plan-cancel>取消</button>
        <button class="modal-primary" type="button" data-plan-confirm>关闭 ${count} 项</button>
      </div>`;
    body.querySelector("[data-plan-cancel]")?.addEventListener("click", closeModal);
    const confirmBtn = body.querySelector("[data-plan-confirm]");
    confirmBtn?.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      try {
        const response = await request(`/api/v1/agent/flags/${encodeURIComponent(key)}/disable`, {
          method: "POST",
          body: JSON.stringify({ confirm: true }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 500 || data.error === "partial") {
          closeModal();
          await loadFlagsSettings();
          applySurfaces();
          toast(`写入中断，已保存 ${Array.isArray(data.changed) ? data.changed.length : 0} 项`);
          return;
        }
        if (!response.ok) {
          toast(data.message || `没关成：HTTP ${response.status}`);
          return;
        }
        closeModal();
        await loadFlagsSettings();
        applySurfaces();
        toast(data.alreadyOff ? "这一项已经是关的" : `已关闭 ${count} 项`);
      } catch (error) {
        if (error.message !== "forbidden") toast(`没关成：${error.message}`);
      } finally {
        confirmBtn.disabled = false;
      }
    });
  });
}

/* ── 自动归档设置区（2026-11-13 对齐 ZCode §3）──────────
   设置→会话 独立区块：开关 ARCHIVE_AUTO_ENABLED + 天数 ARCHIVE_AUTO_DAYS（1-365）。
   读 GET /agent/flags 回填，改动 PUT /agent/flags/:key。两个键还没进服务端白名单
   （批A 未落地）时按缺省展示，保存会被 404 拒——toast 里看得到原因，不算静默失败。 */

const AUTO_ARCHIVE_DEFAULTS = { ARCHIVE_AUTO_ENABLED: "true", ARCHIVE_AUTO_DAYS: "30" };

/** 本页面进程内最后一次从服务端回读到的档位：进页先按它描，别等请求回来再翻一次。
 *  设置页每次进子页都重建 DOM，所以 `switchMarkup(false)` 那一版默认态只是占位；
 *  没有这份快照的话，从别的子页切回来时开关会"关 → 滑到开"走一遍过渡，看着像自己又开了一次。
 *  服务端仍是唯一真值：回读到不同的值就地纠正，纠正本身不带过渡（见 setSwitchChecked）。 */
const archiveAutoSnapshot = { enabled: null, days: null };

/** 把开关与天数画成同一份值（程序化回填：一律不滑）。 */
function paintArchiveAuto(switchEl, daysInput, enabled, daysRaw) {
  let days = Math.round(Number(daysRaw));
  if (!Number.isFinite(days) || days <= 0) days = 30;
  days = Math.min(365, Math.max(1, days));
  setSwitchChecked(switchEl, enabled === true || enabled === "true");
  daysInput.value = String(days);
  daysInput.defaultValue = String(days);
  syncArchiveAutoTip(days);
  archiveAutoSnapshot.enabled = enabled === true || enabled === "true";
  archiveAutoSnapshot.days = days;
}

/** 标签悬停文案（解释文字不常驻）：天数变化要跟着改 N。 */
function archiveAutoTip(days) {
  return `开启后，${days} 天没动静的普通对话与已结束的任务专线自动归档；总管、执事/群、置顶与运行中的不动。`;
}

/** 把天数文案挂到「自动归档」那一行的标签上（rowMarkup 生成的 data-tip 位）。 */
function syncArchiveAutoTip(days) {
  const label = document
    .querySelector("[data-archive-auto-switch]")
    ?.closest(".row")
    ?.querySelector(".row-label");
  label?.setAttribute("data-tip", archiveAutoTip(days));
}

async function loadAutoArchiveSettings() {
  const switchEl = document.querySelector("[data-archive-auto-switch]");
  const daysInput = document.getElementById("archive-auto-days");
  const hint = document.getElementById("archive-auto-hint");
  const hintWrap = document.getElementById("archive-auto-hint-wrap");
  if (!(switchEl instanceof HTMLElement) || !(daysInput instanceof HTMLInputElement)) return;
  const hadSnapshot = archiveAutoSnapshot.enabled !== null;
  const fallbackText = hadSnapshot ? "先按上次读到的值展示" : "先按默认展示";
  // 同一页面进程里再次进这一页：先按上次回读到的值描好，请求回来只做纠正。
  // 这一步必须早于 await——晚一步就是让"关"那版占位态先上屏、再滑成"开"。
  if (hadSnapshot) {
    paintArchiveAuto(switchEl, daysInput, archiveAutoSnapshot.enabled, archiveAutoSnapshot.days);
  }
  const values = { ...AUTO_ARCHIVE_DEFAULTS };
  const rows = new Map();
  let known = false;
  try {
    const response = await request("/api/v1/agent/flags", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      known = true;
      for (const flag of Array.isArray(data.flags) ? data.flags : []) {
        if (flag?.key === "ARCHIVE_AUTO_ENABLED" || flag?.key === "ARCHIVE_AUTO_DAYS") {
          values[flag.key] = String(flag.value || AUTO_ARCHIVE_DEFAULTS[flag.key]);
          rows.set(flag.key, flag);
        }
      }
    } else if (hint) {
      hint.textContent = `读不到开关（HTTP ${response.status}），${fallbackText}。`;
    }
  } catch (error) {
    if (error.message === "forbidden") return;
    if (hint) hint.textContent = `读不到开关，${fallbackText}：${error.message}`;
  }
  // 提示行只装状态/错误：没话可说就整块（含分隔线）不占位
  if (hintWrap) hintWrap.hidden = !hint?.textContent;
  if (known) {
    paintArchiveAuto(switchEl, daysInput, values.ARCHIVE_AUTO_ENABLED === "true", values.ARCHIVE_AUTO_DAYS);
    const daysRow = rows.get("ARCHIVE_AUTO_DAYS");
    const locked = Boolean(daysRow?.lockedBy);
    daysInput.disabled = locked;
    daysInput.setAttribute("aria-disabled", String(locked));
    // 这页的全局 tooltip 会剥掉原生 title，说明挂 data-tip（悬停可见）。
    if (locked) {
      daysInput.setAttribute(
        "data-tip",
        `「${daysRow.lockedByLabel || daysRow.lockedBy}」关闭时，保留天数不生效；重新打开后按原值恢复。`,
      );
    } else {
      daysInput.removeAttribute("data-tip");
    }
  } else if (!hadSnapshot) {
    // 从来没读到过：按缺省展示，别让两个控件空着（2026-11-15 起自动归档缺省开）
    paintArchiveAuto(switchEl, daysInput, AUTO_ARCHIVE_DEFAULTS.ARCHIVE_AUTO_ENABLED === "true", AUTO_ARCHIVE_DEFAULTS.ARCHIVE_AUTO_DAYS);
  }
  // 读过就不回退：读失败时把已知的"开"改回"关"，比停在旧值更糟
}

async function saveAutoArchiveDays(input) {
  const previous = input.defaultValue || "30";
  let days = Math.round(Number(input.value));
  if (!Number.isFinite(days) || days <= 0) days = Number(previous) || 30;
  days = Math.min(365, Math.max(1, days));
  input.value = String(days);
  syncArchiveAutoTip(days);
  try {
    const response = await request("/api/v1/agent/flags/ARCHIVE_AUTO_DAYS", {
      method: "PUT",
      body: JSON.stringify({ value: String(days) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || `没存成：HTTP ${response.status}`);
      input.value = previous;
      syncArchiveAutoTip(Number(previous) || 30);
      return;
    }
    input.defaultValue = String(days);
    archiveAutoSnapshot.days = days;
    toast(data.hot === false ? "已保存，重启服务后生效" : "已保存，即时生效");
  } catch (error) {
    if (error.message !== "forbidden") toast(`没存成：${error.message}`);
    input.value = previous;
    syncArchiveAutoTip(Number(previous) || 30);
  }
}

export { AUTO_ARCHIVE_DEFAULTS, archiveAutoTip, loadAutoArchiveSettings, loadFlagsSettings, renderFlagRows, resetFlagBaseline, saveAutoArchiveDays, syncArchiveAutoTip, toggleFlag };
