import assert from "node:assert/strict";
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
import { resetSchedulingForTest, laneCooldown } from "../../../packages/chancellor/src/lane.ts";
import { runScheduledTasks } from "../../../packages/chancellor/src/scheduler.ts";
import { taskDirName } from "../../../packages/chancellor/src/dispatch.ts";
import { Store } from "../../../packages/chancellor/src/store.ts";
import type {
	PlannedTask,
	ProjectRef,
	Task,
	TaskRun,
	Ticket,
} from "../../../packages/chancellor/src/types.ts";

/**
 * attempt 重试与退避（2026-11-22 M3）。
 *
 * 用假 runner 验调度层自己的账：跑了几轮、run.attempt、旧 REPORT 有没有清、
 * 关掉开关后是不是只跑一次。真 spawning 的执行器行为不在这里验。
 */

type SavedEnv = Array<[string, string | undefined]>;

function saveEnv(names: string[]): SavedEnv {
	return names.map((name) => [name, process.env[name]]);
}

function restoreEnv(saved: SavedEnv): void {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

function temp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `lifediary-${prefix}-`));
}

function planned(seq: number, slug: string): PlannedTask {
	return {
		title: slug,
		slug,
		instruction: `干 ${slug}`,
		done_when: "文件存在",
		dependsOn: [],
		writes: [],
	};
}

function taskRow(ticketId: string, seq: number, slug: string): Task {
	return {
		ticket_id: ticketId,
		seq,
		slug,
		title: slug,
		dir: taskDirName(seq, slug),
		status: "pending",
		employee: null,
		updated_at: new Date().toISOString(),
	};
}

function makeTicket(id: string, workRoot: string): Ticket {
	return {
		id,
		prompt: "测试",
		status: "dispatching",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		options: { dry: true, maxTasks: 8, workRoot },
	};
}

function makeRun(
	ticket: Ticket,
	task: PlannedTask,
	seq: number,
	ticketDir: string,
	over: Partial<TaskRun> = {},
): TaskRun {
	const dirName = taskDirName(seq, task.slug);
	return {
		ticketId: ticket.id,
		seq,
		task,
		dir: join(ticketDir, dirName),
		dirName,
		employee: "mercenary",
		exitCode: 0,
		timedOut: false,
		aborted: false,
		processOk: true,
		processError: null,
		sessionId: null,
		reportExists: true,
		report: { status: "ready", summary: "完成", artifacts: [], raw: "READY" },
		reportError: null,
		stderrTail: "",
		...over,
	};
}

