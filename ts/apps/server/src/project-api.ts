/**
 * 对外接口（单例 / 默认工作区 / 根目录解析 / 错误映射 / 端点挂载）
 *
 * 2026-11-13 从 projects.ts 的 L1238–L1650 整段切出；正文原文搬运，未改一行实现。
 */

import { chancellorWorkRoot } from "./delegation.ts";
import { Context, Hono } from "hono";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DB_PATH, ProjectError, currentProjectEnabled, isInside, projectArchiveChatsEnabled, projectOutsideWorkspaceEnabled, realpathOr, samePath, text } from "./project-types.ts";
import type { ProjectRef, ProposalStatus, Workspace } from "./project-types.ts";
import { ProjectsStore } from "./project-store.ts";

export function resolveDelegationProject(
	ref: string | undefined,
	store: ProjectsStore | null,
): { ok: true; project: ProjectRef } | { ok: false; text: string } {
	if (!store) {
		return {
			ok: false,
			text: JSON.stringify({
				error: "needs_project",
				message: "项目登记表不可用，不能派单",
				projects: [],
			}),
		};
	}
	const result = store.resolveForUse(ref ?? "");
	if (result.ok) return result;
	return {
		ok: false,
		text: JSON.stringify({
			error: "needs_project",
			message: result.message,
			projects: store
				.listProjects()
				.map((project) => ({ id: project.id, name: project.name })),
		}),
	};
}

let store: ProjectsStore | null = null;

export function projectsStore(): ProjectsStore {
	if (!store) {
		store = new ProjectsStore(process.env.PROJECTS_DB_PATH?.trim() || DEFAULT_DB_PATH);
	}
	return store;
}

/** 测试专用：关掉并清掉单例，下一次 projectsStore() 按当时的 env 重开库（进程内单测换临时库用）。 */
export function resetProjectsStoreForTest(): void {
	try {
		store?.close();
	} catch {
		// 库已被关过（前一条测试收尾关了同一个单例）：忽略，只清指针
	}
	store = null;
}

export function defaultWorkspaceRoot(): string | null {
	const flag = process.env.LIFEDIARY_DEFAULT_WORKSPACE?.trim();
	if (flag && ["off", "0", "false"].includes(flag.toLowerCase())) return null;
	return resolve(flag || join(homedir(), "lifediary"));
}

export function seedDefaultWorkspace(store: ProjectsStore = projectsStore()): Workspace | null {
	if (store.getWorkspace()) return null;
	const flag = process.env.LIFEDIARY_DEFAULT_WORKSPACE?.trim();
	if (flag && ["off", "0", "false"].includes(flag.toLowerCase())) return null;
	const usingDefaultDb = !process.env.PROJECTS_DB_PATH?.trim();
	if (!usingDefaultDb && !flag) return null;
	const root = defaultWorkspaceRoot();
	if (!root) return null;
	try {
		mkdirSync(root, { recursive: true });
		return store.setWorkspace(root);
	} catch (error) {
		console.warn(
			"[projects] 默认工作区没建成，保持未设置（可在设置页手动选）:",
			error instanceof Error ? error.message : error,
		);
		return null;
	}
}

export function workspaceRootReal(store: ProjectsStore = projectsStore()): string | null {
	const workspace = store.getWorkspace();
	if (!workspace) return null;
	try {
		return realpathSync(workspace.rootPath);
	} catch {
		return null;
	}
}

export function workspaceRootsReal(store: ProjectsStore = projectsStore()): string[] {
	const roots: string[] = [];
	const push = (path: string): void => {
		try {
			const real = realpathSync(path);
			if (!roots.some((root) => samePath(root, real))) roots.push(real);
		} catch {
			// 目录不可达：不进根集合（派单/当前项目另有存在性校验）
		}
	};
	const workspace = store.getWorkspace();
	const realWorkspace = workspace ? realpathOr(workspace.rootPath) : null;
	if (workspace) push(workspace.rootPath);
	for (const project of store.listProjects()) {
		if (project.archived) continue;
		// 2026-11-13：边界是"所有项目所有文件夹的并集"（一个项目多个根）。
		for (const root of project.roots) {
			if (!existsSync(root.path)) continue;
			if (!projectOutsideWorkspaceEnabled()) {
				if (!realWorkspace || !isInside(realWorkspace, realpathOr(root.path))) continue;
			}
			push(root.path);
		}
	}
	return roots;
}

