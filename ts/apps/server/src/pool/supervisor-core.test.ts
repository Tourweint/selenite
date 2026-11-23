import assert from "node:assert/strict";
import { test } from "node:test";
import {
	backoffDelayMs,
	DEFAULT_SUPERVISOR_CONFIG,
	parseReadyLine,
	pickIdleSlot,
	recycleReason,
	runTimeoutReason,
	slotOfTicket,
	type SlotState,
} from "./supervisor-core.ts";

const CONFIG = DEFAULT_SUPERVISOR_CONFIG;

function slot(over: Partial<SlotState> = {}): SlotState {
	return {
		index: 0,
		pid: 100,
		port: 50000,
		finishedTickets: 0,
		rssMb: 200,
		ticketId: null,
		lastSeenAt: 1_000,
		...over,
	};
}

test("parseReadyLine：标准 ready 行", () => {
	assert.deepEqual(parseReadyLine("[pool] ready port=51234 index=0"), { port: 51234, index: 0 });
	// 前后空白允许
	assert.deepEqual(parseReadyLine("  [pool] ready port=8080 index=3  "), { port: 8080, index: 3 });
});

test("parseReadyLine：普通日志 / 端口越界 / 半行都返回 null", () => {
	assert.equal(parseReadyLine("普通日志"), null);
	assert.equal(parseReadyLine(""), null);
	assert.equal(parseReadyLine("[pool] listening"), null);
	assert.equal(parseReadyLine("[pool] ready port=0 index=0"), null);
	assert.equal(parseReadyLine("[pool] ready port=65536 index=0"), null);
	assert.equal(parseReadyLine("[pool] ready port=51234 index=65536"), null);
	assert.equal(parseReadyLine("[pool] ready port=51234"), null);
	assert.equal(parseReadyLine("x [pool] ready port=51234 index=0"), null);
});

test("backoffDelayMs：第 1/2/3 次为 1000/2000/4000", () => {
	assert.equal(backoffDelayMs(CONFIG, 1), 1000);
	assert.equal(backoffDelayMs(CONFIG, 2), 2000);
	assert.equal(backoffDelayMs(CONFIG, 3), 4000);
});

test("backoffDelayMs：增长封顶 30000，巨大 n 不溢出", () => {
	assert.equal(backoffDelayMs(CONFIG, 10), 30_000);
	assert.equal(backoffDelayMs(CONFIG, 1000), 30_000);
	assert.equal(backoffDelayMs(CONFIG, Number.MAX_SAFE_INTEGER), 30_000);
});

test("backoffDelayMs：n<=0 按第 1 次算", () => {
	assert.equal(backoffDelayMs(CONFIG, 0), 1000);
	assert.equal(backoffDelayMs(CONFIG, -5), 1000);
});

test("pickIdleSlot：跳过绑着票的槽位", () => {
	const slots = [slot({ index: 0, ticketId: "t-1" }), slot({ index: 1 })];
	assert.equal(pickIdleSlot(slots, CONFIG)?.index, 1);
	assert.equal(pickIdleSlot([slot({ ticketId: "t-1" })], CONFIG), null);
});

test("pickIdleSlot：跳过没 ready 的槽位（pid 或 port 为 null）", () => {
	const slots = [
		slot({ index: 0, pid: null }),
		slot({ index: 1, port: null }),
		slot({ index: 2 }),
	];
	assert.equal(pickIdleSlot(slots, CONFIG)?.index, 2);
	assert.equal(pickIdleSlot([slot({ pid: null }), slot({ index: 1, port: null })], CONFIG), null);
});

test("pickIdleSlot：跳过 RSS 超限的槽位，没探过（null）算可用", () => {
	const slots = [
		slot({ index: 0, rssMb: 1500 }),
		slot({ index: 1, rssMb: 2000 }),
		slot({ index: 2, rssMb: null }),
		slot({ index: 3, rssMb: 1499 }),
	];
	assert.equal(pickIdleSlot(slots, CONFIG)?.index, 2);
	assert.equal(pickIdleSlot([slot({ rssMb: 1500 })], CONFIG), null);
});

test("pickIdleSlot：按 index 升序取第一个，不依赖数组顺序", () => {
	const slots = [
		slot({ index: 3 }),
		slot({ index: 1 }),
		slot({ index: 2 }),
	];
	assert.equal(pickIdleSlot(slots, CONFIG)?.index, 1);
});

