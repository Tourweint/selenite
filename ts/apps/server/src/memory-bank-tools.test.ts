import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 记忆库槽位的工具路由（2026-11-23 外部记忆库接入）。
 *
 * 不起 python：`memoryBank` 是结构替身；验 recall / remember 在 external 与 builtin
 * 两个槽位下的分发、失败不回落、写入开关与「参数未生效」提示。真实 ask.py / repair.py
 * 链路在 `scripts/memory-bank-probe.ts`。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-bank-tools-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.MEMORY_ENABLED = "false";
process.env.COMPANIONS_ENABLED = "false";

const { createTools } = await import("./tools.ts");
type MemoryBankAccess = import("./tools.ts").MemoryBankAccess;
type PersonaRecallResult = import("./tools.ts").PersonaRecallResult;
const { partnersStore } = await import("./partners.ts");

const BASE_DEPS = {
	memory: null,
	scopeOf: () => ({ type: "global" as const }),
} as const;

function bank(over: Partial<MemoryBankAccess> = {}): MemoryBankAccess {
	return {
		active: () => "external",
		ask: async () => ({ ok: true, question: "q" }),
		write: async () => ({ ok: true }),
		writable: () => true,
		...over,
	};
}

function toolOf(name: string, memoryBank: MemoryBankAccess | null) {
	return createTools({ ...BASE_DEPS, memoryBank }).find((tool) => tool.name === name);
}

async function runTool(
	tool: NonNullable<ReturnType<typeof toolOf>>,
	args: Record<string, unknown>,
	conversationId = 1,
): Promise<{
	ok: boolean;
	data?: Record<string, unknown>;
	error?: { code?: string; message?: string; hint?: string };
}> {
	const result = await tool.execute(args as never, { conversationId } as never, {} as never);
	const text = (result.output ?? [])
		.map((item) => (item.type === "text" ? item.text : ""))
		.join("");
	return JSON.parse(text) as {
		ok: boolean;
		data?: Record<string, unknown>;
		error?: { code?: string; message?: string; hint?: string };
	};
}

function okResult(over: Partial<PersonaRecallResult> = {}): PersonaRecallResult {
	return { ok: true, question: "q", ...over };
}

test("recall 外部：ask 结果用 renderPersonaAsk 渲染，返回 {count, message}", async () => {
	const recall = toolOf(
		"recall",
		bank({
			ask: async () =>
				okResult({
					groups: {
						memory_day: [{ id: "mem-1", date: "2024-10-06", title: "旧事", text: "假命中正文" }],
					},
					unknown: "查不到 ≠ 没有这回事",
				}),
		}),
	);
	assert.ok(recall);
	const result = await runTool(recall, { query: "旧事", limit: 3 });
	assert.equal(result.ok, true);
	assert.equal(result.data?.count, 1);
	const message = String(result.data?.message ?? "");
	assert.match(message, /\[日记忆\] 2024-10-06｜旧事：假命中正文（mem-1）/);
	assert.match(message, /查不到 ≠ 没有这回事/);
});

test("recall 外部：扁平 hits（组名不固定）按原组名渲染，空 hits 是空结果不是失败", async () => {
	const recall = toolOf(
		"recall",
		bank({
			ask: async () =>
				okResult({
					hits: [{ id: "n1", date: "2024-01-01", text: "外部库正文", group: "notes" }],
				}),
		}),
	);
	assert.ok(recall);
	const hit = await runTool(recall, { query: "正文" });
	assert.equal(hit.ok, true);
	assert.equal(hit.data?.count, 1);
	assert.match(String(hit.data?.message ?? ""), /\[notes\] 2024-01-01｜外部库正文（n1）/);

	const emptyRecall = toolOf("recall", bank({ ask: async () => okResult({ hits: [] }) }));
	assert.ok(emptyRecall);
	const empty = await runTool(emptyRecall, { query: "没有" });
	assert.equal(empty.ok, true);
	assert.equal(empty.data?.count, 0);
	assert.match(String(empty.data?.message ?? ""), /当前外部记忆库里没有查到相关记录/);
});

test("recall 外部：查失败返回 memory_unavailable，不回落内置库（memory=null 也不炸）", async () => {
	const recall = toolOf("recall", bank({ ask: async () => ({ ok: false, question: "q", error: "内部细节" }) }));
	assert.ok(recall);
	const result = await runTool(recall, { query: "四级" });
	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "memory_unavailable");
	assert.match(result.error?.message ?? "", /暂时查不了/);
	assert.ok(!(result.error?.message ?? "").includes("内部细节"), "不把内部错误细节透给模型");
});

