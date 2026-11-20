/**
 * 全局工具池（2026-11-17 设置 → 工具页）。
 *
 * 决定"哪些工具进按需池（deferred）"：按需 = 初始请求里没有它，系统提示只给
 * `tool_index` 一句话，模型要用先调 `tool_search`；其余一律常驻（每轮带完整定义）。
 *
 * 落点 `.data/tool-pool.json`：`{ "deferred": ["routine_manage", …] }`
 * （`AGENT_TOOL_POOL_PATH` 可覆盖）。**存按需例外名单**，与 worker-tools 的
 * `disabled` 同一套思路：文件缺失 / 坏 JSON = 回落到代码默认（当前 8 个），
 * 以后新增工具默认常驻，不会因为名单没更新而悄悄消失。
 *
 * **生效边界（内核约束，2026-11-17 核对）**：`deferred` 是工具注册期属性，
 * 只在 `openHarness()` 里 `markDeferred()` 时打上；改这个文件**必须重开 Harness
 * （= 重启服务）才生效**。所以端点会把"配置值"和"当前运行实际用的名单（applied）"
 * 一起返回，前端据此显示"待重启"。
 *
 * 本模块只做文件 IO + 校验 + 路由，不 import partner-tools（避免
 * tool-index → tool-pool → partner-tools → tool-index 的环）：目录与分组由调用方注入。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Hono } from "hono";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { estimateTokens } from "./token-estimate.ts";

/** 代码默认的按需名单（2026-11-16 C 段用户拍板的 8 个；批2 追加 respond_escalation；
 *  批4 追加 save_reminder_advice）。文件缺失时用它。 */
export const DEFAULT_DEFERRED_TOOL_NAMES: readonly string[] = [
	"routine_manage",
	"partner_manage",
	"group_manage",
	"save_skill_advice",
	"partner_skill_write",
	"propose_project",
	"send_to_agent",
	// 决策上报答复（2026-11-19 批2）：只在唤醒轮用得上，初始不进请求、不打缓存前缀。
	"respond_escalation",
	// 提醒沉淀落盘（2026-11-19 批4）：只有入口发起蒸馏那轮用得上，初始不进请求。
	"save_reminder_advice",
];

/** `tool_search` 是加载按需工具的唯一入口：把它自己放进按需池 = 所有按需工具永久不可达。 */
export const TOOL_SEARCH_NAME = "tool_search";

export function toolPoolPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_TOOL_POOL_PATH?.trim() || ".data/tool-pool.json");
}

/** mtime+size 缓存：每轮工具面判断会读几次，别每次都解析文件。 */
let cache: { path: string; mtimeMs: number; size: number; names: string[] } | null = null;

/**
 * 读按需名单：文件不存在 / 坏 JSON / `deferred` 不是数组 → 回落到代码默认。
 * 空数组合法 = 全部常驻（此时不会有 tool_search，也不会有 tool_index 段）。
 */
export function readDeferredToolNames(env: NodeJS.ProcessEnv = process.env): string[] {
	const path = toolPoolPath(env);
	try {
		const stat = statSync(path);
		if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
			return [...cache.names];
		}
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { deferred?: unknown };
		if (!Array.isArray(parsed.deferred)) return [...DEFAULT_DEFERRED_TOOL_NAMES];
		const names = [
			...new Set(
				parsed.deferred.filter((item): item is string => typeof item === "string" && item.length > 0),
			),
		];
		cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, names };
		return [...names];
	} catch {
		cache = null;
		return [...DEFAULT_DEFERRED_TOOL_NAMES];
	}
}

