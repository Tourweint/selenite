/**
 * ProjectsStore（SQLite 落库：项目与根目录的增删改查、提案处理）
 *
 * 2026-11-13 从 projects.ts 的 L432–L1237 整段切出；正文原文搬运，未改一行实现。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_PROJECT_KEY, DEFAULT_DB_PATH, ProjectError, SCHEMA, assertProjectRootAllowed, assertWritableDir, currentProjectEnabled, defaultLabel, isAbsolutePathInput, isInside, normPathKey, projectOutsideWorkspaceEnabled, realTargetForCreate, realpathOr, sameName, samePath, text, validateProjectRoot, validateWorkspaceRoot } from "./project-types.ts";
import type { Project, ProjectProposal, ProjectRef, ProjectRoot, ProposalStatus, Row, Vcs, Workspace } from "./project-types.ts";
import { detectVcs, projectFromRow, proposalFromRow, resolveProjectPath, rootFromRow } from "./project-rows.ts";

export class ProjectsStore {
	private readonly db: DatabaseSync;
	private readonly dataRoot: string;

	constructor(path: string = process.env.PROJECTS_DB_PATH?.trim() || DEFAULT_DB_PATH) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
		// 旧库升到"一个项目多个文件夹"：补列、给每个老项目播一条 primary 根。
		this.migrate();
		// 与 SQLite 同级的 data 目录：.data/projects/<id> 放租约与 worktree。
		this.dataRoot = join(resolve(dirname(path)), "projects");
	}

	/**
	 * 结构迁移（2026-11-13，纯增量、跑多少次都安全）：
	 * 1. `project_proposals.folders` —— 建项目时一并登记的附加文件夹；
	 * 2. 每个已登记项目若还没有任何根，用它原来的 `root_path` 播一条 `primary`。
	 *    **只补缺失**：用户已经加过文件夹的项目一条都不动。
	 */
	private migrate(): void {
		const proposalCols = (
			this.db.prepare("PRAGMA table_info(project_proposals)").all() as Row[]
		).map((row) => text(row.name));
		if (!proposalCols.includes("folders")) {
			this.db.exec("ALTER TABLE project_proposals ADD COLUMN folders TEXT NOT NULL DEFAULT '[]'");
		}
		for (const row of this.db.prepare("SELECT * FROM projects").all() as Row[]) {
			const projectId = text(row.id);
			const count = this.db
				.prepare("SELECT COUNT(*) AS n FROM project_roots WHERE project_id = ?")
				.get(projectId) as Row;
			if (Number(count?.n ?? 0) > 0) continue;
			const path = text(row.root_path);
			this.insertRoot(
				{
					id: randomUUID(),
					projectId,
					label: defaultLabel(path),
					path,
					role: "primary",
					vcs: text(row.vcs) === "git" ? "git" : "none",
					head: row.head === null || row.head === undefined ? null : text(row.head),
					createdAt: text(row.created_at),
				},
				0,
			);
		}
	}

	private insertRoot(root: ProjectRoot, position: number): void {
		// path_norm 有唯一索引：极小概率的并发插入落到这里，翻成业务错误而不是 500。
		try {
			this.db
				.prepare(
					`INSERT INTO project_roots
					 (id, project_id, label, path, path_norm, role, vcs, head, created_at, position)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					root.id,
					root.projectId,
					root.label,
					root.path,
					normPathKey(root.path),
					root.role,
					root.vcs,
					root.head,
					root.createdAt,
					position,
				);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (/UNIQUE/i.test(detail)) {
				throw new ProjectError("duplicate_root", "这个文件夹已经登记过了", 409);
			}
			throw error;
		}
	}

	/** 某个项目的全部文件夹；主文件夹排第一（稳定给界面与注入用）。 */
	rootsOf(projectId: string): ProjectRoot[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM project_roots WHERE project_id = ?
				 ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, position ASC, created_at ASC`,
			)
			.all(projectId) as Row[];
		return rows.map(rootFromRow);
	}

	/** projects 行 + 文件夹；`rootPath/vcs/head` 以 primary 为准（缓存列只作回落）。 */
	private toProject(row: Row): Project {
		const base = projectFromRow(row);
		const roots = this.rootsOf(base.id);
		const primary = roots.find((root) => root.role === "primary");
		if (!primary) return { ...base, roots };
		return {
			...base,
			roots,
			rootPath: primary.path,
			vcs: primary.vcs,
			head: primary.head,
		};
	}

	projectDataDir(projectId: string): string {
		return join(this.dataRoot, projectId);
	}

	close(): void {
		this.db.close();
	}

	/** 单工作区：设计里是"用户选一次"。重复设置会替换根目录，已有项目保留。 */
	getWorkspace(): Workspace | null {
		const row = this.db
			.prepare("SELECT * FROM workspaces ORDER BY created_at DESC LIMIT 1")
			.get() as Row | undefined;
		if (!row) return null;
		return {
			id: text(row.id),
			rootPath: text(row.root_path),
			createdAt: text(row.created_at),
		};
	}

	setWorkspace(rootPath: string): Workspace {
		const real = validateWorkspaceRoot(rootPath);
		const now = new Date().toISOString();
		const current = this.getWorkspace();
		if (current && samePath(current.rootPath, real)) return current;
		this.db.prepare("DELETE FROM workspaces").run();
		// 当前项目与工作区同生命周期：换根即回主工作区（旧项目可能已不在新根内）。
		this.writeCurrentProjectId(null);
		const workspace: Workspace = { id: randomUUID(), rootPath: real, createdAt: now };
		this.db
			.prepare("INSERT INTO workspaces (id, root_path, created_at) VALUES (?, ?, ?)")
			.run(workspace.id, workspace.rootPath, workspace.createdAt);
		return workspace;
	}

	listProjects(includeArchived = false): Project[] {
		const rows = this.db
			.prepare(
				includeArchived
					? "SELECT * FROM projects ORDER BY created_at ASC"
					: "SELECT * FROM projects WHERE archived = 0 ORDER BY created_at ASC",
			)
			.all() as Row[];
		return rows.map((row) => this.toProject(row));
	}

	/** 改名（扫尾批 1 A4）：校验口径同建项目，排除自己。只改登记，不动磁盘。 */
	renameProject(id: string, name: string): Project {
		const next = name.trim();
		if (!next) throw new ProjectError("bad_path", "项目名不能为空");
		if (next.length > 60) throw new ProjectError("bad_path", "项目名不能超过 60 字");
		const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
		if (!row) throw new ProjectError("not_found", "找不到这个项目", 404);
		if (this.listProjects().some((project) => project.id !== id && sameName(project.name, next))) {
			throw new ProjectError("duplicate_project", `已经有叫「${next}」的项目`);
		}
		this.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(next, id);
		return { ...this.toProject(row), name: next };
	}

	/**
	 * 改**主文件夹**（2026-11-12 建立"改路径"；2026-11-13 起它改的是 primary 那条根）。
	 * 只改登记，不动磁盘/文件；vcs 与 head 按新目录重测。
	 * 校验与新建同口径（已存在、可写、非系统目录、不与其他任何文件夹重叠）。
	 * **已建会话不受影响**：它们的 cwd 是创建时的快照（改主文件夹只决定之后新建的会话）。
	 */
	updateProjectRoot(id: string, rootPath: string): Project {
		const roots = this.rootsOf(id);
		const primary = roots.find((root) => root.role === "primary") ?? roots[0];
		if (!primary) throw new ProjectError("root_not_found", "这个项目还没有文件夹", 404);
		const realRoot = validateProjectRoot(rootPath);
		this.assertRootPathAllowed(realRoot, id, primary.id);
		const { vcs, head } = detectVcs(realRoot);
		this.db
			.prepare("UPDATE project_roots SET path = ?, path_norm = ?, vcs = ?, head = ? WHERE id = ?")
			.run(realRoot, normPathKey(realRoot), vcs, head, primary.id);
		this.db
			.prepare("UPDATE projects SET root_path = ?, vcs = ?, head = ? WHERE id = ?")
			.run(realRoot, vcs, head, id);
		return this.toProject(this.projectRow(id));
	}

	/** 添加文件夹（2026-11-13）：只改登记，**不建目录**（要求已存在，用户先用资源管理器建好）。 */
	addRoot(
		projectId: string,
		input: { path: string; label?: string; primary?: boolean },
	): Project {
		this.projectRow(projectId);
		const realPath = validateProjectRoot(input.path);
		this.assertRootPathAllowed(realPath, projectId);
		const label = this.resolveRootLabel(projectId, input.label, realPath);
		const roots = this.rootsOf(projectId);
		// 第一个根必然是主文件夹；显式 primary 则把原来的主降级。
		const asPrimary = input.primary === true || roots.length === 0;
		const { vcs, head } = detectVcs(realPath);
		const root: ProjectRoot = {
			id: randomUUID(),
			projectId,
			label,
			path: realPath,
			role: asPrimary ? "primary" : "extra",
			vcs,
			head,
			createdAt: new Date().toISOString(),
		};
		if (asPrimary) {
			for (const old of roots) {
				if (old.role === "primary") {
					this.db.prepare("UPDATE project_roots SET role = 'extra' WHERE id = ?").run(old.id);
				}
			}
		}
		this.insertRoot(root, roots.length);
		if (asPrimary) this.writePrimaryCache(projectId, realPath, vcs, head);
		return this.toProject(this.projectRow(projectId));
	}

	/** 改某个文件夹的路径（2026-11-13）：改到 primary 上时同步缓存列。 */
	updateRootPath(projectId: string, rootId: string, path: string): Project {
		const root = this.rootsOf(projectId).find((item) => item.id === rootId);
		if (!root) throw new ProjectError("root_not_found", "找不到这个文件夹", 404);
		const realPath = validateProjectRoot(path);
		this.assertRootPathAllowed(realPath, projectId, rootId);
		const { vcs, head } = detectVcs(realPath);
		this.db
			.prepare("UPDATE project_roots SET path = ?, path_norm = ?, vcs = ?, head = ? WHERE id = ?")
			.run(realPath, normPathKey(realPath), vcs, head, rootId);
		if (root.role === "primary") this.writePrimaryCache(projectId, realPath, vcs, head);
		return this.toProject(this.projectRow(projectId));
	}

	/** 改某个文件夹的显示名（项目内唯一）。 */
	renameRoot(projectId: string, rootId: string, label: string): Project {
		const root = this.rootsOf(projectId).find((item) => item.id === rootId);
		if (!root) throw new ProjectError("root_not_found", "找不到这个文件夹", 404);
		const next = this.resolveRootLabel(projectId, label, root.path, rootId);
		this.db.prepare("UPDATE project_roots SET label = ? WHERE id = ?").run(next, rootId);
		return this.toProject(this.projectRow(projectId));
	}

	/**
	 * 把某个文件夹设为主文件夹（2026-11-13）。
	 * **只影响之后新建的会话**：老会话的 cwd 是创建时的快照，不会跟着挪。
	 */
	promoteRoot(projectId: string, rootId: string): Project {
		const roots = this.rootsOf(projectId);
		const target = roots.find((item) => item.id === rootId);
		if (!target) throw new ProjectError("root_not_found", "找不到这个文件夹", 404);
		if (target.role === "primary") return this.toProject(this.projectRow(projectId));
		for (const old of roots) {
			if (old.role === "primary") {
				this.db.prepare("UPDATE project_roots SET role = 'extra' WHERE id = ?").run(old.id);
			}
		}
		this.db.prepare("UPDATE project_roots SET role = 'primary' WHERE id = ?").run(target.id);
		this.writePrimaryCache(projectId, target.path, target.vcs, target.head);
		return this.toProject(this.projectRow(projectId));
	}

	/**
	 * 移除一个文件夹（2026-11-13）：只删登记，**不动磁盘**。
	 * 主文件夹不能直接移除（先把别的设为主）；最后一个文件夹也不能移除（要退场就归档项目）。
	 */
	removeRoot(projectId: string, rootId: string): Project {
		const roots = this.rootsOf(projectId);
		const target = roots.find((item) => item.id === rootId);
		if (!target) throw new ProjectError("root_not_found", "找不到这个文件夹", 404);
		if (roots.length <= 1) {
			throw new ProjectError("last_root", "项目至少要保留一个文件夹（要退场就归档整个项目）", 409);
		}
		if (target.role === "primary") {
			throw new ProjectError("root_is_primary", "主文件夹不能直接移除，先把另一个设为主", 409);
		}
		this.db.prepare("DELETE FROM project_roots WHERE id = ?").run(rootId);
		return this.toProject(this.projectRow(projectId));
	}

	private projectRow(id: string): Row {
		const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
		if (!row) throw new ProjectError("not_found", "找不到这个项目", 404);
		return row;
	}

	private writePrimaryCache(projectId: string, path: string, vcs: Vcs, head: string | null): void {
		this.db
			.prepare("UPDATE projects SET root_path = ?, vcs = ?, head = ? WHERE id = ?")
			.run(path, vcs, head, projectId);
	}

	/** 文件夹显示名：缺省取目录名；项目内不能重名。 */
	private resolveRootLabel(
		projectId: string,
		input: string | undefined,
		path: string,
		excludeRootId?: string,
	): string {
		const wanted = (input ?? "").trim() || defaultLabel(path);
		if (wanted.length > 40) throw new ProjectError("bad_path", "文件夹名不能超过 40 字");
		const clash = this.rootsOf(projectId).some(
			(root) => root.id !== excludeRootId && sameName(root.label, wanted),
		);
		if (clash) {
			throw new ProjectError("duplicate_label", `这个项目里已经有叫「${wanted}」的文件夹`, 409);
		}
		return wanted;
	}

	/**
	 * 批量登记时的显示名去重（确认 proposal 用）：两个目录恰好同名不该卡住建项目，
	 * 自动加序号就好；用户显式填名字走 `resolveRootLabel`，重名照样报错。
	 */
	private uniqueRootLabel(projectId: string, wanted: string): string {
		const base = wanted.trim() || "文件夹";
		const taken = new Set(this.rootsOf(projectId).map((root) => root.label.toLowerCase()));
		if (!taken.has(base.toLowerCase())) return base;
		for (let index = 2; index < 100; index += 1) {
			const candidate = `${base} ${index}`;
			if (!taken.has(candidate.toLowerCase())) return candidate;
		}
		return `${base} ${taken.size + 1}`;
	}

	/**
	 * 一个文件夹路径能不能用（2026-11-13 多根）：
	 * - 不能等于工作区根（工作区不是项目）；
	 * - 不能是工作区根的祖先（否则整个工作区被裹进一个项目）；
	 * - 不能与其他**任何**文件夹同路径 / 互相包含（同项目内的两个根也按这条判）。
	 * 允许落在工作区根内（旧口径的常态），也允许工作区外的绝对路径。
	 */
	private assertRootPathAllowed(
		realRoot: string,
		excludeProjectId?: string,
		excludeRootId?: string,
	): void {
		const workspace = this.getWorkspace();
		if (workspace) {
			const realWorkspace = realpathOr(workspace.rootPath);
			if (samePath(realWorkspace, realRoot)) {
				throw new ProjectError("duplicate_project", "这个目录就是工作区根目录，不用再登记成项目", 409);
			}
			if (isInside(realRoot, realWorkspace)) {
				throw new ProjectError("contains_workspace", "这个目录包含工作区根目录，请选更具体的目录", 409);
			}
			// 旧口径（PROJECT_OUTSIDE_WORKSPACE=false）：文件夹必须仍在工作区根内。
			if (!projectOutsideWorkspaceEnabled() && !isInside(realWorkspace, realRoot)) {
				throw new ProjectError(
					"outside_workspace",
					"文件夹必须在工作区内（PROJECT_OUTSIDE_WORKSPACE=false 时沿用旧口径）",
				);
			}
		}
		for (const project of this.listProjects()) {
			for (const root of project.roots) {
				if (project.id === excludeProjectId && root.id === excludeRootId) continue;
				const existing = realpathOr(root.path);
				if (samePath(existing, realRoot)) {
					throw new ProjectError(
						"duplicate_root",
						project.id === excludeProjectId
							? `这个文件夹已经在项目「${project.name}」里了`
							: `这个文件夹已经是项目「${project.name}」的「${root.label}」`,
						409,
					);
				}
				if (isInside(existing, realRoot)) {
					throw new ProjectError(
						"inside_existing_project",
						`这个目录在项目「${project.name}」的「${root.label}」内，属于项目内子目录`,
						409,
					);
				}
				if (isInside(realRoot, existing)) {
					throw new ProjectError(
						"root_overlaps_root",
						`这个目录包含项目「${project.name}」的「${root.label}」，两个文件夹不能互相套`,
						409,
					);
				}
			}
		}
	}

	/** 旧名保留（新建项目 / 迁移路径仍在用）：语义就是"这个新根不能跟已有文件夹撞"。 */
	private assertProjectRootAvailable(realRoot: string, excludeId?: string): void {
		this.assertRootPathAllowed(realRoot, excludeId);
	}

	/**
	 * 归档 / 恢复（2026-11-07 建立；2026-11-12 起统一叫「归档」）：软退场，只改 archived 位。
	 * 会话的连带归档不在这里做——那是 HTTP 层调 `archiveChatsOfProject` 的事
	 * （避免 projects ↔ session 的顶层依赖环）。
	 */
	setArchived(id: string, archived: boolean): Project {
		const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
		if (!row) throw new ProjectError("not_found", "找不到这个项目", 404);
		this.db.prepare("UPDATE projects SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
		if (archived && this.getCurrentProjectId() === id) this.writeCurrentProjectId(null);
		return { ...this.toProject(row), archived };
	}

	/**
	 * 程序化硬删登记（2026-11-12）：只删登记行，不动磁盘目录，**不连带归档会话**
	 * （界面不提供入口，只有 DELETE 端点可达；会话归档是独立动作）。
	 * 当前项目指向它时一并清掉指针。
	 */
	deleteProject(id: string): void {
		const row = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(id) as Row | undefined;
		if (!row) throw new ProjectError("not_found", "找不到这个项目", 404);
		if (this.getCurrentProjectId() === id) this.writeCurrentProjectId(null);
		this.db.prepare("DELETE FROM project_roots WHERE project_id = ?").run(id);
		this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
	}

	findProject(ref: string): Project | null {
		const value = ref.trim();
		if (!value) return null;
		const byId = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(value) as Row | undefined;
		if (byId) return this.toProject(byId);
		const byName = this.db
			.prepare("SELECT * FROM projects WHERE lower(name) = lower(?) AND archived = 0")
			.get(value) as Row | undefined;
		return byName ? this.toProject(byName) : null;
	}

	/** 当前项目 id（原始值，可能指向已删/已归档/已移出工作区的项目）。 */
	getCurrentProjectId(): string | null {
		const row = this.db
			.prepare("SELECT value FROM project_state WHERE key = ?")
			.get(CURRENT_PROJECT_KEY) as Row | undefined;
		const id = row ? text(row.value) : "";
		return id || null;
	}

	private writeCurrentProjectId(id: string | null): void {
		if (id === null) {
			this.db.prepare("DELETE FROM project_state WHERE key = ?").run(CURRENT_PROJECT_KEY);
			return;
		}
		this.db
			.prepare(
				"INSERT INTO project_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(CURRENT_PROJECT_KEY, id);
	}

	/**
	 * 当前项目（每轮现读，不缓存陈旧值）。
	 * 目录不存在、已归档时返回 null；2026-11-12 起不再要求落在工作区内
	 * （回滚开关 `PROJECT_OUTSIDE_WORKSPACE=false` 时仍按旧口径复核）。
	 */
	getCurrentProject(): Project | null {
		if (!currentProjectEnabled()) return null;
		const id = this.getCurrentProjectId();
		if (!id) return null;
		const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
		if (!row) return null;
		const project = this.toProject(row);
		if (project.archived) return null;
		// 目录没了就不算"当前项目"：cwd 与系统提示回主工作区，别把失效路径带进下一轮。
		if (!existsSync(project.rootPath)) return null;
		const workspace = this.getWorkspace();
		if (!workspace) return null;
		const realWorkspace = realpathOr(workspace.rootPath);
		const realRoot = realpathOr(project.rootPath);
		if (!realRoot) return null;
		if (!projectOutsideWorkspaceEnabled() && !isInside(realWorkspace, realRoot)) return null;
		return { ...project, rootPath: realRoot };
	}

	/**
	 * 切换当前项目（`null` = 回主工作区）。
	 * 校验顺序：未登记/已归档 → unknown_project；目录不存在 → project_missing；
	 * 旧口径（PROJECT_OUTSIDE_WORKSPACE=false）才复核工作区内外。
	 */
	setCurrentProject(projectId: string | null): string | null {
		if (!currentProjectEnabled()) {
			throw new ProjectError("current_project_disabled", "当前项目功能已关闭（CURRENT_PROJECT=false）");
		}
		if (projectId === null) {
			this.writeCurrentProjectId(null);
			return null;
		}
		const value = projectId.trim();
		const row = value
			? (this.db.prepare("SELECT * FROM projects WHERE id = ?").get(value) as Row | undefined)
			: undefined;
		if (!row) throw new ProjectError("unknown_project", "没有这个已登记项目");
		const project = this.toProject(row);
		if (project.archived) throw new ProjectError("unknown_project", "这个项目已归档");
		if (!existsSync(project.rootPath)) {
			throw new ProjectError("project_missing", `项目「${project.name}」的目录不存在了`);
		}
		const workspace = this.getWorkspace();
		const realWorkspace = workspace ? realpathOr(workspace.rootPath) : null;
		const realRoot = realpathOr(project.rootPath);
		if (!realWorkspace) {
			throw new ProjectError("no_workspace", "还没有选定工作区");
		}
		assertProjectRootAllowed(realRoot, realWorkspace);
		this.writeCurrentProjectId(project.id);
		return project.id;
	}

	/**
	 * 派单前复核：项目存在、目录还在；2026-11-12 起不再要求落在工作区内
	 * （回滚开关 `PROJECT_OUTSIDE_WORKSPACE=false` 时仍按旧口径复核）。
	 * 返回的 `rootPath` 是 realpath，调度器可以直接拿它当 cwd / 租约根。
	 */
	resolveForUse(
		ref: string,
	): { ok: true; project: ProjectRef } | { ok: false; message: string } {
		const value = ref.trim();
		if (!value) return { ok: false, message: "派单必须带 project" };
		const found = this.findProject(value);
		if (!found) {
			return { ok: false, message: `没有叫「${value}」的已登记项目` };
		}
		if (found.archived) {
			return { ok: false, message: `项目「${found.name}」已归档` };
		}
		const workspace = this.getWorkspace();
		if (!workspace) {
			return { ok: false, message: "还没有选定工作区，先在项目设置里选一个根目录" };
		}
		let realWorkspace: string;
		let realRoot: string;
		try {
			realWorkspace = realpathSync(workspace.rootPath);
			realRoot = realpathSync(found.rootPath);
		} catch {
			return { ok: false, message: `项目「${found.name}」的目录不存在了` };
		}
		if (!projectOutsideWorkspaceEnabled() && !isInside(realWorkspace, realRoot)) {
			return { ok: false, message: `项目「${found.name}」不在当前工作区内` };
		}
		const { head } = detectVcs(realRoot);
		return {
			ok: true,
			project: {
				id: found.id,
				name: found.name,
				rootPath: realRoot,
				vcs: found.vcs,
				head,
				dataDir: this.projectDataDir(found.id),
				// 多文件夹（2026-11-13）：派活侧按需进各根读，主根仍是 rootPath。
				roots: found.roots.map((root) => ({
					id: root.id,
					label: root.label,
					path: realpathOr(root.path),
					role: root.role,
				})),
			},
		};
	}

	/**
	 * 助理/界面发起新建项目：只落一条待确认 proposal。
	 * **不建目录、不写文件、不登记项目**——用户确认之前什么都不发生。
	 *
	 * `pathInput` 两种形态（2026-11-12）：
	 * - 相对路径：按工作区根解析，目录可以还不存在，确认时创建（旧行为）；
	 * - 绝对路径：必须是已存在的目录；工作区外也允许（多根模型），确认时只登记。
	 */
	proposeProject(name: string, pathInput: string, folders: string[] = []): ProjectProposal {
		const workspace = this.getWorkspace();
		if (!workspace) throw new ProjectError("no_workspace", "还没有选定工作区，不能新建项目");
		const projectName = name.trim();
		if (!projectName) throw new ProjectError("bad_path", "项目名不能为空");
		if (projectName.length > 60) throw new ProjectError("bad_path", "项目名不能超过 60 字");
		const raw = pathInput.trim();
		if (!raw) throw new ProjectError("bad_path", "项目路径不能为空");

		const realWorkspace = realpathOr(workspace.rootPath);
		const absoluteInput = isAbsolutePathInput(raw);
		let rootPath: string;
		if (absoluteInput) {
			rootPath = validateProjectRoot(raw);
			assertProjectRootAllowed(rootPath, realWorkspace);
		} else {
			rootPath = realTargetForCreate(
				realWorkspace,
				resolveProjectPath(realWorkspace, raw),
			);
		}

		if (this.listProjects().some((project) => sameName(project.name, projectName))) {
			throw new ProjectError("duplicate_project", `已经有叫「${projectName}」的项目`);
		}
		this.assertProjectRootAvailable(rootPath);

		// 一并登记的附加文件夹（2026-11-13）：proposal 阶段只复核，**不建目录、不写文件**。
		const extraFolders: string[] = [];
		for (const item of folders) {
			const rawFolder = item.trim();
			if (!rawFolder) continue;
			const folder = validateProjectRoot(rawFolder);
			if (
				samePath(folder, rootPath) ||
				isInside(rootPath, folder) ||
				isInside(folder, rootPath)
			) {
				throw new ProjectError("root_overlaps_root", "附加文件夹不能与主文件夹相同或互相包含", 409);
			}
			for (const other of extraFolders) {
				if (samePath(other, folder) || isInside(other, folder) || isInside(folder, other)) {
					throw new ProjectError("root_overlaps_root", "两个附加文件夹不能相同或互相包含", 409);
				}
			}
			extraFolders.push(folder);
		}
		for (const folder of extraFolders) this.assertProjectRootAvailable(folder);

		// 同 name + 同路径的 pending proposal 直接复用，避免重复点击产生多条。
		const existing = this.db
			.prepare(
				"SELECT * FROM project_proposals WHERE status = 'pending' AND lower(name) = lower(?) AND root_path = ?",
			)
			.get(projectName, rootPath) as Row | undefined;
		if (existing) return proposalFromRow(existing);

		const proposal: ProjectProposal = {
			id: randomUUID(),
			workspaceId: workspace.id,
			name: projectName,
			relativePath: absoluteInput ? rootPath : normalize(raw),
			rootPath,
			folders: extraFolders,
			status: "pending",
			createdAt: new Date().toISOString(),
			decidedAt: null,
		};
		this.db
			.prepare(
				`INSERT INTO project_proposals
				 (id, workspace_id, name, relative_path, root_path, folders, status, created_at, decided_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				proposal.id,
				proposal.workspaceId,
				proposal.name,
				proposal.relativePath,
				proposal.rootPath,
				JSON.stringify(proposal.folders),
				proposal.status,
				proposal.createdAt,
				null,
			);
		return proposal;
	}

	listProposals(status: ProposalStatus | "all" = "pending"): ProjectProposal[] {
		const rows = (
			status === "all"
				? this.db.prepare("SELECT * FROM project_proposals ORDER BY created_at ASC").all()
				: this.db
						.prepare(
							"SELECT * FROM project_proposals WHERE status = ? ORDER BY created_at ASC",
						)
						.all(status)
		) as Row[];
		return rows.map(proposalFromRow);
	}

	/** 用户确认：**这一步才建目录、写项目登记表**。 */
	confirmProposal(id: string): Project {
		const row = this.db.prepare("SELECT * FROM project_proposals WHERE id = ?").get(id) as
			| Row
			| undefined;
		if (!row) throw new ProjectError("not_found", "找不到这条待确认请求", 404);
		const proposal = proposalFromRow(row);
		if (proposal.status !== "pending") {
			throw new ProjectError("already_decided", "这条请求已经处理过了", 409);
		}
		const workspace = this.getWorkspace();
		if (!workspace) {
			throw new ProjectError("no_workspace", "还没有选定工作区");
		}
		const absoluteProposal = isAbsolutePathInput(proposal.relativePath);
		// 相对路径是"相对当前工作区"写的；换了根就别拿旧根猜，让用户重提。绝对路径不受影响。
		if (!absoluteProposal && workspace.id !== proposal.workspaceId) {
			throw new ProjectError("no_workspace", "工作区已变更，请重新提交新建项目请求");
		}

		const realWorkspace = realpathOr(workspace.rootPath);
		let realRoot: string;
		if (absoluteProposal) {
			// 外部/已有目录：确认时只复核，不创建（proposal 阶段已要求存在）。
			if (!existsSync(proposal.rootPath)) {
				throw new ProjectError("bad_path", "项目目录不存在了，请重新提交", 409);
			}
			realRoot = realpathSync(proposal.rootPath);
			assertProjectRootAllowed(realRoot, realWorkspace);
			assertWritableDir(realRoot);
		} else {
			// 确认前再按相对路径复算一次：proposal 存的是绝对路径，但以当前工作区为准。
			// realTargetForCreate 会先把符号链接祖先解析掉，避免 mkdir 先写到工作区外。
			const target = realTargetForCreate(
				realWorkspace,
				resolveProjectPath(realWorkspace, proposal.relativePath),
			);
			mkdirSync(target, { recursive: true });
			// 建完之后再用 realpath 复核一次（防御建目录期间的链接变化）。
			realRoot = realpathSync(target);
			assertProjectRootAllowed(realRoot, realWorkspace);
			assertWritableDir(realRoot);
		}
		this.assertProjectRootAvailable(realRoot);

		const { vcs, head } = detectVcs(realRoot);
		const now = new Date().toISOString();

		// 附加文件夹（2026-11-13）：proposal 阶段已登记，确认时逐个复核真实落点与互不重叠。
		const extraRoots: string[] = [];
		for (const item of proposal.folders) {
			const folder = validateProjectRoot(item);
			if (
				samePath(folder, realRoot) ||
				isInside(realRoot, folder) ||
				isInside(folder, realRoot)
			) {
				throw new ProjectError("root_overlaps_root", "附加文件夹不能与主文件夹相同或互相包含", 409);
			}
			for (const other of extraRoots) {
				if (samePath(other, folder) || isInside(other, folder) || isInside(folder, other)) {
					throw new ProjectError("root_overlaps_root", "两个附加文件夹不能相同或互相包含", 409);
				}
			}
			extraRoots.push(folder);
		}

		const projectId = randomUUID();
		this.db
			.prepare(
				`INSERT INTO projects
				 (id, workspace_id, name, root_path, vcs, head, created_at, archived)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
			)
			.run(projectId, workspace.id, proposal.name, realRoot, vcs, head, now);
		// 建项目行之后再插根；任何一步失败都撤干净，回到"确认前什么都没发生"。
		try {
			this.insertRoot(
				{
					id: randomUUID(),
					projectId,
					label: defaultLabel(realRoot),
					path: realRoot,
					role: "primary",
					vcs,
					head,
					createdAt: now,
				},
				0,
			);
			extraRoots.forEach((folder, index) => {
				const detected = detectVcs(folder);
				this.insertRoot(
					{
						id: randomUUID(),
						projectId,
						label: this.uniqueRootLabel(projectId, defaultLabel(folder)),
						path: folder,
						role: "extra",
						vcs: detected.vcs,
						head: detected.head,
						createdAt: now,
					},
					index + 1,
				);
			});
		} catch (error) {
			this.db.prepare("DELETE FROM project_roots WHERE project_id = ?").run(projectId);
			this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
			throw error;
		}
		this.db
			.prepare("UPDATE project_proposals SET status = 'confirmed', decided_at = ? WHERE id = ?")
			.run(now, proposal.id);
		return this.toProject(this.projectRow(projectId));
	}

	rejectProposal(id: string): ProjectProposal {
		const row = this.db.prepare("SELECT * FROM project_proposals WHERE id = ?").get(id) as
			| Row
			| undefined;
		if (!row) throw new ProjectError("not_found", "找不到这条待确认请求", 404);
		const proposal = proposalFromRow(row);
		if (proposal.status !== "pending") {
			throw new ProjectError("already_decided", "这条请求已经处理过了", 409);
		}
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE project_proposals SET status = 'rejected', decided_at = ? WHERE id = ?")
			.run(now, id);
		return { ...proposal, status: "rejected", decidedAt: now };
	}
}
