/**
 * 设置 → 上下文（2026-11-16 起，2026-11-17 重画）
 *
 * 一页 = 一条请求装了什么，画成“棋盘”：
 *   - 顶部：总量 + 真实用量 + 384 格棋盘（每格 ≈1/384 请求，按组上色）+ 可点的组标签；
 *   - 点格子或标签 → 浮起一张卡片，里面是该组的逐条内容，点条目读原文；
 *   - 当前会话：只画已经进请求的东西；默认开销：把全部可注入字段（含 0）画进来，0 的行点开写「当前没有开销」。
 * 口径见 docs/设计方案/2026-11-17-上下文页重画（已注入视图）.md。
 *
 * 这一页 2026-11-21 起**可改**（用户口径：注入内容要能在一个页面里改）：
 * 默认开销与当前会话里标了 `editable` 的段，展开后有「改这一节」；
 * 保存直接写回源头（人设 / 关于我 / 岗位契约 / 当前目标 / 纪律），再刷新这一页。
 * 代码固定段（验证铁律、注入防线、派活执行器…）没有编辑入口，只展示。
 * 记忆与工具在「注入」分区的隔壁 tab：索引页管记忆，工具页管常驻/按需。
 */

import { chevSvg } from "./icons.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { parsePartnerExternalId } from "./partner-sessions.js";
import { currentRoute } from "./route.js";
import { openContextSectionEditor } from "./settings-context-edit.js";
import { state } from "./state.js";
import { toast } from "./ui-atoms.js";

const STABILITY = {
	fixed: { label: "固定", cls: "is-fixed" },
	session: { label: "按会话冻结", cls: "is-session" },
	turn: { label: "每轮现算", cls: "is-turn" },
};
const ENTRY_TAG = { toolCall: "调用", toolResult: "结果" };

/**
 * 请求行的骤降结论（2026-11-19）：
 * 0% 命中大家都知道可能是缓存过期——真正要抓的是「命中率从 90% 掉到个位数，而且
 * system 前缀同时变了」。这里把服务端算好的 flag 映射成一个点 + 悬停说明。
 */
const REQUEST_FLAG = {
	prefix_change_drop: {
		mark: "!",
		cls: "is-alarm",
		title: "命中率骤降且 system 前缀同时变了——重点看这条",
	},
	prefix_change: {
		mark: "↑",
		cls: "is-warn",
		title: "system 前缀相对上一条变了（这次没骤降，可能缓存已经过期过）",
	},
	tools_change_drop: {
		mark: "!",
		cls: "is-warn",
		title: "命中率骤降且工具面变了（tool_search 加载/移除过工具）",
	},
	tools_change: {
		mark: "T",
		cls: "is-warn",
		title: "工具面相对上一条变了（加载/移除了工具）",
	},
	drop_unchanged: {
		mark: "·",
		cls: "is-dim",
		title: "命中率骤降，但 system 与工具面都没变（大概率缓存过期/上游）",
	},
	compacted: {
		mark: "C",
		cls: "is-dim",
		title: "上下文压缩/重置后的第一条，前缀必然重写",
	},
};

/** 棋盘：32 列 × 12 行 = 384 格，每格 ≈0.26% 的请求。 */
const WAFFLE_COLS = 32;
const WAFFLE_ROWS = 12;
const WAFFLE_CELLS = WAFFLE_COLS * WAFFLE_ROWS;

/** 浮层卡片单条正文上限与页面一致：超长只在卡片里说“已截断”。 */
const POP_TEXT_MAX = 3000;

let contextSeq = 0;
/** session = 看一条当前会话；default = 看每个角色的默认开销（不需要聊天）。 */
let contextMode = "session";
/** 最近一次画出来的东西：浮层卡片直接复用，不另算一遍。 */
let currentParts = [];
let currentGroups = [];
let currentData = null;
let currentBase = 0;
let popTimer = 0;

/**
 * 棋盘的基准（只影响「当前会话」）：
 * - composition：384 格 = 这一条请求本身，看到的是组成占比（默认，因为窗口通常远大于请求）；
 * - window：384 格 = 上下文窗口，没画到的格子就是没用到的余量。
 * 选择记在 localStorage，跟着设置页的重渲染走。
 */
const WAFFLE_SCALE_KEY = "lifediary.ctxScale";

function readWaffleScale() {
	try {
		return localStorage.getItem(WAFFLE_SCALE_KEY) === "window" ? "window" : "composition";
	} catch {
		return "composition";
	}
}

let waffleScale = readWaffleScale();

/** 执事会话的 conversationId：canonical / side 都解析出真正的 partnerId；默认开销同口径。 */
function partnerIdOfChat(chat) {
	return parsePartnerExternalId(chat?.conversationId)?.partnerId || "";
}

function partnerName(partnerId) {
	const partner = (state.partners || []).find((item) => item && item.id === partnerId);
	return partner?.name || "";
}

/**
 * 会话在页面上的名字：和「默认开销」的角色选择器保持一致——
 * 执事会话就是执事的名字（不是“未命名会话”），总管 / worker 用角色名。
 */
function chatLabel(chat) {
	const partnerId = partnerIdOfChat(chat);
	if (partnerId) return partnerName(partnerId) || chat?.title || "执事";
	if (chat?.chatKind === "chief") return "总管";
	if (chat?.chatKind === "worker") return "普通 worker";
	return chat?.title || "会话";
}

/** 深链 `#/settings/context?chat=<外部id>&label=<显示名>`（2026-11-24）。
 * 只服务「一条不列在会话清单里、但按 id 读得到」的会话（开场问候的隐藏生成会话）；
 * 没带 chat 时逐字保持旧行为。 */
let deepLinkChat = null;

