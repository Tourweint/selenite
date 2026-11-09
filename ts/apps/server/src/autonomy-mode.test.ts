import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	autonomyEnabled,
	autonomyMode,
	autonomyRemindAction,
	observeCount24h,
	recordObserve,
} from "./autonomy-mode.ts";

/**
 * 主动性三档与观察记录（2026-11-09 主动性与例行 T2 §1）。
 * 纯函数：不 import autonomy.ts（那条装配链会顺手建库/扫技能目录）。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-autonomy-mode-"));
process.env.AUTONOMY_OBSERVE_PATH = join(root, "autonomy-observe.jsonl");

function withEnv(value: string | undefined, run: () => void): void {
	const previous = process.env.AUTONOMY_ENABLED;
	try {
		if (value === undefined) delete process.env.AUTONOMY_ENABLED;
		else process.env.AUTONOMY_ENABLED = value;
		run();
	} finally {
		if (previous === undefined) delete process.env.AUTONOMY_ENABLED;
		else process.env.AUTONOMY_ENABLED = previous;
	}
}

test("三档判定：缺省 / false / 0 = off；observe = observe；其余非空 = on", () => {
	withEnv(undefined, () => assert.equal(autonomyMode(), "off"));
	for (const value of ["false", "FALSE", "0", "  "]) {
		withEnv(value, () => {
			assert.equal(autonomyMode(), "off", value);
			assert.equal(autonomyEnabled(), false, value);
		});
	}
	withEnv("observe", () => {
		assert.equal(autonomyMode(), "observe");
		assert.equal(autonomyEnabled(), true, "observe 也算启用（订阅照常）");
	});
	for (const value of ["true", "TRUE", "1", "on"]) {
		withEnv(value, () => {
			assert.equal(autonomyMode(), "on", value);
			assert.equal(autonomyEnabled(), true, value);
		});
	}
});

test("提醒分叉：off 跳过、observe 只记账、on 才写会话", () => {
	assert.equal(autonomyRemindAction("off"), "skip");
	assert.equal(autonomyRemindAction("observe"), "observe");
	assert.equal(autonomyRemindAction("on"), "say");
});

test("观察记录：字段固定、不存正文、24h 计数只算窗口内", () => {
	const path = process.env.AUTONOMY_OBSERVE_PATH as string;
	recordObserve({ type: "stuck", conversationId: 7, summary: "任务可能卡住了：超过 10 分钟没有新进展" });
	const line = readFileSync(path, "utf8").trim();
	const record = JSON.parse(line) as Record<string, unknown>;
	assert.equal(record.type, "stuck");
	assert.equal(record.conversationId, 7);
	assert.equal(record.action, "would-remind");
	assert.equal(typeof record.at, "string");
	assert.equal("text" in record, false, "不存对话正文");
	assert.equal(String(record.summary).length <= 140, true);
	assert.equal(observeCount24h(), 1);

	// 窗口外的一条不该计入（直接往文件里补一条 25h 前的记录）
	const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
	writeFileSync(
		path,
		`${readFileSync(path, "utf8")}${JSON.stringify({ at: old, type: "sweep", conversationId: 0, action: "would-remind", summary: "x" })}\n`,
		"utf8",
	);
	assert.equal(observeCount24h(), 1, "25h 前的记录不进 24h 计数");
});
