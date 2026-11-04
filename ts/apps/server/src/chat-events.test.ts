import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatEventStore, sseSeqEnabled, sseSeqKeep } from "./chat-events.ts";

/**
 * 会话事件重放库单测（2026-11-04 seq 方案）。
 * 全部跑在临时目录的独立库里，不碰 .data/。
 */

function tempStore(keep?: number): { store: ChatEventStore; close: () => void } {
	const path = join(mkdtempSync(join(tmpdir(), "chat-events-test-")), "events.sqlite");
	const store = new ChatEventStore(path, keep);
	// Windows 下 sqlite 文件被打开时 rmSync 会 EPERM：先 close 再删目录。
	return {
		store,
		close: () => {
			store.close();
			rmSync(path, { force: true });
		},
	};
}

const frame = (type: string, text = "") =>
	({ type, text }) as import("@lifediary/shared").ChatEvent;

test("开关：默认开；只有显式 off 才关", () => {
	assert.equal(sseSeqEnabled({}), true);
	assert.equal(sseSeqEnabled({ AGENT_SSE_SEQ: "" }), true);
	assert.equal(sseSeqEnabled({ AGENT_SSE_SEQ: "off" }), false);
	assert.equal(sseSeqEnabled({ AGENT_SSE_SEQ: "OFF" }), false);
	assert.equal(sseSeqEnabled({ AGENT_SSE_SEQ: "on" }), true);
});

test("窗口：默认 500；非法值回落；显式小值生效", () => {
	assert.equal(sseSeqKeep({}), 500);
	assert.equal(sseSeqKeep({ AGENT_SSE_SEQ_KEEP: "abc" }), 500);
	assert.equal(sseSeqKeep({ AGENT_SSE_SEQ_KEEP: "0" }), 500);
	assert.equal(sseSeqKeep({ AGENT_SSE_SEQ_KEEP: "-3" }), 500);
	assert.equal(sseSeqKeep({ AGENT_SSE_SEQ_KEEP: "3" }), 3);
});

test("seq 从 1 起单调递增；落库后重放按序取回", () => {
	const { store, close } = tempStore();
	try {
		assert.equal(store.nextSeq(1), 1);
		store.append(1, 1, frame("start"));
		assert.equal(store.nextSeq(1), 2);
		store.append(1, 2, frame("delta", "你"));
		store.append(1, 3, frame("delta", "好"));
		const { from, events } = store.replaySince(1, 0);
		assert.equal(from, 1);
		assert.deepEqual(events.map((x) => x.event.type), ["start", "delta", "delta"]);
	} finally {
		close();
	}
});

test("不同会话的 seq 各自独立", () => {
	const { store, close } = tempStore();
	try {
		store.append(1, 1, frame("start"));
		store.append(1, 2, frame("delta"));
		assert.equal(store.nextSeq(2), 1, "会话 2 不受会话 1 影响");
		store.append(2, 1, frame("start"));
		assert.deepEqual(store.replaySince(2, 0).events.map((x) => x.event.type), ["start"]);
		assert.equal(store.replaySince(2, 0).from, 1);
	} finally {
		close();
	}
});

test("sinceSeq 只取之后的帧；从 0 起等于全量", () => {
	const { store, close } = tempStore();
	try {
		for (let seq = 1; seq <= 5; seq++) store.append(7, seq, frame("delta", String(seq)));
		assert.deepEqual(
			store.replaySince(7, 3).events.map((x) => (x.event as { text: string }).text),
			["4", "5"],
		);
		assert.equal(store.replaySince(7, 3).from, 4);
		assert.equal(store.replaySince(7, 5).events.length, 0);
		// 超出已落库范围的 sinceSeq 也不该报错
		assert.equal(store.replaySince(7, 100).events.length, 0);
	} finally {
		close();
	}
});

test("滑窗：keep=3 时老帧被滑掉，fromSeq 如实报告窗口起点", () => {
	const { store, close } = tempStore(3);
	try {
		for (let seq = 1; seq <= 5; seq++) store.append(9, seq, frame("delta", String(seq)));
		const { from, events } = store.replaySince(9, 0);
		assert.equal(events.length, 3);
		assert.equal(from, 3, "1、2 已滑掉，窗口从 3 起");
		// 客户端判据：from > since+1 → 不能只补，要全量重建
		assert.ok(from > 0 + 1);
	} finally {
		close();
	}
});

test("窗口内没有缺口时 from = since + 1（可以放心只补）", () => {
	const { store, close } = tempStore(10);
	try {
		for (let seq = 1; seq <= 4; seq++) store.append(3, seq, frame("delta"));
		const { from } = store.replaySince(3, 2);
		assert.equal(from, 3);
		assert.ok(!(from > 2 + 1), "from > since+1 才是缺口");
	} finally {
		close();
	}
});

test("空会话 replay：from = since+1 且零事件（客户端不做重建）", () => {
	const { store, close } = tempStore();
	try {
		const { from, events } = store.replaySince(42, 7);
		assert.deepEqual(events, []);
		assert.equal(from, 8);
	} finally {
		close();
	}
});
