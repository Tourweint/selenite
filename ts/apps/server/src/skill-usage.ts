/**
 * 技能用量账（2026-11-10 批 17 §四）。
 *
 * `skill` 工具每成功取一次手册，给该技能 +1，落 `.data/skill-usage.json`：
 *   `{ "usage": { "<name>": { "count": 3, "lastUsedAt": "…" } } }`
 *
 * 只做两件事：计数、给列表端点提供 `usageCount` / `lastUsedAt` / `stale`。
 * **永不删除**：删技能只能由人在管理端点做；这里不清理任何条目（一个被删掉的技能
 * 的用量记录留着也无害，重名重建时还能接上历史）。
 *
 * 开关 `SKILL_USAGE`（默认开）：false = 不计数、列表也不回用量字段（一行回滚）。
 * 写失败只 warn：用量账是旁路审计，不能挡住"取手册"这个主动作。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { flagEnabled } from "./flags.ts";

export interface SkillUsageEntry {
	count: number;
	lastUsedAt: string | null;
}

/** 超过 90 天没被用过 = stale（只标记，不删、不移）。 */
export const SKILL_STALE_DAYS = 90;

/** 回滚开关：`false` / `0` / `off` = 不计数。 */
export function skillUsageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("SKILL_USAGE", env);
}

/** 用量账落点；探针用 env 与真实 `.data` 隔离。 */
export function skillUsagePath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_SKILL_USAGE_PATH?.trim() || ".data/skill-usage.json");
}

/** 读整份用量账；文件不存在 / 坏 JSON → 空账（用量是旁路，坏了不能挡列表）。 */
export function readSkillUsage(env: NodeJS.ProcessEnv = process.env): Record<string, SkillUsageEntry> {
	try {
		const parsed = JSON.parse(readFileSync(skillUsagePath(env), "utf8")) as unknown;
		const usage = (parsed as { usage?: unknown })?.usage;
		if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
		const out: Record<string, SkillUsageEntry> = {};
		for (const [name, value] of Object.entries(usage as Record<string, unknown>)) {
			const entry = value as { count?: unknown; lastUsedAt?: unknown };
			if (typeof entry?.count !== "number" || !Number.isFinite(entry.count)) continue;
			out[name] = {
				count: Math.max(0, Math.floor(entry.count)),
				lastUsedAt: typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : null,
			};
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * 记一次技能使用。名字由调用方保证来自索引（工具参数已校验过存在性）。
 * 每次调用都读一遍文件：个人技能量级（几十个）下这点 IO 可忽略，换来不用维护进程内缓存。
 */
export function recordSkillUse(
	name: string,
	now: Date = new Date(),
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!skillUsageEnabled(env)) return;
	try {
		const usage = readSkillUsage(env);
		const previous = usage[name];
		usage[name] = {
			count: (previous?.count ?? 0) + 1,
			lastUsedAt: now.toISOString(),
		};
		writeUsage(usage, skillUsagePath(env));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[skills] 用量计数失败（不影响取手册）: ${detail.slice(0, 200)}`);
	}
}

/**
 * stale 判定：距最后一次使用超过 90 天。
 *
 * 从没用过的技能以 `updatedAt`（文件 mtime）为基线——刚建的技能不该一上来就被标 stale；
 * 而从没更新也没用过的老文件，确实"该看一眼了"。
 */
export function isSkillStale(
	lastUsedAt: string | null | undefined,
	fallbackIso: string,
	now: Date = new Date(),
): boolean {
	const anchor = Date.parse(lastUsedAt ?? fallbackIso);
	if (Number.isNaN(anchor)) return false;
	return now.getTime() - anchor > SKILL_STALE_DAYS * 86_400_000;
}

/** 原子写：先写临时文件再改名，读到的永远是整份账。 */
function writeUsage(usage: Record<string, SkillUsageEntry>, path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, `${JSON.stringify({ usage }, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
