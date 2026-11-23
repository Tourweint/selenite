import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSchedulerStatus,
	collectSchedulerStatus,
	schedulerEnabledFromEnv,
	type SchedulerStatusInput,
} from "./scheduler-status.ts";

/**
 * 调度状态只读投影（2026-11-22 调度层合并方案 M2b）。
 *
 * 只验装配约定：形状、冷却 ISO、shortId、pool 缺失时结构不变、单份快照抛错兜底。
 * 闸门 / 池的真实读数不在这里测（它们各自有单测）。
 */

function inputOf(overrides: Partial<SchedulerStatusInput> = {}): SchedulerStatusInput {
	return {
		enabled: true,
		tickets: { max: 3, active: 2, queued: 1, domains: { "frontend": 1 } },
		lanes: [
			{ lane: "native", cap: 4, running: 1, queued: 2, cooldownUntil: null },
			{ lane: "claude-code", cap: 2, running: 0, queued: 0, cooldownUntil: 1_800_000_000_000 },
		],
		pool: {
			slots: [
				{
					index: 0,
					pid: 4321,
					port: 9001,
					ticketId: "0123456789abcdef",
					finishedTickets: 7,
					rssMb: 128,
				},
				{
					index: 1,
					pid: null,
					port: null,
					ticketId: null,
					finishedTickets: 0,
					rssMb: null,
				},
			],
			running: ["0123456789abcdef"],
		},
		...overrides,
	};
}

test("装配形状：ok / enabled / tickets / lanes / pool 全在，且不含多余字段", () => {
	const status = buildSchedulerStatus(inputOf());

	assert.deepEqual(status, {
		ok: true,
		enabled: true,
		tickets: { max: 3, active: 2, queued: 1, domains: { frontend: 1 } },
		lanes: [
			{ lane: "native", cap: 4, running: 1, queued: 2, cooldownUntil: null },
			{
				lane: "claude-code",
				cap: 2,
				running: 0,
				queued: 0,
				cooldownUntil: "2027-01-15T08:00:00.000Z",
			},
		],
		pool: {
			slots: [
				{
					index: 0,
					pid: 4321,
					port: 9001,
					ticketId: "01234567",
					finishedTickets: 7,
					rssMb: 128,
				},
				{
					index: 1,
					pid: null,
					port: null,
					ticketId: null,
					finishedTickets: 0,
					rssMb: null,
				},
			],
			running: ["01234567"],
		},
	});
});

test("冷却时间用 ISO；没冷却 = null；非法值也回 null", () => {
	const status = buildSchedulerStatus(
		inputOf({
			lanes: [
				{ lane: "native", cap: 4, running: 0, queued: 0, cooldownUntil: 0 },
				{ lane: "codex", cap: 2, running: 0, queued: 1, cooldownUntil: Number.NaN },
			],
		}),
	);
	assert.equal(status.lanes[0]?.cooldownUntil, "1970-01-01T00:00:00.000Z");
	assert.equal(status.lanes[1]?.cooldownUntil, null);
});

test("ticketId 只给前 8 位：pool.slots 与 pool.running 都不外泄完整票号", () => {
	const status = buildSchedulerStatus(
		inputOf({
			pool: {
				slots: [
					{
						index: 0,
						pid: 1,
						port: 2,
						ticketId: "abcdefgh-ijkl-mnop",
						finishedTickets: 1,
						rssMb: 64,
					},
				],
				running: ["abcdefgh-ijkl-mnop"],
			},
		}),
	);
	assert.equal(status.pool?.slots[0]?.ticketId, "abcdefgh");
	assert.deepEqual(status.pool?.running, ["abcdefgh"]);
	// 整份 JSON 里不应出现完整票号（shortId 只在前 8 位以内）。
	assert.equal(JSON.stringify(status).includes("abcdefgh-ijkl-mnop"), false);
});

test("pool 为 null 时结构不变：tickets / lanes 照常，pool 固定 null", () => {
	const status = buildSchedulerStatus(inputOf({ enabled: false, pool: null }));
	assert.equal(status.ok, true);
	assert.equal(status.enabled, false);
	assert.deepEqual(status.tickets, { max: 3, active: 2, queued: 1, domains: { frontend: 1 } });
	assert.equal(status.lanes.length, 2);
	assert.equal(status.pool, null);
});

test("tickets.domains 为空时不出现这个键（不冒充「有领域占用」）", () => {
	const status = buildSchedulerStatus(
		inputOf({ tickets: { max: 3, active: 0, queued: 0, domains: {} } }),
	);
	assert.deepEqual(status.tickets, { max: 3, active: 0, queued: 0 });
	assert.equal("domains" in status.tickets, false);
});

test("单份快照抛错只让该段为空 / null，其它段照常", () => {
	const status = collectSchedulerStatus({
		enabled: true,
		tickets: () => {
			throw new Error("admission boom");
		},
		lanes: () => [
			{ lane: "native", cap: 4, running: 1, queued: 0, cooldownUntil: null },
		],
		pool: () => ({
			slots: [],
			running: [],
		}),
	});
	assert.deepEqual(status.tickets, { max: 0, active: 0, queued: 0 });
	assert.deepEqual(status.lanes, [
		{ lane: "native", cap: 4, running: 1, queued: 0, cooldownUntil: null },
	]);
	assert.deepEqual(status.pool, { slots: [], running: [] });
});

test("三份快照全抛错时仍然返回 ok:true 的完整结构（端点不 500）", () => {
	const boom = () => {
		throw new Error("boom");
	};
	const status = collectSchedulerStatus({
		enabled: true,
		tickets: boom,
		lanes: boom,
		pool: boom,
	});
	assert.deepEqual(status, {
		ok: true,
		enabled: true,
		tickets: { max: 0, active: 0, queued: 0 },
		lanes: [],
		pool: null,
	});
});

test("collectSchedulerStatus 正常路径与 buildSchedulerStatus 等价", () => {
	const input = inputOf();
	const collected = collectSchedulerStatus({
		enabled: input.enabled,
		tickets: () => input.tickets,
		lanes: () => input.lanes,
		pool: () => input.pool,
	});
	assert.deepEqual(collected, buildSchedulerStatus(input));
});

test("CHANCELLOR_SCHEDULER 解析与 lane / admission 同口径", () => {
	const saved = process.env.CHANCELLOR_SCHEDULER;
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		assert.equal(schedulerEnabledFromEnv(), true);
		for (const value of ["", "true", "1", "yes", "on", "anything"]) {
			process.env.CHANCELLOR_SCHEDULER = value;
			assert.equal(schedulerEnabledFromEnv(), true, `值 ${JSON.stringify(value)} 应视为开`);
		}
		for (const value of ["false", "FALSE", "0", "no", "off", " off "]) {
			process.env.CHANCELLOR_SCHEDULER = value;
			assert.equal(schedulerEnabledFromEnv(), false, `值 ${JSON.stringify(value)} 应视为关`);
		}
	} finally {
		if (saved === undefined) delete process.env.CHANCELLOR_SCHEDULER;
		else process.env.CHANCELLOR_SCHEDULER = saved;
	}
});
