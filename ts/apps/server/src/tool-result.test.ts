import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryScope } from "@lifediary/memory";
import { encodeToolResult, err, ok } from "./tool-result.ts";

/**
 * 工具返回统一契约（2026-11-10 批 16 §1.4）：形状正确、`hint` 可选。
 *
 * 断言的是**逐字节形状**而不是"包含这些字段"：这份契约要给手机端 / 未来的
 * 浏览器自动化消费，多一个键少一个键都算契约变化。
 */

test("ok：成功只带 ok + data，不夹带 error", () => {
	const result = ok({ count: 2, message: "找到了" });
	assert.deepEqual(result, { ok: true, data: { count: 2, message: "找到了" } });
	assert.equal(Object.keys(result).length, 2);
	assert.equal("error" in result, false);
});

test("err：给 hint 时三件齐全，不给时 error 里不许出现 hint 键", () => {
	const withHint = err("progress_too_long", "超长了", "压成一句");
	assert.deepEqual(withHint, {
		ok: false,
		error: { code: "progress_too_long", message: "超长了", hint: "压成一句" },
	});

	const withoutHint = err("progress_empty", "不能为空");
	assert.deepEqual(withoutHint, {
		ok: false,
		error: { code: "progress_empty", message: "不能为空" },
	});
	assert.equal("hint" in withoutHint.error, false, "没给 hint 时不该写 undefined 进去");
});

test("encodeToolResult：同输入逐字节相同，且能原样解回来", () => {
	const success = ok({ status: "waiting", callId: "call-1" });
	const encoded = encodeToolResult(success);
	assert.equal(encoded, encodeToolResult(ok({ status: "waiting", callId: "call-1" })));
	assert.deepEqual(JSON.parse(encoded), success);

	const failure = encodeToolResult(err("recall_failed", "没跑成"));
	assert.deepEqual(JSON.parse(failure), {
		ok: false,
		error: { code: "recall_failed", message: "没跑成" },
	});
});

/**
 * 迁移后的四个只读工具（2026-11-10 批 18 §五）：`recall` / `web_search` /
 * `propose_topic` / `skill` 的外层必须是 `ToolResult`，人读的 `message` 逐字不变。
 * 这里断言"包对了 + 文案没动"，工具自身的业务规则仍由各自模块负责。
 */

// 落点隔离：别让这组用例在仓库 `.data/` 里留执事库与技能用量账。
process.env.PARTNERS_DB_PATH = join(tmpdir(), `lifediary-tool-contract-${process.pid}.sqlite`);
process.env.AGENT_SKILL_USAGE_PATH = join(tmpdir(), `lifediary-tool-contract-${process.pid}.json`);

const { createTools } = await import("./tools.ts");

const GLOBAL_SCOPE: MemoryScope = { type: "global" };

type Tools = ReturnType<typeof createTools>;

function toolNamed(tools: Tools, name: string) {
	const tool = tools.find((item) => item.name === name);
	assert.ok(tool, `${name} 应该上架`);
	return tool;
}

/** 跑一次工具并把输出文本解回对象（编码格式是契约的一部分） */
async function runTool(
	tool: Tools[number],
	args: Record<string, unknown>,
): Promise<{ ok: boolean; data?: any; error?: { code: string; message: string; hint?: string } }> {
	const result = (await tool.execute(args as never, { conversationId: 7 } as never, {} as never)) as {
		output?: Array<{ type: string; text?: string }>;
	};
	const text = (result.output ?? [])
		.map((item) => (item.type === "text" ? item.text ?? "" : ""))
		.join("");
	return JSON.parse(text);
}

const MEMORY_HIT = {
	record: {
		kind: "fact",
		content: "喜欢喝乌龙茶",
		createdAt: "2026-01-02T03:04:05.000Z",
	},
	score: 1,
};

