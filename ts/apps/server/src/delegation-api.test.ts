import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import {
	mountDelegationApi,
	projectTicketBgJobs,
} from "./delegation-api.ts";
import { ensureManager } from "../../../packages/chancellor/src/manager/registry.ts";
import { Store } from "../../../packages/chancellor/src/store.ts";
import type { Ticket } from "../../../packages/chancellor/src/types.ts";

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
		// Windows 上 sqlite 句柄回收有延迟：删除带重试。
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});


test("多副本对齐：同 requestId 的单在列表/详情共用 groupId；开关关掉不出现", async () => {
	const root = temp("api-fanout");
	try {
		const workRoot = join(root, "runs");
		// 同一 requestId 的副本分散在不同 runs 目录（顶层 / 领域各一份；同库只有一个
		// idempotency_key 唯一位，真实扇出也是这样按领域分目录落的）。
		const manager = ensureManager(workRoot, "fan");
		const rootStore = new Store(workRoot);
		rootStore.saveTicket(makeTicket("T-fan-a", workRoot, { idempotencyKey: "req-1" }));
		rootStore.saveTicket(makeTicket("T-solo", workRoot));
		rootStore.close();
		const managerStore = new Store(manager.runs_dir);
		managerStore.saveTicket(
			makeTicket("T-fan-b", manager.runs_dir, {
				idempotencyKey: "req-1",
				options: { dry: true, maxTasks: 8, workRoot: manager.runs_dir, domain: "fan" },
			}),
		);
		managerStore.close();

		const app = new Hono();
		mountDelegationApi(app, { workRoot });

		const list = (await (await app.request("/api/v1/tickets?limit=50")).json()) as {
			tickets: Array<{ id: string; groupId: string | null }>;
		};
		const byId = new Map(list.tickets.map((ticket) => [ticket.id, ticket.groupId]));
		assert.equal(byId.get("T-fan-a"), "req-1");
		assert.equal(byId.get("T-fan-b"), "req-1");
		assert.equal(byId.get("T-solo"), null, "没有 requestId 的单不带组");

		const detail = (await (await app.request("/api/v1/tickets/T-fan-a")).json()) as {
			groupId?: string;
		};
		assert.equal(detail.groupId, "req-1");

		const saved = process.env.DELEGATION_FANOUT_GROUP;
		process.env.DELEGATION_FANOUT_GROUP = "false";
		try {
			const offDetail = (await (await app.request("/api/v1/tickets/T-fan-a")).json()) as Record<
				string,
				unknown
			>;
			assert.equal("groupId" in offDetail, false, "开关关掉详情不带 groupId");
			const offList = (await (await app.request("/api/v1/tickets?limit=50")).json()) as {
				tickets: Array<{ groupId: string | null }>;
			};
			assert.ok(offList.tickets.every((ticket) => ticket.groupId === null), "列表也不带组");
		} finally {
			if (saved === undefined) delete process.env.DELEGATION_FANOUT_GROUP;
			else process.env.DELEGATION_FANOUT_GROUP = saved;
		}
	} finally {
		// Windows 上目录句柄回收比文件慢半拍；断言已经跑完，清理失败不应把用例判红。
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch {
			/* 句柄由 OS 在进程退出时回收 */
		}
	}
});

// ── 多副本聚合（2026-11-10 批 26 §二）────────────────────

test("多副本聚合：2 个副本 1 个完成 → pending；全完成 → settled；未知组 / 开关关 → 404", async () => {
	const root = temp("api-group-aggregate");
	try {
		const workRoot = join(root, "runs");
		const manager = ensureManager(workRoot, "agg");
		const rootStore = new Store(workRoot);
		// 同一 requestId 的副本分散在顶层与领域（同库只有一个 idempotency_key 唯一位）。
		rootStore.saveTicket(
			makeTicket("T-agg-a", workRoot, { idempotencyKey: "g-1", status: "done" }),
		);
		rootStore.saveTicket(
			makeTicket("T-agg-c", workRoot, { idempotencyKey: "g-2", status: "done" }),
		);
		rootStore.close();
		const managerStore = new Store(manager.runs_dir);
		managerStore.saveTicket(
			makeTicket("T-agg-b", manager.runs_dir, {
				idempotencyKey: "g-1",
				options: { dry: true, maxTasks: 8, workRoot: manager.runs_dir, domain: "agg" },
			}),
		);
		managerStore.saveTicket(
			makeTicket("T-agg-d", manager.runs_dir, {
				idempotencyKey: "g-2",
				status: "failed",
				options: { dry: true, maxTasks: 8, workRoot: manager.runs_dir, domain: "agg" },
			}),
		);
		managerStore.close();

		const app = new Hono();
		mountDelegationApi(app, { workRoot });

		const pending = (await (await app.request("/api/v1/tickets/groups/g-1")).json()) as {
			ok: boolean;
			groupId: string;
			total: number;
			done: number;
			pending: number;
			status: string;
		};
		assert.deepEqual(pending, {
			ok: true,
			groupId: "g-1",
			total: 2,
			done: 1,
			pending: 1,
			status: "pending",
		});

		const settled = (await (await app.request("/api/v1/tickets/groups/g-2")).json()) as {
			groupId: string;
			total: number;
			done: number;
			pending: number;
			status: string;
		};
		assert.equal(settled.groupId, "g-2");
		assert.equal(settled.total, 2);
		assert.equal(settled.done, 2);
		assert.equal(settled.pending, 0);
		assert.equal(settled.status, "settled");

		const unknown = await app.request("/api/v1/tickets/groups/nobody");
		assert.equal(unknown.status, 404);

		const saved = process.env.DELEGATION_FANOUT_GROUP;
		process.env.DELEGATION_FANOUT_GROUP = "false";
		try {
			const off = await app.request("/api/v1/tickets/groups/g-1");
			assert.equal(off.status, 404, "开关关着时组这个概念不存在");
		} finally {
			if (saved === undefined) delete process.env.DELEGATION_FANOUT_GROUP;
			else process.env.DELEGATION_FANOUT_GROUP = saved;
		}
	} finally {
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch {
			/* 句柄由 OS 在进程退出时回收 */
		}
	}
});

