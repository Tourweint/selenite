import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ASK_USER_OPTION_MAX,
	ASK_USER_QUESTION_MAX,
	createAskUserPending,
	validateAskUserArgs,
} from "./ask-user.ts";
import { approvalStore } from "./approvals.ts";

/**
 * ask_user（2026-11-09 §3）：一次一问、超限直接报错且**不建 pending**。
 * 用 AGENT_APPROVALS_PATH 指到临时目录；pending 是进程内单例，本文件独立进程。
 */
const dir = mkdtempSync(join(tmpdir(), "ask-user-"));
process.env.AGENT_APPROVALS_PATH = join(dir, "approvals.json");

test("ask_user 校验：题长 / 选项数 / 选项长 / recommended 越界", () => {
	assert.equal(
		validateAskUserArgs({ question: "x".repeat(ASK_USER_QUESTION_MAX + 1) }).ok,
		false,
	);
	assert.equal(validateAskUserArgs({ question: "   " }).ok, false);
	assert.equal(
		validateAskUserArgs({ question: "选哪个？", options: ["只有一个"] }).ok,
		false,
	);
	assert.equal(
		validateAskUserArgs({ question: "选哪个？", options: ["a", "b", "c", "d"] }).ok,
		false,
	);
	assert.equal(
		validateAskUserArgs({
			question: "选哪个？",
			options: ["a", "b"],
			recommended: 2,
		}).ok,
		false,
	);
	assert.equal(
		validateAskUserArgs({
			question: "选哪个？",
			options: ["a", "b"],
			recommended: -1,
		}).ok,
		false,
	);
	assert.equal(
		validateAskUserArgs({
			question: "选哪个？",
			options: ["a", "b"],
			recommended: 1,
		}).ok,
		true,
	);
	assert.equal(
		validateAskUserArgs({
			question: "选哪个？",
			options: ["a".repeat(ASK_USER_OPTION_MAX + 1), "b"],
		}).ok,
		false,
	);
	assert.equal(
		validateAskUserArgs({ question: "选哪个？", options: ["a", "a"] }).ok,
		false,
	);
	// 不给选项也行（开放式提问）
	assert.equal(validateAskUserArgs({ question: "你想叫什么名字？" }).ok, true);
});

test("ask_user 落 pending：tool/kind 正确，一次只挂一条；答复后清空", () => {
	const first = createAskUserPending({
		conversationId: 7,
		callId: "call-ask-1",
		args: { question: "走哪条路？", options: ["高速", "国道"], recommended: 1 },
	});
	assert.equal(first.ok, true);
	const pending = approvalStore().pendingOf(7);
	assert.equal(pending.length, 1);
	assert.equal(pending[0]!.tool, "ask_user");
	assert.equal(pending[0]!.kind, "ask_user");
	const summary = JSON.parse(pending[0]!.args) as { question: string; options: string[] };
	assert.equal(summary.question, "走哪条路？");
	assert.deepEqual(summary.options, ["高速", "国道"]);

	// 一次一问：同会话已有 pending 提问 → 第二个不建
	const second = createAskUserPending({
		conversationId: 7,
		callId: "call-ask-2",
		args: { question: "再问一个？" },
	});
	assert.equal(second.ok, false);
	assert.equal(approvalStore().pendingOf(7).length, 1);

	// 校验失败也不建 pending（独立会话，不受上面的"一次一问"影响）
	const invalid = createAskUserPending({
		conversationId: 8,
		callId: "call-ask-3",
		args: { question: "x".repeat(ASK_USER_QUESTION_MAX + 1) },
	});
	assert.equal(invalid.ok, false);
	assert.equal(approvalStore().pendingOf(8).length, 0);

	// 答复：状态 answered，不再是 pending
	const record = approvalStore().answer("call-ask-1", "走国道");
	assert.equal(record?.status, "answered");
	assert.equal(record?.answer, "走国道");
	assert.equal(approvalStore().pendingOf(7).length, 0);
	// 幂等：再答一次不改状态
	assert.equal(approvalStore().answer("call-ask-1", "另说")?.status, "answered");
});

test("清理临时审批库", () => {
	rmSync(dir, { recursive: true, force: true });
});
