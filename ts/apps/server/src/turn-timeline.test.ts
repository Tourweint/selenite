import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	beginTurn,
	readTurnTimeline,
	recordTimelineEvent,
	resetTurnTimelineForTest,
	turnTimelineEnabled,
	turnTimelinePath,
} from "./turn-timeline.ts";

/**
 * 一轮时间线账（2026-11-17）。全程临时文件 + 清空进程内表，不碰真实 .data/。
 * 钉五条：按 internalId 反查单号、显式 turnId 优先、按单号隔离、聚合按序且不泄漏内部 id、
 * 开关旁路 + 坏行容忍。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-turn-timeline-"));
const path = join(root, "turn-timeline.jsonl");
const env = { AGENT_TURN_TIMELINE_PATH: path } as NodeJS.ProcessEnv;
let seq = 0;
/** 每个用例一份独立文件，避免互相看到对方的行。 */
const freshEnv = () =>
	({ AGENT_TURN_TIMELINE_PATH: join(root, `case-${++seq}.jsonl`) }) as NodeJS.ProcessEnv;

test.after(() => {
	resetTurnTimelineForTest();
	rmSync(root, { recursive: true, force: true });
});

test("按 internalId 反查单号，各节点串到同一轮；内部 id 不落对外投影", () => {
	resetTurnTimelineForTest();
	const e = freshEnv();
	beginTurn(42, "turn-aaa");
	recordTimelineEvent({ conversationId: 42, kind: "start" }, e);
	recordTimelineEvent({ conversationId: 42, kind: "tool", name: "bash", ok: true }, e);
	recordTimelineEvent({ conversationId: 42, kind: "gate", name: "policy", ok: false }, e);
	recordTimelineEvent({ conversationId: 42, kind: "usage", count: 1234 }, e);
	recordTimelineEvent({ conversationId: 42, kind: "done", ms: 900, chars: 88 }, e);

	const rows = readTurnTimeline("turn-aaa", e);
	assert.equal(rows.length, 5);
	assert.deepEqual(
		rows.map((r) => r.kind),
		["start", "tool", "gate", "usage", "done"],
	);
	assert.equal(rows[1]?.name, "bash");
	assert.equal(rows[1]?.ok, true);
	assert.equal(rows[2]?.name, "policy");
	assert.equal(rows[3]?.count, 1234);
	assert.equal(rows[4]?.ms, 900);
	assert.equal(rows[4]?.chars, 88);
	// 对外投影绝不带内部 conversationId
	assert.equal("conversationId" in rows[0], false);
});

test("显式 turnId 优先；反查不到（不经 /chat 的轮）跳过", () => {
	resetTurnTimelineForTest();
	const e = freshEnv();
	recordTimelineEvent({ conversationId: 999, kind: "tool", name: "x" }, e); // 未登记 → 跳过
	recordTimelineEvent({ turnId: "turn-explicit", kind: "error", name: "model_error" }, e);
	assert.equal(readTurnTimeline("turn-explicit", e).length, 1);
	assert.equal(readTurnTimeline("turn-aaa", e).length, 0, "别的用例的行不在这份文件");
});

test("按单号隔离：两个会话各自成线，互不串", () => {
	resetTurnTimelineForTest();
	const e = freshEnv();
	beginTurn(7, "turn-A");
	beginTurn(8, "turn-B");
	recordTimelineEvent({ conversationId: 7, kind: "start" }, e);
	recordTimelineEvent({ conversationId: 8, kind: "start" }, e);
	recordTimelineEvent({ conversationId: 8, kind: "tool", name: "read" }, e);
	assert.equal(readTurnTimeline("turn-A", e).length, 1);
	assert.equal(readTurnTimeline("turn-B", e).length, 2);
	assert.equal(readTurnTimeline("turn-missing", e).length, 0);
});

test("开关旁路：TURN_TIMELINE=false → 不写也不登记", () => {
	const off = { ...env, TURN_TIMELINE: "false" } as NodeJS.ProcessEnv;
	assert.equal(turnTimelineEnabled(off), false);
	resetTurnTimelineForTest();
	beginTurn(42, "turn-off");
	recordTimelineEvent({ conversationId: 42, kind: "start" }, off);
	assert.equal(readTurnTimeline("turn-off", env).length, 0, "关着时不该有行");
	assert.equal(turnTimelineEnabled({}), true, "缺省开");
	assert.equal(turnTimelineEnabled({ TURN_TIMELINE: "0" } as NodeJS.ProcessEnv), false);
	assert.equal(turnTimelineEnabled({ TURN_TIMELINE: "off" } as NodeJS.ProcessEnv), false);
});

test("坏行容忍 + 路径缺省 + 登记同一 id 覆盖旧单号", () => {
	const bad = join(root, "bad.jsonl");
	writeFileSync(bad, `not json\n{"n":1,"turnId":"turn-x","kind":"start"}\n`, "utf8");
	const rows = readTurnTimeline("turn-x", { AGENT_TURN_TIMELINE_PATH: bad } as NodeJS.ProcessEnv);
	assert.equal(rows.length, 1, "坏行跳过，好行照读");
	assert.equal(turnTimelinePath({} as NodeJS.ProcessEnv).endsWith("turn-timeline.jsonl"), true);

	resetTurnTimelineForTest();
	beginTurn(5, "old");
	beginTurn(5, "new");
	recordTimelineEvent({ conversationId: 5, kind: "start" }, env);
	assert.equal(readTurnTimeline("old", env).length, 0, "旧单号被覆盖");
	assert.equal(readTurnTimeline("new", env).length, 1);
	// 落盘确实带内部 id（排障用），只是不进投影
	const raw = readFileSync(path, "utf8").trim().split("\n").at(-1);
	assert.equal(JSON.parse(raw!).conversationId, 5);
});
