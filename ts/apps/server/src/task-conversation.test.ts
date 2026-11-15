import assert from "node:assert/strict";
import { test } from "node:test";
import {
	TASK_BASELINE_START,
	hasTaskBaseline,
	renderTaskBaseline,
	renderTaskConversationPrompt,
	taskAsConversationEnabled,
	taskConversationExternalId,
	taskKeyedBaselineEnabled,
} from "./task-conversation.ts";
import { TASK_CONVERSATION_PREFIX } from "./agent/shared.ts";
import { dispatchOwnerOf, sidebarTaskGroupsEnabled, taskChatTitle } from "./task-chat-owner.ts";

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

// ── 键控基线（2026-11-10 批 21 §四）──────────────────────

test("键控基线：steps + writes 渲染成带起止标记的整块", () => {
	const block = renderTaskBaseline({
		id: "T-abc123",
		steps: ["读 source.txt", " 写 excerpt.txt "],
		writes: ["excerpt.txt", "summary.md"],
	});
	assert.ok(block);
	assert.ok(block!.startsWith(TASK_BASELINE_START));
	assert.ok(block!.includes("1. 读 source.txt"));
	assert.ok(block!.includes("2. 写 excerpt.txt"), "步骤去空白");
	assert.ok(block!.includes("excerpt.txt、summary.md"));
	assert.ok(block!.endsWith("[[/keyed:task:acceptance]]"));
});

test("键控基线：没有 steps / writes 时不写空块", () => {
	assert.equal(renderTaskBaseline({ id: "T-empty" }), null);
	assert.equal(renderTaskBaseline({ id: "T-empty", steps: ["  "], writes: [] }), null);
});

test("键控基线：只认起点标记（幂等，正文被改写也算在）", () => {
	assert.equal(hasTaskBaseline(["随便说两句", `${TASK_BASELINE_START}\n步骤：…`]), true);
	assert.equal(hasTaskBaseline(["随便说两句"]), false);
	assert.equal(hasTaskBaseline([]), false);
});

test("键控基线开关：默认开；false/0/off 才关", () => {
	assert.equal(taskKeyedBaselineEnabled({}), true);
	assert.equal(taskKeyedBaselineEnabled({ TASK_KEYED_BASELINE: "" }), true);
	for (const value of ["false", "FALSE", "0", "off", " off "]) {
		assert.equal(taskKeyedBaselineEnabled({ TASK_KEYED_BASELINE: value }), false, value);
	}
	for (const value of ["true", "1", "on"]) {
		assert.equal(taskKeyedBaselineEnabled({ TASK_KEYED_BASELINE: value }), true, value);
	}
});

// ── 侧栏任务行归属与标题（2026-11-15 侧栏对话按创建者分组）──────────

test("归属：partner- 宿主 → 该执事 uuid；其余 / 解析不到 → 总管", () => {
	assert.deepEqual(dispatchOwnerOf("partner-7f3a-uuid"), {
		dispatchedBy: "7f3a-uuid",
		isPartnerHost: true,
	});
	assert.deepEqual(dispatchOwnerOf("e55807c3-4fac-49fb-a779-0f1816391d12"), {
		dispatchedBy: "chief",
		isPartnerHost: false,
	});
	assert.deepEqual(dispatchOwnerOf(null), { dispatchedBy: "chief", isPartnerHost: false });
	assert.deepEqual(dispatchOwnerOf(""), { dispatchedBy: "chief", isPartnerHost: false });
});

test("标题：需求首行压空格，空则占位，超 60 字截断加省略号", () => {
	const NL = String.fromCharCode(10);
	const TAB = String.fromCharCode(9);
	assert.equal(taskChatTitle(`把登录页按钮对齐${NL}第二行不要`), "把登录页按钮对齐");
	assert.equal(taskChatTitle(`  多   空格${TAB}压掉  `), "多 空格 压掉");
	assert.equal(taskChatTitle(""), "（没有说明）");
	assert.equal(taskChatTitle(`   ${NL}  `), "（没有说明）");
	const long = taskChatTitle("甲".repeat(100));
	assert.equal(long.length, 61, "60 字 + 省略号");
	assert.ok(long.endsWith("…"));
});

test("侧栏分组开关：默认开，只有明确 false/0 才关（拼错值不误关）", () => {
	assert.equal(sidebarTaskGroupsEnabled({}), true, "缺省开");
	assert.equal(sidebarTaskGroupsEnabled({ SIDEBAR_TASK_GROUPS: "false" }), false);
	assert.equal(sidebarTaskGroupsEnabled({ SIDEBAR_TASK_GROUPS: "0" }), false);
	assert.equal(sidebarTaskGroupsEnabled({ SIDEBAR_TASK_GROUPS: "ture" }), true);
	assert.equal(sidebarTaskGroupsEnabled({ SIDEBAR_TASK_GROUPS: "true" }), true);
});
