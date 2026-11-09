import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalStore } from "./approvals.ts";
import {
	confirmWorldStateEnabled,
	snapshotPath,
	verifyWorldState,
	worldStateTarget,
} from "./world-state.ts";

/**
 * 批 19 §七：批准后的世界状态重验。纯函数 + 临时文件 + 临时审批库，不碰真实 `.data/`。
 */

test("开关：默认关；只有 1/true/on 才开", () => {
	assert.equal(confirmWorldStateEnabled({} as NodeJS.ProcessEnv), false);
	assert.equal(confirmWorldStateEnabled({ AGENT_CONFIRM_WORLD_STATE: "" } as NodeJS.ProcessEnv), false);
	assert.equal(confirmWorldStateEnabled({ AGENT_CONFIRM_WORLD_STATE: "1" } as NodeJS.ProcessEnv), true);
	assert.equal(confirmWorldStateEnabled({ AGENT_CONFIRM_WORLD_STATE: "TRUE" } as NodeJS.ProcessEnv), true);
	assert.equal(confirmWorldStateEnabled({ AGENT_CONFIRM_WORLD_STATE: "on" } as NodeJS.ProcessEnv), true);
	assert.equal(confirmWorldStateEnabled({ AGENT_CONFIRM_WORLD_STATE: "yes" } as NodeJS.ProcessEnv), false);
});

test("文件未变 → 放行；mtime / size 变了 → 拒绝且文案正确", () => {
	const approved = { path: "/w/a.txt", exists: true, mtimeMs: 1000, size: 12 };
	assert.deepEqual(verifyWorldState(approved, { ...approved }), { ok: true });

	const touched = verifyWorldState(approved, { ...approved, mtimeMs: 1001 });
	assert.equal(touched.ok, false);
	assert.match((touched as { reason: string }).reason, /目标文件在你批准之后变过了，请重新确认/);
	assert.match((touched as { reason: string }).reason, /\/w\/a\.txt/);

	const resized = verifyWorldState(approved, { ...approved, size: 99 });
	assert.equal(resized.ok, false);
});

test("存在性变化：批准时不存在、现在有了 → 拒绝；都不存在 → 放行（允许新建）", () => {
	const absent = { path: "/w/new.txt", exists: false, mtimeMs: -1, size: -1 };
	assert.deepEqual(verifyWorldState(absent, { ...absent }), { ok: true });

	const appeared = verifyWorldState(absent, {
		path: "/w/new.txt",
		exists: true,
		mtimeMs: 1,
		size: 1,
	});
	assert.equal(appeared.ok, false);
	assert.match((appeared as { reason: string }).reason, /刚才不存在，现在有了/);

	const vanished = verifyWorldState(
		{ path: "/w/a.txt", exists: true, mtimeMs: 1, size: 1 },
		{ path: "/w/a.txt", exists: false, mtimeMs: -1, size: -1 },
	);
	assert.equal(vanished.ok, false);
});

test("没有快照 → 放行（与开关关闭同口径，不凭空拒绝）", () => {
	assert.deepEqual(verifyWorldState(undefined, null), { ok: true });
});

test("目标路径只在 write / edit 上有；bash 不假装能验", () => {
	const cwd = process.cwd();
	const before = worldStateTarget("write", { path: "tsconfig.json" }, cwd);
	assert.ok(before?.exists);
	assert.equal(before?.size && before.size > 0, true);
	assert.equal(worldStateTarget("edit", { file_path: "tsconfig.json" }, cwd)?.exists, true);
	assert.equal(worldStateTarget("bash", { command: "echo hi" }, cwd), null);
	assert.equal(worldStateTarget("write", { command: "x" }, cwd), null);
});

test("审批库：批准时刷新快照，放行条目带着它过闸", () => {
	const root = mkdtempSync(join(tmpdir(), "lifediary-world-"));
	const file = join(root, "target.txt");
	writeFileSync(file, "one");
	try {
		const store = new ApprovalStore({ path: join(root, "approvals.json") });
		store.create({
			callId: "c1",
			conversationId: 1,
			tool: "write",
			args: "{}",
			argsHash: "h1",
			timeoutMs: 60_000,
			worldState: snapshotPath(file),
		});
		// 等待期间文件被改：批准时重拍，执行前再拍就会对不上。
		writeFileSync(file, "two");
		store.decide("c1", "approve", false, undefined, snapshotPath(file));
		const grant = store.consumeGrantEntry(1, "write", "h1");
		assert.ok(grant?.worldState?.exists);
		assert.equal(grant?.worldState?.size, 3);

		writeFileSync(file, "three!");
		assert.equal(
			verifyWorldState(grant?.worldState, snapshotPath(file)).ok,
			false,
			"批准之后又改过 → 拒绝",
		);
	} finally {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* Windows 句柄回收延迟 */
		}
	}
});