test("recycleReason：跑满 20 票回收", () => {
	const now = 2_000;
	assert.equal(recycleReason(slot({ finishedTickets: 20, lastSeenAt: now }), CONFIG, now), "tickets");
	assert.equal(recycleReason(slot({ finishedTickets: 19, lastSeenAt: now }), CONFIG, now), null);
});

test("recycleReason：跑票中不因票数 / RSS 回收，但心跳超时仍回收", () => {
	const now = 1_000_000;
	const running = slot({
		ticketId: "t-1",
		finishedTickets: 99,
		rssMb: 9999,
		lastSeenAt: now,
	});
	assert.equal(recycleReason(running, CONFIG, now), null);
	// 同一边界：卡死立刻处理
	const stuck = slot({ ...running, lastSeenAt: now - CONFIG.heartbeatTimeoutMs - 1 });
	assert.equal(recycleReason(stuck, CONFIG, now), "heartbeat");
});

test("recycleReason：心跳未超时返回 null（等于阈值也不算超）", () => {
	const now = 1_000_000;
	assert.equal(recycleReason(slot({ lastSeenAt: now - 1000 }), CONFIG, now), null);
	assert.equal(
		recycleReason(slot({ lastSeenAt: now - CONFIG.heartbeatTimeoutMs }), CONFIG, now),
		null,
	);
	// 没探过（0）不算超时
	assert.equal(recycleReason(slot({ lastSeenAt: 0 }), CONFIG, now), null);
});

test("recycleReason：RSS 到阈值回收", () => {
	const now = 2_000;
	assert.equal(recycleReason(slot({ rssMb: 1500, lastSeenAt: now }), CONFIG, now), "rss");
	assert.equal(recycleReason(slot({ rssMb: 1499, lastSeenAt: now }), CONFIG, now), null);
});

test("slotOfTicket：命中 / 不命中", () => {
	const slots = [slot({ index: 0, ticketId: "t-1" }), slot({ index: 1, ticketId: "t-2" })];
	assert.equal(slotOfTicket(slots, "t-2")?.index, 1);
	assert.equal(slotOfTicket(slots, "t-404"), null);
	assert.equal(slotOfTicket([], "t-1"), null);
});

test("runTimeoutReason：静默到空闲上限报 idle", () => {
	const args = { startedAt: 1_000, lastActivityAt: 2_000, idleMs: 10_000, maxMs: 60_000 };
	assert.equal(runTimeoutReason({ ...args, now: 11_999 }), null);
	assert.equal(runTimeoutReason({ ...args, now: 12_000 }), "idle");
});

test("runTimeoutReason：持续有活动时 idle 不到期，总时长到上限报 max", () => {
	const args = { startedAt: 1_000, idleMs: 10_000, maxMs: 60_000 };
	// 每次检查都有活动（lastActivityAt 紧跟 now）
	assert.equal(runTimeoutReason({ ...args, lastActivityAt: 60_999, now: 60_999 }), null);
	assert.equal(runTimeoutReason({ ...args, lastActivityAt: 61_000, now: 61_000 }), "max");
});

test("runTimeoutReason：0 / 负数 = 该项不限", () => {
	const now = 10_000_000;
	assert.equal(
		runTimeoutReason({ startedAt: 0, lastActivityAt: 0, now, idleMs: 0, maxMs: 0 }),
		null,
	);
	assert.equal(
		runTimeoutReason({ startedAt: 0, lastActivityAt: 0, now, idleMs: -1, maxMs: -1 }),
		null,
	);
	// 只关掉一项时，另一项照生效
	assert.equal(
		runTimeoutReason({ startedAt: now, lastActivityAt: 0, now, idleMs: 0, maxMs: 5_000 }),
		null,
	);
	assert.equal(
		runTimeoutReason({ startedAt: 0, lastActivityAt: 0, now, idleMs: 5_000, maxMs: 0 }),
		"idle",
	);
});

test("runTimeoutReason：两个上限都到点时按先到期的那项报", () => {
	// 静默 12 分钟：idle（10 分钟）比 max（60 分钟）先到。
	assert.equal(
		runTimeoutReason({
			startedAt: 0,
			lastActivityAt: 0,
			now: 12 * 60_000,
			idleMs: 10 * 60_000,
			maxMs: 60 * 60_000,
		}),
		"idle",
	);
	// max 更短且先到（idle 尚未到期）时报 max。
	assert.equal(
		runTimeoutReason({
			startedAt: 0,
			lastActivityAt: 900,
			now: 1_000,
			idleMs: 10_000,
			maxMs: 1_000,
		}),
		"max",
	);
});