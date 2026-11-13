import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { chancellorWorkRoot } from "./delegation.ts";

/**
 * 项目与工作区（2026-11-03 方案 §5.5；2026-11-12 改为多根平级）。
 *
 * 三个概念先分开：
 *   领域 = 一块分工（`managers/<domain>/`），项目 = 磁盘上真实的目录/仓库，
 *   工作区 = 默认目录（主根）。
 *
 * 2026-11-12 之前：项目必须落在工作区根内，工作区是唯一物理硬边界。
 * 2026-11-12 起（ZCode 对照 + 用户拍板）：**工作区根与项目目录平级**——项目可以
 * 在任意位置；所有已登记且未归档的目录共同构成助手可读写的根集合。回滚开关
 * `PROJECT_OUTSIDE_WORKSPACE=false` 恢复"项目必须在工作区内"的旧口径。
 *
 * 这里的职责只有登记与校验：**派单前置**。落盘、租约、worktree 是调度器的事（§5.4）。
 *
 * 两条不能含糊的规矩：
 * 1. 新建"项目根目录"必须用户确认：助理只能提交 proposal，确认接口由界面调用；
 *    proposal 阶段**不创建任何目录、不写任何文件**。
 * 2. 每个根都做 realpath 校验（防 `..` 与符号链接逃逸）；根集合的并集就是助手边界。
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

/**
 * 回滚开关：`PROJECT_OUTSIDE_WORKSPACE=false` 恢复 2026-11-12 之前的单根口径
 * （项目必须落在工作区根内）。缺省开；每次现读 env，探针与单测可随时切换。
 */
export function projectOutsideWorkspaceEnabled(): boolean {
	return (process.env.PROJECT_OUTSIDE_WORKSPACE?.trim() || "true").toLowerCase() !== "false";
}

/**
 * 回滚开关：`PROJECT_ARCHIVE_CHATS=false` 关闭「归档项目时连带归档该项目的普通会话」
 * （2026-11-12 归档模块 §5/§8），项目归档只改登记位，回到本批之前的形态。
 * 缺省开；每次现读 env，探针与单测可随时切换。
 */
export function projectArchiveChatsEnabled(): boolean {
	return (process.env.PROJECT_ARCHIVE_CHATS?.trim() || "true").toLowerCase() !== "false";
}

export type Vcs = "git" | "none";

export interface Workspace {
	id: string;
	/** realpath 归一后的绝对路径 */
	rootPath: string;
	createdAt: string;
}

/** 项目里的一个文件夹（2026-11-13 项目容器）。一个项目恰好一个 `primary`。 */
export interface ProjectRoot {
	id: string;
	projectId: string;
	/** 显示名；默认目录名，项目内唯一 */
	label: string;
	/** realpath 归一后的绝对路径 */
	path: string;
	role: "primary" | "extra";
	/** git 项目的当前 HEAD；非 git 或读不到时为 null（下移到根层，2026-11-13） */
	vcs: Vcs;
	head: string | null;
	createdAt: string;
}

export interface Project {
	id: string;
	workspaceId: string;
	name: string;
	/**
	 * **主文件夹**的绝对路径（= `roots` 里 role=primary 那条）。
	 * 2026-11-13 起它是 `project_roots` 的缓存列：新会话的 cwd、派单的租约根都取它。
	 * 老字段名保留是为了不动派单 / 文件浏览 / 手机端的读取面。
	 */
	rootPath: string;
	vcs: Vcs;
	/** git 项目的当前 HEAD；非 git 或读不到时为 null */
	head: string | null;
	createdAt: string;
	archived: boolean;
	/** 全部文件夹，主文件夹排第一 */
	roots: ProjectRoot[];
}

