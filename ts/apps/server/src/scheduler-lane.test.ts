import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	acquireDomain,
	acquireLane,
	FifoGate,
	laneCooldown,
	laneSnapshot,
	recordLaneOutcome,
	resetSchedulingForTest,
	setLaneCooldown,
	type DomainWaitInfo,
	type GateWaitInfo,
	type LaneLease,
} from "../../../packages/chancellor/src/lane.ts";
import { runScheduledTasks } from "../../../packages/chancellor/src/scheduler.ts";
import { taskDirName } from "../../../packages/chancellor/src/dispatch.ts";
import { Store } from "../../../packages/chancellor/src/store.ts";
import type {
	ChancellorEvent,
	PlannedTask,
	ProjectRef,
	Task,
	TaskRun,
	Ticket,
	WorkerKind,
} from "../../../packages/chancellor/src/types.ts";

/**
 * 任务级车道帽 + 同领域串行（2026-11-22 M1a）。
 * 这些都是进程内状态，测试必须自己清闸门并还原 env，避免互相污染。
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

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout ?? "";
}

function gitRepo(): { root: string; head: string } {
	const root = temp("lane-git");
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "test"]);
	writeFileSync(join(root, "base.txt"), "base\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-qm", "init"]);
	return { root, head: git(root, ["rev-parse", "HEAD"]).trim() };
}

function planned(seq: number, slug: string, writes: string[]): PlannedTask {
	return {
		title: slug,
		slug,
		instruction: `写 ${writes.join(",")}`,
		done_when: "文件存在",
		dependsOn: [],
		writes,
	};
}

function taskRow(ticketId: string, dir: string, seq: number, slug: string): Task {
	return {
		ticket_id: ticketId,
		seq,
		slug,
		title: slug,
		dir,
		status: "pending",
		employee: null,
		updated_at: new Date().toISOString(),
	};
}

function makeTicket(id: string, workRoot: string, project: ProjectRef): Ticket {
	return {
		id,
		prompt: "测试",
		status: "dispatching",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		options: { dry: true, maxTasks: 8, workRoot, project },
	};
}

function makeRun(
	ticket: Ticket,
	task: PlannedTask,
	seq: number,
	ticketDir: string,
	employee: WorkerKind,
): TaskRun {
	const dirName = taskDirName(seq, task.slug);
	return {
		ticketId: ticket.id,
		seq,
		task,
		dir: join(ticketDir, dirName),
		dirName,
		employee,
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
	};
}

test("FifoGate：cap=1 时后来者排队，release 按序放行且幂等", async () => {
	const gate = new FifoGate(1);
	const first = await gate.acquire();
	assert.equal(first.granted, true);
	assert.deepEqual(gate.snapshot(), { cap: 1, running: 1, queued: 0 });

	const waits: GateWaitInfo[] = [];
	let secondGranted = false;
	const secondPromise = gate.acquire(0, (info) => waits.push(info)).then((lease) => {
		secondGranted = true;
		return lease;
	});
	// Promise 执行器同步跑：此时已经在队里，不用等微任务。
	assert.equal(secondGranted, false, "容量满时不该立刻放行");
	assert.deepEqual(gate.snapshot(), { cap: 1, running: 1, queued: 1 });
	assert.deepEqual(waits, [{ position: 1, cap: 1, running: 1 }]);

	first.release();
	first.release(); // 幂等：重复释放不能多放一个
	const second = await secondPromise;
	assert.equal(second.granted, true);
	assert.deepEqual(waits, [{ position: 1, cap: 1, running: 1 }], "onWait 只叫一次");
	assert.deepEqual(gate.snapshot(), { cap: 1, running: 1, queued: 0 });

	second.release();
	assert.deepEqual(gate.snapshot(), { cap: 1, running: 0, queued: 0 });
});

test("FifoGate：排队中取消 → granted=false，不占槽也不误放行别人", async () => {
	const gate = new FifoGate(1);
	const first = await gate.acquire();
	const controller = new AbortController();
	const waiting = gate.acquire(0, undefined, controller.signal);
	controller.abort();
	const cancelled = await waiting;
	assert.equal(cancelled.granted, false, "取消的排队者不该拿到槽位");
	assert.deepEqual(gate.snapshot(), { cap: 1, running: 1, queued: 0 }, "取消后应从队列摘掉");

	// 队列里还有一个正常等待者：first 释放后必须直接放它，而不是被取消者占位。
	let granted = false;
	const next = gate.acquire().then((lease) => {
		granted = true;
		return lease;
	});
	assert.equal(granted, false);
	first.release();
	const lease = await next;
	assert.equal(lease.granted, true);
	lease.release();
	assert.deepEqual(gate.snapshot(), { cap: 1, running: 0, queued: 0 });
});

test("acquireDomain：排队中取消不占用领域", async () => {
	const saved = saveEnv(["CHANCELLOR_SCHEDULER", "CHANCELLOR_MAX_ACTIVE_PER_DOMAIN"]);
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		delete process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN;
		resetSchedulingForTest();
		const first = await acquireDomain("shop");
		const controller = new AbortController();
		const waiting = acquireDomain("shop", { signal: controller.signal });
		controller.abort();
		const cancelled = await waiting;
		assert.equal(cancelled.granted, false);
		first.release();
		const next = await acquireDomain("shop");
		assert.equal(next.granted, true, "取消者不能把领域名额一直占着");
		next.release();
	} finally {
		restoreEnv(saved);
		resetSchedulingForTest();
	}
});

test("acquireDomain：同领域串行、不同领域并行、空领域直通", async () => {
	const saved = saveEnv(["CHANCELLOR_SCHEDULER", "CHANCELLOR_MAX_ACTIVE_PER_DOMAIN"]);
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		delete process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN;
		resetSchedulingForTest();

		const shop = await acquireDomain("shop");
		const blog = await acquireDomain("blog");
		assert.equal(shop.granted, true);
		assert.equal(blog.granted, true, "不同领域不该互相排队");

		const waits: DomainWaitInfo[] = [];
		let secondShopGranted = false;
		const secondShop = acquireDomain("shop", { onWait: (info) => waits.push(info) }).then(
			(lease) => {
				secondShopGranted = true;
				return lease;
			},
		);
		assert.equal(secondShopGranted, false, "同领域第二单必须等");
		assert.deepEqual(waits, [{ domain: "shop", position: 1, cap: 1, running: 1 }]);

		shop.release();
		const shop2 = await secondShop;
		assert.equal(shop2.granted, true);

		const empty = await acquireDomain("   ");
		assert.equal(empty.granted, true, "没有分管领域的单不该被领域闸门挡住");

		shop2.release();
		blog.release();
		empty.release();
	} finally {
		restoreEnv(saved);
		resetSchedulingForTest();
	}
});

test("CHANCELLOR_SCHEDULER=false：车道与领域都直通", async () => {
	const saved = saveEnv(["CHANCELLOR_SCHEDULER", "CHANCELLOR_LANE_CAPS"]);
	try {
		process.env.CHANCELLOR_SCHEDULER = "false";
		process.env.CHANCELLOR_LANE_CAPS = "claude-code:1";
		resetSchedulingForTest();

		const lanes: LaneLease[] = [];
		for (let i = 0; i < 3; i += 1) {
			const lease = await acquireLane("claude-code");
			assert.equal(lease.granted, true, "关掉调度层后不该再排队");
			lanes.push(lease);
		}
		assert.deepEqual(laneSnapshot(), [], "直通不该顺手建出闸门");

		const domainA = await acquireDomain("shop");
		const domainB = await acquireDomain("shop");
		assert.equal(domainA.granted, true);
		assert.equal(domainB.granted, true);

		for (const lease of [...lanes, domainA, domainB]) lease.release();
	} finally {
		restoreEnv(saved);
		resetSchedulingForTest();
	}
});

test("调度：claude-code 车道帽 1 时同票两件活串行，并发出 task-waiting", async () => {
	const saved = saveEnv([
		"CHANCELLOR_SCHEDULER",
		"CHANCELLOR_LANE_CAPS",
		"CHANCELLOR_MAX_ACTIVE_PER_DOMAIN",
	]);
	const repo = gitRepo();
	const data = temp("lane-data");
	const root = temp("lane-runs");
	const store = new Store(root);
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		delete process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN;
		process.env.CHANCELLOR_LANE_CAPS = "claude-code:1";
		resetSchedulingForTest();

		const project: ProjectRef = {
			id: "p-lane",
			name: "demo",
			rootPath: repo.root,
			vcs: "git",
			head: repo.head,
			dataDir: data,
		};
		const ticket = makeTicket("T-lane", root, project);
		store.saveTicket(ticket);
		const tasks = [planned(1, "one", ["one.txt"]), planned(2, "two", ["two.txt"])];
		const rows = tasks.map((task, index) =>
			taskRow(
				ticket.id,
				join(store.ticketDir(ticket.id), taskDirName(index + 1, task.slug)),
				index + 1,
				task.slug,
			),
		);
		for (const row of rows) store.saveTask(row);

		let active = 0;
		let maxActive = 0;
		const events: ChancellorEvent[] = [];
		const { runs } = await runScheduledTasks({
			ticket,
			store,
			tasks,
			rows,
			project,
			employeeKind: "claude-code",
			emit: (event) => events.push(event),
			isolation: "worktree",
			maxParallel: 2,
			runner: (async (
				_ticket: Ticket,
				task: PlannedTask,
				seq: number,
				ticketDir: string,
				_signal: unknown,
				_deps: unknown,
				options: { workDir?: string },
			) => {
				const workDir = options.workDir ?? repo.root;
				active += 1;
				maxActive = Math.max(maxActive, active);
				try {
					await new Promise((resolve) => setTimeout(resolve, 120));
					writeFileSync(join(workDir, `${task.slug}.txt`), `${task.slug}\n`);
					return makeRun(ticket, task, seq, ticketDir, "claude-code");
				} finally {
					active -= 1;
				}
			}) as never,
		});

		assert.equal(maxActive, 1, `claude-code 车道帽 1 被绕过：最多同时 ${maxActive} 个`);
		const wait = events.find(
			(event) =>
				event.type === "task-waiting" && (event.waitingOn ?? "").includes("执行器槽位"),
		);
		assert.ok(
			wait,
			`没有发出等车道的 task-waiting：${events.map((event) => event.type).join(",")}`,
		);
		assert.match(wait.waitingOn ?? "", /claude-code 1\/1/);
		assert.equal(wait.message, `等待${wait.waitingOn}`);
		assert.equal(runs.length, 2);
		assert.ok(
			runs.every((run) => run.processOk),
			"两件活都应正常完成",
		);
	} finally {
		store.close();
		restoreEnv(saved);
		resetSchedulingForTest();
		rmSync(data, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
		rmSync(repo.root, { recursive: true, force: true });
	}
});

test("车道冷却：冷却中 granted=false 且带截止时间，到期自动恢复", async () => {
	const saved = saveEnv(["CHANCELLOR_SCHEDULER"]);
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		resetSchedulingForTest();

		const until = Date.now() + 120;
		setLaneCooldown("codex", until);
		assert.equal(laneCooldown("codex"), until);

		const cooling = await acquireLane("codex");
		assert.equal(cooling.granted, false, "冷却期间不该放新 task 进车道");
		assert.equal(cooling.cooldownUntil, until, "要给调用方一个明确的冷却截止时间");
		cooling.release();

		await new Promise((resolve) => setTimeout(resolve, 160));
		assert.equal(laneCooldown("codex"), null, "到期后不再报冷却");
		const open = await acquireLane("codex");
		assert.equal(open.granted, true);
		open.release();
	} finally {
		restoreEnv(saved);
		resetSchedulingForTest();
	}
});

test("车道熔断：连续 3 次失败 → 冷却 5 分钟；成功清零", async () => {
	const saved = saveEnv(["CHANCELLOR_SCHEDULER"]);
	try {
		delete process.env.CHANCELLOR_SCHEDULER;
		resetSchedulingForTest();

		recordLaneOutcome("codex", true);
		recordLaneOutcome("codex", false);
		recordLaneOutcome("codex", false);
		assert.equal(laneCooldown("codex"), null, "两次失败不该熔断");

		recordLaneOutcome("codex", false);
		const until = laneCooldown("codex");
		assert.ok(until !== null, "第三次连续失败必须熔断");
		assert.ok(until > Date.now() + 4 * 60_000, "熔断时长按 5 分钟");
		const blocked = await acquireLane("codex");
		assert.equal(blocked.granted, false);
		assert.equal(blocked.cooldownUntil, until);

		// 成功后计数清零：再过两次失败还不够熔断（新的一段连续失败）。
		resetSchedulingForTest();
		recordLaneOutcome("codex", false);
		recordLaneOutcome("codex", false);
		recordLaneOutcome("codex", true);
		recordLaneOutcome("codex", false);
		recordLaneOutcome("codex", false);
		assert.equal(laneCooldown("codex"), null, "成功必须把连续失败清零");
	} finally {
		restoreEnv(saved);
		resetSchedulingForTest();
	}
});
