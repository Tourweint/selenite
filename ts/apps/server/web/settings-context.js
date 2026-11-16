/**
 * 设置 → 上下文（2026-11-16）
 *
 * 只读展示当前会话每轮开头那四块：系统提示词 / 工具定义 / 技能 / 记忆。
 * 会变的部分单独一块，只报数量；正文不搬到设置页。
 * 口径与端点见 docs/设计方案/2026-11-16-设置上下文页（固定前缀查看）.md。
 */

import { esc } from "./markdown.js";
import { request } from "./net.js";
import { currentRoute, go } from "./route.js";
import { sectionMarkup } from "./settings-atoms.js";
import { state } from "./state.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

const KIND_LABEL = { chief: "总管", worker: "普通", partner: "执事" };
const STABILITY = {
	fixed: { label: "固定", cls: "is-fixed" },
	session: { label: "按会话冻结", cls: "is-session" },
	turn: { label: "每轮现算", cls: "is-turn" },
};

/** 默认页逐节显示的纪律；顺序与宿主注入顺序一致。window 端只允许改这七节。 */
const DISCIPLINE_EDIT_SECTIONS = [
	{ key: "partner_verification", title: "验证铁律" },
	{ key: "partner_ruling", title: "裁决纪律" },
	{ key: "partner_work_silence", title: "干活期间" },
	{ key: "partner_grounding", title: "答案接地" },
	{ key: "partner_artifact_handoff", title: "产物交接" },
	{ key: "partner_brief_card", title: "汇报卡" },
	{ key: "partner_attention", title: "提问纪律" },
];
const DISCIPLINE_TITLE_BY_KEY = new Map(DISCIPLINE_EDIT_SECTIONS.map((item) => [item.key, item.title]));
const DISCIPLINE_ORDER = DISCIPLINE_EDIT_SECTIONS.map((item) => item.title);
const DISCIPLINE_TITLE_SET = new Set(DISCIPLINE_ORDER);

let contextSeq = 0;
/** session = 看一条当前会话；default = 看每个角色的默认开销（不需要聊天）。 */
let contextMode = "session";

function chatKindLabel(chat) {
	if (chat?.chatKind && KIND_LABEL[chat.chatKind]) return KIND_LABEL[chat.chatKind];
	const id = String(chat?.conversationId || "");
	if (id.startsWith("partner-")) return "执事";
	if (id.startsWith("task-")) return "任务";
	return "会话";
}

