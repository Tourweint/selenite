/**
 * 宰相层验证 3/4：worktree 残留与清理时机（2026-11-08 扫尾批 8a）。
 *
 * 真起一个 git 项目，按 CHANCELLOR_TASK_ISOLATION=worktree 的路径做三件事：
 *   1. 正常完成 —— 进程退出码 0 → 合并 → 立刻删 worktree；
 *   2. 失败 —— worker 进程非 0 退出 → **刻意保留**副本（便于看现场）；
 *      同 seq 再开工时先清旧副本再检出，成功后删掉；
 *   3. 崩溃 —— 子进程在任务中途被杀 → worktree + inflight.json 留着；
 *      下次启动恢复：未合并且 resumeCount=0 → 自动续跑，复用副本，成功后删掉。
 *
 * worker 标签用 pool + 替身 runner（不真起 worker），LLM_PROVIDER=faux，不碰真模型；
 * 拆单（Qoder）刻意跳过，
 * 直接喂 plan —— 本项验的是调度层的副本生命周期，不是拆单。
 *
 *   pnpm --filter @lifediary/server worktree
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverDelegations } from "../../../packages/chancellor/src/index.ts";
import { startInflight, readInflight, inflightPath } from "../../../packages/chancellor/src/inflight.ts";
import { taskDirName } from "../../../packages/chancellor/src/dispatch.ts";
import { runScheduledTasks } from "../../../packages/chancellor/src/scheduler.ts";
import { setPoolClient } from "../../../packages/chancellor/src/employee/pool.ts";
import { Store } from "../../../packages/chancellor/src/store.ts";
import type { PlannedTask, ProjectRef, Task, Ticket, TaskRun } from "../../../packages/chancellor/src/types.ts";

process.env.LLM_PROVIDER = "faux";
process.env.CHANCELLOR_LLM_PROVIDER = "faux";
delete process.env.CHANCELLOR_LLM_API_KEY;
delete process.env.LLM_API_KEY;
process.env.CHANCELLOR_WORKER_TIMEOUT_MS = "60000";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

function makeRepo(dir: string): { root: string; head: string } {
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "probe@example.invalid"]);
	git(dir, ["config", "user.name", "probe"]);
	writeFileSync(join(dir, "base.txt"), "base\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return { root: dir, head: git(dir, ["rev-parse", "HEAD"]).trim() };
}

function makeTicket(id: string, workRoot: string, project: ProjectRef): Ticket {
	const now = new Date().toISOString();
	return {
		id,
		prompt: "探针：worktree 生命周期",
		status: "dispatching",
		created_at: now,
		updated_at: now,
		options: { dry: false, maxTasks: 1, workRoot, project },
		employee: "pool",
	};
}

function planned(seq: number, slug: string, writes: string[]): PlannedTask {
	return {
		title: slug,
		slug,
		instruction: "写一个文件",
		done_when: "文件存在",
		dependsOn: [],
		writes,
	};
}

function rowOf(ticket: Ticket, task: PlannedTask, seq: number): Task {
	return {
		ticket_id: ticket.id,
		seq,
		slug: task.slug,
		title: task.title,
		dir: taskDirName(seq, task.slug),
		status: "pending",
		employee: "pool",
		updated_at: new Date().toISOString(),
	};
}

function worktreeDir(project: ProjectRef, ticketId: string): string {
	return join(project.dataDir!, "worktrees", ticketId, taskDirName(1, "a"));
}

/** 任务中途挂住，等外部杀进程；worktree / inflight / 租约都已经是真的。 */
async function hold(ticket: Ticket, task: PlannedTask, _seq: number, _dir: string, _signal?: AbortSignal, _deps?: unknown, options?: { workDir?: string }): Promise<TaskRun> {
	if (options?.workDir) writeFileSync(join(options.workDir, "partial.txt"), "half\n");
	process.stdout.write("READY\n");
	await new Promise(() => {});
	throw new Error("unreachable");
}

/**
 * 替身池客户端（2026-11-23）：本探针验的是 worktree 生命周期，不是 worker 本体。
 * native 退役后 standalone 进程里没有真池，这里按老 faux env 模拟两条路：
 * - `CHANCELLOR_FAUX_ARTIFACT` 合法 JSON → 写进 run.workDir，返回成功；
 *   不是合法 JSON → 返回失败（第 2 步要的「worker 失败」）。
 * - `CHANCELLOR_FAUX_REPORT` 原样写进 run.dir/REPORT.md（步骤 1 的 blocked 结论）。
 */