/** 原子写：先写临时文件再改名，读到的永远是整份配置。 */
export function writeDeferredToolNames(names: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
	const path = toolPoolPath(env);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, `${JSON.stringify({ deferred: [...names] }, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
		cache = null;
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/* ── 当前运行实际用的名单（重启前 vs 重启后）────────────────── */

let applied: string[] | null = null;

/** `markDeferred` 装配完调用：记下这一版 Harness 实际用的名单。 */
export function noteAppliedDeferredNames(names: readonly string[]): void {
	applied = [...new Set(names)];
}

/** null = Harness 还没装配过（服务刚起），此时谈不上"待重启"。 */
export function appliedDeferredToolNames(): string[] | null {
	return applied === null ? null : [...applied];
}

/** 纯函数：配置与运行名单是否不同（不同 = 已保存但还没重启）。 */
export function poolDiffers(configured: readonly string[], runtime: readonly string[] | null): boolean {
	if (runtime === null) return false;
	const a = new Set(configured);
	const b = new Set(runtime);
	return a.size !== b.size || [...a].some((name) => !b.has(name));
}

/* ── 校验 ────────────────────────────────────────────────── */

export function sanitizeDeferredList(
	input: unknown,
	known: ReadonlySet<string>,
): { ok: true; deferred: string[] } | { ok: false; message: string; unknown?: string[] } {
	if (!Array.isArray(input)) return { ok: false, message: "deferred 必须是字符串数组" };
	if (input.length > 64) return { ok: false, message: "deferred 最多 64 项" };
	const seen = new Set<string>();
	const unknown: string[] = [];
	const deferred: string[] = [];
	for (const item of input) {
		if (typeof item !== "string") return { ok: false, message: "deferred 元素必须是字符串" };
		if (!known.has(item)) {
			if (!unknown.includes(item)) unknown.push(item);
			continue;
		}
		if (!seen.has(item)) {
			seen.add(item);
			deferred.push(item);
		}
	}
	if (unknown.length > 0) {
		return { ok: false, message: `未知工具：${unknown.join("、")}`, unknown };
	}
	if (deferred.includes(TOOL_SEARCH_NAME)) {
		return {
			ok: false,
			message: "tool_search 不能设为按需：它是加载按需工具的唯一入口，把它藏起来会让所有按需工具永久不可达",
		};
	}
	return { ok: true, deferred };
}

/* ── 端点 ────────────────────────────────────────────────── */

export interface ToolPoolTool {
	name: string;
	/** 摘要（列表行里那行小字，最多 80 字）。 */
	summary: string;
	/** 描述原文（展开行看全文用；2026-11-17 加，别让列表只能看截断版）。 */
	description: string;
	/** 参数 JSON Schema 原文（展开行"整个工具定义"用；2026-11-17 补）。 */
	parameters: unknown;
	/** 紧凑定义（只算 name+description+parameters，与上下文页同一口径）。 */
	chars: number;
	tokens: number;
	/** 按**配置**算：true = 重启后会进按需池。 */
	deferred: boolean;
}

export interface ToolPoolPayload {
	ok: true;
	/** AGENT_TOOL_INDEX 是否开；关时整页只读。 */
	enabled: boolean;
	/** 文件里的配置值。 */
	deferred: string[];
	/** 代码默认值（一键恢复用）。 */
	defaults: string[];
	/** 当前运行实际用的名单；null = Harness 还没装配过。 */
	applied: string[] | null;
	/** 配置与运行名单不同 = 已保存、待重启。 */
	restartPending: boolean;
	tools: ToolPoolTool[];
}

export interface ToolPoolDeps {
	env?: NodeJS.ProcessEnv;
	/** 模型可见工具目录（复用 modelToolCatalog，包含 deferred）。 */
	catalog: () => readonly ToolRegistration[];
	summaryOf: (description: string) => string;
	/** AGENT_TOOL_INDEX 开关（注入避免 import 环）。 */
	indexEnabled: () => boolean;
}

/** 组装 GET / PUT 的响应体。 */
export function toolPoolPayload(deps: ToolPoolDeps): ToolPoolPayload {
	const env = deps.env ?? process.env;
	const configured = readDeferredToolNames(env);
	const configuredSet = new Set(configured);
	const runtime = appliedDeferredToolNames();
	const tools = deps.catalog().map((tool) => {
		const compact = JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		});
		return {
			name: tool.name,
			summary: deps.summaryOf(tool.description),
			description: tool.description,
			parameters: tool.parameters,
			chars: compact.length,
			tokens: estimateTokens(compact),
			deferred: configuredSet.has(tool.name),
		};
	});
	return {
		ok: true,
		enabled: deps.indexEnabled(),
		deferred: configured,
		defaults: [...DEFAULT_DEFERRED_TOOL_NAMES],
		applied: runtime,
		restartPending: poolDiffers(configured, runtime),
		tools,
	};
}

/** GET / PUT 挂载；鉴权沿用主 app 的 /api/v1/* 中间件。 */
export function mountToolPoolRoutes(app: Hono, deps: ToolPoolDeps): void {
	app.get("/api/v1/agent/tool-pool", (c) => {
		c.header("cache-control", "no-store");
		return c.json(toolPoolPayload(deps));
	});
	app.put("/api/v1/agent/tool-pool", async (c) => {
		if (!deps.indexEnabled()) {
			return c.json(
				{ error: "bad_request", message: "低频工具索引未启用（AGENT_TOOL_INDEX=false），工具池不可改" },
				400,
			);
		}
		const body = (await c.req.json().catch(() => null)) as { deferred?: unknown } | null;
		const known = new Set(deps.catalog().map((tool) => tool.name));
		const result = sanitizeDeferredList(body?.deferred, known);
		if (!result.ok) {
			return c.json(
				{ error: "bad_request", message: result.message, ...(result.unknown ? { unknown: result.unknown } : {}) },
				400,
			);
		}
		writeDeferredToolNames(result.deferred, deps.env ?? process.env);
		c.header("cache-control", "no-store");
		return c.json(toolPoolPayload(deps));
	});
}