function deepLinkChatFromHash() {
	const hash = location.hash.replace(/^#/, "");
	if (!hash.startsWith("/settings/context")) return null;
	const text = hash.split("?")[1] || "";
	let chat = "";
	let label = "";
	try {
		const params = new URLSearchParams(text);
		chat = (params.get("chat") || "").trim();
		label = (params.get("label") || "").trim();
	} catch {
		return null;
	}
	if (!chat) return null;
	return { conversationId: chat, title: label || "系统请求" };
}

function chatChoices() {
	const rows = (state.chats || [])
		.filter((chat) => chat && chat.conversationId)
		.slice()
		.sort((left, right) => (right.lastAt || 0) - (left.lastAt || 0));
	// 2026-11-24：深链 `?chat=` 指定一条不在会话清单里的会话（如开场问候的隐藏生成会话
	// `task-greeting-…`）。只给这一次渲染合成一个选项，不并入 state.chats、不列其它 task- 会话。
	if (deepLinkChat && !rows.some((chat) => chat.conversationId === deepLinkChat.conversationId)) {
		rows.unshift({
			conversationId: deepLinkChat.conversationId,
			title: deepLinkChat.title,
			chatKind: "hidden",
			lastAt: 0,
		});
	}
	// 2026-11-17：只有一条真实会话都没有时才用兜底的「当前会话」。
	// 有真实会话时不把它插进列表：当前打开的可能是一条还没落库的空会话，
	// 选中它只会得到「当前没有开销」，看不出这一页有什么用。
	const current = state.conversationId;
	if (!rows.length && current) {
		rows.unshift({
			conversationId: current,
			title: "当前会话",
			chatKind: state.chatKind || "",
			lastAt: 0,
		});
	}
	return rows.slice(0, 40);
}

function selectedChatId(choices) {
	if (deepLinkChat && choices.some((chat) => chat.conversationId === deepLinkChat.conversationId)) {
		return deepLinkChat.conversationId;
	}
	if (state.conversationId && choices.some((chat) => chat.conversationId === state.conversationId)) {
		return state.conversationId;
	}
	return choices[0]?.conversationId || "";
}

/** 深链 #/settings/context?role=... 认的角色名（执事另走 partner:<id>）。 */
const DEEP_LINK_ROLES = new Set(["chief", "dispatch-worker"]);

/**
 * 深链 `#/settings/context?role=dispatch-worker` 里的 role（2026-11-22）。
 * 只认 chief / dispatch-worker / partner:<id>；别的值（含 2026-11-24 退役的 worker）
 * 当成没写，回落总管，不弹错。地址里没有 query 时返回空串——旧 hash 的页面行为保持逐字不变。
 */
function deepLinkRoleFromHash() {
	const hash = location.hash.replace(/^#/, "");
	if (!hash.startsWith("/settings/context")) return "";
	const text = hash.split("?")[1] || "";
	let raw = "";
	try {
		raw = new URLSearchParams(text).get("role") || "";
	} catch {
		raw = "";
	}
	const id = raw.trim();
	if (!id) return "";
	if (DEEP_LINK_ROLES.has(id)) return id;
	const partnerId = /^partner:([A-Za-z0-9._-]+)$/.exec(id)?.[1] || "";
	if (!partnerId) return "";
	// 执事花名册已经读回来时顺手校验一次：不存在的执事也当没写，宁可看总管也不报 404。
	const known = (state.partners || []).filter(
		(partner) => partner && partner.id && partner.id !== "chief",
	);
	if (known.length && !known.some((partner) => partner.id === partnerId && partner.status === "active")) {
		return "";
	}
	return `partner:${partnerId}`;
}

/** 深链点的角色还不在花名册里时先补一项（等 syncRoleOptions 拿服务端的 roles 校正）。 */
function withDeepLinkRole(roles, roleId) {
	if (!roleId || roles.some((role) => role.id === roleId)) return roles;
	const partnerId = roleId.startsWith("partner:") ? roleId.slice("partner:".length) : "";
	const label = partnerId ? partnerName(partnerId) || "执事" : "派活工人（池）";
	return [...roles, { id: roleId, label }];
}

/** 默认开销的角色：总管 → 活跃执事 → 派活工人（池）兜底。服务端还会回一份完整 roles，用于校正这里的花名册。 */
function defaultRoleChoices() {
	const roles = [{ id: "chief", label: "总管" }];
	for (const partner of state.partners || []) {
		if (!partner || partner.status !== "active" || partner.id === "chief") continue;
		roles.push({ id: `partner:${partner.id}`, label: partner.name || "执事" });
	}
	// 2026-11-22：深链 #/settings/context?role=dispatch-worker 要在服务端 roles 回来前就能选中，
	// 先摆一个兜底项；真名册回来后由 syncRoleOptions 换掉。
	roles.push({ id: "dispatch-worker", label: "派活工人（池）" });
	return roles;
}

function roleOptionMarkup(roles, selected) {
	return roles
		.map(
			(role) =>
				`<option value="${esc(role.id)}"${role.id === selected ? " selected" : ""}>${esc(role.label)}</option>`,
		)
		.join("");
}

function fmtNum(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number.toLocaleString("zh-CN") : "—";
}

/** token 是估算值：页面统一带 `≈`，不冒充精确计费。 */
function fmtTokens(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? `≈${fmtNum(number)}` : "0";
}

function fmtK(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return "—";
	if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
	if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
	return String(number);
}

function fmtAt(at) {
	const date = new Date(Number(at));
	if (!Number.isFinite(date.getTime())) return "";
	const now = new Date();
	const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
	if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
	return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

function badgeMarkup(stability) {
	const meta = STABILITY[stability] || STABILITY.fixed;
	return `<span class="ctx-badge ${meta.cls}">${meta.label}</span>`;
}

// 2026-11-21（箭头统一批）：指下/180° 翻面 → 全站口径指右/90°（旋转行为在 style-27 的 .chev）
const CHEVRON = chevSvg("ctx-chevron chev");

/** 一行 = 名字 + 徽标 + token；点开是原文，空行点开是「当前没有开销」。 */
function rowMarkup(row) {
	const seq = row.seq ? `<span class="ctx-row-seq">${esc(row.seq)}</span>` : "";
	const tag = row.tag ? `<span class="ctx-row-tag">${esc(row.tag)}</span>` : "";
	const mono = row.mono ? " is-mono" : "";
	const text = String(row.text || "");
	const clipped = text.length > POP_TEXT_MAX;
	let body;
	if (row.text) {
		body = `<pre class="ctx-text">${esc(clipped ? text.slice(0, POP_TEXT_MAX) : text)}</pre>${
			clipped || row.truncated
				? `<div class="ctx-trunc">${row.truncated ? "服务端已截断" : "卡片只显示前 3,000 字"} · 共 ${fmtNum(
						row.chars || text.length,
					)} 字</div>`
				: ""
		}`;
	} else if (row.note) {
		body = `<div class="ctx-item-note">${esc(row.note)}</div>`;
	} else {
		body = `<div class="ctx-item-empty">当前没有开销</div>`;
	}
	return `<div class="ctx-row">
    <button class="ctx-row-head" type="button" data-ctx-row aria-expanded="false">
      ${seq}<span class="ctx-row-name${mono}">${esc(row.name)}</span>${tag}${
				row.stability ? badgeMarkup(row.stability) : ""
			}${row.editable ? '<span class="ctx-badge is-editable">可编辑</span>' : ""}
      <span class="ctx-row-tokens">${fmtTokens(row.tokens)} token</span>
      ${CHEVRON}
    </button>
    <div class="ctx-row-body" hidden>${body}${
			row.editable && row.key
				? `<div class="ctx-edit-row"><button class="ctx-link" type="button" data-ctx-edit="${esc(
						row.key,
					)}">改这一节</button></div>`
				: ""
		}</div>
  </div>`;
}

function toolbarMarkup(mode, choices, selected, roles, role) {
	// 同名会话（同一个执事的两条会话）才补时间，避免两条“小记”分不清。
	const names = choices.map((chat) => chatLabel(chat));
	const duplicated = names.some((name, index) => names.indexOf(name) !== index);
	const options = choices.length
		? choices
				.map((chat, index) => {
					const name = names[index];
					const label = duplicated ? `${name} · ${fmtAt(chat.lastAt)}` : name;
					return `<option value="${esc(chat.conversationId)}"${
						chat.conversationId === selected ? " selected" : ""
					}>${esc(label)}</option>`;
				})
				.join("")
		: `<option value="">还没有会话</option>`;
	// 2026-11-23（用户口径）：两个开关靠在一起放，别再一左一右夹着会话框；
	// 会话框收窄到 200px，工具栏整条留在左边，右边不再被拉开一段空。
	return `<div class="ctx-toolbar">
    <div class="ctx-mode" role="radiogroup" aria-label="上下文视图">
      <button type="button" data-ctx-mode="session" aria-checked="${mode === "session"}">当前会话</button>
      <button type="button" data-ctx-mode="default" aria-checked="${mode === "default"}">默认开销</button>
    </div>
    <div class="ctx-mode ctx-scale" role="radiogroup" aria-label="棋盘的基准" ${mode === "session" ? "" : "hidden"}>
      <button type="button" data-ctx-scale="composition" aria-checked="${waffleScale === "composition"}" title="每格 = 请求里的一份，看到的是组成占比">占比</button>
      <button type="button" data-ctx-scale="window" aria-checked="${waffleScale === "window"}" title="每格 = 上下文窗口的一份，空着的就是没用到的">窗口</button>
    </div>
    <select class="set-input ctx-select" id="ctx-chat" ${mode === "session" && choices.length ? "" : "hidden"} ${choices.length ? "" : "disabled"} aria-label="选择要查看上下文的会话">${options}</select>
    <select class="set-input ctx-select" id="ctx-role" ${mode === "default" ? "" : "hidden"} aria-label="选择要查看默认开销的角色">${roleOptionMarkup(roles, role)}</select>
    <button class="ghost ctx-refresh" type="button" id="ctx-refresh">刷新</button>
  </div>`;
}

/** 棋盘格子在骨架里一次建好（384 个），之后只改颜色——这样数字一变是“变色动画”而不是整块重画。 */
function waffleMarkup() {
	const cells = [];
	for (let index = 0; index < WAFFLE_CELLS; index += 1) {
		cells.push(`<span class="ctx-cell" data-cell="${index}"></span>`);
	}
	return `<div class="ctx-waffle" id="ctx-waffle" role="img" aria-label="请求内容的格子图，每格约 0.26%">${cells.join(
		"",
	)}</div>`;
}

function heroMarkup() {
	return `<div class="card ctx-hero" id="ctx-hero">
    <div class="ctx-hero-top">
      <div class="ctx-hero-copy">
        <div class="ctx-total"><b id="ctx-total">—</b><span id="ctx-total-unit">token · 已注入</span></div>
        <div class="ctx-sub" id="ctx-sub">选择会话后读取…</div>
      </div>
      <div class="ctx-hero-side">
        <div class="ctx-meter" id="ctx-meter"><span class="ctx-meter-label">上一轮</span><b>—</b></div>
      </div>
    </div>
    ${`<div class="ctx-hero-body">${waffleMarkup()}<div class="ctx-chips" id="ctx-chips"></div></div>`}
    <div class="ctx-note" id="ctx-note" hidden></div>
  </div>`;
}

/**
 * 「请求」卡骨架（2026-11-19；2026-11-23 按用户口径收口）。
 * 默认开销模式不显示；当前会话模式由 loadRequests 拉数据后再展开。
 * 2026-11-23：不再挂「请求与缓存」标题与红光提示条——卡头只剩一行账
 * （多少次请求第几页 + 前缀变化 / 骤降 / 完全未命中）与右侧命中率。
 */
function cacheMarkup() {
	return `<div class="card ctx-cache" id="ctx-cache" hidden>
    <div class="ctx-cache-head">
      <div class="ctx-cache-meta" id="ctx-cache-sub">读取中…</div>
      <div class="ctx-cache-rate"><b id="ctx-cache-rate">—</b><span>命中率</span></div>
    </div>
    <div class="ctx-cache-list" id="ctx-cache-list"></div>
    <div class="ctx-cache-pager" id="ctx-cache-pager" hidden>
      <button class="ghost" type="button" data-ctx-page="prev">上一页</button>
      <span class="ctx-cache-pages" id="ctx-cache-pages">第 1 / 1 页</span>
      <button class="ghost" type="button" data-ctx-page="next">下一页</button>
    </div>
  </div>`;
}

/**
 * 页骨架。每次设置页重渲染都会重新进来，这里把旧请求代号 +1，
 * 让还没回来的 fetch 不再往新 DOM 里写。
 */
function contextSettingsMarkup() {
	contextSeq += 1;
	// 重渲染后旧请求列表的返回也不能往新 DOM 里写。
	requestsSeq += 1;
	deepLinkChat = deepLinkChatFromHash();
	const choices = chatChoices();
	const selected = selectedChatId(choices);
	// 只有「当前会话」兜底、没有任何真实会话记录时直接进默认开销：
	// 用户不聊天也能看到总管基线，不必先点模式按钮。
	const hasRealChats =
		(state.chats || []).some((chat) => chat && chat.conversationId) || Boolean(deepLinkChat);
	contextMode = hasRealChats ? "session" : "default";
	// 2026-11-22：深链带了 role 就直接看这个角色的默认开销；没带时上面的旧口径逐字不变。
	const deepLinkRole = deepLinkRoleFromHash();
	if (deepLinkRole) contextMode = "default";
	// 2026-11-24：chat 深链优先于 role（它指定的是具体会话，不是角色基线）。
	if (deepLinkChat) contextMode = "session";
	const roles = withDeepLinkRole(defaultRoleChoices(), deepLinkRole);
	const selectedRole = deepLinkRole || roles[0]?.id || "chief";
	// 2026-11-18：导航卡已经写着「上下文」，节标题不再重复一遍；
	// 2026-11-21：注入分区有六张卡，上下文排最后（实际注入的账）。
	// 工具栏自带「当前会话 / 默认开销」两个模式，直接当这一页的入口。
	return `<div id="ctx-content" data-mode="${contextMode}">
    <section class="set-sec">
      ${toolbarMarkup(contextMode, choices, selected, roles, selectedRole)}${heroMarkup()}${cacheMarkup()}
    </section>
  </div>`;
}

/**
 * 当前会话的分段：五块都算进总量（这才是这一条请求的真实体积）。
 * 2026-11-23（用户口径）：工具结果并回「对话与工具」——它本来就属于会话正文，
 * 不再单独当一块（否则图例上有一个点进去什么都没有的段）。
 */
function sessionParts(data) {
	const last = data.memory.last;
	const injectTokens =
		(last ? Number(last.tokens || 0) : 0) +
		(last?.others ?? []).reduce((sum, item) => sum + Number(item.tokens || 0), 0);
	return [
		{ key: "system", label: "系统提示词", tokens: Number(data.system.tokens || 0) },
		{ key: "tools", label: "工具定义", tokens: Number(data.tools.tokens || 0) },
		{ key: "skills", label: "技能", tokens: Number(data.skills.tokens || 0) },
		{ key: "inject", label: "临时注入", tokens: injectTokens },
		{
			key: "conversation",
			label: "对话与工具",
			tokens:
				Number(data.changing?.messages?.tokens || 0) +
				Number(data.changing?.toolCalls?.tokens || 0) +
				Number(data.changing?.toolResults?.tokens || 0),
		},
	];
}

function defaultParts(data) {
	return [
		{ key: "system", label: "系统提示词", tokens: Number(data.system.tokens || 0) },
		{ key: "tools", label: "工具定义", tokens: Number(data.tools.tokens || 0) },
		{ key: "skills", label: "技能", tokens: Number(data.skills.tokens || 0) },
		{ key: "memory", label: "记忆", tokens: 0, note: `预算 ${fmtNum(data.memory.limit)} 条 / ${fmtNum(data.memory.maxChars)} 字` },
	];
}

/**
 * 「窗口」视图里给“没用到的余量”留的**固定面积**：384 格的 30%。
 * 参考 magpie 的做法——真实窗口通常远大于一条请求（1M 里用 6K 只有 0.6%），
 * 按真比例画出来几乎空图，看不出各组的大小；固定留一块余量，已用的部分反而看得清。
 * 面积是示意的，数字还是真的（图例写真实剩余 token，右上角写真实占用率）。
 */
const WAFFLE_RESERVED_CELLS = 115;

/** 余量格子数：组成视图为 0；窗口视图取“固定 30%”与“真实剩余”的较小者（用到 70% 以上时按真的画）。 */
function waffleEmptyCells(parts, base) {
	const sum = parts.reduce((total, part) => total + Number(part.tokens || 0), 0);
	const baseTokens = Number(base) || 0;
	if (baseTokens <= sum) return 0;
	const honest = Math.max(0, Math.round((1 - sum / baseTokens) * WAFFLE_CELLS));
	return Math.min(WAFFLE_RESERVED_CELLS, honest);
}

/**
 * 384 格的分配：组间按占比取整（最大余数补齐），每组至少一格。
 * `budget` = 允许画的格子数（窗口视图扣掉余量那一条）。
 * 返回每格属于哪个组；空字符串 = 空格子（余量，或总量为 0）。
 */
function wafflePlan(parts, budget) {
	const shown = parts.filter((part) => Number(part.tokens) > 0);
	const plan = [];
	if (!shown.length) return new Array(WAFFLE_CELLS).fill("");
	const sum = shown.reduce((total, part) => total + Number(part.tokens), 0) || 1;
	const slots = Math.max(shown.length, Math.min(WAFFLE_CELLS, Number(budget) || WAFFLE_CELLS));
	const want = shown.map((part) => (Number(part.tokens) / sum) * slots);
	const got = want.map((value) => Math.max(1, Math.floor(value)));
	let left = slots - got.reduce((total, value) => total + value, 0);
	const order = want.map((value, index) => [value - Math.floor(value), index]).sort((a, b) => b[0] - a[0]);
	for (let index = 0; left > 0; index = (index + 1) % order.length, left -= 1) got[order[index][1]] += 1;
	for (let index = got.length - 1; left < 0 && index >= 0; index -= 1) {
		while (left < 0 && got[index] > 1) {
			got[index] -= 1;
			left += 1;
		}
	}
	shown.forEach((part, index) => {
		for (let cell = 0; cell < got[index]; cell += 1) plan.push(part.key);
	});
	while (plan.length < WAFFLE_CELLS) plan.push("");
	return plan;
}

/**
 * 列数只能取 384 的约数，行数才是整数——否则最后一行会剩下几个空格子，
 * 深浅两档配色本来就接近底色，那一排空格看着像“这一组突然变长”。
 * 取“格子宽度不低于 13px 的最大列数”，宽窗口格子接近正方，窄窗口自动多排几行。
 */
const WAFFLE_COL_CHOICES = [96, 64, 48, 32, 24, 16, 12, 8];

function fitWaffleColumns() {
	const grid = document.getElementById("ctx-waffle");
	if (!grid) return;
	const width = grid.clientWidth;
	if (!width) return;
	let cols = 8;
	for (const candidate of WAFFLE_COL_CHOICES) {
		if (width / candidate >= 13) {
			cols = candidate;
			break;
		}
	}
	if (grid.dataset.cols === String(cols)) return;
	grid.dataset.cols = String(cols);
	grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
}

function paintWaffle(parts, base) {
	const grid = document.getElementById("ctx-waffle");
	if (!grid) return;
	fitWaffleColumns();
	const empty = waffleEmptyCells(parts, base);
	const plan = wafflePlan(parts, WAFFLE_CELLS - empty);
	const colors = new Map(parts.map((part, index) => [part.key, index + 1]));
	const cells = grid.children;
	for (let index = 0; index < WAFFLE_CELLS; index += 1) {
		const cell = cells[index];
		if (!(cell instanceof HTMLElement)) continue;
		const key = plan[index] || "";
		cell.dataset.group = key;
		// 只改颜色类：颜色有 transition，数据一变就是渐变，不是闪一下。
		const color = colors.get(key) || 0;
		cell.className = `ctx-cell${color ? ` is-g${color}` : ""}${key ? "" : " is-free"}`;
	}
}

function renderChips(parts, total, windowInfo) {
	const box = document.getElementById("ctx-chips");
	if (!box) return;
	const shown = parts.filter((part) => Number(part.tokens) > 0 || part.note);
	box.innerHTML = shown
		.map((part, index) => {
			const color = parts.indexOf(part) + 1;
			const meta = part.note
				? part.note
				: `${fmtTokens(part.tokens)} · ${total > 0 ? Math.round((part.tokens / total) * 100) : 0}%`;
			return `<button class="ctx-chip" type="button" data-ctx-open="${esc(part.key)}" data-ctx-chip="${esc(
				part.key,
			)}"><span class="ctx-dot" style="background:var(--ctx-g${((color - 1) % 6) + 1})"></span><span class="ctx-chip-name">${esc(
				part.label,
			)}</span><span class="ctx-chip-num">${meta}</span></button>`;
		})
		.join("");
	// 窗口视图才需要解释“那些空格子是什么”：就是还没用到的余量，点不开。
	// 面积固定留 30%（示意），数字写真实剩余。
	if (windowInfo && windowInfo.window > windowInfo.used) {
		const unused = windowInfo.window - windowInfo.used;
		box.insertAdjacentHTML(
			"beforeend",
			`<div class="ctx-chip is-unused" title="棋盘里固定留三分之一表示没用到的余量，面积是示意的；真实剩余 ${fmtNum(
				unused,
			)} token"><span class="ctx-dot"></span><span class="ctx-chip-name">未使用</span><span class="ctx-chip-num">${fmtTokens(
				unused,
			)}</span></div>`,
		);
	}
	// 「全部」：一张卡片里按组铺开，方便先扫一遍再点开某一行。
	if (total > 0) {
		box.insertAdjacentHTML(
			"beforeend",
			`<button class="ctx-chip is-all" type="button" data-ctx-open="__all"><span class="ctx-chip-name">全部</span><span class="ctx-chip-num">${shown.length} 组</span></button>`,
		);
	}
}

function renderHero(data) {
	const isDefault = Boolean(data.default);
	const parts = isDefault ? defaultParts(data) : sessionParts(data);
	currentParts = parts;
	const total = parts.reduce((sum, part) => sum + part.tokens, 0);

	const totalNode = document.getElementById("ctx-total");
	if (totalNode) totalNode.textContent = total > 0 ? `≈${fmtNum(total)}` : "—";
	const unit = document.getElementById("ctx-total-unit");
	if (unit) unit.textContent = isDefault ? "token · 默认基线" : "token · 已注入";

	const sub = document.getElementById("ctx-sub");
	if (sub) {
		const memoryText = isDefault
			? ""
			: data.memory.enabled
				? data.memory.last?.items > 0
					? ` · 记忆 ${data.memory.last.items} 条`
					: ""
				: " · 记忆未启用";
		const conversationText = isDefault ? "" : ` · 对话与工具 ${(data.entries || []).length} 条`;
		sub.textContent =
			total > 0
				? isDefault
					? `${data.role?.label || "默认"} · 系统 ${data.system.sections.length} 个字段 · 工具 ${data.tools.count} 个 · 技能 ${data.skills.count} 个`
					: `${data.chatKind === "partner" ? "执事会话" : "会话"} · 系统 ${data.system.sections.length} 段 · 工具 ${data.tools.count} 个 · 技能 ${data.skills.count} 个${memoryText}${conversationText}`
				: "当前没有开销";
	}

	const meter = document.getElementById("ctx-meter");
	if (meter) {
		if (isDefault) {
			meter.innerHTML = `<span class="ctx-meter-label">默认基线</span><b>无需聊天</b>`;
		} else {
			const used = Number(data.usage?.used);
			const windowSize = Number(data.usage?.window);
			if (Number.isFinite(used) && used > 0 && Number.isFinite(windowSize) && windowSize > 0) {
				meter.innerHTML = `<span class="ctx-meter-label">上一轮</span><b>${fmtK(used)} / ${fmtK(windowSize)}</b> <span class="ctx-meter-unit">token · ${Math.round((used / windowSize) * 100)}%</span>`;
			} else {
				meter.innerHTML = `<span class="ctx-meter-label">上一轮</span><b>—</b>`;
			}
		}
	}

	// 棋盘基准：会话版可以切成“按窗口”（余量留白），默认开销永远按组成占比。
	const usedTokens = Number(data.usage?.used);
	const windowTokens = Number(data.usage?.window);
	const windowInfo =
		!isDefault && Number.isFinite(usedTokens) && usedTokens > 0 && Number.isFinite(windowTokens) && windowTokens > 0
			? { used: usedTokens, window: windowTokens }
			: null;
	const scaleMode = !isDefault && waffleScale === "window" && windowInfo && windowInfo.window > total ? "window" : "composition";
	// 没跑过一轮（没有 usage）就没有窗口数：这时把「窗口」这个选项置灰，别让人选了却画不出来。
	for (const button of document.querySelectorAll("[data-ctx-scale]")) {
		const isWindow = button.dataset.ctxScale === "window";
		button.setAttribute("aria-checked", String(button.dataset.ctxScale === scaleMode));
		button.disabled = isWindow && (!windowInfo || Boolean(isDefault));
	}
	const root = document.getElementById("ctx-content");
	if (root) root.dataset.scale = scaleMode;
	const grid = document.getElementById("ctx-waffle");
	if (grid) {
		grid.setAttribute(
			"aria-label",
			scaleMode === "window"
				? "上下文占用格子图：已用的按占比铺满，没用到的余量固定留一块"
				: "请求组成格子图：每格约这一条请求的 0.26%",
		);
	}

	paintWaffle(parts, scaleMode === "window" ? windowInfo.window : total);
	currentBase = scaleMode === "window" ? windowInfo.window : total;
	renderChips(parts, total, scaleMode === "window" ? windowInfo : null);
	return total;
}

/**
 * 哪些段真的能在这页改：服务端 `editable` 是字段级标记，还要看当前角色。
 * 总管 / worker 的默认开销里会保留执事字段的 0 字槽位（岗位契约、纪律、目标…），
 * 这些槽位对它们不适用，不能给「可编辑」徽标和按钮，否则点开只能报错。
 */
function canEditSection(section, data) {
	if (!section.editable) return false;
	// 2026-11-21：当前项目由会话所属项目派生，不是一段可单独改写的正文。
	// 服务端已经不再标 editable；这里再兜一道，旧服务端也不会给出入口。
	if (String(section.key || "") === "current_project") return false;
	const partnerRole = data.default
		? data.role?.kind === "partner"
		: Boolean(currentPartnerIdValue) || data.chatKind === "partner";
	// 执事没有通用 persona 段；它的身份由 partner_soul 承载，别在两行上重复开同一个编辑入口。
	if (partnerRole && String(section.key || "") === "persona") return false;
	if (!partnerRole && String(section.key || "").startsWith("partner_")) return false;
	return true;
}

/** 分组列表：两个模式同一套，差别只在“哪些行在”和“0 怎么办”。 */
function buildGroups(data) {
	const isDefault = Boolean(data.default);
	const groups = [];

	// 1) 临时注入：只有会话版有；服务端只在真跑过一轮时才有记录。
	if (!isDefault) {
		const rows = [];
		const last = data.memory.last;
		// 记忆关掉时，临时注入里仍可能有当前项目（2026-11-19 前缀锁定：
		// 它不再是 system 段，只剩这一处可见），所以只把「记忆召回」那一行按开关过滤。
		if (last) {
			if (data.memory.enabled && last.text) {
				rows.push({ name: "记忆召回", tokens: last.tokens, text: last.text, stability: "turn" });
			}
			for (const other of last.others || []) {
				rows.push({
					name: other.label || other.id,
					tokens: other.tokens,
					text: other.text || "",
					chars: other.chars,
					truncated: other.truncated,
					mono: false,
				});
			}
		}
		const visible = rows.filter((row) => Number(row.tokens) > 0);
		if (visible.length) {
			groups.push({
				key: "inject",
				label: "临时注入",
				count: `${visible.length} 条`,
				tokens: visible.reduce((sum, row) => sum + Number(row.tokens || 0), 0),
				rows: visible,
			});
		}
	}

	// 2) 系统提示词：会话版藏 0，默认版全列。系统底稿（system.content）不再单独占一行。
	const systemRows = [];
	for (const section of data.system.sections || []) {
		if (!isDefault && Number(section.tokens) <= 0) continue;
		systemRows.push({
			key: section.key,
			name: section.label,
			tokens: section.tokens,
			text: section.empty ? "" : section.text,
			stability: section.stability,
			// 2026-11-21：服务端标了 editable 的段才给「改这一节」；代码固定段不假装能改，
			// 非执事角色里的执事字段 0 字槽位也不给入口。
			editable: canEditSection(section, data),
		});
	}
	if (systemRows.length) {
		groups.push({
			key: "system",
			label: "系统提示词",
			count: `${systemRows.length} ${isDefault ? "个字段" : "段"}`,
			tokens: Number(data.system.tokens || 0),
			rows: systemRows,
		});
	}

	// 3) 工具定义：只有名字与 token，描述不进页面（展开才是真实 JSON Schema）。
	const toolRows = (data.tools.items || []).map((tool) => ({
		name: tool.name,
		tokens: tool.tokens,
		text: tool.schema,
		mono: true,
	}));
	if (toolRows.length) {
		groups.push({
			key: "tools",
			label: "工具定义",
			count: `${data.tools.count} 个`,
			tokens: Number(data.tools.tokens || 0),
			rows: toolRows,
		});
	}

	// 4) 技能：索引一段，属于系统消息里的一节。
	if (data.skills.text) {
		groups.push({
			key: "skills",
			label: "技能",
			count: `${data.skills.count} 个技能`,
			tokens: Number(data.skills.tokens || 0),
			rows: [
				{ name: "技能索引", tokens: data.skills.tokens, text: data.skills.text, stability: isDefault ? "fixed" : "session" },
			],
		});
	}

	// 5) 对话与工具：已经进请求的每一条，按真实顺序；默认版没有会话就没有这一组。
	if (!isDefault) {
		const entryRows = (data.entries || []).map((entry, position) => ({
			name: entry.label,
			tokens: entry.tokens,
			text: entry.text,
			chars: entry.chars,
			truncated: entry.truncated,
			// 序号按“已经进请求的条目”从 1 数，不按消息下标（否则第一条从 #2 开始，看着像丢了）。
			seq: `#${position + 1}`,
			tag: ENTRY_TAG[entry.kind] || "",
		}));
		if (entryRows.length) {
			groups.push({
				key: "conversation",
				label: "对话与工具",
				count: `${entryRows.length} 条`,
				tokens: entryRows.reduce((sum, row) => sum + Number(row.tokens || 0), 0),
				rows: entryRows,
			});
		}
	}

	// 6) 记忆：默认版只有预算，没有行；给浮层一个“记忆预算”卡片。
	if (isDefault && data.memory.enabled) {
		groups.push({
			key: "memory",
			label: "记忆",
			count: "预算",
			tokens: 0,
			rows: [
				{
					name: "召回预算",
					tokens: 0,
					text: "",
					note: `每轮最多 ${fmtNum(data.memory.limit)} 条 / ${fmtNum(data.memory.maxChars)} 字；默认开销按全新会话算，不含真实召回。`,
				},
			],
		});
	}

	return groups;
}

