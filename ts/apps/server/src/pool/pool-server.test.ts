import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hono } from "hono";
import { RunQueue, type QueuedRun, type RunHandle, type RunResult } from "./run-queue.ts";
import { createPoolServer } from "./pool-server.ts";

/**
 * HTTP 面测试：真 `RunQueue` + fake `runTicket`（手动 resolve 控时序），
 * `app.request(...)` 直接打不监听端口——不起 Node 服务器、不连模型。
 *
 * 时序关键点：`streamSSE` 的回调在 `app.request` 返回响应**之前**就同步执行到第一个
 * `await`（hono 内部 `run(stream, cb)` 立即调用），所以请求 resolve 时订阅已挂好，
 * 测试可以在之后放心 emit / finish，不会丢事件。
 */

const TOKEN = "test-token";
const AUTH = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

interface FakeRun {
	run: QueuedRun;
	handle: RunHandle;
	finish: (result?: RunResult) => void;
}

function setup(options: { maxInstructionChars?: number; maxQueue?: number; token?: string } = {}) {
	const runs: FakeRun[] = [];
	const queue = new RunQueue({
		...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
		runTicket: (run, handle) =>
			new Promise<RunResult>((resolve) => {
				runs.push({ run, handle, finish: (result) => resolve(result ?? { ok: true }) });
			}),
	});
	const server = createPoolServer({
		queue,
		token: options.token ?? TOKEN,
		poolIndex: 3,
		rssMb: () => 42,
		...(options.maxInstructionChars !== undefined ? { maxInstructionChars: options.maxInstructionChars } : {}),
	});
	return { queue, server, runs };
}

function runBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ticketId: "t1",
		dir: "D:/tasks/t1",
		workDir: "D:/repo",
		instruction: "建池进程骨架",
		doneWhen: "REPORT.md 存在且 artifacts 可读",
		...overrides,
	};
}

function postRun(app: Hono, body: unknown, headers: Record<string, string> = AUTH) {
	return app.request("/run", { method: "POST", headers, body: JSON.stringify(body) });
}

test("/health 不要 token，字段齐且来自队列快照", async () => {
	const { server, queue, runs } = setup();
	const res = await server.app.request("/health");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), {
		ok: true,
		poolIndex: 3,
		rssMb: 42,
		activeTicket: null,
		queued: [],
		finishedTickets: 0,
	});

	await postRun(server.app, runBody());
	const running = (await (await server.app.request("/health")).json()) as Record<string, unknown>;
	assert.equal(running.activeTicket, "t1");
	assert.equal(running.finishedTickets, 0);

	runs[0]!.finish();
	await queue.idle();
	const done = (await (await server.app.request("/health")).json()) as Record<string, unknown>;
	assert.equal(done.activeTicket, null);
	assert.equal(done.finishedTickets, 1);
});

test("没带 token 调 /run：403 且 body 为空", async () => {
	const { server, runs } = setup();
	const res = await server.app.request("/run", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(runBody()),
	});
	assert.equal(res.status, 403);
	assert.equal(await res.text(), "");
	assert.equal(runs.length, 0, "鉴权失败不许进队列");
});

test("带错 token：403 且 body 为空", async () => {
	const { server } = setup();
	const res = await postRun(server.app, runBody(), {
		Authorization: "Bearer wrong-token",
		"Content-Type": "application/json",
	});
	assert.equal(res.status, 403);
	assert.equal(await res.text(), "");
});

test("token 为空串 = 不校验（单测 / 本机调试形态）", async () => {
	const { server } = setup({ token: "" });
	const res = await server.app.request("/run", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(runBody()),
	});
	assert.equal(res.status, 200);
});

test("正确 token + 完整 body：200 accepted 并真的开跑", async () => {
	const { server, queue, runs } = setup();
	const res = await postRun(server.app, runBody({ upstream: "上一票的结论", model: "p/m", tools: ["read"] }));
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { accepted: true, ticketId: "t1" });
	assert.equal(queue.snapshot().activeTicket, "t1");
	assert.equal(runs.length, 1);
	assert.deepEqual(runs[0]!.run.upstream, "上一票的结论");
	assert.deepEqual(runs[0]!.run.tools, ["read"]);
	const health = (await (await server.app.request("/health")).json()) as Record<string, unknown>;
	assert.equal(health.activeTicket, "t1");
});

