/**
 * 请求缓存统计单测（2026-11-19）
 *
 * 用最小的假 Conversation：entries 扫描 + context(at) 重放，与 durable 的口径一致。
 * 只测「怎么从 entry 还原请求 / 分页 / 相邻对比」，不测真实存储。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ContextView, Conversation, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import {
	CACHE_STATS_MAX_REQUESTS,
	recentRequestsOf,
	requestContextOf,
	requestStatsOf,
} from "./request-stats.ts";

type SectionMap = Record<string, string | null>;

function systemEntry(id: number, sections: SectionMap): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind: "pi.system",
		model: [{ role: "system", content: "", sections, timestamp: 0 }],
	} as unknown as EntryRecord;
}

function userEntry(id: number, text: string): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind: "pi.user",
		model: [{ role: "user", content: text, timestamp: 0 }],
	} as unknown as EntryRecord;
}

function assistantEntry(
	id: number,
	usage: { input: number; output: number; cacheRead: number; cacheWrite?: number },
	at: number,
): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [{ type: "text", text: `reply-${id}` }],
				usage: { ...usage, cacheWrite: usage.cacheWrite ?? 0 },
				stopReason: "stop",
				model: "auto/test-model",
				provider: "auto",
				timestamp: at,
			},
		],
	} as unknown as EntryRecord;
}

function toolResultEntry(id: number): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: `c${id}`,
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				timestamp: 0,
			},
		],
	} as unknown as EntryRecord;
}

function systemToolsEntry(
	id: number,
	tools: Array<{ name: string; description: string; parameters: unknown }>,
): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind: "pi.system",
		model: [{ role: "system", content: "", toolsAdded: tools, timestamp: 0 }],
	} as unknown as EntryRecord;
}

const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";

function assistantToolCallEntry(
	id: number,
	usage: { input: number; output: number; cacheRead: number },
	at: number,
): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${id}`, name: "recall", arguments: {} }],
				usage: { ...usage, cacheWrite: 0 },
				stopReason: "toolUse",
				model: "auto/test-model",
				provider: "auto",
				timestamp: at,
			},
		],
	} as unknown as EntryRecord;
}

function toolResultForCall(id: number, toolCallId: string): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId,
				toolName: "recall",
				content: [{ type: "text", text: "ok" }],
				timestamp: 0,
			},
		],
	} as unknown as EntryRecord;
}

/**
 * 模拟内核 `orderToolResults`：assistant 的每个 toolCall 若在可见范围内没有匹配的
 * toolResult，就补一条 isError 占位（与 pi-durable 同一句文案）。这是"旧口径"产生
 * replaced 假阳性的根源——`context({at: 上一条请求})` 会把占位算进前缀。
 */
function toolCallChainConversation(entries: EntryRecord[]): Conversation {
	const sorted = [...entries].sort((a, b) => a.id - b.id);
	const viewAt = (at: number): ContextView => {
		const visible = sorted.filter((entry) => entry.id <= at);
		const messages: Array<Record<string, unknown>> = [];
		for (let index = 0; index < visible.length; index += 1) {
			const message = visible[index].model?.[0] as Record<string, unknown> | undefined;
			if (!message) continue;
			if (message.role === "toolResult") continue; // 工具结果由 assistant 后按调用顺序插回
			messages.push(message);
			if (message.role !== "assistant") continue;
			const calls = (
				(message.content as Array<{ type: string; id: string; name?: string }> | undefined) ?? []
			).filter((block) => block.type === "toolCall");
			if (calls.length === 0) continue;
			const results = new Map<string, Record<string, unknown>>();
			for (let next = index + 1; next < visible.length; next += 1) {
				const candidate = visible[next].model?.[0] as Record<string, unknown> | undefined;
				if (candidate?.role === "assistant") break;
				if (
					candidate?.role === "toolResult" &&
					typeof candidate.toolCallId === "string" &&
					!results.has(candidate.toolCallId)
				) {
					results.set(candidate.toolCallId, candidate);
				}
			}
			for (const call of calls) {
				messages.push(
					results.get(call.id) ?? {
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name ?? "tool",
						content: [{ type: "text", text: MISSING_RESULT_TEXT }],
						isError: true,
						details: { reason: "missing_result" },
						timestamp: message.timestamp,
					},
				);
			}
		}
		return { head: undefined, entries: visible, contributions: [], messages } as unknown as ContextView;
	};
	return {
		entries: async (
			query: { maxEntryId?: number; minEntryId?: number; order?: "ascending" | "descending" },
			limit: number,
		) => {
			let rows = sorted.filter(
				(entry) =>
					(query.minEntryId === undefined || entry.id >= query.minEntryId) &&
					(query.maxEntryId === undefined || entry.id <= query.maxEntryId),
			);
			if ((query.order ?? "descending") === "descending") rows = rows.reverse();
			return { items: rows.slice(0, limit) };
		},
		context: async (_context: unknown, options?: { at?: number }) =>
			viewAt(options?.at ?? Number.MAX_SAFE_INTEGER),
	} as unknown as Conversation;
}

