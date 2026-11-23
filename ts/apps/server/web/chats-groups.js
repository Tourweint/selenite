/**
 * 侧栏「任务」分区（2026-11-21 由「对话」改名）按创建者分文件夹（2026-11-15）。
 *
 * 方案：docs/设计方案/2026-11-15-侧栏对话按创建者分组.md。
 * 数据：`GET /agent/chats` 增量 `tasks` 键（task-<票号> 专线会话，带 dispatchedBy）。
 * 结构：[其他]（用户自己的普通对话 + 自己派的单，2026-11-21 翻案） → [总管] → 每个有任务的执事一 组；
 * 组头可收起（localStorage 记忆），任务行点击直接打开任务专线会话。
 * 回滚开关 SIDEBAR_TASK_GROUPS 2026-11-21 退役，分组是唯一形态。
 */

import { openConversation } from "./chat-open.js";
import { el } from "./dom.js";
import { chevSvg } from "./icons.js";
import { chiefDisplayName, partnerDisplayName } from "./partners-status.js";
import { state } from "./state.js";
import { TASK_STATUS, relativeTime } from "./tasks-model.js";

/* ── 折叠状态 ─────────────────────────────────────────── */

const FOLDERS_KEY = "lifediary.chatFolders";

function closedFolders() {
	try {
		const parsed = JSON.parse(localStorage.getItem(FOLDERS_KEY) || "{}");
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function folderClosed(key) {
	return closedFolders()[key] === "closed";
}

function toggleFolder(key) {
	const folders = closedFolders();
	if (folders[key] === "closed") delete folders[key];
	else folders[key] = "closed";
	localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}

/* ── 渲染 ─────────────────────────────────────────────── */

function folderSection(key, name, rows, closed, count) {
	const wrap = document.createElement("div");
	wrap.className = "chat-folder";
	wrap.dataset.folder = key;

	const head = document.createElement("button");
	head.type = "button";
	head.className = "chat-folder-head";
	head.setAttribute("aria-expanded", closed ? "false" : "true");
	// 2026-11-21（箭头统一批）：指下/-90° → 全站指右/90° 口径（视觉终态不变，旋转在 style-27）
	head.innerHTML = `${chevSvg("chat-folder-chevron chev")}
		<span class="chat-folder-name"></span>
		<span class="chat-folder-count">${count}</span>`;
	head.querySelector(".chat-folder-name").textContent = name;
	head.addEventListener("click", () => {
		toggleFolder(key);
		// 开合状态挂 wrap 的 .is-closed（2026-11-21 起）：组体走高度动画，不能再用
		// body.hidden 直切（display:none 会把过渡杀掉）。
		const nowClosed = folderClosed(key);
		wrap.classList.toggle("is-closed", nowClosed);
		head.setAttribute("aria-expanded", nowClosed ? "false" : "true");
	});
	wrap.append(head);

	// 组体两层结构与顶层分区（.side-sec-body > .side-sec-clip）同一套：
	// .chat-folder-fold 是 grid 轨道层（1fr↔0fr 过渡），.chat-folder-body 兼裁切层。
	const fold = document.createElement("div");
	fold.className = "chat-folder-fold";
	const body = document.createElement("div");
	body.className = "chat-folder-body";
	for (const row of rows) body.append(row);
	fold.append(body);
	wrap.append(fold);
	wrap.classList.toggle("is-closed", closed);
	return wrap;
}

/** 任务专线行：灯 + 需求首行 + 相对时间；点击进这条任务的会话（回信就在里面）。 */
function taskRow(task) {
	const row = document.createElement("button");
	row.type = "button";
	row.className = "side-item task-row";
	const tone = TASK_STATUS[task.status]?.[1] ?? "idle";
	const lamp = document.createElement("i");
	lamp.className = "task-lamp";
	lamp.dataset.lamp = tone === "done" ? "run" : tone;
	const name = document.createElement("span");
	name.className = "side-item-label";
	name.textContent = task.title || "（没有说明）";
	const time = document.createElement("span");
	time.className = "roster-idle";
	time.textContent = relativeTime(new Date(task.lastAt || Date.now()).toISOString());
	row.append(lamp, name, time);
	row.addEventListener("click", () => void openConversation(task.conversationId));
	return row;
}

/**
 * 分组渲染整个「任务」分区（el.chats）。
 * rows = chats-list 按旧口径构建好的普通对话行（动作按钮 / 选中态都在那边）。
 * 顺序：其他 → 总管 → 执事（按名下最近任务排序）。空组不画。
 */
export function renderGroupedChats(rows) {
	const box = el.chats;
	box.replaceChildren();
	const closed = closedFolders();
	const chatNodes = [...rows];

	// 任务专线按创建者归组；服务端已按 lastAt 倒序，组内保序。
	// 2026-11-21 翻案（用户口径「被我创建的东西归为一类」）：普通对话里派出的单不再挂
	// 总管名下——宿主是普通对话（worker 会话）→ 归「其他」组；宿主是总管会话或解析不到
	// 宿主 → 仍归总管（契约 dispatchedBy 不变，细分只在前端做）：
	// chief 宿主清单取自 state.chats（近 50 条活跃会话）；更早 / 已归档的总管会话宿主
	// 认不出来，会误归「其他」——已知边界，不在前端猜更多。
	const chiefHostIds = new Set(
		state.chats
			.filter((chat) => !String(chat.conversationId || "").startsWith("partner-"))
			.filter((chat) => (chat.chatKind || "chief") === "chief")
			.map((chat) => chat.conversationId),
	);
	const tasks = Array.isArray(state.taskChats) ? state.taskChats : [];
	const chiefTasks = [];
	const ownTasks = [];
	for (const task of tasks) {
		if (task.dispatchedBy && task.dispatchedBy !== "chief") continue;
		const host = task.hostConversationId;
		if (host && !chiefHostIds.has(host)) ownTasks.push(task);
		else chiefTasks.push(task);
	}
	const byPartner = new Map();
	for (const task of tasks) {
		if (task.dispatchedBy === "chief" || !task.dispatchedBy) continue;
		if (!byPartner.has(task.dispatchedBy)) byPartner.set(task.dispatchedBy, []);
		byPartner.get(task.dispatchedBy).push(task);
	}
	const partnerKeys = [...byPartner.keys()].sort((a, b) => {
		const latest = (key) => byPartner.get(key)[0]?.lastAt ?? 0;
		return latest(b) - latest(a);
	});

	// 其他（用户自己的普通对话 + 自己派的单）：一行都没有时整组不画
	//（全部为空的空态交给 renderSideListEmpty 一句话）
	const otherRows = [...chatNodes, ...ownTasks.map(taskRow)];
	if (otherRows.length > 0) {
		box.append(folderSection("other", "其他", otherRows, folderClosed("other"), otherRows.length));
	}
	if (chiefTasks.length > 0) {
		box.append(
			folderSection(
				"chief",
				chiefDisplayName(),
				chiefTasks.map(taskRow),
				folderClosed("chief"),
				chiefTasks.length,
			),
		);
	}
	for (const partnerId of partnerKeys) {
		const partnerTasks = byPartner.get(partnerId) ?? [];
		box.append(
			folderSection(
				`partner-${partnerId}`,
				partnerDisplayName(partnerId),
				partnerTasks.map(taskRow),
				folderClosed(`partner-${partnerId}`),
				partnerTasks.length,
			),
		);
	}
}
