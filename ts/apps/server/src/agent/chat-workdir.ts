/**
 * 会话工作归属的纯投影（2026-11-18）
 *
 * 输入框左下角的只读标签要用「这条会话落在哪」。这里是纯函数：cwd / 项目绑定 /
 * 工作区根 → 展示用归属。不读库、不抛错，单测不需要起 durable。
 *
 * 三种归属：
 * - `project`：`ChatProjects` 有绑定且项目还在（归档项目也算，名字照常显示）；
 * - `workspace`：没绑项目、cwd 是主工作区根（或完全没有 cwd）；
 * - `dir`：只选了目录 / 没绑项目，cwd 是别的目录（名称取 basename）。
 *
 * 项目被硬删后映射还在时，`project` 查不到 → 落到 `dir`，不编一个项目名。
 */

import { basename } from "node:path";
import { samePath } from "../project-types.ts";

export type ChatWorkdirKind = "project" | "workspace" | "dir";

export interface ChatWorkdir {
	kind: ChatWorkdirKind;
	name: string;
	path: string;
	projectId?: string;
}

export function resolveChatWorkdir(input: {
	cwd: string | null;
	project: { id: string; name: string; rootPath: string } | null;
	workspaceRoot: string | null;
}): ChatWorkdir | null {
	const cwd = input.cwd?.trim() || null;
	if (input.project) {
		return {
			kind: "project",
			name: input.project.name,
			path: cwd || input.project.rootPath,
			projectId: input.project.id,
		};
	}
	if (cwd && input.workspaceRoot && samePath(cwd, input.workspaceRoot)) {
		return { kind: "workspace", name: "工作区", path: cwd };
	}
	if (cwd) return { kind: "dir", name: basename(cwd) || cwd, path: cwd };
	if (input.workspaceRoot) return { kind: "workspace", name: "工作区", path: input.workspaceRoot };
	return null;
}
