import assert from "node:assert/strict";
import { test } from "node:test";
import { AutonomyReceipts, autonomyEventId, AUTONOMY_CAP_PER_DAY } from "./autonomy-core.ts";

function clock(start = 0): () => Date {
	let tick = start;
	return () => new Date((tick += 60_000));
}

test("观察层账本：同一事件 id 只提醒一次；状态换锚（重进状态）可再提醒", () => {
	const now = clock();
	const receipts = new AutonomyReceipts({}, now);
	const event = { type: "stuck" as const, conversationId: 7, key: "1000" };
	assert.equal(autonomyEventId(event, now()), "stuck:7:1000");
	assert.equal(receipts.shouldRemind(event), true);
	receipts.record(event);
	assert.equal(receipts.shouldRemind(event), false, "同一状态锚不得重复提醒");
	// 状态消失后重进（key=新的进入时刻）→ 新 id → 可再提醒
	const reenter = { type: "stuck" as const, conversationId: 7, key: "9999" };
	assert.equal(receipts.shouldRemind(reenter), true);
});

test("观察层账本：同会话同类型 24h 内最多 6 次（第 7 次拒绝）", () => {
	const now = clock();
	const receipts = new AutonomyReceipts({}, now);
	let reminded = 0;
	for (let i = 0; i < AUTONOMY_CAP_PER_DAY + 3; i += 1) {
		const event = { type: "errored" as const, conversationId: 7, key: String(i) };
		if (receipts.shouldRemind(event)) {
			receipts.record(event);
			reminded += 1;
		}
	}
	assert.equal(reminded, AUTONOMY_CAP_PER_DAY, "超上限后 shouldRemind 必须拒绝");
	// 换类型不受牵连（上限按 类型:会话 分键）
	const other = { type: "stuck" as const, conversationId: 7, key: "1" };
	assert.equal(receipts.shouldRemind(other), true);
	// 换会话不受牵连
	const otherConv = { type: "errored" as const, conversationId: 8, key: "1" };
	assert.equal(receipts.shouldRemind(otherConv), true);
});

test("观察层账本：sweep 按 2h 时间桶分 id；24h 后可再提醒", () => {
	let t = Date.now();
	const now = () => new Date((t += 60_000));
	const receipts = new AutonomyReceipts({}, now);
	const sweep = { type: "sweep" as const, conversationId: 0, key: "" };
	const firstId = autonomyEventId(sweep, now());
	receipts.record(sweep);
	assert.equal(receipts.shouldRemind(sweep), false, "同一 2h 桶只提醒一次");
	// 拨到 3 小时后：桶变了 → 可再提醒
	t += 3 * 60 * 60_000;
	assert.equal(receipts.shouldRemind(sweep), true);
	assert.notEqual(autonomyEventId(sweep, now()), firstId);
});

test("观察层账本：序列化往返（重启恢复）", () => {
	const now = clock();
	const receipts = new AutonomyReceipts({}, now);
	const event = { type: "waiting" as const, conversationId: 3, key: "call-1" };
	receipts.record(event);
	const restored = new AutonomyReceipts(receipts.toJSON(), now);
	assert.equal(restored.shouldRemind(event), false, "重启后同一事件 id 不得再提醒");
});