function deps(memory: unknown): Parameters<typeof createTools>[0] {
	return {
		memory: memory as never,
		scopeOf: () => GLOBAL_SCOPE,
		delegate: false,
		skills: {
			names: () => ["daily-brief"],
			manual: (name: string) => (name === "daily-brief" ? "# 日报\n按顺序做。" : undefined),
			indexFor: () => undefined,
		},
		search: {
			searchConfigured: () => true,
			searchKeyEnv: () => "DEEPSEEK_SEARCH_API_KEY" as const,
			webSearch: async (query: string) =>
				query === "空的"
					? { ok: true as const, hits: [] }
					: {
							ok: true as const,
							hits: [{ title: "标题", url: "https://example.com/a", summary: "摘要" }],
						},
		},
		topics: {
			proposeTopic: (input: { question: string }) => {
				if (input.question === "已在跟") {
					return {
						ok: false as const,
						reason: "exists" as const,
						existingTopicId: "topic-1",
						message: "这个课题已经在跟了，不用重复提。",
					};
				}
				return {
					ok: true as const,
					proposal: {
						id: "proposal-1",
						question: input.question,
						flavor: "watch",
						cron: "0 9 * * 1",
					},
				};
			},
		} as never,
	};
}

test("recall：命中包成 ok + message，文案与迁移前逐字一致", async () => {
	const tools = createTools(deps({ recall: () => [MEMORY_HIT] }));
	const out = await runTool(toolNamed(tools, "recall"), { query: "茶" });
	assert.equal(out.ok, true);
	assert.equal(out.data.count, 1);
	assert.equal(out.data.message, "- [fact] 喜欢喝乌龙茶（2026-01-02）");
	assert.equal("hits" in out.data, false, "不把带 scope 的原始 record 端给模型");
});

test("recall：没有命中仍是 ok（count 0），不是错误", async () => {
	const tools = createTools(deps({ recall: () => [] }));
	const out = await runTool(toolNamed(tools, "recall"), { query: "茶" });
	assert.deepEqual(out, { ok: true, data: { count: 0, message: "没有找到相关记忆。" } });
});

test("web_search：命中/空结果都包 ok，message 是同一份人读正文", async () => {
	const tools = createTools(deps({ recall: () => [] }));
	const hit = await runTool(toolNamed(tools, "web_search"), { query: "茶" });
	assert.equal(hit.ok, true);
	assert.equal(hit.data.count, 1);
	assert.equal(hit.data.message, "标题 — https://example.com/a\n摘要");

	const empty = await runTool(toolNamed(tools, "web_search"), { query: "空的" });
	assert.deepEqual(empty, { ok: true, data: { count: 0, message: "没有找到相关结果。" } });
});

test("web_search：上游错误走 err，code 用适配层的稳定枚举", async () => {
	const base = deps({ recall: () => [] });
	const tools = createTools({
		...base,
		search: {
			searchConfigured: () => false,
			searchKeyEnv: () => "DEEPSEEK_SEARCH_API_KEY" as const,
			webSearch: async () => ({
				ok: false as const,
				error: "search_not_configured" as const,
				message: "搜索还没配置：去 设置 → 服务页 填 DEEPSEEK_SEARCH_API_KEY（可在 .env 直接写）。",
			}),
		},
	});
	const out = await runTool(toolNamed(tools, "web_search"), { query: "茶" });
	assert.equal(out.ok, false);
	assert.equal(out.error?.code, "search_not_configured");
	assert.match(out.error?.message ?? "", /^搜索还没配置：/);
	assert.ok(out.error?.hint, "没配搜索要告诉模型下一步");
});

test("propose_topic：成功保留 proposal 字段，message 不变", async () => {
	const tools = createTools(deps({ recall: () => [] }));
	const out = await runTool(toolNamed(tools, "propose_topic"), {
		question: "长期盯一下茶价",
		flavor: "watch",
	});
	assert.equal(out.ok, true);
	assert.equal(out.data.proposalId, "proposal-1");
	assert.equal(out.data.flavor, "watch");
	assert.equal(out.data.cron, "0 9 * * 1");
	assert.match(out.data.message, /^已提交待确认：/);
});

