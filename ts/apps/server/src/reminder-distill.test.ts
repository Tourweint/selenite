import assert from "node:assert/strict";
import { test } from "node:test";
import {
	collectReminderCandidates,
	collectTaughtCandidates,
	collectUtteranceCandidates,
	collectVerifiedCandidates,
	reminderDistillEnabled,
	reminderPatternsOf,
	renderReminderDistillPrompt,
	splitReminderSentences,
	REMINDER_MAX_CANDIDATES,
	REMINDER_MAX_TAUGHT,
	REMINDER_MAX_UTTERANCES,
	REMINDER_PATTERN_WORDS,
	type ReminderUtterance,
} from "./reminder-distill.ts";
import type { MemoryRecord } from "@lifediary/memory";

/**
 * 提醒沉淀 · 收集端单测（2026-11-19 批4）。收集是纯代码 0 token，
 * 全部断言打在纯函数上：模式词命中 / 切句 / 聚合 / 窗口 / 上限 / 开关回落。
 * 记忆两路（taught / verified）用假引擎喂数组，不起真库。
 */

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0); // 2026-11-19 12:00 UTC

function line(text: string, at: number, role: "user" | "assistant" = "user") {
	return { role, text, at } as const;
}

function fakeEngine(preferences: MemoryRecord[], facts: MemoryRecord[]) {
	return {
		// 与真 MemoryEngine.browse 同口径：默认不返回 superseded（includeSuperseded=false）
		browse(options: { scopes?: string[]; kinds?: string[] }) {
			const wantsPreference = options.kinds?.includes("preference") ?? false;
			const pool = wantsPreference ? preferences : facts;
			const scoped = options.scopes?.length
				? pool.filter((record) => options.scopes!.includes(record.scope))
				: pool;
			const rows = scoped.filter((record) => !record.supersededBy);
			return { items: rows, total: rows.length };
		},
	} as unknown as import("@lifediary/memory").MemoryEngine;
}

test("taught 候选 scope 口径：主人侧键空间都要（remember 工具落 session），partner/project 排除", () => {
	const engine = fakeEngine(
		[
			record({ id: "s1", source: "taught", content: "会话里教的", scope: "session:2" }),
			record({ id: "g1", source: "taught", content: "全局的", scope: "global" }),
			record({ id: "p1", source: "taught", content: "执事的规矩", scope: "partner:xyz" }),
			record({ id: "pr1", source: "taught", content: "项目口径", scope: "project:abc" }),
		],
		[],
	);
	const got = collectTaughtCandidates(engine);
	assert.deepEqual(got.map((item) => item.text).sort(), ["会话里教的", "全局的"]);
});

function record(partial: Partial<MemoryRecord>): MemoryRecord {
	return {
		id: partial.id ?? "r1",
		kind: partial.kind ?? "preference",
		scope: partial.scope ?? "global",
		content: partial.content ?? "",
		importance: partial.importance ?? 0.7,
		veracity: partial.veracity ?? "stated",
		source: partial.source ?? "user",
		createdAt: partial.createdAt ?? "2026-11-18T00:00:00.000Z",
		validUntil: null,
		supersededBy: partial.supersededBy ?? null,
		recallCount: 0,
		lastRecalledAt: null,
		...(partial.archivedAt !== undefined ? { archivedAt: partial.archivedAt } : {}),
	} as MemoryRecord;
}

test("模式词：命中与未命中（含多词命中去重）", () => {
	assert.deepEqual(reminderPatternsOf("以后每天早上先给我发日报"), ["以后"]);
	assert.deepEqual(reminderPatternsOf("记住：别再重复问我要 key"), ["记住", "别再"]);
	assert.deepEqual(reminderPatternsOf("下次别再忘了带伞"), ["下次", "别再"]);
	assert.deepEqual(reminderPatternsOf("今天天气不错"), []);
	assert.equal(reminderPatternsOf("").length, 0);
	assert.equal(REMINDER_PATTERN_WORDS.length, 6);
});

test("切句：换行与中英句读都算边界", () => {
	assert.deepEqual(splitReminderSentences("以后早睡。记住带伞！下次别忘?"), [
		"以后早睡",
		"记住带伞",
		"下次别忘",
	]);
	assert.deepEqual(splitReminderSentences("第一行\n第二行记住我"), ["第一行", "第二行记住我"]);
});

test("聚合：同句原文计数、首末时间、模式词并集；跨行合并", () => {
	const at1 = NOW - 3 * DAY_MS;
	const at2 = NOW - 1 * DAY_MS;
	const got = collectUtteranceCandidates(
		[
			line("以后汇报先给结论。", at1),
			line("以后汇报先给结论", at2), // 末尾句读切掉后同一句
			line("别再重复发提醒", at2),
			line("是我说的，不是提醒", at2),
		],
		NOW,
	);
	assert.equal(got.length, 2);
	const top = got[0]!;
	assert.equal(top.text, "以后汇报先给结论");
	assert.equal(top.count, 2);
	assert.deepEqual(top.patterns, ["以后"]);
	assert.equal(top.firstAt, new Date(at1).toISOString());
	assert.equal(top.lastAt, new Date(at2).toISOString());
});

test("窗口：30 天外的句子不进候选；assistant 的话不算", () => {
	const got = collectUtteranceCandidates(
		[
			line("以后记得备份", NOW - 31 * DAY_MS),
			line("以后记得备份", NOW - 29 * DAY_MS),
			line("以后记得备份", NOW - 1 * DAY_MS, "assistant"),
		],
		NOW,
	);
	assert.equal(got.length, 1);
	assert.equal(got[0]!.count, 1);
});