/** 浮层里的一组：组头 + 行；「全部」打开时默认收起，只列组头，想看的点「展开」。 */
function groupSectionMarkup(group, color, { foldable = false, folded = false } = {}) {
	const isFolded = foldable && folded;
	const foldButton = foldable
		? `<button class="ctx-pop-fold" type="button" data-ctx-group-fold aria-expanded="${
				isFolded ? "false" : "true"
			}">${isFolded ? "展开" : "收起"}</button>`
		: "";
	return `<div class="ctx-pop-group${isFolded ? " is-folded" : ""}">
    <div class="ctx-pop-group-head">
      <span class="ctx-dot" style="background:var(--ctx-g${((color - 1) % 6) + 1})"></span>
      <b>${esc(group.label)}</b>
      <span class="ctx-pop-group-num">${esc(group.count)} · ${fmtTokens(group.tokens)} token</span>
      ${foldButton}
    </div>
    <div class="ctx-group-body"${isFolded ? " hidden" : ""}>${group.rows.map(rowMarkup).join("")}</div>
  </div>`;
}

function ensurePopover() {
	let pop = document.getElementById("ctx-pop");
	if (pop) return pop;
	const host = document.getElementById("ctx-content");
	if (!host) return null;
	pop = document.createElement("div");
	pop.id = "ctx-pop";
	pop.className = "ctx-pop";
	pop.hidden = true;
	pop.setAttribute("role", "dialog");
	pop.setAttribute("aria-modal", "false");
	host.append(pop);
	pop.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (!target) return;
		if (target.closest("[data-ctx-pop-close]")) {
			closePopover();
			return;
		}
		const groupFold = target.closest("[data-ctx-group-fold]");
		if (groupFold) {
			togglePopGroupFold(groupFold);
			return;
		}
	});
	return pop;
}

