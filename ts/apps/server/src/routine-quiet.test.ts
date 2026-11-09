import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assessRoutineOutput,
	NO_UPDATE_MARKER,
	routineQuietEnabled,
	routineQuietMinChars,
} from "./routine-quiet.ts";

/** 例行轮安静契约（2026-11-09 T2 §2.4）：确定性判定 + 标记剔除 + 回滚开关。 */

function withEnv(patch: Record<string, string | undefined>, run: () => void): void {
	const previous: Record<string, string | undefined> = {};
	for (const key of Object.keys(patch)) previous[key] = process.env[key];
	try {
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("短文本且无数字/链接/日期 → quiet", () => {
	for (const text of ["", "   ", "无事发生", "一切正常。", "no update"]) {
		const verdict = assessRoutineOutput(text);
		assert.equal(verdict.quiet, true, JSON.stringify(text));
	}
});

test("短文本带数字 / 链接 / 日期 → 有内容（不误判）", () => {
	for (const text of [
		"有 3 条新消息",
		"https://example.com",
		"2026-11-09 有发布",
		"11月9日更新",
	]) {
		assert.equal(assessRoutineOutput(text).quiet, false, text);
	}
});

test("长文本 → 照常写（不是 quiet）", () => {
	const long = "这一轮没有发现新情况，但把上周的三项待办都核对了一遍，结论是照旧，不需要你做任何事。";
	assert.equal(assessRoutineOutput(long).quiet, false);
});

test("带 [[no-update]] → quiet，且标记被剔除", () => {
	const verdict = assessRoutineOutput(`好的。${NO_UPDATE_MARKER}`);
	assert.equal(verdict.quiet, true, "模型显式说没更新，一律安静");
	assert.equal(verdict.text.includes(NO_UPDATE_MARKER), false, "标记不写进下游文本");
	assert.equal(verdict.text, "好的。");
});

test("阈值与回滚开关：ROUTINE_QUIET=false 回到旧行为；阈值可调", () => {
	withEnv({ ROUTINE_QUIET: undefined, ROUTINE_QUIET_MIN_CHARS: undefined }, () => {
		assert.equal(routineQuietEnabled(), true, "缺省开");
		assert.equal(routineQuietMinChars(), 40, "缺省 40 字");
	});
	for (const value of ["false", "FALSE", "0", "off"]) {
		withEnv({ ROUTINE_QUIET: value }, () => {
			assert.equal(routineQuietEnabled(), false, value);
		});
	}
	withEnv({ ROUTINE_QUIET_MIN_CHARS: "10" }, () => {
		assert.equal(routineQuietMinChars(), 10);
		assert.equal(assessRoutineOutput("一切正常没有发现问题情况").quiet, false, "阈值调小后短句也算有内容");
	});
	withEnv({ ROUTINE_QUIET_MIN_CHARS: "abc" }, () => {
		assert.equal(routineQuietMinChars(), 40, "非法值回落缺省");
	});
});
