import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChancellor, type ChancellorEvent } from "../../../packages/chancellor/src/index.ts";
import {
	acquireAdmission,
	admissionSnapshot,
	resetAdmissionForTest,
	type AdmissionLease,
} from "../../../packages/chancellor/src/admission.ts";
import { priorityOfRunSource, type RunSource } from "./run-source.ts";

/**
 * ticket 准入闸 + 优先级（2026-11-22 调度层合并方案 M1b）。
 *
 * 闸门状态与 env 都是进程级的：每条测试自己保存 / 还原 env，
 * 并在 finally 里 resetAdmissionForTest()，避免上一条的排队者影响下一条。
 */

type SavedEnv = Array<[string, string | undefined]>;

const ENV_NAMES = [
	"CHANCELLOR_SCHEDULER",
	"CHANCELLOR_MAX_ACTIVE_TICKETS",
	"CHANCELLOR_MAX_ACTIVE_PER_DOMAIN",
	"CHANCELLOR_QUEUE_MAX",
];

function saveEnv(): SavedEnv {
	return ENV_NAMES.map((name) => [name, process.env[name]]);
}

function restoreEnv(saved: SavedEnv): void {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

/** 清空本文件关心的 env，让每条测试只声明自己要用的开关。 */
function clearEnv(): void {
	for (const name of ENV_NAMES) delete process.env[name];
}

/** 等一轮事件循环：用来断言「这个 promise 还没被 resolve」。 */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("全局上限 2：第三个排队，release 后补放且 release 幂等", async () => {
	const saved = saveEnv();
	try {
		clearEnv();
		process.env.CHANCELLOR_MAX_ACTIVE_TICKETS = "2";
		// 本用例只验全局闸：领域闸设成不限，避免两个不同领域互相干扰。
		process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN = "0";
		resetAdmissionForTest();

		const first = await acquireAdmission({ domain: "a" });
		const second = await acquireAdmission({ domain: "b" });
		assert.equal(first.granted, true);
		assert.equal(second.granted, true);
		assert.deepEqual(admissionSnapshot(), {
			max: 2,
			active: 2,
			queued: 0,
			domains: { a: 1, b: 1 },
		});

		let thirdGranted = false;
		const third = acquireAdmission({ domain: "c" }).then((lease) => {
			thirdGranted = true;
			return lease;
		});
		await flush();
		assert.equal(thirdGranted, false, "全局 2 满时第三个必须排队");
		assert.deepEqual(admissionSnapshot(), {
			max: 2,
			active: 2,
			queued: 1,
			domains: { a: 1, b: 1 },
		});

		first.release();
		first.release(); // 幂等：重复释放不能多开一个名额
		const thirdLease = await third;
		assert.equal(thirdLease.granted, true);
		assert.equal(admissionSnapshot().active, 2, "补放后仍应正好 2 个 active");

		second.release();
		thirdLease.release();
		assert.deepEqual(admissionSnapshot(), { max: 2, active: 0, queued: 0 });
	} finally {
		restoreEnv(saved);
		resetAdmissionForTest();
	}
});

test("同领域 cap 1：同领域串行、异领域并行、空领域不受领域闸限制", async () => {
	const saved = saveEnv();
	try {
		clearEnv();
		// 全局不限，单独验 per-domain。
		process.env.CHANCELLOR_MAX_ACTIVE_TICKETS = "0";
		process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN = "1";
		resetAdmissionForTest();

		const shop = await acquireAdmission({ domain: "shop" });
		const blog = await acquireAdmission({ domain: "blog" });
		assert.equal(shop.granted, true);
		assert.equal(blog.granted, true, "不同领域不该互相排队");
		assert.deepEqual(admissionSnapshot().domains, { shop: 1, blog: 1 });

		let secondShopGranted = false;
		const secondShop = acquireAdmission({ domain: "shop" }).then((lease) => {
			secondShopGranted = true;
			return lease;
		});
		await flush();
		assert.equal(secondShopGranted, false, "同领域第二单必须等");
		assert.equal(admissionSnapshot().queued, 1);

		const empty = await acquireAdmission({ domain: "   " });
		assert.equal(empty.granted, true, "空领域不该被 per-domain 挡住");

		shop.release();
		const shop2 = await secondShop;
		assert.equal(shop2.granted, true, "同领域上一单释放后应补放");

		shop2.release();
		blog.release();
		empty.release();
		assert.deepEqual(admissionSnapshot(), { max: Infinity, active: 0, queued: 0 });
	} finally {
		restoreEnv(saved);
		resetAdmissionForTest();
	}
});

test("优先级：数值小的先放；同优先级 FIFO", async () => {
	const saved = saveEnv();
	try {
		clearEnv();
		process.env.CHANCELLOR_MAX_ACTIVE_TICKETS = "1";
		process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN = "0";
		resetAdmissionForTest();

		const holder = await acquireAdmission({ domain: "holder" });
		assert.equal(holder.granted, true);

		const order: string[] = [];
		const routine = acquireAdmission({ domain: "r", priority: 2 }).then((lease) => {
			order.push("routine");
			return lease;
		});
		const human = acquireAdmission({ domain: "h", priority: 0 }).then((lease) => {
			order.push("human");
			return lease;
		});
		const routine2 = acquireAdmission({ domain: "r2", priority: 2 }).then((lease) => {
			order.push("routine2");
			return lease;
		});
		await flush();
		assert.deepEqual(order, [], "容量没释放前谁都不该拿到");

		holder.release();
		const humanLease = await human;
		assert.deepEqual(order, ["human"], "human(0) 应插在 routine(2) 前面");

		humanLease.release();
		const routineLease = await routine;
		assert.deepEqual(order, ["human", "routine"], "同优先级先来先服务");

		routineLease.release();
		const routine2Lease = await routine2;
		assert.deepEqual(order, ["human", "routine", "routine2"]);

		routine2Lease.release();
		assert.deepEqual(admissionSnapshot(), { max: 1, active: 0, queued: 0 });
	} finally {
		restoreEnv(saved);
		resetAdmissionForTest();
	}
});

test("队列满：直接失败 queue_full，不排队", async () => {
	const saved = saveEnv();
	try {
		clearEnv();
		process.env.CHANCELLOR_MAX_ACTIVE_TICKETS = "1";
		process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN = "0";
		process.env.CHANCELLOR_QUEUE_MAX = "1";
		resetAdmissionForTest();

		const holder = await acquireAdmission({ domain: "holder" });
		const waiting = acquireAdmission({ domain: "w" });
		await flush();
		assert.equal(admissionSnapshot().queued, 1);

		const rejected = await acquireAdmission({ domain: "z" });
		assert.deepEqual(
			{ granted: rejected.granted, reason: rejected.reason },
			{ granted: false, reason: "queue_full" },
		);
		assert.equal(admissionSnapshot().queued, 1, "被拒的单不能进队列");

		holder.release();
		const granted = await waiting;
		assert.equal(granted.granted, true);
		granted.release();
	} finally {
		restoreEnv(saved);
		resetAdmissionForTest();
	}
});

test("排队中取消：返回 aborted，摘出队列且不占名额", async () => {
	const saved = saveEnv();
	try {
		clearEnv();
		process.env.CHANCELLOR_MAX_ACTIVE_TICKETS = "1";
		process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN = "0";
		resetAdmissionForTest();

		const holder = await acquireAdmission({ domain: "holder" });
		const controller = new AbortController();
		const waiting = acquireAdmission({ domain: "w", signal: controller.signal });
		await flush();
		assert.equal(admissionSnapshot().queued, 1);

		controller.abort();
		const denied = await waiting;
		assert.equal(denied.granted, false);
		assert.equal(denied.reason, "aborted");
		assert.deepEqual(admissionSnapshot(), {
			max: 1,
			active: 1,
			queued: 0,
			domains: { holder: 1 },
		});

		holder.release();
		const next = await acquireAdmission({ domain: "next" });
		assert.equal(next.granted, true, "被取消的等待者不能把名额一直占着");
		next.release();
		assert.deepEqual(admissionSnapshot(), { max: 1, active: 0, queued: 0 });
	} finally {
		restoreEnv(saved);
		resetAdmissionForTest();
	}
});

test("CHANCELLOR_SCHEDULER=false：准入闸直通", async () => {
	const saved = saveEnv();
	try {
		clearEnv();
		process.env.CHANCELLOR_SCHEDULER = "false";
		process.env.CHANCELLOR_MAX_ACTIVE_TICKETS = "1";
		process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN = "1";
		process.env.CHANCELLOR_QUEUE_MAX = "0";
		resetAdmissionForTest();

		const leases = [
			await acquireAdmission({ domain: "same" }),
			await acquireAdmission({ domain: "same" }),
			await acquireAdmission({ domain: "same" }),
		];
		assert.ok(
			leases.every((lease) => lease.granted),
			"关掉调度层后不该再排队 / 拒绝",
		);
		assert.equal(admissionSnapshot().queued, 0, "直通不该建出排队状态");

		for (const lease of leases) lease.release();
	} finally {
		restoreEnv(saved);
		resetAdmissionForTest();
	}
});

test("priorityOfRunSource：human 0 / device 1 / routine 2 / script 3 / test 9 / 未知 5", () => {
	assert.equal(priorityOfRunSource("human"), 0);
	assert.equal(priorityOfRunSource("device"), 1);
	assert.equal(priorityOfRunSource("routine"), 2);
	assert.equal(priorityOfRunSource("routine_self"), 2);
	assert.equal(priorityOfRunSource("script"), 3);
	assert.equal(priorityOfRunSource("test"), 9);
	assert.equal(priorityOfRunSource("nonsense" as RunSource), 5);
});

test("runChancellor：排队已满时单号同步发出，并以 failed 收尾", async () => {
	const saved = saveEnv();
	const root = mkdtempSync(join(tmpdir(), "lifediary-admission-"));
	let holder: AdmissionLease | null = null;
	try {
		clearEnv();
		process.env.CHANCELLOR_MAX_ACTIVE_TICKETS = "1";
		process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN = "0";
		// queueMax=0：被拒路径不需要真的进队列，也避免测试里留下挂起的 promise。
		process.env.CHANCELLOR_QUEUE_MAX = "0";
		resetAdmissionForTest();
		holder = await acquireAdmission({ domain: "holder" });

		const events: ChancellorEvent[] = [];
		const promise = runChancellor(
			{ requirement: "做一件小事", workRoot: root },
			{ onEvent: (event) => events.push(event) },
		);

		// 关键：runChancellor 的同步段必须已经发出带单号的 ticket 事件。
		// 宿主 startDelegation 靠「第一个 await 之前有没有单号」区分受理成功与续跑被拒；
		// 准入闸如果先 await，delegate 工具会拿到空单号（这是 M1b 的回归点）。
		assert.ok(events.length > 0, "ticket 事件必须在第一个 await 之前同步发出");
		assert.equal(events[0]?.type, "ticket");
		assert.ok(events[0]?.ticketId, "同步 ticket 事件必须带单号");

		const result = await promise;
		assert.equal(result.status, "failed");
		assert.equal(result.line, "排队已满，稍后再试");
		assert.equal(events.at(-1)?.type, "finished");

		const ticket = JSON.parse(
			readFileSync(join(root, result.ticketId, "ticket.json"), "utf8"),
		) as { status?: string; error?: string };
		assert.equal(ticket.status, "failed");
		assert.equal(ticket.error, "排队已满，稍后再试");
		assert.equal(
			existsSync(join(root, result.ticketId, "inflight.json")),
			false,
			"终态收尾必须清掉 inflight，别留下僵尸在跑",
		);
	} finally {
		holder?.release();
		restoreEnv(saved);
		resetAdmissionForTest();
		rmSync(root, { recursive: true, force: true });
	}
});