/**
 * 浮层当前是不是正开着同一个主题（2026-11-24）：
 * 同一个格子 / 标签 / 请求行再点一次就当收起——和点浮层外面一样，不用先挪开手。
 */
function popoverShowing(key) {
	const pop = document.getElementById("ctx-pop");
	return Boolean(pop && !pop.hidden && pop.classList.contains("is-open") && key && pop.dataset.popKey === key);
}

/**
 * 从格子 / 标签下面浮起一张卡片：先量尺寸再定位，默认贴在触发点下方，
 * 下面没地方就翻到上方；transform-origin 落在触发点上，缩放看起来是从那块长出来的。
 * `key` 记这次浮的是哪个主题，供 popoverShowing 判断“再点一次收起”。
 */
function openPopover(anchor, { key = "", title, color, meta, body, footer = "" }) {
	const pop = ensurePopover();
	const host = document.getElementById("ctx-content");
	if (!pop || !host || !anchor) return;
	clearTimeout(popTimer);
	pop.dataset.popKey = key;
	pop.innerHTML = `<div class="ctx-pop-head">
      <span class="ctx-dot" style="background:var(--ctx-g${((Number(color) - 1) % 6) + 1})"></span>
      <b>${esc(title)}</b>
      <span class="ctx-pop-meta">${meta}</span>
      <button class="ctx-pop-close" type="button" data-ctx-pop-close aria-label="关闭">×</button>
    </div>
    <div class="ctx-pop-body">${body}</div>
    ${footer ? `<div class="ctx-note">${footer}</div>` : ""}`;
	pop.hidden = false;
	pop.classList.remove("is-open");
	pop.style.visibility = "hidden";
	const hostRect = host.getBoundingClientRect();
	const rect = anchor.getBoundingClientRect();
	const width = pop.offsetWidth || 380;
	const height = pop.offsetHeight || 320;
	let left = rect.left - hostRect.left + rect.width / 2 - width / 2;
	left = Math.max(10, Math.min(hostRect.width - width - 10, left));
	const below = rect.bottom - hostRect.top + 10;
	const flip = hostRect.top + below + height > window.innerHeight - 10;
	const top = Math.max(10, flip ? rect.top - hostRect.top - height - 10 : below);
	const originX = Math.max(8, Math.min(width - 8, rect.left + rect.width / 2 - hostRect.left - left));
	pop.style.left = `${Math.round(left)}px`;
	pop.style.top = `${Math.round(top)}px`;
	pop.style.transformOrigin = `${Math.round(originX)}px ${flip ? Math.round(height) : 0}px`;
	pop.style.visibility = "";
	// 量完尺寸后强制一次 layout，让 transition 从“缩着”的那一帧开始；
	// 不用 requestAnimationFrame：标签页不在前台时 rAF 会被节流，浮层会一直停在 opacity 0。
	void pop.offsetWidth;
	pop.classList.add("is-open");
}

