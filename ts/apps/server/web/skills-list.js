/**
 * 技能墙：筛选、排序、卡片、斜杠选择器
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { switchMarkup } from "./settings-atoms.js";
import { toggleSkillEnabled } from "./skills-actions.js";
import { openDeleteSkillModal, openEditSkillModal } from "./skills-modals.js";
import { SKILL_ADVICE_BUCKET_LABEL, SKILL_ADVICE_FILTERS, SKILL_ADVICE_FREQ_LABEL, SKILL_FREQ_RANK, SKILL_ORIGIN_LABEL, SKILL_SORT_OPTIONS, skillAdvice, skillAdvicePlan, skillLastUsedText, skillSizeText, skillWhenText } from "./skills-settings.js";
import { toast } from "./ui-atoms.js";

/* ── 分类 / 排序 / 批量（2026-11-13 二轮：按钮收敛成两个下拉 + 一个批量钮）──
 * 分类 = Agent 评估分栏（全部 / 建议开启 / 按场景 / 建议不开 / 未评估）；
 * 排序 = 默认（读取链顺序）/ 使用频率（次数、最近使用）/ Agent 建议（桶 + 频率）。
 * 没有建议快照时分类整块不出现、排序里也不出现「Agent 建议」。
 * 列表分两区：已开启在上、未开启在下；筛选与排序各自作用于两个区内部。 */

function closeSkillSelects() {
  for (const menu of document.querySelectorAll(".sk-select-menu:not([hidden])")) {
    menu.hidden = true;
    menu.closest(".sk-select")?.querySelector(".sk-select-btn")?.setAttribute("aria-expanded", "false");
  }
}

