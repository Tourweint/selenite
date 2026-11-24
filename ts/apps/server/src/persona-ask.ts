import { spawn, type ChildProcess } from "node:child_process";
import { flagEnabled } from "./flags.ts";

/**
 * persona-metric 记忆库检索（2026-11-09 persona 接入批一）。
 *
 * 总管本地短记忆（`recall`，`.data/memory.db`）只覆盖近期与偏好；问到"去年 / 2024 年"
 * 这类很久以前的事、或要原文出处时，走这里去查主人一生的记忆库。
 *
 * 只读契约（方案 D-甲 / D-丙）：
 *   - 唯一入口是 persona-metric 自带的检索门 `analysis/ask.py`，`--json` 输出稳定结构；
 *   - 子进程 argv 数组传参，**不用 shell**——模型只能影响 question 文本本身，没有注入面；
 *   - ask.py 自己 `mode=ro` 只读打开 persona.db，本模块绝不直接碰那个库；
 *   - 失败一律降级成 `ok:false`，不抛异常打断对话轮（与 `recallContext` 同口径）。
 *
 * 日志纪律：只记问题字数 / 耗时 / ok / 组数，不记 question 原文与 stderr 全文。
 */

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** 工具调用（recall 的外部槽）的超时兜底：实测 0.7s 检索 + Python 启动，15s 足够；
 *  卡住就放弃，别让一轮对话僵死。实际值可被外接库配置的 timeouts.askMs 覆盖。 */
export const PERSONA_ASK_TIMEOUT_MS = 15_000;
/** 每轮轻召回的超时兜底（2026-11-24 两档超时）：正常 0.8s，8s 已是十倍；超时静默空，
 *  别让一个坏库每轮把对话拖住。实际值可被外接库配置的 timeouts.lightMs 覆盖。 */
export const PERSONA_LIGHT_TIMEOUT_MS = 8_000;
/** stderr 只留够取第一行的量（可能含本机路径，绝不整段落日志）。 */
const STDERR_KEEP = 4_096;

export type PersonaGroup =
	| "memory_day"
	| "event"
	| "segment"
	| "fact"
	| "entity"
	| "tension";

/** 六组的展示顺序（与 ask.py 的 render 顺序一致）。 */
export const PERSONA_GROUP_ORDER: readonly PersonaGroup[] = [
	"memory_day",
	"event",
	"fact",
	"segment",
	"entity",
	"tension",
];

/**
 * 一条证据。字段按 ask.py 实测 JSON 映射（2026-11-09 真跑 `ask.py "四级考了几次" --json`）：
 *   - memory_day: {id, date, title, body, conf, n_seg, why}
 *   - event:      {id, title, object, span, arc_n, outcome, why}（无 date）
 *   - fact:       {id, date, title, body, conf, why}
 *   - segment:    {id, date, module, text, kind, conf, why}
 *   - entity:     {id, name, type, role, n_mention, why}（无 date/title/text）
 *   - tension:    {id, name, trigger, trigger_type, side_a, side_b, why}
 */
export interface PersonaHit {
	id: string;
	date?: string;
	title?: string;
	text?: string;
	/** segment 的 kind（question / reflection / …） */
	kind?: string;
	/** segment 的 module（diary / wechat_self / ai_dialog / …） */
	source?: string;
	/** ask.py 给的命中理由（"日记忆命中" / "关键词命中" …） */
	why?: string;
	/**
	 * 外接库的原始组名（2026-11-23）：外部库的组名不固定，解析时原样带出，
	 * 渲染 / 页面搜索用它做展示标签。内置 persona 六组不填（组名由对象键承担）。
	 */
	group?: string;
}

export interface PersonaCoverage {
	not_searched?: string[];
	not_indexed?: string[];
	gaps?: string[];
	/** ask.py 实测字段：整月无记录的月份列表。 */
	gap_months?: string[];
}