/** 复刻生产 messageDiffOf 的逐条前缀算法，用来在测试里证明"旧口径"确实会误报。 */
function promptDiffOf(previous: ContextView, current: ContextView): {
	shared: number;
	replaced: number;
	appended: number;
} {
	const fingerprints = (view: ContextView): string[] =>
		view.messages.filter((message) => message.role !== "system").map((message) => JSON.stringify(message));
	const before = fingerprints(previous);
	const after = fingerprints(current);
	let shared = 0;
	while (shared < Math.min(before.length, after.length) && before[shared] === after[shared]) shared += 1;
	return { shared, replaced: before.length - shared, appended: after.length - shared };
}

function fakeConversation(entries: EntryRecord[]): Conversation {
	const sorted = [...entries].sort((a, b) => a.id - b.id);
	const conversation = {
		entries: async (
			query: { maxEntryId?: number; minEntryId?: number; order?: "ascending" | "descending" },
			limit: number,
		) => {
			let rows = sorted.filter(
				(entry) =>
					(query.minEntryId === undefined || entry.id >= query.minEntryId) &&
					(query.maxEntryId === undefined || entry.id <= query.maxEntryId),
			);
			if ((query.order ?? "descending") === "descending") rows = rows.reverse();
			return { items: rows.slice(0, limit) };
		},
		context: async (_context: unknown, options?: { at?: number }) => {
			const at = options?.at ?? Number.MAX_SAFE_INTEGER;
			const visible = sorted.filter((entry) => entry.id <= at);
			const messages = visible.flatMap((entry) => entry.model ?? []);
			const view: ContextView = {
				head: undefined,
				entries: visible,
				contributions: [],
				messages,
			};
			return view;
		},
	};
	return conversation as unknown as Conversation;
}

const CTX = {} as never;

test("recentRequestsOf：只收带 usage 的 assistant，0 token 与工具结果都不算请求", async () => {
	const conversation = fakeConversation([
		systemEntry(1, { persona: "人设" }),
		userEntry(2, "你好"),
		assistantEntry(3, { input: 10, output: 5, cacheRead: 90 }, 1000),
		toolResultEntry(4),
		assistantEntry(5, { input: 0, output: 0, cacheRead: 0 }, 1001), // 本地合成消息
		assistantEntry(6, { input: 20, output: 5, cacheRead: 180 }, 1002),
	]);
	const { rows, truncated } = await recentRequestsOf(conversation, CTX);
	assert.equal(truncated, false);
	assert.deepEqual(
		rows.map((row) => row.entryId),
		[6, 3],
		"新 → 旧；0 token 的 assistant 被跳过",
	);
	assert.deepEqual(
		rows.map((row) => row.seq),
		[2, 1],
		"seq 按时序（旧 → 新）编号",
	);
	assert.equal(rows[0].promptTokens, 200);
	assert.equal(rows[0].hitRate, 0.9);
});

test("recentRequestsOf：超过上限时截断并标记 truncated", async () => {
	const entries = [systemEntry(1, { persona: "人设" })];
	for (let index = 0; index < 5; index += 1) {
		entries.push(assistantEntry(10 + index, { input: 1, output: 1, cacheRead: 9 }, 1000 + index));
	}
	const { rows, truncated } = await recentRequestsOf(fakeConversation(entries), CTX, 3);
	assert.equal(rows.length, 3);
	assert.equal(truncated, true);
	assert.equal(CACHE_STATS_MAX_REQUESTS >= 500, true, "默认保留窗口至少 500 条");
});

