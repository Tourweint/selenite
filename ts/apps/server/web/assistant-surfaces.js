/**
 * 注入 → 人设 · 顶部「助手的人设与工具」卡（2026-11-22）
 *
 * 设计：docs/设计方案/2026-11-22-注入页助手总览与普通助手可调面.md（§二.3、§四）。
 * 只做展示 + 已有可调项的入口：读 GET /api/v1/agent/assistant-surfaces，
 * 按服务端给的顺序（总管 → 活跃执事 → 普通助手 → 派活工人）渲染紧凑行。
 *
 * 三条硬约束：
 * 1. **读不到就不显示**：404 / 非 200 / 空数组一律把卡 hidden，静默返回——旧版本服务端
 *    没有这个端点，卡片不能挡原来的总管与执事列表，也不该弹错。
 * 2. **服务端字符串只经 esc()/attr() 落地**：label / preview / 工具名 / 可调项 / 固定段
 *    全是服务端来的文本，一律转义后再进 HTML，绝不裸拼。
 * 3. **动作只照 hash 走**：人设 / 工具 / 模型 / 上下文四个入口由服务端下发的站内 hash
 *    决定，有点才画；点击就是 location.hash = hash，前端不自己拼路由。
 */

import { attr, esc } from "./markdown.js";
import { request } from "./net.js";

/** 卡的宿主 id（放在 设置 → 注入 → 人设 tab 顶部）。 */
const SURFACES_ID = "assistant-surfaces";
const SURFACES_ENDPOINT = "/api/v1/agent/assistant-surfaces";

/** kind → 小徽标文案；不认识的 kind 原样显示（转义后）。 */
const KIND_LABEL = {
  chief: "总管",
  partner: "执事",
  worker: "普通助手",
  dispatch: "派活工人",
};

/** 工具 chips 一行最多摆几枚，其余收进 +N。 */
const TOOL_CHIP_MAX = 8;
/** 「可调」最多列几项，其余收进 +N。 */
const ADJUSTABLE_MAX = 4;
/** 人设预览超过这么多字就截断省略（服务端本来就限 160 字，这里只兜版面）。 */
const PREVIEW_MAX = 80;
/** 人设预览为空时的兜底文案：派活工人与普通助手共用同一份人设正文。 */
const PERSONA_SHARED_TEXT = "人设与普通助手共用";

/** 四个动作：只有服务端给了对应 hash 才画。
 *  人设 / 工具的 hash 嵌在 persona、tools 里，模型 / 上下文是条目上的独立字段。 */
const ACTIONS = [
  { label: "改人设", hashOf: (surface) => surface.persona && surface.persona.hash },
  { label: "调工具", hashOf: (surface) => surface.tools && surface.tools.hash },
  { label: "模型", hashOf: (surface) => surface.modelHash },
  { label: "看上下文", hashOf: (surface) => surface.contextHash },
];

const str = (value) => String(value ?? "");

/** 站内 hash 才认（防服务端误给绝对地址或别的 scheme）。 */
function siteHash(value) {
  const hash = str(value).trim();
  return hash.startsWith("#/") ? hash : "";
}

/** 预览截断：超长收尾加省略号，原文留在 title 里（悬停看全）。 */
function previewOf(persona) {
  const raw = str(persona && persona.preview).trim();
  if (!raw) return { text: PERSONA_SHARED_TEXT, full: PERSONA_SHARED_TEXT, cut: false };
  if (raw.length <= PREVIEW_MAX) return { text: raw, full: raw, cut: false };
  return { text: `${raw.slice(0, PREVIEW_MAX).trimEnd()}…`, full: raw, cut: true };
}

/** 人设那一行（含字数与编辑开关）。没有 persona 对象就整行不出。 */
function personaHtml(surface) {
  const persona = surface.persona;
  if (!persona || typeof persona !== "object") return "";
  const { text, full, cut } = previewOf(persona);
  const chars = Number(persona.chars);
  const count = Number.isFinite(chars) && chars > 0 ? `<span class="as-chars">${chars} 字</span>` : "";
  return `<p class="as-persona"${cut || text !== full ? ` title="${attr(full)}"` : ""}>${esc(text)}${count}</p>`;
}

/** 工具 chips：前 8 枚 + 「+N」；note 挂在这一行的 title 上。 */
function toolsHtml(surface) {
  const tools = surface.tools;
  if (!tools || typeof tools !== "object") return "";
  const names = Array.isArray(tools.names)
    ? tools.names.map((name) => str(name).trim()).filter(Boolean)
    : [];
  if (!names.length && !Number(tools.count)) return "";
  const total = Number.isFinite(Number(tools.count)) ? Number(tools.count) : names.length;
  const shown = names.slice(0, TOOL_CHIP_MAX);
  const rest = Math.max(0, total - shown.length);
  const chips = shown.map((name) => `<span class="as-chip">${esc(name)}</span>`);
  if (rest > 0) chips.push(`<span class="as-chip as-more" title="${attr(`另有 ${rest} 件`)}">+${rest}</span>`);
  const note = str(tools.note).trim();
  return `<div class="as-tools"${note ? ` title="${attr(note)}"` : ""}>${chips.join("")}</div>`;
}

