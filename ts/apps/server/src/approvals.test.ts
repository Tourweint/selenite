import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalStore } from "./approvals.ts";

/**
 * 审批 store（2026-11-04 批次二）：幂等、覆盖重置、启动置 timeout、会话级结算。
 * 全部用临时目录里的小文件，不碰 .data/approvals.json。
 */

function tempStore(): { store: ApprovalStore; path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-approval-"));
	const path = join(dir, "approvals.json");
	return { store: new ApprovalStore({ path }), path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function create(store: ApprovalStore, callId: string, conversationId = 1, tool = "bash") {
	return store.create({
		callId,
		conversationId,
		tool,
		args: '{\n  "command": "sleep 2"\n}',
		timeoutMs: 60_000,
	});
}

test("decide：幂等，已决返回原决定、不二次 resolve", async () => {
	const { store, cleanup } = tempStore();
	try {
		const pending = create(store, "call-1");
		const first = store.decide("call-1", "approve", false);
		assert.equal(first?.status, "approved");
		assert.equal(await pending.promise, "approved");

		// 再发一次（哪怕 decision 相反）也不改状态
		const second = store.decide("call-1", "reject", false);
		assert.equal(second?.status, "approved");
		assert.equal(store.pendingOf(1).length, 0);
	} finally {
		cleanup();
	}
});

test("decide：未知 callId 返回 null", () => {
	const { store, cleanup } = tempStore();
	try {
		assert.equal(store.decide("nope", "reject"), null);
	} finally {
		cleanup();
	}
});

test("create：同 callId 的终态记录覆盖重置，旧等待方按 aborted 放走", async () => {
	const { store, cleanup } = tempStore();
	try {
		const first = create(store, "call-1");
		store.decide("call-1", "reject");
		assert.equal(await first.promise, "rejected");

		const second = create(store, "call-1");
		assert.equal(second.record.status, "pending");
		assert.equal(store.pendingOf(1).length, 1);

		const third = create(store, "call-1");
		assert.equal(await second.promise, "aborted");
		assert.equal(third.record.status, "pending");
	} finally {
		cleanup();
	}
});

test("load：遗留 pending 置 timeout（fail-closed），已决记录原样读回", () => {
	const { store, path, cleanup } = tempStore();
	try {
		create(store, "left-pending");
		const decided = create(store, "decided");
		store.decide("decided", "reject");

		const reopened = new ApprovalStore({ path });
		reopened.load();
		assert.equal(reopened.pendingOf(1).length, 0);
		assert.equal(reopened.decide("left-pending", "approve")?.status, "timeout");
		assert.equal(reopened.decide("decided", "approve")?.status, "rejected");
	} finally {
		cleanup();
	}
});

test("load：重复调用不会把本进程正在等的 pending 误判成 timeout", () => {
	const { store, cleanup } = tempStore();
	try {
		create(store, "call-1");
		store.load();
		store.load();
		assert.equal(store.pendingOf(1).length, 1);
	} finally {
		cleanup();
	}
});

test("expireAll：只结算指定会话，并按给定终态 resolve", async () => {
	const { store, cleanup } = tempStore();
	try {
		const a = create(store, "a", 7);
		const b = create(store, "b", 7);
		const other = create(store, "c", 8);

		assert.equal(store.expireAll(7, "aborted"), 2);
		assert.equal(await a.promise, "aborted");
		assert.equal(await b.promise, "aborted");
		assert.equal(store.pendingOf(8).length, 1);
		store.expireAll(8, "timeout");
		assert.equal(await other.promise, "timeout");
	} finally {
		cleanup();
	}
});

test("pendingAll：跨会话、只回 pending、按 createdAt 升序", () => {
	const { store, cleanup } = tempStore();
	try {
		create(store, "a", 1);
		create(store, "b", 2);
		create(store, "c", 1);
		store.decide("b", "reject");
		create(store, "d", 3);

		const list = store.pendingAll();
		assert.deepEqual(list.map((record) => record.callId).sort(), ["a", "c", "d"]);
		for (let index = 1; index < list.length; index += 1) {
			assert.ok(list[index]!.createdAt >= list[index - 1]!.createdAt);
		}
		// 会话过滤不能把别的会话漏掉
		assert.equal(store.pendingOf(1).length, 2);
		assert.equal(store.pendingOf(2).length, 0);
	} finally {
		cleanup();
	}
});

test("remember：只在批准时记入本会话；拒绝不记", () => {
	const { store, cleanup } = tempStore();
	try {
		create(store, "approved");
		store.decide("approved", "approve", true);
		assert.equal(store.isRemembered(1, "bash"), true);
		assert.equal(store.isRemembered(2, "bash"), false);

		create(store, "rejected", 3, "write");
		store.decide("rejected", "reject", true);
		assert.equal(store.isRemembered(3, "write"), false);
	} finally {
		cleanup();
	}
});
