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

test("回执：跨进程的 accepting 一律 uncertain（boot 代号对不上 / 旧行 NULL）", () => {
	const root = tempRoot();
	const file = join(root, "delegations.sqlite");
	const first = new DelegationReceipts(file);
	try {
		// 两条 accepting：一条留本进程代号，一条伪造旧进程代号
		assert.equal(first.begin("rb-old", "fp-a", { explicit: true, workRoot: root }).kind, "new");
		assert.equal(first.begin("rb-null", "fp-b", { explicit: true, workRoot: root }).kind, "new");
		const raw = new DatabaseSync(file);
		raw.prepare("UPDATE delegation_receipts SET boot_id = 'boot-old' WHERE request_id = 'rb-old'").run();
		// rb-null 保持 boot_id —— 同进程实例共享代号，先写成当前值再置 NULL 模拟"没有该列的旧行"
		raw.prepare("UPDATE delegation_receipts SET boot_id = NULL WHERE request_id = 'rb-null'").run();
		raw.close();
	} finally {
		first.close();
	}

	// 新实例 = 同进程共享 boot 代号；两条 accepting 都因 boot 对不上被判 uncertain
	const second = new DelegationReceipts(file);
	try {
		assert.equal(second.begin("rb-old", "fp-a", { explicit: true, workRoot: root }).kind, "uncertain");
		assert.equal(second.lookup("rb-old")?.outcome, "uncertain");
		assert.equal(second.begin("rb-null", "fp-b", { explicit: true, workRoot: root }).kind, "uncertain");
		assert.equal(second.lookup("rb-null")?.outcome, "uncertain");
	} finally {
		second.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("回执：本进程的 accepting（boot 匹配）带空单号仍按 uncertain（原语义保留）", () => {
	const root = tempRoot();
	const receipts = new DelegationReceipts(join(root, "delegations.sqlite"));
	try {
		assert.equal(receipts.begin("rb-same", "fp-a", { explicit: true, workRoot: root }).kind, "new");
		// 同进程、未 accept：boot 匹配但单号为空 → 原有的惰性 uncertain 判定保留
		assert.equal(receipts.begin("rb-same", "fp-a", { explicit: true, workRoot: root }).kind, "uncertain");
	} finally {
		receipts.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("续跑回执：每次 resume 各一行，反查取最新；开关关掉一行都不落", () => {
	const root = tempRoot();
	const file = join(root, "delegations.sqlite");
	const receipts = new DelegationReceipts(file);
	const previous = process.env.DELEGATION_MAP_PERSIST;
	try {
		// 原单：自动 id 受理在 802
		assert.equal(receipts.begin("auto-x", "fp-x", { explicit: false }).kind, "new");
		receipts.accept("auto-x", "T-R", 802);
		assert.equal(receipts.lookupByTicket("T-R")?.conversationId, 802);

		assert.equal(receipts.recordResume("T-R", 803), "resume:T-R:1");
		assert.equal(receipts.lookupByTicket("T-R")?.conversationId, 803, "回灌目标跟着 resume 走");
		assert.equal(receipts.recordResume("T-R", 805), "resume:T-R:2");
		assert.equal(receipts.countResumes("T-R"), 2, "同单两次 resume 各留一行、幂等键不撞");
		// 恢复端取的永远是最新那行（latest-wins），不看是不是第一条
		assert.equal(receipts.lookupByTicket("T-R")?.requestId, "resume:T-R:2");
		assert.equal(receipts.lookupByTicket("T-R")?.conversationId, 805);

		// 回滚：DELEGATION_MAP_PERSIST=false → 不落行（不是落一行空映射盖掉旧的）
		process.env.DELEGATION_MAP_PERSIST = "false";
		assert.equal(receipts.recordResume("T-R", 806), null);
		assert.equal(receipts.countResumes("T-R"), 2);
		assert.equal(receipts.lookupByTicket("T-R")?.conversationId, 805);
		assert.equal(receipts.recordResume("", 1), null, "空单号不落行");
	} finally {
		receipts.close();
		if (previous === undefined) delete process.env.DELEGATION_MAP_PERSIST;
		else process.env.DELEGATION_MAP_PERSIST = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("死信：主键幂等，重复记账只落一次，按父单可查", () => {
	const root = tempRoot();
	const receipts = new DelegationReceipts(join(root, "delegations.sqlite"));
	try {
		assert.equal(
			receipts.recordDeadLetter({
				parentTicketId: "T-P",
				childTicketId: "T-C1",
				childStatus: "running",
				note: "父单已终态（aborted），子单仍未终态",
			}),
			true,
		);
		assert.equal(
			receipts.recordDeadLetter({
				parentTicketId: "T-P",
				childTicketId: "T-C1",
				childStatus: "running",
				note: "父单已终态（aborted），子单仍未终态",
			}),
			false,
			"重复扫描同一条必须幂等",
		);
		assert.equal(
			receipts.recordDeadLetter({
				parentTicketId: "T-P",
				childTicketId: "T-C2",
				childStatus: "done",
				note: "父单已中止，子单结果无处并入",
			}),
			true,
		);
		const letters = receipts.listDeadLetters("T-P");
		assert.equal(letters.length, 2);
		assert.equal(letters[0]?.childTicketId, "T-C1");
		assert.equal(receipts.listDeadLetters("T-NONE").length, 0);
	} finally {
		receipts.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("改派回执：续跑被拒改派的新单也落映射，重启回灌落到发起续跑的会话", async () => {
	const { createTools } = await import("./tools.ts");
	const { reportRecoveredTickets } = await import("./recovery-report.ts");
	const root = tempRoot();
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
			delegateRun: (async (
				_request: { resumeTicketId?: string },
				options: { onEvent?: (event: never) => void },
			) => {
				calls += 1;
				if (calls === 1) {
					options.onEvent?.({ type: "ticket", ticketId: "T-OLD", message: "已受理" } as never);
					return { ticketId: "T-OLD", status: "done", line: "完成", tasks: [] };
				}
				if (_request.resumeTicketId) {
					// 续跑在派活前就被拒：没有可续的单
					throw new Error("这张单已经结束");
				}
				// 改派出的新单：同步段先发单号，工具据此写回执
				options.onEvent?.({ type: "manager", ticketId: "T-FB" } as never);
				return { ticketId: "T-FB", status: "done", line: "改派完成", tasks: [] };
			}) as never,
		});
		const delegate = tools.find((tool) => tool.name === "delegate");
		assert.ok(delegate);

		// 先派一张单，让会话记住"最后一张单"（resume 只能续同一轮里最后那张）
		await delegate.execute(
			{ requirement: "先派一张单" } as never,
			{ conversationId: 7123 } as never,
			{} as never,
		);
		// 再回答它：续跑被拒 → 改派新单
		const result = await delegate.execute(
			{ requirement: "验证码 1234", resume: true } as never,
			{ conversationId: 7123 } as never,
			{} as never,
		);
		assert.match(textOf(result), /T-FB/, "改派的新单号要回给模型");

		const receipt = receipts.lookupByTicket("T-FB");
		assert.equal(receipt?.conversationId, 7123, "新单映射到发起续跑的会话");
		assert.match(String(receipt?.requestId), /^resume:T-FB:\d+$/, "与 7a 同款键法");

		// 重启恢复：按单号查回执 → 写回那个会话（不是最初派单的会话）
		const said: Array<{ conversationId: number; text: string }> = [];
		const sent = await reportRecoveredTickets(
			[{ ticketId: "T-FB", status: "done" }],
			{
				receipts,
				say: (conversationId, text) => {
					said.push({ conversationId, text });
				},
			},
		);
		assert.equal(sent, 1);
		assert.equal(said[0]?.conversationId, 7123);
		assert.match(said[0]?.text ?? "", /T-FB/);
	} finally {
		receipts.close();
		if (previousRequired === undefined) delete process.env.DELEGATION_PROJECT_REQUIRED;
		else process.env.DELEGATION_PROJECT_REQUIRED = previousRequired;
		if (previousRoot === undefined) delete process.env.CHANCELLOR_WORK_ROOT;
		else process.env.CHANCELLOR_WORK_ROOT = previousRoot;
		rmSync(root, { recursive: true, force: true });
	}
});
