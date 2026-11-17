import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Hono } from "hono";
import { inactiveReason, mountPhoneWorker, phoneEnsureActive } from "./phone-worker.ts";
import { phoneTransport } from "../../../packages/chancellor/src/employee/phone.ts";
import type { PhoneTask } from "../../../packages/chancellor/src/employee/phone.ts";

/**
 * 手机 worker 执行前重验（2026-11-10 批 26 §一）。
 *
 * 断言的全部是"服务端交出去 / 收回来"两个动作：取消 / 超时 / 重复认领的单不再下发，
 * 取消之后交回的结果不写回。手机侧真跑不在本仓，边界写在变更记录里。
 */

function app(): Hono {
	return (() => {
		const instance = new Hono();
		mountPhoneWorker(instance);
		return instance;
	})();
}

function task(taskId: string, budgetMs = 5_000): PhoneTask {
	return { taskId, goal: "把探针跑完", doneWhen: "result.md 里说清", budgetMs };
}

async function poll(instance: Hono, timeoutS = 1): Promise<Response> {
	return instance.request("/api/v1/worker/poll", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ timeoutS }),
	});
}

async function result(
	instance: Hono,
	taskId: string,
	summary = "干完了",
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await instance.request("/api/v1/worker/result", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ taskId, status: "done", summary }),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("判定口径：abort 优先于超时；两者都无才是活的", () => {
	const controller = new AbortController();
	const live = { deadlineAt: Date.now() + 10_000, signal: controller.signal };
	assert.equal(inactiveReason(live), null);

	controller.abort();
	assert.equal(inactiveReason(live), "canceled");
	assert.equal(
		inactiveReason({ deadlineAt: Date.now() - 1, signal: controller.signal }),
		"canceled",
	);
	assert.equal(inactiveReason({ deadlineAt: Date.now() - 1 }), "expired");
});

test("开关缺省开；false / 0 / off 才关", () => {
	assert.equal(phoneEnsureActive({}), true);
	assert.equal(phoneEnsureActive({ PHONE_ENSURE_ACTIVE: "true" }), true);
	for (const value of ["false", "0", "OFF"]) {
		assert.equal(phoneEnsureActive({ PHONE_ENSURE_ACTIVE: value }), false);
	}
});

test("取消后不发出：已 abort 的单不再交给 poll", async () => {
	const instance = app();
	const controller = new AbortController();
	const pending = phoneTransport().dispatch(task("T-cancel-send"), controller.signal);
	pending.catch(() => {});
	controller.abort();

	await assert.rejects(pending);
	const response = await poll(instance);
	assert.equal(response.status, 204, "取消的单不该被任何 poll 领走");
});

test("超时后不发出：预算到期的单不再交给 poll", async () => {
	const instance = app();
	const pending = phoneTransport().dispatch(task("T-expire-send", 20));
	pending.catch(() => {});
	await assert.rejects(pending);

	const response = await poll(instance);
	assert.equal(response.status, 204, "过期单不该被交付");
});

test("已认领不重复发：同一张单只交付一次", async () => {
	const instance = app();
	const controller = new AbortController();
	const pending = phoneTransport().dispatch(task("T-once"), controller.signal);
	pending.catch(() => {});

	const first = await poll(instance);
	assert.equal(first.status, 200);
	const delivered = (await first.json()) as PhoneTask;
	assert.equal(delivered.taskId, "T-once");

	const second = await poll(instance);
	assert.equal(second.status, 204, "认领过的单不能第二次下发");
	controller.abort();
	await assert.rejects(pending);
});

test("取消后结果被丢弃：不写回，只回 applied:false", async () => {
	const instance = app();
	const controller = new AbortController();
	const pending = phoneTransport().dispatch(task("T-cancel-result"), controller.signal);
	pending.catch(() => {});

	const delivered = (await (await poll(instance)).json()) as PhoneTask;
	assert.equal(delivered.taskId, "T-cancel-result");

	controller.abort();
	await assert.rejects(pending);

	const applied = await result(instance, "T-cancel-result", "这句不该写进 result.md");
	assert.equal(applied.status, 200);
	assert.equal(applied.body["applied"], false);
	assert.equal(applied.body["reason"], "canceled");
});

test("开关旁路：PHONE_ENSURE_ACTIVE=false 回到今天形态（迟到结果按未知单 404）", async () => {
	const instance = app();
	const saved = process.env.PHONE_ENSURE_ACTIVE;
	process.env.PHONE_ENSURE_ACTIVE = "false";
	try {
		const controller = new AbortController();
		const pending = phoneTransport().dispatch(task("T-switch-off"), controller.signal);
		pending.catch(() => {});
		await poll(instance);
		controller.abort();
		await assert.rejects(pending);

		const applied = await result(instance, "T-switch-off");
		assert.equal(applied.status, 404);
	} finally {
		if (saved === undefined) delete process.env.PHONE_ENSURE_ACTIVE;
		else process.env.PHONE_ENSURE_ACTIVE = saved;
	}
});

test("同 taskId 重派：旧单超时收尾不连坐新单", async () => {
	const instance = app();
	const first = new AbortController();
	const old = phoneTransport().dispatch(task("T-dup", 20), first.signal);
	old.catch(() => {});
	const second = new AbortController();
	const fresh = phoneTransport().dispatch(task("T-dup", 5_000), second.signal);
	fresh.catch(() => {});

	await assert.rejects(old);
	await sleep(30);

	const delivered = (await (await poll(instance)).json()) as PhoneTask;
	assert.equal(delivered.taskId, "T-dup", "新单必须还能交付");

	second.abort();
	await assert.rejects(fresh);
});
