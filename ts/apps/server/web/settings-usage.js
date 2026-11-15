/**
 * 用量页
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { fetchModelCatalog, updateModelPill } from "./hover-tip.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { loadProviders } from "./providers.js";
import { loadSearchSources } from "./search-sources.js";
import { mountSegmented, syncSegmented } from "./settings-atoms.js";
import { renderDefaultModelRow } from "./settings-reminders.js";
import { state } from "./state.js";


/* ── 用量页（2026-11-13 从服务页拆出）────────────────────────────
 * 一张接口、三个视角：累计（总量 + 四项拆解）、按模型（占比条 + 图例）、明细（原始 key 的表）。
 * 2026-11-15 加区间：近 7 天 / 近 30 天 / 全部。全部走 durable 的 pi.usage 累计；
 * 两个近程区间由每条回复自带的 timestamp + usage 还原（服务端 usage-range.ts），
 * 所以"删掉会话，那部分用量也会消失"这条口径对三档都成立。
 * 不折算金额（服务端 cost 固定 0）；逐日日柱没画（三个数字能答的问题，不必再上一张图）。 */
const USE_BAR_SLOTS = 4; // 占比条最多画 4 段，剩下的并成「其他」

const USE_RANGE_KEY = "lifediary.usage.range";
const USE_RANGES = ["7d", "30d", "all"];
const USE_RANGE_LABEL = { "7d": "近 7 天", "30d": "近 30 天", all: "全部" };
/** 两档默认最近 7 天：进页面先看"最近花了多少"，要历史总量再点「全部」。 */
const USE_RANGE_DEFAULT = "7d";

function readUsageRange() {
  try {
    const raw = localStorage.getItem(USE_RANGE_KEY);
    return USE_RANGES.includes(raw) ? raw : USE_RANGE_DEFAULT;
  } catch {
    return USE_RANGE_DEFAULT;
  }
}

function writeUsageRange(range) {
  try {
    localStorage.setItem(USE_RANGE_KEY, range);
  } catch {
    // 存不了就只影响下次进页的默认档，不影响当前这次
  }
}

/** 把 aria-checked 与滑行胶囊同步到指定档（DOM 重建后也要能一次对上） */
function syncUsageRange(root, range) {
  if (!root) return;
  for (const button of root.querySelectorAll("button[data-range]")) {
    button.setAttribute("aria-checked", String(button.dataset.range === range));
  }
  syncSegmented(root);
}

/** 区间控件只在第一次挂监听；页面每次重建 DOM 都会得到一份新的 #use-range */
function bindUsageRange() {
  const root = document.getElementById("use-range");
  if (!root) return;
  const range = readUsageRange();
  syncUsageRange(root, range);
  if (root.dataset.rangeBound === "1") return;
  root.dataset.rangeBound = "1";
  mountSegmented(root);
  document.getElementById("use-refresh")?.addEventListener("click", () => void loadUsagePage());
  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-range]") : null;
    if (!button || !root.contains(button)) return;
    const next = button.dataset.range;
    if (!USE_RANGES.includes(next) || next === readUsageRange()) return;
    writeUsageRange(next);
    syncUsageRange(root, next);
    void loadUsagePage();
  });
}

