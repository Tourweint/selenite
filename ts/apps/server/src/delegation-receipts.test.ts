import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		assert.equal(calls, 1, "重复 requestId 不能重复起单");
		assert.match(textOf(first), /T-9/);
		assert.match(textOf(second), /T-9/);
		assert.match(textOf(second), /已经受理过/);
	} finally {
		receipts.close();
		if (previous === undefined) delete process.env.DELEGATION_PROJECT_REQUIRED;
		else process.env.DELEGATION_PROJECT_REQUIRED = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

function textOf(result: { output?: Array<{ type: string; text?: string }> }): string {
	return (result.output ?? [])
		.map((item) => (item.type === "text" ? item.text ?? "" : ""))
		.join("");
}
