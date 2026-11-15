import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DelegationMessages } from "./delegation-messages.ts";

/**
 * 派活留言存储单测（2026-11-07）。
 *
 * 为什么单独测存储而不只测 startDelegation：留言表是"任务详情能说出谁让我干这个"
 * 的唯一事实源，它的顺序、空值、超长截断都是展示契约的一部分，
 * 混在派单测试里会被派单语义盖住。
 */

function tempStore(): { store: DelegationMessages; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-msg-"));
	const store = new DelegationMessages(join(dir, "delegations.sqlite"));
	return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("追加后按顺序读回：out 在 in 前面", () => {
	const { store, cleanup } = tempStore();
	try {
		store.append({
			ticketId: "T-1",
			direction: "out",
			fromKind: "chief",
			fromName: "总管",
			body: "把按钮改成蓝色",
			createdAt: "2026-11-07T10:00:00.000Z",
		});
		store.append({
			ticketId: "T-1",
			direction: "in",
			fromKind: "system",
			fromName: "执行端",
			body: "改好了",
			createdAt: "2026-11-07T10:05:00.000Z",
		});
		const rows = store.list("T-1");
		assert.equal(rows.length, 2);
		assert.equal(rows[0]?.direction, "out");
		assert.equal(rows[0]?.fromName, "总管");
		assert.equal(rows[1]?.direction, "in");
	} finally {
		cleanup();
	}
});

test("没有记录 = 空数组，不是错误", () => {
	const { store, cleanup } = tempStore();
	try {
		assert.deepEqual(store.list("T-NOPE"), []);
	} finally {
		cleanup();
	}
});

test("不同任务单互不串台", () => {
	const { store, cleanup } = tempStore();
	try {
		for (const id of ["T-A", "T-B"]) {
			store.append({
				ticketId: id,
				direction: "out",
				fromKind: "partner",
				fromName: id,
				body: id,
				createdAt: "2026-11-07T10:00:00.000Z",
			});
		}
		assert.deepEqual(store.list("T-A").map((m) => m.body), ["T-A"]);
		assert.deepEqual(store.list("T-B").map((m) => m.body), ["T-B"]);
	} finally {
		cleanup();
	}
});

test("超长正文被截断（表不被撑爆），名字也截断", () => {
	const { store, cleanup } = tempStore();
	try {
		store.append({
			ticketId: "T-LONG",
			direction: "out",
			fromKind: "chief",
			fromName: "名".repeat(500),
			body: "文".repeat(50_000),
			createdAt: "2026-11-07T10:00:00.000Z",
		});
		const [row] = store.list("T-LONG");
		assert.ok((row?.body.length ?? 0) <= 20_000, "正文截到 20k");
		assert.ok((row?.fromName.length ?? 0) <= 120, "名字截到 120");
	} finally {
		cleanup();
	}
});

// ── 送达记账（2026-11-15 回信送达兜底，方案 §A）──────────────────

test("append 返回行 id；delivered 缺省 1，listUndelivered 只收显式 0 的 in 行", () => {
	const { store, cleanup } = tempStore();
	try {
		const outId = store.append({
			ticketId: "T-D",
			direction: "out",
			fromKind: "chief",
			fromName: "总管",
			body: "派活",
			createdAt: "2026-11-15T10:00:00.000Z",
		});
		const inId = store.append(
			{
				ticketId: "T-D",
				direction: "in",
				fromKind: "system",
				fromName: "执行端",
				body: "结论",
				createdAt: "2026-11-15T10:05:00.000Z",
			},
			{ delivered: 0 },
		);
		assert.ok(outId > 0 && inId > 0 && outId !== inId, "返回自增行 id");
		assert.deepEqual(
			store.listUndelivered().map((row) => row.id),
			[inId],
			"只有待送达的 in 行进扫描",
		);
	} finally {
		cleanup();
	}
});

test("markDelivery 销账：1/2 都算清账，out 行不受影响", () => {
	const { store, cleanup } = tempStore();
	try {
		const id = store.append(
			{
				ticketId: "T-M",
				direction: "in",
				fromKind: "system",
				fromName: "执行端",
				body: "结论",
				createdAt: "2026-11-15T10:05:00.000Z",
			},
			{ delivered: 0 },
		);
		store.markDelivery(id, 1);
		assert.deepEqual(store.listUndelivered(), [], "销账后不再扫到");
		const next = store.append(
			{
				ticketId: "T-M",
				direction: "in",
				fromKind: "system",
				fromName: "执行端",
				body: "结论二",
				createdAt: "2026-11-15T10:06:00.000Z",
			},
			{ delivered: 0 },
		);
		store.markDelivery(next, 2);
		assert.deepEqual(store.listUndelivered(), [], "跳过（2）也不再扫到");
	} finally {
		cleanup();
	}
});

test("老库迁移：没有 delivered 列的表自动补列，历史行视为已送达", () => {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-msg-old-"));
	const file = join(dir, "delegations.sqlite");
	try {
		// 手建一张"老 schema"的表（没有 delivered 列），再让新代码打开
		const legacy = new DatabaseSync(file);
		legacy.exec(
			"CREATE TABLE delegation_messages (" +
				"id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, direction TEXT NOT NULL, " +
				"from_kind TEXT NOT NULL, from_name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, " +
				"created_at TEXT NOT NULL)",
		);
		legacy
			.prepare(
				"INSERT INTO delegation_messages (ticket_id, direction, from_kind, from_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("T-OLD", "in", "system", "执行端", "老结论", "2026-11-01T00:00:00.000Z");
		legacy.close();

		const store = new DelegationMessages(file);
		try {
			assert.deepEqual(store.listUndelivered(), [], "历史行默认已送达，升级不触发批量补送");
			const id = store.append(
				{
					ticketId: "T-OLD",
					direction: "in",
					fromKind: "system",
					fromName: "执行端",
					body: "新结论",
					createdAt: "2026-11-15T11:00:00.000Z",
				},
				{ delivered: 0 },
			);
			assert.deepEqual(
				store.listUndelivered().map((row) => row.id),
				[id],
				"迁移后新行记账照常",
			);
		} finally {
			store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