/** 区间起点/终点文案：MM-DD（本地）；终点 = 起点 + days - 1 个自然日 */
function fmtUsageDay(at) {
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function fmtUsageWindowEnd(since, days) {
  const date = new Date(since);
  date.setDate(date.getDate() + Math.max(0, days - 1));
  return fmtUsageDay(date.getTime());
}

function usageRangeFoot(range, data) {
  if (range === "all") {
    return "来源：本机用量账本（pi.usage），按模型累计，不折算金额。";
  }
  const days = range === "7d" ? 7 : 30;
  const span = data.since
    ? `${fmtUsageDay(data.since)} 至 ${fmtUsageWindowEnd(data.since, days)}`
    : `近 ${days} 天`;
  return `${USE_RANGE_LABEL[range]} · ${span} · ${data.activeDays ?? 0} 天有用量。来源：每条回复自带的用量记录，按完成时间归日；删掉会话，那部分用量也会跟着消失。`;
}

function fmtTokens(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

/** 占比文案：真 0 显示 0%，非 0 但不到 0.1% 显示 <0.1%——别让大户旁边排出一串 0.0% */
function fmtShare(part, whole) {
  if (!whole || !part) return "0%";
  const pct = (part / whole) * 100;
  return pct < 0.1 ? "<0.1%" : `${pct.toFixed(1)}%`;
}

/** 缓存命中率口径：缓存读 ÷（输入 + 缓存读 + 缓存写）。没有分母返回 null，不冒充 0% */
function cacheHitRate(input, cacheRead, cacheWrite) {
  const base = Number(input || 0) + Number(cacheRead || 0) + Number(cacheWrite || 0);
  if (!base) return null;
  return Number(cacheRead || 0) / base;
}

/** 模型 key（`provider/model#think-off`）拆成三段：族（去变体）、provider、变体 */
function splitModelKey(key) {
  const raw = String(key || "");
  const hash = raw.indexOf("#");
  const base = hash === -1 ? raw : raw.slice(0, hash);
  const variant = hash === -1 ? "" : raw.slice(hash);
  const slash = base.lastIndexOf("/");
  return {
    raw,
    base,
    variant,
    provider: slash === -1 ? "" : base.slice(0, slash),
    name: slash === -1 ? base : base.slice(slash + 1),
  };
}

function isMockModel(base) {
  return /^faux(\/|$)/.test(String(base || ""));
}

/** 同一模型的 think 档位并成一行（明细表仍按原始 key 列）；按 total 倒序 */
function groupUsageFamilies(models) {
  const families = new Map();
  for (const item of models) {
    const parts = splitModelKey(item.model);
    const family = families.get(parts.base) || {
      base: parts.base,
      provider: parts.provider,
      name: parts.name,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      variants: 0,
      mock: isMockModel(parts.base),
    };
    family.input += item.inputTokens || 0;
    family.output += item.outputTokens || 0;
    family.cacheRead += item.cacheReadTokens || 0;
    family.cacheWrite += item.cacheWriteTokens || 0;
    family.total += item.totalTokens || 0;
    family.variants += 1;
    families.set(parts.base, family);
  }
  return [...families.values()].sort((a, b) => b.total - a.total);
}

/** 名次色阶：第一名走主题色，其余是 text 与卡片底混出的灰阶。
 *  不引第二套调色板——换主题色整页跟着走，也不跟 --c-secondary / --c-tertiary 打架。 */
function usageSlotColor(index) {
  if (index === 0) return "var(--accent)";
  const stop = [58, 34, 18][index - 1] ?? 6;
  return `color-mix(in srgb, var(--text) ${stop}%, var(--card))`;
}

function usageEmptyMarkup(title, hint) {
  return `<div class="use-empty"><div class="use-empty-title">${title}</div><div class="use-empty-hint">${hint}</div></div>`;
}

/** 一份 `{models, range, since, activeDays}` → 三张卡。都写进现成的 id 容器，刷新只重画内容、不重排页面。 */
function renderUsagePage(data) {
  const hero = document.getElementById("use-hero");
  const modelsHost = document.getElementById("use-models");
  const detail = document.getElementById("use-detail");
  if (!hero || !modelsHost || !detail) return;

  // 兼容旧形态：早期调用只传 models[]；区间信息缺失时按「全部」
  const models = Array.isArray(data) ? data : data?.models || [];
  const range = !Array.isArray(data) && USE_RANGES.includes(data?.range) ? data.range : "all";

  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const item of models) {
    sum.input += item.inputTokens || 0;
    sum.output += item.outputTokens || 0;
    sum.cacheRead += item.cacheReadTokens || 0;
    sum.cacheWrite += item.cacheWriteTokens || 0;
    sum.total += item.totalTokens || 0;
  }
  if (!sum.total) {
    const empty =
      range === "all"
        ? usageEmptyMarkup("还没有用量", "跑一次对话，这里就会出现累计和按模型的数字。")
        : usageEmptyMarkup(
            "这段时间没有用量",
            `${USE_RANGE_LABEL[range]}没有记录；切到「全部」可以看到历史累计。`,
          );
    hero.innerHTML = empty;
    modelsHost.innerHTML = empty;
    detail.innerHTML = empty;
    return;
  }

  const families = groupUsageFamilies(models);
  const familyIndex = new Map(families.map((family, index) => [family.base, index]));
  const rate = cacheHitRate(sum.input, sum.cacheRead, sum.cacheWrite);
  const hasMock = families.some((family) => family.mock);
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 0;
  const totalTip =
    range === "all"
      ? "账记在会话上：删掉一个会话，它的用量也会从累计里消失。"
      : `只算近 ${days} 个自然日（含今天）内完成的回复；删掉会话，那部分用量也会跟着消失。`;

  const cell = (label, value, tip) => `<div class="use-cell"${tip ? ` data-tip="${attr(tip)}"` : ""}>
      <div class="use-cell-v">${value}</div>
      <div class="use-cell-k">${label}</div>
    </div>`;
  hero.innerHTML = `
    <div class="use-total" data-tip="${attr(totalTip)}"><span class="use-total-v">${fmtTokens(sum.total)}</span><span class="use-total-unit">tokens</span><span class="use-count">${families.length} 个模型 · ${models.length} 个档位</span></div>
    <div class="use-cells">
      ${cell("输入", fmtTokens(sum.input))}
      ${cell("输出", fmtTokens(sum.output))}
      ${cell("缓存读", fmtTokens(sum.cacheRead))}
      ${cell("缓存写", fmtTokens(sum.cacheWrite))}
      ${cell("缓存命中", rate === null ? "—" : `${(rate * 100).toFixed(1)}%`, "缓存读 ÷（输入 + 缓存读 + 缓存写）")}
    </div>
    <div class="use-foot">${usageRangeFoot(range, Array.isArray(data) ? {} : data || {})}${
      hasMock ? " faux 是模拟模型（没配真上游时的假回答），那部分不是真实消耗。" : ""
    }</div>`;

  // 占比条：前 4 名各占一段，长尾并成「其他」——条太碎就不成图了。
  const slots = families.slice(0, USE_BAR_SLOTS);
  const rest = families.slice(USE_BAR_SLOTS);
  const restTotal = rest.reduce((total, family) => total + family.total, 0);
  const segments = slots.map((family, index) => ({
    name: family.name,
    provider: family.provider,
    variants: family.variants,
    total: family.total,
    mock: family.mock,
    color: usageSlotColor(index),
  }));
  if (restTotal) {
    segments.push({
      name: `其他 ${rest.length} 个模型`,
      provider: "",
      variants: rest.reduce((count, family) => count + family.variants, 0),
      total: restTotal,
      mock: false,
      color: usageSlotColor(USE_BAR_SLOTS),
    });
  }
  const barSegments = segments
    .map((segment, index) => {
      const pct = (segment.total / sum.total) * 100;
      return `<span class="use-bar-seg" data-seg="${index}" style="flex:0 0 ${pct.toFixed(3)}%;background:${segment.color};animation-delay:${index * 60}ms" title="${attr(`${segment.name} · ${fmtTokens(segment.total)} tokens`)}"></span>`;
    })
    .join("");
  const legendRows = segments
    .map(
      (segment, index) => `<div class="use-row" data-seg="${index}">
        <span class="use-dot" style="background:${segment.color}"></span>
        <span class="use-row-main">
          <span class="use-row-name">${esc(segment.name)}${segment.mock ? '<span class="use-tag is-mock">模拟</span>' : ""}</span>
          <span class="use-row-sub">${esc(segment.provider || "本机")}${segment.variants ? ` · ${segment.variants} 个档位` : ""}</span>
        </span>
        <span class="use-row-num">${fmtTokens(segment.total)}</span>
        <span class="use-row-pct">${fmtShare(segment.total, sum.total)}</span>
      </div>`,
    )
    .join("");
  modelsHost.innerHTML = `
    <div class="use-bar" role="img" aria-label="按模型占比">${barSegments}</div>
    <div class="use-legend">${legendRows}</div>
    <div class="use-foot">${
      range === "all" ? "" : `${USE_RANGE_LABEL[range]} · `
    }同一模型的 think 档位并成一行；分档看下面的明细。</div>`;
  // 悬停图例行 → 压暗其它段，看清这一行在条上占多宽（指针离开就恢复）
  const bar = modelsHost.querySelector(".use-bar");
  modelsHost.querySelectorAll(".use-row").forEach((row) => {
    row.addEventListener("pointerenter", () => bar?.setAttribute("data-hl", row.dataset.seg || "0"));
    row.addEventListener("pointerleave", () => bar?.removeAttribute("data-hl"));
  });

  const sorted = [...models].sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
  const tableRows = sorted
    .map((item) => {
      const parts = splitModelKey(item.model);
      const familyIdx = familyIndex.get(parts.base) ?? USE_BAR_SLOTS;
      const color = usageSlotColor(familyIdx < USE_BAR_SLOTS ? familyIdx : USE_BAR_SLOTS);
      const itemTotal = item.totalTokens || 0;
      const itemRate = cacheHitRate(item.inputTokens, item.cacheReadTokens, item.cacheWriteTokens);
      const share = itemTotal / sum.total;
      return `<tr>
        <td class="model">
          <div class="use-model-line">
            <span class="use-mono">${esc(parts.base || "未知模型")}</span>
            ${parts.variant ? `<span class="use-tag">${esc(parts.variant)}</span>` : ""}
            ${isMockModel(parts.base) ? '<span class="use-tag is-mock">模拟</span>' : ""}
          </div>

        </td>
        <td class="num">${fmtTokens(item.inputTokens)}</td>
        <td class="num">${fmtTokens(item.outputTokens)}</td>
        <td class="num">${fmtTokens(item.cacheReadTokens)}</td>
        <td class="num">${fmtTokens(item.cacheWriteTokens)}</td>
        <td class="num is-strong">${fmtTokens(itemTotal)}</td>
        <td class="num share"><span class="use-share-bar" style="width:${Math.max(2, share * 46).toFixed(1)}px;background:${color}"></span>${fmtShare(itemTotal, sum.total)}</td>
        <td class="num is-muted">${itemRate === null ? "—" : `${(itemRate * 100).toFixed(1)}%`}</td>
      </tr>`;
    })
    .join("");
  detail.innerHTML = `
    <div class="use-table-wrap">
      <table class="use-table">
        <thead><tr>
          <th scope="col">模型</th>
          <th scope="col" class="num">输入</th>
          <th scope="col" class="num">输出</th>
          <th scope="col" class="num">缓存读</th>
          <th scope="col" class="num">缓存写</th>
          <th scope="col" class="num">合计</th>
          <th scope="col" class="num">占比</th>
          <th scope="col" class="num">缓存命中</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="use-foot">${
      range === "all" ? "" : `${USE_RANGE_LABEL[range]} · `
    }共 ${sorted.length} 个模型档位；缓存命中率按每一档单独算，不是整表平均。</div>`;
}

/** 连点区间时只让最后一次响应落地（后发的请求可能先回来） */
let usageLoadSeq = 0;

async function loadUsagePage() {
  const hero = document.getElementById("use-hero");
  const modelsHost = document.getElementById("use-models");
  const detail = document.getElementById("use-detail");
  if (!hero || !modelsHost || !detail) return;
  bindUsageRange();
  const range = readUsageRange();
  const seq = ++usageLoadSeq;
  const loading = `<div class="use-loading">读取中…</div>`;
  hero.innerHTML = loading;
  modelsHost.innerHTML = loading;
  detail.innerHTML = loading;
  let data;
  try {
    const response = await request(
      `/api/v1/agent/usage${range === "all" ? "" : `?range=${range}`}`,
      { cache: "no-store" },
    );
    data = await response.json();
  } catch {
    if (seq !== usageLoadSeq) return;
    hero.innerHTML = usageEmptyMarkup("读取失败", "服务端没回用量；稍后再点右上角「刷新」。");
    modelsHost.innerHTML = `<div class="use-loading">—</div>`;
    detail.innerHTML = `<div class="use-loading">—</div>`;
    return;
  }
  if (seq !== usageLoadSeq) return;
  renderUsagePage(data);
}

/** 模型页读数（2026-11-09 从服务页拆出）：默认模型行 + 供应商双栏。 */
async function loadModelsInfo() {
  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  try {
    const catalog = await fetchModelCatalog();
    state.modelCatalog = catalog;
    renderDefaultModelRow(catalog);
    updateModelPill();
  } catch {
    set("mdl-current", "读取失败");
    const hint = document.getElementById("mdl-hint");
    if (hint) hint.textContent = "";
  }
  await loadProviders();
  void loadSearchSources();
}

export { USE_BAR_SLOTS, cacheHitRate, fmtShare, fmtTokens, groupUsageFamilies, isMockModel, loadModelsInfo, loadUsagePage, renderUsagePage, splitModelKey, usageEmptyMarkup, usageSlotColor };
