import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StallWatchdog, stallAuditEnabled, stallTimeoutSeconds } from "./watchdog.ts";

/**
 * stream_stalled 看门狗（任务书 T3 §4.4）：
 * - 模拟两分钟无事件 → 一条记录；
 * - 有事件 → 不记。
 * 时钟注入 + 关定时器，测试不睡觉。
 */

const dir = mkdtempSync(join(tmpdir(), "lh-stall-"));
const filePath = join(dir, "stall-audit.jsonl");

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("开关与阈值：缺省开 / 180 秒；非法值回落", () => {
	assert.equal(stallAuditEnabled({}), true);
	assert.equal(stallAuditEnabled({ AGENT_STALL_AUDIT: "off" }), false);
	assert.equal(stallAuditEnabled({ AGENT_STALL_AUDIT: "false" }), false);
	assert.equal(stallTimeoutSeconds({}), 180);
	assert.equal(stallTimeoutSeconds({ AGENT_STALL_TIMEOUT_S: "0" }), 180);
	assert.equal(stallTimeoutSeconds({ AGENT_STALL_TIMEOUT_S: "abc" }), 180);
	assert.equal(stallTimeoutSeconds({ AGENT_STALL_TIMEOUT_S: "60" }), 60);
});

test("两分钟无事件记一条；继续卡着不刷屏；有事件后重新计时", () => {
	const started = Date.UTC(2026, 10, 9, 0, 0, 0);
	let now = started;
	const dog = new StallWatchdog({
		filePath,
		timeoutS: 60,
		startTimer: false,
		now: () => now,
	});

	dog.note(7, "start");
	now += 30_000;
	assert.deepEqual(dog.scan(), [], "30 秒未到阈值，不该记");

	// 超过 60 秒的"两分钟无事件"场景
	now += 90_000;
	const written = dog.scan();
	assert.equal(written.length, 1);
	assert.equal(written[0].conversationId, 7);
	assert.equal(written[0].lastEvent, "start");
	assert.ok(written[0].elapsedMs >= 120_000);

	// 同一段卡死再扫不重复记
	assert.deepEqual(dog.scan(), [], "同一段卡死只记一条");

	// 新事件把计时器拉回来
	dog.note(7, "delta");
	now += 10_000;
	assert.deepEqual(dog.scan(), [], "有新事件后不该记");

	const lines = readFileSync(filePath, "utf8").trim().split("\n");
	assert.equal(lines.length, 1, "同一会话应只有一条审计");
	const record = JSON.parse(lines[0]) as Record<string, unknown>;
	assert.equal(record.conversationId, 7);
	assert.equal(record.lastEvent, "start");
	assert.equal("text" in record, false, "审计不许带对话内容");

	dog.close();
});

test("流结束（finish）后不再记；有事件时不写文件", () => {
	const second = join(dir, "second.jsonl");
	let now = 0;
	const dog = new StallWatchdog({ filePath: second, timeoutS: 60, startTimer: false, now: () => now });
	dog.note(9, "delta");
	dog.finish(9);
	now += 10 * 60_000;
	assert.deepEqual(dog.scan(), []);
	assert.equal(existsSync(second), false, "没有卡死就不该创建审计文件");
	dog.close();
});

test("扩面（2026-11-12）：群回合的 uuid 键照记；数字键与 uuid 键互不干扰", () => {
	const third = join(dir, "third.jsonl");
	let now = 0;
	const dog = new StallWatchdog({ filePath: third, timeoutS: 60, startTimer: false, now: () => now });
	const groupId = "0f4d6c8e-1111-4222-8333-444455556666";

	// 群回合：首帧前先记一笔（"subscribe" = 流已开还没发过帧），再无帧 → 超时记录
	dog.note(groupId, "subscribe");
	now += 90_000;
	const written = dog.scan();
	assert.equal(written.length, 1);
	assert.equal(written[0].conversationId, groupId, "uuid 键原样落账");
	assert.equal(written[0].lastEvent, "subscribe");

	// 同一条流有帧后重新计时；流结束移出跟踪
	dog.note(groupId, "delta");
	now += 10_000;
	assert.deepEqual(dog.scan(), [], "群回合有新帧不该记");
	dog.finish(groupId);
	now += 10 * 60_000;
	assert.deepEqual(dog.scan(), [], "群回合流结束不该再记");

	// 数字键（/chat 内部 id）与 uuid 键并存，各记各的
	dog.note(7, "start");
	dog.note(groupId, "thinking");
	now += 90_000;
	const both = dog.scan();
	assert.equal(both.length, 2, "两个键各自超时各自记");
	assert.deepEqual(
		both.map((record) => record.conversationId).sort(),
		[7, groupId].sort(),
	);

	const lines = readFileSync(third, "utf8").trim().split("\n");
	assert.equal(lines.length, 3, "uuid 键 1 条 + 并存 2 条");
	const parsed = lines.map((line) => JSON.parse(line) as { conversationId: number | string });
	assert.ok(parsed.every((record) => typeof record.conversationId === "number" || typeof record.conversationId === "string"));
	dog.close();
});
