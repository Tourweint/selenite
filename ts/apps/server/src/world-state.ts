import { statSync } from "node:fs";
import { resolve } from "node:path";
import { realTargetOf } from "./path-guard.ts";

/**
 * 审批放行的「世界状态重验」（2026-11-10 批 19 §七；全景调研四 §9.2）。
 *
 * 现有放行绑的是**工具参数指纹**（8c）：人批准的是"写这个路径"，但参数没变不代表
 * 文件没变——等待审批的那段时间里别人可能已经改过它，照着旧上下文写下去就是覆盖别人的活。
 *
 * 轻量版只做两件事：
 *   1. 批准时给目标路径拍一张 `{mtimeMs, size}` 指纹（write / edit 才有目标路径）；
 *   2. 执行前再拍一张，不一致就**拒绝执行**并让模型重新确认。
 *
 * **只对 write / edit**：bash 的世界状态无法用两个数确定，不假装能验。
 * 开关默认关（这是收紧行为，先观望）。
 */

export const WORLD_STATE_TOOLS = new Set(["write", "edit"]);

/** 回滚开关：默认 **false**；只有 `AGENT_CONFIRM_WORLD_STATE=1/true/on` 才启用。 */
export function confirmWorldStateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.AGENT_CONFIRM_WORLD_STATE ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on";
}

export interface WorldFingerprint {
	/** 解析后的真实落点（绝对路径） */
	path: string;
	exists: boolean;
	/** 不存在时是 -1 */
	mtimeMs: number;
	/** 不存在时是 -1 */
	size: number;
}

const PATH_KEYS = ["path", "file_path", "filePath"];
/** 与 path-guard 同口径：全角空格归一、去掉行首 `@`、trim。 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function targetPathOf(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const values = args as Record<string, unknown>;
	for (const key of PATH_KEYS) {
		const value = values[key];
		if (typeof value !== "string") continue;
		const normalized = value.replace(UNICODE_SPACES, " ").trim();
		const path = normalized.startsWith("@") ? normalized.slice(1) : normalized;
		if (path) return path;
	}
	return null;
}

/** 给目标路径拍指纹（与 path-guard 同一套路径解析：相对路径按会话 cwd，符号链接落真实点）。 */
export function worldStateTarget(
	tool: string,
	args: unknown,
	cwd: string,
): WorldFingerprint | null {
	if (!WORLD_STATE_TOOLS.has(tool)) return null;
	const raw = targetPathOf(args);
	if (!raw) return null;
	return snapshotPath(realTargetOf(resolve(cwd, raw)));
}

/** 按已解析的绝对路径拍指纹（批准时刷新用，避免相对路径再解析一次）。 */
export function snapshotPath(target: string): WorldFingerprint {
	try {
		const stat = statSync(target);
		return { path: target, exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return { path: target, exists: false, mtimeMs: -1, size: -1 };
	}
}

export type WorldStateVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 对比两张指纹（纯函数）：任一缺失 → 放行（没记录就没有可比的东西，与开关关闭同口径）；
 * 存在性变了或 mtime / size 变了 → 拒绝。
 */
export function verifyWorldState(
	approved: WorldFingerprint | null | undefined,
	current: WorldFingerprint | null | undefined,
): WorldStateVerdict {
	if (!approved || !current) return { ok: true };
	if (approved.exists !== current.exists) {
		return {
			ok: false,
			reason: `目标文件在你批准之后变过了，请重新确认：${current.path}（${
				approved.exists ? "刚才是存在的，现在不见了" : "刚才不存在，现在有了"
			}）`,
		};
	}
	if (!approved.exists) return { ok: true };
	if (approved.mtimeMs !== current.mtimeMs || approved.size !== current.size) {
		return {
			ok: false,
			reason: `目标文件在你批准之后变过了，请重新确认：${current.path}`,
		};
	}
	return { ok: true };
}