export interface PersonaAskResult {
	ok: boolean;
	question: string;
	/** ask.py 判出的问题类型 */
	qtype?: string;
	/** 只保留有内容的组 */
	groups?: Partial<Record<PersonaGroup, PersonaHit[]>>;
	/**
	 * 外接库的扁平命中（2026-11-23）：`anyGroups` 模式下**总是**给这个字段
	 * （空库 = `[]`，不是失败）；组名在 `hit.group` 里。内置 persona 六组不用它。
	 */
	hits?: PersonaHit[];
	/** ask.py 自己说"查不到时该说什么" */
	unknown?: string;
	coverage?: PersonaCoverage;
	/** ok=false 时的失败原因（不含 stderr 原文） */
	error?: string;
	/**
	 * 超时标记（2026-11-24）：只有超时分支置 true。工具层据此把 `error`
	 * （如「persona 检索超时（15s）」）作为可行动文案给模型；其余失败仍走通用文案。
	 */
	timedOut?: boolean;
	/**
	 * 库不认 `--vector`（2026-11-24 命名统一）：本次请求带 `vector:true`，库以退出码 2 +
	 * argparse 参数拒绝特征退回，harness 已自动用不带 `--vector` 的同一命令重试一次。
	 * 重试结果照常返回，只是带这个标记留痕（工具层不当失败）。
	 */
	vectorUnsupported?: boolean;
}

export interface PersonaAskOptions {
	/** 每组最多几条，默认 5，收敛到 1..20。 */
	limit?: number;
	/**
	 * 外接库模式（2026-11-23）：组名不固定，按 `Object.entries(groups)` 全量扁平化；
	 * 空 `groups: {}` 是合法空结果。内置 persona 路径不传，保持六组校验。
	 */
	anyGroups?: boolean;
	/**
	 * 向量检索（2026-11-24 命名统一，原名「深检索 deep」）：true 时在 argv **末尾**追加
	 * `--vector`（位置在 `--limit N` 之后）。只有检索类调用（recall 外部槽 / 页面搜索，
	 * 都经 memory-bank 的 bankAsk）可能传；轻召回与 `--catalog-only` 永不传。
	 * 不传 / false = argv 与没有该开关的旧版逐字节相同。
	 * 库认不认识 `--vector` 由库决定：退出码 2 + argparse 参数拒绝特征时，本模块自动
	 * 去掉开关重试一次，并在结果上标 `vectorUnsupported:true`（见 `askPersona`）。
	 */
	vector?: boolean;
}

/** 测试注入口：假 spawn / 假 env / 缩短超时；生产不传。 */
export interface PersonaAskDeps {
	env?: NodeJS.ProcessEnv;
	spawnFn?: typeof spawn;
	timeoutMs?: number;
	/**
	 * 通用入口命令（2026-11-23 多语言入口）：`["python", "<abs>/ask.py"]` /
	 * `["node", "<abs>/ask.js"]` / `["<abs>/ask"]`。传了就不再依赖
	 * `PERSONA_MEMORY_ASK` / `PERSONA_PYTHON` 两个 env（外接库槽位走这里）。
	 */
	command?: string[];
	/** 入口命令的工作目录（多语言入口的相对 import 用；缺省 = 进程 cwd）。 */
	cwd?: string;
}

/**
 * 显式关闭开关（`PERSONA_MEMORY_ENABLED`，默认开）。
 *
 * 与 `PERSONA_MEMORY_ASK` 的关系：ASK 配置 = 启用；ENABLED=false = 显式关。
 * 双闸都过才注册工具（见 lifecycle.ts）。
 */
export function personaAskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("PERSONA_MEMORY_ENABLED", env);
}

/** ask.py 路径与 Python 命令都非空才算可用（默认态未配置 → 工具不上架）。 */
export function askPersonaAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	const script = env.PERSONA_MEMORY_ASK?.trim();
	const python = (env.PERSONA_PYTHON?.trim() || "python").trim();
	return Boolean(script) && Boolean(python);
}

function clampLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function fail(question: string, error: string): PersonaAskResult {
	return { ok: false, question, error };
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
	return out.length > 0 ? out : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mapHit(group: PersonaGroup, raw: unknown): PersonaHit | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const id = optionalString(item.id);
	if (!id) return null;
	const date = optionalString(item.date);
	const why = optionalString(item.why);

	switch (group) {
		case "memory_day":
		case "fact":
			return { id, ...(date ? { date } : {}), title: optionalString(item.title), text: optionalString(item.body), ...(why ? { why } : {}) };
		case "event": {
			const span = optionalString(item.span);
			const outcome = optionalString(item.outcome);
			const detail = [span, outcome].filter(Boolean).join(" · ");
			return { id, title: optionalString(item.title), ...(detail ? { text: detail } : {}), ...(why ? { why } : {}) };
		}
		case "segment": {
			const kind = optionalString(item.kind);
			const source = optionalString(item.module);
			return {
				id,
				...(date ? { date } : {}),
				text: optionalString(item.text),
				...(kind ? { kind } : {}),
				...(source ? { source } : {}),
				...(why ? { why } : {}),
			};
		}
		case "entity": {
			const role = optionalString(item.role);
			const mentions = typeof item.n_mention === "number" ? item.n_mention : undefined;
			const detail =
				role && mentions !== undefined
					? `${role}，提及 ${mentions}`
					: role ?? (mentions !== undefined ? `提及 ${mentions}` : undefined);
			return {
				id,
				title: optionalString(item.name),
				...(detail ? { text: detail } : {}),
				...(why ? { why } : {}),
			};
		}
		case "tension": {
			const trigger = optionalString(item.trigger);
			return {
				id,
				title: optionalString(item.name),
				...(trigger ? { text: `触发：${trigger}` } : {}),
				...(why ? { why } : {}),
			};
		}
	}
}

/** 外接库的通用命中映射：字段从宽（text/body/title/name），组名原样带出。 */
function mapAnyHit(item: unknown, group: string): PersonaHit | null {
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const row = item as Record<string, unknown>;
	const id = optionalString(row.id);
	if (!id) return null;
	const date = optionalString(row.date);
	const title = optionalString(row.title) ?? optionalString(row.name);
	const text = optionalString(row.text) ?? optionalString(row.body);
	const why = optionalString(row.why);
	return {
		id,
		...(date ? { date } : {}),
		...(title ? { title } : {}),
		...(text ? { text } : {}),
		...(why ? { why } : {}),
		group,
	};
}

function mapCoverage(root: Record<string, unknown>): PersonaCoverage | undefined {
	const rawCoverage = root.coverage;
	if (!rawCoverage || typeof rawCoverage !== "object" || Array.isArray(rawCoverage)) return undefined;
	const c = rawCoverage as Record<string, unknown>;
	const mapped: PersonaCoverage = {
		...(asStringArray(c.not_searched) ? { not_searched: asStringArray(c.not_searched) } : {}),
		...(asStringArray(c.not_indexed) ? { not_indexed: asStringArray(c.not_indexed) } : {}),
		...(asStringArray(c.gaps) ? { gaps: asStringArray(c.gaps) } : {}),
		...(asStringArray(c.gap_months) ? { gap_months: asStringArray(c.gap_months) } : {}),
	};
	return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/** 解析 ask.py / 外接库的 `--json` stdout；结构不符返回 error 而不是抛。 */
export function parsePersonaAskOutput(
	stdout: string,
	question: string,
	options: { anyGroups?: boolean } = {},
): PersonaAskResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		return fail(question, "persona 检索返回无法解析（非 JSON）");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return fail(question, "persona 检索返回结构不符");
	}
	const root = parsed as Record<string, unknown>;
	const rawGroups = root.groups;
	if (!rawGroups || typeof rawGroups !== "object" || Array.isArray(rawGroups)) {
		return fail(question, "persona 检索返回结构不符（缺 groups）");
	}
	const coverage = mapCoverage(root);

	// 外接库（2026-11-23）：组名不固定，全量扁平化；`groups: {}` = 合法空结果。
	if (options.anyGroups) {
		const hits: PersonaHit[] = [];
		for (const [group, arr] of Object.entries(rawGroups as Record<string, unknown>)) {
			if (!Array.isArray(arr)) return fail(question, `persona 检索返回结构不符（${group} 不是数组）`);
			for (const item of arr) {
				const hit = mapAnyHit(item, group);
				if (hit) hits.push(hit);
			}
		}
		return {
			ok: true,
			question,
			...(optionalString(root.qtype) ? { qtype: optionalString(root.qtype) } : {}),
			hits,
			...(optionalString(root.unknown) ? { unknown: optionalString(root.unknown) } : {}),
			...(coverage ? { coverage } : {}),
		};
	}

	const groups: Partial<Record<PersonaGroup, PersonaHit[]>> = {};
	let sawGroup = false;
	for (const name of PERSONA_GROUP_ORDER) {
		const arr = (rawGroups as Record<string, unknown>)[name];
		if (arr === undefined) continue;
		if (!Array.isArray(arr)) return fail(question, `persona 检索返回结构不符（${name} 不是数组）`);
		sawGroup = true;
		const hits = arr
			.map((item) => mapHit(name, item))
			.filter((hit): hit is PersonaHit => hit !== null);
		if (hits.length > 0) groups[name] = hits;
	}
	if (!sawGroup) return fail(question, "persona 检索返回结构不符（groups 为空对象）");

	return {
		ok: true,
		question,
		...(optionalString(root.qtype) ? { qtype: optionalString(root.qtype) } : {}),
		...(Object.keys(groups).length > 0 ? { groups } : {}),
		...(optionalString(root.unknown) ? { unknown: optionalString(root.unknown) } : {}),
		...(coverage ? { coverage } : {}),
	};
}