// ── 后台任务投影（2026-11-10 批 23 §二）──────────────────────

test("后台任务：只取时间窗口内的摘要，不带日志正文", () => {
	const ticket = {
		created_at: "2026-01-01T10:00:00.000Z",
		updated_at: "2026-01-01T11:00:00.000Z",
		status: "done",
	};
	const jobs = [
		{
			id: "bg-early",
			commandSummary: "npm test",
			startedAt: "2026-01-01T09:59:59.000Z",
			endedAt: "2026-01-01T10:01:00.000Z",
			exitCode: 0,
		},
		{
			id: "bg-inside",
			commandSummary: "npm run build",
			startedAt: "2026-01-01T10:30:00.000Z",
			endedAt: "2026-01-01T10:31:00.000Z",
			exitCode: 0,
		},
		{
			id: "bg-late",
			commandSummary: "npm run e2e",
			startedAt: "2026-01-01T11:00:01.000Z",
			endedAt: "2026-01-01T11:02:00.000Z",
			exitCode: 1,
		},
	];
	const projected = projectTicketBgJobs(ticket, jobs);
	assert.deepEqual(projected, [
		{
			id: "bg-inside",
			commandSummary: "npm run build",
			startedAt: "2026-01-01T10:30:00.000Z",
			endedAt: "2026-01-01T10:31:00.000Z",
			exitCode: 0,
		},
	]);
	// 形状只有摘要四件：没有 log / 完整命令。
	assert.deepEqual(Object.keys(projected[0] ?? {}).sort(), [
		"commandSummary",
		"endedAt",
		"exitCode",
		"id",
		"startedAt",
	]);

	// 在跑的单：窗口终点是"现在"，早期任务不因 updated_at 没刷新而丢。
	const running = projectTicketBgJobs(
		{ created_at: "2026-01-01T10:00:00.000Z", updated_at: "2026-01-01T10:00:00.000Z", status: "dispatching" },
		jobs,
		Date.parse("2026-01-01T10:40:00.000Z"),
	);
	assert.deepEqual(running.map((job) => job.id), ["bg-inside"]);

	// 没有 created_at 就没有窗口依据：返回空，不猜。
	assert.deepEqual(projectTicketBgJobs({ status: "done" }, jobs), []);
});

test("后台任务：详情带 bgJobs；开关关掉不带这个键", async () => {
	const root = temp("api-bgjobs");
	const previousDir = process.env.AGENT_BG_JOBS_DIR;
	const dir = join(root, "bg-jobs");
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "index.json"),
			JSON.stringify([
				{
					id: "bg-aaaaaa-1",
					commandSummary: "npm test",
					startedAt: "2026-01-01T10:05:00.000Z",
					endedAt: "2026-01-01T10:06:00.000Z",
					exitCode: 0,
					status: "done",
				},
				{
					id: "bg-bbbbbb-2",
					commandSummary: "旧任务",
					startedAt: "2025-12-31T00:00:00.000Z",
					endedAt: "2025-12-31T00:01:00.000Z",
					exitCode: 0,
					status: "done",
				},
			]),
			"utf8",
		);
		process.env.AGENT_BG_JOBS_DIR = dir;

		const workRoot = join(root, "runs");
		const store = new Store(workRoot);
		store.saveTicket(
			makeTicket("T-bg", workRoot, {
				status: "done",
				created_at: "2026-01-01T10:00:00.000Z",
				updated_at: "2026-01-01T11:00:00.000Z",
			}),
		);
		store.close();

		const app = new Hono();
		mountDelegationApi(app, { workRoot });

		const body = (await (await app.request("/api/v1/tickets/T-bg")).json()) as {
			bgJobs?: Array<Record<string, unknown>>;
		};
		assert.deepEqual(body.bgJobs, [
			{
				id: "bg-aaaaaa-1",
				commandSummary: "npm test",
				startedAt: "2026-01-01T10:05:00.000Z",
				endedAt: "2026-01-01T10:06:00.000Z",
				exitCode: 0,
			},
		]);
		assert.equal("log" in (body.bgJobs?.[0] ?? {}), false, "不返回日志正文");

		const saved = process.env.TICKET_BG_JOBS;
		process.env.TICKET_BG_JOBS = "false";
		try {
			const off = (await (await app.request("/api/v1/tickets/T-bg")).json()) as Record<
				string,
				unknown
			>;
			assert.equal("bgJobs" in off, false, "开关关掉详情不带 bgJobs");
		} finally {
			if (saved === undefined) delete process.env.TICKET_BG_JOBS;
			else process.env.TICKET_BG_JOBS = saved;
		}
	} finally {
		if (previousDir === undefined) delete process.env.AGENT_BG_JOBS_DIR;
		else process.env.AGENT_BG_JOBS_DIR = previousDir;
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
