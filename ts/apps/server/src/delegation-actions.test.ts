import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Ticket } from "../../../packages/chancellor/src/types.ts";
import { cancelTicketAction, forwardWorkerMessageAction } from "./delegation-actions.ts";
import { deadLetterStore } from "./delegation-jobs.ts";
import { DelegationReceipts } from "./delegation-receipts.ts";
import { abortTicket, registerTicketAbort, setPoolControl } from "./worker-control.ts";

const root = mkdtempSync(join(tmpdir(), "lifediary-actions-"));
process.env.DELEGATIONS_DB_PATH = join(root, "delegations.sqlite");
process.env.WORKER_STEER_ENABLED = "true";

after(() => {
	try {
		deadLetterStore().close();
	} catch {
		/* 没建过 / 已关 */
	}
	rmSync(root, { recursive: true, force: true });
});

function makeTicket(id: string, employee: Ticket["employee"]): Ticket {
	const now = new Date().toISOString();
	return {
		id,
		prompt: "测试任务",
		status: "dispatching",
		created_at: now,
		updated_at: now,
		employee,
		options: { dry: true, maxTasks: 8, workRoot: join(root, "runs") },
	};
}

function writeTicket(workRoot: string, ticket: Ticket): void {
	mkdirSync(join(workRoot, ticket.id), { recursive: true });
	writeFileSync(join(workRoot, ticket.id, "ticket.json"), JSON.stringify(ticket));
}

test("取消：中止注册过的票级控制器，并正常返回 canceled", () => {
	const workRoot = join(root, "runs-cancel");
	const ticket = makeTicket("T-cancel-1", "pool");
	writeTicket(workRoot, ticket);
	const receipts = new DelegationReceipts(join(root, "receipts-cancel.sqlite"));
	const controller = new AbortController();
	registerTicketAbort(ticket.id, controller);
	try {
		const result = cancelTicketAction(receipts, workRoot, ticket.id);
		assert.equal(result.status, 200);
		assert.deepEqual(result.body, { ok: true, status: "canceled" });
		assert.equal(controller.signal.aborted, true, "取消必须让这张单的 signal 中止");
		// 用过的控制器已摘除，同一票不会重复触发。
		assert.equal(abortTicket(ticket.id), false);
	} finally {
		receipts.close();
	}
});

test("取消：没有控制器（已结算 / 旧进程）也照常返回 canceled", () => {
	const workRoot = join(root, "runs-cancel-legacy");
	const ticket = makeTicket("T-cancel-2", "pool");
	writeTicket(workRoot, ticket);
	const receipts = new DelegationReceipts(join(root, "receipts-cancel-legacy.sqlite"));
	try {
		const result = cancelTicketAction(receipts, workRoot, ticket.id);
		assert.equal(result.status, 200);
		assert.deepEqual(result.body, { ok: true, status: "canceled" });
	} finally {
		receipts.close();
	}
});

test("插话：pool 票走池控制面 say", async () => {
	const workRoot = join(root, "runs-say-pool");
	const ticket = makeTicket("T-say-pool", "pool");
	writeTicket(workRoot, ticket);
	const calls: Array<{ ticketId: string; text: string; mode: string }> = [];
	setPoolControl({
		abort: async () => ({ ok: true }),
		say: async (ticketId, text, mode) => {
			calls.push({ ticketId, text, mode });
			return { ok: true };
		},
	});
	try {
		const result = await forwardWorkerMessageAction(
			workRoot,
			ticket.id,
			{ mode: "steer", text: "第 2 条换成 A" },
			null,
		);
		assert.equal(result.status, 202);
		assert.equal(result.body.ok, true);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], {
			ticketId: ticket.id,
			text: "[插话]\n第 2 条换成 A",
			mode: "steer",
		});
	} finally {
		setPoolControl(null);
	}
});

test("插话：pool 未接线时如实回 worker_not_running", async () => {
	const workRoot = join(root, "runs-say-pool-off");
	const ticket = makeTicket("T-say-pool-off", "pool");
	writeTicket(workRoot, ticket);
	setPoolControl(null);
	const result = await forwardWorkerMessageAction(
		workRoot,
		ticket.id,
		{ mode: "followUp", text: "下轮再说" },
		null,
	);
	assert.equal(result.status, 400);
	assert.equal(result.body.error, "worker_not_running");
	assert.match(String(result.body.message), /未接线/);
});

test("插话：外部 CLI 票说清没有注入口", async () => {
	const workRoot = join(root, "runs-say-cli");
	const ticket = makeTicket("T-say-cli", "claude-code");
	writeTicket(workRoot, ticket);
	const result = await forwardWorkerMessageAction(
		workRoot,
		ticket.id,
		{ mode: "steer", text: "插一句" },
		null,
	);
	assert.equal(result.status, 400);
	assert.equal(result.body.error, "worker_not_running");
	assert.equal(result.body.message, "外部 CLI 打手没有注入口");
});
