/**
 * 低频工具索引（2026-11-16 C 段；2026-11-17 名单可配）
 *
 * 机制完全交给内核，这里只做三件事：
 *   1. 一份按需名单 —— 哪些工具注册时打 `deferred: true`（初始不进请求）。
 *      名单住 `tool-pool.ts`：代码默认 8 个，用户可在「设置 → 工具」覆盖
 *      （`.data/tool-pool.json`，**重启后生效**：deferred 是注册期属性）；
 *   2. `markDeferred()` —— 在 createTools 之后给名单内工具补属性，浅拷贝、不改原对象、不动顺序；
 *   3. `toolIndexText()` —— 把"当前可加载的 deferred"投影成一段 prompt 文本。
 *
 * `tool_search` 的注册在 tools.ts 末尾（它自己不是 deferred）；内核收到
 * `control.addTools:[name]` 后把名字追加进会话 `modelTools.add`，下一轮起完整 schema 才进请求。
 *
 * 回滚：`AGENT_TOOL_INDEX=false/0/off` → 不打 deferred、不注册 tool_search、不渲染 tool_index，
 * 一行回到全量工具。
 */

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { toolSummaryOf } from "./partner-tools.ts";
import {
	DEFAULT_DEFERRED_TOOL_NAMES,
	noteAppliedDeferredNames,
	readDeferredToolNames,
} from "./tool-pool.ts";

/** 代码默认名单（旧名保留：测试与文档在引用；实际生效值由 `tool-pool.json` 覆盖）。 */
export const DEFERRED_TOOL_NAMES: ReadonlySet<string> = new Set(DEFAULT_DEFERRED_TOOL_NAMES);

const OFF_VALUES = new Set(["false", "0", "off"]);

/** AGENT_TOOL_INDEX：false / 0 / off（大小写、空白不敏感）= 关；缺省 / 其它 = 开。 */
export function toolIndexEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = String(env.AGENT_TOOL_INDEX ?? "").trim().toLowerCase();
	return !OFF_VALUES.has(raw);
}

/** 名字在当前按需名单里、且开关开 → 这个工具应当以 deferred 形态注册 / 可被 tool_search 加载。 */
export function isDeferredTool(
	name: string,
	enabled = toolIndexEnabled(),
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return enabled && readDeferredToolNames(env).includes(name);
}

/**
 * 给按需名单内工具补 `{ deferred: true }`（浅拷贝），名单外的原样返回；不改原对象、保持顺序。
 * 关时一个都不打，返回的新数组里放的都是原对象。
 *
 * 装配完把这一版实际用的名单记进 `tool-pool.ts`（端点据此显示"配置已改、待重启"）。
 */
export function markDeferred<T extends ToolRegistration>(
	tools: readonly T[],
	enabled = toolIndexEnabled(),
	env: NodeJS.ProcessEnv = process.env,
): T[] {
	if (!enabled) return [...tools];
	const names = readDeferredToolNames(env);
	const set = new Set(names);
	noteAppliedDeferredNames(names);
	return tools.map((tool) => (set.has(tool.name) ? ({ ...tool, deferred: true } as T) : tool));
}

const TOOL_INDEX_TITLE =
	'按需工具（初始不加载）：要用下面某个工具时，先调 tool_search({name:"工具名"}) 取完整定义，下一轮起它才可用。';

/**
 * 「按需工具」清单文本。空列表 → undefined（整段省略）。
 * 摘要复用 partner-tools 的 `toolSummaryOf`，不另抄一份截断逻辑。
 */
export function toolIndexText(
	available: readonly { name: string; description: string }[],
): string | undefined {
	if (available.length === 0) return undefined;
	return [
		TOOL_INDEX_TITLE,
		...available.map((tool) => `- ${tool.name}：${toolSummaryOf(tool.description)}`),
		"先调 tool_search({name}) 取完整定义，下一轮起它才可用。",
	].join("\n");
}
