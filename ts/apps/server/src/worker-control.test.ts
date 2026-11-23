import assert from "node:assert/strict";
import { test } from "node:test";
import {
	abortTicket,
	registerTicketAbort,
	sayWorker,
	setPoolControl,
	unregisterTicketAbort,
} from "./worker-control.ts";

test("票级取消控制器：注册后可中止，摘掉后查不到", () => {
	const ticketId = "T-abort-1";
	const controller = new AbortController();
	registerTicketAbort(ticketId, controller);
	assert.equal(abortTicket(ticketId), true);
	assert.equal(controller.signal.aborted, true);
	// abortTicket 用过即摘（同一票不会重复触发）。
	assert.equal(controller.signal.aborted, true);
	assert.equal(abortTicket(ticketId), false);

	const second = new AbortController();
	registerTicketAbort("T-abort-2", second);
	unregisterTicketAbort("T-abort-2");
	assert.equal(abortTicket("T-abort-2"), false);
	assert.equal(second.signal.aborted, false, "摘掉的控制器不应被中止");
});

test("sayWorker：pool 走池控制面", async () => {
	const calls: Array<{ ticketId: string; text: string; mode: string }> = [];
	setPoolControl({
		abort: async () => ({ ok: true }),
		say: async (ticketId, text, mode) => {
			calls.push({ ticketId, text, mode });
			return { ok: true };
		},
	});
	try {
		const result = await sayWorker("pool", "T-pool-1", "[插话]\n换成 A", "steer");
		assert.deepEqual(result, { ok: true });
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], {
			ticketId: "T-pool-1",
			text: "[插话]\n换成 A",
			mode: "steer",
		});
	} finally {
		setPoolControl(null);
	}
});

test("sayWorker：pool 未接线时如实返回错误", async () => {
	setPoolControl(null);
	const result = await sayWorker("pool", "T-pool-2", "在吗", "followUp");
	assert.equal(result.ok, false);
	assert.match(result.message ?? "", /未接线/);
});

test("sayWorker：外部 CLI 没有注入口", async () => {
	for (const employee of ["claude-code", "codex", "opencode", "mcp", "phone"] as const) {
		const result = await sayWorker(employee, `T-${employee}`, "插一句", "steer");
		assert.equal(result.ok, false, `${employee} 不该被当成可注入口`);
		assert.equal(result.message, "外部 CLI 打手没有注入口");
	}
});

test("sayWorker：native 不在跑时返回 worker_not_running", async () => {
	// 没有起过 native 子进程 → forwardNativeWorkerMessage 抛 WorkerNotRunningError。
	const result = await sayWorker("native", "T-native-not-running", "插一句", "steer");
	assert.equal(result.ok, false);
	assert.match(result.message ?? "", /worker_not_running/);
});
