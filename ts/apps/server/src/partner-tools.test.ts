import assert from "node:assert/strict";
import { test } from "node:test";

import type { Conversation, ToolRegistration } from "@earendil-works/pi-durable";
import {
	applyPartnerToolSelection,
	modelToolCatalog,
	partnerToolsEnabled,
	PARTNER_TOOL_GROUPS,
	sanitizeDisabledTools,
	toolDependencyError,
	toolGroupOf,
	toolSummaryOf,
} from "./partner-tools.ts";
import type { PartnerRow } from "./partner-types.ts";

// 本文件只测开关读法（显式 env），apply 用真实 process.env —— 钉成开，避免外部 .env 干扰。
process.env.PARTNER_TOOLS_ENABLED = "true";

function tool(name: string, extra: Record<string, unknown> = {}): ToolRegistration {
	return {
		name,
		description: `${name} 做一件事。第二句不该出现在摘要里。`,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: "ok" }),
		...extra,
	} as unknown as ToolRegistration;
}

function partnerWith(disabledTools: string[]): PartnerRow {
	return { id: "p-1", name: "测试执事", disabledTools } as unknown as PartnerRow;
}

/** 假 conversation：agent() 返回给定工具，configure() 记录每次调用。 */
function fakeConversation(
	tools: readonly ToolRegistration[],
	calls: unknown[],
	failAgent = false,
): Conversation {
	return {
		agent: async () => {
			if (failAgent) throw new Error("agent 读不到");
			return { tools };
		},
		configure: async (change: unknown) => {
			calls.push(change);
		},
	} as unknown as Conversation;
}

// ── 目录 ──────────────────────────────────────────────

test("modelToolCatalog：deferred 包含（带标记）/ 只过滤 callers 不含 model / 按名去重，保持注册顺序", () => {
	const catalog = modelToolCatalog([
		tool("read"),
		tool("hidden", { deferred: true }),
		tool("tools_only", { callers: ["tools"] }),
		tool("both", { callers: ["model", "tools"] }),
		tool("read", { description: "重名第二个" }), // 先到先得
		tool("model_only", { callers: ["model"] }),
	]);
	assert.deepEqual(
		catalog.map((t) => t.name),
		["read", "hidden", "both", "model_only"],
	);
	assert.equal(catalog.find((item) => item.name === "hidden")?.deferred, true, "deferred 带标记进目录");
	assert.match(catalog[0]?.description ?? "", /read 做一件事/, "重名时保留第一个");
});

// ── 组与摘要 ──────────────────────────────────────────

test("PARTNER_TOOL_GROUPS 固定六组顺序；toolGroupOf 未知归其他", () => {
	assert.deepEqual([...PARTNER_TOOL_GROUPS], [
		"文件与命令",
		"记忆",
		"派活与任务",
		"资料与技能",
		"执事与群组",
		"其他",
	]);
	assert.equal(toolGroupOf("read"), "文件与命令");
	assert.equal(toolGroupOf("powershell"), "文件与命令");
	assert.equal(toolGroupOf("recall"), "记忆");
	assert.equal(toolGroupOf("delegate"), "派活与任务");
	assert.equal(toolGroupOf("web_search"), "资料与技能");
	assert.equal(toolGroupOf("send_to_agent"), "执事与群组");
	assert.equal(toolGroupOf("brand_new_tool"), "其他");
});

test("toolSummaryOf：取首句 / 首行、去 Markdown 标记、trim、超 80 字截断加省略号", () => {
	assert.equal(toolSummaryOf("读取文件。第二句不要。"), "读取文件");
	assert.equal(toolSummaryOf("  首行说明\n第二行  "), "首行说明");
	assert.equal(toolSummaryOf("问一句？后面不要"), "问一句");
	assert.equal(toolSummaryOf(""), "");
	assert.equal(toolSummaryOf("在**主人的个人记忆库**里检索"), "在主人的个人记忆库里检索");
	assert.equal(toolSummaryOf("`delegate` 派活"), "delegate 派活");
	const long = "字".repeat(100);
	const cut = toolSummaryOf(long);
	assert.equal([...cut].length, 81);
	assert.ok(cut.endsWith("…"));
});

// ── 入参收口 ──────────────────────────────────────────

