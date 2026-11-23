import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueuedRun, RunHandle, RunResult, TicketEvent } from "./run-queue.ts";
import { MAX_RETAINED_SETTLED, RunQueue } from "./run-queue.ts";

/**
 * 长度 1 队列状态机的行为规格测试。
 *
 * 时序一律靠「手动 resolve 的 promise」控制，不靠真实长等待；
 * 需要等微任务 / 下一票自动开跑的地方只等一个 `setTimeout(0)` 的 tick。
 */

function makeRun(ticketId: string): QueuedRun {
	return {
		ticketId,
		dir: `/tmp/tasks/${ticketId}`,
		workDir: "/tmp/repo",
		instruction: "do it",
		doneWhen: "done",
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function collect() {
	const events: TicketEvent[] = [];
	return { events, listener: (event: TicketEvent) => events.push(event) };
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i += 1) {
		if (predicate()) return;
		await tick();
	}
	throw new Error("waitFor 超时");
}

test("连派两票：第一票 active，第二票只在 queued（长度 1）", async () => {
	const first = deferred<RunResult>();
	const started: string[] = [];
	const queue = new RunQueue({
		runTicket: (run) => {
			started.push(run.ticketId);
			return run.ticketId === "a" ? first.promise : Promise.resolve<RunResult>({ ok: true });
		},
	});

	assert.deepEqual(queue.enqueue(makeRun("a")), { accepted: true, ticketId: "a", queued: 0 });
	assert.deepEqual(queue.enqueue(makeRun("b")), { accepted: true, ticketId: "b", queued: 1 });

	const snapshot = queue.snapshot();
	assert.equal(snapshot.activeTicket, "a");
	assert.deepEqual(snapshot.queued, ["b"]);
	assert.deepEqual(started, ["a"], "第二票不能与第一票同时开跑");
	first.resolve({ ok: true });
	await queue.idle();
});

test("第一票结束后第二票自动开跑", async () => {
	const first = deferred<RunResult>();
	const started: string[] = [];
	const queue = new RunQueue({
		runTicket: (run) => {
			started.push(run.ticketId);
			return run.ticketId === "a" ? first.promise : Promise.resolve<RunResult>({ ok: true });
		},
	});
	queue.enqueue(makeRun("a"));
	queue.enqueue(makeRun("b"));
	assert.deepEqual(started, ["a"]);

	first.resolve({ ok: true });
	await queue.idle();
	assert.deepEqual(started, ["a", "b"]);
	assert.equal(queue.snapshot().activeTicket, null);
});

test("同 ticketId 重复 enqueue → duplicate；结算后可重派", async () => {
	const first = deferred<RunResult>();
	const queue = new RunQueue({
		runTicket: () => first.promise,
	});
	assert.equal(queue.enqueue(makeRun("a")).accepted, true);
	assert.deepEqual(queue.enqueue(makeRun("a")), { accepted: false, reason: "duplicate" });

	first.resolve({ ok: true });
	await queue.idle();

	const again = queue.enqueue(makeRun("a"));
	assert.equal(again.accepted, true, "已结算的 ticketId 允许重派");
});

test("队列满（maxQueue: 1）→ queue_full", async () => {
	const first = deferred<RunResult>();
	const queue = new RunQueue({ maxQueue: 1, runTicket: () => first.promise });
	assert.equal(queue.enqueue(makeRun("a")).accepted, true);
	assert.equal(queue.enqueue(makeRun("b")).accepted, true);
	assert.deepEqual(queue.enqueue(makeRun("c")), { accepted: false, reason: "queue_full" });
	first.resolve({ ok: true });
	await queue.idle();
});

test("事件回放：subscribe 之前 emit 的事件也能收到", async () => {
	const queue = new RunQueue({
		runTicket: async (_run, handle) => {
			handle.emit({ type: "progress", message: "开工" });
			return { ok: true };
		},
	});
	queue.enqueue(makeRun("a"));
	const { events, listener } = collect();
	queue.subscribe("a", listener);
	assert.deepEqual(events[0], { type: "progress", message: "开工" }, "回放缓冲里的早期事件");
	await queue.idle();
	assert.deepEqual(events.at(-1), { type: "settled", ok: true, reason: "done" });
});

test("abort 排队中的票 → settled(aborted)，且不再开跑", async () => {
	const first = deferred<RunResult>();
	const started: string[] = [];
	const queue = new RunQueue({
		runTicket: (run) => {
			started.push(run.ticketId);
			return run.ticketId === "a" ? first.promise : Promise.resolve<RunResult>({ ok: true });
		},
	});
	queue.enqueue(makeRun("a"));
	queue.enqueue(makeRun("b"));
	const { events, listener } = collect();
	queue.subscribe("b", listener);

	assert.deepEqual(queue.abort("b"), { ok: true });
	assert.deepEqual(events, [{ type: "settled", ok: false, reason: "aborted" }]);
	assert.deepEqual(queue.snapshot().queued, []);

	first.resolve({ ok: true });
	await queue.idle();
	assert.deepEqual(started, ["a"], "被中止的排队票不能开跑");
	assert.deepEqual(queue.abort("b"), { ok: false, message: "票 b 不在跑也不在队列" });
});

test("abort 正在跑的票 → runner 的 signal 变 aborted", async () => {
	let seen: AbortSignal | undefined;
	const queue = new RunQueue({
		runTicket: (_run, handle) => {
			seen = handle.signal;
			return new Promise<RunResult>((resolve) => {
				handle.signal.addEventListener("abort", () => resolve({ ok: false, reason: "runner 自己收尾" }));
			});
		},
	});
	queue.enqueue(makeRun("a"));
	const { events, listener } = collect();
	queue.subscribe("a", listener);

	assert.deepEqual(queue.abort("a"), { ok: true });
	assert.equal(seen?.aborted, true);
	await queue.idle();
	assert.deepEqual(events.at(-1), { type: "settled", ok: false, reason: "aborted" });
});

test("runner 抛错 → settled(false)，队列继续拉下一票", async () => {
	const started: string[] = [];
	const queue = new RunQueue({
		runTicket: async (run) => {
			started.push(run.ticketId);
			if (run.ticketId === "a") throw new Error("boom");
			return { ok: true };
		},
	});
	queue.enqueue(makeRun("a"));
	queue.enqueue(makeRun("b"));
	const { events, listener } = collect();
	queue.subscribe("a", listener);

	await waitFor(() => started.length === 2);
	await queue.idle();
	assert.deepEqual(events.at(-1), { type: "settled", ok: false, reason: "boom" });
	assert.deepEqual(started, ["a", "b"]);
	assert.equal(queue.snapshot().activeTicket, null);
});

test("settled 只发一次：runner 结算后晚到的 emit 被忽略", async () => {
	let handle: RunHandle | undefined;
	const queue = new RunQueue({
		runTicket: async (_run, h) => {
			handle = h;
			return { ok: true };
		},
	});
	queue.enqueue(makeRun("a"));
	const { events, listener } = collect();
	queue.subscribe("a", listener);
	await queue.idle();

	handle!.emit({ type: "progress", message: "晚到的尾巴" });
	handle!.emit({ type: "settled", ok: false, reason: "伪造结算" });

	const settled = events.filter((event) => event.type === "settled");
	assert.equal(settled.length, 1);
	assert.deepEqual(settled[0], { type: "settled", ok: true, reason: "done" });
	assert.equal(events.some((event) => event.type === "progress"), false);
});

test("finishedTickets 只数成功结算", async () => {
	const queue = new RunQueue({
		runTicket: async (run) => {
			if (run.ticketId === "bad") throw new Error("nope");
			return { ok: true };
		},
	});
	queue.enqueue(makeRun("ok"));
	await queue.idle();
	queue.enqueue(makeRun("bad"));
	await queue.idle();
	queue.enqueue(makeRun("aborted-while-active"));
	queue.abort("aborted-while-active");
	await queue.idle();

	assert.equal(queue.snapshot().finishedTickets, 1);
});

test("say 只送到正在跑的那一票；不在跑返回 ok:false", async () => {
	const first = deferred<RunResult>();
	const heard: Array<[string, string]> = [];
	const queue = new RunQueue({
		runTicket: async (run, handle) => {
			handle.onSay((text, mode) => heard.push([text, mode]));
			return run.ticketId === "a" ? first.promise : { ok: true };
		},
	});
	queue.enqueue(makeRun("a"));
	queue.enqueue(makeRun("b"));

	assert.deepEqual(queue.say("a", "先做 X"), { ok: true });
	assert.equal(queue.say("a", "再补 Y", "followUp").ok, true);
	assert.equal(queue.say("b", "轮不到你").ok, false);
	assert.equal(queue.say("ghost", "不存在").ok, false);
	assert.deepEqual(heard, [
		["先做 X", "steer"],
		["再补 Y", "followUp"],
	]);

	first.resolve({ ok: true });
	await queue.idle();
	assert.equal(queue.say("a", "已经结束").ok, false);
});

test("事件缓冲不超过 eventBuffer 条，保留最新", async () => {
	const queue = new RunQueue({
		eventBuffer: 2,
		runTicket: async (_run, handle) => {
			handle.emit({ type: "progress", message: "1" });
			handle.emit({ type: "progress", message: "2" });
			handle.emit({ type: "progress", message: "3" });
			return { ok: true };
		},
	});
	queue.enqueue(makeRun("a"));
	await queue.idle();
	const { events, listener } = collect();
	queue.subscribe("a", listener);
	assert.deepEqual(events, [
		{ type: "progress", message: "3" },
		{ type: "settled", ok: true, reason: "done" },
	]);
});

test("已结算票缓冲有界：超过上限淘汰最老的一票", async () => {
	const queue = new RunQueue({ runTicket: async () => ({ ok: true }) });
	for (let i = 0; i < MAX_RETAINED_SETTLED + 1; i += 1) {
		const id = `t${i}`;
		queue.enqueue(makeRun(id));
		await queue.idle();
	}
	const oldest = collect();
	queue.subscribe("t0", oldest.listener);
	assert.deepEqual(oldest.events, [], "被淘汰票的回放为空");
	const late = collect();
	queue.subscribe(`t${MAX_RETAINED_SETTLED}`, late.listener);
	assert.equal(late.events.at(-1)?.type, "settled");
});