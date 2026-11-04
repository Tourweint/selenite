import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareTaskWorktree, removeWorktree } from "../../../../../chancellor/src/isolation.ts";
import { recoverDelegations, type RecoveredTicket } from "../../../../../chancellor/src/index.ts";
import { readJson, Store } from "../../../../../chancellor/src/store.ts";
import type { ProjectRef, Ticket } from "../../../../../chancellor/src/types.ts";
import { formatRecoveryLine, reportRecoveredTickets } from "./recovery-report.ts";

function temp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `lifediary-${prefix}-`));
}

function makeTicket(id: string, workRoot: string, status: Ticket["status"]): Ticket {
	return {
		id,
		prompt: "测试",
		status,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		options: { dry: false, maxTasks: 4, workRoot },
	};
}

function writeInflight(
	workRoot: string,
	ticketId: string,
	patch: { pid?: number; merged?: boolean; resumeCount?: number } = {},
): string {
	const dir = join(workRoot, ticketId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "inflight.json");
	writeFileSync(
		file,
		JSON.stringify({
			ticketId,
			pid: patch.pid ?? 999_999,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			resumeCount: patch.resumeCount ?? 0,
			merged: patch.merged ?? false,
			taskDir: dir,
			worktrees: [],
		}),
	);
	return file;
}

function saveTicket(ticket: Ticket): void {
	const store = new Store(ticket.options.workRoot);
	try {
		store.saveTicket(ticket);
	} finally {
		store.close();
	}
}

/** 逐单回调的收集器：现有用例都挂上，用来担保 chancellor 的汇总行为没变。 */
function collect(): {
	entries: RecoveredTicket[];
	onTicket: (entry: RecoveredTicket) => void;
} {
	const entries: RecoveredTicket[] = [];
	return { entries, onTicket: (entry) => entries.push(entry) };
}

function entryOf(
	ticketId: string,
	status: RecoveredTicket["status"],
	error?: string,
): RecoveredTicket {
	return {
		ticketId,
		status,
		...(error !== undefined ? { error } : {}),
	};
}

/** 只实现 A3b 用到的那一个查询，测试不建库。 */
function receiptsOf(map: Record<string, number | null>): {
	lookupByTicket: (ticketId: string) => { conversationId: number | null } | null;
} {
	return {
		lookupByTicket: (ticketId) =>
			ticketId in map ? { conversationId: map[ticketId] ?? null } : null,
	};
}

