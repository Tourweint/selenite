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
import {
	collectDeadLetters,
	formatRecoveryLine,
	redeliverUndeliveredReports,
	reportRedeliveryEnabled,
	reportRecoveredTickets,
	type DeadLetterRecord,
	type UndeliveredReportRow,
} from "./recovery-report.ts";

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

test("恢复死信：父单 aborted + 子单已终态 → 记账；父单 done + 子单终态 → 不记", () => {
	const recorded: DeadLetterRecord[] = [];
	let calls = 0;
	const recordedCount = collectDeadLetters(
		[entryOf("T-P1", "aborted"), entryOf("T-P2", "done")],
		{
			childrenOf: (parentTicketId) => {
				calls += 1;
				if (parentTicketId === "T-P1") {
					return [{ id: "T-C1", status: "done" }];
				}
				if (parentTicketId === "T-P2") {
					return [{ id: "T-C2", status: "done" }];
				}
				return [];
			},
			record: (entry) => {
				recorded.push(entry);
				return true;
			},
		},
	);
	assert.equal(calls, 2, "两个终态父单都要扫子单");
	assert.equal(recordedCount, 1);
	assert.equal(recorded.length, 1);
	assert.equal(recorded[0]?.parentTicketId, "T-P1");
	assert.equal(recorded[0]?.childTicketId, "T-C1");
	assert.match(recorded[0]?.note ?? "", /已中止/);
});

test("恢复死信：父单终态 + 子单未终态 → 记账；重复扫描幂等不重复计", () => {
	const seen = new Set<string>();
	const recordedCount = collectDeadLetters(
		[entryOf("T-P3", "needs_you"), entryOf("T-P3", "needs_you")],
		{
			childrenOf: () => [
				{ id: "T-C3", status: "running" },
				// failed 子单 + 非 aborted 父单 = 正常收口路径（enforceChildClosure 已覆盖），不记死信
				{ id: "T-C4", status: "planning" },
			],
			record: (entry) => {
				const key = `${entry.parentTicketId}/${entry.childTicketId}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			},
		},
	);
	// 两轮扫描 × 两个未终态子单，幂等后只算 2 条；failed 子单 + 非 aborted 父单不记
	assert.equal(recordedCount, 2);
});

test("恢复死信：非终态父单不扫、开关关掉不扫", () => {
	let calls = 0;
	let records = 0;
	const previous = process.env.DELEGATION_RECOVER_REPORT;
	try {
		collectDeadLetters([entryOf("T-P4", "still_running")], {
			childrenOf: () => {
				calls += 1;
				return [{ id: "T-C5", status: "running" }];
			},
			record: () => {
				records += 1;
				return true;
			},
		});
		assert.equal(calls, 0, "非终态父单不该进入死信扫描");
		process.env.DELEGATION_RECOVER_REPORT = "false";
		const count = collectDeadLetters([entryOf("T-P5", "aborted")], {
			childrenOf: () => [{ id: "T-C6", status: "done" }],
			record: () => {
				records += 1;
				return true;
			},
		});
		assert.equal(count, 0);
		assert.equal(records, 0, "开关关掉时 record 一次都不该被调");
	} finally {
		if (previous === undefined) delete process.env.DELEGATION_RECOVER_REPORT;
		else process.env.DELEGATION_RECOVER_REPORT = previous;
	}
});

// ── 待送达汇报的启动补送（2026-11-15 回信送达兜底，方案 §A.4）──────────

function redeliverDeps(overrides: Partial<Parameters<typeof redeliverUndeliveredReports>[0]> = {}) {
	const calls: Array<{ conversationId: number; text: string }> = [];
	const settled: Array<{ id: number; state: 1 | 2 }> = [];
	const woken: Array<{ conversationId: number; ticketId: string }> = [];
	const rows: UndeliveredReportRow[] = [
		{ id: 11, ticketId: "T-1", body: "任务 T-1 的结论", createdAt: "2026-11-15T10:00:00.000Z" },
		{ id: 12, ticketId: "T-2", body: "任务 T-2 的结论", createdAt: "2026-11-15T10:01:00.000Z" },
	];
	const deps = {
		undelivered: () => rows,
		hostConversationId: (ticketId: string) => (ticketId === "T-1" ? 7 : null),
		say: async (conversationId: number, text: string) => {
			calls.push({ conversationId, text });
			return true;
		},
		settle: (id: number, state: 1 | 2) => settled.push({ id, state }),
		wake: (conversationId: number, ticketId: string) => {
			woken.push({ conversationId, ticketId });
		},
		phaseOf: (ticketId: string) => (ticketId === "T-1" ? "done" : null),
		log: (line: string) => console.warn(line),
		...overrides,
	};
	return { deps, calls, settled, woken, rows };
}

test("补送：解析到宿主的写回并销 1 + 唤醒；解析不到的留 0 下次再试", async () => {
	const { deps, calls, settled, woken } = redeliverDeps();
	const sent = await redeliverUndeliveredReports(deps);
	assert.equal(sent, 1, "只有 T-1 解析到宿主");
	assert.deepEqual(calls, [{ conversationId: 7, text: "（重启补送）任务 T-1 的结论" }]);
	assert.deepEqual(settled, [{ id: 11, state: 1 }], "成功行销账，缺宿主的留 0");
	assert.deepEqual(woken, [{ conversationId: 7, ticketId: "T-1" }], "补送成功即唤醒");
});

test("补送：会话不存在销 2；写回抛异常留 0；开关关时整段旁路", async () => {
	const { deps, settled } = redeliverDeps({
		say: async () => false,
	});
	const sent = await redeliverUndeliveredReports(deps);
	assert.equal(sent, 0);
	assert.deepEqual(settled, [{ id: 11, state: 2 }], "会话不存在 → 销 2（补送永远不会再成功）");
	// T-2 解析不到宿主（deps 里 hostConversationId 对它返回 null）：留 0 走 warn 口径
	assert.deepEqual(
		(await redeliverUndeliveredReports(deps), settled),
		settled,
		"重跑不再送已销账的行",
	);

	const throwing = redeliverDeps({
		say: async () => {
			throw new Error("durable 抖了");
		},
	});
	const thrown = await redeliverUndeliveredReports(throwing.deps);
	assert.equal(thrown, 0);
	assert.deepEqual(throwing.settled, [], "异常不销账，下次启动再试");

	process.env.DELEGATION_REPORT_REDELIVERY = "false";
	try {
		assert.equal(reportRedeliveryEnabled(), false);
		assert.equal(await redeliverUndeliveredReports(deps), 0, "开关关 = 回老行为");
	} finally {
		delete process.env.DELEGATION_REPORT_REDELIVERY;
	}
});

test("补送：脏行与票已清掉的孤儿行直接销 2，不再反复扫", async () => {
	const { deps, settled } = redeliverDeps({
		undelivered: () => [{ id: 99, ticketId: "", body: "", createdAt: "" }],
		ticketExists: () => false,
	});
	const sent = await redeliverUndeliveredReports(deps);
	assert.equal(sent, 0);
	assert.deepEqual(settled, [{ id: 99, state: 2 }], "脏行销 2");
});
