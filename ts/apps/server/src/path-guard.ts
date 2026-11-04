/**
 * 最大工作区物理边界（2026-11-04 侧边栏工作区与当前项目方案 §2.4）。
 *
 * 只守 `write` / `edit` 的目标路径：**解析后必须落在工作区根内**，越界直接拒绝执行。
 * bash / powershell 不扫命令文本（设计已定，登记为已知边界）——它们的 cwd 已由
 * 会话执行环境圈在工作区内，命令里写绝对路径逃逸由审批兜底。
 *
 * 提成纯函数是为了能直接断言：入参只有工具名、参数、工作区根和当前 cwd，
 * 不读全局状态，也不碰磁盘以外的环境（工作区未设时由调用方传 null → 旁路）。
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const GUARDED_TOOLS = new Set(["write", "edit"]);
/** pi 的 write / edit 都用 `path`；留两个别名给未来工具，不改变当前语义 */
const PATH_KEYS = ["path", "file_path", "filePath"];
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

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
function insideOrEqual(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface PathGuardInput {
	readonly tool: string;
	readonly args: unknown;
	/** 最大工作区根的 realpath；null = 未设工作区，守卫旁路 */
	readonly workspaceRoot: string | null;
	/** 本轮会话执行环境的 cwd（相对路径按它解析） */
	readonly cwd: string;
}

/** 越界时返回给模型的 blockReason；放行返回 undefined。 */
export function pathGuardBlockReason(input: PathGuardInput): string | undefined {
	const { tool, args, workspaceRoot, cwd } = input;
	if (!workspaceRoot || !GUARDED_TOOLS.has(tool)) return undefined;
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
	if (insideOrEqual(workspaceRoot, target)) return undefined;
	return `路径越出最大工作区（${workspaceRoot}）：如确需写入外部，请在设置调整工作区或用完全访问档`;
}
