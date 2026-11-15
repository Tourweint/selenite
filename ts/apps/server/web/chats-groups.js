/**
 * 侧栏「对话」分区按创建者分文件夹（2026-11-15）。
 *
 * 方案：docs/设计方案/2026-11-15-侧栏对话按创建者分组.md。
 * 数据：`GET /agent/chats` 增量 `tasks` 键（task-<票号> 专线会话，带 dispatchedBy）。
 * 结构：[其他对话]（用户自己的普通对话，原有行原样） → [总管] → 每个有任务的执事一 组；
 * 组头可收起（localStorage 记忆），任务行点击直接打开任务专线会话。
 *
 * 回滚：flags `SIDEBAR_TASK_GROUPS=false` → chats-list 走旧版平铺渲染（renderChats 原文），
 * tasks-mini 恢复承担任务行（tasks-cards.renderTasksMini 用 sidebarGroupsActiveSync 判断让位）。
 */

import { openConversation } from "./chat-open.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { chiefDisplayName, partnerDisplayName } from "./partners-status.js";
import { state } from "./state.js";
import { TASK_STATUS, relativeTime } from "./tasks-model.js";

/* ── 回滚开关：flags 懒读 + 模块级缓存（照 partner-templates 的口径） ── */

let groupsFlagCache = null;

/** flags `SIDEBAR_TASK_GROUPS`（默认开）。读不到 flags 端点时按开处理（默认值语义）。 */
export async function refreshSidebarGroupsFlag() {
	if (groupsFlagCache !== null) return groupsFlagCache;
	try {
		const response = await request("/api/v1/agent/flags", { cache: "no-store" });
		const data = await response.json().catch(() => ({}));
		if (!response.ok || !Array.isArray(data.flags)) {
			groupsFlagCache = true;
			return true;
		}
		const found = data.flags.find((item) => item?.key === "SIDEBAR_TASK_GROUPS");
		const value = found?.value ?? found?.defaultValue ?? "true";
		groupsFlagCache = value !== "false" && value !== "0";
	} catch {
		groupsFlagCache = true;
	}
	return groupsFlagCache;
}

/** 同步读取最近一次刷出来的开关值；loadChats 之前调用按开处理（默认值语义）。 */
export function sidebarGroupsActiveSync() {
	return groupsFlagCache !== false;
}

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
	head.innerHTML = `<svg class="chat-folder-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
		<span class="chat-folder-name"></span>
		<span class="chat-folder-count">${count}</span>`;
	head.querySelector(".chat-folder-name").textContent = name;
	head.addEventListener("click", () => {
		toggleFolder(key);
		const body = wrap.querySelector(".chat-folder-body");
		const nowClosed = folderClosed(key);
		body.hidden = nowClosed;
		head.setAttribute("aria-expanded", nowClosed ? "false" : "true");
	});
	wrap.append(head);

	const body = document.createElement("div");
	body.className = "chat-folder-body";
	body.hidden = closed;
	for (const row of rows) body.append(row);
	wrap.append(body);
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
 * 分组渲染整个「对话」分区（el.chats）。
 * rows = chats-list 按旧口径构建好的普通对话行（动作按钮 / 选中态都在那边）。
 * 顺序：其他对话 → 总管 → 执事（按名下最近任务排序）。空组不画。
 */
export function renderGroupedChats(rows) {
	const box = el.chats;
	box.replaceChildren();
	const closed = closedFolders();
	const chatNodes = [...rows];

	// 任务专线按创建者归组；服务端已按 lastAt 倒序，组内保序
	const tasks = Array.isArray(state.taskChats) ? state.taskChats : [];
	const chiefTasks = tasks.filter((task) => task.dispatchedBy === "chief");
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

	// 其他对话：一行都没有时整组不画（全部为空的空态交给 renderSideListEmpty 一句话）
	if (chatNodes.length > 0) {
		box.append(
			folderSection(
				"other",
				"其他对话",
				chatNodes,
				folderClosed("other"),
				chatNodes.length,
			),
		);
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

	// 旧 tasks-mini 让位：分组形态下任务行都在文件夹里了
	if (el.tasksMini) {
		el.tasksMini.replaceChildren();
		el.tasksMini.hidden = true;
	}
}