test("缺必填字段（没 doneWhen）：400 bad_request，且不排队", async () => {
	const { server, queue, runs } = setup();
	const body = runBody();
	delete body.doneWhen;
	const res = await postRun(server.app, body);
	assert.equal(res.status, 400);
	const json = (await res.json()) as Record<string, unknown>;
	assert.equal(json.ok, false);
	assert.equal(json.error, "bad_request");
	assert.ok(String(json.message).includes("doneWhen"));
	assert.equal(runs.length, 0);
	assert.deepEqual(queue.snapshot().queued, []);
});

test("body 不是 JSON 对象 / 必填字段是空串：400", async () => {
	const { server } = setup();
	for (const body of [null, [], "x", runBody({ ticketId: "  " }), runBody({ workDir: 42 })]) {
		const res = await postRun(server.app, body);
		assert.equal(res.status, 400, `body=${JSON.stringify(body)} 必须 400`);
	}
});

test("重复 ticketId（还在跑）→ 409 duplicate", async () => {
	const { server } = setup();
	assert.equal((await postRun(server.app, runBody())).status, 200);
	const res = await postRun(server.app, runBody());
	assert.equal(res.status, 409);
	assert.deepEqual(await res.json(), { accepted: false, error: "duplicate" });
});

test("队列满 → 429 queue_full", async () => {
	const { server, queue } = setup({ maxQueue: 1 });
	assert.equal((await postRun(server.app, runBody({ ticketId: "t1" }))).status, 200); // 在跑
	assert.equal((await postRun(server.app, runBody({ ticketId: "t2" }))).status, 200); // 占满队列
	assert.deepEqual(queue.snapshot().queued, ["t2"]);
	const res = await postRun(server.app, runBody({ ticketId: "t3" }));
	assert.equal(res.status, 429);
	assert.deepEqual(await res.json(), { accepted: false, error: "queue_full" });
});

test("/say：在跑时投递（含 mode），不在跑 / 空文本各自的拒绝口径", async () => {
	const { server, runs } = setup();
	assert.equal((await postRun(server.app, runBody())).status, 200);
	const heard: Array<[string, string]> = [];
	runs[0]!.handle.onSay((text, mode) => heard.push([text, mode]));

	const ok = await server.app.request("/run/t1/say", {
		method: "POST",
		headers: AUTH,
		body: JSON.stringify({ text: "改成 B 方案" }),
	});
	assert.equal(ok.status, 200);
	assert.deepEqual(await ok.json(), { ok: true });
	const followUp = await server.app.request("/run/t1/say", {
		method: "POST",
		headers: AUTH,
		body: JSON.stringify({ text: "再看一眼", mode: "followUp" }),
	});
	assert.equal(followUp.status, 200);
	assert.deepEqual(heard, [
		["改成 B 方案", "steer"],
		["再看一眼", "followUp"],
	]);

	const empty = await server.app.request("/run/t1/say", {
		method: "POST",
		headers: AUTH,
		body: JSON.stringify({ text: "   " }),
	});
	assert.equal(empty.status, 400);

	const missing = await server.app.request("/run/ghost/say", {
		method: "POST",
		headers: AUTH,
		body: JSON.stringify({ text: "喂" }),
	});
	assert.equal(missing.status, 409);
	const missingJson = (await missing.json()) as Record<string, unknown>;
	assert.equal(missingJson.ok, false);
	assert.ok(typeof missingJson.message === "string");
});

