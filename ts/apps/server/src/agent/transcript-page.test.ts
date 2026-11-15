import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	decodeHistoryCursor,
	encodeHistoryCursor,
	historyDayKeyOf,
	readTranscriptPage,
} from "./transcript-page.ts";

/**
 * 分页纯函数测试：不启动 durable，用一个假的 `conversation.entries()` 模拟
 * SQLite 的 `(conversation_id, id DESC)` 扫描（含 maxEntryId 含边界、cursor 排他）。
 */

interface FakeEntry {
	id: number;
	conversationId: number;
	kind: string;
	/** 应用条目的 JSON 负载（2026-11-15 来信的作者进这里） */
	data?: Record<string, unknown>;
	model?: readonly {
		role: string;
		content: unknown;
		timestamp?: number;
		durationMs?: number;
		toolCallId?: string;
		isError?: boolean;
		details?: unknown;
	}[];
	head?: number;
}

function userEntry(id: number, text: string, at: number): FakeEntry {
	return {
		id,
		conversationId: 1,
		kind: "pi.user",
		model: [{ role: "user", content: text, timestamp: at }],
	};
}

/**
 * 来信条目（2026-11-15 作者标记方案）：应用 kind + 作者 data + 模型侧带来源前缀的正文。
 * 形状与 lifecycle `deliverPartnerRelay` 提交的一致。
 */
function relayEntry(id: number, text: string, at: number): FakeEntry {
	return {
		id,
		conversationId: 1,
		kind: "relay.message",
		data: { kind: "partner", id: "p-a", name: "信使甲", domain: "inbox", hop: 1 },
		model: [
			{
				role: "user",
				content: `[relay hop=1][来自执事 信使甲（inbox）] ${text}`,
				timestamp: at,
			},
		],
	};
}

function assistantEntry(id: number, text: string, at: number): FakeEntry {
	return {
		id,
		conversationId: 1,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				timestamp: at,
				durationMs: 10,
			},
		],
	};
}

