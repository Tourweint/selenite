import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MemoryEngine, MemoryRecord } from "@lifediary/memory";
import {
	applyReminderActions,
	illegalReminderActions,
	makeReminderAdviceSaver,
	reminderAdviceEnabled,
	reminderAdvicePath,
	readReminderAdviceSnapshot,
	SAVE_REMINDER_ADVICE_DESCRIPTION,
	sanitizeReminderAdviceItems,
	saveReminderAdviceItems,
	writeReminderAdviceSnapshot,
} from "./reminder-advice.ts";

/**
 * 提醒沉淀 · 建议快照与采纳单测（2026-11-19 批4）。全程临时文件，不碰真实 `.data/`。
 * 钉：清洗（截断/去重/封顶）/ 快照读写往返 / 落盘工具（空输入报错）/ 采纳闸门
 * （原文必须来自快照）/ 采纳写库（remember 同款 taught 偏好 + 去重 + 失败不摘）。
 */

const ROOT = mkdtempSync(join(tmpdir(), "lifediary-reminder-advice-"));
const PATH = join(ROOT, "reminder-advice.json");

test.after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

/** 假记忆引擎：remember 记录写入（可配失败）；browse 回注入的现有 global 偏好。 */
function fakeMemoryEngine(options: { existing?: MemoryRecord[]; failWrite?: boolean; failBrowse?: boolean } = {}) {
	const written: MemoryRecord[] = [];
	const engine = {
		remember(input: { kind: string; content: string; importance: number; source: string }) {
			if (options.failWrite) throw new Error("db locked");
			const rec: MemoryRecord = {
				id: `w${written.length + 1}`,
				kind: input.kind,
				scope: "global",
				content: input.content,
				importance: input.importance,
				veracity: "stated",
				source: input.source,
				createdAt: "2026-11-19T00:00:00.000Z",
				validUntil: null,
				supersededBy: null,
				recallCount: 0,
				lastRecalledAt: null,
			} as MemoryRecord;
			written.push(rec);
			return rec;
		},
		browse() {
			if (options.failBrowse) throw new Error("browse failed");
			return { items: options.existing ?? [], total: (options.existing ?? []).length };
		},
	} as unknown as MemoryEngine;
	return { engine, written };
}

function preference(content: string): MemoryRecord {
	return {
		id: `p${content.length}`,
		kind: "preference",
		scope: "global",
		content,
		importance: 0.7,
		veracity: "stated",
		source: "taught",
		createdAt: "2026-11-18T00:00:00.000Z",
		validUntil: null,
		supersededBy: null,
		recallCount: 0,
		lastRecalledAt: null,
	} as MemoryRecord;
}

test("sanitize：空白丢 / 截 200 / 去重 / 封顶 30 / 非字符串丢", () => {
	assert.deepEqual(sanitizeReminderAdviceItems(["  以后先给结论  ", "以后先给结论", "", "  "]), ["以后先给结论"]);
	assert.deepEqual(sanitizeReminderAdviceItems(["好".repeat(250)]), ["好".repeat(200)]);
	assert.deepEqual(sanitizeReminderAdviceItems(["a", 1, null, "b"]), ["a", "b"]);
	assert.deepEqual(sanitizeReminderAdviceItems("不是数组"), []);
	assert.deepEqual(sanitizeReminderAdviceItems([]), []);
	const thirtyOne = Array.from({ length: 31 }, (_, index) => `条目${index}`);
	assert.equal(sanitizeReminderAdviceItems(thirtyOne).length, 30);
	assert.equal(sanitizeReminderAdviceItems(thirtyOne)[0], "条目0");
});

test("读写往返：整份替换 items，adopted 尾巴保留；坏文件 → null；路径缺省落 .data", () => {
	writeReminderAdviceSnapshot(PATH, {
		generatedAt: "2026-11-18T00:00:00.000Z",
		items: ["旧条目"],
		adopted: ["已采纳过的"],
	});
	saveReminderAdviceItems(PATH, ["合并后的新清单"]);
	const read = readReminderAdviceSnapshot(PATH);
	assert.deepEqual(read?.items, ["合并后的新清单"]);
	assert.deepEqual(read?.adopted, ["已采纳过的"]);
	assert.ok(read?.generatedAt);

	writeFileSync(PATH, "not json", "utf8");
	assert.equal(readReminderAdviceSnapshot(PATH), null);
	assert.equal(existsSync(PATH), true);

	assert.ok(reminderAdvicePath({} as NodeJS.ProcessEnv).endsWith(join(".data", "reminder-advice.json")));
});

test("落盘工具（makeReminderAdviceSaver）：空输入报错带 hint；合法输入回 saved", () => {
	const saver = makeReminderAdviceSaver(PATH);
	const bad = saver([]);
	assert.equal(bad.ok, false);
	if (!bad.ok) {
		assert.equal(bad.error, "no_valid_items");
		assert.match(bad.hint ?? "", /合并/);
	}
	const good = saver(["  以后先给结论  ", "以后先给结论"]);
	assert.deepEqual(good, { ok: true, saved: 1 }, "清洗去重后只剩一条");
	assert.deepEqual(readReminderAdviceSnapshot(PATH)?.items, ["以后先给结论"]);
});

test("采纳闸门：不在快照里的原文一律非法（无快照时全非法）", () => {
	assert.deepEqual(illegalReminderActions([{ text: "不在清单", action: "adopt" }], null), ["不在清单"]);
	writeReminderAdviceSnapshot(PATH, { generatedAt: "t", items: ["以后先给结论"], adopted: [] });
	assert.deepEqual(
		illegalReminderActions(
			[
				{ text: "以后先给结论", action: "adopt" },
				{ text: "伪造的", action: "adopt" },
			],
			readReminderAdviceSnapshot(PATH),
		),
		["伪造的"],
	);
});

