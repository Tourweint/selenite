/**
 * 行映射（项目路径解析 / VCS 探测 / 提案与根目录行转换）
 *
 * 2026-11-13 从 projects.ts 的 L344–L431 整段切出；正文原文搬运，未改一行实现。
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, parse, resolve } from "node:path";
import { ProjectError, isInside, text } from "./project-types.ts";
import type { Project, ProjectProposal, ProjectRoot, ProposalStatus, Row, Vcs } from "./project-types.ts";

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

export { detectVcs, parseFolders, projectFromRow, proposalFromRow, rootFromRow };
