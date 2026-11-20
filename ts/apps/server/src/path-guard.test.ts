import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathGuardBlockReason } from "./path-guard.ts";

/**
 * 多根物理边界（2026-11-12）：工作区根 + 已登记项目根，任一根内放行；
 * 都不在才硬拒。空数组 = 没配任何根，旁路（与旧“未设工作区”同口径）。
 *
 * 2026-11-20 按权限档收口：完全访问旁路；只读 / 在工作区内修改把 read 也圈进根集合；
 * 用户附上来的文件对 read 例外。回滚开关的旧形态也一并钉住。
 */
function withEnv<T>(name: string, value: string | undefined, run: () => T): T {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

test("path-guard：多根内放行、所有根外硬拒、空根集合旁路", () => {
	const base = mkdtempSync(join(tmpdir(), "lh-path-guard-"));
	const workspace = join(base, "ws");
	const outside = join(base, "outside");
	const other = join(base, "other");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(outside, { recursive: true });
	mkdirSync(other, { recursive: true });
	try {
		const roots = [workspace, outside];
		assert.equal(
			pathGuardBlockReason({
				tool: "write",
				args: { path: join(outside, "a.txt") },
				workspaceRoots: roots,
				cwd: workspace,
				access: "no-shell",
			}),
			undefined,
			"已登记的外部项目根应放行",
		);
		assert.equal(
			pathGuardBlockReason({
				tool: "edit",
				args: { path: join(workspace, "b.txt") },
				workspaceRoots: roots,
				cwd: workspace,
				access: "read-only",
			}),
			undefined,
			"工作区根应放行",
		);
		assert.match(
			pathGuardBlockReason({
				tool: "write",
				args: { path: join(other, "c.txt") },
				workspaceRoots: roots,
				cwd: workspace,
				access: "no-shell",
			}) ?? "",
			/不在已登记/,
			"所有根外应硬拒",
		);
		assert.equal(
			pathGuardBlockReason({
				tool: "write",
				args: { path: join(other, "c.txt") },
				workspaceRoots: [],
				cwd: workspace,
				access: "no-shell",
			}),
			undefined,
			"没配任何根时旁路",
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("path-guard：受限两档 read 也限根，回滚开关恢复旧形态", () => {
	const base = mkdtempSync(join(tmpdir(), "lh-path-guard-read-"));
	const workspace = join(base, "ws");
	const other = join(base, "other");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(other, { recursive: true });
	const foreign = join(other, "secret.txt");
	writeFileSync(foreign, "x");
	try {
		const input = {
			tool: "read",
			args: { path: foreign },
			workspaceRoots: [workspace],
			cwd: workspace,
		} as const;
		assert.match(
			pathGuardBlockReason({ ...input, access: "no-shell" }) ?? "",
			/不在已登记/,
			"在工作区内修改档：read 根外硬拒",
		);
		assert.match(
			pathGuardBlockReason({ ...input, access: "read-only" }) ?? "",
			/不在已登记/,
			"只读档：read 根外硬拒（档位保持单调）",
		);
		assert.equal(
			pathGuardBlockReason({ ...input, access: "no-shell", allowedFiles: [foreign] }),
			undefined,
			"用户附上来的文件：read 放行",
		);
		assert.match(
			pathGuardBlockReason({
				tool: "write",
				args: { path: foreign },
				workspaceRoots: [workspace],
				cwd: workspace,
				access: "no-shell",
				allowedFiles: [foreign],
			}) ?? "",
			/不在已登记/,
			"附件例外只给 read，不给 write",
		);
		assert.equal(
			withEnv("AGENT_READ_PATH_GUARD", "0", () =>
				pathGuardBlockReason({ ...input, access: "no-shell" }),
			),
			undefined,
			"AGENT_READ_PATH_GUARD=0 回到 read 不受守",
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("path-guard：完全访问不再过闸门，旧形态可回滚", () => {
	const base = mkdtempSync(join(tmpdir(), "lh-path-guard-full-"));
	const workspace = join(base, "ws");
	const other = join(base, "other");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(other, { recursive: true });
	const foreign = join(other, "outside.txt");
	try {
		const write = {
			tool: "write",
			args: { path: foreign },
			workspaceRoots: [workspace],
			cwd: workspace,
		} as const;
		const read = { ...write, tool: "read" } as const;
		assert.equal(pathGuardBlockReason({ ...write, access: "full" }), undefined, "完全访问：write 根外放行");
		assert.equal(pathGuardBlockReason({ ...read, access: "full" }), undefined, "完全访问：read 根外放行");
		assert.match(
			withEnv("AGENT_FULL_ACCESS_PATH_GUARD", "1", () =>
				pathGuardBlockReason({ ...write, access: "full" }) ?? "",
			),
			/不在已登记/,
			"回滚开关：完全访问仍守 write/edit",
		);
		assert.equal(
			withEnv("AGENT_FULL_ACCESS_PATH_GUARD", "1", () =>
				pathGuardBlockReason({ ...read, access: "full" }),
			),
			undefined,
			"回滚开关只恢复 write/edit 的旧形态，read 仍不限根",
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
