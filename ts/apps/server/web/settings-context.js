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

const KIND_LABEL = { chief: "总管", worker: "普通", partner: "执事" };
const STABILITY = {
	fixed: { label: "固定", cls: "is-fixed" },
	session: { label: "按会话冻结", cls: "is-session" },
	turn: { label: "每轮现算", cls: "is-turn" },
};

let contextSeq = 0;

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

function fmtNum(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number.toLocaleString("zh-CN") : "—";
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

function textBlock(text) {
	return `<pre class="ctx-text">${esc(text || "")}</pre>`;
}

function itemMarkup({ name, badge = "", desc = "", chars = 0, body = "", nameClass = "", toolKey = "" }) {
	return `<div class="ctx-item"${toolKey ? ` data-tool-key="${esc(toolKey.toLowerCase())}" data-tool-chars="${chars}"` : ""}>
    <button class="ctx-item-head" type="button" data-ctx-toggle aria-expanded="false">
      <span class="ctx-item-name ${nameClass}">${name}</span>
      ${badge}
      <span class="ctx-item-desc">${desc}</span>
      <span class="ctx-item-chars">${fmtNum(chars)} 字</span>
      <svg class="ctx-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div class="ctx-item-body" hidden>${body}</div>
  </div>`;
}

function emptyMarkup(text) {
	return `<div class="ctx-empty">${text}</div>`;
}

function loadingMarkup() {
	return `<div class="ctx-loading">读取中…</div>`;
}

function toolbarMarkup(choices, selected) {
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
    <select class="set-input ctx-select" id="ctx-chat" ${choices.length ? "" : "disabled"} aria-label="选择要查看上下文的会话">${options}</select>
    <button class="ghost ctx-refresh" type="button" id="ctx-refresh">刷新</button>
  </div>`;
}

function heroMarkup() {
	return `<div class="card ctx-hero" id="ctx-hero">
    <div class="ctx-hero-top">
      <div class="ctx-hero-copy">
        <div class="ctx-eyebrow">模型每轮开工先读这一段</div>
        <div class="ctx-total"><b id="ctx-total">—</b><span>字符固定前缀</span></div>
        <div class="ctx-sub" id="ctx-sub">选择会话后读取…</div>
      </div>
      <div class="ctx-hero-side">
        <div class="ctx-meter" id="ctx-meter"><span class="ctx-meter-label">上一轮</span><b>—</b></div>
        <div class="ctx-meter-hint" id="ctx-meter-hint">按模型窗口算</div>
      </div>
    </div>
    <div class="ctx-stack" id="ctx-stack"><span class="ctx-stack-empty"></span></div>
    <ul class="ctx-legend" id="ctx-legend"></ul>
    <div class="ctx-hero-note" id="ctx-hero-note">工具描述与顺序会参与上游缓存；改它们会打掉命中。</div>
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
	const hasChat = Boolean(selected);
	return `<div id="ctx-content">
    ${sectionMarkup("上下文", heroMarkup(), "", toolbarMarkup(choices, selected))}
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
	const memoryChars = data.memory.last?.chars ?? 0;
	const parts = [
		{ key: "system", label: "系统提示词", chars: data.system.chars },
		{ key: "tools", label: "工具定义", chars: data.tools.chars },
		{ key: "skills", label: "技能", chars: data.skills.chars },
		{ key: "memory", label: "记忆", chars: memoryChars },
	];
	const total = parts.reduce((sum, part) => sum + part.chars, 0);
	const totalNode = document.getElementById("ctx-total");
	if (totalNode) totalNode.textContent = total > 0 ? fmtNum(total) : "—";

	const sub = document.getElementById("ctx-sub");
	if (sub) {
		const memoryText = data.memory.enabled
			? data.memory.last
				? data.memory.last.items > 0
					? `记忆 ${data.memory.last.items} 条`
					: "记忆未召回"
				: "记忆待下一轮"
			: "记忆未启用";
		sub.textContent =
			total > 0
				? `系统 ${data.system.sections.length + (data.system.content ? 1 : 0)} 段 · 工具 ${data.tools.count} 个 · 技能 ${data.skills.count} 个 · ${memoryText}`
				: "这个会话还没有可读的上下文";
	}

	const meter = document.getElementById("ctx-meter");
	const meterHint = document.getElementById("ctx-meter-hint");
	if (meter) {
		const used = Number(data.usage?.used);
		const windowSize = Number(data.usage?.window);
		if (Number.isFinite(used) && used > 0 && Number.isFinite(windowSize) && windowSize > 0) {
			meter.innerHTML = `<span class="ctx-meter-label">上一轮</span><b>${fmtK(used)} / ${fmtK(windowSize)}</b> <span class="ctx-meter-unit">token · ${Math.round((used / windowSize) * 100)}%</span>`;
			if (meterHint) meterHint.textContent = "按模型窗口算";
		} else {
			meter.innerHTML = `<span class="ctx-meter-label">上一轮</span><b>—</b>`;
			if (meterHint) meterHint.textContent = total > 0 ? "这个会话还没有真实用量" : "";
		}
	}

	const stack = document.getElementById("ctx-stack");
	const legend = document.getElementById("ctx-legend");
	if (stack) {
		stack.innerHTML =
			total > 0
				? parts
						.filter((part) => part.chars > 0)
						.map(
							(part) =>
								`<span class="ctx-seg" style="width:${(part.chars / total) * 100}%;background:var(--ctx-seg-${parts.indexOf(part) + 1})"></span>`,
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
								`<li><span class="ctx-dot" style="background:var(--ctx-seg-${(index % 6) + 1})"></span><span class="ctx-name">${part.label}</span><span class="ctx-num">${fmtNum(part.chars)} 字 · ${Math.round((part.chars / total) * 100)}%</span></li>`,
						)
						.join("")
				: "";
	}

	const note = document.getElementById("ctx-hero-note");
	if (note) {
		note.textContent =
			total > 0
				? "这一段取自当前会话的实时装配；工具描述与顺序会参与上游缓存，改它们会打掉命中。"
				: "这个会话还没跑过一轮，先发一条消息；下一次打开这里，就能看到这一轮真正进入的固定前缀。";
	}
	return total;
}

function renderSystem(data) {
	const card = document.getElementById("ctx-system");
	if (!card) return;
	const items = [];
	if (data.system.content) {
		items.push(
			itemMarkup({
				name: "系统底稿",
				badge: badgeMarkup("fixed"),
				desc: "system message 的基础正文",
				chars: data.system.content.length,
				body: textBlock(data.system.content),
			}),
		);
	}
	for (const section of data.system.sections) {
		items.push(
			itemMarkup({
				name: esc(section.label),
				badge: badgeMarkup(section.stability),
				desc: esc(section.key),
				chars: section.chars,
				body: textBlock(section.text),
			}),
		);
	}
	setCount("ctx-system-count", `${items.length} 段 · ${fmtNum(data.system.chars)} 字`);
	card.innerHTML = items.length
		? `${items.join("")}<div class="ctx-note">人设段可在 <button class="ctx-link" type="button" data-ctx-go="partners">人设页</button> 改；其余段落由生命周期固定装配。</div>`
		: emptyMarkup("这个会话还没有系统提示词段。");
}

function renderTools(data) {
	const card = document.getElementById("ctx-tools");
	if (!card) return;
	card.dataset.toolCount = String(data.tools.count);
	card.dataset.toolChars = String(data.tools.chars);
	const items = data.tools.items.map((tool) =>
		itemMarkup({
			name: esc(tool.name),
			badge: "",
			desc: esc(firstLine(tool.description)),
			chars: tool.chars,
			body: textBlock(tool.schema),
			nameClass: "ctx-mono",
			toolKey: `${tool.name} ${tool.description}`,
		}),
	);
	card.innerHTML = items.length
		? `${items.join("")}<div class="ctx-empty ctx-filter-empty" id="ctx-tools-empty" hidden>没有匹配的工具，换个词试试。</div><div class="ctx-note">工具描述与顺序是缓存前缀资产；这里只读，改它们要回代码。</div>`
		: emptyMarkup("这个会话没有挂工具（或工具投影还没生成）。");
	applyToolFilter(document.getElementById("ctx-tool-filter")?.value || "");
}

function renderSkills(data) {
	const card = document.getElementById("ctx-skills");
	if (!card) return;
	setCount("ctx-skills-count", `${data.skills.count} 个 · ${fmtNum(data.skills.chars)} 字`);
	card.innerHTML = data.skills.text
		? `${itemMarkup({
				name: "技能索引",
				badge: badgeMarkup("session"),
				desc: `${data.skills.count} 个技能`,
				chars: data.skills.chars,
				body: textBlock(data.skills.text),
			})}<div class="ctx-note">索引按会话第一轮冻结；技能目录后来变了也不改写本会话。</div>`
		: emptyMarkup("当前会话没有启用任何技能。");
}

function renderMemory(data) {
	const card = document.getElementById("ctx-memory");
	if (!card) return;
	const last = data.memory.last;
	const recallChars = last?.chars ?? 0;
	setCount("ctx-memory-count", last ? `${last.items} 条 · ${fmtNum(recallChars)} 字` : "待下一轮");
	const meta = `<div class="ctx-meta-row">
      <span>预算 ${fmtNum(data.memory.limit)} 条 / ${fmtNum(data.memory.maxChars)} 字</span>
      ${last ? `<span>上一次注入 ${fmtAt(last.at)}</span>` : ""}
    </div>`;
	if (!data.memory.enabled) {
		card.innerHTML = `${meta}${emptyMarkup("记忆未启用。")}`;
		return;
	}
	if (!last) {
		card.innerHTML = `${meta}${emptyMarkup("当前进程还没跑过这个会话的一轮请求；下一次发消息后，这里会出现本轮真正注入的记忆实文。")}`;
		return;
	}
	if (!last.text) {
		card.innerHTML = `${meta}${emptyMarkup("上一轮没有召回记忆：这一轮说的话和记忆库没有对上。")}`;
		return;
	}
	card.innerHTML = `${meta}${itemMarkup({
		name: "本轮召回的记忆",
		badge: badgeMarkup("turn"),
		desc: "按本轮用户消息临时插入",
		chars: last.chars,
		body: textBlock(last.text),
	})}<div class="ctx-note">记忆不是固定文本：它按你这一轮说的话从库里挑，所以会变；预算只限制条数与字数。</div>`;
}

function renderChanging(data) {
	const card = document.getElementById("ctx-changing");
	if (!card) return;
	const changing = data.changing;
	const others = data.memory.last?.others ?? [];
	const otherMarkup = others.length
		? `<div class="ctx-other"><span class="ctx-other-label">另注入</span>${others
				.map((item) => `<span class="ctx-chip">${esc(item.id)} · ${fmtNum(item.chars)} 字</span>`)
				.join("")}</div>`
		: "";
	card.innerHTML = `<div class="ctx-change-grid">
      <div class="ctx-change-cell"><b>${fmtNum(changing.messages.count)}</b><span>对话消息 · ${fmtNum(changing.messages.chars)} 字</span></div>
      <div class="ctx-change-cell"><b>${fmtNum(changing.toolCalls.count)}</b><span>工具调用 · ${fmtNum(changing.toolCalls.chars)} 字</span></div>
      <div class="ctx-change-cell"><b>${fmtNum(changing.toolResults.count)}</b><span>工具结果 · ${fmtNum(changing.toolResults.chars)} 字</span></div>
    </div>
    ${otherMarkup}
    <div class="ctx-change-note">这些内容每轮都在变，所以这里只报数量和字符，不展开正文；整段对话去会话里看。</div>`;
}

function renderContext(data) {
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
	renderChanging(data);
}

function applyToolFilter(raw) {
	const query = String(raw || "").trim().toLowerCase();
	const card = document.getElementById("ctx-tools");
	if (!card) return;
	let shown = 0;
	let chars = 0;
	for (const item of card.querySelectorAll(".ctx-item[data-tool-key]")) {
		const hay = item.dataset.toolKey || "";
		const visible = !query || hay.includes(query);
		item.hidden = !visible;
		if (visible) {
			shown += 1;
			chars += Number(item.dataset.toolChars) || 0;
		}
	}
	const totalCount = Number(card.dataset.toolCount) || 0;
	const totalChars = Number(card.dataset.toolChars) || 0;
	setCount(
		"ctx-tools-count",
		query
			? `筛出 ${shown} / ${totalCount} 个 · ${fmtNum(chars)} 字`
			: `${totalCount} 个 · ${fmtNum(totalChars)} 字`,
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
	const note = document.getElementById("ctx-hero-note");
	if (note) note.textContent = hint;
	const meter = document.getElementById("ctx-meter");
	if (meter) meter.innerHTML = `<span class="ctx-meter-label">上一轮</span><b>—</b>`;
	const meterHint = document.getElementById("ctx-meter-hint");
	if (meterHint) meterHint.textContent = "";
}

function setLoading() {
	resetHero("读取中…", "正在读取当前会话的装配。");
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
	const select = document.getElementById("ctx-chat");
	if (!(select instanceof HTMLSelectElement)) return;
	const conversationId = select.value;
	if (!conversationId) {
		showError("还没有会话，先聊一轮再来。", "发一条消息后回到这里，就能看到这一轮真正进入的固定前缀。");
		return;
	}
	const seq = ++contextSeq;
	setLoading();
	try {
		const response = await request(
			`/api/v1/agent/chat/${encodeURIComponent(conversationId)}/context-inspect`,
			{ cache: "no-store" },
		);
		if (seq !== contextSeq) return;
		if (response.status === 404) {
			showError(
				"这个会话读不到上下文（可能没启用，或会话已不存在）。",
				"可以刷新重试；如果所有会话都这样，检查 CHAT_CONTEXT_INSPECT 是否被关掉。",
			);
			return;
		}
		if (!response.ok) {
			showError(`读取失败（HTTP ${response.status}）。`, "点刷新重试；持续失败去设置 → 服务看运行状态。");
			return;
		}
		const data = await response.json();
		if (seq !== contextSeq) return;
		renderContext(data);
	} catch (error) {
		if (seq !== contextSeq) return;
		const detail = error instanceof Error ? error.message : String(error);
		showError(
			detail === "forbidden" ? "这个令牌没被接受。" : "服务暂时连不上。",
			detail === "forbidden" ? "检查本机令牌或配对状态。" : "检查服务是否在运行，稍后刷新。",
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

function wireClicks() {
	const root = document.getElementById("ctx-content");
	if (!root) return;
	root.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		if (!target) return;
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
		}
	});
	const select = document.getElementById("ctx-chat");
	if (select instanceof HTMLSelectElement) {
		select.addEventListener("change", () => void loadContext());
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
	const select = document.getElementById("ctx-chat");
	if (select instanceof HTMLSelectElement && select.value) {
		void loadContext();
	}
}

export { contextSettingsMarkup, wireContextSettings };