function installFakePool(): void {
	setPoolClient({
		async run(run) {
			let artifact: { path?: unknown; content?: unknown };
			try {
				artifact = JSON.parse(process.env.CHANCELLOR_FAUX_ARTIFACT ?? "") as {
					path?: unknown;
					content?: unknown;
				};
			} catch {
				return { ok: false, reason: "faux_artifact_invalid" };
			}
			if (typeof artifact.path !== "string" || typeof artifact.content !== "string") {
				return { ok: false, reason: "faux_artifact_invalid" };
			}
			const workDir = run.workDir || run.dir;
			mkdirSync(workDir, { recursive: true });
			writeFileSync(join(workDir, artifact.path), artifact.content);
			const report = process.env.CHANCELLOR_FAUX_REPORT?.trim();
			if (report) writeFileSync(join(run.dir, "REPORT.md"), `\`\`\`json\n${report}\n\`\`\`\n`);
			return { ok: true, reason: "done" };
		},
		async say() {
			return { ok: true };
		},
		async abort() {
			return { ok: true };
		},
	});
}

async function crashHost(): Promise<void> {
	const root = process.env.PROBE_ROOT!;
	const ticketId = process.env.PROBE_TICKET!;
	const store = new Store(root);
	const project: ProjectRef = {
		id: "p-crash",
		name: "demo",
		rootPath: process.env.PROBE_REPO!,
		vcs: "git",
		head: process.env.PROBE_HEAD!,
		dataDir: process.env.PROBE_DATA!,
	};
	const ticket = makeTicket(ticketId, root, project);
	store.saveTicket(ticket);
	const tasks = [planned(1, "a", ["partial.txt", "a.txt", "REPORT.md"])];
	writeFileSync(join(store.ticketDir(ticketId), "plan.json"), JSON.stringify({ tasks }));
	for (const [index, task] of tasks.entries()) store.saveTask(rowOf(ticket, task, index + 1));
	// 与 runChancellor 收单后一致：先落进行中标记，再进调度。
	startInflight(store.ticketDir(ticketId), ticket.id);
	await runScheduledTasks({
		ticket,
		store,
		tasks,
		rows: tasks.map((task, index) => rowOf(ticket, task, index + 1)),
		project,
		employeeKind: "pool",
		emit: () => {},
		isolation: "worktree",
		runner: hold as never,
	});
}

