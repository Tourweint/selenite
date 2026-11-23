import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { allocateTicketId, intake } from "./intake.ts";
import { Store } from "./store.ts";

function tempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chancellor-intake-"));
	return path.join(dir, "runs");
}

test("预分配单号：形状合法、可被 intake 原样使用", () => {
	const workRoot = tempRoot();
	const store = new Store(workRoot);
	try {
		const id = allocateTicketId(workRoot);
		assert.match(id, /^t-\d{8}-\d{6}-[a-z0-9]{4}$/);
		const ticket = intake(
			store,
			"干一件小事",
			{ dry: false, maxTasks: 1, workRoot },
			"pool",
			undefined,
			undefined,
			undefined,
			undefined,
			id,
		);
		assert.equal(ticket.id, id);
		assert.ok(fs.existsSync(store.ticketDir(id)));
	} finally {
		store.close();
	}
});

test("预分配单号：目录已存在 / 形状不合法 → 回落自生成", () => {
	const workRoot = tempRoot();
	const store = new Store(workRoot);
	try {
		const id = allocateTicketId(workRoot);
		fs.mkdirSync(store.ticketDir(id), { recursive: true });
		const ticket = intake(
			store,
			"再来一件",
			{ dry: false, maxTasks: 1, workRoot },
			"pool",
			undefined,
			undefined,
			undefined,
			undefined,
			id,
		);
		assert.notEqual(ticket.id, id);
		assert.match(ticket.id, /^t-\d{8}-\d{6}-[a-z0-9]{4}$/);

		const bad = intake(
			store,
			"第三件",
			{ dry: false, maxTasks: 1, workRoot },
			"pool",
			undefined,
			undefined,
			undefined,
			undefined,
			"not-a-ticket",
		);
		assert.match(bad.id, /^t-\d{8}-\d{6}-[a-z0-9]{4}$/);
	} finally {
		store.close();
	}
});