test("上限：候选原话截到 REMINDER_MAX_UTTERANCES", () => {
	const lines = Array.from({ length: REMINDER_MAX_UTTERANCES + 5 }, (_, index) =>
		line(`以后第${index}件事先洗手`, NOW - index * 60_000),
	);
	const got = collectUtteranceCandidates(lines, NOW);
	assert.equal(got.length, REMINDER_MAX_UTTERANCES);
	// 排序：次数相同按最近出现时间倒序 → 最新的一条在最前
	assert.equal(got[0]!.text, "以后第0件事先洗手");
});

test("超长句整句丢（不歪曲原话）", () => {
	const long = `以后${"很".repeat(300)}重要`;
	assert.equal(collectUtteranceCandidates([line(long, NOW)], NOW).length, 0);
});

test("taught 候选：只收 source=taught 的；非 taught / superseded / archived 都不要", () => {
	const engine = fakeEngine(
		[
			record({ id: "a", source: "taught", content: "汇报先给结论", scope: "global" }),
			record({ id: "b", source: "user", content: "不是教诲", scope: "global" }),
			record({ id: "d", source: "taught", content: "被取代的", scope: "global", supersededBy: "a" }),
			record({ id: "e", source: "taught", content: "拆走的", scope: "global", archivedAt: "2026-11-18T00:00:00.000Z" }),
		],
		[],
	);
	const got = collectTaughtCandidates(engine);
	assert.deepEqual(got.map((item) => item.text), ["汇报先给结论"]);
	assert.equal(got[0]!.kind, "taught");
});

test("verified 候选：只收 source=verified_answer 的 fact；不限 scope", () => {
	const engine = fakeEngine(
		[],
		[
			record({ id: "v1", kind: "fact", source: "verified_answer", content: "问：几点开会？\n答：十点", scope: "session:1" }),
			record({ id: "v2", kind: "fact", source: "extract", content: "普通事实", scope: "global" }),
		],
	);
	const got = collectVerifiedCandidates(engine);
	assert.deepEqual(got.map((item) => item.text), ["问：几点开会？\n答：十点"]);
});

test("引擎为 null / browse 抛异常 → 两段为空，收集不挂", () => {
	assert.deepEqual(collectTaughtCandidates(null), []);
	assert.deepEqual(collectVerifiedCandidates(null), []);
	const boom = {
		browse() {
			throw new Error("db locked");
		},
	} as unknown as import("@lifediary/memory").MemoryEngine;
	assert.deepEqual(collectTaughtCandidates(boom), []);
	assert.deepEqual(collectVerifiedCandidates(boom), []);
});

test("总上限：三段合计 ≤40（20+10+10），payload 带分段计数", () => {
	const utterances = Array.from({ length: 30 }, (_, index) =>
		line(`以后第${index}件事喝水`, NOW - index * 60_000),
	);
	const engine = fakeEngine(
		Array.from({ length: 15 }, (_, index) =>
			record({ id: `t${index}`, source: "taught", content: `规矩${index}`, scope: "global" }),
		),
		Array.from({ length: 15 }, (_, index) =>
			record({ id: `v${index}`, kind: "fact", source: "verified_answer", content: `问答${index}`, scope: "session:1" }),
		),
	);
	const payload = collectReminderCandidates(engine, utterances, NOW);
	assert.equal(payload.counts.utterances, REMINDER_MAX_UTTERANCES);
	assert.equal(payload.counts.taught, REMINDER_MAX_TAUGHT);
	assert.equal(payload.counts.verified, 10);
	assert.ok(
		payload.candidates.length <= REMINDER_MAX_CANDIDATES,
		`候选总数 ${payload.candidates.length} 超上限`,
	);
	assert.equal(payload.windowDays, 30);
});

test("预填提示词：三段标题、模式词、save_reminder_advice 指引都在；空段有占位", () => {
	const payload = collectReminderCandidates(
		fakeEngine([record({ source: "taught", content: "汇报先给结论" })], []),
		[line("以后先给结论", NOW)],
		NOW,
	);
	const prompt = renderReminderDistillPrompt(payload);
	assert.match(prompt, /一、我反复说过的/);
	assert.match(prompt, /二、已经记下的教诲/);
	assert.match(prompt, /三、我亲口确认过的问答/);
	assert.match(prompt, /save_reminder_advice/);
	assert.match(prompt, /以后先给结论/);
	assert.match(prompt, /汇报先给结论/);
	assert.match(prompt, /（这段没收集到内容）/);
	const empty = renderReminderDistillPrompt({
		generatedAt: new Date(NOW).toISOString(),
		windowDays: 30,
		candidates: [],
		counts: { utterances: 0, taught: 0, verified: 0 },
	});
	assert.match(empty, /（这段没收集到内容）/);
});

test("utterance 候选进 prompt 时带出现次数", () => {
	const lines = [line("以后先给结论", NOW), line("以后先给结论", NOW - DAY_MS)];
	const payload = collectReminderCandidates(null, lines, NOW);
	const utterance = payload.candidates.find((item) => item.kind === "utterance") as ReminderUtterance;
	assert.equal(utterance.count, 2);
	const prompt = renderReminderDistillPrompt(payload);
	assert.match(prompt, /"count":2/);
});

test("开关：REMINDER_DISTILL_ENABLED 缺省开，显式 false / 0 / off 关", () => {
	assert.equal(reminderDistillEnabled({} as NodeJS.ProcessEnv), true);
	assert.equal(reminderDistillEnabled({ REMINDER_DISTILL_ENABLED: "false" } as NodeJS.ProcessEnv), false);
	assert.equal(reminderDistillEnabled({ REMINDER_DISTILL_ENABLED: "0" } as NodeJS.ProcessEnv), false);
	assert.equal(reminderDistillEnabled({ REMINDER_DISTILL_ENABLED: " off " } as NodeJS.ProcessEnv), false);
});
