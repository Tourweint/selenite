import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