test("/abort：排队中的票 → 200 并出队；在跑的票发 signal；不存在的票 → 409", async () => {
	const { server, queue, runs } = setup();
	assert.equal((await postRun(server.app, runBody({ ticketId: "t1" }))).status, 200);
	assert.equal((await postRun(server.app, runBody({ ticketId: "t2" }))).status, 200);
	assert.deepEqual(queue.snapshot().queued, ["t2"]);

	const queuedAbort = await server.app.request("/run/t2/abort", { method: "POST", headers: AUTH });
	assert.equal(queuedAbort.status, 200);
	assert.deepEqual(await queuedAbort.json(), { ok: true });
	assert.deepEqual(queue.snapshot().queued, []);

	const signal = runs[0]!.handle.signal;
	assert.equal(signal.aborted, false);
	const runningAbort = await server.app.request("/run/t1/abort", { method: "POST", headers: AUTH });
	assert.equal(runningAbort.status, 200);
	assert.equal(signal.aborted, true);
	// 队列口径：abort 只发信号，结算仍等 runner 收尾
	runs[0]!.finish();
	await queue.idle();
	assert.equal(queue.snapshot().finishedTickets, 0, "被中止的票不算 finished");

	const ghost = await server.app.request("/run/ghost/abort", { method: "POST", headers: AUTH });
	assert.equal(ghost.status, 409);
});

test("/events：SSE 收到 data 帧，settled 之后流结束", { timeout: 5000 }, async () => {
	const { server, queue, runs } = setup();
	assert.equal((await postRun(server.app, runBody())).status, 200);

	const res = await server.app.request("/run/t1/events", { headers: AUTH });
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

	const textPromise = res.text();
	runs[0]!.handle.emit({ type: "progress", message: "第 1 步：读任务书" });
	runs[0]!.finish();
	const text = await textPromise;

	assert.ok(
		text.includes(`data: ${JSON.stringify({ type: "progress", message: "第 1 步：读任务书" })}\n\n`),
		`缺 progress 帧：${JSON.stringify(text)}`,
	);
	assert.ok(text.includes('"type":"settled"'), "缺 settled 帧");
	assert.ok(text.includes('"ok":true'), "settled 应报 ok:true");
	// 帧格式：只要 data:，不许用 event: 字段
	assert.ok(!text.includes("event:"), "SSE 不许带 event: 字段");
	await queue.idle();
});

test("/events：结算后才连的订阅者能从缓冲回放（不丢事件）", { timeout: 5000 }, async () => {
	const { server, queue, runs } = setup();
	assert.equal((await postRun(server.app, runBody())).status, 200);
	runs[0]!.handle.emit({ type: "progress", message: "先发的 progress" });
	runs[0]!.finish();
	await queue.idle();

	const res = await server.app.request("/run/t1/events", { headers: AUTH });
	assert.equal(res.status, 200);
	const text = await res.text();
	assert.ok(text.includes("先发的 progress"), "回放缺 progress");
	assert.ok(text.includes('"type":"settled"'), "回放缺 settled");
});

test("/events：不存在的票 → 404 普通 JSON", async () => {
	const { server } = setup();
	const res = await server.app.request("/run/ghost/events", { headers: AUTH });
	assert.equal(res.status, 404);
	assert.match(res.headers.get("content-type") ?? "", /application\/json/);
	const json = (await res.json()) as Record<string, unknown>;
	assert.equal(json.error, "not_found");
});

test("/events：没带 token → 403 空体", async () => {
	const { server } = setup();
	assert.equal((await postRun(server.app, runBody())).status, 200);
	const res = await server.app.request("/run/t1/events");
	assert.equal(res.status, 403);
	assert.equal(await res.text(), "");
});

test("instruction 超上限：400，且不被截断进队列", async () => {
	const { server, queue } = setup({ maxInstructionChars: 10 });
	const res = await postRun(server.app, runBody({ instruction: "12345678901" }));
	assert.equal(res.status, 400);
	const json = (await res.json()) as Record<string, unknown>;
	assert.equal(json.error, "bad_request");
	assert.ok(String(json.message).includes("10"));
	assert.equal(queue.snapshot().activeTicket, null);
});

test("close()：关掉活着的 SSE 流，之后的订阅直接 503", { timeout: 5000 }, async () => {
	const { server } = setup();
	assert.equal((await postRun(server.app, runBody())).status, 200);
	const res = await server.app.request("/run/t1/events", { headers: AUTH });
	assert.equal(res.status, 200);
	server.close();
	// 流被关掉 → res.text() 立刻结束（不等 settled）
	const text = await res.text();
	assert.equal(text.includes('"type":"settled"'), false);

	const later = await server.app.request("/run/t1/events", { headers: AUTH });
	assert.equal(later.status, 503);
});