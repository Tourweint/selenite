/**
 * 记忆 scope 迁移与项目记忆处置（2026-11-17 项目合并与记忆迁移）。
 *
 * 单独成文件是为了把「记忆侧怎么搬」收口在一处：
 * - `memory-api.ts` 的 `POST /memory/scope/move` 用它（带前端参数校验）；
 * - `project-api.ts` 的删项目 / 合并项目用它（服务端内部调用，不需要重复校验表单）。
 *
 * 依赖 `./agent.ts` 取引擎单例，所以 project-api 侧一律**动态 import**（该文件本来
 * 就这个惯例：delegation / partners 都是动态拉，避免启动期把 agent 链拖进项目模块）。
 */

import { memoryEngine } from "./agent.ts";
import { validTargetScope } from "./memory-consolidate.ts";
import { projectsStore } from "./projects.ts";

/**
 * 记忆迁移开关（`MEMORY_SCOPE_MOVE=false` / `0` / `off`）：
 * `POST /memory/scope/move` 404、删项目 `memory=move` 400。孤儿清单不受影响（只读）。
 */
export function memoryScopeMoveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = (env.MEMORY_SCOPE_MOVE ?? "").trim().toLowerCase();
	return value !== "false" && value !== "0" && value !== "off";
}

export interface MoveScopeFailure {
	ok: false;
	status: 400 | 404;
	error: string;
	message: string;
}
export type MoveScopeResult =
	| { ok: true; records: number; documents: number }
	| MoveScopeFailure;

/** 目标项目必须是登记的（活或归档都算）：不制造新的孤儿（与导入同口径）。 */
function targetProjectRegistered(scope: string): boolean {
	if (!scope.startsWith("project:")) return true;
	const projectId = scope.slice("project:".length);
	try {
		return projectsStore()
			.listProjects(true)
			.some((project) => project.id === projectId);
	} catch {
		return false;
	}
}

/**
 * 带校验的 scope 迁移（API 入口用）。校验顺序：
 * 形态 → 不是自己搬自己 → 目标项目已登记 → 源真的存在（有行）。
 */
export function moveScopeChecked(
	from: string,
	to: string,
	options: { allowEmptySource?: boolean } = {},
): MoveScopeResult {
	if (!memoryEngine) {
		return { ok: false, status: 404, error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" };
	}
	if (!validTargetScope(from) || !validTargetScope(to)) {
		return {
			ok: false,
			status: 400,
			error: "bad_request",
			message: "from / to 只能是 global、partner:<id> 或 project:<uuid>",
		};
	}
	if (from === to) {
		return { ok: false, status: 400, error: "bad_request", message: "from 和 to 不能是同一个范围" };
	}
	if (!targetProjectRegistered(to)) {
		return { ok: false, status: 400, error: "unknown_project", message: "目标不是已登记的项目" };
	}
	// 源必须真的存在：搬 0 条不报成功，那多半是 uuid 写错了。
	// 用 listScopes 判定而不是列表条数——只剩已归档 / 已取代行的 scope 也值得搬。
	// 删项目路径传 `allowEmptySource`：那个项目可能本来就没记忆，不该因此删不掉。
	if (!options.allowEmptySource && !memoryEngine.listScopes().includes(from)) {
		return { ok: false, status: 400, error: "empty_source", message: "这个范围里没有可迁移的记忆" };
	}
	const moved = memoryEngine.moveScope(from, to);
	return { ok: true, records: moved.records, documents: moved.documents };
}

/** 合并项目时的记忆搬迁：不做"非空"校验（空 scope 也要能合），失败只报 0。 */
export function moveProjectMemory(
	sourceProjectId: string,
	targetProjectId: string,
): { records: number; documents: number } {
	if (!memoryEngine) return { records: 0, documents: 0 };
	return memoryEngine.moveScope(`project:${sourceProjectId}`, `project:${targetProjectId}`);
}

/** 软封存一个项目的全部记忆（删项目 `memory=archive`）；返回封存条数。 */
export function archiveProjectMemory(projectId: string): number {
	if (!memoryEngine) return 0;
	return memoryEngine.archiveScope(`project:${projectId}`);
}
