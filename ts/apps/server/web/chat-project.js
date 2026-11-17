/**
 * 对话选项目（2026-11-17）
 *
 * 用户的原话：新建任意一个对话时，要能知道它属于哪个项目；项目要坐到对话框里，
 * 放在左下角加号旁边。并且**只对 worker 显示**——总管和执事都不显示。
 *
 * 选中项目 = 这个对话的工作目录就是那个项目的主文件夹（发消息时带 dirPath）。
 * 它**不决定记忆注入**：记忆只看设置里勾选的项目。这是两件事，刻意分开。
 *
 * 元素前缀统一用 chat-project-*：`proj-menu` / `el.projectMenu` 已经被侧栏的
 * 项目切换菜单占用（project-modal.js），这里不能再借同名 id 或 dom 键——
 * 2026-11-17 第一版就是撞了这个键，两套菜单互相开关，表现为"点了闪一下就没"。
 */

import { el } from "./dom.js";
import { request } from "./net.js";
import { state } from "./state.js";

/** 选中的项目：null = 跟随「当前项目」（旧口径）。 */
let picked = null;
let cache = null;
let open = false;
/** 「当前项目」的名字，只在没选项目时给 pill 当说明，避免它看着不知道属于谁。 */
let currentName = "";

/**
 * 只对 worker 生效。`chatKind` 回读中（空串）也不显示——宁可晚一帧，不要闪。
 */
function isNewWorkerChat() {
	return !state.conversationId && state.chatKind === "worker";
}

async function projectList() {
	if (!cache) cache = await request("/api/v1/projects").catch(() => null);
	return cache;
}

function hostNameOf(data) {
	const id = data?.currentProjectId;
	if (!id) return "";
	const hit = (data?.projects ?? []).find((project) => project.id === id);
	return hit?.name ?? "";
}

function closeMenu() {
	if (!el.chatProjectMenu) return;
	open = false;
	el.chatProjectMenu.hidden = true;
	el.chatProjectMenu.classList.remove("pop-open");
	el.chatProjectPill?.setAttribute("aria-expanded", "false");
}

function paintPill() {
	if (!el.chatProjectPill) return;
	if (!isNewWorkerChat()) {
		el.chatProjectPill.hidden = true;
		closeMenu();
		return;
	}
	el.chatProjectPill.hidden = false;
	if (picked) {
		el.chatProjectPillLabel.textContent = picked.name;
		el.chatProjectPill.title = picked.path;
		el.chatProjectPill.dataset.picked = "1";
	} else if (currentName) {
		el.chatProjectPillLabel.textContent = `当前：${currentName}`;
		el.chatProjectPill.title = "没选项目：沿用「当前项目」的主文件夹当工作目录";
		el.chatProjectPill.dataset.picked = "";
	} else {
		el.chatProjectPillLabel.textContent = "选项目";
		el.chatProjectPill.title = "选一个项目 = 这个对话的工作目录就是它的主文件夹";
		el.chatProjectPill.dataset.picked = "";
	}
}

function makeItem(label, sub, onChoose, chosen) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "project-item";
	button.setAttribute("role", "menuitem");
	button.dataset.chosen = chosen ? "1" : "";
	const name = document.createElement("span");
	name.className = "project-item-name";
	name.textContent = label;
	button.appendChild(name);
	if (sub) {
		const path = document.createElement("span");
		path.className = "project-item-path";
		path.textContent = sub;
		button.appendChild(path);
	}
	button.addEventListener("click", () => {
		onChoose();
		closeMenu();
		paintPill();
	});
	return button;
}

/** 同步渲染：数据没好之前也先把菜单打开，只多一行“正在读…”，不能点了像没反应。 */
function renderMenu(data) {
	const menu = el.chatProjectMenu;
	if (!menu) return;
	menu.innerHTML = "";
	menu.appendChild(
		makeItem(
			"跟随当前项目",
			currentName ? `当前：${currentName}` : "不指定目录，沿用旧口径",
			() => {
				picked = null;
			},
			picked === null,
		),
	);
	if (!data) {
		const hint = document.createElement("div");
		hint.className = "project-item-hint";
		hint.textContent = "正在读项目清单…";
		menu.appendChild(hint);
		return;
	}
	for (const project of data.projects ?? []) {
		if (project.archived) continue;
		const roots = project.roots ?? [];
		const primary = roots.find((root) => root.role === "primary") ?? roots[0];
		if (!primary?.path) continue;
		menu.appendChild(
			makeItem(
				project.name,
				primary.path,
				() => {
					picked = { id: project.id, name: project.name, path: primary.path };
				},
				picked?.id === project.id,
			),
		);
	}
}

/** 打开菜单：先同步显示（有缓存就带列表），缓存空则后台补一轮。 */
function openMenu() {
	if (open || !isNewWorkerChat() || !el.chatProjectMenu) return;
	open = true;
	el.chatProjectMenu.hidden = false;
	el.chatProjectMenu.classList.remove("pop-open");
	void el.chatProjectMenu.offsetWidth;
	el.chatProjectMenu.classList.add("pop-open");
	el.chatProjectPill?.setAttribute("aria-expanded", "true");
	renderMenu(cache);
	if (cache) return;
	void projectList().then((data) => {
		// 数据回来时菜单可能已经关了 / 会话已经落盘：不再往上画
		if (!open || !isNewWorkerChat()) return;
		currentName = hostNameOf(data) || currentName;
		renderMenu(data);
		paintPill();
	});
}

function toggle() {
	if (open) closeMenu();
	else openMenu();
}

/** 新建会话 / 切换会话时调一次：决定 pill 显不显示、显示什么。 */
async function syncChatProjectPill() {
	paintPill();
	if (!isNewWorkerChat()) return;
	const data = await projectList();
	if (!isNewWorkerChat()) {
		paintPill();
		return;
	}
	currentName = hostNameOf(data);
	paintPill();
}

/** 会话落盘之后：pill 收起来（这条会话的项目已经定在 cwd 上了）。 */
function clearChatProject() {
	picked = null;
	closeMenu();
	paintPill();
}

/** 发给 POST /api/v1/agent/chat 的目录字段；没选 = 空对象（跟随当前项目）。 */
function chatProjectPayload() {
	if (!isNewWorkerChat() || !picked) return {};
	return { dirPath: picked.path };
}

function wireChatProject() {
	if (!el.chatProjectPill) return;
	el.chatProjectPill.addEventListener("click", (event) => {
		event.preventDefault();
		toggle();
	});
	// 点外面收：pointerdown 早于 click，用 contains 判内外，不和 pill 的 click 打架
	document.addEventListener("pointerdown", (event) => {
		if (!open) return;
		const target = event.target;
		if (!(target instanceof Element)) return;
		if (el.chatProjectMenu?.contains(target) || el.chatProjectPill?.contains(target)) return;
		closeMenu();
	});
	document.addEventListener("keydown", (event) => {
		if (!open || event.key !== "Escape") return;
		closeMenu();
	});
}

wireChatProject();

export { chatProjectPayload, clearChatProject, syncChatProjectPill };