function closePopover() {
	const pop = document.getElementById("ctx-pop");
	if (!pop || pop.hidden) return;
	pop.classList.remove("is-open");
	clearTimeout(popTimer);
	popTimer = setTimeout(() => {
		pop.hidden = true;
	}, 170);
}

/**
 * 「全部内容」里按组收起：组头（系统提示词 + 数量 + token）留着，下面的
 * 人设 / 验证铁律 / 开工前请问整段消失。再点「展开」还原。
 */
function togglePopGroupFold(button) {
	const group = button.closest(".ctx-pop-group");
	if (!group) return;
	const body = group.querySelector(".ctx-group-body");
	if (!body) return;
	const open = button.getAttribute("aria-expanded") !== "true";
	button.setAttribute("aria-expanded", String(open));
	button.textContent = open ? "收起" : "展开";
	body.hidden = !open;
	group.classList.toggle("is-folded", !open);
	// 展开后卡片一下子变高，可能掉出屏幕底；往上提回来，别让下半截点不到。
	if (open) {
		const pop = group.closest("#ctx-pop");
		if (!pop) return;
		const overflow = pop.getBoundingClientRect().bottom - (window.innerHeight - 10);
		if (overflow > 0) {
			const top = Math.max(10, parseFloat(pop.style.top || "0") - overflow);
			pop.style.top = `${Math.round(top)}px`;
		}
	}
}

function openGroup(key, anchor) {
	if (popoverShowing(key)) {
		closePopover();
		return;
	}
	if (key === "__all") {
		const total = currentParts.reduce((sum, part) => sum + part.tokens, 0);
		const body = currentGroups
			.map((group) =>
				groupSectionMarkup(group, currentParts.findIndex((part) => part.key === group.key) + 1, {
					foldable: true,
					folded: true,
				}),
			)
			.join("");
		openPopover(anchor, {
			key,
			title: "全部内容",
			color: 1,
			meta: `${currentGroups.length} 组 · ${fmtTokens(total)} token`,
			body: body || `<div class="ctx-item-empty">当前没有开销</div>`,
		});
		return;
	}
	const group = currentGroups.find((item) => item.key === key);
	const index = currentParts.findIndex((part) => part.key === key);
	const part = currentParts[index];
	const tokens = group?.tokens ?? part?.tokens ?? 0;
	// 0 token 的组（默认开销里的“记忆：预算 16 条”）不列一堆 0，只留一句话。
	const rows = Array.isArray(group?.rows) ? group.rows : [];
	const allZero = rows.every((row) => !Number(row.tokens));
	// 组名 + 数量 + token；0 token 的组用 it 自己的说明（如预算）代替“0 token”，避免“预算 · 0 token · 预算…”。
	const meta = tokens === 0 && part?.note ? part.note : `${group?.count ? `${esc(group.count)} · ` : ""}${fmtTokens(tokens)} token`;
	openPopover(anchor, {
		key,
		title: group?.label || part?.label || key,
		color: index + 1,
		meta,
		body:
			group && !allZero
				? rows.map((row) => rowMarkup(row)).join("")
				: `<div class="ctx-item-empty">当前没有开销</div>`,
	});
}

let currentPartnerIdValue = "";

/**
 * 请求与缓存（2026-11-19）：列表按服务端分页，每页 100 条、最多 500 条。
 * 只在这里保存「当前页」与最近一次返回；切会话 / 切模式都重新从第 1 页拉。
 */
let requestPage = 1;
let requestsSeq = 0;
let requestsData = null;
let requestsChatId = "";

/** 一次性系统请求的会话（目前只有开场问候）：页面顶部给一句口径提示。 */
function oneShotHintOf(conversationId) {
	const id = String(conversationId || "");
	if (id.startsWith("task-greeting-")) return "开场问候";
	return "";
}

function renderNote() {
	const note = document.getElementById("ctx-note");
	if (!note) return;
	const partnerId = currentPartnerIdValue;
	if (!partnerId) {
		const oneShot = oneShotHintOf(currentData?.conversationId);
		if (!oneShot) {
			note.hidden = true;
			note.innerHTML = "";
			return;
		}
		note.hidden = false;
		// 冷前缀是一条请求的事，不是「缓存掉了」：这条会话每次生成只跑这一条，命中率 0 属预期。
		note.innerHTML = `这是一次性系统请求（${esc(
			oneShot,
		)}）：服务端替助手发起的一次，类似定时任务到点让它自己跑一轮，不是每轮注入、也不是你说了什么。这里的第一条请求前缀从没被缓存过——命中率 0 / 慢一点都属于预期，整条请求只跑这一次。`;
		return;
	}
	note.hidden = false;
	note.innerHTML = `标了「可编辑」的段能直接改；人格模块、工具勾选与档案仍在 <button class="ctx-link" type="button" data-ctx-partner="${esc(
		partnerId,
	)}">${esc(partnerName(partnerId) || "档案页")}</button>。`;
}