export interface ProjectRef {
	id: string;
	name: string;
	/** 主文件夹（realpath）：派单的租约根 / cwd */
	rootPath: string;
	vcs: Vcs;
	/** 派单这一刻的 HEAD；worktree 基线与合并基线都用它。非 git 为 null。 */
	head?: string | null;
	/** 总管给这个项目的数据目录（租约 / worktree），调度器只往里写。 */
	dataDir?: string;
	/** 全部文件夹（2026-11-13）；派活侧要按需进去读，不认识的字段自然忽略 */
	roots?: { id: string; label: string; path: string; role: "primary" | "extra" }[];
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
	/** 一并登记的附加文件夹（绝对路径，2026-11-13）；确认时逐个复核 */
	folders: string[];
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
-- 2026-11-13 项目容器：一个项目多个文件夹。projects.root_path 退化为 primary 的缓存列，
-- 真源在这张表；path_norm 是"小写 + 正斜杠"的归一值，唯一索引保证一个文件夹只属于一个项目
-- （Windows 大小写不敏感，所以不能直接对 path 建唯一索引）。
CREATE TABLE IF NOT EXISTS project_roots (
	id          TEXT PRIMARY KEY,
	project_id  TEXT NOT NULL,
	label       TEXT NOT NULL,
	path        TEXT NOT NULL,
	path_norm   TEXT NOT NULL,
	role        TEXT NOT NULL DEFAULT 'extra',
	vcs         TEXT NOT NULL DEFAULT 'none',
	head        TEXT,
	created_at  TEXT NOT NULL,
	position    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_root_path ON project_roots(path_norm);
CREATE INDEX IF NOT EXISTS idx_root_project ON project_roots(project_id);
CREATE TABLE IF NOT EXISTS project_proposals (
	id            TEXT PRIMARY KEY,
	workspace_id  TEXT NOT NULL,
	name          TEXT NOT NULL,
	relative_path TEXT NOT NULL,
	root_path     TEXT NOT NULL,
	folders       TEXT NOT NULL DEFAULT '[]',
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

/** 拒绝盘符根、用户主目录（及其祖先）、系统目录——工作区/项目根都不能选这些。 */
function assertSelectableRoot(realRoot: string, label: string): void {
	if (parse(realRoot).root === realRoot) {
		throw new ProjectError("bad_path", `${label}不能是盘符根目录`);
	}
	const home = realpathOr(resolve(homedir()));
	if (samePath(realRoot, home)) {
		throw new ProjectError("bad_path", `${label}不能是用户主目录`);
	}
	if (isInside(realRoot, home)) {
		throw new ProjectError("bad_path", `${label}不能是用户主目录的上级目录`);
	}
	for (const name of ["SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"]) {
		const value = process.env[name]?.trim();
		if (!value) continue;
		if (samePath(realRoot, realpathOr(resolve(value)))) {
			throw new ProjectError("bad_path", `${label}不能是系统目录（${name}）`);
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

/** 路径的归一键（唯一索引与"同一文件夹"判定共用）：小写 + 正斜杠 + 去尾斜杠。 */
function normPathKey(path: string): string {
	return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 文件夹显示名的默认值：目录名（Windows 盘符根退回整条路径）。 */
function defaultLabel(path: string): string {
	const base = parse(path).base;
	return base || path;
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
	assertSelectableRoot(real, "工作区");
	assertWritableDir(real);
	return real;
}

/** 绝对路径判定：兼容 Windows 的 `C:/x` 与 `C:\x`（node 的 isAbsolute 在跨平台测试里不稳）。 */
function isAbsolutePathInput(value: string): boolean {
	return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

/**
 * 项目根目录（2026-11-12 多根）：必须是**已存在**的绝对路径；可写，且不是盘符根/
 * 主目录/系统目录。是否必须落在工作区内由 `assertProjectRootAllowed` 按回滚开关判。
 */
export function validateProjectRoot(input: string): string {
	const raw = input.trim();
	if (!raw) throw new ProjectError("bad_path", "项目路径不能为空");
	if (!isAbsolutePathInput(raw)) {
		throw new ProjectError("bad_path", "项目路径必须是绝对路径（例如 D:/Projects/foo）");
	}
	const abs = resolve(raw);
	if (!existsSync(abs)) throw new ProjectError("bad_path", "项目目录不存在");
	const real = realpathSync(abs);
	assertSelectableRoot(real, "项目目录");
	assertWritableDir(real);
	return real;
}

/** 回滚开关兜底：旧口径下项目必须仍在工作区根内。 */
function assertProjectRootAllowed(realRoot: string, workspaceRoot: string | null): void {
	if (projectOutsideWorkspaceEnabled()) return;
	if (!workspaceRoot || !isInside(workspaceRoot, realRoot)) {
		throw new ProjectError(
			"outside_workspace",
			"项目必须在工作区内（PROJECT_OUTSIDE_WORKSPACE=false 时沿用旧口径）",
		);
	}
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
		folders: parseFolders(row.folders),
		status: text(row.status) as ProposalStatus,
		createdAt: text(row.created_at),
		decidedAt: row.decided_at === null ? null : text(row.decided_at),
	};
}

/** proposal 里的附加文件夹（JSON 数组）；坏数据按空处理，不让一条脏行卡住建项目。 */
function parseFolders(value: unknown): string[] {
	if (typeof value !== "string" || !value.trim()) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function rootFromRow(row: Row): ProjectRoot {
	return {
		id: text(row.id),
		projectId: text(row.project_id),
		label: text(row.label),
		path: text(row.path),
		role: text(row.role) === "primary" ? "primary" : "extra",
		vcs: text(row.vcs) === "git" ? "git" : "none",
		head: row.head === null || row.head === undefined ? null : text(row.head),
		createdAt: text(row.created_at),
	};
}

/** 只读 projects 行本身；文件夹在 `ProjectsStore#toProject` 里补。 */
function projectFromRow(row: Row): Omit<Project, "roots"> {
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

/** 默认工作区落点：LIFEDIARY_DEFAULT_WORKSPACE 可换路径；off / 0 / false = 关掉播种。 */
export function defaultWorkspaceRoot(): string | null {
	const flag = process.env.LIFEDIARY_DEFAULT_WORKSPACE?.trim();
	if (flag && ["off", "0", "false"].includes(flag.toLowerCase())) return null;
	return resolve(flag || join(homedir(), "lifediary"));
}

/**
 * 首次使用播种默认工作区（2026-11-08 用户拍板：不做引导，默认落 <主目录>/lifediary，之后可改）。
 * 只在**没设过**时动手——用户已经选了根目录的，一次都不动。
 * 换了 PROJECTS_DB_PATH 跑（测试/探针）默认不播种，别往真实主目录写；
 * 要验这段就显式给 LIFEDIARY_DEFAULT_WORKSPACE 指到临时目录。
 * 任何失败只 warn：播种不成 = 退回旧行为（未设置态，侧栏仍有「设置主项目」兜底入口）。
 */
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

/**
 * 助手可读写的根集合（2026-11-12 多根）：工作区根 + 所有未归档且目录还在的项目根。
 * 去重、按 realpath；工作区根排第一（默认 cwd 仍以它为准）。
 * 回滚开关 `PROJECT_OUTSIDE_WORKSPACE=false` 时只收工作区内的项目，恢复单根口径。
 */
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
			projectsStore().deleteProject(id);
			return c.json({ ok: true, id });
		} catch (error) {
			return projectError(c, error);
		}
	});
}
