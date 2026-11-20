import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LeaseManager } from "../../../packages/chancellor/src/lease.ts";
import {
	collectTaskChanges,
	mergeTaskChanges,
	prepareTaskWorktree,
} from "../../../packages/chancellor/src/isolation.ts";
import { coveredByAny } from "../../../packages/chancellor/src/paths.ts";
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

function temp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `lifediary-${prefix}-`));
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout ?? "";
}

function gitRepo(): { root: string; head: string } {
	const root = temp("git");
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "test"]);
	writeFileSync(join(root, "base.txt"), "base\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-qm", "init"]);
	return { root, head: git(root, ["rev-parse", "HEAD"]).trim() };
}

function planned(seq: number, slug: string, writes: string[], dependsOn: number[] = []): PlannedTask {
	return {
		title: slug,
		slug,
		instruction: `写 ${writes.join(",")}`,
		done_when: "文件存在",
		dependsOn,
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

function makeTicket(id: string, workRoot: string, project?: ProjectRef): Ticket {
	return {
		id,
		prompt: "测试",
		status: "dispatching",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		options: { dry: true, maxTasks: 8, workRoot, ...(project ? { project } : {}) },
	};
}

function makeRun(
	ticket: Ticket,
	task: PlannedTask,
	seq: number,
	ticketDir: string,
	workDir: string,
	reportText = "READY",
): TaskRun {
	const dirName = taskDirName(seq, task.slug);
	const dir = join(ticketDir, dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "REPORT.md"), `\`\`\`json\n${JSON.stringify({
		status: "ready",
		summary: "完成",
		artifacts: [],
	})}\n\`\`\`\n${reportText}`);
	return {
		ticketId: ticket.id,
		seq,
		task,
		dir,
		dirName,
		employee: "mercenary",
		exitCode: 0,
		timedOut: false,
		aborted: false,
		processOk: true,
		processError: null,
		sessionId: null,
		reportExists: true,
		report: { status: "ready", summary: "完成", artifacts: [], raw: reportText },
		reportError: null,
		stderrTail: "",
		workDir,
	};
}

test("租约：同一路径独占，释放后才能再拿", () => {
	const root = temp("lease");
	try {
		const a = new LeaseManager({ dataDir: root, projectId: "p", ticketId: "t1", seq: 1 });
		const b = new LeaseManager({ dataDir: root, projectId: "p", ticketId: "t2", seq: 2 });
		assert.equal(a.acquire(["src/a.ts", "src/b.ts"]).ok, true);
		const blocked = b.acquire(["src/b.ts"]);
		assert.equal(blocked.ok, false);
		assert.equal(blocked.blockedPath, "src/b.ts");
		a.releaseAll();
		assert.equal(b.acquire(["src/b.ts"]).ok, true);
		b.releaseAll();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("worktree：隔离改动检出、按租约合并、冲突不落盘", () => {
	const repo = gitRepo();
	const data = temp("data");
	try {
		const project: ProjectRef = {
			id: "p1",
			name: "demo",
			rootPath: repo.root,
			vcs: "git",
			head: repo.head,
			dataDir: data,
		};
		const worktree = prepareTaskWorktree({
			project: project as ProjectRef & { head: string },
			worktreePath: join(data, "wt"),
		});
		writeFileSync(join(worktree.path, "new.txt"), "hello\n");
		writeFileSync(join(worktree.path, "base.txt"), "changed\n");
		const changes = collectTaskChanges(worktree);
		assert.deepEqual(
			changes.map((change) => change.path).sort(),
			["base.txt", "new.txt"],
		);

		const merged = mergeTaskChanges({ projectRoot: repo.root, worktree, changes });
		assert.deepEqual(merged.conflicts, []);
		assert.equal(readFileSync(join(repo.root, "new.txt"), "utf8"), "hello\n");
		assert.equal(readFileSync(join(repo.root, "base.txt"), "utf8"), "changed\n");

		// 副本建立之后、合并之前，外部改了同一文件：这次合并要判冲突且不写。
		const second = prepareTaskWorktree({
			project: project as ProjectRef & { head: string },
			worktreePath: join(data, "wt2"),
		});
		writeFileSync(join(repo.root, "base.txt"), "outside\n");
		writeFileSync(join(second.path, "base.txt"), "task\n");
		const changes2 = collectTaskChanges(second);
		const conflict = mergeTaskChanges({
			projectRoot: repo.root,
			worktree: second,
			changes: changes2,
		});
		assert.deepEqual(conflict.conflicts, ["base.txt"]);
		assert.equal(readFileSync(join(repo.root, "base.txt"), "utf8"), "outside\n");
	} finally {
		rmSync(data, { recursive: true, force: true });
		rmSync(repo.root, { recursive: true, force: true });
	}
});

test("写集匹配：目录通配覆盖子文件，未声明路径不覆盖", () => {
	assert.equal(coveredByAny(["docs/**"], "docs/a.md"), true);
	assert.equal(coveredByAny(["src/a.ts"], "src/a.ts"), true);
	assert.equal(coveredByAny(["src/a.ts"], "src/b.ts"), false);
	assert.equal(coveredByAny([], "anything"), false);
});

test("调度：依赖感知并行 + 租约等待 + 越权写入判失败", async () => {
	const repo = gitRepo();
	const data = temp("sched-data");
	const root = temp("sched-runs");
	const store = new Store(root);
	const project: ProjectRef = {
		id: "p2",
		name: "demo",
		rootPath: repo.root,
		vcs: "git",
		head: repo.head,
		dataDir: data,
	};
	const ticket = makeTicket("T-sched", root, project);
	store.saveTicket(ticket);
	const tasks = [
		planned(1, "a", ["a.txt"]),
		planned(2, "b", ["b.txt"]),
		planned(3, "c", ["c.txt"]),
		planned(4, "d", ["d.txt"], [1]),
		planned(5, "hack", ["ok.txt"]),
	];
	const rows = tasks.map((task, index) =>
		taskRow(ticket.id, join(store.ticketDir(ticket.id), taskDirName(index + 1, task.slug)), index + 1, task.slug),
	);
	for (const row of rows) store.saveTask(row);

	const events: string[] = [];
	let task1Finished = false;
	let activeCount = 0;
	let maxActive = 0;
	const { runs } = await runScheduledTasks({
		ticket,
		store,
		tasks,
		rows,
		project,
		employeeKind: "mercenary",
		emit: (event) => events.push(event.type),
		isolation: "worktree",
		maxParallel: 3,
		runner: (async (_ticket: Ticket, task: PlannedTask, seq: number, ticketDir: string, _signal: unknown, _deps: unknown, options: { workDir?: string }) => {
			const workDir = options.workDir ?? repo.root;
			activeCount += 1;
			maxActive = Math.max(maxActive, activeCount);
			try {
				// 让并行的任务有重叠，便于观察真正并发。
				await new Promise((resolve) => setTimeout(resolve, 150));
				if (task.slug === "hack") {
					writeFileSync(join(workDir, "hack.txt"), "unauthorized\n");
				} else if (task.slug === "d") {
					// 依赖任务必须看到 seq1 合并后的项目内容。
					const base = readFileSync(join(workDir, "a.txt"), "utf8");
					writeFileSync(join(workDir, "d.txt"), base.toUpperCase());
				} else {
					writeFileSync(join(workDir, `${task.slug}.txt`), `${task.slug}\n`);
				}
				const run = makeRun(ticket, task, seq, ticketDir, workDir, task.slug);
				if (task.slug === "a") task1Finished = true;
				const delay = seq === 1 ? 120 : 0;
				if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
				return run;
			} finally {
				activeCount -= 1;
			}
		}) as never,
	});

	assert.equal(task1Finished, true);
	// worktree 的 git 开销不适合拿总耗时判断并行；直接看同时在跑的任务数。
	assert.ok(maxActive >= 3, `并行没有生效：最多同时 ${maxActive} 个任务`);
	assert.ok(events.includes("task-start"));

	const runByName = new Map(runs.map((run) => [run.task.slug, run]));
	assert.ok(runByName.get("hack")?.failure?.includes("越权"), "未声明写入必须判失败");
	assert.equal(existsSync(join(repo.root, "hack.txt")), false, "越权写入不得合并");
	assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "a\n");
	assert.equal(readFileSync(join(repo.root, "b.txt"), "utf8"), "b\n");
	assert.equal(readFileSync(join(repo.root, "c.txt"), "utf8"), "c\n");
	assert.equal(readFileSync(join(repo.root, "d.txt"), "utf8"), "A\n", "依赖任务要看到前序合并结果");

	rmSync(data, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
	rmSync(repo.root, { recursive: true, force: true });
});

test("调度：同一路径并发写入 → 后来者等待文件，前序释放后继续", async () => {
	const repo = gitRepo();
	const data = temp("wait-data");
	const root = temp("wait-runs");
	const store = new Store(root);
	const project: ProjectRef = {
		id: "p3",
		name: "demo",
		rootPath: repo.root,
		vcs: "git",
		head: repo.head,
		dataDir: data,
	};
	const ticket = makeTicket("T-wait", root, project);
	store.saveTicket(ticket);
	const tasks = [planned(1, "first", ["same.txt"]), planned(2, "second", ["same.txt"])];
	const rows = tasks.map((task, index) =>
		taskRow(ticket.id, join(store.ticketDir(ticket.id), taskDirName(index + 1, task.slug)), index + 1, task.slug),
	);
	for (const row of rows) store.saveTask(row);
	let secondStartedAt = 0;
	let firstFinishedAt = 0;
	const waits: string[] = [];
	const { runs } = await runScheduledTasks({
		ticket,
		store,
		tasks,
		rows,
		project,
		employeeKind: "mercenary",
		emit: (event) => {
			if (event.type === "task-waiting") waits.push(event.waitingOn ?? "");
		},
		isolation: "worktree",
		maxParallel: 3,
		runner: (async (_ticket: Ticket, task: PlannedTask, seq: number, ticketDir: string, _signal: unknown, _deps: unknown, options: { workDir?: string }) => {
			const workDir = options.workDir ?? repo.root;
			if (task.slug === "first") {
				await new Promise((resolve) => setTimeout(resolve, 200));
				writeFileSync(join(workDir, "same.txt"), "first\n");
				firstFinishedAt = Date.now();
			} else {
				secondStartedAt = Date.now();
				writeFileSync(join(workDir, "same.txt"), "second\n");
			}
			return makeRun(ticket, task, seq, ticketDir, workDir);
		}) as never,
	});
	assert.ok(waits.length > 0, "后来者必须经历等待文件");
	assert.ok(secondStartedAt >= firstFinishedAt, "同路径任务必须串行");
	assert.equal(readFileSync(join(repo.root, "same.txt"), "utf8"), "second\n");
	assert.equal(runs.length, 2);
	rmSync(data, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
	rmSync(repo.root, { recursive: true, force: true });
});