test("sanitizeDisabledTools：非数组 / 非字符串 / 超 64 都拒", () => {
	const known = new Set(["read", "write"]);
	assert.equal(sanitizeDisabledTools(null, known).ok, false);
	assert.equal(sanitizeDisabledTools("read", known).ok, false);
	assert.equal(sanitizeDisabledTools([1], known).ok, false);
	assert.equal(sanitizeDisabledTools([null], known).ok, false);
	assert.equal(sanitizeDisabledTools(new Array(65).fill("read"), known).ok, false);
});

test("sanitizeDisabledTools：去重、未知名 400、空数组合法", () => {
	const known = new Set(["read", "write"]);
	assert.deepEqual(sanitizeDisabledTools(["read", "read", "write"], known), {
		ok: true,
		disabled: ["read", "write"],
	});
	assert.deepEqual(sanitizeDisabledTools([], known), { ok: true, disabled: [] });
	const bad = sanitizeDisabledTools(["read", "a", "b", "a"], known);
	assert.equal(bad.ok, false);
	if (!bad.ok) {
		assert.deepEqual(bad.unknown, ["a", "b"]);
		assert.match(bad.message, /未知工具：a、b/);
	}
});

test("toolDependencyError：只关 skill 不关 delegate 拒；一起关 / 无关工具放行", () => {
	const known = new Set(["delegate", "skill", "read"]);
	assert.match(toolDependencyError(["skill"], known) ?? "", /delegate 依赖 skill/);
	assert.equal(toolDependencyError(["skill", "delegate"], known), null);
	assert.equal(toolDependencyError(["read"], known), null);
	assert.equal(toolDependencyError(["skill"], new Set(["read"])), null);
});

// ── 运行时应用 ────────────────────────────────────────

test("applyPartnerToolSelection：名单相同不写任何东西", async () => {
	const catalog = modelToolCatalog();
	const calls: unknown[] = [];
	const conversation = fakeConversation(
		catalog, // agent.tools = 全目录 = desired（没有取消）
		calls,
	);
	await applyPartnerToolSelection(conversation, partnerWith([]));
	assert.equal(calls.length, 0);
});

test("applyPartnerToolSelection：名单不同才写 remove（只写被取消的那一个）", async () => {
	const catalog = modelToolCatalog();
	assert.ok(catalog.length >= 2, "真实目录至少两个工具");
	const disabledName = catalog[0]!.name;
	const calls: unknown[] = [];
	const conversation = fakeConversation(catalog, calls);
	await applyPartnerToolSelection(conversation, partnerWith([disabledName]));
	assert.equal(calls.length, 1);
	const change = calls[0] as { modelTools: { remove: ToolRegistration[] } };
	assert.deepEqual(change.modelTools.remove.map((t) => t.name), [disabledName]);
});

test("applyPartnerToolSelection：清空名单写 {modelTools:null} 恢复默认", async () => {
	const catalog = modelToolCatalog();
	const disabledName = catalog[0]!.name;
	const calls: unknown[] = [];
	// agent.tools 少了被取消的那个（当前态 = 已裁剪），现在名单清空 → 期望全目录 → 不同 → null。
	const conversation = fakeConversation(
		catalog.filter((t) => t.name !== disabledName),
		calls,
	);
	await applyPartnerToolSelection(conversation, partnerWith([]));
	assert.deepEqual(calls, [{ modelTools: null }]);
});

test("applyPartnerToolSelection：只比较目录内工具，额外 extension 工具不导致误写", async () => {
	const catalog = modelToolCatalog();
	const calls: unknown[] = [];
	const extra = tool("extra_extension_tool");
	const conversation = fakeConversation([...catalog, extra], calls);
	await applyPartnerToolSelection(conversation, partnerWith([]));
	assert.equal(calls.length, 0, "目录外工具不该触发写入");
});

test("applyPartnerToolSelection：agent() 读不到也不抛（只 warn）", async () => {
	const calls: unknown[] = [];
	const conversation = fakeConversation([], calls, true);
	await applyPartnerToolSelection(conversation, partnerWith(["read"]));
	assert.equal(calls.length, 1, "agent 读不到时按空集合走，仍会写 remove");
});