test("recall 外部：只有 timedOut=true 才把超时文案透传给模型（缺省仍走通用文案）", async () => {
	const recall = toolOf(
		"recall",
		bank({
			ask: async () => ({
				ok: false,
				question: "q",
				error: "persona 检索超时（15s）",
				timedOut: true,
			}),
		}),
	);
	assert.ok(recall);
	const timedOut = await runTool(recall, { query: "四级" });
	assert.equal(timedOut.ok, false);
	assert.equal(timedOut.error?.code, "memory_unavailable");
	assert.equal(timedOut.error?.message, "persona 检索超时（15s）", "超时文案原样给模型");
	assert.match(timedOut.error?.hint ?? "", /查得太慢/);
	assert.match(timedOut.error?.hint ?? "", /别连续重试同一个查询/);

	// 同样的 error 字符串、没有 timedOut 标记：仍走通用文案（结构标记决定，不靠字符串匹配）。
	const generic = toolOf(
		"recall",
		bank({ ask: async () => ({ ok: false, question: "q", error: "persona 检索超时（15s）" }) }),
	);
	assert.ok(generic);
	const other = await runTool(generic, { query: "四级" });
	assert.equal(other.ok, false);
	assert.match(other.error?.message ?? "", /暂时查不了/);
	assert.ok(!(other.error?.message ?? "").includes("检索超时"), "缺 timedOut 不透传");
});

test("recall 外部：PERSONA_MEMORY_ENABLED=false 的关闭文案原样转告", async () => {
	const recall = toolOf(
		"recall",
		bank({
			ask: async () => ({
				ok: false,
				question: "q",
				error: "外部记忆库已关闭（PERSONA_MEMORY_ENABLED=false）",
			}),
		}),
	);
	assert.ok(recall);
	const result = await runTool(recall, { query: "四级" });
	assert.equal(result.ok, false);
	assert.match(result.error?.message ?? "", /外部记忆库已关闭/);
});

test("remember 外部：body 原话 + 固定 why，返回「参数未生效」提示", async () => {
	const calls: Array<{ body: string; why: string; about?: string; tag?: string }> = [];
	const remember = toolOf(
		"remember",
		bank({
			write: async (input) => {
				calls.push(input);
				return { ok: true, statementId: "us-0123456789" };
			},
		}),
	);
	assert.ok(remember);
	const result = await runTool(remember, {
		content: "住院的是我姥姥",
		kind: "fact",
		scope: "project",
		importance: 0.9,
	});
	assert.equal(result.ok, true);
	assert.deepEqual(calls, [{ body: "住院的是我姥姥", why: "用户让记住" }]);
	const message = String(result.data?.message ?? "");
	assert.match(message, /已记住：住院的是我姥姥/);
	assert.match(message, /外部记忆库只收原话；kind\/scope 等参数未生效/);
});

test("remember 外部：写入未开启 → memory_write_disabled，不调用 write", async () => {
	let wrote = false;
	const remember = toolOf(
		"remember",
		bank({
			writable: () => false,
			write: async () => {
				wrote = true;
				return { ok: true };
			},
		}),
	);
	assert.ok(remember);
	const result = await runTool(remember, { content: "原话" });
	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "memory_write_disabled");
	assert.match(result.error?.message ?? "", /写入未开启/);
	assert.equal(wrote, false, "未开启时不该 spawn repair.py");
});

test("remember 外部：写失败 → memory_write_failed，不回落内置库", async () => {
	const remember = toolOf(
		"remember",
		bank({ write: async () => ({ ok: false, error: "persona 写入失败（退出码 2）" }) }),
	);
	assert.ok(remember);
	const result = await runTool(remember, { content: "原话" });
	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "memory_write_failed");
	assert.match(result.error?.message ?? "", /退出码 2/);
});

test("群聊：两个槽位的 recall / remember 都不进个人记忆", async () => {
	const store = partnersStore();
	const partner = store.create("群成员");
	store.linkSession({ partnerId: partner.id, role: "group", routeKey: "group:probe", sessionId: 9001 });

	const recall = toolOf("recall", bank());
	const remember = toolOf("remember", bank());
	assert.ok(recall);
	assert.ok(remember);
	const recalled = await runTool(recall, { query: "旧事" }, 9001);
	const remembered = await runTool(remember, { content: "原话" }, 9001);
	assert.equal(recalled.error?.code, "group_session");
	assert.equal(remembered.error?.code, "group_session");
});

test("内置槽位：memoryBank.active()=builtin 时交回内置引擎（没有引擎就照旧报错）", async () => {
	const recall = toolOf("recall", bank({ active: () => "builtin" }));
	assert.ok(recall);
	await assert.rejects(
		() => runTool(recall, { query: "旧事" }),
		/记忆库未启用/,
		"builtin 槽位不得被外部替身接管",
	);
});
