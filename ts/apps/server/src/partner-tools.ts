/**
 * 人设页工具勾选（2026-11-16 工具裁剪 B）
 *
 * 三件事：
 *   1. 目录：从真实 extension（CodingTools + lifediaryExt）现取模型可见工具，不手抄清单；
 *   2. 存储视图：按某人 disabledTools 算出每项 enabled，供人设页勾选；
 *   3. 运行时：chatStream 提交前按 disabledTools 配置会话 modelTools，下一轮生效。
 *
 * 只写"取消名单"（空 = 全开）：以后新增工具默认对所有人可见。
 * PARTNER_TOOLS_ENABLED=false → 整组回滚：端点回空形状、运行时不写、默认页不过滤。
 * 失败只 warn，绝不挡对话；不动工具实现 / extension / 审批闸门。
 */

import type { Conversation, ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { lifediaryExt } from "./agent/lifecycle-harness.ts";
import { CTX } from "./agent/shared.ts";
import type { PartnerRow } from "./partner-types.ts";
import { isDeferredTool } from "./tool-index.ts";

export interface PartnerToolItem {
	name: string;
	group: string;
	summary: string;
	/** 这个人当前是否可用 */
	enabled: boolean;
	/** 是否为按需加载工具（人设页可显示「按需加载」小字，2026-11-16 C 段） */
	deferred: boolean;
}

export interface PartnerToolsView {
	/** 全局开关；关时前端隐藏整段 */
	enabled: boolean;
	/** 被取消的工具名（去重后的存储值） */
	disabled: string[];
	/** 固定顺序的组名 */
	groups: string[];
	tools: PartnerToolItem[];
}

const OFF_VALUES = new Set(["false", "0", "off"]);

/** PARTNER_TOOLS_ENABLED：false / 0 / off（大小写、空白不敏感）= 关；缺省 / 其它 = 开。 */
export function partnerToolsEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = String(env.PARTNER_TOOLS_ENABLED ?? "").trim().toLowerCase();
	return !OFF_VALUES.has(raw);
}

/**
 * 模型可见工具目录：CodingTools.tools + lifediaryExt.tools，按注册顺序，按名去重（先到先得）。
 * 只过滤 `callers` 不含 model 的（callers 缺省 = model + tools）；**deferred 现在包含**（2026-11-16 C 段），
 * 工具自身带 `deferred: true`，人设页才能看到并取消它们（初始前缀里没有它们，由 tool_search 按需加载）。
 * 不手抄工具清单——工具上架 / 下架自动反映。
 *
 * pool 可选注入只为单测造 deferred / callers / 重名工具；正常调用方不传。
 */
export function modelToolCatalog(
	pool: readonly ToolRegistration[] = [
		...(CodingTools.tools ?? []),
		...(lifediaryExt?.tools ?? []),
	],
): ToolRegistration[] {
	const seen = new Set<string>();
	const tools: ToolRegistration[] = [];
	for (const tool of pool) {
		// deferred 也进目录（C 段）：人设页要能看到 / 取消；它是否进请求由 modelTools.add 决定。
		if (tool.callers !== undefined && !tool.callers.includes("model")) continue;
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		tools.push(tool);
	}
	return tools;
}

/** 组的固定顺序。 */
export const PARTNER_TOOL_GROUPS = [
	"文件与命令",
	"记忆",
	"派活与任务",
	"资料与技能",
	"执事与群组",
	"其他",
] as const;