test("重试：transient 失败后重跑同一 task，attempt=2，旧 REPORT / session 被清掉", async () => {
	const saved = saveEnv(["CHANCELLOR_SCHEDULER", "CHANCELLOR_RETRY_ENABLED", "CHANCELLOR_LANE_CAPS"]);
	const root = temp("retry-runs");
	const store = new Store(root);
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		delete process.env.CHANCELLOR_RETRY_ENABLED;
		delete process.env.CHANCELLOR_LANE_CAPS;
		resetSchedulingForTest();

		const ticket = makeTicket("T-retry", root);
		store.saveTicket(ticket);
		const tasks = [planned(1, "flaky")];
		const rows = [taskRow(ticket.id, 1, "flaky")];
		for (const row of rows) store.saveTask(row);
		const taskDir = join(store.ticketDir(ticket.id), taskDirName(1, "flaky"));

		let calls = 0;
		let sawOldReportOnRetry: boolean | null = null;
		let sawOldSessionOnRetry: boolean | null = null;
		const { runs } = await runScheduledTasks({
			ticket,
			store,
			tasks,
			rows,
			employeeKind: "mercenary",
			emit: () => undefined,
			isolation: "direct",
			maxParallel: 1,
			runner: (async (
				runTicket: Ticket,
				task: PlannedTask,
				seq: number,
				ticketDir: string,
			) => {
				calls += 1;
				const dir = join(ticketDir, taskDirName(seq, task.slug));
				mkdirSync(dir, { recursive: true });
				if (calls === 1) {
					// 第一轮留下「旧结论」：第二轮开工前必须被清掉，否则会被当新报告。
					writeFileSync(
						join(dir, "REPORT.md"),
						"```json\n{\"status\":\"ready\",\"summary\":\"旧报告\"}\n```\n",
					);
					writeFileSync(join(dir, "session.json"), '{"session_id":"stale"}\n');
					return makeRun(runTicket, task, seq, ticketDir, {
						exitCode: 1,
						processOk: false,
						processError: "fetch failed",
						stderrTail: "socket hang up",
						report: null,
						reportError: "旧报告",
					});
				}
				sawOldReportOnRetry = existsSync(join(dir, "REPORT.md"));
				sawOldSessionOnRetry = existsSync(join(dir, "session.json"));
				writeFileSync(
					join(dir, "REPORT.md"),
					"```json\n{\"status\":\"ready\",\"summary\":\"第二轮完成\"}\n```\n",
				);
				return makeRun(runTicket, task, seq, ticketDir, {
					report: {
						status: "ready",
						summary: "第二轮完成",
						artifacts: [],
						raw: "第二轮完成",
					},
				});
			}) as never,
		});

		assert.equal(calls, 2, "transient 失败必须重跑一轮");
		assert.equal(sawOldReportOnRetry, false, "重试前必须清掉上一轮 REPORT.md");
		assert.equal(sawOldSessionOnRetry, false, "重试前必须清掉上一轮 session.json");
		assert.equal(runs.length, 1);
		assert.equal(runs[0]?.attempt, 2);
		assert.equal(runs[0]?.processOk, true);
		assert.equal(runs[0]?.report?.summary, "第二轮完成");

		const first = JSON.parse(readFileSync(join(taskDir, "attempt-1.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.deepEqual(
			Object.keys(first).sort(),
			["attempt", "class", "durationMs", "exitCode", "queueMs", "seq", "timedOut", "worktreeMs"],
			"attempt 记账只写这几项，不写正文",
		);
		assert.equal(first.seq, 1);
		assert.equal(first.attempt, 1);
		assert.equal(first.class, "transient");
		assert.equal(first.exitCode, 1);
		const second = JSON.parse(readFileSync(join(taskDir, "attempt-2.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(second.attempt, 2);
		assert.equal(second.class, "unknown", "成功一轮没有失败类");
	} finally {
		store.close();
		restoreEnv(saved);
		resetSchedulingForTest();
		rmSync(root, { recursive: true, force: true });
	}
});

test("CHANCELLOR_RETRY_ENABLED=false：失败只跑一次，attempt=1", async () => {
	const saved = saveEnv(["CHANCELLOR_SCHEDULER", "CHANCELLOR_RETRY_ENABLED", "CHANCELLOR_LANE_CAPS"]);
	const root = temp("retry-off-runs");
	const store = new Store(root);
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		delete process.env.CHANCELLOR_LANE_CAPS;
		process.env.CHANCELLOR_RETRY_ENABLED = "false";
		resetSchedulingForTest();

		const ticket = makeTicket("T-retry-off", root);
		store.saveTicket(ticket);
		const tasks = [planned(1, "broken")];
		const rows = [taskRow(ticket.id, 1, "broken")];
		for (const row of rows) store.saveTask(row);

		let calls = 0;
		const { runs } = await runScheduledTasks({
			ticket,
			store,
			tasks,
			rows,
			employeeKind: "mercenary",
			emit: () => undefined,
			isolation: "direct",
			maxParallel: 1,
			runner: (async (
				runTicket: Ticket,
				task: PlannedTask,
				seq: number,
				ticketDir: string,
			) => {
				calls += 1;
				return makeRun(runTicket, task, seq, ticketDir, {
					exitCode: 1,
					processOk: false,
					processError: "fetch failed",
					stderrTail: "socket hang up",
				});
			}) as never,
		});

		assert.equal(calls, 1, "开关关掉后不许重试");
		assert.equal(runs[0]?.attempt, 1);
		assert.equal(runs[0]?.failureClass, "transient");
	} finally {
		store.close();
		restoreEnv(saved);
		resetSchedulingForTest();
		rmSync(root, { recursive: true, force: true });
	}
});

test("usage_limit 带几小时 reset：不在进程内等，直接失败并冷却车道", async () => {
	const saved = saveEnv(["CHANCELLOR_SCHEDULER", "CHANCELLOR_RETRY_ENABLED", "CHANCELLOR_LANE_CAPS"]);
	const root = temp("retry-usage-runs");
	const store = new Store(root);
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		delete process.env.CHANCELLOR_RETRY_ENABLED;
		delete process.env.CHANCELLOR_LANE_CAPS;
		resetSchedulingForTest();

		const ticket = makeTicket("T-usage", root);
		store.saveTicket(ticket);
		const tasks = [planned(1, "quota")];
		const rows = [taskRow(ticket.id, 1, "quota")];
		for (const row of rows) store.saveTask(row);

		let calls = 0;
		const startedAt = Date.now();
		const { runs } = await runScheduledTasks({
			ticket,
			store,
			tasks,
			rows,
			employeeKind: "mercenary",
			emit: () => undefined,
			isolation: "direct",
			maxParallel: 1,
			runner: (async (
				runTicket: Ticket,
				task: PlannedTask,
				seq: number,
				ticketDir: string,
			) => {
				calls += 1;
				return makeRun(runTicket, task, seq, ticketDir, {
					exitCode: 1,
					processOk: false,
					processError: "claude-code 报告 is_error=true",
					stderrTail: 'API Error: 429 {"type":"rate_limit_error"} (reset after 3h)',
				});
			}) as never,
		});

		assert.equal(calls, 1, "reset 在几小时后：不在进程内等，也不立即重跑");
		assert.ok(Date.now() - startedAt < 3_000, "不能真的 sleep 到 reset");
		assert.equal(runs[0]?.failureClass, "usage_limit");
		const until = laneCooldown("mercenary");
		assert.ok(until !== null, "额度失败必须冷却整条车道");
		assert.ok(until > Date.now() + 2 * 3_600_000, "冷却截止应接近 resetAt");
	} finally {
		store.close();
		restoreEnv(saved);
		resetSchedulingForTest();
		rmSync(root, { recursive: true, force: true });
	}
});

test("按单隔离：worktree 在非 git 项目回落 direct（串行、不报错）", async () => {
	const saved = saveEnv([
		"CHANCELLOR_SCHEDULER",
		"CHANCELLOR_RETRY_ENABLED",
		"CHANCELLOR_LANE_CAPS",
	]);
	const root = temp("isolation-fallback");
	const store = new Store(root);
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		delete process.env.CHANCELLOR_RETRY_ENABLED;
		delete process.env.CHANCELLOR_LANE_CAPS;
		resetSchedulingForTest();

		const ticket = makeTicket("T-iso-fallback", root);
		store.saveTicket(ticket);
		const tasks = [planned(1, "one"), planned(2, "two")];
		const rows = tasks.map((task, index) => taskRow(ticket.id, index + 1, task.slug));
		for (const row of rows) store.saveTask(row);
		// 没有 vcs / 没有基线提交：isGitProject=false，worktree 请求应回落 direct。
		const project: ProjectRef = {
			id: "p-plain",
			name: "plain",
			rootPath: root,
			vcs: "none",
		};

		let active = 0;
		let maxActive = 0;
		const { runs } = await runScheduledTasks({
			ticket,
			store,
			tasks,
			rows,
			project,
			employeeKind: "mercenary",
			emit: () => undefined,
			isolation: "worktree",
			maxParallel: 2,
			runner: (async (
				runTicket: Ticket,
				task: PlannedTask,
				seq: number,
				ticketDir: string,
			) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				try {
					await new Promise((resolve) => setTimeout(resolve, 40));
					const dir = join(ticketDir, taskDirName(seq, task.slug));
					mkdirSync(dir, { recursive: true });
					writeFileSync(
						join(dir, "REPORT.md"),
						'```json\n{"status":"ready","summary":"完成","artifacts":[]}\n```\n',
					);
					return makeRun(runTicket, task, seq, ticketDir);
				} finally {
					active -= 1;
				}
			}) as never,
		});

		assert.equal(maxActive, 1, "非 git 项目没有副本可并行，必须回落 direct 串行");
		assert.equal(runs.length, 2);
		assert.ok(runs.every((run) => run.processOk), "回落 direct 不该把单判失败");
	} finally {
		store.close();
		restoreEnv(saved);
		resetSchedulingForTest();
		rmSync(root, { recursive: true, force: true });
	}
});