test("恢复：已终态的清单只清标记", async () => {
	const root = temp("recover-finished");
	try {
		const ticket = makeTicket("t-finished", root, "done");
		saveTicket(ticket);
		const file = writeInflight(root, ticket.id);
		const spy = collect();
		const summary = await recoverDelegations(root, { onTicket: spy.onTicket });
		assert.equal(summary.finished, 1);
		assert.equal(existsSync(file), false);
		assert.deepEqual(spy.entries, [{ ticketId: "t-finished", status: "done" }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("恢复：原进程还活着就不接管", async () => {
	const root = temp("recover-running");
	try {
		const ticket = makeTicket("t-running", root, "dispatching");
		saveTicket(ticket);
		const file = writeInflight(root, ticket.id, { pid: process.pid });
		const spy = collect();
		const summary = await recoverDelegations(root, { onTicket: spy.onTicket });
		assert.equal(summary.stillRunning, 1);
		assert.equal(existsSync(file), true, "活着的单不能被当作崩溃");
		assert.deepEqual(spy.entries, [{ ticketId: "t-running", status: "still_running" }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("恢复：跨过合并点一律转待你处理", async () => {
	const root = temp("recover-merged");
	try {
		const ticket = makeTicket("t-merged", root, "dispatching");
		saveTicket(ticket);
		writeInflight(root, ticket.id, { merged: true });
		const spy = collect();
		const summary = await recoverDelegations(root, { onTicket: spy.onTicket });
		assert.equal(summary.needsYou, 1);
		const current = readJson<Ticket>(join(root, ticket.id, "ticket.json"));
		assert.equal(current?.status, "needs_you");
		assert.match(current?.error ?? "", /崩溃恢复/);
		assert.equal(spy.entries.length, 1);
		assert.equal(spy.entries[0]?.status, "needs_you");
		assert.match(spy.entries[0]?.error ?? "", /崩溃恢复/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("恢复：自动续跑次数用完就转待你处理", async () => {
	const root = temp("recover-limit");
	try {
		const ticket = makeTicket("t-limit", root, "dispatching");
		saveTicket(ticket);
		writeInflight(root, ticket.id, { resumeCount: 1 });
		const spy = collect();
		const summary = await recoverDelegations(root, { onTicket: spy.onTicket });
		assert.equal(summary.needsYou, 1);
		const current = readJson<Ticket>(join(root, ticket.id, "ticket.json"));
		assert.match(current?.error ?? "", /已自动续跑/);
		assert.equal(spy.entries.length, 1);
		assert.equal(spy.entries[0]?.status, "needs_you");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("恢复：没有计划就不硬跑，转待你处理", async () => {
	const root = temp("recover-noplan");
	try {
		const ticket = makeTicket("t-noplan", root, "dispatching");
		saveTicket(ticket);
		writeInflight(root, ticket.id);
		const spy = collect();
		const summary = await recoverDelegations(root, { onTicket: spy.onTicket });
		assert.equal(summary.needsYou, 1);
		assert.equal(summary.resumed, 0);
		const current = readJson<Ticket>(join(root, ticket.id, "ticket.json"));
		assert.match(current?.error ?? "", /没有可续跑/);
		assert.equal(existsSync(join(root, ticket.id, "inflight.json")), false);
		// 两个失败出口在 autoResume 内部上报，循环尾不能再报一次（同一单不能两行）。
		assert.equal(spy.entries.length, 1);
		assert.equal(spy.entries[0]?.status, "needs_you");
		assert.match(spy.entries[0]?.error ?? "", /没有可续跑/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("恢复：缺 ticket.json 记未知并清标记", async () => {
	const root = temp("recover-unknown");
	try {
		const dir = join(root, "t-unknown");
		mkdirSync(dir, { recursive: true });
		writeInflight(root, "t-unknown");
		const spy = collect();
		const summary = await recoverDelegations(root, { onTicket: spy.onTicket });
		assert.equal(summary.unknown, 1);
		assert.equal(existsSync(join(dir, "recovery.json")), true);
		assert.equal(existsSync(join(dir, "inflight.json")), false);
		assert.deepEqual(spy.entries, [{ ticketId: "t-unknown", status: "unknown" }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("恢复：done / needs_you / failed / aborted 四态各自上报，互不混淆", async () => {
	const root = temp("recover-four");
	try {
		const cases: Array<[string, Ticket["status"], string | undefined]> = [
			["t-done", "done", undefined],
			["t-needs", "needs_you", "需要你（崩溃恢复）：已合并进项目"],
			["t-failed", "failed", "目标核对未通过：测试"],
			["t-aborted", "aborted", "已停止"],
		];
		for (const [id, status, error] of cases) {
			saveTicket({ ...makeTicket(id, root, status), ...(error ? { error } : {}) });
			writeInflight(root, id);
		}

		const spy = collect();
		const summary = await recoverDelegations(root, { onTicket: spy.onTicket });
		assert.equal(summary.finished, 4);

		const seen = spy.entries
			.map((entry) => ({ status: entry.status, error: entry.error ?? null }))
			.sort((a, b) => String(a.status).localeCompare(String(b.status)));
		assert.deepEqual(seen, [
			{ status: "aborted", error: "已停止" },
			{ status: "done", error: null },
			{ status: "failed", error: "目标核对未通过：测试" },
			{ status: "needs_you", error: "需要你（崩溃恢复）：已合并进项目" },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("恢复：onTicket 抛异常不中断结算", async () => {
	const root = temp("recover-throw");
	try {
		for (const id of ["t-a", "t-b"]) {
			saveTicket(makeTicket(id, root, "done"));
			writeInflight(root, id);
		}
		let calls = 0;
		const summary = await recoverDelegations(root, {
			onTicket: async () => {
				calls += 1;
				throw new Error("宿主写回失败");
			},
		});
		assert.equal(calls, 2);
		assert.equal(summary.scanned, 2);
		assert.equal(summary.finished, 2);
		assert.equal(existsSync(join(root, "t-a", "inflight.json")), false);
		assert.equal(existsSync(join(root, "t-b", "inflight.json")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("回灌：回执命中就写一行状态到原会话", async () => {
	const said: Array<[number, string]> = [];
	const sent = await reportRecoveredTickets(
		[entryOf("t-hit", "failed", "worker 退出码 1")],
		{
			receipts: receiptsOf({ "t-hit": 7 }),
			say: (conversationId, text) => {
				said.push([conversationId, text]);
			},
		},
	);
	assert.equal(sent, 1);
	assert.deepEqual(said, [
		[7, "上一进程留下的派活单 t-hit 已终态：failed（worker 退出码 1）"],
	]);
});

test("回灌：没有回执 / 回执没有会话映射只 warn，不抛", async () => {
	const logs: string[] = [];
	const sent = await reportRecoveredTickets(
		[entryOf("t-miss", "done"), entryOf("t-null", "needs_you", "需要你")],
		{
			receipts: receiptsOf({ "t-null": null }),
			say: () => {
				throw new Error("不该被调用");
			},
			log: (line) => logs.push(line),
		},
	);
	assert.equal(sent, 0);
	assert.equal(logs.length, 2);
	assert.match(logs[0] ?? "", /没有受理回执/);
	assert.match(logs[1] ?? "", /没有会话映射/);
});

test("回灌：会话已删（say 抛异常）只 warn，后面的单照常处理", async () => {
	const logs: string[] = [];
	const said: number[] = [];
	const sent = await reportRecoveredTickets(
		[entryOf("t-gone", "done"), entryOf("t-alive", "done")],
		{
			receipts: receiptsOf({ "t-gone": 3, "t-alive": 4 }),
			say: (conversationId) => {
				if (conversationId === 3) throw new Error("会话不存在");
				said.push(conversationId);
			},
			log: (line) => logs.push(line),
		},
	);
	assert.equal(sent, 1);
	assert.deepEqual(said, [4]);
	assert.match(logs[0] ?? "", /写回会话失败/);
});

test("回灌：DELEGATION_RECOVER_REPORT=false 时零查询零写入", async () => {
	const previous = process.env.DELEGATION_RECOVER_REPORT;
	process.env.DELEGATION_RECOVER_REPORT = "false";
	try {
		let looked = 0;
		let said = 0;
		const sent = await reportRecoveredTickets([entryOf("t-off", "done")], {
			receipts: {
				lookupByTicket: () => {
					looked += 1;
					return { conversationId: 1 };
				},
			},
			say: () => {
				said += 1;
			},
		});
		assert.equal(sent, 0);
		assert.equal(looked, 0);
		assert.equal(said, 0);
	} finally {
		if (previous === undefined) delete process.env.DELEGATION_RECOVER_REPORT;
		else process.env.DELEGATION_RECOVER_REPORT = previous;
	}
});

test("回灌：still_running / unknown 不是终态，零调用", async () => {
	let looked = 0;
	const sent = await reportRecoveredTickets(
		[entryOf("t-1", "still_running"), entryOf("t-2", "unknown")],
		{
			receipts: {
				lookupByTicket: () => {
					looked += 1;
					return { conversationId: 1 };
				},
			},
			say: () => undefined,
		},
	);
	assert.equal(sent, 0);
	assert.equal(looked, 0);
});

test("回灌：状态行按原词输出且不超过 80 字", () => {
	const line = formatRecoveryLine(entryOf("t-x", "aborted"));
	assert.equal(line, "上一进程留下的派活单 t-x 已终态：aborted");
	assert.equal(line.includes("完成"), false);
	assert.equal(formatRecoveryLine(entryOf("t-y", "failed")).includes("完成"), false);

	const long = formatRecoveryLine(entryOf("t-long", "needs_you", "很长的原因".repeat(40)));
	assert.ok(long.length <= 80, `状态行应 ≤80 字，实际 ${long.length}`);
});

test("worktree：复用副本能接住崩溃前的半成品", () => {
	const root = temp("recover-worktree");
	try {
		const repo = join(root, "repo");
		mkdirSync(repo, { recursive: true });
		spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
		spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
		spawnSync("git", ["-C", repo, "config", "user.name", "test"]);
		writeFileSync(join(repo, "base.txt"), "base\n");
		spawnSync("git", ["-C", repo, "add", "-A"]);
		spawnSync("git", ["-C", repo, "commit", "-qm", "init"]);
		const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" })
			.stdout.trim();
		const project: ProjectRef & { head: string } = {
			id: "p1",
			name: "repo",
			rootPath: repo,
			vcs: "git",
			dataDir: join(root, "project-data"),
			head,
		};
		const worktreePath = join(root, "project-data", "worktrees", "t-1", "01-a");
		const first = prepareTaskWorktree({ project, worktreePath });
		writeFileSync(join(worktreePath, "base.txt"), "partial\n");
		writeFileSync(join(worktreePath, "new.txt"), "半成品\n");
		const reused = prepareTaskWorktree({ project, worktreePath, reuseExisting: true });
		assert.equal(reused.baseRef, first.baseRef);
		assert.equal(readFileSync(join(worktreePath, "base.txt"), "utf8"), "partial\n");
		assert.equal(readFileSync(join(worktreePath, "new.txt"), "utf8"), "半成品\n");
		removeWorktree(repo, worktreePath);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