test("requestStatsOf：100 条一页、页码夹取、汇总按保留窗口加权", async () => {
	const entries = [systemEntry(1, { persona: "人设" })];
	for (let index = 0; index < 130; index += 1) {
		entries.push(
			assistantEntry(10 + index, { input: 100, output: 10, cacheRead: 900 }, 1000 + index),
		);
	}
	const conversation = fakeConversation(entries);
	const first = await requestStatsOf(conversation, CTX, "chat-1", { page: 1 });
	assert.equal(first.total, 130);
	assert.equal(first.pageSize, 100);
	assert.equal(first.pages, 2);
	assert.equal(first.items.length, 100);
	assert.equal(first.items[0].seq, 130, "第一页从最新的开始");
	assert.equal(first.summary.requests, 130);
	assert.equal(first.summary.promptTokens, 130 * 1000);
	assert.equal(first.summary.cacheReadTokens, 130 * 900);
	assert.equal(first.summary.hitRate, 0.9);
	assert.equal(first.summary.fullMisses, 0);

	const second = await requestStatsOf(conversation, CTX, "chat-1", { page: 2 });
	assert.equal(second.items.length, 30);
	assert.equal(second.items[0].seq, 30);

	const clamped = await requestStatsOf(conversation, CTX, "chat-1", { page: 99 });
	assert.equal(clamped.page, 2, "越界页码夹到最后一页");
});

test("requestContextOf：重放当时的 system / 消息，并对比出变了哪个 section", async () => {
	const conversation = fakeConversation([
		systemEntry(1, { persona: "人设 A", current_project: "项目 A" }),
		userEntry(2, "第一轮"),
		assistantEntry(3, { input: 10, output: 5, cacheRead: 90 }, 1000),
		systemEntry(4, { current_project: "项目 B" }),
		userEntry(5, "第二轮"),
		assistantEntry(6, { input: 10, output: 5, cacheRead: 90 }, 2000),
	]);

	const detail = await requestContextOf(conversation, CTX, "chat-1", 6);
	assert.ok(detail);
	assert.equal(detail.request.entryId, 6);
	assert.equal(detail.system.tools, 0);
	assert.deepEqual(
		detail.system.sections.map((section) => section.key),
		["persona", "current_project"],
	);
	assert.equal(detail.compare?.entryId, 3);
	assert.equal(detail.compare?.systemChanged, true);
	assert.deepEqual(detail.compare?.changedSections, ["current_project"]);
	assert.equal(detail.context.entries.some((entry) => entry.kind === "user"), true);

	const first = await requestContextOf(conversation, CTX, "chat-1", 3);
	assert.equal(first?.compare, null, "第一条请求没有上一条");

	const missing = await requestContextOf(conversation, CTX, "chat-1", 2);
	assert.equal(missing, null, "不是模型请求的 entry 返回 null");
});

test("骤降定位：system 前缀变了 + 命中率从 90% 掉到 0% → prefix_change_drop", async () => {
	const conversation = fakeConversation([
		systemEntry(1, { persona: "人设 A" }),
		userEntry(2, "第一轮"),
		assistantEntry(3, { input: 10, output: 5, cacheRead: 90 }, 1000),
		// 跑到一半追加一个 section：durable 会写一条 pi.system 补丁
		systemEntry(4, { skills: "技能索引：新技能" }),
		userEntry(5, "第二轮"),
		assistantEntry(6, { input: 100, output: 5, cacheRead: 0 }, 2000),
	]);
	const stats = await requestStatsOf(conversation, CTX, "chat-1");
	const newest = stats.items[0];
	assert.equal(newest.entryId, 6);
	assert.equal(newest.systemChanged, true);
	assert.equal(newest.toolsChanged, false);
	assert.equal(newest.prefixChanged, true);
	assert.equal(newest.drop, true);
	assert.equal(newest.flag, "prefix_change_drop");
	assert.equal(newest.systemPatches, 1);
	assert.equal(stats.summary.suspects, 1);
	assert.equal(stats.summary.drops, 1);
	assert.equal(stats.summary.prefixChanges, 1);
});

test("骤降定位：前缀没变 → drop_unchanged（缓存过期 / 上游，不报警）", async () => {
	const conversation = fakeConversation([
		systemEntry(1, { persona: "人设 A" }),
		userEntry(2, "第一轮"),
		assistantEntry(3, { input: 10, output: 5, cacheRead: 90 }, 1000),
		userEntry(4, "隔了很久再说一句"),
		assistantEntry(5, { input: 100, output: 5, cacheRead: 0 }, 2000),
	]);
	const stats = await requestStatsOf(conversation, CTX, "chat-1");
	const newest = stats.items[0];
	assert.equal(newest.systemChanged, false);
	assert.equal(newest.drop, true);
	assert.equal(newest.flag, "drop_unchanged");
	assert.equal(stats.summary.suspects, 0, "前缀没变不算可疑");
	assert.equal(stats.summary.drops, 1);
});

