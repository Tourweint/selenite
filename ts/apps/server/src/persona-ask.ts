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
/** 超时预算：实测 0.7s 检索 + Python 启动，15s 足够；卡住就放弃，别让一轮对话僵死。 */
export const PERSONA_ASK_TIMEOUT_MS = 15_000;
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
	/** ask.py 自己说"查不到时该说什么" */
	unknown?: string;
	coverage?: PersonaCoverage;
	/** ok=false 时的失败原因（不含 stderr 原文） */
	error?: string;
}

export interface PersonaAskOptions {
	/** 每组最多几条，默认 5，收敛到 1..20。 */
	limit?: number;
}

/** 测试注入口：假 spawn / 假 env / 缩短超时；生产不传。 */
export interface PersonaAskDeps {
	env?: NodeJS.ProcessEnv;
	spawnFn?: typeof spawn;
	timeoutMs?: number;
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

/** 解析 ask.py 的 `--json` stdout；结构不符返回 error 而不是抛。 */
export function parsePersonaAskOutput(stdout: string, question: string): PersonaAskResult {
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

	const rawCoverage = root.coverage;
	let coverage: PersonaCoverage | undefined;
	if (rawCoverage && typeof rawCoverage === "object" && !Array.isArray(rawCoverage)) {
		const c = rawCoverage as Record<string, unknown>;
		const mapped: PersonaCoverage = {
			...(asStringArray(c.not_searched) ? { not_searched: asStringArray(c.not_searched) } : {}),
			...(asStringArray(c.not_indexed) ? { not_indexed: asStringArray(c.not_indexed) } : {}),
			...(asStringArray(c.gaps) ? { gaps: asStringArray(c.gaps) } : {}),
			...(asStringArray(c.gap_months) ? { gap_months: asStringArray(c.gap_months) } : {}),
		};
		if (Object.keys(mapped).length > 0) coverage = mapped;
	}

	return {
		ok: true,
		question,
		...(optionalString(root.qtype) ? { qtype: optionalString(root.qtype) } : {}),
		...(Object.keys(groups).length > 0 ? { groups } : {}),
		...(optionalString(root.unknown) ? { unknown: optionalString(root.unknown) } : {}),
		...(coverage ? { coverage } : {}),
	};
}

/**
 * 经 ask.py 查 persona 记忆库。
 *
 * 未配置 / 显式关闭 / 超时 / 启动失败 / 非零退出 / JSON 结构不符 —— 一律返回 `ok:false`，
 * **绝不抛异常**。`deps` 只给单测注入假 spawn，生产调用两个参数即可。
 */
export function askPersona(
	question: string,
	options: PersonaAskOptions = {},
	deps: PersonaAskDeps = {},
): Promise<PersonaAskResult> {
	const env = deps.env ?? process.env;
	if (!askPersonaAvailable(env) || !personaAskEnabled(env)) {
		return Promise.resolve(
			fail(
				question,
				"persona 记忆库未启用（PERSONA_MEMORY_ASK 未配置或 PERSONA_MEMORY_ENABLED=false）",
			),
		);
	}

	const script = env.PERSONA_MEMORY_ASK!.trim();
	const python = env.PERSONA_PYTHON?.trim() || "python";
	const limit = clampLimit(options.limit);
	const timeoutMs = deps.timeoutMs ?? PERSONA_ASK_TIMEOUT_MS;
	const spawnFn = deps.spawnFn ?? spawn;
	const startedAt = Date.now();

	return new Promise<PersonaAskResult>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ChildProcess | undefined;

		const finish = (result: PersonaAskResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			const groupCount = result.groups ? Object.keys(result.groups).length : 0;
			const hitCount = result.groups
				? Object.values(result.groups).reduce((sum, hits) => sum + (hits?.length ?? 0), 0)
				: 0;
			// 只记字数 / 耗时 / 状态 / 组数，不记问题原文与正文（硬约束）。
			console.log(
				`[persona-ask] q=${question.length}字 ok=${result.ok} groups=${groupCount} hits=${hitCount} ${Date.now() - startedAt}ms`,
			);
			resolve(result);
		};

		try {
			child = spawnFn(python, [script, question, "--json", "--limit", String(limit)], {
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish(
				fail(question, `persona 检索启动失败：${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`),
			);
			return;
		}

		timer = setTimeout(() => {
			try {
				child?.kill();
			} catch {
				// 进程可能已退出；超时结果照常返回
			}
			finish(fail(question, "persona 检索超时（15s）"));
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
			finish(fail(question, `persona 检索启动失败：${error.message.slice(0, 120)}`));
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
					fail(question, `persona 检索失败（退出码 ${code ?? "unknown"}）${firstLine ? `：${firstLine}` : ""}`),
				);
				return;
			}
			finish(parsePersonaAskOutput(Buffer.concat(stdout).toString("utf8"), question));
		});
	});
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
	if (!askPersonaAvailable(env) || !personaAskEnabled(env)) {
		return Promise.resolve({ ok: false, lines: [], error: "not_configured" });
	}
	const script = env.PERSONA_MEMORY_ASK!.trim();
	const python = env.PERSONA_PYTHON?.trim() || "python";
	const cacheKey = `${script}\u0000${python}`;
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
			child = spawnFn(python, [script, "--catalog-only"], {
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
