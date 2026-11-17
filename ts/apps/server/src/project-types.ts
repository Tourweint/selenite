/**
 * 项目契约（常量 / 类型 / 路径比较与根目录校验）
 *
 * 2026-11-13 从 projects.ts 的 L1–L343 整段切出；正文原文搬运，未改一行实现。
 */

import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { flagEnabled } from "./flags.ts";

const DEFAULT_DB_PATH = ".data/projects.sqlite";

const CURRENT_PROJECT_KEY = "current_project_id";

export function currentProjectEnabled(): boolean {
	return flagEnabled("CURRENT_PROJECT");
}

export function projectOutsideWorkspaceEnabled(): boolean {
	return flagEnabled("PROJECT_OUTSIDE_WORKSPACE");
}

export function projectArchiveChatsEnabled(): boolean {
	return flagEnabled("PROJECT_ARCHIVE_CHATS");
}

/** 项目合并开关（2026-11-17 项目合并与记忆迁移）：`PROJECT_MERGE=false` → 端点 404、菜单不渲染。 */
export function projectMergeEnabled(): boolean {
	return flagEnabled("PROJECT_MERGE");
}

export type Vcs = "git" | "none";

export interface Workspace {
	id: string;
	/** realpath 归一后的绝对路径 */
	rootPath: string;
	createdAt: string;
}

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

export function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

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

function normPathKey(path: string): string {
	return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function defaultLabel(path: string): string {
	const base = parse(path).base;
	return base || path;
}

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

function isAbsolutePathInput(value: string): boolean {
	return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

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

function assertProjectRootAllowed(realRoot: string, workspaceRoot: string | null): void {
	if (projectOutsideWorkspaceEnabled()) return;
	if (!workspaceRoot || !isInside(workspaceRoot, realRoot)) {
		throw new ProjectError(
			"outside_workspace",
			"项目必须在工作区内（PROJECT_OUTSIDE_WORKSPACE=false 时沿用旧口径）",
		);
	}
}

export { CURRENT_PROJECT_KEY, DEFAULT_DB_PATH, SCHEMA, assertProjectRootAllowed, assertSelectableRoot, assertWritableDir, defaultLabel, isAbsolutePathInput, normPathKey, realTargetForCreate, realpathOr, sameName, samePath, text };
export type { Row };
