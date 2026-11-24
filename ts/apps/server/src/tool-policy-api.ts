/**
 * 工具超时策略端点（2026-11-24 M0，方案 §3.5）。
 *
 *   GET /api/v1/agent/tool-policy  —— 全部能力组 + 工具行（可配行带 effective / ranges，
 *                                     锁定行只有原因）+ 注入预算 + 后台任务索引上限
 *   PUT /api/v1/agent/tool-policy  —— 局部更新（`null` = 删除该条，回继承），返回同 GET 形状
 *
 * 总开关 `TOOL_TIMEOUT_POLICY` 关 → 两个端点都 404（与 bg-jobs / companions 同口径，
 * 前端读不到就不渲染新区块）。开关是 hot 的，所以挂载不判断开关、由 handler 现读——
 * 这样打开 / 关闭下一轮就生效，不需要重启服务。
 *
 * 鉴权沿用主 app 的 `/api/v1/*` 中间件（AGENT_TOKEN 之后；失败仍 403 空体）。
 * 这些是服务端内部设置端点，不进 shared 契约，手机端不需要适配。
 */
import type { Hono } from "hono";
import { BG_INDEX_LIMIT } from "./bash-background.ts";
import { bankTimeouts } from "./memory-bank.ts";
import {
	TOOL_POLICY_CATALOG,
	TOOL_POLICY_GROUPS,
	TOOL_POLICY_INJECTIONS,
	applyToolPolicyPatch,
	readToolPolicyConfig,
	resolveToolPolicy,
	toolTimeoutPolicyEnabled,
	writeToolPolicyConfig,
	type EffectiveToolPolicy,
	type ToolPolicyCapabilities,
	type ToolPolicyCategory,
	type ToolPolicyGroup,
	type ToolPolicyLegacyOverrides,
} from "./tool-policy.ts";

export interface ToolPolicyToolRow {
	name: string;
	label: string;
	group: string;
	category: ToolPolicyCategory;
	capabilities: ToolPolicyCapabilities;
	lockedReason: string | null;
	/** 锁定工具为 null（没有可解析的输入面）。 */
	effective: EffectiveToolPolicy | null;
	ranges: { min: number; max: number } | null;
}

export interface ToolPolicyInjectionRow {
	name: string;
	label: string;
	desc: string;
	effective: EffectiveToolPolicy;
	ranges: { min: number; max: number };
}

export interface ToolPolicyPayload {
	ok: true;
	enabled: true;
	groups: ToolPolicyGroup[];
	tools: ToolPolicyToolRow[];
	injections: ToolPolicyInjectionRow[];
	backgroundJobs: { indexLimit: number };
}

export interface ToolPolicyApiDeps {
	env?: NodeJS.ProcessEnv;
	/** 总开关读取（测试注入）；缺省 `flagEnabled("TOOL_TIMEOUT_POLICY")` 现读。 */
	enabled?: () => boolean;
	/** 旧配置层（memory-bank 两档）；缺省读当前 `memory-bank.json`。 */
	legacy?: (env: NodeJS.ProcessEnv) => { recall?: number; memoryLight?: number };
}

function envOf(deps: ToolPolicyApiDeps): NodeJS.ProcessEnv {
	return deps.env ?? process.env;
}

function legacyOf(deps: ToolPolicyApiDeps, env: NodeJS.ProcessEnv): ToolPolicyLegacyOverrides {
	if (deps.legacy) return deps.legacy(env);
	const timeouts = bankTimeouts(env);
	return { recall: timeouts.askMs, memoryLight: timeouts.lightMs };
}

/** 组装 GET / PUT 的响应体。只读文件 + 解析，不写盘。 */
export function toolPolicyPayload(deps: ToolPolicyApiDeps = {}): ToolPolicyPayload {
	const env = envOf(deps);
	const resolved = resolveToolPolicy(env, legacyOf(deps, env));
	return {
		ok: true,
		enabled: true,
		groups: TOOL_POLICY_GROUPS.map((group) => ({ ...group })),
		tools: TOOL_POLICY_CATALOG.map((entry) => {
			const effective = entry.capabilities.configurable ? (resolved.tools[entry.name]?.effective ?? null) : null;
			return {
				name: entry.name,
				label: entry.label,
				group: entry.group,
				category: entry.category,
				capabilities: { ...entry.capabilities },
				lockedReason: entry.lockedReason,
				effective,
				ranges:
					entry.capabilities.configurable && entry.min !== null && entry.max !== null
						? { min: entry.min, max: entry.max }
						: null,
			};
		}),
		injections: TOOL_POLICY_INJECTIONS.map((entry) => ({
			name: entry.name,
			label: entry.label,
			desc: entry.desc,
			effective:
				resolved.injections[entry.name]?.effective ??
				({
					timeoutMs: entry.defaultTimeoutMs,
					onTimeout: "fail",
					notify: false,
					source: "default",
				} as const),
			ranges: { min: entry.min, max: entry.max },
		})),
		backgroundJobs: { indexLimit: BG_INDEX_LIMIT },
	};
}

/** GET / PUT 挂载；开关关时两个端点都 404（handler 现读，hot 生效）。 */
export function mountToolPolicyRoutes(app: Hono, deps: ToolPolicyApiDeps = {}): void {
	const enabled = deps.enabled ?? (() => toolTimeoutPolicyEnabled(envOf(deps)));

	app.get("/api/v1/agent/tool-policy", (c) => {
		if (!enabled()) return c.json({ ok: false, error: "tool_policy_disabled" }, 404);
		c.header("cache-control", "no-store");
		return c.json(toolPolicyPayload(deps));
	});

	app.put("/api/v1/agent/tool-policy", async (c) => {
		if (!enabled()) return c.json({ ok: false, error: "tool_policy_disabled" }, 404);
		const env = envOf(deps);
		const body = (await c.req.json().catch(() => null)) as unknown;
		const current = readToolPolicyConfig(env);
		const patched = applyToolPolicyPatch(current, body);
		if (!patched.ok) {
			return c.json({ ok: false, error: patched.error, message: patched.message }, 400);
		}
		writeToolPolicyConfig(patched.config, env);
		c.header("cache-control", "no-store");
		return c.json(toolPolicyPayload(deps));
	});
}