/** 一个紧凑下拉：按钮 + 贴下方的单选菜单（筛选/排序共用；视觉同 .gmenu 一档） */
function renderSkillSelect(slot, { label, count = null, value, options, onPick }) {
  slot.replaceChildren();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sk-select-btn";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<span class="sk-select-label">${esc(label)}</span>${
    count === null ? "" : `<span class="sk-select-count">${count}</span>`
  }<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const menu = document.createElement("div");
  menu.className = "sk-select-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  for (const option of options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "sk-select-item";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(option.value === value));
    item.innerHTML = `<span class="sk-select-label">${esc(option.label)}</span>${
      option.count === undefined ? "" : `<span class="sk-select-count">${option.count}</span>`
    }<svg class="sk-select-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
    item.addEventListener("click", () => {
      closeSkillSelects();
      if (option.value !== value) onPick(option.value);
    });
    menu.append(item);
  }
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    closeSkillSelects();
    if (!open) return;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    menu.querySelector('[aria-checked="true"]')?.focus();
  });
  slot.append(button, menu);
}

function skillFilterCounts(items) {
  const view = skillAdvice.view;
  const counts = { all: items.length, keep: 0, scene: 0, skip: 0, none: 0 };
  for (const item of items) {
    const entry = view?.items?.[item.name];
    if (entry) counts[entry.bucket] = (counts[entry.bucket] || 0) + 1;
    else counts.none += 1;
  }
  return counts;
}

/** 工具栏（分类 / 排序 / 批量）与建议 banner 的唯一渲染入口；每次列表重渲都跟着刷新 */
function renderSkillControls(items) {
  const view = skillAdvice.view;
  skillAdvice.items = items;
  const toolbar = document.getElementById("skill-toolbar");
  if (toolbar) toolbar.hidden = items.length === 0;

  const counts = skillFilterCounts(items);
  const filterSlot = document.getElementById("skill-filter");
  if (filterSlot) {
    if (!view) {
      // 没有评估快照 = 没有分类可筛（旧行为：chips 整块不出现）
      skillAdvice.filter = "all";
      filterSlot.hidden = true;
      filterSlot.replaceChildren();
    } else {
      filterSlot.hidden = false;
      const current =
        SKILL_ADVICE_FILTERS.find((spec) => spec.key === skillAdvice.filter) || SKILL_ADVICE_FILTERS[0];
      renderSkillSelect(filterSlot, {
        label: current.label,
        count: counts[current.key] ?? 0,
        value: current.key,
        options: SKILL_ADVICE_FILTERS.map((spec) => ({
          value: spec.key,
          label: spec.label,
          count: counts[spec.key] ?? 0,
        })),
        onPick: (key) => {
          skillAdvice.filter = key;
          renderSkillList(document.getElementById("skill-list"), skillAdvice.items);
        },
      });
    }
  }

  const sortSlot = document.getElementById("skill-sort");
  if (sortSlot) {
    const options = SKILL_SORT_OPTIONS.filter((spec) => spec.key !== "advice" || view).map((spec) => ({
      value: spec.key,
      label: spec.label,
    }));
    if (!options.some((spec) => spec.value === skillAdvice.sort)) skillAdvice.sort = "default";
    const current = options.find((spec) => spec.value === skillAdvice.sort) || options[0];
    renderSkillSelect(sortSlot, {
      label: current.label,
      value: current.value,
      options,
      onPick: (key) => {
        skillAdvice.sort = key;
        renderSkillList(document.getElementById("skill-list"), skillAdvice.items);
      },
    });
  }

  const bulk = document.getElementById("skill-bulk");
  if (bulk) {
    const allOn = items.length > 0 && items.every((item) => item.enabled === true);
    bulk.hidden = items.length === 0;
    bulk.textContent = allOn ? "全部关闭" : "全部开启";
    bulk.title = allOn ? "批量关闭全部技能（需要确认）" : "批量开启全部技能（需要确认）";
  }

  // Agent 建议条（2026-11-13 补）：有快照就常驻，写明建议分布与对齐状态。
  // 「按建议调整」= 建议开启的打开、建议不开的关闭；按场景 / 未评估 / 待复核不动。
  const banner = document.getElementById("skill-advice-banner");
  if (banner) {
    const plan = skillAdvicePlan(items);
    if (!skillAdvice.view) {
      banner.hidden = true;
      banner.replaceChildren();
    } else if (!plan) {
      // 端点开着但还没有快照：给一句指引，别让「Agent 建议」这一行时有时无
      banner.hidden = false;
      banner.innerHTML = `
        <span class="sk-banner-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg></span>
        <span class="sk-banner-text">Agent 建议：还没有评估。先点右上「让 Agent 评估」，总管逐条评完这里会出现「按建议调整」。</span>`;
    } else {
      const mismatch = plan.toOn.length + plan.toOff.length;
      const summary = [
        `开启 ${plan.keep} 个`,
        plan.warn ? `待复核 ${plan.warn} 个` : "",
        `不开 ${plan.skip} 个`,
      ]
        .filter(Boolean)
        .join(" · ");
      const status = mismatch
        ? `；${plan.toOn.length ? `建议开启没开 ${plan.toOn.length} 个` : ""}${
            plan.toOn.length && plan.toOff.length ? "、" : ""
          }${plan.toOff.length ? `建议不开开着 ${plan.toOff.length} 个` : ""}`
        : "；已按建议对齐";
      const source = `Agent 评估于 ${skillWhenText(plan.generatedAt)}${plan.model ? `（${plan.model}）` : ""}`;
      banner.hidden = false;
      banner.innerHTML = `
        <span class="sk-banner-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg></span>
        <span class="sk-banner-text" title="${attr(source)}">Agent 建议：${summary}${status}。</span>
        <button class="ghost" type="button" data-skill-apply title="按 Agent 的建议调整：开启建议开启的、关闭建议不开的；按场景 / 未评估 / 待复核不动">按建议调整</button>`;
    }
  }
}

/** 排序只作用在同一分区内（已开启 / 未开启各自排） */
function sortSkillItems(items) {
  const out = items.slice();
  if (skillAdvice.sort === "usage") {
    out.sort((a, b) => {
      const ua = Number.isFinite(a.usageCount) ? Number(a.usageCount) : 0;
      const ub = Number.isFinite(b.usageCount) ? Number(b.usageCount) : 0;
      if (ua !== ub) return ub - ua;
      const ta = Date.parse(String(a.lastUsedAt || "")) || 0;
      const tb = Date.parse(String(b.lastUsedAt || "")) || 0;
      if (ta !== tb) return tb - ta;
      return String(a.name).localeCompare(String(b.name));
    });
  } else if (skillAdvice.sort === "advice") {
    const view = skillAdvice.view;
    const rankOf = (item) => {
      const entry = view?.items?.[item.name];
      if (!entry) return { bucket: 4, freq: 9 };
      // 待复核（建议开启 + 几乎用不上）排最前：它就是要人看一眼的那条
      if (entry.bucket === "keep" && entry.frequency === "rare") {
        return { bucket: 0, freq: SKILL_FREQ_RANK.rare };
      }
      const bucket = entry.bucket === "keep" ? 1 : entry.bucket === "scene" ? 2 : entry.bucket === "skip" ? 3 : 4;
      return { bucket, freq: SKILL_FREQ_RANK[entry.frequency] ?? 9 };
    };
    out.sort((a, b) => {
      const ra = rankOf(a);
      const rb = rankOf(b);
      if (ra.bucket !== rb.bucket) return ra.bucket - rb.bucket;
      if (ra.freq !== rb.freq) return ra.freq - rb.freq;
      return String(a.name).localeCompare(String(b.name));
    });
  }
  return out;
}

/** 一张技能卡（A+C 版）：名字当主角、建议 = 色点 + 四个字、底部只留用量 + 开关/删除 */
function buildSkillCard(item, view) {
  const name = String(item.name || "");
  // 只读来源（~/.agents/skills）只展示不给删：那是别的工具的家，改删请去原目录（2026-11-08 批 10-A）
  const readOnly = item.writable === false;
  const originLabel = readOnly ? SKILL_ORIGIN_LABEL[item.origin] || String(item.origin || "") : "";
  // 用量（2026-11-10 批 18 §四；2026-11-13 A+C 版）：卡片只留「用过几次 · 多久前」，
  // 秒级更新时间与文件大小移进点开的弹窗。SKILL_USAGE 关着时端点整组不回这三个字段 → 这段自然空掉。
  const usage = Number.isFinite(item.usageCount) ? Number(item.usageCount) : null;
  const lastUsed = skillLastUsedText(item.lastUsedAt);
  // 建议（批 30；2026-11-13 C 版口径）：只留 6px 色点 + 四个字，频率与理由进 hover。
  // rare+keep 自相矛盾 → 待复核，不进一键采纳口径之外的建议。
  const entry = view?.items?.[name];
  let adviceTag = "";
  if (view && !entry) {
    adviceTag = `<span class="sk-bucket sk-bucket-none" title="Agent 还没评估过这条（快照生成后新装的技能）。点「让 Agent 评估」重新生成。"><i></i>未评估</span>`;
  } else if (entry) {
    const contradictory = entry.bucket === "keep" && entry.frequency === "rare";
    const cls = contradictory ? "sk-bucket-warn" : `sk-bucket-${entry.bucket}`;
    const label = contradictory ? "待复核" : SKILL_ADVICE_BUCKET_LABEL[entry.bucket] || entry.bucket;
    const tip = `预计${SKILL_ADVICE_FREQ_LABEL[entry.frequency] || entry.frequency}用上；${entry.reason || "（没有理由）"}${contradictory ? "；模型说建议开启但频率几乎用不上，自相矛盾，采纳前自己看一眼" : ""}`;
    adviceTag = `<span class="sk-bucket ${cls}" title="${attr(tip)}"><i></i>${esc(label)}</span>`;
  }
  // 更新时间、文件大小、来源、全文都点开弹窗看——列表不再一人一行摊开日志。
  const summaryText = String(item.summary || "（第 1 行是空摘要，不会进索引）");
  // 只读标记的 hover 分两种：内置手册可"另存一份改"，.agents 只能去原目录
  const readOnlyTip =
    item.origin === "app"
      ? "内置手册（只读来源）：点开可编辑，保存会在你的技能目录里建一份同名副本"
      : `来自${originLabel}（只读来源），改 / 删请去原目录`;
  const metaBits = [];
  if (usage !== null) {
    metaBits.push(`<span>${usage > 0 ? `用过 ${usage} 次` : "没用过"}</span>`);
    if (usage > 0 && lastUsed) metaBits.push(`<span>${esc(lastUsed)}</span>`);
  }
  if (readOnly) metaBits.push(`<span class="sk-ro" title="${attr(readOnlyTip)}">只读</span>`);
  if (item.stale === true) {
    metaBits.push(
      `<span class="sk-stale" title="按最近一次使用时间算，已经 90 天没被取用过；只标记，不删不移">90 天未用</span>`,
    );
  }
  const metaHtml = metaBits.join('<span class="sk-sep">·</span>');
  // hover 补全卡片上撤掉的细节（更新到什么时候、多大、从哪来）
  const metaTip = [
    `更新于 ${skillWhenText(item.updatedAt)}`,
    skillSizeText(item.size),
    usage === null ? "" : usage > 0 ? `用过 ${usage} 次${lastUsed ? `，上次 ${lastUsed}` : ""}` : "没用过",
    readOnly ? `来自 ${originLabel}（只读）` : "",
  ]
    .filter(Boolean)
    .join("；");
  const card = document.createElement("div");
  card.className = "card sk-item";
  card.innerHTML = `
    <button class="sk-open" type="button" data-skill-open="${attr(name)}" title="点开${readOnly ? "查看" : "编辑"}">
      <span class="sk-item-head">
        <span class="sk-item-name">${esc(name)}</span>
        ${adviceTag}
      </span>
      <span class="sk-item-summary" title="${attr(summaryText)}">${esc(summaryText)}</span>
    </button>
    <div class="sk-item-foot">
      <span class="sk-item-meta" title="${attr(metaTip)}">${metaHtml}</span>
      <span class="sk-item-actions">
        ${switchMarkup(item.enabled === true, { label: `开关 ${name}`, attrs: `data-skill-switch="${attr(name)}"` })}
        ${
          readOnly
            ? ""
            : `<button class="sk-del" type="button" data-skill-delete="${attr(name)}" title="删除 ${attr(name)}" aria-label="删除 ${attr(name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>`
        }
      </span>
    </div>`;
  card
    .querySelector("[data-skill-open]")
    ?.addEventListener("click", () => void openEditSkillModal(name, item));
  const sw = card.querySelector("[data-skill-switch]");
  if (sw) {
    sw.addEventListener("click", () => {
      void toggleSkillEnabled(name, sw.getAttribute("aria-checked") !== "true", sw);
    });
  }
  const remove = card.querySelector("[data-skill-delete]");
  if (remove) remove.addEventListener("click", () => openDeleteSkillModal(name));
  return card;
}

/** 列表主体：筛选 → 分「已开启 / 未开启」两区 → 各自排序 → 卡片墙 */
function renderSkillList(box, items) {
  if (!box) return;
  box.replaceChildren();
  if (!items.length) {
    renderSkillControls(items);
    const empty = document.createElement("div");
    empty.className = "card sk-empty";
    empty.innerHTML = `<p class="set-hint">还没有技能。点右上「新建技能」写一份手册；也可以把现成的 .md 放进技能目录（第 1 行是摘要）。</p>`;
    box.append(empty);
    return;
  }
  renderSkillControls(items);
  const view = skillAdvice.view;
  const filtered =
    view && skillAdvice.filter !== "all"
      ? items.filter((item) => {
          const entry = view.items?.[item.name];
          return skillAdvice.filter === "none" ? !entry : entry?.bucket === skillAdvice.filter;
        })
      : items;
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "card sk-empty";
    empty.innerHTML = `<p class="set-hint">这个分类下没有技能。</p>`;
    box.append(empty);
    return;
  }
  const groups = [
    ["已开启", sortSkillItems(filtered.filter((item) => item.enabled === true))],
    ["未开启", sortSkillItems(filtered.filter((item) => item.enabled !== true))],
  ];
  for (const [label, group] of groups) {
    if (!group.length) continue;
    const section = document.createElement("section");
    section.className = "sk-section";
    section.innerHTML = `<div class="sk-section-head"><span class="sk-section-title">${label}</span><span class="sk-section-count">${group.length}</span></div><div class="sk-grid"></div>`;
    const grid = section.querySelector(".sk-grid");
    for (const item of group) grid.append(buildSkillCard(item, view));
    box.append(section);
  }
}

/** 读一条技能正文；失败返回 null（已经 toast 过，调用方直接收工）。
 *  2026-11-13 起把 form / origin / writable 一并带回来：弹窗按形态分两种渲染（见下）。 */
async function readSkill(name) {
  try {
    const response = await request(`/api/v1/agent/skills/${encodeURIComponent(name)}`, {
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || `读不到技能：HTTP ${response.status}`);
      return null;
    }
    return {
      content: String(data.content ?? ""),
      form: data.form === "dir" ? "dir" : "flat",
      origin: String(data.origin || ""),
      writable: data.writable === true,
    };
  } catch (error) {
    if (error.message !== "forbidden") toast(`读不到技能：${error.message}`);
    return null;
  }
}

/** 首行摘要 / 其余正文：与 skills.ts 的收录口径同一刀（只认第一个换行）。
 *  正文原样保留（包括开头的空行），保存拼回去不改用户排版。 */
function splitSkillContent(content) {
  const text = String(content ?? "");
  const at = text.indexOf("\n");
  if (at < 0) return { summary: text.trim(), body: "" };
  return { summary: text.slice(0, at).replace(/\r$/, "").trim(), body: text.slice(at + 1) };
}

/** 摘要输入框里的换行一律压成空格：摘要只占索引一行，粘进来的多行不能把正文顶乱 */
function summaryInputValue(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

/**
 * 技能详情弹窗（2026-11-13 用户口径：摘要单独一栏，不再混在正文里）。
 * 只有**扁平 + 不是 .agents 只读目录**的技能能在这里改（写侧本来也只写扁平 `<名>.md`）：
 *   - 目录形态 `<名>/SKILL.md`：只读查看，摘要取列表里的 frontmatter description；
 *   - `.agents`：别的工具的家，写了也 400，直接只读；
 *   - 内置手册（app 目录）：允许改，保存会在用户技能目录建一份同名副本（9-S 合并语义）。
 */

export { buildSkillCard, closeSkillSelects, readSkill, renderSkillControls, renderSkillList, renderSkillSelect, skillFilterCounts, sortSkillItems, splitSkillContent, summaryInputValue };
