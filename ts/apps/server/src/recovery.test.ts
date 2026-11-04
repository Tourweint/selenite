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
import { recoverDelegations } from "../../../../../chancellor/src/index.ts";
import { readJson, Store } from "../../../../../chancellor/src/store.ts";
import type { ProjectRef, Ticket } from "../../../../../chancellor/src/types.ts";

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

test("恢复：已终态的清单只清标记", async () => {
	const root = temp("recover-finished");
	try {
		const ticket = makeTicket("t-finished", root, "done");
		saveTicket(ticket);
		const file = writeInflight(root, ticket.id);
		const summary = await recoverDelegations(root);
		assert.equal(summary.finished, 1);
		assert.equal(existsSync(file), false);
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
		const summary = await recoverDelegations(root);
		assert.equal(summary.stillRunning, 1);
		assert.equal(existsSync(file), true, "活着的单不能被当作崩溃");
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
		const summary = await recoverDelegations(root);
		assert.equal(summary.needsYou, 1);
		const current = readJson<Ticket>(join(root, ticket.id, "ticket.json"));
		assert.equal(current?.status, "needs_you");
		assert.match(current?.error ?? "", /崩溃恢复/);
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
		const summary = await recoverDelegations(root);
		assert.equal(summary.needsYou, 1);
		const current = readJson<Ticket>(join(root, ticket.id, "ticket.json"));
		assert.match(current?.error ?? "", /已自动续跑/);
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
		const summary = await recoverDelegations(root);
		assert.equal(summary.needsYou, 1);
		assert.equal(summary.resumed, 0);
		const current = readJson<Ticket>(join(root, ticket.id, "ticket.json"));
		assert.match(current?.error ?? "", /没有可续跑/);
		assert.equal(existsSync(join(root, ticket.id, "inflight.json")), false);
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
		const summary = await recoverDelegations(root);
		assert.equal(summary.unknown, 1);
		assert.equal(existsSync(join(dir, "recovery.json")), true);
		assert.equal(existsSync(join(dir, "inflight.json")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
