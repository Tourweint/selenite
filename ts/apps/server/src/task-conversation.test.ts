import assert from "node:assert/strict";
import { test } from "node:test";
import {
	renderTaskConversationPrompt,
	taskAsConversationEnabled,
	taskConversationExternalId,
} from "./task-conversation.ts";
import { TASK_CONVERSATION_PREFIX } from "./agent/shared.ts";

/**
 * 任务专线（2026-11-08 扫尾批 8g）的纯函数边界。
 *
 * 真实建会话 / 写条目由 `http` 探针（真服务 + faux）覆盖；这里只钉住
 * "外部 id 的形"与"回滚开关"，避免把 harness 拉进单测（会 resume 真实任务）。
 */

test("专线外部 id：task-<票号>，与侧栏隐藏前缀同源", () => {
	const id = taskConversationExternalId("T-abc123");
	assert.equal(id, "task-T-abc123");
	assert.ok(id.startsWith(TASK_CONVERSATION_PREFIX), "必须命中侧栏既有 task- 前缀过滤");
	assert.equal(id.startsWith("task-topic-"), false, "不要和研究回合混成同一族");
});

test("专线提示词：点名单号，且明确无工具 / 回话由系统转交", () => {
	const prompt = renderTaskConversationPrompt("T-abc123");
	assert.match(prompt, /T-abc123/);
	assert.match(prompt, /没有任何工具/);
	assert.match(prompt, /转给执行端/);
});

test("回滚开关：TASK_AS_CONVERSATION=false 时旁路", () => {
	const previous = process.env.TASK_AS_CONVERSATION;
	try {
		delete process.env.TASK_AS_CONVERSATION;
		assert.equal(taskAsConversationEnabled(), true, "缺省开");
		for (const value of ["false", "FALSE", "0", "off", " off "]) {
			process.env.TASK_AS_CONVERSATION = value;
			assert.equal(taskAsConversationEnabled(), false, value);
		}
		for (const value of ["true", "1", "on", ""]) {
			process.env.TASK_AS_CONVERSATION = value;
			assert.equal(taskAsConversationEnabled(), true, value);
		}
	} finally {
		if (previous === undefined) delete process.env.TASK_AS_CONVERSATION;
		else process.env.TASK_AS_CONVERSATION = previous;
	}
});