// ── 与低频工具索引（C）的交互 ──────────────────────────

test("applyPartnerToolSelection：disabled 为空但已加载 deferred → 写 add 而不是 null", async () => {
	const deferred = tool("routine_manage", { deferred: true });
	const pool = [tool("read"), deferred];
	const calls: unknown[] = [];
	// agent.tools 里只有已加载的 deferred（缺 read → 非 deferred 集合不同，触发写）
	const conversation = fakeConversation([deferred], calls);
	await applyPartnerToolSelection(conversation, partnerWith([]), pool);
	assert.equal(calls.length, 1);
	const change = calls[0] as {
		modelTools: { add?: ToolRegistration[]; remove?: ToolRegistration[] };
	};
	assert.deepEqual(change.modelTools.add?.map((item) => item.name), ["routine_manage"]);
	assert.equal(change.modelTools.remove, undefined);
});

test("applyPartnerToolSelection：关掉已加载 deferred → 进 remove、不进 add", async () => {
	const deferred = tool("routine_manage", { deferred: true });
	const pool = [tool("read"), tool("write"), deferred];
	const calls: unknown[] = [];
	const conversation = fakeConversation([tool("read"), tool("write"), deferred], calls);
	// 同时取消 write（确保非 deferred 集合变化触发写）和已加载的 deferred
	await applyPartnerToolSelection(conversation, partnerWith(["write", "routine_manage"]), pool);
	assert.equal(calls.length, 1);
	const change = calls[0] as {
		modelTools: { add?: ToolRegistration[]; remove?: ToolRegistration[] };
	};
	const removed = (change.modelTools.remove ?? []).map((item) => item.name);
	const added = (change.modelTools.add ?? []).map((item) => item.name);
	assert.ok(removed.includes("routine_manage"), "被取消的已加载 deferred 进 remove");
	assert.ok(removed.includes("write"), "非 deferred 取消名单照旧进 remove");
	assert.ok(!added.includes("routine_manage"), "被取消的 deferred 不能出现在 add 里");
});

test("applyPartnerToolSelection：只取消未加载的 deferred 也要写 remove（否则它仍可被 tool_search 加载）", async () => {
	const deferred = tool("routine_manage", { deferred: true });
	const pool = [tool("read"), deferred];
	const calls: unknown[] = [];
	// agent.tools 没加载 deferred、disabled 只含 deferred：非 deferred 集合相同，
	// 但被取消的 deferred 必须落进 remove —— 内核的 deferred 是「延迟 − 已 offer」，
	// 不写 remove 它就一直留在可加载清单里（2026-11-16 C 段实测到的坑）。
	const conversation = fakeConversation([tool("read")], calls);
	await applyPartnerToolSelection(conversation, partnerWith(["routine_manage"]), pool);
	assert.equal(calls.length, 1);
	const change = calls[0] as {
		modelTools: { add?: ToolRegistration[]; remove?: ToolRegistration[] } | null;
	};
	const removed = (change.modelTools?.remove ?? []).map((item) => item.name);
	assert.deepEqual(removed, ["routine_manage"]);
	assert.equal(change.modelTools?.add, undefined, "没有已加载的 deferred，不该写 add");
});

test("applyPartnerToolSelection：deferred 集合无变化且未被取消时不写", async () => {
	const deferred = tool("routine_manage", { deferred: true });
	const pool = [tool("read"), deferred];
	const calls: unknown[] = [];
	const conversation = fakeConversation([tool("read")], calls);
	await applyPartnerToolSelection(conversation, partnerWith([]), pool);
	assert.equal(calls.length, 0, "全开且没有已加载 deferred → 不写");
});

test("partnerToolsEnabled：false / 0 / off 关，缺省 / 其它开", () => {
	assert.equal(partnerToolsEnabled({}), true);
	assert.equal(partnerToolsEnabled({ PARTNER_TOOLS_ENABLED: "1" }), true);
	assert.equal(partnerToolsEnabled({ PARTNER_TOOLS_ENABLED: "FALSE" }), false);
	assert.equal(partnerToolsEnabled({ PARTNER_TOOLS_ENABLED: "0" }), false);
	assert.equal(partnerToolsEnabled({ PARTNER_TOOLS_ENABLED: " off " }), false);
});