test("骤降定位：工具面变了单独标 tools_change（用户接受的一次性代价）", async () => {
	const conversation = fakeConversation([
		systemEntry(1, { persona: "人设 A" }),
		systemToolsEntry(2, [{ name: "read", description: "读", parameters: {} }]),
		userEntry(3, "第一轮"),
		assistantEntry(4, { input: 10, output: 5, cacheRead: 90 }, 1000),
		systemToolsEntry(5, [
			{ name: "read", description: "读", parameters: {} },
			{ name: "bash", description: "跑命令", parameters: {} },
		]),
		userEntry(6, "第二轮"),
		assistantEntry(7, { input: 100, output: 5, cacheRead: 0 }, 2000),
	]);
	const stats = await requestStatsOf(conversation, CTX, "chat-1");
	const newest = stats.items[0];
	assert.equal(newest.systemChanged, false, "system 段没变");
	assert.equal(newest.toolsChanged, true);
	assert.equal(newest.flag, "tools_change_drop");
	assert.equal(newest.systemChanged, false);
	assert.equal(stats.summary.suspects, 0, "工具面变化不算 system 前缀事故");
});

test("骤降定位：压缩/重置后的第一条标 compacted，不报可疑", async () => {
	const compaction: EntryRecord = {
		id: 4,
		conversationId: 1,
		kind: "pi.compaction",
		model: [{ role: "user", content: "摘要", timestamp: 0 }],
	} as unknown as EntryRecord;
	const conversation = fakeConversation([
		systemEntry(1, { persona: "人设 A" }),
		userEntry(2, "第一轮"),
		assistantEntry(3, { input: 10, output: 5, cacheRead: 90 }, 1000),
		compaction,
		systemEntry(5, { persona: "人设 A" }),
		userEntry(6, "压缩后"),
		assistantEntry(7, { input: 100, output: 5, cacheRead: 0 }, 2000),
	]);
	const stats = await requestStatsOf(conversation, CTX, "chat-1");
	const newest = stats.items[0];
	assert.equal(newest.flag, "compacted");
	assert.equal(stats.summary.suspects, 0);
});

test("详情对比（消息层）：两条请求之间只是追加 → replaced 0 / appended N，0% 能归因上游", async () => {
	const conversation = fakeConversation([
		systemEntry(1, { persona: "人设 A" }),
		userEntry(2, "第一轮"),
		assistantEntry(3, { input: 10, output: 5, cacheRead: 90 }, 1000),
		userEntry(4, "隔了一天再问一句"),
		assistantEntry(5, { input: 100, output: 5, cacheRead: 0 }, 2000),
	]);
	const detail = await requestContextOf(conversation, CTX, "chat-1", 5);
	assert.ok(detail?.compare);
	assert.equal(detail.compare.systemChanged, false);
	assert.equal(detail.compare.toolsChanged, false);
	// 2026-11-25 口径：对比两条请求各自发出前的 prompt。
	// 上一条 prompt = [用户]；这一条 prompt = [用户, 上一条回答, 新用户]。
	// 上一条请求自己的回答不在它的 prompt 里，所以只算这一条追加的 2 条。
	assert.deepEqual(detail.compare.messages, { shared: 1, replaced: 0, appended: 2 });
});

test("详情对比（消息层）：压缩重写正文 → replaced > 0（前缀必然断）", async () => {
	const compaction: EntryRecord = {
		id: 4,
		conversationId: 1,
		kind: "pi.compaction",
		model: [],
	} as unknown as EntryRecord;
	const entries = [
		systemEntry(1, { persona: "人设 A" }),
		userEntry(2, "第一轮"),
		assistantEntry(3, { input: 10, output: 5, cacheRead: 90 }, 1000),
		compaction,
		systemEntry(5, { persona: "人设 A" }),
		userEntry(6, "压缩后"),
		assistantEntry(7, { input: 100, output: 5, cacheRead: 0 }, 2000),
	];
	// durable 的压缩语义：compaction 之后上下文从 head 重来，压缩前的正文不再重放。
	const viewAt = (at: number): ContextView => {
		let visible = entries.filter((entry) => entry.id <= at);
		const lastCompaction = [...visible].reverse().find((entry) => entry.kind === "pi.compaction");
		if (lastCompaction) visible = visible.filter((entry) => entry.id > lastCompaction.id);
		return {
			head: undefined,
			entries: visible,
			contributions: [],
			messages: visible.flatMap((entry) => entry.model ?? []),
		} as ContextView;
	};
	const conversation = {
		entries: async (
			query: { maxEntryId?: number; minEntryId?: number; order?: "ascending" | "descending" },
			limit: number,
		) => {
			let rows = entries.filter(
				(entry) =>
					(query.minEntryId === undefined || entry.id >= query.minEntryId) &&
					(query.maxEntryId === undefined || entry.id <= query.maxEntryId),
			);
			if ((query.order ?? "descending") === "descending") rows = rows.reverse();
			return { items: rows.slice(0, limit) };
		},
		context: async (_context: unknown, options?: { at?: number }) => viewAt(options?.at ?? Number.MAX_SAFE_INTEGER),
	} as unknown as Conversation;
	const detail = await requestContextOf(conversation, CTX, "chat-1", 7);
	assert.ok(detail?.compare);
	// 压缩前 prompt = [用户]；压缩后 prompt = [用户「压缩后」]：旧前缀被换掉。
	assert.deepEqual(detail.compare.messages, { shared: 0, replaced: 1, appended: 1 });
});

