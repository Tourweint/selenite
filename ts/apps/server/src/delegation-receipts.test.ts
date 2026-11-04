import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DelegationReceipts } from "./delegation-receipts.ts";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "lifediary-receipts-"));
}

test("回执：显式 requestId 永远返回原单，内容不同判冲突", () => {
	const root = tempRoot();
	const receipts = new DelegationReceipts(join(root, "delegations.sqlite"));
	try {
		assert.equal(receipts.begin("r1", "fp-a", { explicit: true, workRoot: root }).kind, "new");
		receipts.accept("r1", "T-1");

		const again = receipts.begin("r1", "fp-a", { explicit: true, workRoot: root });
		assert.equal(again.kind, "existing");
		assert.equal(again.receipt?.ticketId, "T-1");

		const conflict = receipts.begin("r1", "fp-b", { explicit: true, workRoot: root });
		assert.equal(conflict.kind, "conflict");
	} finally {
		receipts.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("回执：受理中崩溃 → uncertain，不自动重派", () => {
	const root = tempRoot();
	const receipts = new DelegationReceipts(join(root, "delegations.sqlite"));
	try {
		assert.equal(receipts.begin("r2", "fp-a", { explicit: false, workRoot: root }).kind, "new");
		// 故意不 accept，模拟发送中就崩溃。
		const retry = receipts.begin("r2", "fp-a", { explicit: false, workRoot: root });
		assert.equal(retry.kind, "uncertain");
	} finally {
		receipts.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("回执：自动 id 只在原单未终态时复用", () => {
	const root = tempRoot();
	const receipts = new DelegationReceipts(join(root, "delegations.sqlite"));
	try {
		mkdirSync(join(root, "T-2"));
		writeFileSync(join(root, "T-2", "ticket.json"), JSON.stringify({ status: "dispatching" }));
		assert.equal(receipts.begin("r3", "fp-a", { explicit: false, workRoot: root }).kind, "new");
		receipts.accept("r3", "T-2");
		assert.equal(receipts.begin("r3", "fp-a", { explicit: false, workRoot: root }).kind, "existing");

		writeFileSync(join(root, "T-2", "ticket.json"), JSON.stringify({ status: "done" }));
		// 原单终态：允许重新派同一需求，回执改指向新单。
		assert.equal(receipts.begin("r3", "fp-a", { explicit: false, workRoot: root }).kind, "new");
	} finally {
		receipts.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("delegate 工具：同一 requestId 只起一张单", async () => {
	const { createTools } = await import("./tools.ts");
	const root = tempRoot();
	const receipts = new DelegationReceipts(join(root, "delegations.sqlite"));
	const previous = process.env.DELEGATION_PROJECT_REQUIRED;
	process.env.DELEGATION_PROJECT_REQUIRED = "false";
	let calls = 0;
	try {
		const tools = createTools({
			memory: null,
			scopeOf: (id) => ({ type: "session", id: String(id) }) as never,
			projects: null,
			receipts,
			delegateRun: (async (request: { requirement: string }, options: { onEvent?: (event: never) => void }) => {
				calls += 1;
				options.onEvent?.({
					type: "ticket",
					ticketId: "T-9",
					message: "已受理",
				} as never);
				return { ticketId: "T-9", status: "done", line: "完成", tasks: [] };
			}) as never,
		});
		const delegate = tools.find((tool) => tool.name === "delegate");
		assert.ok(delegate);
		const first = await delegate.execute(
			{ requirement: "把按钮改蓝", requestId: "req-1" } as never,
			{ conversationId: 7101 } as never,
			{} as never,
		);
		const second = await delegate.execute(
			{ requirement: "把按钮改蓝", requestId: "req-1" } as never,
			{ conversationId: 7101 } as never,
			{} as never,
		);
		// 同一 requestId、内容不同：不报 request_conflict，交回原单并说明已受理过。
		const third = await delegate.execute(
			{ requirement: "把按钮改红", requestId: "req-1" } as never,
			{ conversationId: 7101 } as never,
			{} as never,
		);
		assert.equal(calls, 1, "重复 requestId 不能重复起单");
		assert.match(textOf(first), /T-9/);
		assert.match(textOf(second), /T-9/);
		assert.match(textOf(second), /已经受理过/);
		assert.match(textOf(third), /该请求号已受理过，返回原单/);
		assert.match(textOf(third), /T-9/);
	} finally {
		receipts.close();
		if (previous === undefined) delete process.env.DELEGATION_PROJECT_REQUIRED;
		else process.env.DELEGATION_PROJECT_REQUIRED = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("delegate 工具：非法领域名直接回可用领域清单，不建单", async () => {
	const { createTools } = await import("./tools.ts");
	const root = tempRoot();
	mkdirSync(join(root, "managers", "frontend"), { recursive: true });
	const receipts = new DelegationReceipts(join(root, "delegations.sqlite"));
	const previousRequired = process.env.DELEGATION_PROJECT_REQUIRED;
	const previousRoot = process.env.CHANCELLOR_WORK_ROOT;
	process.env.DELEGATION_PROJECT_REQUIRED = "false";
	process.env.CHANCELLOR_WORK_ROOT = join(root, "runs");
	let calls = 0;
	try {
		const tools = createTools({
			memory: null,
			scopeOf: (id) => ({ type: "session", id: String(id) }) as never,
			projects: null,
			receipts,
			delegateRun: (async () => {
				calls += 1;
				return { ticketId: "T-X", status: "done", line: "完成", tasks: [] };
			}) as never,
		});
		const delegate = tools.find((tool) => tool.name === "delegate");
		assert.ok(delegate);
		const result = await delegate.execute(
			{ requirement: "写个文档", domain: "文档", requestId: "req-cn" } as never,
			{ conversationId: 7102 } as never,
			{} as never,
		);
		const text = textOf(result);
		assert.match(text, /必须是小写 ASCII/);
		assert.match(text, /可用领域：frontend/);
		assert.equal(calls, 0, "非法领域名不应起单");
	} finally {
		receipts.close();
		if (previousRequired === undefined) delete process.env.DELEGATION_PROJECT_REQUIRED;
		else process.env.DELEGATION_PROJECT_REQUIRED = previousRequired;
		if (previousRoot === undefined) delete process.env.CHANCELLOR_WORK_ROOT;
		else process.env.CHANCELLOR_WORK_ROOT = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});

test("回执：旧库自动迁移，会话映射随受理落库并可反查", () => {
	const root = tempRoot();
	const file = join(root, "delegations.sqlite");
	// 2026-11-03 的旧 schema：没有 conversation_id
	const legacy = new DatabaseSync(file);
	legacy.exec(`
		CREATE TABLE delegation_receipts (
			request_id TEXT PRIMARY KEY,
			ticket_id TEXT NOT NULL DEFAULT '',
			fingerprint TEXT NOT NULL,
			outcome TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		INSERT INTO delegation_receipts
			(request_id, ticket_id, fingerprint, outcome, created_at, updated_at)
		VALUES ('old', 'T-OLD', 'fp-old', 'accepted', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
	`);
	legacy.close();

	let receipts = new DelegationReceipts(file);
	try {
		// 迁移后旧行照常可读；旧行没有映射，永远是 null
		assert.equal(receipts.lookup("old")?.ticketId, "T-OLD");
		assert.equal(receipts.lookup("old")?.conversationId, null);

		assert.equal(receipts.begin("r-new", "fp-new", { explicit: true, workRoot: root }).kind, "new");
		// 会话 id 用 0 验证 `!== undefined`（不是 truthy）
		receipts.accept("r-new", "T-42", 0);
	} finally {
		receipts.close();
	}

	// 新开实例：映射真的落到库里，不是进程内状态
	receipts = new DelegationReceipts(file);
	try {
		const found = receipts.lookupByTicket("T-42");
		assert.equal(found?.requestId, "r-new");
		assert.equal(found?.ticketId, "T-42");
		assert.equal(found?.conversationId, 0);
		assert.equal(receipts.lookupByTicket("T-NONE"), null);
	} finally {
		receipts.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("回执：DELEGATION_MAP_PERSIST=false 时不写会话列，每次 accept 都读 env", () => {
	const root = tempRoot();
	const receipts = new DelegationReceipts(join(root, "delegations.sqlite"));
	const previous = process.env.DELEGATION_MAP_PERSIST;
	try {
		assert.equal(receipts.begin("r-off", "fp-off", { explicit: true, workRoot: root }).kind, "new");

		process.env.DELEGATION_MAP_PERSIST = "false";
		receipts.accept("r-off", "T-OFF", 7);
		assert.equal(receipts.lookup("r-off")?.conversationId, null);

		// 同一实例里切回来就写：构造时不缓存开关
		delete process.env.DELEGATION_MAP_PERSIST;
		receipts.accept("r-off", "T-OFF", 7);
		assert.equal(receipts.lookup("r-off")?.conversationId, 7);
	} finally {
		receipts.close();
		if (previous === undefined) delete process.env.DELEGATION_MAP_PERSIST;
		else process.env.DELEGATION_MAP_PERSIST = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

function textOf(result: { output?: Array<{ type: string; text?: string }> }): string {
	return (result.output ?? [])
		.map((item) => (item.type === "text" ? item.text ?? "" : ""))
		.join("");
}