const TOOL_GROUP_OF: Record<string, string> = {
	// 文件与命令
	read: "文件与命令",
	write: "文件与命令",
	edit: "文件与命令",
	bash: "文件与命令",
	powershell: "文件与命令",
	// 记忆
	remember: "记忆",
	recall: "记忆",
	recall_sessions: "记忆",
	persona_recall: "记忆",
	persona_write: "记忆",
	// 派活与任务
	delegate: "派活与任务",
	propose_project: "派活与任务",
	propose_topic: "派活与任务",
	routine_manage: "派活与任务",
	set_reminder: "派活与任务",
	report_progress: "派活与任务",
	ask_user: "派活与任务",
	// 资料与技能
	web_search: "资料与技能",
	skill: "资料与技能",
	save_skill_advice: "资料与技能",
	partner_skill_write: "资料与技能",
	// 执事与群组
	partner_manage: "执事与群组",
	group_manage: "执事与群组",
	send_to_agent: "执事与群组",
};

/** 未知工具一律归「其他」。 */
export function toolGroupOf(name: string): string {
	return TOOL_GROUP_OF[name] ?? "其他";
}

/** 勾选列表的一行说明：去掉 Markdown 强调 / 行内码标记，取第一行 / 第一句，trim，超 80 字截断加 `…`。 */
export function toolSummaryOf(description: string): string {
	const text = String(description ?? "")
		.replace(/\*\*|__|`/g, "")
		.trim();
	if (!text) return "";
	const first = text.split(/[。！？\n]/, 1)[0]?.trim() ?? "";
	const chars = [...first];
	return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : first;
}

/** 勾选用视图：全局开关 + 被取消名单 + 组顺序 + 每项当前是否可用。 */
export function partnerToolsView(partner: PartnerRow): PartnerToolsView {
	const disabled = [...(partner.disabledTools ?? [])];
	const disabledSet = new Set(disabled);
	const tools: PartnerToolItem[] = modelToolCatalog().map((tool) => ({
		name: tool.name,
		group: toolGroupOf(tool.name),
		summary: toolSummaryOf(tool.description),
		enabled: !disabledSet.has(tool.name),
		deferred: tool.deferred === true,
	}));
	return {
		enabled: partnerToolsEnabled(),
		disabled,
		groups: [...PARTNER_TOOL_GROUPS],
		tools,
	};
}

/**
 * PUT 入参收口：必须是数组、元素都是字符串、≤64 个；去重、只保留已知名。
 * 未知名**不静默吞**，整批 400 并返回名单（端点拼 `未知工具：a、b`）。空数组合法 = 全开。
 */
export function sanitizeDisabledTools(
	input: unknown,
	known: ReadonlySet<string>,
): { ok: true; disabled: string[] } | { ok: false; message: string; unknown?: string[] } {
	if (!Array.isArray(input)) return { ok: false, message: "disabled 必须是字符串数组" };
	if (input.length > 64) return { ok: false, message: "disabled 最多 64 项" };
	const seen = new Set<string>();
	const unknown: string[] = [];
	const disabled: string[] = [];
	for (const item of input) {
		if (typeof item !== "string") return { ok: false, message: "disabled 元素必须是字符串" };
		if (!known.has(item)) {
			if (!unknown.includes(item)) unknown.push(item);
			continue;
		}
		if (!seen.has(item)) {
			seen.add(item);
			disabled.push(item);
		}
	}
	if (unknown.length > 0) {
		return { ok: false, message: `未知工具：${unknown.join("、")}`, unknown };
	}
	return { ok: true, disabled };
}

/**
 * 工具依赖收口（2026-11-16 工具裁剪 A+B 联调）：`delegate` 的描述让模型先调 `skill({name:"delegate"})`
 * 读手册；把 skill 关掉、delegate 还开着，等于让派活失去配套说明。两者都在目录里时，
 * 不允许“只关 skill 不关 delegate”；把 delegate 一起关掉则合法（这个人不派活）。
 * 返回 null = 允许；字符串 = 400 文案。
 */
export function toolDependencyError(
	disabled: readonly string[],
	known: ReadonlySet<string>,
): string | null {
	if (!known.has("delegate") || !known.has("skill")) return null;
	if (disabled.includes("skill") && !disabled.includes("delegate")) {
		return "delegate 依赖 skill 读取派活手册：要关 skill 请同时关 delegate";
	}
	return null;
}

/**
 * 把某人的工具勾选应用到会话，**下一轮生效**（在 chatStream 提交用户输入前调用）。
 *
 * 只比较目录内**非 deferred** 工具的名字集合（按集合，不看顺序）：deferred 的加载状态归
 * `tool_search` 管，不归勾选管——所以只有 deferred 集合变化时不写一个字节。
 *
 * 写 `modelTools` 是**整体替换**：必须把本会话已被 tool_search 加载的 deferred 名字带回 `add`，
 * 否则每次勾选保存都会把它们抹掉。规则：
 *   - 已加载且仍勾选的 deferred → `add`；
 *   - 已加载但被取消勾选的 deferred → `remove`，且不进 `add`（内核 offeredTools 里 remove 优先）；
 *   - 非 deferred 的取消名单 → `remove`（语义不变）；
 *   - `disabled` 为空且没有已加载 deferred → `configure({modelTools:null})` 恢复默认。
 *
 * 额外 extension 工具（不在目录里，如 research 的 web_search）不参与比较，不会导致误写。
 * 失败只 console.warn，绝不向上抛（工具面读不到不能挡对话）。
 *
 * `catalogPool` 可选，仅单测注入造 deferred 目录；正常调用方不传。
 */
export async function applyPartnerToolSelection(
	conversation: Conversation,
	partner: PartnerRow,
	catalogPool?: readonly ToolRegistration[],
): Promise<void> {
	if (!partnerToolsEnabled()) return;
	try {
		const catalog = modelToolCatalog(catalogPool);
		const catalogNames = new Set(catalog.map((tool) => tool.name));
		const byName = new Map(catalog.map((tool) => [tool.name, tool]));
		const nonDeferred = catalog.filter((tool) => tool.deferred !== true);
		const disabled = new Set(partner.disabledTools ?? []);
		const desired = nonDeferred.filter((tool) => !disabled.has(tool.name)).map((tool) => tool.name);

		const agent = await conversation.agent(CTX).catch(() => null);
		const current = (agent?.tools ?? [])
			.filter((tool) => catalogNames.has(tool.name) && tool.deferred !== true)
			.map((tool) => tool.name);

		const currentSet = new Set(current);
		const same =
			currentSet.size === desired.length && desired.every((name) => currentSet.has(name));
		// 被取消的 deferred 工具必须落进 remove：内核的 agent.deferred 是「延迟 − 已 offer」，
		// 不写 remove 它就一直留在可加载清单里。这种情形下即使非 deferred 集合没变也要写一次
		// （等值写入内核不记变更，重复写无副作用）。
		const disabledDeferred = catalog.some((tool) => tool.deferred === true && disabled.has(tool.name));
		if (same && !disabledDeferred) return;

		// 按名字从目录取回注册对象：内核 configure 只读每项的 `.name`。
		const loaded = (agent?.tools ?? [])
			.filter((tool) => isDeferredTool(tool.name))
			.map((tool) => byName.get(tool.name))
			.filter((tool): tool is ToolRegistration => tool !== undefined);
		// 取消名单里的工具一律进 remove——包括**还没被 tool_search 加载过**的 deferred：
		// 否则它在内核眼里仍属于 agent.deferred，会继续出现在 tool_index 里、也还能被加载。
		const remove = catalog.filter((tool) => disabled.has(tool.name));
		const add = loaded.filter((tool) => !disabled.has(tool.name));

		if (disabled.size === 0 && add.length === 0) {
			await conversation.configure({ modelTools: null }, CTX);
		} else {
			await conversation.configure(
				{
					modelTools: {
						...(remove.length ? { remove } : {}),
						...(add.length ? { add } : {}),
					},
				},
				CTX,
			);
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[partner-tools] 应用工具勾选失败（不挡对话）：${detail}`);
	}
}
