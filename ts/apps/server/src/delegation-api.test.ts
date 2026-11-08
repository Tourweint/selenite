import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { mountDelegationApi } from "./delegation-api.ts";
import { ensureManager } from "../../../../../chancellor/src/manager/registry.ts";
import { Store } from "../../../../../chancellor/src/store.ts";
import type { Ticket } from "../../../../../chancellor/src/types.ts";

function temp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `lifediary-${prefix}-`));
}

function makeTicket(
	id: string,
	workRoot: string,
	extra: Partial<Ticket> = {},
): Ticket {
	const now = new Date().toISOString();
	return {
		id,
		prompt: "测试任务",
		status: "dispatching",
		created_at: now,
		updated_at: now,
		options: { dry: true, maxTasks: 8, workRoot },
		...extra,
	};
}

test("只读接口：领域列表给出在办/总数", async () => {
	const root = temp("api-domains");
	try {
		const workRoot = join(root, "runs");
		const manager = ensureManager(workRoot, "frontend");
		const managerStore = new Store(manager.runs_dir);
		managerStore.saveTicket(makeTicket("T-m1", manager.runs_dir));
		managerStore.close();

		const app = new Hono();
		mountDelegationApi(app, { workRoot });
		const response = await app.request("/api/v1/domains");
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			workRoot: string;
			domains: Array<{
				domain: string;
				activeTickets: number;
				totalTickets: number;
				error: string | null;
			}>;
		};
		assert.equal(body.domains.length, 1);
		assert.equal(body.domains[0]?.domain, "frontend");
		assert.equal(body.domains[0]?.activeTickets, 1);
		assert.equal(body.domains[0]?.totalTickets, 1);
		assert.equal(body.domains[0]?.error, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("只读接口：按单号读 ticket、任务与子单，区分根目录与领域目录", async () => {
	const root = temp("api-ticket");
	try {
		const workRoot = join(root, "runs");
		const manager = ensureManager(workRoot, "frontend");
		const managerStore = new Store(manager.runs_dir);

		// 根目录的单（没有领域）。
		const rootStore = new Store(workRoot);
		rootStore.saveTicket(makeTicket("T-root", workRoot));

		// 领域目录里的父单 + 一个任务行 + 一张子单。
		const now = new Date().toISOString();
		managerStore.saveTicket(makeTicket("T-mgr", manager.runs_dir, { employee: "manager" }));
		managerStore.saveTask({
			ticket_id: "T-mgr",
			seq: 1,
			slug: "child",
			title: "child",
			dir: join(manager.runs_dir, "T-mgr", "01-child"),
			status: "pending",
			employee: null,
			updated_at: now,
		});
		managerStore.saveTicket(
			makeTicket("T-child", manager.runs_dir, {
				parentTicketId: "T-mgr",
				status: "dispatching",
			}),
		);

		const app = new Hono();
		mountDelegationApi(app, { workRoot });

		const rootResponse = await app.request("/api/v1/tickets/T-root");
		assert.equal(rootResponse.status, 200);
		const rootBody = (await rootResponse.json()) as {
			ok: boolean;
			domain: string | null;
			tasks: unknown[];
			children: unknown[];
		};
		assert.equal(rootBody.ok, true);
		assert.equal(rootBody.domain, null);
		assert.deepEqual(rootBody.tasks, []);
		assert.deepEqual(rootBody.children, []);

		const managerResponse = await app.request("/api/v1/tickets/T-mgr");
		assert.equal(managerResponse.status, 200);
		const managerBody = (await managerResponse.json()) as {
			ok: boolean;
			domain: string | null;
			tasks: Array<{ seq: number }>;
			children: Array<{ id: string; parentTicketId: string }>;
		};
		assert.equal(managerBody.ok, true);
		assert.equal(managerBody.domain, "frontend");
		assert.equal(managerBody.tasks.length, 1);
		assert.equal(managerBody.tasks[0]?.seq, 1);
		assert.equal(managerBody.children.length, 1);
		assert.equal(managerBody.children[0]?.id, "T-child");
		assert.equal(managerBody.children[0]?.parentTicketId, "T-mgr");

		rootStore.close();
		managerStore.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("只读接口：列表与详情带回最近动作/心跳/等待文件", async () => {
	const root = temp("api-progress");
	try {
		const workRoot = join(root, "runs");
		const store = new Store(workRoot);
		const now = new Date().toISOString();
		store.saveTicket(
			makeTicket("T-progress", workRoot, {
				lastAction: "派活到 01-write",
				lastHeartbeat: now,
				waitingOn: "src/a.ts",
			}),
		);
		store.close();

		const app = new Hono();
		mountDelegationApi(app, { workRoot });

		const list = await app.request("/api/v1/tickets");
		assert.equal(list.status, 200);
		const listBody = (await list.json()) as {
			tickets: Array<{
				id: string;
				lastAction: string | null;
				lastHeartbeat: string | null;
				waitingOn: string | null;
			}>;
		};
		const row = listBody.tickets.find((item) => item.id === "T-progress");
		assert.equal(row?.lastAction, "派活到 01-write");
		assert.equal(row?.lastHeartbeat, now);
		assert.equal(row?.waitingOn, "src/a.ts");

		const detail = await app.request("/api/v1/tickets/T-progress");
		assert.equal(detail.status, 200);
		const detailBody = (await detail.json()) as {
			ticket: { lastAction?: string; lastHeartbeat?: string; waitingOn?: string };
		};
		assert.equal(detailBody.ticket.lastAction, "派活到 01-write");
		assert.equal(detailBody.ticket.lastHeartbeat, now);
		assert.equal(detailBody.ticket.waitingOn, "src/a.ts");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("进度落盘：动作变化立刻写，纯心跳被节流且新进程能读回", () => {
	const root = temp("api-progress-write");
	try {
		const workRoot = join(root, "runs");
		const store = new Store(workRoot);
		const ticket = makeTicket("T-touch", workRoot);
		store.saveTicket(ticket);
		const file = join(workRoot, "T-touch", "ticket.json");

		const first = "2026-11-04T00:00:00.000Z";
		store.saveTicketProgress(ticket, { action: "第一步", heartbeat: first });
		const afterFirst = JSON.parse(readFileSync(file, "utf8")) as {
			lastAction?: string;
			lastHeartbeat?: string;
		};
		assert.equal(afterFirst.lastAction, "第一步");
		assert.equal(afterFirst.lastHeartbeat, first);

		// 同一个动作、只换心跳：10 秒内不写盘，文件里的心跳保持第一次的值。
		store.saveTicketProgress(ticket, {
			action: "第一步",
			heartbeat: "2026-11-04T00:00:01.000Z",
		});
		const afterThrottled = JSON.parse(readFileSync(file, "utf8")) as {
			lastHeartbeat?: string;
		};
		assert.equal(afterThrottled.lastHeartbeat, first);

		// 动作变了就必须写。
		store.saveTicketProgress(ticket, {
			action: "等待文件：src/a.ts",
			waitingOn: "src/a.ts",
			heartbeat: "2026-11-04T00:00:02.000Z",
		});
		const afterChange = JSON.parse(readFileSync(file, "utf8")) as {
			lastAction?: string;
			lastHeartbeat?: string;
			waitingOn?: string;
		};
		assert.equal(afterChange.lastAction, "等待文件：src/a.ts");
		assert.equal(afterChange.lastHeartbeat, "2026-11-04T00:00:02.000Z");
		assert.equal(afterChange.waitingOn, "src/a.ts");
		store.close();

		// 模拟崩溃重启：新 Store 从明文读回同一张单。
		const reopened = new Store(workRoot);
		const readBack = reopened.listTickets(10).find((item) => item.id === "T-touch");
		assert.ok(readBack);
		reopened.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("只读接口：未知单号 404，路径穿越一律拒绝", async () => {
	const root = temp("api-404");
	try {
		const workRoot = join(root, "runs");
		const app = new Hono();
		mountDelegationApi(app, { workRoot });

		const missing = await app.request("/api/v1/tickets/T-none");
		assert.equal(missing.status, 404);

		for (const raw of ["../../secret", "..\\secret", "a/b"]) {
			const response = await app.request(
				`/api/v1/tickets/${encodeURIComponent(raw)}`,
			);
			assert.equal(response.status, 404, raw);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── 任务回话（2026-11-08 扫尾批 8g）──────────────────────────
// 成功路径（建专线 + submit + 续跑）需要真模型/Harness，由 http 探针覆盖；
// 这里只钉开关、入参与前置拒绝，全部在到达 `submitTaskReply` 之前返回。

function withTaskConversation<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.TASK_AS_CONVERSATION;
	process.env.TASK_AS_CONVERSATION = enabled ? "true" : "false";
	return fn().finally(() => {
		if (previous === undefined) delete process.env.TASK_AS_CONVERSATION;
		else process.env.TASK_AS_CONVERSATION = previous;
	});
}

test("任务回话：回滚开关关着时端点 404", async () => {
	const root = temp("api-say-off");
	try {
		const workRoot = join(root, "runs");
		const app = new Hono();
		await withTaskConversation(false, async () => {
			mountDelegationApi(app, { workRoot });
			const response = await app.request("/api/v1/tickets/T-x/say", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "在吗" }),
			});
			assert.equal(response.status, 404, "TASK_AS_CONVERSATION=false → 404（未启用）");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("任务回话：缺 text / 未知单 / 终态 / 无来源会话都如实拒绝", async () => {
	const root = temp("api-say-guard");
	try {
		const workRoot = join(root, "runs");
		const store = new Store(workRoot);
		store.saveTicket(makeTicket("T-done", workRoot, { status: "done" }));
		store.saveTicket(makeTicket("T-orphan-say", workRoot, { status: "needs_you" }));
		store.close();

		const app = new Hono();
		await withTaskConversation(true, async () => {
			mountDelegationApi(app, { workRoot });

			const empty = await app.request("/api/v1/tickets/T-done/say", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "   " }),
			});
			assert.equal(empty.status, 400);

			const missing = await app.request("/api/v1/tickets/T-none/say", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "在吗" }),
			});
			assert.equal(missing.status, 404);

			const terminal = await app.request("/api/v1/tickets/T-done/say", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "在吗" }),
			});
			const terminalBody = (await terminal.json()) as { error?: string };
			assert.equal(terminal.status, 400);
			assert.equal(terminalBody.error, "ticket_terminal");

			const orphan = await app.request("/api/v1/tickets/T-orphan-say/say", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "在吗" }),
			});
			const orphanBody = (await orphan.json()) as { error?: string };
			assert.equal(orphan.status, 400);
			assert.equal(orphanBody.error, "missing_conversation");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("详情：启用时带回 taskConversationEnabled 与确定性专线 id", async () => {
	const root = temp("api-say-detail");
	try {
		const workRoot = join(root, "runs");
		const store = new Store(workRoot);
		store.saveTicket(makeTicket("T-conv", workRoot));
		store.close();

		const app = new Hono();
		await withTaskConversation(true, async () => {
			mountDelegationApi(app, { workRoot });
			const response = await app.request("/api/v1/tickets/T-conv");
			assert.equal(response.status, 200);
			const body = (await response.json()) as {
				taskConversationEnabled?: boolean;
				taskConversationId?: string | null;
			};
			assert.equal(body.taskConversationEnabled, true);
			assert.equal(body.taskConversationId, "task-T-conv", "id 是 task-<票号>，不需要读 Harness");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
