import assert from "node:assert/strict";
import { test } from "node:test";
import { planBranchCopy } from "./branch-copy.ts";

/** 合成一条 pi 消息（contentText 只认 model[].content 里的 text 块） */
function msg(role: string, text: string, usage?: Record<string, unknown>) {
	return {
		role,
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		timestamp: 1700000000000,
		...(usage ? { usage } : {}),
	};
}

const usage = {
	input: 12,
	output: 9,
	cacheRead: 3,
	cacheWrite: 1,
	totalTokens: 25,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

function entries() {
	return [
		{ id: 1, kind: "pi.user", model: [msg("user", "第一问")] },
		{ id: 2, kind: "pi.assistant", model: [msg("assistant", "第一答", usage)] },
		{ id: 3, kind: "pi.tool-result", data: { name: "read", ok: true }, model: [] },
		{ id: 4, kind: "pi.compaction", head: 1, data: { summary: "压缩摘要" } },
		{ id: 5, kind: "pi.user", model: [msg("user", "第二问")] },
		{ id: 6, kind: "pi.assistant", model: [msg("assistant", "第二答", usage)] },
	];
}

test("分叉点在 assistant：复制 0..target 全部条目，usage 全 0，headIndex 指向复制下标", () => {
	const result = planBranchCopy(entries(), 1);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.plan.count, 2);
	assert.deepEqual(
		result.plan.entries.map((entry) => entry.kind),
		["pi.user", "pi.assistant"],
	);
	// 源第 2 条（assistant）的 usage 被清零；用户那条没有 usage，不补。
	const assistant = result.plan.entries[1].model as Array<Record<string, any>>;
	assert.equal(assistant[0].usage.input, 0);
	assert.equal(assistant[0].usage.output, 0);
	assert.equal(assistant[0].usage.cacheRead, 0);
	assert.equal(assistant[0].usage.cacheWrite, 0);
	assert.equal(assistant[0].usage.totalTokens, 0);
	assert.equal(assistant[0].usage.cost.total, 0);
	assert.equal(assistant[0].usage.cost.input, 0);
	assert.equal((result.plan.entries[0].model as Array<Record<string, any>>)[0].usage, undefined);
	assert.deepEqual(result.plan.headRemaps, []);
});

test("compaction 的 head 重映射到复制下标；head 不在范围则丢弃并计数", () => {
	// 分叉点取第二条 assistant（下标 5），这样前面的 compaction（下标 3）也在复制范围里。
	const withCompaction = planBranchCopy(entries(), 5);
	assert.equal(withCompaction.ok, true);
	if (!withCompaction.ok) return;
	assert.equal(withCompaction.plan.count, 6);
	assert.deepEqual(withCompaction.plan.headRemaps, [{ entryIndex: 3, headIndex: 0 }]);
	assert.equal(withCompaction.plan.entries[3].head, undefined); // 旧 head 已摘掉，等调用方回填

	const orphan = entries();
	orphan[3] = { id: 4, kind: "pi.compaction", head: 999, data: { summary: "" } };
	const dropped = planBranchCopy(orphan, 5);
	assert.equal(dropped.ok, true);
	if (!dropped.ok) return;
	assert.equal(dropped.plan.count, 5);
	assert.equal(dropped.plan.droppedCompaction, 1);
});

test("分叉点不是 assistant / assistant 正文为空 → 对应 reason", () => {
	const notAssistant = planBranchCopy(entries(), 0);
	assert.deepEqual(
		notAssistant.ok ? null : { reason: notAssistant.reason },
		{ reason: "not_assistant" },
	);
	const empty = entries();
	empty[1] = { id: 2, kind: "pi.assistant", model: [msg("assistant", "   ")] };
	const emptyResult = planBranchCopy(empty, 1);
	assert.deepEqual(emptyResult.ok ? null : { reason: emptyResult.reason }, { reason: "empty" });
});

test("未知 kind 原样复制", () => {
	const odd = [
		{ id: 1, kind: "pi.user", model: [msg("user", "第一问")] },
		{ id: 2, kind: "x.custom-note", data: { hello: "world" } },
		{ id: 3, kind: "pi.assistant", model: [msg("assistant", "回答")] },
	];
	const result = planBranchCopy(odd, 2);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.plan.entries[1].kind, "x.custom-note");
	assert.deepEqual(result.plan.entries[1].data, { hello: "world" });
});

test("超过 400 条 → too_large，不悄悄截断", () => {
	const many = Array.from({ length: 402 }, (_, i) => ({
		id: i + 1,
		kind: i === 400 ? "pi.assistant" : "pi.user",
		model: [msg(i === 400 ? "assistant" : "user", i === 400 ? "分叉点" : "随便")],
	}));
	// 复制 0..400 = 401 条 > 400 上限
	const result = planBranchCopy(many, 400);
	assert.deepEqual(result.ok ? null : { reason: result.reason }, { reason: "too_large" });
});

test("真实 compaction 的前向 head：展平成普通摘要，不记 headRemaps", () => {
	// 内核里 compaction 的 head = first kept entry（在 compaction 之后），是前向引用。
	const forward = [
		{ id: 1, kind: "pi.user", model: [msg("user", "很久以前的一问")] },
		{ id: 2, kind: "pi.compaction", head: 3, data: { summary: "压缩摘要" }, model: [msg("user", "压缩摘要")] },
		{ id: 3, kind: "pi.assistant", model: [msg("assistant", "分叉点回答")] },
	];
	const result = planBranchCopy(forward, 2);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.plan.entries[1].head, undefined);
	assert.deepEqual(result.plan.headRemaps, []);
	assert.equal(result.plan.flattenedCompaction, 1);
	assert.equal(result.plan.droppedCompaction, 0);
});

test("edits[].target 重映射到复制下标，并暂时摘掉 target", () => {
	const withEdits = [
		{ id: 1, kind: "pi.user", model: [msg("user", "原问题")] },
		{
			id: 2,
			kind: "pi.assistant",
			model: [msg("assistant", "回答")],
			edits: [{ target: 1, action: "replace", messages: [msg("user", "改写后的问题")] }],
		},
	];
	const result = planBranchCopy(withEdits, 1);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.plan.editRemaps, [{ entryIndex: 1, editIndex: 0, targetIndex: 0 }]);
	const edits = result.plan.entries[1].edits as Array<Record<string, unknown>>;
	assert.equal(edits.length, 1);
	assert.equal(edits[0].target, undefined);
	assert.equal(edits[0].action, "replace");
});

test("edits 目标不在复制范围：丢掉该条 edit，不留下空 edits", () => {
	const orphanEdit = [
		{ id: 1, kind: "pi.user", model: [msg("user", "原问题")] },
		{
			id: 2,
			kind: "pi.assistant",
			model: [msg("assistant", "回答")],
			edits: [{ target: 999, action: "omit" }],
		},
	];
	const result = planBranchCopy(orphanEdit, 1);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.plan.editRemaps, []);
	assert.equal(result.plan.entries[1].edits, undefined);
});
