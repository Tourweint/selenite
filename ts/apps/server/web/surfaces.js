/**
 * 界面显隐注册表（2026-11-25，第一批 4 个已确认的缺口）
 *
 * 一句话：**哪个界面元素跟着哪个开关走，写在一张表里**，不再散在各页各写一遍 if。
 * 表里每行 = { id, selector, requires, mode }：
 *   - requires 全部「开」才显示；任一关 → 按 mode 收起来。
 *   - mode="hide"    → node.hidden = true（走 [hidden] 的 display:none，不写 style，不摘 DOM）
 *   - mode="disable" → disabled=true + aria-disabled="true"（留着可见，但点不动）
 *   - mode="empty"   → 容器留着（不 hidden），原内容存 WeakMap，换成空态（标题 / 正文 / 去插件中心）
 *                      深链进来不能白屏：哪怕整块不可用，也得看见「为什么空、去哪开」。
 *
 * 口径（与 flags.ts 的 offValueOf 同源）：每行可以自带 offValue（如 AGENT_TOOL_POLICY 的关值是 "full"），
 * 给了就按这个值判关，没给才退回 false / 0 / off。**读不到按「开」**——
 * 一次网络抖动 / 没令牌不该把界面藏没，藏错了用户根本找不到东西，也没法自己去开回来。
 *
 * 总闸：PLUGIN_SURFACE_HIDE=false 时整张表停用（三个调用点统一停），不再一处一处摘。
 *
 * 防呆：PINNED 里的 selector 是「回去的路」（侧栏轨道 / 设置导航 / 返回按钮 / 会话区），
 * 任何 mode="hide" 的条目想藏它们都会被跳过并 console.warn 一次。
 *
 * 静态 DOM 由本表兜底；渲染期才知道的列（如工具页用量列）拿 flagOn() 自己判，注册表抓不到动态产物。
 */

import { request } from "./net.js";
import { state } from "./state.js";

/** 一个界面元素跟哪些开关走。requires 是 env key（与 GET /api/v1/agent/flags 的 key 同名）。 */
export const SURFACES = [
  { id: "sidebar.rail.partners", selector: "#rail-partners", requires: ["COMPANIONS_ENABLED"], mode: "hide" },
  { id: "sidebar.sec.partners", selector: "#sec-partners", requires: ["COMPANIONS_ENABLED"], mode: "hide" },
  { id: "settings.skills.advice", selector: "#skill-advice-run", requires: ["SKILL_ADVICE"], mode: "hide" },
  { id: "settings.chats.export", selector: "#settings-export-all", requires: ["EXPORT_BUNDLE"], mode: "hide" },
  { id: "settings.nav.agent", selector: "#settings-tab-agent", requires: ["CHANCELLOR_ENABLED"], mode: "hide" },
  { id: "settings.nav.reminders", selector: "#settings-tab-reminders", requires: ["AUTONOMY_ENABLED"], mode: "hide" },

  // 第二批（2026-11-25）：设置页里「插件关了还在」的入口。
  // 注入页的 tab 按钮由 settings-base.js 的 injectTabsMarkup() 现画（data-inject-tab=<id>），
  // 只在那个 tab 条存在时才抓得到；选择器用 data 属性，不依赖文案。
  { id: "inject.tab.personas", selector: '[data-inject-tab="personas"]', requires: ["COMPANIONS_ENABLED"], mode: "hide" },
  { id: "inject.tab.memory", selector: '[data-inject-tab="memory"]', requires: ["MEMORY_ENABLED"], mode: "hide" },
  { id: "inject.tab.skills", selector: '[data-inject-tab="skills"]', requires: ["SKILLS_ADMIN"], mode: "hide" },
  { id: "inject.tab.context", selector: '[data-inject-tab="context"]', requires: ["CHAT_CONTEXT_INSPECT"], mode: "hide" },
  { id: "inject.tab.about-me", selector: '[data-inject-tab="about-me"]', requires: ["USER_PROFILE_ENABLED"], mode: "hide" },

  // 项目页「添加项目」：CURRENT_PROJECT 关着时留着可见但点不动（没了工作区就无处落项目）。
  { id: "settings.projects.add", selector: "#project-add", requires: ["CURRENT_PROJECT"], mode: "disable" },

  // 派活页每行的「检测」按钮（class 由 settings-executor.js 渲染时挂，见 data-probe 那一行）。
  { id: "settings.executor.probe", selector: ".executor-probe-btn", requires: ["EXECUTOR_PROBE"], mode: "hide" },
];