/** 「可调」：最多 4 项 + 「+N」。 */
function adjustableHtml(surface) {
  const list = Array.isArray(surface.adjustable)
    ? surface.adjustable.map((item) => str(item).trim()).filter(Boolean)
    : [];
  if (!list.length) return "";
  const shown = list.slice(0, ADJUSTABLE_MAX);
  const rest = list.length - shown.length;
  const items = shown.map((item) => `<span class="as-chip as-adjust">${esc(item)}</span>`);
  if (rest > 0) items.push(`<span class="as-chip as-more" title="${attr(list.join(" / "))}">+${rest}</span>`);
  return `<div class="as-adjustable"><span class="as-tag-label">可调</span>${items.join("")}</div>`;
}

/** 「固定 N 项」：只报数，全部项目挂在 title 里。 */
function fixedHtml(surface) {
  const list = Array.isArray(surface.fixed)
    ? surface.fixed.map((item) => str(item).trim()).filter(Boolean)
    : [];
  if (!list.length) return "";
  return `<span class="as-chip as-fixed" title="${attr(list.join(" / "))}">固定 ${list.length} 项</span>`;
}

/** 动作按钮：只有 hash 存在（且是站内 hash）才画。 */
function actionsOf(surface) {
  const out = [];
  for (const action of ACTIONS) {
    const hash = siteHash(action.hashOf(surface));
    if (hash) out.push({ hash, label: action.label });
  }
  return out;
}

function actionsHtml(actions) {
  if (!actions.length) return "";
  const buttons = actions.map(
    (action) => `<button class="ghost as-act" type="button" data-hash="${attr(action.hash)}">${esc(action.label)}</button>`,
  );
  return `<div class="as-acts">${buttons.join("")}</div>`;
}

/** 一档助手：label + kind 徽标 / 人设预览 / 工具 chips / 可调 · 固定 / 动作。 */
function surfaceRow(surface) {
  const label = str(surface.label).trim() || str(surface.id).trim();
  const kind = str(surface.kind).trim();
  const kindLabel = KIND_LABEL[kind] || kind;
  const kindKey = /^[a-z-]+$/.test(kind) ? kind : "other";
  const badge = kindLabel ? `<span class="pill-tag as-kind as-kind-${kindKey}">${esc(kindLabel)}</span>` : "";
  const tags = `${adjustableHtml(surface)}${fixedHtml(surface)}`;
  const actions = actionsOf(surface);
  const row = document.createElement("article");
  row.className = "as-row";
  row.dataset.kind = kindKey;
  row.innerHTML = `
    <div class="as-head">
      <span class="as-label">${esc(label)}</span>
      ${badge}
    </div>
    ${personaHtml(surface)}
    ${toolsHtml(surface)}
    ${tags ? `<div class="as-tags">${tags}</div>` : ""}
    ${actionsHtml(actions)}
  `;
  for (const button of row.querySelectorAll(".as-act")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const hash = siteHash(button.dataset.hash);
      // 服务端只给站内 hash；不给就什么都不做，别把地址栏写坏。
      if (hash) location.hash = hash;
    });
  }
  return row;
}

/** 读不到（404 / 非 200 / 空 / 出错）就藏起来：一行不显示，也不报错。 */
function hideCard(card) {
  card.hidden = true;
  card.replaceChildren();
}

/**
 * 拉一次汇总端点并渲染卡片。
 *
 * @param {HTMLElement} [host] 宿主节点，缺省按 id `#assistant-surfaces` 找。
 * @returns {Promise<boolean>} 渲染成功 true；藏起来（含任何失败）false。不抛错、不 toast。
 */
async function renderAssistantSurfaces(host = null) {
  const card = host || document.getElementById(SURFACES_ID);
  if (!card) return false;
  let data = null;
  try {
    const response = await request(SURFACES_ENDPOINT, { cache: "no-store" });
    if (!response || !response.ok) {
      hideCard(card);
      return false;
    }
    data = await response.json();
  } catch {
    hideCard(card);
    return false;
  }
  if (!data || data.ok === false) {
    hideCard(card);
    return false;
  }
  const surfaces = (Array.isArray(data.surfaces) ? data.surfaces : []).filter(
    (surface) => surface && typeof surface === "object" && (str(surface.label).trim() || str(surface.id).trim()),
  );
  if (!surfaces.length) {
    hideCard(card);
    return false;
  }
  card.replaceChildren(...surfaces.map(surfaceRow));
  card.hidden = false;
  return true;
}

export { renderAssistantSurfaces };