test("propose_topic：失败走 err，已在跟的 id 进 hint；参数校验也是 err", async () => {
	const tools = createTools(deps({ recall: () => [] }));
	const exists = await runTool(toolNamed(tools, "propose_topic"), {
		question: "已在跟",
		flavor: "dig",
	});
	assert.equal(exists.ok, false);
	assert.equal(exists.error?.code, "exists");
	assert.equal(exists.error?.message, "这个课题已经在跟了，不用重复提。");
	assert.match(exists.error?.hint ?? "", /topic-1/);

	const empty = await runTool(toolNamed(tools, "propose_topic"), { question: "  ", flavor: "watch" });
	assert.deepEqual(empty, { ok: false, error: { code: "question_empty", message: "question 不能为空" } });
});

test("skill：取到手册包 ok，手册正文就在 message 里（内容逐字不变）", async () => {
	const tools = createTools(deps({ recall: () => [] }));
	const okOut = await runTool(toolNamed(tools, "skill"), { name: "daily-brief" });
	assert.equal(okOut.ok, true);
	assert.equal(okOut.data.name, "daily-brief");
	assert.equal(okOut.data.message, "# 日报\n按顺序做。");

	const miss = await runTool(toolNamed(tools, "skill"), { name: "没有这个" });
	assert.equal(miss.ok, false);
	assert.equal(miss.error?.code, "skill_not_found");
	assert.equal(miss.error?.message, "没有叫「没有这个」的技能。可用：daily-brief");
});

/**
 * delegate 契约迁移（2026-11-10 批 23b 五§八#1）：只包外层，不碰文案与业务分支。
 *
 * 回执用替身：真实 `DelegationReceipts` 会落 sqlite，这里只验证工具返回形状；
 * 回执自身的行为在 `delegation-receipts.test.ts`。
 */
const stubReceipts = {
	begin: () => ({ kind: "begun" }),
	accept: () => undefined,
	markFailed: () => undefined,
	recordResume: () => undefined,
	isCanceled: () => false,
	lookupByTicket: () => undefined,
} as never;

function delegateDeps(run: unknown, projects: unknown = null) {
	return {
		memory: null,
		scopeOf: () => GLOBAL_SCOPE,
		projects,
		receipts: stubReceipts,
		delegateRun: run,
	} as never;
}

const DELEGATE_TEXT = "已受理：任务单 T-9。它在后台执行，完成后我会汇报；不要等，也不要重复派。";

test("delegate：成功外层是 ok，message 逐字不变，ticketId 在 data", async () => {
	const previous = process.env.DELEGATION_PROJECT_REQUIRED;
	process.env.DELEGATION_PROJECT_REQUIRED = "false";
	try {
		const tools = createTools(
			delegateDeps(async (_request: unknown, options: { onEvent?: (event: unknown) => void }) => {
				options.onEvent?.({ type: "ticket", ticketId: "T-9", message: "已受理" });
				return { ticketId: "T-9", status: "done", line: "完成", tasks: [] };
			}),
		);
		const out = await runTool(toolNamed(tools, "delegate"), { requirement: "写一个文件" });
		assert.equal(out.ok, true);
		assert.equal(out.data.message, DELEGATE_TEXT);
		assert.equal(out.data.ticketId, "T-9");
	} finally {
		if (previous === undefined) delete process.env.DELEGATION_PROJECT_REQUIRED;
		else process.env.DELEGATION_PROJECT_REQUIRED = previous;
	}
});

test("delegate：needs_project 仍在 data（不是 error），候选清单不丢", async () => {
	const previous = process.env.DELEGATION_PROJECT_REQUIRED;
	process.env.DELEGATION_PROJECT_REQUIRED = "true";
	try {
		let called = 0;
		const tools = createTools(
			delegateDeps(async () => {
				called += 1;
				throw new Error("不该跑到执行");
			}),
		);
		const out = await runTool(toolNamed(tools, "delegate"), { requirement: "写一个文件" });
		assert.equal(out.ok, true, "needs_project 是业务分支，不是工具调用失败");
		assert.equal(out.data.error, "needs_project");
		assert.deepEqual(out.data.projects, []);
		assert.match(out.data.message, /项目/);
		assert.equal(called, 0, "没有项目不能起 worker");
	} finally {
		if (previous === undefined) delete process.env.DELEGATION_PROJECT_REQUIRED;
		else process.env.DELEGATION_PROJECT_REQUIRED = previous;
	}
});
