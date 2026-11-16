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
import { request } from "./net.js";
import { mountSegmented, setSwitchChecked, switchMarkup, syncSegmented } from "./settings-atoms.js";
import { state } from "./state.js";
import { toast } from "./ui-atoms.js";

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
  try {
    const response = await request("/api/v1/agent/flags", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json().catch(() => ({}));
    renderFlagRows(
      card,
      Array.isArray(data.flags) ? data.flags : [],
      Array.isArray(data.groups) ? data.groups : [],
    );
  } catch (error) {
    if (error.message === "forbidden") return;
    card.innerHTML = `<div class="card flag-empty"><p class="set-hint">读不到开关：${esc(String(error.message))}</p></div>`;
  }
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

/** 卡片徽标只标「例外」：默认关、待重启、已改、随总闸关闭。默认开是多数派，页首已写总数。
 *  「待重启」只在 hot:false 的改动还没被进程装载时出现（服务端 pendingRestart）；重启后自动消失，
 *  不再像旧版那样对所有 hot:false 开关常驻「需重启」——那个字与"这次是否生效"无关。
 *  「已改」看当前值是否真的和默认不同，不看文件里有没有历史覆盖行（覆盖行可能只是测试留下的）。 */
function flagTags(flag) {
  const tags = [];
  const locked = Boolean(flag.lockedBy);
  // 2026-11-16 用户拍板「一套展示、两层存储」：core 仍可拨，但明确标成系统核心，
  // 不跟普通插件混成一类；加载逻辑不拆，仍是同一份 GET /agent/flags。
  if (flag.scope === "core") {
    tags.push(
      '<span class="flag-tag core" data-tip="系统核心：服务端环境配置是缺省；这里改的值会保存，重启后仍保持。">系统核心</span>',
    );
  }
  if (flag.defaultValue === "false") tags.push(`<span class="flag-tag">默认${esc(flagValueText(flag, flag.defaultValue))}</span>`);
  if (flag.pendingRestart) tags.push('<span class="flag-tag warn">待重启</span>');
  if (locked) tags.push(`<span class="flag-tag warn" data-tip="「${attr(flag.lockedByLabel || flagParentLabel(flag.lockedBy))}」关闭时，这项显示关、拨不动；它自己的存储值保留，总闸重开后恢复。">随总闸关闭</span>`);
  else if (flag.value !== flag.defaultValue) tags.push('<span class="flag-tag accent">已改</span>');
  return tags.length ? `<span class="flag-tags">${tags.join("")}</span>` : "";
}

/** 卡片上一句话简介：取 summary 的第一句；完整解释仍在标题的 data-tip 里。 */
function flagBrief(summary) {
  const first = String(summary || "").split("。")[0].trim();
  return first;
}

/** 一张开关卡（2026-11-15 二版）：照「插件中心」的卡片墙排——名字 + 徽标 + 两行简介 + 控件；
 *  完整说明收进名字的 data-tip（和设置页其它标签同一套小黑块），不再把长段正文铺在卡面上。 */
function flagCardMarkup(flag) {
  const meta = { label: flag.label || flag.key, summary: flag.summary || "" };
  const locked = Boolean(flag.lockedBy);
  const effective = flag.effectiveValue ?? flag.value;
  // 多档开关：服务端清单给 choices；没有 choices 的按布尔拨杆画。
  const choices = Array.isArray(flag.choices) ? flag.choices : [];
  const lockedSwitch = switchMarkup(false, {
    label: meta.label,
    attrs: `data-flag-switch="${attr(flag.key)}" disabled aria-disabled="true"`,
  });
  const control = locked
    ? lockedSwitch
    : choices.length
      ? `<div class="segmented" role="radiogroup" aria-label="${attr(meta.label)}" data-flag-select="${attr(flag.key)}">
           ${choices.map((choice) => `<button type="button" data-value="${attr(choice.value)}" aria-checked="${effective === choice.value}">${esc(choice.label)}</button>`).join("")}
         </div>`
      : switchMarkup(effective === "true", {
          label: meta.label,
          attrs: `data-flag-switch="${attr(flag.key)}"`,
        });
  const tip = locked
    ? `${meta.summary} 当前由「${flag.lockedByLabel || flagParentLabel(flag.lockedBy)}」关闭：显示关、拨不动；它自己的存储值保留，总闸重开后恢复。`
    : meta.summary;
  return `<div class="card flag-item${locked ? " is-locked" : ""}${flag.scope === "core" ? " is-core" : ""}">
    <div class="flag-item-main" data-tip="${attr(tip)}">
      <div class="flag-item-head">
        <div class="flag-item-name">${esc(meta.label)}</div>
        ${flagTags(flag)}
      </div>
      <div class="flag-item-brief">${esc(flagBrief(meta.summary))}</div>
    </div>
    <div class="flag-item-foot">${control}</div>
  </div>`;
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
  const byKey = new Map(visible.map((flag) => [flag.key, flag]));
  const defaultOff = visible.filter((flag) => flag.defaultValue === "false").length;
  const currentOff = visible.filter((flag) => (flag.effectiveValue ?? flag.value) === "false").length;
  const lockedCount = visible.filter((flag) => flag.lockedBy).length;
  // 页首只留一行计数，不铺解释性长文：这一页是干什么的，名字和卡片简介已经说清了。
  card.insertAdjacentHTML(
    "beforeend",
    `<div class="flag-intro">
      <span class="flag-intro-count">${visible.length} 个插件 · ${visible.length - defaultOff} 默认开 / ${defaultOff} 默认关 · 当前 ${visible.length - currentOff} 开 / ${currentOff} 关${lockedCount ? ` · ${lockedCount} 个随总闸关闭` : ""}</span>
    </div>`,
  );
  // 工具活动不再单列一行（2026-11-15 用户口径：常开、平时不会去动它，条目可以删）：
  // 它确实是常开的复核凭据，但不是一个可配置项；压到卡尾一句话，既不占一行，也不丢这个事实。
  const groupDefs = Array.isArray(groups) ? groups : [];
  const paintGroup = (title, desc, items) => {
    const section = document.createElement("section");
    section.className = "flag-section";
    section.innerHTML = `<div class="flag-group-head">
        <div class="flag-group-title" data-tip="${attr(desc)}">${esc(title)}</div>
        <div class="flag-group-count">${items.length}</div>
      </div>
      <div class="flag-grid"></div>`;
    const grid = section.querySelector(".flag-grid");
    for (const flag of items) grid.insertAdjacentHTML("beforeend", flagCardMarkup(flag));
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
  card.insertAdjacentHTML(
    "beforeend",
    `<div class="flag-foot"><strong>工具活动常开</strong>：对话里始终显示读了哪个文件、跑了什么命令、花了多久；不提供关闭，用来事后复核它到底动过什么。<br>带「系统核心」的开关由服务端环境配置兜底，其余是普通功能插件；密钥 / 路径 / 令牌类 env 刻意不上面板——那些是部署配置，不是日常开关，要改请走 .env。</div>`,
  );
  for (const sw of card.querySelectorAll("[data-flag-switch]")) {
    sw.addEventListener("click", () => {
      void toggleFlag(sw.dataset.flagSwitch, sw.getAttribute("aria-checked") !== "true", sw);
    });
  }
  for (const seg of card.querySelectorAll("[data-flag-select]")) {
    for (const button of seg.querySelectorAll("button")) {
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-checked") === "true") return;
        void toggleFlag(seg.dataset.flagSelect, button.dataset.value, null, seg);
      });
    }
    mountSegmented(seg);
  }
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
    // 布尔拨杆路径传的是 boolean，分段控件路径传的是字符串——统一归一成字符串再比，
    // 否则 String(true === "true") 恒为 false，拨杆点击后服务端已翻但 UI 永远显示旧态（实测复现）。
    if (sw) sw.setAttribute("aria-checked", String(String(value) === "true"));
    if (seg) {
      for (const button of seg.querySelectorAll("button")) {
        button.setAttribute("aria-checked", String(button.dataset.value === String(value)));
      }
      syncSegmented(seg);
    }
    // 对话框的逐字浮现开关下一轮要立刻看到变化，不能等刷新：同步内存投影 + 缓存行。
    if (key === "CHAT_STREAM_REVEAL") state.chatRevealFlag = String(value) !== "false";
    // 自动归档拨杆同步进快照：下次进「会话」子页直接按它描，不再走一遍回填动画。
    if (key === "ARCHIVE_AUTO_ENABLED") archiveAutoSnapshot.enabled = String(value) === "true";
    // 历史分页同理：下一次 openChat 立刻按新开关走（当前屏幕不重排，避免翻页中被打断）。
    if (key === "CHAT_HISTORY_PAGING_ENABLED") state.chatPagingFlag = String(value) !== "false";
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
    toast(data.hot ? "已保存，即时生效" : "已保存，重启服务后生效");
  } catch (error) {
    if (error.message !== "forbidden") toast(`没存成：${error.message}`);
  } finally {
    setBusy(false);
  }
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

export { AUTO_ARCHIVE_DEFAULTS, archiveAutoTip, loadAutoArchiveSettings, loadFlagsSettings, renderFlagRows, saveAutoArchiveDays, syncArchiveAutoTip, toggleFlag };
