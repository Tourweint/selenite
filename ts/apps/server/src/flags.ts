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
	/**
	 * 数值型开关（2026-11-13 自动归档天数）：`values` 留空且给了 `min` 时，
	 * 取值按「≥min 的整数」校验，不再查枚举表。只有界面真的要自由数值才用。
	 */
	min?: number;
	/** 数值型开关的上界（2026-11-14 压缩百分比）：给了就按「min–max 的整数」校验。 */
	max?: number;
}

/** 取值校验收口：枚举表命中，或数值型开关按整数 ≥min（≤max）校验（loadFlagOverrides / setFlag 共用）。 */
function flagValueAllowed(def: FlagDef, value: string): boolean {
	if (def.values.includes(value)) return true;
	if (def.values.length === 0 && def.min !== undefined) {
		const parsed = Number(value);
		if (!Number.isInteger(parsed)) return false;
		if (parsed < def.min) return false;
		if (def.max !== undefined && parsed > def.max) return false;
		return true;
	}
	return false;
}

/** 进界面的白名单：只收"用户行为开关"，路径/令牌类一律不收 */
export const FLAG_DEFS: FlagDef[] = [
	// 自主轮总开关（2026-11-13 起默认开：没人盯着跑的轮要有人兜底提醒+审批收紧；显式 false 才关）。
	{ key: "AUTONOMY_ENABLED", values: ["true", "false", "observe"], defaultValue: "true", hot: true },
	{ key: "AGENT_ATTACHMENTS", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "AGENT_EDIT_RESEND", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "CURRENT_PROJECT", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "MEMORY_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "MEMORY_EXTRACT", values: ["auto", "llm", "rule"], defaultValue: "auto", hot: true },
	// 记忆页 A 版（2026-11-13）：前端每次进记忆页懒读，false = 旧页整套 DOM/逻辑。
	{ key: "MEMORY_PAGE_A", values: ["true", "false"], defaultValue: "true", hot: true },
	// 整理后台任务（2026-11-13）：false = ?background=1 也同步等待（旧页/旧探针回滚）。
	{ key: "MEMORY_CONSOLIDATE_JOB", values: ["true", "false"], defaultValue: "true", hot: true },
	// 规则抽取噪声过滤（2026-11-13）：false = 回到"每句 ≥6 字都记成经历"。
	{ key: "MEMORY_EXTRACT_NOISE", values: ["true", "false"], defaultValue: "true", hot: false },
	// 外接记忆库页脚（2026-11-13）：false = 设置页不显示、端点 404。
	{ key: "MEMORY_EXTERNAL", values: ["true", "false"], defaultValue: "true", hot: true },
	// persona 记忆库接入（2026-11-09）：读 = persona_recall 工具的显式关闸（默认开，
	// 但还要求 PERSONA_MEMORY_ASK 配了 ask.py 路径才上架——路径类 env 按白名单纪律不进界面，
	// 开关文案里写明）；写 = 主对话导出（默认关，对外送数据默认不动）。两个消费处都懒读 env，热生效。
	{ key: "PERSONA_MEMORY_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "PERSONA_EXPORT_ENABLED", values: ["true", "false"], defaultValue: "false", hot: true },
	// 执事派发权总闸（2026-11-06）：消费处 `ministerDispatchMasterEnabled()` 缺省就是开
	// （只有明确 false/0 才关）；`defaultValue` 2026-11-15 从 false 修正为 true，界面不再
	// 把"实际开着"的开关标成"默认关"。
	{ key: "MINISTER_DISPATCH_AUTHORITY", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "DEVICE_AUTO_DISPATCH", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "PARTNER_WORK_RECORD", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "SKILLS_ADMIN", values: ["true", "false"], defaultValue: "true", hot: false },
	{ key: "ROUTINE_SELF_SERVICE", values: ["true", "false"], defaultValue: "true", hot: false },
	{ key: "COMPANIONS_ENABLED", values: ["true", "false"], defaultValue: "true", hot: false },
	{ key: "GROUPS_ENABLED", values: ["true", "false"], defaultValue: "true", hot: false },
	{ key: "CHANCELLOR_ENABLED", values: ["true", "false"], defaultValue: "true", hot: false },
	// 派活完成即唤醒（2026-11-10 批 29）：消费处每次 flush 懒读 env，所以 hot:true。
	{ key: "DELEGATION_WAKE_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	// 工具结果投影总开关（2026-11-13 工具层结果契约化 §5.4 回滚开关 2）：消费处每次 execute 懒读 env，hot:true。
	{ key: "TOOL_PROJECTION", values: ["true", "false"], defaultValue: "true", hot: true },
	// 打手工具结果整理（2026-11-16）：只管**本机内核打手**（chatKind==="worker"）的默认值，
	// 总闸 `TOOL_PROJECTION` 关时它不生效；执事三态（partners.tool_projection）压过它。
	// 外接 CLI 打手（CodeBuddy / Qoder / Claude Code / Codex / OpenCode）跑自己的工具、
	// 不经过包装器，**不受此开关影响**。消费处每次 execute 懒读 env，所以 hot:true。
	{ key: "TOOL_PROJECTION_WORKER", values: ["true", "false"], defaultValue: "true", hot: true },
	// 记忆召回总闸（2026-11-16 父子关系补齐）：父 = 这一行（所有会话都不再自动带记忆），
	// 子 = 每位执事/总管人设页的「记忆 + 项目记忆」开关（`persona_switches.memoryRecallEnabled`，
	// 默认开）。关总闸 = 全部会话只靠 recall 工具主动查；`MEMORY_ENABLED` 管的是记忆库本身
	// （写与读的能力），这个只管"每轮自动注入"那一半。消费处每次请求懒读 env，所以 hot:true。
	{ key: "PARTNER_MEMORY_RECALL", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "TOPICS_ENABLED", values: ["true", "false"], defaultValue: "true", hot: false },
	// 结构化提问（2026-11-09）：工具注册在启动时冻结，所以 hot:false。
	{ key: "AGENT_ASK_USER", values: ["true", "false"], defaultValue: "true", hot: false },
	// 任务中心重做回滚开关（2026-11-13 批 1）：web 每次进任务中心懒读，
	// false = 退回旧三列看板（旧渲染函数与旧 DOM 都还在），所以 hot:true。
	{ key: "TASKS_REDESIGN_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	// 侧栏对话按创建者分组（2026-11-15）：false = 服务端不下发 chats 的 tasks 键、
	// 前端回旧版平铺列表（nav#chats + tasks-mini 三块拼装），所以 hot:true。
	{ key: "SIDEBAR_TASK_GROUPS", values: ["true", "false"], defaultValue: "true", hot: true },
	// 永久删除（2026-11-13 归档管理对齐 ZCode 批A）：端点常挂、消费处每次请求懒读 env，
	// 所以 hot:true。false = deletion-preview / delete 两端点 400「永久删除已关闭」（回滚开关）。
	{ key: "CHAT_HARD_DELETE", values: ["true", "false"], defaultValue: "true", hot: true },
	// 对话流逐字浮现（2026-11-13）：web 每次开新消息懒读（首屏拉一次 flags），
	// false = 退回旧的整块渲染 + 旧 caret，所以 hot:true。
	{ key: "CHAT_STREAM_REVEAL", values: ["true", "false"], defaultValue: "true", hot: true },
	// 自动归档（同批）：调度器每轮懒读（动态开关经 flags 端点的 onChange 接线开停定时器）。
	// 2026-11-15 用户口径：做出来的功能默认就开（"剩下的全开"），只有明确 false/0/off 才关；
	// 之前"默认关"是怕新装机器替用户做主，现已按用户要求翻成默认开。
	{ key: "ARCHIVE_AUTO_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	// 自动归档天数：数值型开关（values 留空 + min=1，按 ≥1 整数校验）；每轮懒读，改完下一轮生效。
	{ key: "ARCHIVE_AUTO_DAYS", values: [], defaultValue: "30", hot: true, min: 1 },
	// 对话历史分页（2026-11-13）：web 每次 openChat 懒读（同 TASKS 的一次性缓存），
	// false = 退回一次拉最近 200 条、无上滑加载 + 无日期分隔；服务端同时忽略 page/before 参数。
	{ key: "CHAT_HISTORY_PAGING_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	// 上下文压缩（2026-11-14 二次拍板：只留两档，默认按百分比 70%）。
	// 消费处是 `buildHarnessSettings`（Harness settings 访问器，每次使用现算），所以全 hot：
	// 改完下一轮就按新档压，不重启。数值型沿用 `values: [] + min` 机制；百分比另给 max，
	// 5% 以下等于每轮都压、95% 以上等于没有留白给回答。
	// 保留原文 / 后台提前不在这里——那不是用户能凭直觉调的量，一律吃内核默认（20000 / 32768）。
	{ key: "AGENT_COMPACT_ENABLED", values: ["true", "false"], defaultValue: "true", hot: true },
	{ key: "AGENT_COMPACT_TRIGGER_MODE", values: ["percent", "tokens"], defaultValue: "percent", hot: true },
	// 缺省 70 与 `compaction-settings.ts` 的 DEFAULT_PERCENT 必须一致（界面回显的就是生效值）
	{ key: "AGENT_COMPACT_TRIGGER_PERCENT", values: [], defaultValue: "70", hot: true, min: 5, max: 95 },
	// 绝对触发点（K）：留空 = 该档不生效、回落内核默认白；填了就是"到多少 K 压一次"
	{ key: "AGENT_COMPACT_TRIGGER_K", values: [], defaultValue: "", hot: true, min: 1 },
	// 执事招聘模板（2026-11-15）：招聘墙 + 新建弹窗模板条，web 每次渲染列表/弹窗懒读（带模块级缓存）。
	// false = 空态回旧「新建执事」按钮、新建弹窗无模板条；模板数据是前端常量（web/partner-templates.js）。
	{ key: "PARTNER_TEMPLATES", values: ["true", "false"], defaultValue: "true", hot: true },
	// 技能索引摘要截断（2026-11-15 上下文预算批）：开 = 索引每行截到
	// `SKILLS_INDEX_SUMMARY_CHARS`（默认 120 字），关 = 显示完整摘要。
	// 索引**按会话冻结**（首轮渲染后不再改），所以改完只影响**新开的会话**——老会话
	// 保持打开时的索引，这是既有口径（改索引会让已命中的 system 缓存前缀整段作废）。
	// 消费处是 renderIndex（每次首渲染现读 env），所以标 hot: true（对新会话即时）。
	{ key: "SKILLS_INDEX_CLIP", values: ["true", "false"], defaultValue: "true", hot: true },
	// 召回后去重（2026-11-15 上下文预算批）：同一件事的多种说法只注入一条（保留分数最高）。
	// 消费处 `recallContext` 每轮懒读 env，所以 hot: true，改完下一轮生效。
	{ key: "MEMORY_INJECT_DEDUPE", values: ["true", "false"], defaultValue: "true", hot: true },
];

const FLAG_BY_KEY = new Map(FLAG_DEFS.map((def) => [def.key, def]));

/** 启动装载后每个键当时真正生效的值。用来判断 hot:false 的改动是否还没重启——
 *  文件里的值和启动时不一样 → 界面标「待重启」；重启装载后两者相等，标自动消失。 */
const bootValues = new Map<string, string>();
let bootCaptured = false;

function captureBootValues(env: NodeJS.ProcessEnv): void {
	if (bootCaptured) return;
	bootCaptured = true;
	for (const def of FLAG_DEFS) bootValues.set(def.key, env[def.key]?.trim() || def.defaultValue);
}

/**
 * 对话历史分页开关（2026-11-13）。
 * 缺省开；显式 false/0/off 才关（与其它"新能力默认开"的开关同口径）。
 */
export function chatHistoryPagingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.CHAT_HISTORY_PAGING_ENABLED?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

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
		if (!def || !flagValueAllowed(def, value)) {
			console.warn(`[flags] 跳过无效开关：${key}=${value}`);
			continue;
		}
		env[key] = value;
		applied += 1;
	}
	if (applied) console.log(`[flags] 已应用 ${applied} 项界面覆盖（${flagsPath(env)}）`);
	// 只有主进程启动装载才有"启动值"；测试传临时 env 时不记录，避免跨用例污染。
	if (env === process.env) captureBootValues(env);
	return applied;
}

/** 当前形态：env 现值（缺省回落 defaultValue）+ 是否被文件覆盖过 + 是否待重启 */
export function listFlags(env: NodeJS.ProcessEnv = process.env): {
	flags: {
		key: string;
		value: string;
		defaultValue: string;
		hot: boolean;
		overridden: boolean;
		pendingRestart: boolean;
	}[];
} {
	const map = readOverrideMap(flagsPath(env));
	return {
		flags: FLAG_DEFS.map((def) => ({
			key: def.key,
			value: env[def.key]?.trim() || def.defaultValue,
			defaultValue: def.defaultValue,
			hot: def.hot,
			overridden: Boolean(map[def.key]),
			pendingRestart:
				env === process.env &&
				!def.hot &&
				bootCaptured &&
				(map[def.key] ?? def.defaultValue) !== (bootValues.get(def.key) ?? def.defaultValue),
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
	const path = flagsPath(env);
	// 数值型开关的空值 = "回到默认"（2026-11-14 上下文压缩）：删掉覆盖行 + 删 env，
	// 消费处下一次懒读就拿到"没设"，回落内核默认。枚举型开关没有"空"这一档，照旧拒收。
	if (value.trim() === "" && def.values.length === 0) {
		const map = readOverrideMap(path);
		if (Object.hasOwn(map, key)) {
			delete map[key];
			atomicWrite(path, `${JSON.stringify(map, null, "\t")}\n`);
		}
		delete env[key];
		return { ok: true, hot: def.hot };
	}
	if (!flagValueAllowed(def, value)) {
		const allowed =
			def.values.length > 0
				? `：${def.values.join(" / ")}`
				: def.max !== undefined
					? `：${def.min ?? 1}–${def.max} 的整数`
					: `：≥${def.min ?? 1} 的整数`;
		return { ok: false, status: 400, message: `${key} 的取值只能是${allowed}` };
	}
	const map = readOverrideMap(path);
	map[key] = value;
	atomicWrite(path, `${JSON.stringify(map, null, "\t")}\n`);
	env[key] = value;
	return { ok: true, hot: def.hot };
}

export function mountFlags(
	app: Hono,
	deps: {
		enabled?: boolean;
		/** 开关写成功后的回调（2026-11-13）：自动归档调度器靠它动态开停定时器，否则运行中打开开关要等重启。 */
		onChange?: (key: string, value: string) => void;
	} = {},
): void {
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
		deps.onChange?.(key, body.value);
		return c.json({ ok: true, key, value: body.value, hot: result.hot });
	});
}