async function main(): Promise<void> {
	installFakePool();
	const TEMP = mkdtempSync(join(tmpdir(), "lifediary-worktree-"));
	const env = { ...process.env };
	const PROJECT = join(TEMP, "repo");
	const repo = makeRepo(PROJECT);
	const DATA = join(TEMP, "data");
	const ROOT = join(TEMP, "runs");
	mkdirSync(ROOT, { recursive: true });

	const project: ProjectRef = {
		id: "p-success",
		name: "demo",
		rootPath: repo.root,
		vcs: "git",
		head: repo.head,
		dataDir: DATA,
	};

	// ── 1. 正常完成 ─────────────────────────────────────
	console.log("[1] 正常完成：进程 0 退出 → 合并 → 删副本");
	const store1 = new Store(ROOT);
	const ticket1 = makeTicket("T-success", ROOT, project);
	store1.saveTicket(ticket1);
	const tasks1 = [planned(1, "a", ["a.txt", "REPORT.md"])];
	const rows1 = tasks1.map((task, index) => rowOf(ticket1, task, index + 1));
	for (const row of rows1) store1.saveTask(row);
	const wt1 = worktreeDir(project, ticket1.id);
	process.env.CHANCELLOR_FAUX_ARTIFACT = JSON.stringify({ path: "a.txt", content: "hello\n" });
	process.env.CHANCELLOR_FAUX_REPORT = JSON.stringify({
		status: "blocked",
		summary: "faux 写完了，等人工确认（探针不需要验收）",
		artifacts: ["a.txt"],
		attention: { question: "探针：确认？", kind: "need_decision" },
	});
	const r1 = await runScheduledTasks({
		ticket: ticket1,
		store: store1,
		tasks: tasks1,
		rows: rows1,
		project,
		employeeKind: "pool",
		emit: () => {},
		isolation: "worktree",
	});
	check(r1.runs[0]?.processOk === true, "worker 进程正常退出", `exit=${r1.runs[0]?.exitCode}`);
	check(!existsSync(wt1), "worktree 已删（成功即清）");
	check(existsSync(join(repo.root, "a.txt")), "产物已合并进项目");

	// ── 2. 失败 ─────────────────────────────────────────
	console.log("\n[2] 失败（worker 非 0 退出）：副本刻意保留，下次开工先清");
	const store2 = new Store(ROOT);
	const ticket2 = makeTicket("T-fail", ROOT, project);
	store2.saveTicket(ticket2);
	const tasks2 = [planned(1, "a", ["a.txt", "REPORT.md"])];
	const rows2 = tasks2.map((task, index) => rowOf(ticket2, task, index + 1));
	for (const row of rows2) store2.saveTask(row);
	const wt2 = worktreeDir(project, ticket2.id);
	process.env.CHANCELLOR_FAUX_ARTIFACT = "{ 这不是 JSON";
	const r2 = await runScheduledTasks({
		ticket: ticket2,
		store: store2,
		tasks: tasks2,
		rows: rows2,
		project,
		employeeKind: "pool",
		emit: () => {},
		isolation: "worktree",
	});
	check(r2.runs[0]?.processOk === false, "worker 进程判失败", `exit=${r2.runs[0]?.exitCode}`);
	check(existsSync(wt2), "失败副本保留（设计如此：看现场）");

	// 同 seq 再开工：prepareTaskWorktree 不是复用就直接 removeWorktree 再检出。
	process.env.CHANCELLOR_FAUX_ARTIFACT = JSON.stringify({ path: "a.txt", content: "retry\n" });
	const task2 = tasks2[0]!;
	const r2b = await runScheduledTasks({
		ticket: ticket2,
		store: store2,
		tasks: tasks2,
		rows: [rowOf(ticket2, task2, 1)],
		project,
		employeeKind: "pool",
		emit: () => {},
		isolation: "worktree",
	});
	check(r2b.runs[0]?.processOk === true, "重跑成功");
	check(!existsSync(wt2), "旧副本先被清、成功后新副本也删掉（无残留）");

	// ── 3. 崩溃 ─────────────────────────────────────────
	console.log("\n[3] 崩溃：中途杀进程 → 副本 + inflight 留着；重启恢复复用并清理");
	const crashRoot = join(TEMP, "crash-runs");
	const crashData = join(TEMP, "crash-data");
	const ticketId = "T-crash";
	const child = spawn(
		process.execPath,
		[fileURLToPath(import.meta.url), "--phase", "crash-host"],
		{
			env: {
				...env,
				PROBE_ROOT: crashRoot,
				PROBE_TICKET: ticketId,
				PROBE_REPO: repo.root,
				PROBE_HEAD: repo.head,
				PROBE_DATA: crashData,
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	let ready = false;
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		if (chunk.includes("READY")) ready = true;
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4000);
	});
	for (let i = 0; i < 100 && !ready; i++) await wait(100);
	const crashWt = join(crashData, "worktrees", ticketId, taskDirName(1, "a"));
	check(ready, "子进程已进到任务中途", stderr.split("\n").filter(Boolean).slice(-1)[0] ?? "");
	check(existsSync(join(crashWt, "partial.txt")), "半成品已在副本里");
	const crashRecord = readInflight(join(crashRoot, ticketId));
	check(Boolean(crashRecord?.worktrees.some((item) => item.path === crashWt)), "inflight 已记下副本路径");

	spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
	await wait(500);
	check(existsSync(crashWt), "杀进程后副本还在（崩溃保留，不即时清理）");
	check(existsSync(inflightPath(join(crashRoot, ticketId))), "inflight.json 还在（恢复的凭据）");

	// 重启：真实恢复路径（auto-before-merge + resumeCount=0）
	process.env.CHANCELLOR_FAUX_ARTIFACT = JSON.stringify({ path: "a.txt", content: "resumed\n" });
	const summary = await recoverDelegations(crashRoot, { log: () => {} });
	check(summary.resumed === 1, "重启后按 cut_off → 自动续跑一次", `resumed=${summary.resumed}`);
	check(!existsSync(crashWt), "续跑成功后副本被删（崩溃残留的最终归宿）");
	check(existsSync(join(crashRoot, "T-crash", "ticket.json")), "ticket 目录仍在（结论可查）");

	// 清理
	for (const dir of [TEMP]) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 临时目录留给系统 */
		}
	}
}

if (process.argv.includes("--phase")) {
	await crashHost();
} else {
	await main();
	console.log(failures === 0 ? "\n✓ worktree 三条路全部符合设计" : `\n✗ 有 ${failures} 项不对`);
	process.exit(failures === 0 ? 0 : 1);
}
