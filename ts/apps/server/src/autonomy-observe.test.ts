import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 观察层的 observe 档（2026-11-09 主动性与例行 T2 §1.5）：
 * "本来会提醒"只落一条观察记录，不写会话；off 档零行为；on 档行为不变。
 *
 * 用注入的假 say + 临时路径；不碰真实 .data 与真实会话。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-autonomy-observe-"));
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
process.env.MEMORY_ENABLED = "false";
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.AGENT_APPROVALS_PATH = join(root, "approvals.json");
process.env.PROVIDERS_PATH = join(root, "providers.json");
process.env.AGENT_SKILLS_DIR = join(root, "skills");
process.env.AUTONOMY_STATE_PATH = join(root, "autonomy-state.json");
process.env.AUTONOMY_OBSERVE_PATH = join(root, "autonomy-observe.jsonl");
process.env.LLM_PROVIDER = "faux";

const { AutonomyObserver } = await import("./autonomy.ts");

test("observe：只落一条观察记录，不调用 sayInConversation", () => {
	let says = 0;
	const observer = new AutonomyObserver({
		mode: () => "observe",
		say: async () => {
			says += 1;
		},
	});
	observer.remind({ type: "stuck", conversationId: 7, key: "1000" }, "任务可能卡住了：超过 10 分钟没有新进展");
	assert.equal(says, 0, "observe 分支绝不写会话");

	const lines = readFileSync(process.env.AUTONOMY_OBSERVE_PATH as string, "utf8")
		.split(/\r?\n/)
		.filter(Boolean);
	assert.equal(lines.length, 1, "一条提醒 = 一条观察记录");
	const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
	assert.equal(record.type, "stuck");
	assert.equal(record.conversationId, 7);
	assert.equal(record.action, "would-remind");
	assert.equal(String(record.summary).length <= 140, true, "摘要 ≤140 字");
	assert.equal("text" in record, false, "不存对话正文");

	// 同一事件只记一次（回执去重照常生效，观察档不会自己刷屏）
	observer.remind({ type: "stuck", conversationId: 7, key: "1000" }, "重复事件");
	assert.equal(
		readFileSync(process.env.AUTONOMY_OBSERVE_PATH as string, "utf8").split(/\r?\n/).filter(Boolean).length,
		1,
	);
});

test("off：remind 零行为（不写会话、不记账、不落观察记录）", () => {
	let says = 0;
	const observer = new AutonomyObserver({
		mode: () => "off",
		observe: () => {
			throw new Error("off 档不该记观察记录");
		},
		say: async () => {
			says += 1;
		},
	});
	observer.remind({ type: "errored", conversationId: 9, key: "x" }, "上游出错");
	assert.equal(says, 0);
	assert.deepEqual(observer.snapshot().receipts.receipts, {}, "off 档连账本都不记");
});

test("on：照常写会话（回归：observe 档没有偷走原来的提醒）", async () => {
	const calls: Array<{ conversationId: number; text: string }> = [];
	const observer = new AutonomyObserver({
		mode: () => "on",
		say: async (conversationId, text) => {
			calls.push({ conversationId, text });
		},
	});
	observer.remind({ type: "waiting", conversationId: 12, key: "call-1" }, "有一项工具调用等你批准：bash");
	await Promise.resolve();
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.conversationId, 12);
	assert.match(calls[0]?.text ?? "", /^【需要你】/);
});
