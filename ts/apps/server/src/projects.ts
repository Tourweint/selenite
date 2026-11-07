import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { chancellorWorkRoot } from "./delegation.ts";

/**
 * 项目与工作区（2026-11-03 方案 §5.5）。
 *
 * 三个概念先分开：
 *   领域 = 一块分工（`managers/<domain>/`），项目 = 磁盘上真实的目录/仓库，
 *   工作区 = 用户事先选定的根目录（所有新项目只能建在它下面）。
 *
 * 这里的职责只有登记与校验：**派单前置**。落盘、租约、worktree 是调度器的事（§5.4）。
 *
 * 两条不能含糊的规矩：
 * 1. 新建"项目根目录"必须用户确认：助理只能提交 proposal，确认接口由界面调用；
 *    proposal 阶段**不创建任何目录、不写任何文件**。
 * 2. 项目必须落在当前工作区内：登记与每次派单都用 `realpath` 复核，防 `..` 与符号链接逃逸。
 *
 * 存独立 SQLite（`.data/projects.sqlite`），不混进 pi-durable 的表——理由与日记镜像相同。
 */

const DEFAULT_DB_PATH = ".data/projects.sqlite";
/** project_state 里存"当前项目"的键 */
const CURRENT_PROJECT_KEY = "current_project_id";

/**
 * 回滚开关：`CURRENT_PROJECT=false` 时"当前项目"整体旁路
 * （PUT 一律 400 `current_project_disabled`，GET 恒 null，cwd / 系统提示不注入）。
 * 缺省开；每次现读 env，探针与单测可以随时切换。
 */
export function currentProjectEnabled(): boolean {
	return (process.env.CURRENT_PROJECT?.trim() || "true").toLowerCase() !== "false";
}

export type Vcs = "git" | "none";

export interface Workspace {
	id: string;
	/** realpath 归一后的绝对路径 */
	rootPath: string;
	createdAt: string;
}

export interface Project {
	id: string;
	workspaceId: string;
	name: string;
	/** realpath 归一后的绝对路径 */
	rootPath: string;
	vcs: Vcs;
	/** git 项目的当前 HEAD；非 git 或读不到时为 null */
	head: string | null;
	createdAt: string;
	archived: boolean;
}

export interface ProjectRef {
	id: string;
	name: string;
	rootPath: string;
	vcs: Vcs;
	/** 派单这一刻的 HEAD；worktree 基线与合并基线都用它。非 git 为 null。 */
	head?: string | null;
	/** 总管给这个项目的数据目录（租约 / worktree），调度器只往里写。 */
	dataDir?: string;
}

export type ProposalStatus = "pending" | "confirmed" | "rejected";

export interface ProjectProposal {
	id: string;
	workspaceId: string;
	name: string;
	/** 相对工作区根的路径，用户确认前的原始输入 */
	relativePath: string;
	/** 归一后的绝对路径（确认时才会 mkdir） */
	rootPath: string;
	status: ProposalStatus;
	createdAt: string;
	decidedAt: string | null;
}

/** 业务拒绝（400 带说明）；鉴权失败仍然是 403 空体。 */
export class ProjectError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: 400 | 404 | 409 | 500 = 400,
	) {
		super(message);
	}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
	id          TEXT PRIMARY KEY,
	root_path   TEXT NOT NULL,
	created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
	id            TEXT PRIMARY KEY,
	workspace_id  TEXT NOT NULL,
	name          TEXT NOT NULL,
	root_path     TEXT NOT NULL,
	vcs           TEXT NOT NULL DEFAULT 'none',
	head          TEXT,
	created_at    TEXT NOT NULL,
	archived      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_projects_root ON projects(root_path);
