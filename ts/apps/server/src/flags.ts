import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Hono } from "hono";

/**
 * 运行时开关层（2026-11-09 用户拍板：设置尽量在界面里控制，不逼人碰服务端 env）。
 *
 * 机制：`.data/agent-flags.json` 存界面改过的开关（{ KEY: "value" }）。
 * - 启动时 `loadFlagOverrides()` 把文件里的值**覆盖写进 process.env**。既有消费代码
 *   全都是函数内懒读 process.env（逐处核对见变更记录），所以覆盖后立即生效，
 *   消费代码一行不用改；env 仍是缺省来源——文件里没写的键完全回到 env 行为（回滚 = 删文件）。
 * - 界面 `PUT /api/v1/agent/flags/:key`：校验后落盘 + 同步写 env。`hot: true` 的开关
 *   当场生效；`hot: false` 的（路由挂载 / 工具注册 / 模块常量在启动时冻结）重启后生效，
 *   文件保证重启后仍是用户选的值。
 * - 界面回滚：`AGENT_FLAGS_UI=false` → 端点不挂（GET 留着只读无妨，一并关）。
 *
 * 刻意不做：不在这一层做权限分级（写端点在 /api/v1 鉴权后面，与其它设置同权）；
 * 不做文件锁（单进程 + 原子写足够）。
 */

export interface FlagDef {
	key: string;
	values: string[];
	/** 缺省值（env 未设时界面显示的形态） */
	defaultValue: string;
	/**
	 * true = 消费处函数内懒读 env（改完即生效）；
	 * false = 启动时冻结（路由挂载 / 工具注册 / 模块常量），重启后生效。
	 */
	hot: boolean;
}

/** 进界面的白名单：只收"用户行为开关"，路径/令牌类一律不收 */
export const FLAG_DEFS: FlagDef[] = [
	{ key: "AUTONOMY_ENABLED", values: ["true", "false", "observe"], defaultValue: "false", hot: true },
	{ key: "AGENT_ATTACHMENTS", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "AGENT_EDIT_RESEND", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "CURRENT_PROJECT", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "MEMORY_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "MEMORY_EXTRACT", values: ["auto", "llm", "rule"], defaultValue: "auto", hot: true },
	// persona 记忆库接入（2026-11-09）：读 = persona_recall 工具的显式关闸（默认开，
	// 但还要求 PERSONA_MEMORY_ASK 配了 ask.py 路径才上架——路径类 env 按白名单纪律不进界面，
	// 开关文案里写明）；写 = 主对话导出（默认关，对外送数据默认不动）。两个消费处都懒读 env，热生效。
	{ key: "PERSONA_MEMORY_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "PERSONA_EXPORT_ENABLED", values: ["true", "false"], defaultValue: "false", hot: true },
	{ key: "MINISTER_DISPATCH_AUTHORITY", values: ["true", "false"], defaultValue: "false", hot: true },
	{ key: "DEVICE_AUTO_DISPATCH", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "PARTNER_WORK_RECORD", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "SKILLS_ADMIN", values: ["true", "false"], defaultValue: "true", hot: false },
	{ key: "ROUTINE_SELF_SERVICE", values: ["true", "false"], defaultValue: "true", hot: false },
	{ key: "COMPANIONS_ENABLED", values: ["true", "false"], defaultValue: "true", hot: false },
	{ key: "GROUPS_ENABLED", values: ["true", "false"], defaultValue: "true", hot: false },
	{ key: "CHANCELLOR_ENABLED", values: ["true", "false"], defaultValue: "true", hot: false },
	// 派活完成即唤醒（2026-11-10 批 29）：消费处每次 flush 懒读 env，所以 hot:true。
	{ key: "DELEGATION_WAKE_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "TOPICS_ENABLED", values: ["true", "false"], defaultValue: "true", hot: false },
	// 结构化提问（2026-11-09）：工具注册在启动时冻结，所以 hot:false。
	{ key: "AGENT_ASK_USER", values: ["true", "false"], defaultValue: "true", hot: false },
];

const FLAG_BY_KEY = new Map(FLAG_DEFS.map((def) => [def.key, def]));

export function flagsUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AGENT_FLAGS_UI ?? "").trim().toLowerCase() !== "false";
}

export function flagsPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_FLAGS_PATH?.trim() || ".data/agent-flags.json");
}

function readOverrideMap(path: string): Record<string, string> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const out: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value === "string") out[key] = value;
			}
			return out;
		}
	} catch {
		/* 文件不存在 / 坏 JSON：当作没有覆盖 */
	}
	return {};
}

function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, content, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** 启动装载（index.ts 在 loadEnvFile / injectProviderKeys 之后调一次）：文件覆盖 env */
export function loadFlagOverrides(env: NodeJS.ProcessEnv = process.env): number {
	const map = readOverrideMap(flagsPath(env));
	let applied = 0;
	for (const [key, value] of Object.entries(map)) {
		const def = FLAG_BY_KEY.get(key);
		if (!def || !def.values.includes(value)) {
			console.warn(`[flags] 跳过无效开关：${key}=${value}`);
			continue;
		}
		env[key] = value;
		applied += 1;
	}
	if (applied) console.log(`[flags] 已应用 ${applied} 项界面覆盖（${flagsPath(env)}）`);
	return applied;
}

/** 当前形态：env 现值（缺省回落 defaultValue）+ 是否被文件覆盖过 */
export function listFlags(env: NodeJS.ProcessEnv = process.env): {
	flags: { key: string; value: string; defaultValue: string; hot: boolean; overridden: boolean }[];
} {
	const map = readOverrideMap(flagsPath(env));
	return {
		flags: FLAG_DEFS.map((def) => ({
			key: def.key,
			value: env[def.key]?.trim() || def.defaultValue,
			defaultValue: def.defaultValue,
			hot: def.hot,
			overridden: Boolean(map[def.key]),
		})),
	};
}

/** 界面写一个开关：校验 → 落盘 → 同步写 env（懒读的消费代码当场看到） */
export function setFlag(
	key: string,
	value: string,
	env: NodeJS.ProcessEnv = process.env,
): { ok: true; hot: boolean } | { ok: false; status: 400 | 404; message: string } {
	const def = FLAG_BY_KEY.get(key);
	if (!def) return { ok: false, status: 404, message: `没有叫 ${key} 的开关` };
	if (!def.values.includes(value)) {
		return { ok: false, status: 400, message: `${key} 的取值只能是：${def.values.join(" / ")}` };
	}
	const path = flagsPath(env);
	const map = readOverrideMap(path);
	map[key] = value;
	atomicWrite(path, `${JSON.stringify(map, null, "\t")}\n`);
	env[key] = value;
	return { ok: true, hot: def.hot };
}

export function mountFlags(app: Hono, deps: { enabled?: boolean } = {}): void {
	if (!(deps.enabled ?? flagsUiEnabled())) return;

	app.get("/api/v1/agent/flags", (c) => c.json(listFlags()));

	app.put("/api/v1/agent/flags/:key", async (c) => {
		const key = c.req.param("key");
		const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
		if (typeof body?.value !== "string") {
			return c.json({ error: "bad_request", message: "value 必须是字符串" }, 400);
		}
		const result = setFlag(key, body.value);
		if (!result.ok) {
			return c.json({ error: "bad_request", message: result.message }, result.status);
		}
		return c.json({ ok: true, key, value: body.value, hot: result.hot });
	});
}