test("详情对比（消息层）：正文被改写 → replaced > 0（前缀在改写处断掉）", async () => {
	const base = [
		systemEntry(1, { persona: "人设 A" }),
		userEntry(2, "第一轮"),
		assistantEntry(3, { input: 10, output: 5, cacheRead: 90 }, 1000),
		userEntry(4, "第二轮"),
		assistantEntry(5, { input: 100, output: 5, cacheRead: 0 }, 2000),
	];
	// 模拟 durable 的 edits：entry 2 的正文在请求 3 之后被改掉，
	// context(at) 重放时按“当时的正文”给——上一条看到旧文，这一条看到新文。
	const conversation = {
		entries: async (
			query: { maxEntryId?: number; minEntryId?: number; order?: "ascending" | "descending" },
			limit: number,
		) => {
			let rows = base.filter(
				(entry) =>
					(query.minEntryId === undefined || entry.id >= query.minEntryId) &&
					(query.maxEntryId === undefined || entry.id <= query.maxEntryId),
			);
			if ((query.order ?? "descending") === "descending") rows = rows.reverse();
			return { items: rows.slice(0, limit) };
		},
		context: async (_context: unknown, options?: { at?: number }) => {
			const at = options?.at ?? Number.MAX_SAFE_INTEGER;
			const visible = base
				.filter((entry) => entry.id <= at)
				.map((entry) =>
					entry.id === 2 && at >= 4
						? ({
								...entry,
								model: [{ role: "user", content: "第一轮（已改）", timestamp: 0 }],
							} as EntryRecord)
						: entry,
				);
			return {
				head: undefined,
				entries: visible,
				contributions: [],
				messages: visible.flatMap((entry) => entry.model ?? []),
			} as ContextView;
		},
	} as unknown as Conversation;
	const detail = await requestContextOf(conversation, CTX, "chat-1", 5);
	assert.ok(detail?.compare);
	// 旧 prompt = [旧「第一轮」]；新 prompt = [新「第一轮（已改）」, 助手回复, 新用户]。
	// 第一条就对不上：旧 1 条被换掉，新的 3 条都算追加。
	assert.deepEqual(detail.compare.messages, { shared: 0, replaced: 1, appended: 3 });
});

test("详情对比（消息层）：工具调用 → 下一请求带结果，只算追加（2026-11-25 修 replaced 假阳性）", async () => {
	const conversation = toolCallChainConversation([
		systemEntry(1, { persona: "人设 A" }),
		userEntry(2, "第一轮"),
		assistantToolCallEntry(3, { input: 10, output: 5, cacheRead: 90 }, 1000),
		toolResultForCall(4, "call-3"),
		assistantEntry(5, { input: 100, output: 5, cacheRead: 0 }, 2000),
	]);

	// 旧口径（直接对比两条请求 entry 自己的 context 视图）：上一条请求后的
	// 「未完成工具调用占位」被真实工具结果替换，replaced 假阳性。
	const previousView = await conversation.context(CTX, { at: 3 as EntryId });
	const currentView = await conversation.context(CTX, { at: 5 as EntryId });
	assert.deepEqual(
		promptDiffOf(previousView, currentView),
		{ shared: 2, replaced: 1, appended: 2 },
		"旧口径把占位算进前缀，工具结果一来就误报 replaced",
	);

	// 新口径：对比两条请求各自发出去之前的 prompt；上一条的回答与占位都不算前缀。
	// 上一条 prompt = [用户]；这一条 prompt = [用户, 工具调用, 工具结果]。
	const detail = await requestContextOf(conversation, CTX, "chat-1", 5);
	assert.ok(detail?.compare);
	assert.deepEqual(detail.compare.messages, { shared: 1, replaced: 0, appended: 2 });
});