CREATE TABLE IF NOT EXISTS project_proposals (
	id            TEXT PRIMARY KEY,
	workspace_id  TEXT NOT NULL,
	name          TEXT NOT NULL,
	relative_path TEXT NOT NULL,
	root_path     TEXT NOT NULL,
	status        TEXT NOT NULL DEFAULT 'pending',
	created_at    TEXT NOT NULL,
	decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON project_proposals(status);
CREATE TABLE IF NOT EXISTS project_state (
	key   TEXT PRIMARY KEY,
	value TEXT
);
`;

type Row = Record<string, unknown>;

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function samePath(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

/** child 是否严格在 parent 之内（不含 parent 本身，不含 `..` / 跨盘）。 */
export function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 拒绝盘符根、用户主目录（及其祖先）、系统目录——工作区不能选这些。 */
function assertSelectableWorkspace(realRoot: string): void {
	if (parse(realRoot).root === realRoot) {
		throw new ProjectError("bad_path", "工作区不能是盘符根目录");
	}
	const home = realpathOr(resolve(homedir()));
	if (samePath(realRoot, home)) {
		throw new ProjectError("bad_path", "工作区不能是用户主目录");
	}
	if (isInside(realRoot, home)) {
		throw new ProjectError("bad_path", "工作区不能是用户主目录的上级目录");
	}
	for (const name of ["SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"]) {
		const value = process.env[name]?.trim();
		if (!value) continue;
		if (samePath(realRoot, realpathOr(resolve(value)))) {
			throw new ProjectError("bad_path", `工作区不能是系统目录（${name}）`);
		}
	}
}

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function sameName(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 把"还不存在的目标路径"换算成真实落点：
 * 先找到最近的已存在祖先并 realpath，再把剩余段接回去。
 *
 * 目的：在 mkdir **之前**就识破 `workspace/link-out/newdir` 这种情况，
 * 否则 mkdir 会先把目录建到工作区外，等 realpath 复核时已经晚了。
 */
function realTargetForCreate(workspaceRoot: string, target: string): string {
	let probe = target;
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (samePath(parent, probe)) break;
		probe = parent;
	}
	const realProbe = realpathSync(probe);
	const tail = relative(probe, target);
	const candidate = tail ? join(realProbe, tail) : realProbe;
	if (!isInside(workspaceRoot, candidate)) {
		throw new ProjectError("outside_workspace", "目标路径经 realpath 解析后落在工作区外");
	}
	return candidate;
}

function assertWritableDir(path: string): void {
	const stat = statSync(path);
	if (!stat.isDirectory()) {
		throw new ProjectError("bad_path", "路径不是目录");
	}
	try {
		accessSync(path, constants.W_OK);
	} catch {
		throw new ProjectError("bad_path", "目录不可写");
	}
}

/** 工作区根目录：绝对路径、存在、可写、不是盘符根/主目录/系统目录。 */
export function validateWorkspaceRoot(input: string): string {
	const raw = input.trim();
	if (!raw) throw new ProjectError("bad_path", "工作区路径不能为空");
	if (!isAbsolute(raw)) throw new ProjectError("bad_path", "工作区必须是绝对路径");
	const abs = resolve(raw);
	if (!existsSync(abs)) throw new ProjectError("bad_path", "工作区目录不存在");
	const real = realpathSync(abs);
	assertSelectableWorkspace(real);
	assertWritableDir(real);
	return real;
}

/**
 * 项目根必须写成"工作区内的相对路径"。
 * 这里只做字形校验；目录是否真的落在工作区，确认时再用 realpath 复核。
 */
export function resolveProjectPath(workspaceRoot: string, relativePath: string): string {
	const raw = relativePath.trim();
	if (!raw) throw new ProjectError("bad_path", "项目路径不能为空");
	if (isAbsolute(raw)) throw new ProjectError("bad_path", "项目路径必须是工作区内的相对路径");
	// 必须在 normalize 之前查：normalize 会把 "a/../b" 折成 "b"，`..` 就看不见了。
	const segments = raw.split(/[\\/]+/).filter(Boolean);
	if (segments.some((segment) => segment === "..")) {
		throw new ProjectError("outside_workspace", "项目路径不能包含 ..");
	}
	const abs = resolve(workspaceRoot, normalize(raw));
	if (!isInside(workspaceRoot, abs)) {
		throw new ProjectError("outside_workspace", "项目必须建在工作区内");
	}
	return abs;
}

function detectVcs(rootPath: string): { vcs: Vcs; head: string | null } {
	if (!existsSync(join(rootPath, ".git"))) return { vcs: "none", head: null };
	try {
		const head = execFileSync("git", ["-C", rootPath, "rev-parse", "HEAD"], {
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		}).trim();
		return { vcs: "git", head: head || null };
	} catch {
		// 有 .git 但 HEAD 读不出来（空仓库/损坏）：仍按 git 记，head 留空。
		return { vcs: "git", head: null };
	}
}

function proposalFromRow(row: Row): ProjectProposal {
	return {
		id: text(row.id),
		workspaceId: text(row.workspace_id),
		name: text(row.name),
		relativePath: text(row.relative_path),
		rootPath: text(row.root_path),
		status: text(row.status) as ProposalStatus,
		createdAt: text(row.created_at),
		decidedAt: row.decided_at === null ? null : text(row.decided_at),
	};
}

function projectFromRow(row: Row): Project {
	return {
		id: text(row.id),
		workspaceId: text(row.workspace_id),
		name: text(row.name),
		rootPath: text(row.root_path),
		vcs: text(row.vcs) === "git" ? "git" : "none",
		head: row.head === null || row.head === undefined ? null : text(row.head),
		createdAt: text(row.created_at),
		archived: Number(row.archived ?? 0) !== 0,
	};
}

export class ProjectsStore {
	private readonly db: DatabaseSync;
	private readonly dataRoot: string;

	constructor(path: string = process.env.PROJECTS_DB_PATH?.trim() || DEFAULT_DB_PATH) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
		// 与 SQLite 同级的 data 目录：.data/projects/<id> 放租约与 worktree。
		this.dataRoot = join(resolve(dirname(path)), "projects");
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
		return rows.map(projectFromRow);
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
		return { ...projectFromRow(row), name: next };
	}

	/** 归档 / 恢复：`archived` 位本就存在、此前无写入方，本批接上。 */
	setArchived(id: string, archived: boolean): Project {
		const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
		if (!row) throw new ProjectError("not_found", "找不到这个项目", 404);
		this.db.prepare("UPDATE projects SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
		if (archived && this.getCurrentProjectId() === id) this.writeCurrentProjectId(null);
		return { ...projectFromRow(row), archived };
	}

	/** 删除：只删登记行，不动磁盘目录；当前项目指向它时一并清掉指针。 */
	deleteProject(id: string): void {
		const row = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(id) as Row | undefined;
		if (!row) throw new ProjectError("not_found", "找不到这个项目", 404);
		if (this.getCurrentProjectId() === id) this.writeCurrentProjectId(null);
		this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
	}

	findProject(ref: string): Project | null {
		const value = ref.trim();
		if (!value) return null;
		const byId = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(value) as Row | undefined;
		if (byId) return projectFromRow(byId);
		const byName = this.db
			.prepare("SELECT * FROM projects WHERE lower(name) = lower(?) AND archived = 0")
			.get(value) as Row | undefined;
		return byName ? projectFromRow(byName) : null;
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
	 * 目录不存在、已归档、或已不在工作区内时返回 null —— 与"切了下轮才生效"同口径：
	 * 不在读取时把过期状态带进 cwd / 系统提示。
	 */
	getCurrentProject(): Project | null {
		if (!currentProjectEnabled()) return null;
		const id = this.getCurrentProjectId();
		if (!id) return null;
		const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
		if (!row) return null;
		const project = projectFromRow(row);
		if (project.archived) return null;
		// 目录没了就不算"当前项目"：cwd 与系统提示回主工作区，别把失效路径带进下一轮。
		if (!existsSync(project.rootPath)) return null;
		const workspace = this.getWorkspace();
		if (!workspace) return null;
		const realWorkspace = realpathOr(workspace.rootPath);
		const realRoot = realpathOr(project.rootPath);
		if (!realRoot || !isInside(realWorkspace, realRoot)) return null;
		return { ...project, rootPath: realRoot };
	}

	/**
	 * 切换当前项目（`null` = 回主工作区）。
	 * 校验顺序按接口文档 §2.7：未登记/已归档 → unknown_project；目录不存在 → project_missing；
	 * 在工作区外 → outside_workspace。成功返回落库的 id。
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
		const project = projectFromRow(row);
		if (project.archived) throw new ProjectError("unknown_project", "这个项目已归档");
		if (!existsSync(project.rootPath)) {
			throw new ProjectError("project_missing", `项目「${project.name}」的目录不存在了`);
		}
		const workspace = this.getWorkspace();
		const realWorkspace = workspace ? realpathOr(workspace.rootPath) : null;
		const realRoot = realpathOr(project.rootPath);
		if (!realWorkspace || !isInside(realWorkspace, realRoot)) {
			throw new ProjectError("outside_workspace", `项目「${project.name}」不在当前工作区内`);
		}
		this.writeCurrentProjectId(project.id);
		return project.id;
	}

	/**
	 * 派单前复核：项目存在、目录还在、仍在当前工作区内（realpath）。
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
		if (!isInside(realWorkspace, realRoot)) {
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
			},
		};
	}

	/**
	 * 助理发起新建项目：只落一条待确认 proposal。
	 * **不建目录、不写文件、不登记项目**——用户确认之前什么都不发生。
	 */
	proposeProject(name: string, relativePath: string): ProjectProposal {
		const workspace = this.getWorkspace();
		if (!workspace) throw new ProjectError("no_workspace", "还没有选定工作区，不能新建项目");
		const projectName = name.trim();
		if (!projectName) throw new ProjectError("bad_path", "项目名不能为空");
		if (projectName.length > 60) throw new ProjectError("bad_path", "项目名不能超过 60 字");

		const realWorkspace = realpathSync(workspace.rootPath);
		const rootPath = realTargetForCreate(
			realWorkspace,
			resolveProjectPath(realWorkspace, relativePath),
		);

		if (this.listProjects().some((project) => sameName(project.name, projectName))) {
			throw new ProjectError("duplicate_project", `已经有叫「${projectName}」的项目`);
		}

		// 已经落在某个项目里：那是项目内子目录，不需要（也不允许）登记成新项目。
		for (const project of this.listProjects()) {
			const realProjectRoot = realpathOr(project.rootPath);
			const realTarget = existsSync(rootPath) ? realpathSync(rootPath) : rootPath;
			if (samePath(realProjectRoot, realTarget) || isInside(realProjectRoot, realTarget)) {
				throw new ProjectError(
					"inside_existing_project",
					`这个路径已经在项目「${project.name}」内，属于项目内子目录，不需要新建项目`,
				);
			}
		}

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
			relativePath: normalize(relativePath.trim()),
			rootPath,
			status: "pending",
			createdAt: new Date().toISOString(),
			decidedAt: null,
		};
		this.db
			.prepare(
				`INSERT INTO project_proposals
				 (id, workspace_id, name, relative_path, root_path, status, created_at, decided_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				proposal.id,
				proposal.workspaceId,
				proposal.name,
				proposal.relativePath,
				proposal.rootPath,
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
		if (!workspace || workspace.id !== proposal.workspaceId) {
			throw new ProjectError("no_workspace", "工作区已变更，请重新提交新建项目请求");
		}

		const realWorkspace = realpathSync(workspace.rootPath);
		// 确认前再按相对路径复算一次：proposal 存的是绝对路径，但以当前工作区为准。
		// realTargetForCreate 会先把符号链接祖先解析掉，避免 mkdir 先写到工作区外。
		const target = realTargetForCreate(
			realWorkspace,
			resolveProjectPath(realWorkspace, proposal.relativePath),
		);
		mkdirSync(target, { recursive: true });

		// 建完之后再用 realpath 复核一次（防御建目录期间的链接变化）。
		const realRoot = realpathSync(target);
		if (!isInside(realWorkspace, realRoot)) {
			throw new ProjectError("outside_workspace", "目录建好后落在工作区外，已拒绝", 409);
		}
		assertWritableDir(realRoot);

		for (const project of this.listProjects()) {
			const existingRoot = realpathOr(project.rootPath);
			if (samePath(existingRoot, realRoot)) {
				throw new ProjectError("duplicate_project", `这个目录已经是项目「${project.name}」`, 409);
			}
			if (isInside(existingRoot, realRoot)) {
				throw new ProjectError(
					"inside_existing_project",
					`这个目录在项目「${project.name}」内，属于项目内子目录，不需要新建项目`,
					409,
				);
			}
		}

		const { vcs, head } = detectVcs(realRoot);
		const now = new Date().toISOString();
		const project: Project = {
			id: randomUUID(),
			workspaceId: workspace.id,
			name: proposal.name,
			rootPath: realRoot,
			vcs,
			head,
			createdAt: now,
			archived: false,
		};
		this.db
			.prepare(
				`INSERT INTO projects
				 (id, workspace_id, name, root_path, vcs, head, created_at, archived)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
			)
			.run(
				project.id,
				project.workspaceId,
				project.name,
				project.rootPath,
				project.vcs,
				project.head,
				project.createdAt,
			);
		this.db
			.prepare("UPDATE project_proposals SET status = 'confirmed', decided_at = ? WHERE id = ?")
			.run(now, proposal.id);
		return project;
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

/**
 * `delegate` 的项目前置判定（提成纯函数是为了能直接断言，不用驱动一次工具调用）。
 *
 * 返回值有两种：拿到已复核的项目，或一段给模型看的 JSON（`{ error: "needs_project" }`）。
 * JSON 里带已登记项目清单，模型不用猜——没有项目时可以直接反问或调 `propose_project`。
 */
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

/** 懒建：进程启动时不碰磁盘（与日记/配对存储同一纪律）。 */
let store: ProjectsStore | null = null;

export function projectsStore(): ProjectsStore {
	if (!store) {
		store = new ProjectsStore(process.env.PROJECTS_DB_PATH?.trim() || DEFAULT_DB_PATH);
	}
	return store;
}

/** 最大工作区根的 realpath；未设工作区或根目录已不可达 → null（守卫据此旁路）。 */
export function workspaceRootReal(store: ProjectsStore = projectsStore()): string | null {
	const workspace = store.getWorkspace();
	if (!workspace) return null;
	try {
		return realpathSync(workspace.rootPath);
	} catch {
		return null;
	}
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

	/** 已登记项目（含目录是否还在、是否仍在当前工作区内）。默认滤掉 archived。 */
	app.get("/api/v1/projects", (c) => {
		try {
			const store = projectsStore();
			const workspace = store.getWorkspace();
			const realWorkspace = workspace ? realpathOr(workspace.rootPath) : null;
			// 归档折叠区要用：?includeArchived=1 才把已归档的一并返回。
			const includeArchived = c.req.query("includeArchived") === "1";
			const projects = store.listProjects(includeArchived).map((project) => {
				const exists = existsSync(project.rootPath);
				const realRoot = exists ? realpathOr(project.rootPath) : project.rootPath;
				return {
					...project,
					exists,
					insideWorkspace: Boolean(realWorkspace && isInside(realWorkspace, realRoot)),
				};
			});
			return c.json({ workspace, projects });
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
			| { name?: string; path?: string }
			| null;
		const name = body?.name?.trim();
		const relativePath = body?.path?.trim();
		if (!name || !relativePath) {
			return c.json({ error: "bad_request", message: "name 与 path 都必填" }, 400);
		}
		try {
			const proposal = projectsStore().proposeProject(name, relativePath);
			return c.json({ ok: true, proposal }, 202);
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

	// ── 改名 / 归档 / 恢复 / 删除（扫尾批 1 A4）──────────────────
	// 纯增量端点；前端不接即旧行为。删除只删登记，不动磁盘目录。
	app.patch("/api/v1/projects/:id", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
		if (typeof body?.name !== "string") {
			return c.json({ error: "bad_request", message: "name 必填（字符串）" }, 400);
		}
		try {
			return c.json({ ok: true, project: projectsStore().renameProject(c.req.param("id"), body.name) });
		} catch (error) {
			return projectError(c, error);
		}
	});

	app.post("/api/v1/projects/:id/archive", (c) => {
		try {
			return c.json({ ok: true, project: projectsStore().setArchived(c.req.param("id"), true) });
		} catch (error) {
			return projectError(c, error);
		}
	});

	app.post("/api/v1/projects/:id/unarchive", (c) => {
		try {
			return c.json({ ok: true, project: projectsStore().setArchived(c.req.param("id"), false) });
		} catch (error) {
			return projectError(c, error);
		}
	});

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
			projectsStore().deleteProject(id);
			return c.json({ ok: true, id });
		} catch (error) {
			return projectError(c, error);
		}
	});
}
