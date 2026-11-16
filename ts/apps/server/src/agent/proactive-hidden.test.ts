import assert from "node:assert/strict";
import test from "node:test";
import { PROACTIVE_HIDDEN_MARKER } from "@lifediary/shared";
import { foldTranscriptEntries } from "./session-transcript.ts";

/**
 * 定时主动轮（2026-11-17）：带专用标记的触发指令对用户隐藏，
 * 但模型回复照常显示，且回答仍挂上步骤与 workMs。
 * 这里直接喂 durable entry 形状给 fold，不启动 durable。
 */

interface FakeEntry {
	id: number;
	kind: string;
	model?: readonly {
		role: string;
		content: unknown;
		timestamp?: number;
		durationMs?: number;
		toolCallId?: string;
		isError?: boolean;
		details?: unknown;
	}[];
}

function userEntry(id: number, text: string, at: number): FakeEntry {
	return { id, kind: "pi.user", model: [{ role: "user", content: text, timestamp: at }] };
}

function assistantEntry(id: number, text: string, at: number, durationMs = 10): FakeEntry {
	return {
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "text", text }], timestamp: at, durationMs }],
	};
}

function toolCallEntry(id: number, at: number): FakeEntry {
	return {
		id,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
				timestamp: at,
			},
		],
	};
}

function toolResultEntry(id: number, at: number): FakeEntry {
	return {
		id,
		kind: "pi.tool-result",
		model: [
			{ role: "toolResult", content: [{ type: "text", text: "ok" }], toolCallId: "call-1", timestamp: at },
		],
	};
}

function fold(entries: FakeEntry[]) {
	return foldTranscriptEntries("conv-1", entries as never);
}

test("隐藏触发：带标记的 user 指令不进历史，模型回复照常显示", () => {
	const t = 1_700_000_000_000;
	const messages = fold([
		userEntry(1, `${PROACTIVE_HIDDEN_MARKER}\n到点看看天气`, t),
		assistantEntry(2, "今天晴，25 度。", t + 100),
	]);
	assert.equal(messages.length, 1, "只剩一条助手回复");
	assert.equal(messages[0]!.role, "assistant");
	assert.equal(messages[0]!.text, "今天晴，25 度。");
});

test("真实形态：autonomous 头在标记之前，仍判为隐藏", () => {
	const t = 1_700_000_000_000;
	// runPartnerTurn 会把 autonomous 透明头拼在正文最前；标记是正文第一行，不落在整条文本的行首。
	const submitted =
		"[Scheduled run context]\nturnAuthority: autonomous\n\n" +
		`${PROACTIVE_HIDDEN_MARKER}\n到点看看天气`;
	const messages = fold([
		userEntry(1, submitted, t),
		assistantEntry(2, "今天晴，25 度。", t + 100),
	]);
	assert.equal(messages.length, 1, "autonomous 头在前也要隐藏触发消息");
	assert.equal(messages[0]!.role, "assistant");
});

test("普通 user 消息不受影响：没有标记就照常显示", () => {
	const t = 1_700_000_000_000;
	const messages = fold([
		userEntry(1, "这是我手打的话", t),
		assistantEntry(2, "好的", t + 100),
	]);
	assert.equal(messages.length, 2);
	assert.equal(messages[0]!.role, "user");
	assert.equal(messages[0]!.text, "这是我手打的话");
	assert.ok(messages[0]!.id, "真人消息仍带可编辑的 id");
});

test("隐藏触发后回答仍挂步骤与 workMs（turnStartAt 没被隐藏逻辑丢掉）", () => {
	const t = 1_700_000_000_000;
	const messages = fold([
		userEntry(1, `${PROACTIVE_HIDDEN_MARKER}\n到点看看有啥要做的`, t),
		toolCallEntry(2, t + 1_000),
		toolResultEntry(3, t + 2_000),
		assistantEntry(4, "看完了，没事。", t + 5_000, 3_000),
	]);
	const reply = messages[0]!;
	assert.equal(reply.role, "assistant");
	assert.ok(reply.steps && reply.steps.length > 0, "工具步骤仍在");
	// endedAt = timestamp + durationMs = t+5000+3000；turnStartAt = t；workMs = 8000
	assert.equal(reply.workMs, 8_000);
});

test("标记必须独立成行：夹在正文中间不算隐藏", () => {
	const t = 1_700_000_000_000;
	const messages = fold([
		userEntry(1, `开头文字 ${PROACTIVE_HIDDEN_MARKER} 后面`, t),
	]);
	assert.equal(messages.length, 1);
	assert.equal(messages[0]!.role, "user");
});
