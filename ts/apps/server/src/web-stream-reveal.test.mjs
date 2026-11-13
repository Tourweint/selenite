import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createRevealClock,
	isIncrementalRevealSource,
	planRevealSchedule,
	segmentRevealUnits,
} from "../web/stream-reveal.js";

/**
 * 流式逐字浮现的纯函数（2026-11-13）。DOM 增量部分只在浏览器里跑，
 * 这里守住最容易回退的三件事：分词不丢字、非追加不播、排期有上限且跨帧接续。
 */

test("segmentRevealUnits：英文按词、中日文按单字、输出不丢字", () => {
	const units = segmentRevealUnits("你好，world!");
	assert.ok(units.includes("你"));
	assert.ok(units.includes("好"));
	assert.ok(units.includes("world"));
	assert.equal(units.join(""), "你好，world!");
});

test("isIncrementalRevealSource：只有纯追加且增量不过大才逐字", () => {
	assert.equal(isIncrementalRevealSource("", "你好"), true);
	assert.equal(isIncrementalRevealSource("你好", "你好，世界"), true);
	assert.equal(isIncrementalRevealSource("你好", "您好"), false, "非前缀（重写/回填）不动画");
	assert.equal(isIncrementalRevealSource("a", "a".repeat(700)), false, "单帧超过 600 字符不动画");
	assert.equal(isIncrementalRevealSource("a", "a"), false, "没增长不排期");
});

test("planRevealSchedule：间隔有上限、队列跨帧接续、时钟停在队尾", () => {
	const clock = createRevealClock();
	const first = planRevealSchedule(clock, 10, 1000);
	assert.ok(first);
	assert.equal(first.count, 10);
	assert.ok(first.interval > 0 && first.interval <= 40);
	assert.ok(first.start >= 1000);
	assert.equal(clock.clock, first.end);

	const second = planRevealSchedule(clock, 10, 1010);
	assert.ok(second);
	assert.ok(second.start >= first.end, "第二批接在第一批最后一个单元之后，不重叠");
	assert.ok(second.interval <= 40, "积压时也只缩短间隔，不加班次");
});
