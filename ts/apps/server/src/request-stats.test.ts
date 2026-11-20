/**
 * 请求缓存统计单测（2026-11-19）
 *
 * 用最小的假 Conversation：entries 扫描 + context(at) 重放，与 durable 的口径一致。
 * 只测「怎么从 entry 还原请求 / 分页 / 相邻对比」，不测真实存储。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ContextView, Conversation, EntryRecord } from "@earendil-works/pi-durable";
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
