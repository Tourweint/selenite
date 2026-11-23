/**
 * 对话工作归属（2026-11-18 从「新建选项目」改为「常显只读」）
 *
 * 用户口径：左侧侧栏选中什么项目，新对话就落在那个项目的主文件夹；没选项目就落主工作区。
 * 输入框左下角只把这个归属**显示出来**，不再提供选择菜单——选项目回到左侧侧栏。
 *
 * 三种归属（服务端 /messages 的 `chatWorkdir` 与这里同形状）：
 * - project：项目名（创建时绑定的项目，归档/改名后按服务端当前名字显示）
 * - workspace：主工作区（没绑项目时的默认落点）
 * - dir：只选了目录 / 项目已删，名称取目录 basename
 *
 * 只对 worker 显示：总管、执事、task- 任务专线都不显示（任务专线在侧栏按派活人分组）。
 *
 * 元素前缀仍是 chat-project-*：`proj-menu` / `el.projectMenu` 已被侧栏项目切换菜单占用。
 */

import { el } from "./dom.js";
import { state } from "./state.js";

/** 已落盘会话的归属：服务端回读，或首条消息的 start 帧按侧栏选择冻结。null = 未知。 */
let workdir = null;

/** 开关关着 → 整块不渲染（/agent/policy 的 chatProjectLabel）。 */
function labelEnabled() {
	return state.capabilities?.chatProjectLabel !== false;
}

/** 新建态：读侧栏「当前项目 / 工作区」。项目数据没回来时返回 null（先不画）。 */
function selectionOf() {
	const switcher = state.switcher || {};
	const currentId = String(switcher.currentProjectId || "");
	const project = (switcher.items || []).find((item) => item.id === currentId);
	if (project) {
		const roots = Array.isArray(project.roots) ? project.roots : [];
		const primary = roots.find((root) => root.role === "primary") ?? roots[0];
		return {
			kind: "project",
			name: project.name || "项目",
			path: project.rootPath || primary?.path || "",
			projectId: project.id,
		};
	}
	const rootPath = String(switcher.workspace?.rootPath || "");
	return rootPath ? { kind: "workspace", name: "工作区", path: rootPath } : null;
}

function hide() {
	if (!el.chatProjectPill) return;
	el.chatProjectPill.hidden = true;
	el.chatProjectPill.removeAttribute("data-kind");
}

function titleOf(info, fixed) {
	const place =
		info.kind === "project" ? `项目：${info.name}` : info.kind === "workspace" ? "主工作区" : "目录";
	const path = info.path ? `\n${info.path}` : "";
	const tail = fixed ? "\n创建时固定，不可改" : "\n新建对话会落在这里（左侧选项目可改落点）";
	return `${place}${path}${tail}`;
}

function paint() {
	if (!el.chatProjectPill) return;
	if (
		!labelEnabled() ||
		state.chatKind !== "worker" ||
		String(state.conversationId || "").startsWith("task-")
	) {
		return hide();
	}
	// 已落盘 = 创建时快照；未落盘 = 跟着左侧当前选择走
	const fixed = Boolean(state.conversationId);
	const info = fixed ? workdir : selectionOf();
	if (!info) return hide();
	el.chatProjectPill.hidden = false;
	el.chatProjectPill.dataset.kind = info.kind;
	el.chatProjectPillLabel.textContent = info.name;
	el.chatProjectPill.title = titleOf(info, fixed);
}

/** 新建 / 切换会话：先清掉上一条的回读值，别把旧归属挂到新会话上。 */
function clearChatProject() {
	workdir = null;
	paint();
}

/** 打开历史会话：用服务端回读的 chatWorkdir；旧后端没有这个字段 → null = 不显示。 */
function setChatWorkdir(next) {
	workdir = next && typeof next.name === "string" && next.name ? next : null;
	paint();
}

/** 首条消息拿到 conversationId：把这一刻的侧栏选择冻结成这条会话的归属。 */
function freezeChatProjectLabel() {
	if (!workdir) workdir = selectionOf();
	paint();
}

/** 项目数据 / 侧栏选择变了：新建态跟着变；已落盘态不受影响（paint 走 workdir）。 */
function syncChatProjectPill() {
	paint();
}

export { clearChatProject, freezeChatProjectLabel, setChatWorkdir, syncChatProjectPill };
