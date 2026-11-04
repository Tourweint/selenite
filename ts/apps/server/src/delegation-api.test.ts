import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