interface AskAttemptOutcome {
	result: PersonaAskResult;
	/** 本次带 `--vector` 且子进程以 argparse 参数拒绝的方式失败（上层据此去开关重试一次）。 */
	vectorRejected: boolean;
}

/** argparse 对未知参数的特征（2026-11-24）：必须同时满足退出码 2。 */
const VECTOR_REJECT_HINTS = ["unrecognized arguments", "unknown option", "invalid option"];

function vectorArgRejected(code: number | null, stderr: string): boolean {
	if (code !== 2) return false;
	const lower = stderr.toLowerCase();
	return VECTOR_REJECT_HINTS.some((hint) => lower.includes(hint)) || /^\s*usage:/im.test(stderr);
}

interface AskAttemptInput {
	question: string;
	limit: number;
	anyGroups: boolean;
	vector: boolean;
	commandPrefix: string[];
	/** 整次检索的总预算（只用于超时文案）。 */
	timeoutMs: number;
	/**
	 * 绝对截止时间（2026-11-24）：带 `--vector` 被库拒绝后的那次重试**共享同一个 deadline**，
	 * 第一次耗时算进第二次预算，最坏不翻倍。缺省 = 本次尝试开始时再按 timeoutMs 算。
	 */
	deadlineAt?: number;
	spawnFn: typeof spawn;
	cwd?: string;
}

/**
 * 起一次 ask 子进程并解析结果；超时 / 启动失败 / 非零退出都降级成 `ok:false`（不抛）。
 * 只做一次；带 `--vector` 被库拒绝时的去开关重试由 `askPersona` 决定（超时不重试）。
 */