function renderContext(data) {
	currentData = data;
	if (data.default) {
		syncRoleOptions(data.roles, data.role?.id);
		currentPartnerIdValue = String(data.role?.id || "").startsWith("partner:")
			? String(data.role.id).slice("partner:".length)
			: "";
	} else {
		const chat = (state.chats || []).find((item) => item && item.conversationId === data.conversationId);
		currentPartnerIdValue = partnerIdOfChat(chat) || partnerIdOfChat({ conversationId: data.conversationId });
	}
	currentGroups = buildGroups(data);
	const total = renderHero(data);
	renderNote();
	if (data.default) {
		hideCachePanel();
	} else if (data.conversationId) {
		void loadRequests(1, data.conversationId);
	}
	if (total <= 0) return;
}

function resetHero(message) {
	const totalNode = document.getElementById("ctx-total");
	if (totalNode) totalNode.textContent = "—";
	const sub = document.getElementById("ctx-sub");
	if (sub) sub.textContent = message;
	const chips = document.getElementById("ctx-chips");
	if (chips) chips.innerHTML = "";
	const waffle = document.getElementById("ctx-waffle");
	if (waffle) {
		for (const cell of waffle.children) {
			if (cell instanceof HTMLElement) {
				cell.dataset.group = "";
				cell.className = "ctx-cell is-free";
			}
		}
	}
	const meter = document.getElementById("ctx-meter");
	if (meter) meter.innerHTML = `<span class="ctx-meter-label">上一轮</span><b>—</b>`;
	const note = document.getElementById("ctx-note");
	if (note) note.hidden = true;
}

function setLoading() {
	resetHero(contextMode === "default" ? "读取默认开销…" : "读取中…");
	hideCachePanel();
	requestsSeq += 1;
}

function showError(message) {
	resetHero(message);
	const chips = document.getElementById("ctx-chips");
	if (chips) chips.innerHTML = `<span class="ctx-empty-inline">${esc(message)}</span>`;
}

// ── 请求与缓存（2026-11-19） ─────────────────────────────

function pct(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return "0%";
	return `${Math.round(number * 100)}%`;
}

function rateClass(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "is-mid";
	if (number >= 0.8) return "is-good";
	if (number >= 0.5) return "is-mid";
	return "is-bad";
}

function hideCachePanel() {
	const card = document.getElementById("ctx-cache");
	if (card) card.hidden = true;
}

function cacheError(message) {
	const list = document.getElementById("ctx-cache-list");
	if (list) list.innerHTML = `<div class="ctx-item-empty">${esc(message)}</div>`;
	const sub = document.getElementById("ctx-cache-sub");
	if (sub) sub.textContent = "读取失败";
	const rate = document.getElementById("ctx-cache-rate");
	if (rate) rate.textContent = "—";
	const pager = document.getElementById("ctx-cache-pager");
	if (pager) pager.hidden = true;
}