function projectError(c: Context, error: unknown) {
	if (error instanceof ProjectError) {
		return c.json({ error: error.code, message: error.message }, error.status);
	}
	const detail = error instanceof Error ? error.message : String(error);
	// 原始错误只进服务端日志（可能带磁盘路径）。
	console.warn(`[projects] ${detail}`);
	return c.json({ error: "internal", message: "项目操作失败" }, 500);
}

export function mountProjects(app: Hono): void {
	/** 当前工作区（未选时 workspace=null）+ 当前项目（null = 主工作区 / 杂事态） */
	app.get("/api/v1/workspaces", (c) => {
		try {
			const store = projectsStore();
			return c.json({
				workspace: store.getWorkspace(),
				currentProjectId: currentProjectEnabled() ? store.getCurrentProjectId() : null,
			});
		} catch (error) {
			return projectError(c, error);
		}
	});

	/**
	 * 切换当前项目（侧边栏高频操作，2026-11-04 方案）。
	 * `{projectId:null}` = 回主工作区；校验失败一律业务 400（鉴权失败仍是 403 空体）。
	 */
	app.put("/api/v1/workspaces/current-project", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { projectId?: unknown } | null;
		if (
			!body ||
			!("projectId" in body) ||
			(body.projectId !== null && typeof body.projectId !== "string")
		) {
			return c.json({ error: "bad_request", message: "projectId 必须是字符串或 null" }, 400);
		}
		try {
			const projectId = projectsStore().setCurrentProject(body.projectId);
			return c.json({ ok: true, projectId });
		} catch (error) {
			return projectError(c, error);
		}
	});

	/** 设置工作区根目录（设置页「项目」分区）。单工作区，重复设置会替换。 */
	app.post("/api/v1/workspaces", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { rootPath?: string } | null;
		const rootPath = body?.rootPath?.trim();
		if (!rootPath) return c.json({ error: "bad_request", message: "rootPath 必填" }, 400);
		try {
			const workspace = projectsStore().setWorkspace(rootPath);
			return c.json({ ok: true, workspace });
		} catch (error) {
			return projectError(c, error);
		}
	});

	/** 已登记项目（含文件夹清单、目录是否还在、是否仍在当前工作区内）。默认滤掉 archived。 */
	app.get("/api/v1/projects", (c) => {
		try {
			const store = projectsStore();
			const workspace = store.getWorkspace();
			const realWorkspace = workspace ? realpathOr(workspace.rootPath) : null;
			// 归档折叠区要用：?includeArchived=1 才把已归档的一并返回。
			const includeArchived = c.req.query("includeArchived") === "1";
			const projects = store.listProjects(includeArchived).map((project) => {
				// 2026-11-13：存在性与内外判定下移到每个文件夹；项目级的 exists
				// 仍是"主文件夹还在吗"（手机端只认这一个字段，纯增量不破坏它）。
				const roots = project.roots.map((root) => {
					const rootExists = existsSync(root.path);
					const realRoot = rootExists ? realpathOr(root.path) : root.path;
					return {
						...root,
						exists: rootExists,
						insideWorkspace: Boolean(realWorkspace && isInside(realWorkspace, realRoot)),
					};
				});
				const primary = roots.find((root) => root.role === "primary") ?? roots[0];
				return {
					...project,
					roots,
					exists: Boolean(primary?.exists),
					insideWorkspace: Boolean(primary?.insideWorkspace),
				};
			});
			// 侧栏要标出"当前选中的项目"，一次请求拿全（纯增量字段，老客户端忽略）。
			const currentProjectId = currentProjectEnabled()
				? (store.getCurrentProject()?.id ?? null)
				: null;
			return c.json({ workspace, currentProjectId, projects });
		} catch (error) {
			return projectError(c, error);
		}
	});

	/**
	 * 助理发起新建项目（方案 §5.5）：
	 * 只提交待确认请求，不建目录、不写项目登记表。确认走下面的 /confirm。
	 */
	app.post("/api/v1/projects", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { name?: string; path?: string; primaryPath?: string; folders?: unknown }
			| null;
		const name = body?.name?.trim();
		// `primaryPath`（2026-11-13）与旧的 `path` 同义；两者都给时以 primaryPath 为准。
		const relativePath = body?.primaryPath?.trim() || body?.path?.trim();
		if (!name || !relativePath) {
			return c.json({ error: "bad_request", message: "name 与 path 都必填" }, 400);
		}
		const folders =
			Array.isArray(body?.folders)
				? body!.folders.filter((item): item is string => typeof item === "string")
				: [];
		try {
			const proposal = projectsStore().proposeProject(name, relativePath, folders);
			return c.json({ ok: true, proposal }, 202);
		} catch (error) {
			return projectError(c, error);
		}
	});

	// ── 文件夹（2026-11-13 项目容器）：加 / 改路径 / 改名 / 设为主 / 移除 ──────────
	// 全部只改登记，不动磁盘；主文件夹的 path 变更同步到 projects.root_path 缓存列。
	app.post("/api/v1/projects/:id/roots", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { path?: unknown; label?: unknown; primary?: unknown }
			| null;
		if (typeof body?.path !== "string" || !body.path.trim()) {
			return c.json({ error: "bad_request", message: "path 必填（绝对路径）" }, 400);
		}
		try {
			const project = projectsStore().addRoot(c.req.param("id"), {
				path: body.path,
				label: typeof body.label === "string" ? body.label : undefined,
				primary: body.primary === true,
			});
			return c.json({ ok: true, project });
		} catch (error) {
			return projectError(c, error);
		}
	});

	app.patch("/api/v1/projects/:id/roots/:rootId", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { path?: unknown; label?: unknown }
			| null;
		const hasPath = typeof body?.path === "string" && Boolean(body.path.trim());
		const hasLabel = typeof body?.label === "string";
		if (!hasPath && !hasLabel) {
			return c.json({ error: "bad_request", message: "path 或 label 至少给一个（字符串）" }, 400);
		}
		try {
			const projectId = c.req.param("id");
			const rootId = c.req.param("rootId");
			const store = projectsStore();
			let project = hasPath
				? store.updateRootPath(projectId, rootId, body!.path as string)
				: null;
			if (hasLabel) project = store.renameRoot(projectId, rootId, body!.label as string);
			return c.json({ ok: true, project: project ?? store.findProject(projectId) });
		} catch (error) {
			return projectError(c, error);
		}
	});

	/** 设为主文件夹：**只影响之后新建的会话**，老会话的 cwd 是创建时的快照。 */
	app.post("/api/v1/projects/:id/roots/:rootId/promote", (c) => {
		try {
			const project = projectsStore().promoteRoot(c.req.param("id"), c.req.param("rootId"));
			return c.json({ ok: true, project });
		} catch (error) {
			return projectError(c, error);
		}
	});

	app.delete("/api/v1/projects/:id/roots/:rootId", (c) => {
		try {
			const project = projectsStore().removeRoot(c.req.param("id"), c.req.param("rootId"));
			return c.json({ ok: true, project });
		} catch (error) {
			return projectError(c, error);
		}
	});

	app.get("/api/v1/projects/proposals", (c) => {
		const status = c.req.query("status")?.trim() || "pending";
		if (status !== "pending" && status !== "confirmed" && status !== "rejected" && status !== "all") {
			return c.json({ error: "bad_request", message: "status 只能是 pending/confirmed/rejected/all" }, 400);
		}
		try {
			return c.json({ proposals: projectsStore().listProposals(status as ProposalStatus | "all") });
		} catch (error) {
			return projectError(c, error);
		}
	});

	/** 用户确认：这一步才建目录、登记项目。界面/桌面设置页调用。 */
	app.post("/api/v1/projects/:id/confirm", (c) => {
		try {
			return c.json({ ok: true, project: projectsStore().confirmProposal(c.req.param("id")) });
		} catch (error) {
			return projectError(c, error);
		}
	});

	/** 用户拒绝：什么都不建，任务单也不会落地。 */
	app.post("/api/v1/projects/:id/reject", (c) => {
		try {
			return c.json({ ok: true, proposal: projectsStore().rejectProposal(c.req.param("id")) });
		} catch (error) {
			return projectError(c, error);
		}
	});

	// ── 改名 / 改路径 / 归档 / 恢复 / 删除（扫尾批 1 A4；2026-11-12 补改路径与归档语义）──
	// 纯增量端点；前端不接即旧行为。归档只改登记位，不动磁盘目录。
	app.patch("/api/v1/projects/:id", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { name?: unknown; rootPath?: unknown }
			| null;
		const hasName = typeof body?.name === "string";
		const hasRootPath = typeof body?.rootPath === "string";
		if (!hasName && !hasRootPath) {
			return c.json({ error: "bad_request", message: "name 或 rootPath 至少给一个（字符串）" }, 400);
		}
		try {
			const id = c.req.param("id");
			const store = projectsStore();
			let project = hasName ? store.renameProject(id, body!.name as string) : null;
			if (hasRootPath) project = store.updateProjectRoot(id, body!.rootPath as string);
			return c.json({ ok: true, project: project ?? store.findProject(id) });
		} catch (error) {
			return projectError(c, error);
		}
	});

	const setArchived = async (c: Context, archived: boolean) => {
		try {
			const project = projectsStore().setArchived(c.req.param("id") ?? "", archived);
			if (!archived) return c.json({ ok: true, project });
			// 项目归档成功后，若开关开，连带归档"这个项目下新建的普通会话"。
			// 动态 import 避免 projects ↔ session 的顶层环；连带失败不回滚项目登记
			// （项目已经归档成功，会话归档是附带的；错误只进服务端日志）。
			let archivedChats = 0;
			if (projectArchiveChatsEnabled()) {
				try {
					const { archiveChatsOfProject } = await import("./agent/session.ts");
					archivedChats = await archiveChatsOfProject(project.id);
				} catch (error) {
					console.warn(
						`[projects] 项目 ${project.id} 连带归档会话失败: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			return c.json({ ok: true, project, archivedChats });
		} catch (error) {
			return projectError(c, error);
		}
	};

	/** 归档项目（软退场，可恢复）：界面主入口；响应带 `archivedChats` 计数。 */
	app.post("/api/v1/projects/:id/archive", (c) => setArchived(c, true));
	/** 旧路径名保留为兼容别名（2026-11-12 前叫 remove）。 */
	app.post("/api/v1/projects/:id/remove", (c) => setArchived(c, true));
	/** 恢复只恢复项目登记，**不自动恢复会话**（会话归档是独立动作）。 */
	app.post("/api/v1/projects/:id/restore", (c) => setArchived(c, false));
	app.post("/api/v1/projects/:id/unarchive", (c) => setArchived(c, false));

	app.delete("/api/v1/projects/:id", async (c) => {
		try {
			const id = c.req.param("id");
			// 守卫：该项目还有非终态派单（chancellor 工作目录还在跑）→ 400。
			// 懒加载避免项目模块在启动期拉起整个任务中心链；读取复用 delegation-api 同一套。
			const { projectHasInFlightTickets } = await import("./delegation-api.ts");
			if (projectHasInFlightTickets(chancellorWorkRoot(), id)) {
				return c.json(
					{ error: "project_in_flight", message: "先取消或等任务完结，再删除项目登记" },
					400,
				);
			}
			// 连带解除执事挂载（2026-11-15 界面恢复删除入口）：先解除、后删登记，
			// 顺序反了登记删掉就没人负责清这些悬空引用了。数量带回给界面提示；
			// 删除失败时挂载已清，但那只是把"指着存活项目的挂载"提前摘掉，重试即成。
			const { partnersStore } = await import("./partners.ts");
			const detachedPartners = partnersStore().detachProject(id);
			projectsStore().deleteProject(id);
			return c.json({ ok: true, id, detachedPartners });
		} catch (error) {
			return projectError(c, error);
		}
	});
}

export { projectError, store };
