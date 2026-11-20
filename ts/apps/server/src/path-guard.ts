/**
 * 助手物理边界（2026-11-04 单根；2026-11-12 多根；2026-11-20 按权限档收口）。
 *
 * 目标路径**解析后必须落在任一根集合内**（工作区根 + 已登记项目根），都不在才硬拒绝。
 * 守哪些工具按档位分：
 *   - `full`（完全访问）：write / edit / read 全部直接放行（`AGENT_FULL_ACCESS_PATH_GUARD=1` 可回滚）；
 *   - `read-only` / `no-shell`：write / edit 限根；`read` 也限根（`AGENT_READ_PATH_GUARD=0` 可回滚）。
 * bash / powershell 不扫命令文本（设计已定，登记为已知边界）——它们的 cwd 已在根集合内，
 * 命令里写绝对路径逃逸由审批兜底。
 *
 * 提成纯函数是为了能直接断言：入参只有工具名、参数、根集合、当前 cwd 和档位，
 * 不读全局状态，也不碰磁盘以外的环境（根集合为空时旁路）。
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** 受限两档下守的文件工具（read 是否受守还看档位与开关，见下方分支）。 */
const GUARDED_TOOLS = new Set(["write", "edit", "read"]);
/** pi 的 write / edit / read 都用 `path`；留两个别名给未来工具，不改变当前语义 */
const PATH_KEYS = ["path", "file_path", "filePath"];
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** 与 `agent/policy.ts` 的 `ToolAccess` 同值；这里只读字面量，避免低层模块反向依赖。 */
export type GuardAccess = "full" | "read-only" | "no-shell";

/**
 * 完全访问档是否仍过路径闸门（回滚开关，2026-11-20）。
 * 缺省 off = 完全访问不再限根；`AGENT_FULL_ACCESS_PATH_GUARD=1/true/on` 回到旧形态
 * （write/edit 限根、read 不限）。
 */
export function fullAccessPathGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.AGENT_FULL_ACCESS_PATH_GUARD?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on";
}

/**
 * 受限两档（只读 / 在工作区内修改）是否把 `read` 也限根（2026-11-20）。
 * 缺省 on；`AGENT_READ_PATH_GUARD=0/false/off` 回到旧形态（read 不过闸门）。
 */
export function readToolPathGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.AGENT_READ_PATH_GUARD?.trim().toLowerCase();
	return !(raw === "0" || raw === "false" || raw === "off");
}

function samePath(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32"
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

/** 与 pi 的 resolveToolPath 同口径：全角空格归一、去掉行首 `@`。 */
function normalizeToolPath(value: string): string {
	const normalized = value.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

/**
 * 不存在的目标路径也要算出真实落点：
 * 先找到最近的已存在祖先并 realpath，再把剩余段接回去 —— `workspace/link-out/new.txt`
 * 这种"祖先是指向外部的符号链接"必须在写入前识破。
 */
function realTarget(target: string): string {
	let probe = target;
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (samePath(parent, probe)) break;
		probe = parent;
	}
	let realProbe: string;
	try {
		realProbe = realpathSync(probe);
	} catch {
		// 连祖先都解析不了（权限/损坏）：保守按原路径判，交给下面的 inside 检查。
		return target;
	}
	const tail = relative(probe, target);
	return tail ? join(realProbe, tail) : realProbe;
}

/** 根自身也算"在根内"（写根目录本身会由工具自己报错，不在这里制造歧义）。 */
export function insideOrEqual(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 目标路径的**真实落点**（含尚未存在的路径：最近的已存在祖先 realpath 后接回尾段）。
 * 导出给 `skills-api.ts` 用：技能写盘的越界复核与 pathGuard 必须是同一套算法。
 */
export function realTargetOf(target: string): string {
	return realTarget(target);
}

export interface PathGuardInput {
	readonly tool: string;
	readonly args: unknown;
	/**
	 * 助手可读写的根目录 realpath 列表（2026-11-12 多根：工作区 + 已登记项目）。
	 * 空数组 = 未配置任何根，守卫旁路（不把没配的人锁死）。
	 */
	readonly workspaceRoots: readonly string[];
	/** 本轮会话执行环境的 cwd（相对路径按它解析） */
	readonly cwd: string;
	/**
	 * 当前权限档（2026-11-20）。缺省按受限档处理（最保守）；
	 * `full` 且没开 `AGENT_FULL_ACCESS_PATH_GUARD` 时整个守卫旁路。
	 */
	readonly access?: GuardAccess;
	/**
	 * 用户在本会话里附上来的文件绝对路径（2026-11-20）。**只对 `read` 生效**：
	 * 附件是用户主动递给你看的，不属于越界；write/edit 不享受这个例外。
	 */
	readonly allowedFiles?: readonly string[];
}

/** 越界时返回给模型的 blockReason；放行返回 undefined。 */
export function pathGuardBlockReason(input: PathGuardInput): string | undefined {
	const { tool, args, workspaceRoots, cwd, access, allowedFiles } = input;
	const full = access === "full";
	// 完全访问 = 不受文件权限约束（2026-11-20 用户拍板）；回滚开关让它回到旧的限根形态。
	if (full && !fullAccessPathGuardEnabled()) return undefined;
	if (!GUARDED_TOOLS.has(tool)) return undefined;
	// 回滚形态下完全访问仍守 write/edit，但 read 保持旧行为（不限根）。
	if (full && tool === "read") return undefined;
	if (tool === "read" && !readToolPathGuardEnabled()) return undefined;
	if (!workspaceRoots.length) return undefined;
	if (!args || typeof args !== "object") return undefined;

	const values = args as Record<string, unknown>;
	let raw: string | undefined;
	for (const key of PATH_KEYS) {
		const value = values[key];
		if (typeof value === "string") {
			raw = value;
			break;
		}
	}
	// 没有目标路径（参数不合法）不在守卫职责内：交给工具自身的参数校验。
	if (raw === undefined) return undefined;
	const path = normalizeToolPath(raw).trim();
	if (!path) return undefined;

	const target = realTarget(resolve(cwd, path));
	// 用户附上来的文件：read 放行（只按“同一个文件”判，不给它所在的目录开口子）。
	if (tool === "read" && allowedFiles?.length) {
		if (allowedFiles.some((file) => samePath(realTarget(resolve(cwd, file)), target))) return undefined;
	}
	if (workspaceRoots.some((root) => insideOrEqual(root, target))) return undefined;
	return `路径不在已登记的工作区/项目目录内：请到 设置 → 项目 里添加该目录（${workspaceRoots.join("、")}）`;
}