/** 一行请求：时间 / 模型 / prompt / 命中 / 未命中 / 输出 / 命中率；点开是详情。 */
function requestRowMarkup(row) {
	const model = String(row.model || "unknown").replace(/#.*$/, "");
	const flag = REQUEST_FLAG[row.flag];
	const flagMarkup = flag
		? `<i class="ctx-req-flag ${flag.cls}" title="${esc(flag.title)}">${flag.mark}</i>`
		: "";
	// 未命中 = prompt − 命中（即 input + cacheWrite），保证「命中 + 未命中 = prompt」。
	const missTokens = Math.max(0, Number(row.promptTokens || 0) - Number(row.cacheReadTokens || 0));
	return `<button class="ctx-req-row" type="button" data-ctx-req="${esc(String(row.entryId))}">
    <span class="ctx-req-seq">#${fmtNum(row.seq)}</span>
    <span class="ctx-req-at">${esc(fmtAt(row.at))}</span>
    <span class="ctx-req-model" title="${esc(row.model || "")}">${esc(model)}</span>
    <span class="ctx-req-num">${fmtTokens(row.promptTokens)}</span>
    <span class="ctx-req-num">${fmtTokens(row.cacheReadTokens)}</span>
    <span class="ctx-req-num">${fmtTokens(missTokens)}</span>
    <span class="ctx-req-num">${fmtTokens(row.outputTokens)}</span>
    <span class="ctx-req-rate ${rateClass(row.hitRate)}">${pct(row.hitRate)}${flagMarkup}</span>
  </button>`;
}

function renderRequests() {
	const data = requestsData;
	if (!data) return;
	const card = document.getElementById("ctx-cache");
	if (!card) return;
	card.hidden = false;
	const sub = document.getElementById("ctx-cache-sub");
	if (sub) {
		if (data.total > 0) {
			const summaryData = data.summary || {};
			const prefixChanges = Number(summaryData.prefixChanges || 0);
			const drops = Number(summaryData.drops || 0);
			const fullMisses = Number(summaryData.fullMisses || 0);
			const units = [
				`${data.truncated ? `最近 ${fmtNum(data.max)} 条里的 ` : ""}${fmtNum(data.total)} 次请求`,
				`第 ${data.page} / ${data.pages} 页`,
				`<span${prefixChanges > 0 ? ' class="is-warn"' : ""}>前缀变化 ${fmtNum(prefixChanges)} 次</span>`,
				`<span${drops > 0 ? ' class="is-warn"' : ""}>骤降 ${fmtNum(drops)} 次</span>`,
				`完全未命中 ${fmtNum(fullMisses)} 次`,
			];
			sub.innerHTML = units.join('<span class="ctx-cache-sep">·</span>');
		} else {
			sub.textContent = "还没有可统计的模型请求（聊一轮再来）";
		}
	}
	const rate = document.getElementById("ctx-cache-rate");
	if (rate) rate.textContent = data.total > 0 ? pct(data.summary.hitRate) : "—";
	const list = document.getElementById("ctx-cache-list");
	if (list) {
		if (!data.items.length) {
			list.innerHTML = `<div class="ctx-item-empty">还没有请求记录。</div>`;
		} else {
			list.innerHTML = `<div class="ctx-req-head">
          <span>#</span><span>时间</span><span>模型</span><span title="完整 prompt = 命中 + 未命中">prompt</span><span title="缓存命中读取的 token">命中</span><span title="prompt 里没被缓存命中的部分">未命中</span><span title="模型输出的 token">输出</span><span>命中率</span>
        </div>${data.items.map(requestRowMarkup).join("")}`;
		}
	}
	const pager = document.getElementById("ctx-cache-pager");
	const pages = document.getElementById("ctx-cache-pages");
	if (pager) pager.hidden = data.pages <= 1;
	if (pages) pages.textContent = `第 ${data.page} / ${data.pages} 页`;
	for (const button of document.querySelectorAll("[data-ctx-page]")) {
		const delta = button.dataset.ctxPage === "prev" ? -1 : 1;
		const target = data.page + delta;
		button.disabled = target < 1 || target > data.pages;
	}
}

async function loadRequests(page = 1, conversationId = "") {
	const card = document.getElementById("ctx-cache");
	if (!card) return;
	if (contextMode !== "session") {
		hideCachePanel();
		return;
	}
	const select = document.getElementById("ctx-chat");
	const selected = select instanceof HTMLSelectElement ? select.value : "";
	const id = conversationId || selected;
	if (!id) {
		hideCachePanel();
		return;
	}
	// 换会话时页码归零：不能拿上一条会话的第 5 页去请求新会话。
	if (requestsChatId !== id) requestPage = 1;
	requestsChatId = id;
	const targetPage = Math.max(1, Number(page) || 1);
	const seq = ++requestsSeq;
	card.hidden = false;
	const sub = document.getElementById("ctx-cache-sub");
	if (sub) sub.textContent = "读取中…";
	const list = document.getElementById("ctx-cache-list");
	if (list) list.innerHTML = `<div class="ctx-item-empty">读取中…</div>`;
	const pager = document.getElementById("ctx-cache-pager");
	if (pager) pager.hidden = true;
	try {
		const response = await request(
			`/api/v1/agent/chat/${encodeURIComponent(id)}/requests?page=${targetPage}&pageSize=100`,
			{ cache: "no-store" },
		);
		if (seq !== requestsSeq) return;
		if (response.status === 404) {
			hideCachePanel();
			return;
		}
		if (!response.ok) {
			cacheError(`读取失败（HTTP ${response.status}）。`);
			return;
		}
		const data = await response.json();
		if (seq !== requestsSeq) return;
		requestsData = data;
		requestPage = data.page;
		renderRequests();
	} catch {
		if (seq === requestsSeq) cacheError("服务暂时连不上。");
	}
}

/**
 * 消息层结论（2026-11-21）：按服务端算好的 shared / replaced / appended 转成人话。
 * 临时注入不在存档里，这里说的都是已存档的正文前缀。
 */
function messageVerdict(compare) {
	const diff = compare.messages || null;
	if (!diff) return { text: "", broke: false };
	if (diff.replaced > 0) {
		return {
			text: `已存档消息从第 ${fmtNum(diff.shared + 1)} 条起与上一条不同（旧 ${fmtNum(diff.replaced)} 条被换掉${
				diff.appended > 0 ? `、另追加 ${fmtNum(diff.appended)} 条` : ""
			}）——可缓存前缀在这里断掉`,
			broke: true,
		};
	}
	if (diff.appended > 0) {
		return {
			text: `已存档消息与上一条逐条一致，往后只追加了 ${fmtNum(diff.appended)} 条（追加不改前缀）`,
			broke: false,
		};
	}
	return { text: "已存档消息与上一条完全一致", broke: false };
}

function compareMarkup(compare, sectionLabels, hitRate) {
	if (!compare) {
		return `<div class="ctx-cache-compare">这是保留窗口里的第一条请求，没有可对比的上一条。</div>`;
	}
	const labelOf = (key) => sectionLabels.get(key) || key;
	const changes = [];
	if (compare.systemChanged) {
		const parts = [];
		if (compare.changedSections.length) parts.push(`变了 ${compare.changedSections.map(labelOf).join("、")}`);
		if (compare.addedSections.length) parts.push(`新增 ${compare.addedSections.map(labelOf).join("、")}`);
		if (compare.removedSections.length) parts.push(`移除 ${compare.removedSections.map(labelOf).join("、")}`);
		if (compare.orderChanged) parts.push("段顺序变了");
		changes.push(`system ${parts.join("；") || "正文变了"}`);
	}
	if (compare.toolsChanged) {
		const added = compare.toolsAdded.length ? `+${compare.toolsAdded.join("、")}` : "";
		const removed = compare.toolsRemoved.length ? `−${compare.toolsRemoved.join("、")}` : "";
		changes.push(`工具面 ${[added, removed].filter(Boolean).join(" ") || "声明变了"}`);
	}
	const verdict = messageVerdict(compare);
	const tail = compare.at ? `（上一条 · ${esc(fmtAt(compare.at))}）` : "";
	if (!changes.length && !verdict.broke) {
		// 0% 且前缀完全一致：把「锅在上游」写在脸上，不给“是不是我这边改了什么”留悬念。
		const attribution =
			Number(hitRate) < 0.05
				? `这条命中率 ${pct(hitRate)}——可缓存前缀其实完全一致，没命中是上游把缓存丢了（过期 / 淘汰 / 上游不稳），不是这边改了前缀`
				: "";
		const body = [verdict.text, attribution].filter(Boolean).join("；");
		return `<div class="ctx-cache-compare is-good">与上一条请求相比：固定前缀与工具面都没变${
			body ? `；${esc(body)}` : ""
		}${tail}。</div>`;
	}
	const pieces = [...changes, verdict.text].filter(Boolean);
	return `<div class="ctx-cache-compare is-warn">与上一条请求相比：${esc(pieces.join("；"))}${tail}。</div>`;
}

/** 单条请求详情：与上一条的差异 + 固定前缀 + 当时已存档的消息。 */
function requestDetailMarkup(data, seq) {
	const row = data.request;
	const labels = new Map((data.system.sections || []).map((section) => [section.key, section.label]));
	const systemRows = (data.context.system.sections || []).map((section) => ({
		name: section.label,
		tokens: section.tokens,
		text: section.empty ? "" : section.text,
		stability: section.stability,
	}));
	const messages = data.context.entries || [];
	const messageRows = messages.map((entry) => ({
		name: entry.label,
		tokens: entry.tokens,
		text: entry.text,
		chars: entry.chars,
		truncated: entry.truncated,
		seq: `#${entry.index + 1}`,
		tag: ENTRY_TAG[entry.kind] || "",
	}));
	const systemTokens = (data.context.system.sections || []).reduce(
		(sum, section) => sum + Number(section.tokens || 0),
		0,
	);
	const messageTokens = messages.reduce((sum, entry) => sum + Number(entry.tokens || 0), 0);
	const omitted = Number(data.context.entriesOmitted || 0);
	const meta = `#${fmtNum(seq)} · ${esc(fmtAt(row.at))} · ${esc(
		String(row.model || "unknown").replace(/#.*$/, ""),
	)} · prompt ${fmtTokens(row.promptTokens)} token · 命中 ${pct(row.hitRate)}`;
	return `<div class="ctx-req-detail-meta">${meta}</div>
    ${compareMarkup(data.compare, labels, row.hitRate)}
    ${groupSectionMarkup(
			{
				label: "固定前缀",
				count: `${(data.context.system.sections || []).length} 段 · 工具 ${fmtNum(data.system.tools)} 个`,
				tokens: systemTokens,
				rows: systemRows,
			},
			1,
		)}
    ${groupSectionMarkup(
			{
				label: "当时已存档的消息",
				count: `${fmtNum(data.context.entriesTotal)} 条${omitted > 0 ? `（只列最后 ${messages.length} 条）` : ""}`,
				tokens: messageTokens,
				rows: messageRows,
			},
			2,
		)}`;
}

async function openRequestDetail(entryId, anchor) {
	const id = requestsChatId;
	if (!id) return;
	const popKey = `req:${entryId}`;
	if (popoverShowing(popKey)) {
		closePopover();
		return;
	}
	const row = (requestsData?.items || []).find((item) => String(item.entryId) === String(entryId));
	openPopover(anchor, {
		key: popKey,
		title: row ? `请求 #${row.seq}` : "请求详情",
		color: 1,
		meta: row ? `${fmtAt(row.at)} · ${fmtTokens(row.promptTokens)} token` : "读取中…",
		body: `<div class="ctx-item-empty">读取这一轮上下文…</div>`,
	});
	try {
		const response = await request(
			`/api/v1/agent/chat/${encodeURIComponent(id)}/requests/${encodeURIComponent(entryId)}/context`,
			{ cache: "no-store" },
		);
		if (!response.ok) {
			// 读取期间用户可能已经点同一行收起、点了别的行或切了会话：
			// 旧响应不许把浮层重新弹出来，也不许覆盖新主题。
			if (popoverShowing(popKey)) {
				openPopover(anchor, {
					key: popKey,
					title: row ? `请求 #${row.seq}` : "请求详情",
					color: 1,
					meta: "读取失败",
					body: `<div class="ctx-item-empty">读取失败（HTTP ${response.status}）。</div>`,
				});
			}
			return;
		}
		const data = await response.json();
		if (!popoverShowing(popKey)) return;
		// 详情端点不知道列表窗口里的时序编号（seq），沿用点击那一行的——
		// 同一行从列表点进来，编号才和列表一致。
		const seq = row?.seq ?? data.request.seq;
		openPopover(anchor, {
			key: popKey,
			title: `请求 #${seq}`,
			color: 1,
			meta: `${esc(fmtAt(data.request.at))} · ${esc(String(data.request.model || "unknown").replace(/#.*$/, ""))}`,
			body: requestDetailMarkup(data, seq),
			footer: esc(data.note || ""),
		});
	} catch (error) {
		// 别把渲染错误伪装成网络错误：控制台留一行，弹层里也写清是哪一类。
		const detail = error instanceof Error ? error.message : String(error);
		console.error("[ctx] 请求详情读取失败", error);
		if (!popoverShowing(popKey)) return;
		openPopover(anchor, {
			key: popKey,
			title: row ? `请求 #${row.seq}` : "请求详情",
			color: 1,
			meta: "读取失败",
			body: `<div class="ctx-item-empty">${
				detail === "forbidden" ? "这个令牌没被接受。" : `服务暂时连不上（${esc(detail)}）。`
			}</div>`,
		});
	}
}


async function loadContext() {
	const seq = ++contextSeq;
	const isDefault = contextMode === "default";
	let url = "";
	if (isDefault) {
		const role = document.getElementById("ctx-role");
		const roleId = role instanceof HTMLSelectElement ? role.value : "chief";
		if (!roleId) {
			showError("还没有可选角色。");
			return;
		}
		url = `/api/v1/agent/context-defaults?role=${encodeURIComponent(roleId)}`;
	} else {
		const select = document.getElementById("ctx-chat");
		if (!(select instanceof HTMLSelectElement)) return;
		const conversationId = select.value;
		if (!conversationId) {
			showError("还没有会话，先聊一轮再来。");
			return;
		}
		url = `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/context-inspect`;
	}
	closePopover();
	setLoading();
	try {
		const response = await request(url, { cache: "no-store" });
		if (seq !== contextSeq) return;
		if (response.status === 404) {
			showError(isDefault ? "默认开销读不到。" : "这个会话读不到上下文。");
			return;
		}
		if (!response.ok) {
			showError(`读取失败（HTTP ${response.status}）。`);
			return;
		}
		const data = await response.json();
		if (seq !== contextSeq) return;
		renderContext(data);
	} catch (error) {
		if (seq !== contextSeq) return;
		const detail = error instanceof Error ? error.message : String(error);
		showError(detail === "forbidden" ? "这个令牌没被接受。" : "服务暂时连不上。");
	}
}

function setMode(mode) {
	if (mode !== "session" && mode !== "default") return;
	contextMode = mode;
	const root = document.getElementById("ctx-content");
	if (root) root.dataset.mode = mode;
	for (const button of document.querySelectorAll("[data-ctx-mode]")) {
		button.setAttribute("aria-checked", String(button.dataset.ctxMode === mode));
	}
	const unit = document.getElementById("ctx-total-unit");
	if (unit) unit.textContent = mode === "default" ? "token · 默认基线" : "token · 已注入";
	const chat = document.getElementById("ctx-chat");
	if (chat) chat.hidden = mode !== "session";
	const role = document.getElementById("ctx-role");
	if (role) role.hidden = mode !== "default";
	const scale = document.querySelector(".ctx-scale");
	if (scale) scale.hidden = mode !== "session";
	closePopover();
	// 切模式 / 切会话时取消在途的请求列表：旧返回不能写进新 DOM。
	requestsData = null;
	requestsSeq += 1;
	if (mode === "default") hideCachePanel();
	void loadContext();
}

function toggleRow(button) {
	const row = button.closest(".ctx-row");
	const body = row?.querySelector(".ctx-row-body");
	if (!row || !body) return;
	const open = button.getAttribute("aria-expanded") !== "true";
	button.setAttribute("aria-expanded", String(open));
	body.hidden = !open;
	row.classList.toggle("is-open", open);
}

/** 悬停某组：格子与标签一起亮，其它的压暗——比单纯一个图例更容易看出“这块属于谁”。 */
function focusGroup(key) {
	// 0 token 的组（默认开销里的「记忆」）在棋盘上根本没有格子：这时只亮标签，
	// 不能把整张图都压暗，否则看着像所有块都被取消选中了。
	const cells = document.querySelectorAll(".ctx-cell");
	const painted = Boolean(key) && Array.from(cells).some((cell) => cell.dataset.group === key);
	const waffle = document.getElementById("ctx-waffle");
	if (waffle) {
		if (key && painted) waffle.dataset.f = key;
		else delete waffle.dataset.f;
	}
	for (const cell of cells) {
		cell.classList.toggle("is-focus", painted && cell.dataset.group === key);
	}
	for (const chip of document.querySelectorAll("[data-ctx-chip]")) {
		chip.classList.toggle("is-focus", chip.dataset.ctxChip === key);
	}
}

/**
 * 这一页当前在改谁：默认开销直接看选中的角色；当前会话从会话 id 认执事，
 * 认不到再按 chatKind 落总管 / worker。
 */
function currentEditRole() {
	const data = currentData;
	if (!data) return null;
	if (data.default) {
		const roleId = String(data.role?.id || "chief");
		return {
			roleId,
			partnerId: roleId.startsWith("partner:") ? roleId.slice("partner:".length) : "",
		};
	}
	const chat = (state.chats || []).find((item) => item && item.conversationId === data.conversationId);
	const partnerId =
		partnerIdOfChat(chat) ||
		partnerIdOfChat({ conversationId: data.conversationId }) ||
		currentPartnerIdValue;
	if (partnerId) return { roleId: `partner:${partnerId}`, partnerId };
	return { roleId: data.chatKind === "worker" ? "worker" : "chief", partnerId: "" };
}

/** 展开行里的「改这一节」：找到这一段的原文与角色，打开对应源头的编辑弹层。 */
function openEditorFor(key) {
	if (!key) return;
	const group = currentGroups.find((item) => (item.rows || []).some((row) => row.key === key));
	const row = group?.rows.find((item) => item.key === key);
	if (!row) return;
	const role = currentEditRole();
	if (!role) {
		toast("先选一个会话或角色，再改这一节");
		return;
	}
	closePopover();
	void openContextSectionEditor(
		{
			key,
			label: row.name,
			text: String(row.text || ""),
			roleId: role.roleId,
			partnerId: role.partnerId,
		},
		() => {
			void loadContext();
		},
	);
}

function wireClicks() {
	const root = document.getElementById("ctx-content");
	if (!root) return;
	root.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (!target) return;
		const modeButton = target.closest("[data-ctx-mode]");
		if (modeButton) {
			setMode(modeButton.dataset.ctxMode);
			return;
		}
		// 页面上铺开的行与浮层里的行共用一套收展（2026-11-23 起正文段也在页面上）。
		const rowHead = target.closest("[data-ctx-row]");
		if (rowHead) {
			toggleRow(rowHead);
			return;
		}
		// 2026-11-21：可编辑段的「改这一节」——就地改源头，保存后刷新这一页。
		const editButton = target.closest("[data-ctx-edit]");
		if (editButton) {
			openEditorFor(editButton.dataset.ctxEdit || "");
			return;
		}
		const scaleButton = target.closest("[data-ctx-scale]");
		if (scaleButton) {
			const value = scaleButton.dataset.ctxScale === "window" ? "window" : "composition";
			if (value !== waffleScale) {
				waffleScale = value;
				try {
					localStorage.setItem(WAFFLE_SCALE_KEY, value);
				} catch {
					/* 存不进去也不影响这一次怎么画 */
				}
				for (const button of document.querySelectorAll("[data-ctx-scale]")) {
					button.setAttribute("aria-checked", String(button.dataset.ctxScale === value));
				}
				closePopover();
				if (currentData) renderHero(currentData);
			}
			return;
		}
		// 请求与缓存：翻页 / 点一行看当时上下文（2026-11-19）。
		const pageButton = target.closest("[data-ctx-page]");
		if (pageButton) {
			const delta = pageButton.dataset.ctxPage === "prev" ? -1 : 1;
			const targetPage = Math.max(1, requestPage + delta);
			if (!(pageButton instanceof HTMLButtonElement) || !pageButton.disabled) {
				void loadRequests(targetPage);
			}
			return;
		}
		const requestButton = target.closest("[data-ctx-req]");
		if (requestButton) {
			const entryId = requestButton.dataset.ctxReq || "";
			if (entryId) void openRequestDetail(entryId, requestButton);
			return;
		}
		const openButton = target.closest("[data-ctx-open]");
		if (openButton) {
			openGroup(openButton.dataset.ctxOpen || "", openButton);
			return;
		}
		const cell = target.closest(".ctx-cell");
		if (cell && cell.dataset.group) {
			openGroup(cell.dataset.group, cell);
			return;
		}
		const partnerButton = target.closest("[data-ctx-partner]");
		if (partnerButton) {
			const partnerId = partnerButton.dataset.ctxPartner || "";
			if (partnerId) location.hash = `#/settings/partners/${encodeURIComponent(partnerId)}`;
			return;
		}
		// 点浮层外面 = 收起来
		const pop = document.getElementById("ctx-pop");
		if (pop && !pop.hidden && !pop.contains(target)) closePopover();
	});	root.addEventListener("pointerover", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const cell = target?.closest(".ctx-cell");
		if (cell?.dataset.group) {
			focusGroup(cell.dataset.group);
			return;
		}
		const chip = target?.closest("[data-ctx-chip]");
		if (chip) focusGroup(chip.dataset.ctxChip || "");
	});
	root.addEventListener("pointerout", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (!(target?.closest(".ctx-cell") || target?.closest("[data-ctx-chip]"))) return;
		const related = event.relatedTarget instanceof Element ? event.relatedTarget : null;
		if (related?.closest("[data-ctx-chip]") || related?.closest(".ctx-cell")) return;
		focusGroup("");
	});
	const select = document.getElementById("ctx-chat");
	if (select instanceof HTMLSelectElement) {
		select.addEventListener("change", () => void loadContext());
	}
	const role = document.getElementById("ctx-role");
	if (role instanceof HTMLSelectElement) {
		role.addEventListener("change", () => void loadContext());
	}
	document.getElementById("ctx-refresh")?.addEventListener("click", () => void loadContext());
	// 全局监听只挂一次：设置页会反复重渲染，重复挂会攒出一堆同样的回调。
	if (!globalWired) {
		globalWired = true;
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape") closePopover();
		});
		// 卡片外面的任何点击（包括设置页侧栏、顶栏）都要收起来；页面内那一处监听只管卡片自身。
		document.addEventListener("pointerdown", (event) => {
			const pop = document.getElementById("ctx-pop");
			if (!pop || pop.hidden) return;
			const target = event.target instanceof Element ? event.target : null;
			if (!target) return;
			if (pop.contains(target)) return;
			if (target.closest(".ctx-cell") || target.closest("[data-ctx-open]") || target.closest("[data-ctx-req]")) {
				return;
			}
			closePopover();
		});
		window.addEventListener("resize", closePopover);
		// 窗口变宽/变窄时列数要重排，否则格子会被拉成横条。
		window.addEventListener("resize", () => {
			fitWaffleColumns();
			if (Array.isArray(currentParts) && currentParts.length) paintWaffle(currentParts, currentBase);
		});
	}
}

let globalWired = false;

function syncRoleOptions(roles, selected) {
	const select = document.getElementById("ctx-role");
	if (!(select instanceof HTMLSelectElement) || !Array.isArray(roles) || roles.length === 0) return;
	const current = roles.some((role) => role.id === selected) ? selected : roles[0].id;
	select.innerHTML = roleOptionMarkup(roles, current);
}

function wireContextSettings() {
	// 只在这个设置页活着时接线：路由已经不是 settings/context 就不挂。
	if (currentRoute() !== "settings") return;
	wireClicks();
	void loadContext();
}

export { contextSettingsMarkup, wireContextSettings };
