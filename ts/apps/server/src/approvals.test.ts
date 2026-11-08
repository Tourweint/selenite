import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalStore } from "./approvals.ts";

/**
 * 审批 store（2026-11-04 批次二；2026-11-08 扫尾批 8c 改等待态与放行清单）：
 * 幂等、覆盖重置、启动保留 pending、会话级结算、一次性放行核销。
 * 全部用临时目录里的小文件，不碰 .data/approvals.json。
 */

function tempStore(): { store: ApprovalStore; path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-approval-"));
	const path = join(dir, "approvals.json");
	return { store: new ApprovalStore({ path }), path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function create(
	store: ApprovalStore,
	callId: string,
	conversationId = 1,
	tool = "bash",
	argsHash = "hash-bash-sleep2",
) {
	return store.create({
		callId,
		conversationId,
		tool,
		args: '{\n  "command": "sleep 2"\n}',
		argsHash,
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

test("load：缺省保留遗留 pending（等待态落库，可答），已决记录原样读回", () => {
	const { store, path, cleanup } = tempStore();
	try {
		create(store, "left-pending");
		const decided = create(store, "decided");
		store.decide("decided", "reject");

		const reopened = new ApprovalStore({ path });
		reopened.load();
		assert.equal(reopened.pendingOf(1).length, 1, "遗留 pending 不再被置 timeout");
		assert.equal(reopened.decide("left-pending", "approve")?.status, "approved", "重启后仍可答");
		assert.equal(reopened.decide("decided", "approve")?.status, "rejected");
	} finally {
		cleanup();
	}
});

test("load：blocking 回滚形态才把遗留 pending 置 timeout（fail-closed）", () => {
	const { store, path, cleanup } = tempStore();
	try {
		create(store, "left-pending");
		create(store, "live", 2);

		const reopened = new ApprovalStore({ path });
		reopened.load({ expireLeftover: true });
		assert.equal(reopened.pendingOf(1).length, 0);
		assert.equal(reopened.decide("left-pending", "approve")?.status, "timeout");
	} finally {
		cleanup();
	}
});

test("load：expireLeftover 粘性——先隐式 load 过，之后显式传入仍结算遗留（不碰本进程新 pending）", () => {
	const { store, path, cleanup } = tempStore();
	try {
		create(store, "left-pending");
		const reopened = new ApprovalStore({ path });
		reopened.pendingOf(1); // 隐式 load（默认不结算）

		create(reopened, "live", 2); // 本进程新建的 pending
		reopened.load({ expireLeftover: true });

		assert.equal(reopened.decide("left-pending", "approve")?.status, "timeout", "遗留被结算");
		assert.equal(reopened.pendingOf(2).length, 1, "本进程的活等待不受影响");
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

// E2 #0：投影从 ApprovalRecord.origin 透出，这里先把「事实源的字段」钉死。
test("origin：自主轮标记从 create 透到 pendingOf / pendingAll；普通轮不带键", () => {
	const { store, cleanup } = tempStore();
	try {
		const plain = create(store, "plain", 1);
		assert.equal(plain.record.origin, undefined, "普通轮记录不带 origin");

		const autonomous = store.create({
			callId: "auto-1",
			conversationId: 1,
			tool: "bash",
			args: "{}",
			timeoutMs: 60_000,
			origin: "autonomous",
		});
		assert.equal(autonomous.record.origin, "autonomous");
		assert.equal(
			store.pendingOf(1).find((record) => record.callId === "auto-1")?.origin,
			"autonomous",
		);
		assert.equal(
			store.pendingAll().find((record) => record.callId === "auto-1")?.origin,
			"autonomous",
		);
		// 同一会话里普通轮仍是 undefined，投影据此「undefined 不带键」
		assert.equal(
			store.pendingOf(1).find((record) => record.callId === "plain")?.origin,
			undefined,
		);
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

// ── 一次性放行清单（2026-11-08 扫尾批 8c）───────────────

test("放行：批准记一条，核销一次即删（幂等：第二次不命中）", () => {
	const { store, cleanup } = tempStore();
	try {
		create(store, "a", 7);
		assert.equal(store.grantCount(7), 0, "批准前没有放行");
		store.decide("a", "approve");
		assert.equal(store.grantCount(7), 1, "批准后记一条");

		assert.equal(store.consumeGrant(7, "bash", "hash-bash-sleep2"), true, "同参命中");
		assert.equal(store.grantCount(7), 0, "核销即删");
		assert.equal(store.consumeGrant(7, "bash", "hash-bash-sleep2"), false, "再核销不命中");
	} finally {
		cleanup();
	}
});

test("放行：换参数 / 换工具 / 换会话都不命中（批了 A 不能执行 B）", () => {
	const { store, cleanup } = tempStore();
	try {
		create(store, "a", 7);
		store.decide("a", "approve");

		assert.equal(store.consumeGrant(7, "bash", "另一个哈希"), false, "换参数不命中");
		assert.equal(store.consumeGrant(7, "write", "hash-bash-sleep2"), false, "换工具不命中");
		assert.equal(store.consumeGrant(8, "bash", "hash-bash-sleep2"), false, "换会话不命中");
		// 这几次不命中都不该把原来那条吃掉
		assert.equal(store.grantCount(7), 1, "不命中不消耗");
		assert.equal(store.consumeGrant(7, "bash", "hash-bash-sleep2"), true, "原参数仍可核销");
	} finally {
		cleanup();
	}
});

test("放行：拒绝不记；重复答复（幂等）不会多记一条", () => {
	const { store, cleanup } = tempStore();
	try {
		create(store, "r", 1);
		store.decide("r", "reject");
		assert.equal(store.grantCount(1), 0, "拒绝不放行");

		create(store, "a", 2);
		store.decide("a", "approve");
		store.decide("a", "approve");
		assert.equal(store.grantCount(2), 1, "幂等重发只有一条");
	} finally {
		cleanup();
	}
});

test("放行：没有参数指纹的老记录不给放行（宁可重新问一次）", () => {
	const { store, cleanup } = tempStore();
	try {
		store.create({ callId: "old", conversationId: 1, tool: "bash", args: "{}", timeoutMs: 60_000 });
		store.decide("old", "approve");
		assert.equal(store.grantCount(1), 0);
		assert.equal(store.consumeGrant(1, "bash", ""), false, "空指纹永不命中");
	} finally {
		cleanup();
	}
});

test("放行：/stop 的会话级结算清掉该会话全部放行（停止 = 撤销）", () => {
	const { store, cleanup } = tempStore();
	try {
		create(store, "a", 7);
		create(store, "b", 7, "write", "hash-write");
		store.decide("a", "approve");
		store.decide("b", "approve");
		create(store, "c", 8);
		store.decide("c", "approve");

		store.expireAll(7, "aborted");
		assert.equal(store.grantCount(7), 0, "该会话的放行清空");
		assert.equal(store.grantCount(8), 1, "别的会话不受影响");
	} finally {
		cleanup();
	}
});

test("放行：落盘可跨重启（重启后仍能核销一次）", () => {
	const { store, path, cleanup } = tempStore();
	try {
		create(store, "a", 7);
		store.decide("a", "approve");

		const reopened = new ApprovalStore({ path });
		reopened.load();
		assert.equal(reopened.grantCount(7), 1, "重启后放行还在");
		assert.equal(reopened.consumeGrant(7, "bash", "hash-bash-sleep2"), true);
	} finally {
		cleanup();
	}
});

test("放行：超过 24h 的条目在 load 时被丢弃（清单不会无限长）", () => {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-approval-grant-"));
	const path = join(dir, "approvals.json");
	try {
		const old = Date.now() - 2 * 86_400_000;
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				approvals: [],
				grants: [
					{
						callId: "stale",
						conversationId: 1,
						tool: "bash",
						argsHash: "old-hash",
						grantedAt: old,
					},
					{
						callId: "fresh",
						conversationId: 1,
						tool: "bash",
						argsHash: "fresh-hash",
						grantedAt: Date.now(),
					},
				],
			}),
		);
		const store = new ApprovalStore({ path });
		store.load();
		assert.equal(store.grantCount(1), 1, "只剩新鲜的");
		assert.equal(store.consumeGrant(1, "bash", "old-hash"), false);
		assert.equal(store.consumeGrant(1, "bash", "fresh-hash"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pending 去重：同会话 + 同工具 + 同指纹能查到；换指纹查不到", () => {
	const { store, cleanup } = tempStore();
	try {
		create(store, "a", 5, "bash", "h1");
		assert.equal(store.findPending(5, "bash", "h1")?.callId, "a");
		assert.equal(store.findPending(5, "bash", "h2"), undefined);
		assert.equal(store.findPending(6, "bash", "h1"), undefined);
	} finally {
		cleanup();
	}
});