function chatChoices() {
	const rows = (state.chats || [])
		.filter((chat) => chat && chat.conversationId)
		.slice()
		.sort((left, right) => (right.lastAt || 0) - (left.lastAt || 0));
	const current = state.conversationId;
	if (current && !rows.some((chat) => chat.conversationId === current)) {
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
	if (state.conversationId && choices.some((chat) => chat.conversationId === state.conversationId)) {
		return state.conversationId;
	}
	return choices[0]?.conversationId || "";
}

/** 默认开销的角色：总管 → 活跃执事 → 普通 worker。服务端还会回一份完整 roles，用于校正这里的花名册。 */
function defaultRoleChoices() {
	const roles = [{ id: "chief", label: "总管" }];
	for (const partner of state.partners || []) {
		if (!partner || partner.status !== "active" || partner.id === "chief") continue;
		roles.push({ id: `partner:${partner.id}`, label: partner.name || "执事" });
	}
	roles.push({ id: "worker", label: "普通 worker" });
	return roles;
}

/** 默认页的执事 id：只给 partner: 前缀的角色；总管 / worker 没有可编辑契约。 */
function partnerIdOfRole(role) {
	if (!role || role.kind !== "partner" || typeof role.id !== "string") return "";
	return role.id.startsWith("partner:") ? role.id.slice("partner:".length) : "";
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

function firstLine(text, max = 88) {
	const line = String(text || "").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function badgeMarkup(stability) {
	const meta = STABILITY[stability] || STABILITY.fixed;
	return `<span class="ctx-badge ${meta.cls}">${meta.label}</span>`;
}

function extraBadgeMarkup(editable, empty) {
	return `${editable ? '<span class="ctx-badge is-editable">可编辑</span>' : ""}${empty ? '<span class="ctx-badge is-empty">空字段</span>' : ""}`;
}

function textBlock(text) {
	return `<pre class="ctx-text">${esc(text || "")}</pre>`;
}

function itemMarkup({ name, badge = "", desc = "", tokens = 0, body = "", nameClass = "", toolKey = "", editable = false, empty = false, editKey = "", editPartner = "", editTitle = "" }) {
	const editRow = editKey
		? `<div class="ctx-edit-row"><button class="ctx-link" type="button" data-ctx-discipline="${esc(editKey)}" data-ctx-discipline-partner="${esc(editPartner)}" data-ctx-discipline-title="${esc(editTitle)}">改这一节</button></div>`
		: "";
	return `<div class="ctx-item"${toolKey ? ` data-tool-key="${esc(toolKey.toLowerCase())}" data-tool-tokens="${tokens}"` : ""}>
    <button class="ctx-item-head" type="button" data-ctx-toggle aria-expanded="false">
      <span class="ctx-item-name ${nameClass}">${name}</span>
      ${badge}${extraBadgeMarkup(editable, empty)}
      <span class="ctx-item-desc">${desc}</span>
      <span class="ctx-item-tokens">${fmtTokens(tokens)} token</span>
      <svg class="ctx-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    ${editRow}
    <div class="ctx-item-body" hidden>${body}</div>
  </div>`;
}

function emptyMarkup(text) {
	return `<div class="ctx-empty">${text}</div>`;
}

function loadingMarkup() {
	return `<div class="ctx-loading">读取中…</div>`;
}

function toolbarMarkup(mode, choices, selected, roles, role) {
	const options = choices.length
		? choices
				.map(
					(chat) =>
						`<option value="${esc(chat.conversationId)}"${chat.conversationId === selected ? " selected" : ""}>${esc(
							(chat.title || "未命名会话").slice(0, 48),
						)} · ${chatKindLabel(chat)}</option>`,
				)
				.join("")
		: `<option value="">还没有会话</option>`;
	return `<div class="ctx-toolbar">
    <div class="ctx-mode" role="radiogroup" aria-label="上下文视图">
      <button type="button" data-ctx-mode="session" aria-checked="${mode === "session"}">当前会话</button>
      <button type="button" data-ctx-mode="default" aria-checked="${mode === "default"}">默认开销</button>
    </div>
    <select class="set-input ctx-select" id="ctx-chat" ${mode === "session" && choices.length ? "" : "hidden"} ${choices.length ? "" : "disabled"} aria-label="选择要查看上下文的会话">${options}</select>
    <select class="set-input ctx-select" id="ctx-role" ${mode === "default" ? "" : "hidden"} aria-label="选择要查看默认开销的角色">${roleOptionMarkup(roles, role)}</select>
    <button class="ghost ctx-refresh" type="button" id="ctx-refresh">刷新</button>
  </div>`;
}

function heroMarkup() {
	return `<div class="card ctx-hero" id="ctx-hero">
    <div class="ctx-hero-top">
      <div class="ctx-hero-copy">
        <div class="ctx-total"><b id="ctx-total">—</b><span>token · 固定前缀</span></div>
        <div class="ctx-sub" id="ctx-sub">选择会话后读取…</div>
      </div>
      <div class="ctx-hero-side">
        <div class="ctx-meter" id="ctx-meter"><span class="ctx-meter-label">上一轮</span><b>—</b></div>
      </div>
    </div>
    <div class="ctx-stack" id="ctx-stack"><span class="ctx-stack-empty"></span></div>
    <ul class="ctx-legend" id="ctx-legend"></ul>
  </div>`;
}

/**
 * 页骨架。每次设置页重渲染都会重新进来，这里把旧请求代号 +1，
 * 让还没回来的 fetch 不再往新 DOM 里写。
 */
function contextSettingsMarkup() {
	contextSeq += 1;
	const choices = chatChoices();
	const selected = selectedChatId(choices);
	// 只有「当前会话」兜底、没有任何真实会话记录时直接进默认开销：
	// 用户不聊天也能看到总管基线，不必先点模式按钮。
	const hasRealChats = (state.chats || []).some((chat) => chat && chat.conversationId);
	contextMode = hasRealChats ? "session" : "default";
	const roles = defaultRoleChoices();
	const selectedRole = roles[0]?.id || "chief";
	const hasChat = contextMode === "default" || Boolean(selected);
	return `<div id="ctx-content" data-mode="${contextMode}">
    ${sectionMarkup("上下文", heroMarkup(), "", toolbarMarkup(contextMode, choices, selected, roles, selectedRole))}
    ${sectionMarkup(
			"系统提示词",
			`<div class="card" id="ctx-system">${hasChat ? loadingMarkup() : emptyMarkup("还没有会话，先聊一轮再来。")}</div>`,
			'id="ctx-sec-system"',
			`<div class="ctx-head-actions"><span class="ctx-count" id="ctx-system-count"></span><button class="ghost" type="button" data-ctx-toggle-all="system">展开全部</button></div>`,
		)}
    ${sectionMarkup(
			"工具定义",
			`<div class="card" id="ctx-tools">${hasChat ? loadingMarkup() : emptyMarkup("还没有会话，先聊一轮再来。")}</div>`,
			'id="ctx-sec-tools"',
			`<div class="ctx-head-actions">
         <input class="set-input ctx-filter" id="ctx-tool-filter" type="search" placeholder="筛工具名或说明" aria-label="筛选工具" />
         <span class="ctx-count" id="ctx-tools-count"></span>
         <button class="ghost" type="button" data-ctx-toggle-all="tools">展开全部</button>
       </div>`,
		)}
    ${sectionMarkup(
			"技能",
			`<div class="card" id="ctx-skills">${hasChat ? loadingMarkup() : emptyMarkup("还没有会话，先聊一轮再来。")}</div>`,
			'id="ctx-sec-skills"',
			`<div class="ctx-head-actions"><span class="ctx-count" id="ctx-skills-count"></span><button class="ghost" type="button" data-ctx-go="skills">管理技能</button></div>`,
		)}
    ${sectionMarkup(
			"记忆",
			`<div class="card" id="ctx-memory">${hasChat ? loadingMarkup() : emptyMarkup("还没有会话，先聊一轮再来。")}</div>`,
			'id="ctx-sec-memory"',
			`<div class="ctx-head-actions"><span class="ctx-count" id="ctx-memory-count"></span><button class="ghost" type="button" data-ctx-go="memory">管理记忆</button></div>`,
		)}
    ${sectionMarkup(
			"会变的部分",
			`<div class="card ctx-change-card" id="ctx-changing">${hasChat ? loadingMarkup() : emptyMarkup("还没有会话，先聊一轮再来。")}</div>`,
			'id="ctx-sec-changing"',
		)}
  </div>`;
}

function setCount(id, text) {
	const node = document.getElementById(id);
	if (node) node.textContent = text;
}

function renderHero(data) {
	const isDefault = Boolean(data.default);
	const memoryTokens = data.memory.last?.tokens ?? 0;
	const parts = [
		{ key: "system", label: "系统提示词", tokens: data.system.tokens, note: "" },
		{ key: "tools", label: "工具定义", tokens: data.tools.tokens, note: "" },
		{ key: "skills", label: "技能", tokens: data.skills.tokens, note: "" },
		{
			key: "memory",
			label: "记忆",
			tokens: memoryTokens,
			note: isDefault ? `预算 ${fmtNum(data.memory.limit)} 条` : "",
		},
	];
	const total = parts.reduce((sum, part) => sum + part.tokens, 0);
	const totalNode = document.getElementById("ctx-total");
	if (totalNode) totalNode.textContent = total > 0 ? `≈${fmtNum(total)}` : "—";

	const sub = document.getElementById("ctx-sub");
	if (sub) {
		const memoryText = isDefault
			? `记忆预算 ${fmtNum(data.memory.limit)} 条 / ${fmtNum(data.memory.maxChars)} 字`
			: data.memory.enabled
				? data.memory.last
					? data.memory.last.items > 0
						? `记忆 ${data.memory.last.items} 条`
						: "记忆未召回"
					: "记忆待下一轮"
				: "记忆未启用";
		sub.textContent =
			total > 0
				? isDefault
					? `${data.role?.label || "默认"} · 系统 ${data.system.sections.length + 1} 个字段 · 工具 ${data.tools.count} 个 · 技能 ${data.skills.count} 个 · ${memoryText}`
					: `系统 ${data.system.sections.length + 1} 段 · 工具 ${data.tools.count} 个 · 技能 ${data.skills.count} 个 · ${memoryText}`
				: "这个会话还没有可读的上下文";
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

	const stack = document.getElementById("ctx-stack");
	const legend = document.getElementById("ctx-legend");
	if (stack) {
		stack.innerHTML =
			total > 0
				? parts
						.filter((part) => part.tokens > 0)
						.map(
							(part) =>
								`<span class="ctx-seg" style="width:${(part.tokens / total) * 100}%;background:var(--ctx-seg-${parts.indexOf(part) + 1})"></span>`,
						)
						.join("")
				: `<span class="ctx-stack-empty"></span>`;
	}
	if (legend) {
		legend.innerHTML =
			total > 0
				? parts
						.map(
							(part, index) =>
								`<li><span class="ctx-dot" style="background:var(--ctx-seg-${(index % 6) + 1})"></span><span class="ctx-name">${part.label}</span><span class="ctx-num">${part.note ? esc(part.note) : `${fmtTokens(part.tokens)} token · ${Math.round((part.tokens / total) * 100)}%`}</span></li>`,
						)
						.join("")
				: "";
	}
	return total;
}

function parseDisciplineSource(source) {
	const sections = new Map();
	let current = null;
	let buffer = [];
	const flush = () => {
		if (current) sections.set(current, buffer.join("\n").trim());
		buffer = [];
	};
	for (const line of String(source || "").split(/\r?\n/)) {
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			flush();
			const title = heading[1] || "";
			current = DISCIPLINE_TITLE_SET.has(title) ? title : null;
			continue;
		}
		if (current) buffer.push(line);
	}
	flush();
	return sections;
}

function serializeDisciplineSource(sections) {
	return DISCIPLINE_ORDER
		.filter((title) => sections.has(title))
		.map((title) => `## ${title}\n${String(sections.get(title) || "").trim()}`.trim())
		.join("\n\n");
}

/**
 * 默认页逐节编辑：只改当前标题，其他已覆盖的节原样保留。
 * 没有覆盖时只写这一节，不把整份宿主默认抄成覆盖文件。
 */
function openDisciplineEditor(partnerId, key, title) {
	if (!partnerId || !DISCIPLINE_TITLE_BY_KEY.has(key)) return;
	openModal(`改纪律 · ${title}`, (body) => {
		body.innerHTML = `
      <div id="ctx-disc-loading" class="modal-hint">读取中…</div>
      <div id="ctx-disc-editor" hidden>
        <textarea class="pf-contract" id="ctx-disc-text" rows="10" spellcheck="false" aria-label="纪律这一节"></textarea>
        <p class="modal-hint" id="ctx-disc-hint"></p>
        <div id="ctx-disc-red" hidden>
          <p class="pf-inject-readonly-title">主人数据红线（固定）</p>
          <pre class="pf-inject-text" id="ctx-disc-red-text"></pre>
        </div>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>关闭</button>
          <button class="ghost" type="button" id="ctx-disc-reset" disabled>撤销</button>
          <button class="ghost" type="button" id="ctx-disc-restore" disabled>恢复这一节默认</button>
          <button class="btn-primary" type="button" id="ctx-disc-save" disabled>保存</button>
        </div>
      </div>`;
		const loading = body.querySelector("#ctx-disc-loading");
		const editor = body.querySelector("#ctx-disc-editor");
		const area = body.querySelector("#ctx-disc-text");
		const hint = body.querySelector("#ctx-disc-hint");
		const red = body.querySelector("#ctx-disc-red");
		const redText = body.querySelector("#ctx-disc-red-text");
		const save = body.querySelector("#ctx-disc-save");
		const reset = body.querySelector("#ctx-disc-reset");
		const restore = body.querySelector("#ctx-disc-restore");
		let sections = new Map();
		let original = "";
		let saving = false;
		let loaded = false;
		const setHint = (text, bad = false) => {
			if (!hint) return;
			hint.textContent = text || "";
			hint.classList.toggle("is-bad", Boolean(bad));
		};
		const refresh = () => {
			const dirty = Boolean(area) && area.value !== original;
			if (save) save.disabled = !loaded || saving || !dirty;
			if (reset) reset.disabled = !loaded || saving || !dirty;
			if (restore) restore.disabled = !loaded || saving || !sections.has(title);
		};
		const saveSource = async (source, successMessage) => {
			if (saving) return;
			saving = true;
			setHint("保存中…");
			refresh();
			try {
				const response = source.trim()
					? await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/discipline`, {
							method: "PUT",
							body: JSON.stringify({ discipline: source }),
							cache: "no-store",
						})
					: await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/discipline`, {
							method: "DELETE",
							cache: "no-store",
						});
				const data = await response.json().catch(() => ({}));
				if (!response.ok || !data.ok) {
					throw new Error(data.message || data.error || `HTTP ${response.status}`);
				}
				toast(successMessage);
				closeModal();
				void loadContext();
			} catch (error) {
				setHint(`没存成：${error instanceof Error ? error.message : String(error)}`, true);
				saving = false;
				refresh();
			}
		};
		body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal());
		area?.addEventListener("input", () => {
			setHint("");
			refresh();
		});
		reset?.addEventListener("click", () => {
			if (!area) return;
			area.value = original;
			setHint("");
			refresh();
		});
		restore?.addEventListener("click", () => {
			if (!sections.has(title)) {
				setHint("这一节本来就在用宿主默认。");
				return;
			}
			const next = new Map(sections);
			next.delete(title);
			void saveSource(serializeDisciplineSource(next), `已恢复「${title}」的宿主默认`);
		});
		save?.addEventListener("click", () => {
			if (!area || !loaded) return;
			const next = new Map(sections);
			// 显式保留标题（正文可为空）：空节 = 删除这一条，而不是回默认。
			next.set(title, area.value.trim());
			void saveSource(serializeDisciplineSource(next), area.value.trim() ? "纪律这一节已保存" : "已清空这一节覆盖");
		});
		void (async () => {
			try {
				const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/discipline`, {
					cache: "no-store",
				});
				const data = await response.json().catch(() => ({}));
				if (!response.ok || !data.ok) {
					throw new Error(data.message || data.error || `HTTP ${response.status}`);
				}
				if (!data.editable) {
					throw new Error("纪律覆盖未启用（PARTNER_DISCIPLINE_EDIT=false）");
				}
				const override = String(data.override || "");
				const fallback = String(data.defaultDiscipline || "");
				sections = parseDisciplineSource(override);
				const defaultSections = parseDisciplineSource(fallback);
				original = sections.get(title) ?? defaultSections.get(title) ?? "";
				if (area) area.value = original;
				if (data.redLine && red && redText) {
					red.hidden = false;
					redText.textContent = String(data.redLine);
				}
				loaded = true;
				if (loading) loading.hidden = true;
				if (editor) editor.hidden = false;
				refresh();
			} catch (error) {
				if (loading) loading.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
			}
		})();
	});
}

function renderSystem(data) {
	const card = document.getElementById("ctx-system");
	if (!card) return;
	const partnerId = data.default ? partnerIdOfRole(data.role) : "";
	const items = [];
	// 系统底稿也是系统提示词的一层：空的时候不能整行消失，
	// 否则用户会以为“没有这个字段”，而不是“这个字段是 0 token”。
	const base = data.system.content || "";
	// 服务端只给 system.tokens 总数；底稿这一行用它减掉各 section（每段各自向上取整）。
	const baseTokens =
		Number(data.system.tokens || 0) -
		data.system.sections.reduce((sum, section) => sum + Number(section.tokens || 0), 0);
	items.push(
		itemMarkup({
			name: "系统底稿",
			badge: badgeMarkup("fixed"),
			desc: "",
			tokens: Math.max(0, baseTokens),
			empty: !base,
			body: base ? textBlock(base) : "",
		}),
	);
	for (const section of data.system.sections) {
		const empty = Boolean(section.empty);
		const editKey = partnerId && DISCIPLINE_TITLE_BY_KEY.has(section.key) ? section.key : "";
		const editTitle = editKey ? DISCIPLINE_TITLE_BY_KEY.get(editKey) : "";
		items.push(
			itemMarkup({
				name: esc(section.label),
				badge: badgeMarkup(section.stability),
				desc: esc(section.key),
				tokens: section.tokens,
				editable: Boolean(section.editable),
				empty,
				editKey,
				editPartner: partnerId,
				editTitle,
				body: empty ? "" : textBlock(section.text),
			}),
		);
	}
	setCount("ctx-system-count", `${items.length} ${data.default ? "个字段" : "段"} · ${fmtTokens(data.system.tokens)} token`);
	const editLink = partnerId
		? `<div class="ctx-note"><button class="ctx-link" type="button" data-ctx-partner="${esc(partnerId)}">去档案页逐节改</button></div>`
		: "";
	card.innerHTML = items.length
		? `${items.join("")}${editLink}`
		: emptyMarkup(data.default ? "这个角色还没有系统提示词段。" : "这个会话还没有系统提示词段。");
}

function renderTools(data) {
	const card = document.getElementById("ctx-tools");
	if (!card) return;
	card.dataset.toolCount = String(data.tools.count);
	card.dataset.toolTokens = String(data.tools.tokens);
	const items = data.tools.items.map((tool) =>
		itemMarkup({
			name: esc(tool.name),
			badge: "",
			desc: esc(firstLine(tool.description)),
			tokens: tool.tokens,
			body: textBlock(tool.schema),
			nameClass: "ctx-mono",
			toolKey: `${tool.name} ${tool.description}`,
		}),
	);
	card.innerHTML = items.length
		? `${items.join("")}<div class="ctx-empty ctx-filter-empty" id="ctx-tools-empty" hidden>没有匹配的工具，换个词试试。</div>`
		: emptyMarkup(data.default ? "这个角色没有挂工具。" : "这个会话没有挂工具（或工具投影还没生成）。");
	applyToolFilter(document.getElementById("ctx-tool-filter")?.value || "");
}

function renderSkills(data) {
	const card = document.getElementById("ctx-skills");
	if (!card) return;
	setCount("ctx-skills-count", `${data.skills.count} 个 · ${fmtTokens(data.skills.tokens)} token`);
	card.innerHTML = data.skills.text
		? `${itemMarkup({
				name: "技能索引",
				badge: badgeMarkup(data.default ? "fixed" : "session"),
				desc: `${data.skills.count} 个技能`,
				tokens: data.skills.tokens,
				body: textBlock(data.skills.text),
			})}`
		: emptyMarkup(data.default ? "这个角色当前没有可见技能。" : "当前会话没有启用任何技能。");
}

function renderMemory(data) {
	const card = document.getElementById("ctx-memory");
	if (!card) return;
	const isDefault = Boolean(data.default);
	const last = data.memory.last;
	setCount(
		"ctx-memory-count",
		isDefault
			? `预算 ${fmtNum(data.memory.limit)} 条`
			: last
				? `${last.items} 条 · ${fmtTokens(last.tokens)} token`
				: "待下一轮",
	);
	const meta = `<div class="ctx-meta-row">
      <span>预算 ${fmtNum(data.memory.limit)} 条 / ${fmtNum(data.memory.maxChars)} 字</span>
      ${last ? `<span>上一次注入 ${fmtAt(last.at)}</span>` : ""}
    </div>`;
	if (!data.memory.enabled) {
		card.innerHTML = `${meta}${emptyMarkup("记忆未启用。")}`;
		return;
	}
	if (isDefault) {
		card.innerHTML = `${meta}`;
		return;
	}
	if (!last) {
		card.innerHTML = `${meta}${emptyMarkup("本轮尚未注入记忆。")}`;
		return;
	}
	if (!last.text) {
		card.innerHTML = `${meta}${emptyMarkup("上一轮没有召回记忆。")}`;
		return;
	}
	card.innerHTML = `${meta}${itemMarkup({
		name: "本轮召回的记忆",
		badge: badgeMarkup("turn"),
		desc: "按本轮用户消息临时插入",
		tokens: last.tokens,
		body: textBlock(last.text),
	})}`;
}

function renderChanging(data) {
	const card = document.getElementById("ctx-changing");
	if (!card) return;
	const changing = data.changing;
	const others = data.memory.last?.others ?? [];
	const otherMarkup = others.length
		? `<div class="ctx-other"><span class="ctx-other-label">另注入</span>${others
				.map((item) => `<span class="ctx-chip">${esc(item.id)} · ${fmtTokens(item.tokens)} token</span>`)
				.join("")}</div>`
		: "";
	card.innerHTML = `<div class="ctx-change-grid">
      <div class="ctx-change-cell"><b>${fmtNum(changing.messages.count)}</b><span>对话消息 · ${fmtTokens(changing.messages.tokens)} token</span></div>
      <div class="ctx-change-cell"><b>${fmtNum(changing.toolCalls.count)}</b><span>工具调用 · ${fmtTokens(changing.toolCalls.tokens)} token</span></div>
      <div class="ctx-change-cell"><b>${fmtNum(changing.toolResults.count)}</b><span>工具结果 · ${fmtTokens(changing.toolResults.tokens)} token</span></div>
    </div>
    ${otherMarkup}`;
}

function syncRoleOptions(roles, selected) {
	const select = document.getElementById("ctx-role");
	if (!(select instanceof HTMLSelectElement) || !Array.isArray(roles) || roles.length === 0) return;
	const current = roles.some((role) => role.id === selected) ? selected : roles[0].id;
	select.innerHTML = roleOptionMarkup(roles, current);
}

function renderContext(data) {
	const isDefault = Boolean(data.default);
	if (isDefault) {
		syncRoleOptions(data.roles, data.role?.id);
	}
	const total = renderHero(data);
	const isEmpty = total <= 0;
	for (const id of ["ctx-sec-system", "ctx-sec-tools", "ctx-sec-skills", "ctx-sec-memory", "ctx-sec-changing"]) {
		const section = document.getElementById(id);
		if (section) section.hidden = isEmpty;
	}
	if (isEmpty) {
		for (const id of ["ctx-system-count", "ctx-tools-count", "ctx-skills-count", "ctx-memory-count"]) {
			setCount(id, "");
		}
		return;
	}
	renderSystem(data);
	renderTools(data);
	renderSkills(data);
	renderMemory(data);
	if (isDefault) {
		const changing = document.getElementById("ctx-sec-changing");
		if (changing) changing.hidden = true;
		return;
	}
	renderChanging(data);
}

function applyToolFilter(raw) {
	const query = String(raw || "").trim().toLowerCase();
	const card = document.getElementById("ctx-tools");
	if (!card) return;
	let shown = 0;
	let tokens = 0;
	for (const item of card.querySelectorAll(".ctx-item[data-tool-key]")) {
		const hay = item.dataset.toolKey || "";
		const visible = !query || hay.includes(query);
		item.hidden = !visible;
		if (visible) {
			shown += 1;
			tokens += Number(item.dataset.toolTokens) || 0;
		}
	}
	const totalCount = Number(card.dataset.toolCount) || 0;
	const totalTokens = Number(card.dataset.toolTokens) || 0;
	setCount(
		"ctx-tools-count",
		query
			? `筛出 ${shown} / ${totalCount} 个 · ${fmtTokens(tokens)} token`
			: `${totalCount} 个 · ${fmtTokens(totalTokens)} token`,
	);
	const empty = document.getElementById("ctx-tools-empty");
	if (empty) empty.hidden = !query || shown > 0;
}

function resetHero(message, hint = "") {
	const totalNode = document.getElementById("ctx-total");
	if (totalNode) totalNode.textContent = "—";
	const sub = document.getElementById("ctx-sub");
	if (sub) sub.textContent = message;
	const stack = document.getElementById("ctx-stack");
	if (stack) stack.innerHTML = `<span class="ctx-stack-empty"></span>`;
	const legend = document.getElementById("ctx-legend");
	if (legend) legend.innerHTML = "";
	const meter = document.getElementById("ctx-meter");
	if (meter) meter.innerHTML = `<span class="ctx-meter-label">上一轮</span><b>—</b>`;
}

function setLoading() {
	const isDefault = contextMode === "default";
	resetHero(isDefault ? "读取默认开销…" : "读取中…");
	for (const id of ["ctx-system-count", "ctx-tools-count", "ctx-skills-count", "ctx-memory-count"]) {
		setCount(id, "");
	}
	for (const id of ["ctx-system", "ctx-tools", "ctx-skills", "ctx-memory", "ctx-changing"]) {
		const card = document.getElementById(id);
		if (card) card.innerHTML = loadingMarkup();
	}
}

function showError(message, hint = "") {
	resetHero(message, hint);
	for (const id of ["ctx-sec-system", "ctx-sec-tools", "ctx-sec-skills", "ctx-sec-memory", "ctx-sec-changing"]) {
		const section = document.getElementById(id);
		if (section) section.hidden = true;
	}
	for (const id of ["ctx-system-count", "ctx-tools-count", "ctx-skills-count", "ctx-memory-count"]) {
		setCount(id, "");
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
			showError("还没有可选角色。", "等执事花名册加载后再试，或刷新页面。");
			return;
		}
		url = `/api/v1/agent/context-defaults?role=${encodeURIComponent(roleId)}`;
	} else {
		const select = document.getElementById("ctx-chat");
		if (!(select instanceof HTMLSelectElement)) return;
		const conversationId = select.value;
		if (!conversationId) {
			showError("还没有会话，先聊一轮再来。", "也可以切到“默认开销”，不聊天就能看固定前缀。");
			return;
		}
		url = `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/context-inspect`;
	}
	setLoading();
	try {
		const response = await request(url, { cache: "no-store" });
		if (seq !== contextSeq) return;
		if (response.status === 404) {
			showError(
				isDefault
					? "默认开销读不到（可能功能被关掉了，或角色已不存在）。"
					: "这个会话读不到上下文（可能没启用，或会话已不存在）。",
				isDefault
					? "可以刷新重试；如果还不行，检查 CHAT_CONTEXT_INSPECT 是否被关掉。"
					: "可以刷新重试；如果所有会话都这样，检查 CHAT_CONTEXT_INSPECT 是否被关掉。",
			);
			return;
		}
		if (!response.ok) {
			showError(
				isDefault ? `默认开销读取失败（HTTP ${response.status}）。` : `读取失败（HTTP ${response.status}）。`,
				isDefault ? "点刷新重试；持续失败去设置 → 服务看运行状态。" : "点刷新重试；持续失败去设置 → 服务看运行状态。",
			);
			return;
		}
		const data = await response.json();
		if (seq !== contextSeq) return;
		renderContext(data);
	} catch (error) {
		if (seq !== contextSeq) return;
		const detail = error instanceof Error ? error.message : String(error);
		showError(
			detail === "forbidden" ? "这个令牌没被接受。" : isDefault ? "服务暂时连不上。" : "服务暂时连不上。",
			detail === "forbidden"
				? "检查本机令牌或配对状态。"
				: isDefault
					? "检查服务是否在运行，稍后刷新。"
					: "检查服务是否在运行，稍后刷新。",
		);
	}
}

function toggleAll(button) {
	const group = button.dataset.ctxToggleAll;
	const card = document.getElementById(group === "system" ? "ctx-system" : "ctx-tools");
	if (!card) return;
	const open = button.textContent !== "收起全部";
	button.textContent = open ? "收起全部" : "展开全部";
	for (const item of card.querySelectorAll(".ctx-item")) {
		if (item.hidden) continue;
		const head = item.querySelector(".ctx-item-head");
		const body = item.querySelector(".ctx-item-body");
		if (!head || !body) continue;
		head.setAttribute("aria-expanded", String(open));
		body.hidden = !open;
		item.classList.toggle("is-open", open);
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
	const chat = document.getElementById("ctx-chat");
	if (chat) chat.hidden = mode !== "session";
	const role = document.getElementById("ctx-role");
	if (role) role.hidden = mode !== "default";
	void loadContext();
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
		const disciplineButton = target.closest("[data-ctx-discipline]");
		if (disciplineButton) {
			openDisciplineEditor(
				disciplineButton.dataset.ctxDisciplinePartner || "",
				disciplineButton.dataset.ctxDiscipline || "",
				disciplineButton.dataset.ctxDisciplineTitle || "",
			);
			return;
		}
		const toggle = target.closest("[data-ctx-toggle]");
		if (toggle) {
			const item = toggle.closest(".ctx-item");
			const body = item?.querySelector(".ctx-item-body");
			if (!item || !body) return;
			const open = toggle.getAttribute("aria-expanded") !== "true";
			toggle.setAttribute("aria-expanded", String(open));
			body.hidden = !open;
			item.classList.toggle("is-open", open);
			return;
		}
		const toggleAllButton = target.closest("[data-ctx-toggle-all]");
		if (toggleAllButton) {
			toggleAll(toggleAllButton);
			return;
		}
		const goButton = target.closest("[data-ctx-go]");
		if (goButton) {
			go("settings", goButton.dataset.ctxGo);
			return;
		}
		const partnerButton = target.closest("[data-ctx-partner]");
		if (partnerButton) {
			const partnerId = partnerButton.dataset.ctxPartner || "";
			if (partnerId) location.hash = `#/settings/partners/${encodeURIComponent(partnerId)}`;
			return;
		}
	});
	const select = document.getElementById("ctx-chat");
	if (select instanceof HTMLSelectElement) {
		select.addEventListener("change", () => void loadContext());
	}
	const role = document.getElementById("ctx-role");
	if (role instanceof HTMLSelectElement) {
		role.addEventListener("change", () => void loadContext());
	}
	const filter = document.getElementById("ctx-tool-filter");
	if (filter instanceof HTMLInputElement) {
		filter.addEventListener("input", () => applyToolFilter(filter.value));
	}
	document.getElementById("ctx-refresh")?.addEventListener("click", () => void loadContext());
}

function wireContextSettings() {
	// 只在这个设置页活着时接线：路由已经不是 settings/context 就不挂。
	if (currentRoute() !== "settings") return;
	wireClicks();
	void loadContext();
}

export { contextSettingsMarkup, wireContextSettings };