test("采纳：adopt 写偏好（preference/global/taught/0.7）+ 摘除 + 进尾巴；dismiss 只摘除", () => {
	saveReminderAdviceItems(PATH, ["以后先给结论", "别再重复提问"]);
	const { engine, written } = fakeMemoryEngine();
	const outcome = applyReminderActions(engine, PATH, [
		{ text: "以后先给结论", action: "adopt" },
		{ text: "别再重复提问", action: "dismiss" },
	]);
	assert.ok(!("error" in outcome));
	assert.equal(outcome.adopted, 1);
	assert.equal(outcome.dismissed, 1);
	assert.equal(outcome.remaining, 0);
	assert.equal(written.length, 1);
	const record = written[0]!;
	assert.equal(record.kind, "preference");
	assert.equal(record.scope, "global");
	assert.equal(record.source, "taught");
	assert.equal(record.importance, 0.7);
	const after = readReminderAdviceSnapshot(PATH);
	assert.deepEqual(after?.items, []);
	assert.deepEqual(after?.adopted, ["以后先给结论"]);
});

test("采纳去重：库里已有同一句 → 不重复落库，仍从清单摘除、不进尾巴", () => {
	// 前一个用例往 adopted 尾巴写过东西：先清文件，保证本例从干净快照开始
	rmSync(PATH, { force: true });
	const { engine, written } = fakeMemoryEngine({ existing: [preference("汇报先给结论")] });
	saveReminderAdviceItems(PATH, ["汇报先给结论"]);
	const outcome = applyReminderActions(engine, PATH, [{ text: "汇报先给结论", action: "adopt" }]);
	assert.ok(!("error" in outcome));
	assert.equal(outcome.duplicates, 1);
	assert.equal(outcome.adopted, 0);
	assert.equal(written.length, 0);
	assert.deepEqual(readReminderAdviceSnapshot(PATH)?.items, []);
	assert.deepEqual(readReminderAdviceSnapshot(PATH)?.adopted, []);
});

test("采纳去重数据来自 browse：现有偏好读不出（抛异常）也照样落库", () => {
	const { engine, written } = fakeMemoryEngine({ failBrowse: true });
	saveReminderAdviceItems(PATH, ["汇报先给结论"]);
	const outcome = applyReminderActions(engine, PATH, [{ text: "汇报先给结论", action: "adopt" }]);
	assert.ok(!("error" in outcome));
	assert.equal(outcome.adopted, 1);
	assert.equal(written.length, 1);
});

test("采纳失败：单条 remember 抛异常 → 条目留在清单里可重试", () => {
	const { engine } = fakeMemoryEngine({ failWrite: true });
	saveReminderAdviceItems(PATH, ["规矩甲", "规矩乙"]);
	const outcome = applyReminderActions(engine, PATH, [{ text: "规矩甲", action: "adopt" }]);
	assert.ok(!("error" in outcome));
	assert.equal(outcome.adopted, 0);
	assert.deepEqual(readReminderAdviceSnapshot(PATH)?.items, ["规矩甲", "规矩乙"]);
});

test("无快照时采纳 → not_found；引擎为 null 的 dismiss 也能走（不写库）", () => {
	rmSync(PATH, { force: true });
	const { engine, written } = fakeMemoryEngine();
	const missing = applyReminderActions(engine, PATH, [{ text: "任意", action: "dismiss" }]);
	assert.ok("error" in missing);
	assert.equal(missing.error, "not_found");
	saveReminderAdviceItems(PATH, ["只忽略"]);
	const outcome = applyReminderActions(null, PATH, [{ text: "只忽略", action: "dismiss" }]);
	assert.ok(!("error" in outcome));
	assert.equal(outcome.dismissed, 1);
	assert.equal(written.length, 0);
	assert.deepEqual(readReminderAdviceSnapshot(PATH)?.items, []);
});

test("adopted 尾巴封顶 200：最老的被挤掉", () => {
	const tail = Array.from({ length: 200 }, (_, index) => `旧采纳${index}`);
	writeReminderAdviceSnapshot(PATH, { generatedAt: "t", items: [], adopted: tail });
	saveReminderAdviceItems(PATH, ["新条目"]);
	const { engine } = fakeMemoryEngine();
	const outcome = applyReminderActions(engine, PATH, [{ text: "新条目", action: "adopt" }]);
	assert.ok(!("error" in outcome));
	const after = readReminderAdviceSnapshot(PATH);
	assert.equal(after?.adopted.length, 200);
	assert.equal(after?.adopted.at(-1), "新条目");
	assert.equal(after?.adopted[0], "旧采纳1");
});

test("描述原文：写的是建议清单、不写记忆库、采纳是人的动作", () => {
	assert.match(SAVE_REMINDER_ADVICE_DESCRIPTION, /建议清单/);
	assert.match(SAVE_REMINDER_ADVICE_DESCRIPTION, /不写记忆库/);
	assert.match(SAVE_REMINDER_ADVICE_DESCRIPTION, /采纳/);
});

test("开关：REMINDER_DISTILL_ENABLED 缺省开，false / off 关（同一开关管端点与工具）", () => {
	assert.equal(reminderAdviceEnabled({} as NodeJS.ProcessEnv), true);
	assert.equal(reminderAdviceEnabled({ REMINDER_DISTILL_ENABLED: "false" } as NodeJS.ProcessEnv), false);
	assert.equal(reminderAdviceEnabled({ REMINDER_DISTILL_ENABLED: "off" } as NodeJS.ProcessEnv), false);
});