function runAskAttempt(input: AskAttemptInput): Promise<AskAttemptOutcome> {
	const startedAt = Date.now();
	const deadlineAt = input.deadlineAt ?? startedAt + input.timeoutMs;

	return new Promise<AskAttemptOutcome>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ChildProcess | undefined;

		const finish = (result: PersonaAskResult, vectorRejected = false): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			const groupCount = result.groups ? Object.keys(result.groups).length : 0;
			// 外接库（anyGroups）把命中扁平放在 `hits` 里、`groups` 恒空——先看 hits，
			// 没有才回落到旧的分组累加（2026-11-24 修日志恒 0）。
			const hitCount =
				result.hits?.length ??
				(result.groups ? Object.values(result.groups).reduce((sum, hits) => sum + (hits?.length ?? 0), 0) : 0);
			// 只记字数 / 耗时 / 状态 / 组数，不记问题原文与正文（硬约束）。
			console.log(
				`[persona-ask] q=${input.question.length}字 ok=${result.ok} groups=${groupCount} hits=${hitCount} ${Date.now() - startedAt}ms`,
			);
			resolve({ result, vectorRejected });
		};

		// 预算已经用完（重试前第一次尝试就把时间花光了）：不再起进程，直接按超时结算。
		if (deadlineAt - Date.now() <= 0) {
			finish({
				...fail(input.question, `persona 检索超时（${Math.round(input.timeoutMs / 1000)}s）`),
				timedOut: true,
			});
			return;
		}

		try {
			child = input.spawnFn(
				input.commandPrefix[0],
				[
					...input.commandPrefix.slice(1),
					input.question,
					"--json",
					"--limit",
					String(input.limit),
					// 向量检索开关只出现在末尾（2026-11-24）；不传 = argv 与旧版逐字节相同。
					...(input.vector ? ["--vector"] : []),
				],
				{
					...(input.cwd ? { cwd: input.cwd } : {}),
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		} catch (error) {
			finish(
				fail(
					input.question,
					`persona 检索启动失败：${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
				),
			);
			return;
		}

		timer = setTimeout(() => {
			try {
				child?.kill();
			} catch {
				// 进程可能已退出；超时结果照常返回
			}
			// 超时标记只给工具层判断"这次是查慢了"用；其余失败不置（2026-11-24）。
			finish({
				...fail(input.question, `persona 检索超时（${Math.round(input.timeoutMs / 1000)}s）`),
				timedOut: true,
			});
		}, Math.max(0, deadlineAt - Date.now()));

		const stdout: Buffer[] = [];
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (stderr.length < STDERR_KEEP) stderr += chunk.toString();
		});
		child.once("error", (error: Error) => {
			finish(fail(input.question, `persona 检索启动失败：${error.message.slice(0, 120)}`));
		});
		child.once("close", (code: number | null) => {
			if (settled) return;
			if (code !== 0) {
				// stderr 可能含本机路径：只取第一行、截 120 字，绝不整段落日志。
				const firstLine = stderr
					.split(/\r?\n/)
					.map((line) => line.trim())
					.find(Boolean)
					?.slice(0, 120);
				finish(
					fail(
						input.question,
						`persona 检索失败（退出码 ${code ?? "unknown"}）${firstLine ? `：${firstLine}` : ""}`,
					),
					input.vector && vectorArgRejected(code, stderr),
				);
				return;
			}
			finish(
				parsePersonaAskOutput(Buffer.concat(stdout).toString("utf8"), input.question, {
					anyGroups: input.anyGroups,
				}),
			);
		});
	});
}

/**
 * 经 ask.py 查 persona 记忆库。
 *
 * 未配置 / 显式关闭 / 超时 / 启动失败 / 非零退出 / JSON 结构不符 —— 一律返回 `ok:false`，
 * **绝不抛异常**。`deps` 只给单测注入假 spawn，生产调用两个参数即可。
 * 带 `vector:true` 且库以 argparse 参数拒绝（退出码 2）时，自动去开关重试一次普通检索
 * （结果带 `vectorUnsupported:true`；超时不重试）。
 */
export async function askPersona(
	question: string,
	options: PersonaAskOptions = {},
	deps: PersonaAskDeps = {},
): Promise<PersonaAskResult> {
	const env = deps.env ?? process.env;
	const command = deps.command && deps.command.length > 0 ? deps.command : null;
	if (!personaAskEnabled(env) || (!command && !askPersonaAvailable(env))) {
		return fail(
			question,
			"persona 记忆库未启用（PERSONA_MEMORY_ASK 未配置或 PERSONA_MEMORY_ENABLED=false）",
		);
	}

	const script = command ? "" : env.PERSONA_MEMORY_ASK!.trim();
	const python = command ? "" : env.PERSONA_PYTHON?.trim() || "python";
	const timeoutMs = deps.timeoutMs ?? PERSONA_ASK_TIMEOUT_MS;
	// 整次调用的预算从第一次尝试开始计时；带 --vector 被拒后的重试共享同一个 deadline
	//（第一次耗时算进第二次预算），所以最坏总耗时仍是 timeoutMs 而不是 2×（2026-11-24）。
	const deadlineAt = Date.now() + timeoutMs;
	const base: AskAttemptInput = {
		question,
		limit: clampLimit(options.limit),
		anyGroups: options.anyGroups === true,
		vector: options.vector === true,
		commandPrefix: command ?? [python, script],
		timeoutMs,
		deadlineAt,
		spawnFn: deps.spawnFn ?? spawn,
		...(deps.cwd ? { cwd: deps.cwd } : {}),
	};

	const first = await runAskAttempt(base);
	if (!first.vectorRejected) return first.result;

	// 库不认识 --vector（2026-11-24）：自动退回普通检索，**只重试一次**，且不重置 deadline。
	// 超时（timedOut）/ 其它失败不会走到这里——不带开关的同一命令再跑一次即可。
	console.log("[persona-ask] 库不认识 --vector，已改用普通检索");
	const retry = await runAskAttempt({ ...base, vector: false, deadlineAt });
	return { ...retry.result, vectorUnsupported: true };
}

// ── 库边界（2026-11-13 记忆页脚）──────────────────────────
//
// `ask.py --catalog-only` 是它自带的"库的边界"只读输出（约 2k token 的纯文本）。
// 只给设置页显示"这个库大概有什么"，不做检索；结果缓存 10 分钟，避免每次进页都起 python。

export interface PersonaCatalogResult {
	ok: boolean;
	lines: string[];
	error?: string;
}

const CATALOG_CACHE_MS = 10 * 60_000;
let catalogCache: { key: string; at: number; result: PersonaCatalogResult } | null = null;

export function askPersonaCatalog(deps: PersonaAskDeps = {}): Promise<PersonaCatalogResult> {
	const env = deps.env ?? process.env;
	const command = deps.command && deps.command.length > 0 ? deps.command : null;
	if (!personaAskEnabled(env) || (!command && !askPersonaAvailable(env))) {
		return Promise.resolve({ ok: false, lines: [], error: "not_configured" });
	}
	const script = command ? "" : env.PERSONA_MEMORY_ASK!.trim();
	const python = command ? "" : env.PERSONA_PYTHON?.trim() || "python";
	const commandPrefix = command ?? [python, script];
	const cacheKey = `${commandPrefix.join("\u0000")}\u0000${deps.cwd ?? ""}`;
	if (catalogCache && catalogCache.key === cacheKey && Date.now() - catalogCache.at < CATALOG_CACHE_MS) {
		return Promise.resolve(catalogCache.result);
	}

	const timeoutMs = deps.timeoutMs ?? PERSONA_ASK_TIMEOUT_MS;
	const spawnFn = deps.spawnFn ?? spawn;
	const startedAt = Date.now();

	return new Promise<PersonaCatalogResult>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ChildProcess | undefined;

		const finish = (result: PersonaCatalogResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (result.ok) {
				catalogCache = { key: cacheKey, at: Date.now(), result };
			}
			console.log(
				`[persona-catalog] ok=${result.ok} lines=${result.lines.length} ${Date.now() - startedAt}ms`,
			);
			resolve(result);
		};

		try {
			child = spawnFn(commandPrefix[0], [...commandPrefix.slice(1), "--catalog-only"], {
				...(deps.cwd ? { cwd: deps.cwd } : {}),
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({
				ok: false,
				lines: [],
				error: (error instanceof Error ? error.message : String(error)).slice(0, 120),
			});
			return;
		}

		timer = setTimeout(() => {
			try {
				child?.kill();
			} catch {
				/* 已退出 */
			}
			finish({ ok: false, lines: [], error: "catalog_timeout" });
		}, timeoutMs);

		const stdout: Buffer[] = [];
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (stderr.length < STDERR_KEEP) stderr += chunk.toString();
		});
		child.once("error", (error: Error) => {
			finish({ ok: false, lines: [], error: error.message.slice(0, 120) });
		});
		child.once("close", (code: number | null) => {
			if (settled) return;
			if (code !== 0) {
				const firstLine = stderr
					.split(/\r?\n/)
					.map((line) => line.trim())
					.find(Boolean)
					?.slice(0, 120);
				finish({
					ok: false,
					lines: [],
					error: `catalog_failed（退出码 ${code ?? "unknown"}）${firstLine ? `：${firstLine}` : ""}`,
				});
				return;
			}
			const lines = Buffer.concat(stdout)
				.toString("utf8")
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.slice(0, 20);
			finish({ ok: true, lines });
		});
	});
}
