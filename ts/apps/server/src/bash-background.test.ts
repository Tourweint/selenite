import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bashBackgroundEnabled,
	moveToBackground,
	replacedResult,
	summarizeCommand,
	timeoutSecondsFromResult,
} from "./bash-background.ts";

/**
 * bash 超时转后台（任务书 T3 §3.6）。
 *
 * 真起进程的用例故意很短（`node -e "setTimeout(...)"` 300ms），整个文件秒级跑完。
 */

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lh-bg-job-"));
	dirs.push(dir);
	return dir;
}
test.after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("超时识别：只认内核固定文案，且能从 output / diagnostics 两处取到", () => {
	// 形状一：内核把抛错转成 output 文本（bash.js 的 `Command timed out after N seconds`）
	assert.equal(
		timeoutSecondsFromResult({
			isError: true,
			output: [{ type: "text", text: "Command timed out after 1 seconds" }],
		}),
		1,
	);
	// 形状二：纯字符串输出
	assert.equal(timeoutSecondsFromResult({ isError: true, output: "Command timed out after 900 seconds" }), 900);
	// 形状三：诊断里带这句
	assert.equal(
		timeoutSecondsFromResult({
			isError: true,
			output: [],
			diagnostics: [{ message: "Command timed out after 5 seconds" }],
		}),
		5,
	);
	// 失败但不像超时 → null（不把真正的错误转后台再跑一遍）
	assert.equal(timeoutSecondsFromResult({ isError: true, output: "Command exited with code 2" }), null);
	assert.equal(timeoutSecondsFromResult({ isError: true, output: "connection timed out" }), null);
	assert.equal(timeoutSecondsFromResult({ isError: false, output: "ok" }), null);
});

test("开关默认关；摘要把命令压成 ≤120 字", () => {
	assert.equal(bashBackgroundEnabled({}), false);
	assert.equal(bashBackgroundEnabled({ AGENT_BASH_BG_TIMEOUT: "false" }), false);
	assert.equal(bashBackgroundEnabled({ AGENT_BASH_BG_TIMEOUT: "1" }), true);
	assert.equal(bashBackgroundEnabled({ AGENT_BASH_BG_TIMEOUT: "TRUE" }), true);

	const long = `npm run build -- ${"x".repeat(300)}`;
	const summary = summarizeCommand(long);
	assert.ok(summary.length <= 121, `摘要应 ≤120 字，实际 ${summary.length}`);
	assert.equal(summarizeCommand("  a   b  "), "a b");
});

test("转后台：真起进程，完成后 index 落一条（只存摘要，不存完整命令）", async () => {
	const dir = tempDir();
	const command = 'node -e "setTimeout(()=>{},300)"';
	const finished = new Promise<{ exitCode: number | null; status: string }>((resolve) => {
		moveToBackground({
			command,
			cwd: process.cwd(),
			timeoutSeconds: 1,
			dir,
			onFinished: (record) => resolve({ exitCode: record.exitCode ?? null, status: record.status }),
		});
	});

	// 立刻回给模型的文案（不等进程结束）
	const moved = moveToBackground({
		command: 'node -e "setTimeout(()=>{},50)"',
		cwd: process.cwd(),
		timeoutSeconds: 1,
		dir,
	});
	assert.match(moved.message, /已转到后台（任务 bg-/);
	assert.match(moved.message, /别再重复执行同一条命令/);

	const result = await finished;
	assert.equal(result.status, "done");
	assert.equal(result.exitCode, 0);

	const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Array<
		Record<string, unknown>
	>;
	const record = index.find((entry) => entry.id === moved.id);
	assert.ok(record, "index.json 里应有这次转后台的记录");
	assert.ok(index.length >= 2, "两次调用都应落账");
	for (const entry of index) {
		assert.equal(typeof entry.commandSummary, "string");
		assert.ok((entry.commandSummary as string).length <= 121);
		assert.equal("command" in entry, false, "完整命令不许落 index.json");
		assert.ok(typeof entry.startedAt === "string");
	}
});

test("工具结果替换：不回传 isError（否则模型会当成失败重跑）", () => {
	const replacement = replacedResult("已转到后台（任务 bg-x）");
	assert.equal(replacement.isError, false);
	assert.equal(replacement.structuredOutput.exitCode, -1);
	assert.match(replacement.output[0].text, /bg-x/);
});
