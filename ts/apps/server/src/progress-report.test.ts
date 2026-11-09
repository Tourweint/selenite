import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryScope } from "@lifediary/memory";
import { createTools, type ToolDeps } from "./tools.ts";
import {
	PROGRESS_MAX_PER_RUN,
	PROGRESS_MESSAGE_LIMIT,
	PROGRESS_TOOL_NAME,
	progressCapMessage,
	progressNoticeText,
	progressReportAllowed,
	progressReportEnabled,
	progressRunKey,
	resetProgressState,
	takeProgressSlot,
} from "./progress-report.ts";
import { markTaskSession, resetUnattendedState } from "./unattended.ts";

/**
 * 中途播报单测（2026-11-10 批 13 §三）。
 *
 * 只测纯逻辑与进程内状态：开关 / 上架范围 / 每轮频率闸 / 文案。
 * 真正的 notice 帧送达需要开流，在探针里验（与派单进度同一口径）。
 */

const GLOBAL_SCOPE: MemoryScope = { type: "global" };

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
	return { memory: null, scopeOf: () => GLOBAL_SCOPE, ...over };
}

test("开关：默认开；false/0/off 关", () => {
	assert.equal(progressReportEnabled({}), true);
	assert.equal(progressReportEnabled({ AGENT_PROGRESS_REPORT: "" }), true);
	assert.equal(progressReportEnabled({ AGENT_PROGRESS_REPORT: "false" }), false);
	assert.equal(progressReportEnabled({ AGENT_PROGRESS_REPORT: "0" }), false);
	assert.equal(progressReportEnabled({ AGENT_PROGRESS_REPORT: "off" }), false);
	assert.equal(progressReportEnabled({ AGENT_PROGRESS_REPORT: "true" }), true);
});

test("注册：progressReport=true 才上架；false/缺省都不注册（一行回滚）", () => {
	const on = createTools(deps({ progressReport: true })).map((tool) => tool.name);
	assert.ok(on.includes(PROGRESS_TOOL_NAME));
	const off = createTools(deps({ progressReport: false })).map((tool) => tool.name);
	assert.ok(!off.includes(PROGRESS_TOOL_NAME));
	const absent = createTools(deps()).map((tool) => tool.name);
	assert.ok(!absent.includes(PROGRESS_TOOL_NAME), "不传 deps = 不上架（单测/探针零改动）");
});

test("上架范围：task- 专线允许（主人对话/群会话的判定在 lifecycle）", () => {
	resetUnattendedState();
	assert.equal(progressReportAllowed(987654), false, "没登记的会话不是执事轮");
	markTaskSession(987654);
	assert.equal(progressReportAllowed(987654), true, "task- 专线属于上架范围");
	resetUnattendedState();
});

test("频率闸：同一轮最多 3 条，第 4 条起给引导话术", () => {
	resetProgressState();
	const key = progressRunKey(7, { run: { inputs: ["turn-1"] } });
	assert.equal(takeProgressSlot(7, key).allowed, true);
	assert.equal(takeProgressSlot(7, key).allowed, true);
	assert.equal(takeProgressSlot(7, key).allowed, true);
	const fourth = takeProgressSlot(7, key);
	assert.equal(fourth.allowed, false);
	assert.equal(fourth.used, PROGRESS_MAX_PER_RUN);

	const guidance = progressCapMessage();
	assert.match(guidance, /上限/);
	assert.match(guidance, /合并成一条/);
	assert.doesNotMatch(guidance, /错误/, "超限是引导，不是报错");
});

test("频率闸：换到下一轮就重新计数", () => {
	resetProgressState();
	const first = progressRunKey(8, { run: { inputs: ["turn-a"] } });
	takeProgressSlot(8, first);
	takeProgressSlot(8, first);
	takeProgressSlot(8, first);
	assert.equal(takeProgressSlot(8, first).allowed, false);

	const next = progressRunKey(8, { run: { inputs: ["turn-b"] } });
	assert.notEqual(first, next);
	assert.equal(takeProgressSlot(8, next).allowed, true, "新一轮重新给 3 个名额");
	resetProgressState();
});

test("run 键：与 turn-gate / relay 同口径（inputs[0] 优先，缺省 taskId）", () => {
	assert.equal(progressRunKey(5, { run: { inputs: ["x"], taskId: "t" } }), "5:x");
	assert.equal(progressRunKey(5, { run: { taskId: "t" } }), "5:t");
	assert.equal(progressRunKey(5, null), "5:none");
});

test("文案：notice 前缀 + 200 字上限常量", () => {
	assert.equal(PROGRESS_MESSAGE_LIMIT, 200);
	assert.match(progressNoticeText("正在改第二步"), /^【进度】/);
	assert.match(progressNoticeText("正在改第二步"), /正在改第二步/);
});
