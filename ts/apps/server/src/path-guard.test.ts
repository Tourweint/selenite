import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathGuardBlockReason } from "./path-guard.ts";

/**
 * 多根物理边界（2026-11-12）：工作区根 + 已登记项目根，任一根内放行；
 * 都不在才硬拒。空数组 = 没配任何根，旁路（与旧“未设工作区”同口径）。
 */
test("path-guard：多根内放行、所有根外硬拒、只守 write/edit", () => {
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
			}) ?? "",
			/不在已登记/,
			"所有根外应硬拒",
		);
		assert.equal(
			pathGuardBlockReason({
				tool: "read",
				args: { path: join(other, "c.txt") },
				workspaceRoots: roots,
				cwd: workspace,
			}),
			undefined,
			"read 不在物理边界职责内",
		);
		assert.equal(
			pathGuardBlockReason({
				tool: "write",
				args: { path: join(other, "c.txt") },
				workspaceRoots: [],
				cwd: workspace,
			}),
			undefined,
			"没配任何根时旁路",
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