function toolCallEntry(id: number, at: number): FakeEntry {
	return {
		id,
		conversationId: 1,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${id}`, name: "bash", arguments: {} }],
				timestamp: at,
			},
		],
	};
}

function toolResultEntry(id: number, at: number): FakeEntry {
	return {
		id,
		conversationId: 1,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				content: [{ type: "text", text: "ok" }],
				toolCallId: `call-${id - 1}`,
				timestamp: at,
			},
		],
	};
}

/** 假会话：只实现分页路径用到的 entries()。 */
function fakeChat(entries: FakeEntry[]) {
	return {
		externalId: "conv-1",
		internalId: 1,
		conversation: {
			entries: async (
				query: { maxEntryId?: number; order?: string },
				limit: number,
				cursor: { after?: number } | undefined,
			) => {
				const max = query.maxEntryId === undefined ? Number.POSITIVE_INFINITY : Number(query.maxEntryId);
				const after = cursor?.after === undefined ? Number.POSITIVE_INFINITY : Number(cursor.after);
				const rest = entries
					.filter((entry) => Number(entry.id) <= max && Number(entry.id) < after)
					.slice()
					.sort((a, b) => b.id - a.id);
				const items = rest.slice(0, limit);
				const next = rest.length > limit ? { after: items[items.length - 1]!.id } : undefined;
				return { items, ...(next ? { next } : {}) };
			},
		},
	} as never;
}

/** 本地时区某天的中午（避开 UTC/夏令时边界） */
function noonOf(month: number, date: number): number {
	return new Date(2026, month - 1, date, 12, 0, 0).getTime();
}

/** 两天各两轮：id 从 1 开始，时间升序 */
function twoDays(): { entries: FakeEntry[]; today: number; yesterday: number } {
	const yesterday = noonOf(11, 12);
	const today = noonOf(11, 13);
	const entries = [
		userEntry(1, "昨天问 1", yesterday),
		assistantEntry(2, "昨天答 1", yesterday + 1),
		userEntry(3, "昨天问 2", yesterday + 2),
		assistantEntry(4, "昨天答 2", yesterday + 3),
		userEntry(5, "今天问 1", today),
		assistantEntry(6, "今天答 1", today + 1),
		userEntry(7, "今天问 2", today + 2),
		assistantEntry(8, "今天答 2", today + 3),
	];
	return { entries, today, yesterday };
}

afterEach(() => {
	delete process.env.AGENT_TOKEN;
});

test("游标：同一会话可解、跨会话/被改/换令牌一律拒绝", () => {
	process.env.AGENT_TOKEN = "token-a";
	const token = encodeHistoryCursor("conv-1", 42);
	assert.equal(decodeHistoryCursor("conv-1", token), 42);
	assert.equal(decodeHistoryCursor("conv-2", token), null);
	assert.equal(decodeHistoryCursor("conv-1", `${token}x`), null);
	assert.equal(decodeHistoryCursor("conv-1", "not-a-cursor"), null);

	process.env.AGENT_TOKEN = "token-b";
	assert.equal(decodeHistoryCursor("conv-1", token), null);
});

test("分页：日界优先收页，两页无重叠无遗漏", async () => {
	const { entries } = twoDays();
	const chat = fakeChat(entries);

	const first = await readTranscriptPage(chat, { limit: 4 });
	assert.deepEqual(
		first.messages.map((message) => message.text),
		["今天问 1", "今天答 1", "今天问 2", "今天答 2"],
	);
	assert.equal(first.hasMore, true);
	assert.ok(first.nextBefore);

	const before = decodeHistoryCursor("conv-1", first.nextBefore!);
	assert.ok(before !== null);

	const second = await readTranscriptPage(chat, { limit: 4, beforeMaxEntryId: before! });
	assert.deepEqual(
		second.messages.map((message) => message.text),
		["昨天问 1", "昨天答 1", "昨天问 2", "昨天答 2"],
	);
	assert.equal(second.hasMore, false);
	assert.equal(second.nextBefore, undefined);
});

test("分页：一页只收一轮时不会从 assistant 开头（不切轮）", async () => {
	const { entries } = twoDays();
	const chat = fakeChat(entries);
	const page = await readTranscriptPage(chat, { limit: 2 });
	assert.equal(page.messages.length, 2);
	assert.equal(page.messages[0]!.role, "user");
	assert.equal(page.messages[1]!.role, "assistant");
});

test("分页：工具轮整轮保留（step 不跨页丢）", async () => {
	const day = noonOf(11, 13);
	const entries = [
		userEntry(1, "旧问题", day - 1000),
		assistantEntry(2, "旧回答", day - 999),
		userEntry(3, "跑个命令", day),
		toolCallEntry(4, day + 1),
		toolResultEntry(5, day + 2),
		assistantEntry(6, "跑完了", day + 3),
	];
	const chat = fakeChat(entries);
	const page = await readTranscriptPage(chat, { limit: 2 });
	assert.deepEqual(
		page.messages.map((message) => message.text),
		["跑个命令", "跑完了"],
	);
	assert.equal(page.messages[1]!.steps?.[0]?.name, "bash");
	assert.equal(page.messages[1]!.steps?.[0]?.ok, true);
});

test("分页：遇到最新 head 标记就停，压缩前的旧段不翻出来", async () => {
	const day = noonOf(11, 13);
	const entries: FakeEntry[] = [
		userEntry(1, "压缩前的旧问题", day - 2000),
		assistantEntry(2, "压缩前的旧回答", day - 1999),
		{ id: 3, conversationId: 1, kind: "pi.compaction", head: 1 },
		userEntry(4, "压缩后的问题", day),
		assistantEntry(5, "压缩后的回答", day + 1),
	];
	const page = await readTranscriptPage(fakeChat(entries), { limit: 20 });
	assert.deepEqual(
		page.messages.map((message) => message.text),
		["压缩后的问题", "压缩后的回答"],
	);
	assert.equal(page.hasMore, false);
});

test("分页：空会话返回空页且没有游标", async () => {
	const page = await readTranscriptPage(fakeChat([]), { limit: 20 });
	assert.deepEqual(page.messages, []);
	assert.equal(page.hasMore, false);
	assert.equal(page.nextBefore, undefined);
});

test("日界键：本地日历日；时间戳缺失不参与日界", () => {
	const day = historyDayKeyOf(noonOf(11, 13));
	assert.equal(day, "2026-11-13");
	assert.equal(historyDayKeyOf(0), null);
	assert.equal(historyDayKeyOf(undefined), null);
});

test("来信：relay.message 自成一轮、带作者、没有可编辑 id", async () => {
	const at = noonOf(11, 13);
	const chat = fakeChat([
		userEntry(1, "你先看下日程", at),
		assistantEntry(2, "好", at + 1),
		relayEntry(3, "对一下明天上午的口径", at + 2),
		assistantEntry(4, "收到", at + 3),
	]);

	const page = await readTranscriptPage(chat, { limit: 10 });
	assert.deepEqual(
		page.messages.map((message) => message.role),
		["user", "assistant", "user", "assistant"],
	);

	const letter = page.messages[2]!;
	// 模型侧前缀不进界面：抬头已经写了谁发来的
	assert.equal(letter.text, "对一下明天上午的口径");
	// 作者进结构；不给 id → 编辑重发拿不到锚点（主人能看不能改）
	assert.deepEqual(letter.author, {
		kind: "partner",
		id: "p-a",
		name: "信使甲",
		domain: "inbox",
		hop: 1,
	});
	assert.equal(letter.id, undefined);

	// 主人自己那条仍然可寻址、也没有 author
	assert.ok(page.messages[0]!.id);
	assert.equal(page.messages[0]!.author, undefined);
});

test("来信：结构缺了作者时退回正文前缀（仍不给 id）", async () => {
	const at = noonOf(11, 13);
	const broken: FakeEntry = {
		id: 7,
		conversationId: 1,
		kind: "relay.message",
		model: [
			{
				role: "user",
				content: "[relay hop=1][来自执事 信使丙（日程）] 帮我看下周三",
				timestamp: at,
			},
		],
	};
	const page = await readTranscriptPage(fakeChat([broken]), { limit: 5 });
	const letter = page.messages[0]!;
	assert.equal(letter.text, "帮我看下周三");
	assert.equal(letter.author?.name, "信使丙");
	assert.equal(letter.author?.domain, "日程");
	assert.equal(letter.author?.id, "");
	assert.equal(letter.id, undefined);
});