/**
 * 不许被 mode="hide" 藏掉的返回路径：#settings-tab-plugins 是插件页渲染时动态生成的标签，
 * 静态表里现在没有它，但未来加条目前先把它钉住。
 */
const PINNED = new Set([
  "#rail-settings",
  "#close-settings",
  "#settings-nav",
  "#settings-inner",
  "#chief-entry",
  "#rail-chief",
  "#sec-chats",
  "#map-back",
  "#search-back",
  "#settings-tab-plugins",
]);

/** 关档的取值口径：服务端 flags.ts 的 flagIsOff 只认这三个字面值（布尔 / 旧清单兜底）。 */
const OFF_VALUES = new Set(["false", "0", "off"]);

function isOffValue(value) {
  return OFF_VALUES.has(String(value ?? "").trim().toLowerCase());
}

/** 行上自带 offValue 才算「按档位判关」；空串 / 缺键都不算。 */
function offValueOf(row) {
  const explicit = String(row?.offValue ?? "").trim();
  return explicit ? explicit : null;
}

/**
 * 这个开关是不是「开」。
 * 读 effectiveValue ?? value（总闸关着时 effectiveValue 是关，自己存的值不作数）。
 * 行上带 offValue（多档插件的关 = 某个既有档，如 AGENT_TOOL_POLICY 的 "full"）就按它判；
 * 没有 offValue 才退回 false / 0 / off。
 * 缓存里没有这一行（还没拉到 / 拉失败 / 服务端没这个键）→ true：读不到不隐藏。
 */
export function flagOn(key) {
  const row = state.flagsCache instanceof Map ? state.flagsCache.get(key) : null;
  if (!row) return true;
  const raw = row.effectiveValue ?? row.value;
  const off = offValueOf(row);
  if (off) return String(raw ?? "").trim().toLowerCase() !== off.toLowerCase();
  return !isOffValue(raw);
}

/** 总闸（PLUGIN_SURFACE_HIDE）：false 时整张表停用，applySurfaces 直接返回。 */
let surfacesEnabled = true;

/** 外部（loadSurfaceFlags）只在这一处改总闸；undefined / 缺字段都按「开」。 */
export function setSurfacesEnabled(value) {
  surfacesEnabled = value !== false;
}

/** 同一份 flags 只拉一次：并发调用合流，成功后不再重复打端点（失败留给下一次重试）。 */
let flagsInflight = null;
let flagsLoaded = false;

/** 读总闸：GET /api/v1/agent/policy 的 pluginSurfaces，拉失败 / 没这个字段都按「开」。 */
async function readSurfacesEnabled() {
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    if (!response.ok) return true;
    const data = await response.json().catch(() => null);
    return data?.pluginSurfaces !== false;
  } catch {
    return true;
  }
}

/**
 * 把 GET /api/v1/agent/flags 装进 state.flagsCache（形状与 settings-switches.js 的 renderFlagRows 相同：
 * Map(key → flag 行)）。缓存已有内容就直接用，不再发请求。
 * 同一次里并行读总闸 /agent/policy：三个调用点都走这里，所以一处关就全关。
 * 失败时**不写空 Map**：保持原样（null → flagOn 全按开），下一次 refresh 再试一次。
 */
export async function loadSurfaceFlags() {
  if (state.flagsCache instanceof Map && state.flagsCache.size) return state.flagsCache;
  if (flagsLoaded) return state.flagsCache;
  if (flagsInflight) return flagsInflight;
  flagsInflight = (async () => {
    try {
      const [response, gate] = await Promise.all([
        request("/api/v1/agent/flags", { cache: "no-store" }),
        readSurfacesEnabled(),
      ]);
      setSurfacesEnabled(gate);
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json().catch(() => ({}));
      const flags = Array.isArray(data.flags) ? data.flags : [];
      state.flagsCache = new Map(
        flags.filter((flag) => flag && typeof flag.key === "string").map((flag) => [flag.key, flag]),
      );
      // 服务端整份关掉（AGENT_FLAGS_UI=false，列表为空）也算「读到了」：
      // 之后所有键都按开处理（回滚态就是全显示），不再每次渲染都打一次端点。
      flagsLoaded = true;
    } catch {
      // 断网 / 403 / 端点不存在：读不到按开，界面保持原样
    } finally {
      flagsInflight = null;
    }
    return state.flagsCache;
  })();
  return flagsInflight;
}

