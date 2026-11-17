/**
 * 工具用量账（2026-11-17，方案 docs/设计方案/2026-11-17-工具调用计数.md）。
 *
 * 模型发起的工具调用真实执行完（lifecycle afterTool），给该工具 +1；
 * `tool_search` 命中加载一个 deferred 工具时给该工具记一次 `loads`。
 * 落 `.data/tool-usage.json`：
 *   `{ "usage": { "<name>": { "count": 3, "err": 0, "loads": 1, "lastUsedAt": "…" } } }`
 *
 * 口径：只计真实执行——内核 bash/read/write/edit、deferred 加载后再调用、worker 会话
 * 的调用全都经过同一个 afterTool，天然覆盖。被闸门拦下 / 工具不存在 / 参数校验失败
 * 在内核里直接 settle，不走 afterTool，不进账（拦下另有 gate-blocks.jsonl 审计）。
 * 用途：给"按使用频率动态调整上下文"（提升常被用的 deferred / 收敛常驻）当数据底座。
 *
 * 永不删除（同 skill-usage：工具删了记录留着无害，重装同名接得上）。
 * 写失败只 warn：用量账是旁路审计，不能挡住工具执行这个主动作。
 * 开关 `TOOL_USAGE`（默认开）：false = 不记账、端点 404（一行回滚，仿 SKILL_USAGE）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ToolUsageEntry {
	/** 真实执行次数（成败都算）。 */
	count: number;
	/** 其中执行报错的次数。 */
	err: number;
	/** 被 tool_search 按需加载的次数（≠ 执行：加载了没调用也记在这里）。 */
	loads: number;
	lastUsedAt: string | null;
}

/** 回滚开关：`false` / `0` / `off` = 不记账。 */
export function toolUsageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.TOOL_USAGE ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 用量账落点；探针用 env 与真实 `.data` 隔离。 */
export function toolUsagePath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_TOOL_USAGE_PATH?.trim() || ".data/tool-usage.json");
}

/** 读整份用量账；文件不存在 / 坏 JSON → 空账（用量是旁路，坏了不能挡列表）。 */
export function readToolUsage(env: NodeJS.ProcessEnv = process.env): Record<string, ToolUsageEntry> {
	try {
		const parsed = JSON.parse(readFileSync(toolUsagePath(env), "utf8")) as unknown;
		const usage = (parsed as { usage?: unknown })?.usage;
		if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
		const out: Record<string, ToolUsageEntry> = {};
		for (const [name, value] of Object.entries(usage as Record<string, unknown>)) {
			const entry = value as { count?: unknown; err?: unknown; loads?: unknown; lastUsedAt?: unknown };
			if (typeof entry?.count !== "number" || !Number.isFinite(entry.count)) continue;
			const num = (raw: unknown) =>
				typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
			out[name] = {
				count: Math.max(0, Math.floor(entry.count)),
				err: num(entry.err),
				loads: num(entry.loads),
				lastUsedAt: typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : null,
			};
		}
		return out;
	} catch {
		return {};
	}
}

/** 端点投影：按执行次数降序（次数并列按名字稳定排序），平面对象变数组省得前端再排。 */
export function toolUsageRows(env: NodeJS.ProcessEnv = process.env): Array<ToolUsageEntry & { name: string }> {
	return Object.entries(readToolUsage(env))
		.map(([name, entry]) => ({ name, ...entry }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * 记一次真实执行。`ok` = 执行是否报错（bash 转后台的替换结果算成功）。
 * 每次调用都读一遍文件：一天几十次工具调用的量级下这点 IO 可忽略，换来不用维护进程内缓存。
 */
export function recordToolUse(
	name: string,
	ok: boolean,
	now: Date = new Date(),
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!toolUsageEnabled(env)) return;
	try {
		const usage = readToolUsage(env);
		const previous = usage[name];
		usage[name] = {
			count: (previous?.count ?? 0) + 1,
			err: (previous?.err ?? 0) + (ok ? 0 : 1),
			loads: previous?.loads ?? 0,
			lastUsedAt: now.toISOString(),
		};
		writeUsage(usage, toolUsagePath(env));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[tools] 用量计数失败（不影响工具执行）: ${detail.slice(0, 200)}`);
	}
}

/** 记一次 tool_search 按需加载（只表明"被搜出来过"，不动 count / lastUsedAt）。 */
export function recordToolLoad(
	name: string,
	now: Date = new Date(),
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!toolUsageEnabled(env)) return;
	try {
		const usage = readToolUsage(env);
		const previous = usage[name];
		usage[name] = {
			count: previous?.count ?? 0,
			err: previous?.err ?? 0,
			loads: (previous?.loads ?? 0) + 1,
			lastUsedAt: previous?.lastUsedAt ?? null,
		};
		writeUsage(usage, toolUsagePath(env));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[tools] 加载计数失败（不影响工具加载）: ${detail.slice(0, 200)}`);
	}
}

/** 原子写：先写临时文件再改名，读到的永远是整份账。 */
function writeUsage(usage: Record<string, ToolUsageEntry>, path: string): void {
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