/* ── empty 模式 ───────────────────────────────────────── */

/** node → 被替换前的 innerHTML。WeakMap 不拦 GC，也不会因为节点重建而串味。 */
const surfaceBackups = new WeakMap();

/** 已经警告过的 surface.id（同一条只刷一次，别把控制台刷满）。 */
const pinnedWarned = new Set();

const DEFAULT_EMPTY_COPY = "这块界面已被关闭|当前配置下它不显示。打开对应插件后回来刷新即可。";

/**
 * 解析 emptyCopy：
 *   - 含 "|" → "<标题>|<正文>"，按第一个竖线切两段；
 *   - 不含 "|" → 整串当 HTML（调用方自己保证内容是可信的静态片段）；
 *   - 缺省 → DEFAULT_EMPTY_COPY。
 */
function parseEmptyCopy(copy) {
  const text = typeof copy === "string" && copy.trim() ? copy : DEFAULT_EMPTY_COPY;
  const bar = text.indexOf("|");
  if (bar >= 0) {
    return { title: text.slice(0, bar).trim(), body: text.slice(bar + 1).trim(), html: "" };
  }
  return { title: "", body: "", html: text };
}

/** 把容器内容换成空态。标题 / 正文走 textContent，HTML 串走 innerHTML。 */
function renderEmpty(node, surface) {
  const doc = node.ownerDocument || document;
  const copy = parseEmptyCopy(surface.emptyCopy);
  const wrap = doc.createElement("div");
  wrap.className = "surface-empty";
  if (copy.html) {
    wrap.innerHTML = copy.html;
  } else {
    const title = doc.createElement("div");
    title.className = "surface-empty-title";
    title.textContent = copy.title;
    const body = doc.createElement("div");
    body.className = "surface-empty-body";
    body.textContent = copy.body;
    wrap.append(title, body);
  }
  // 去处永远给一条：深链进来的人不用自己猜。
  const go = doc.createElement("a");
  go.className = "btn-primary surface-empty-go";
  go.href = "#/settings/plugins";
  go.textContent = "去插件中心";
  wrap.append(go);
  node.replaceChildren(wrap);
}

/**
 * 按注册表铺显隐。幂等：同样的 flags 重复调用结果一致。
 * root 可以是 document，也可以是某一页的渲染根（只处理它底下的元素）。
 */
export function applySurfaces(root = document) {
  if (!surfacesEnabled) return;
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const surface of SURFACES) {
    // 防呆：返回路径不许 hide（未来有人手滑加条目时，至少还回得去）
    if (surface.mode === "hide" && PINNED.has(surface.selector)) {
      if (!pinnedWarned.has(surface.id)) {
        pinnedWarned.add(surface.id);
        console.warn(`[surfaces] ${surface.id} 指向返回路径 ${surface.selector}，mode="hide" 已跳过`);
      }
      continue;
    }
    const nodes = root.querySelectorAll(surface.selector);
    // 选择器找不到就跳过：这些元素只在对应页面上存在（插件页 / 技能页 / 会话页）
    if (!nodes.length) continue;
    const requires = Array.isArray(surface.requires) ? surface.requires : [];
    const on = requires.every((key) => flagOn(key));
    for (const node of nodes) {
      if (surface.mode === "disable") {
        if ("disabled" in node) node.disabled = !on;
        node.setAttribute("aria-disabled", String(!on));
        continue;
      }
      if (surface.mode === "empty") {
        const backup = surfaceBackups.get(node);
        if (on) {
          // 恢复原内容；恢复后清掉备份，下次关再存一份当前的样子
          if (backup !== undefined) {
            node.innerHTML = backup;
            surfaceBackups.delete(node);
          }
          continue;
        }
        // 已经换过的不再备份（幂等：重复调用不会把空态当原文存进去）
        if (backup !== undefined) continue;
        surfaceBackups.set(node, node.innerHTML);
        renderEmpty(node, surface);
        continue;
      }
      node.hidden = !on;
    }
  }
}

/** 拉一次 flags（缓存已有就不发请求），再按注册表铺一遍。页面启动 / 每次重渲染后调这个。 */
export async function refreshSurfaces(root = document) {
  await loadSurfaceFlags();
  applySurfaces(root);
}
