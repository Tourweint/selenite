import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	adviceViewOf,
	illegalAdviceActions,
	parseAdviceResponse,
	pruneAdviceSnapshot,
	readAdviceSnapshot,
	sanitizeAdviceItem,
	skillAdviceEnabled,
	skillAdvicePath,
	writeAdviceSnapshot,
	type AdviceSkillRow,
	renderAdviceUserInput,
} from "./skill-advice.ts";

test("sanitizeAdviceItem：合法条目通过，非法 bucket/frequency 丢弃", () => {
	assert.deepEqual(sanitizeAdviceItem({ bucket: "keep", frequency: "daily", reason: "基础设施" }), {
		bucket: "keep",
		frequency: "daily",
		reason: "基础设施",
	});
	// 紧凑数组形态（批 30 实测：122 条对象形态撑爆 maxTokens，改数组省 2/3 输出）
	assert.deepEqual(sanitizeAdviceItem(["scene", "monthly", "按场景用"]), {
		bucket: "scene",
		frequency: "monthly",
		reason: "按场景用",
	});
	assert.equal(sanitizeAdviceItem(["keep"]), null); // 缺频率
	assert.equal(sanitizeAdviceItem(["buy", "daily", "x"]), null); // 非法 bucket
	assert.equal(sanitizeAdviceItem({ bucket: "buy", frequency: "daily", reason: "x" }), null);
	assert.equal(sanitizeAdviceItem({ bucket: "keep", frequency: "hourly", reason: "x" }), null);
	assert.equal(sanitizeAdviceItem({ bucket: "keep", reason: "x" }), null);
	assert.equal(sanitizeAdviceItem(null), null);
	assert.equal(sanitizeAdviceItem("keep"), null);
	// reason 截到 40 字符，超长不报错
	const long = sanitizeAdviceItem({ bucket: "skip", frequency: "rare", reason: "好".repeat(80) });
	assert.equal(long?.reason.length, 40);
	// reason 缺失 = 空串（不拦截——理由是展示信息，不是判断依据）
	assert.equal(sanitizeAdviceItem({ bucket: "skip", frequency: "rare" })?.reason, "");
});

test("parseAdviceResponse：干净 JSON / markdown 栅栏 / 非法混合 / 整体坏输出", () => {
	const clean = JSON.stringify({
		items: {
			alpha: { bucket: "keep", frequency: "daily", reason: "a" },
			beta: { bucket: "skip", frequency: "rare", reason: "b" },
		},
	});
	const parsed = parseAdviceResponse(clean);
	assert.ok(parsed);
	assert.equal(parsed.alpha?.bucket, "keep");
	assert.equal(parsed.beta?.bucket, "skip");

	// markdown 栅栏包一层也能解析
	const fenced = "```json\n" + clean + "\n```";
	assert.ok(parseAdviceResponse(fenced)?.alpha);

	// 非法条目被丢、合法条目保留
	const mixed = JSON.stringify({
		items: {
			alpha: { bucket: "keep", frequency: "daily", reason: "a" },
			bad: { bucket: "nope", frequency: "daily", reason: "x" },
		},
	});
	const partial = parseAdviceResponse(mixed);
	assert.ok(partial);
	assert.ok(partial.alpha);
	assert.equal(partial.bad, undefined);

	// 整体坏输出：非 JSON / 顶层不是对象 / items 缺失 / 一条合法都没有 → null
	assert.equal(parseAdviceResponse("我说不清楚"), null);
	assert.equal(parseAdviceResponse("[1,2,3]"), null);
	assert.equal(parseAdviceResponse(JSON.stringify({ foo: 1 })), null);
	assert.equal(parseAdviceResponse(JSON.stringify({ items: { bad: { bucket: "x" } } })), null);
	assert.equal(parseAdviceResponse(""), null);
});

test("adviceViewOf：空快照=全部未评估；有快照=差集标注（新增 unevaluated，消失剔除）", () => {
	const empty = adviceViewOf(null, ["a", "b"]);
	assert.equal(empty.generatedAt, null);
	assert.deepEqual(empty.unevaluated, ["a", "b"]);
	assert.deepEqual(empty.items, {});

	const snapshot = {
		generatedAt: "2026-11-10T00:00:00Z",
		model: "p/m",
		items: {
			a: { bucket: "keep" as const, frequency: "daily" as const, reason: "x" },
			gone: { bucket: "skip" as const, frequency: "rare" as const, reason: "y" },
		},
	};
	const view = adviceViewOf(snapshot, ["a", "new"]);
	assert.equal(view.items.a?.bucket, "keep");
	assert.equal(view.items.gone, undefined); // 消失的技能不在视图里
	assert.deepEqual(view.unevaluated, ["new"]);
	assert.equal(view.stale, true); // 有未评估的 = 快照过期

	const fresh = adviceViewOf(snapshot, ["a"]);
	assert.equal(fresh.stale, false);
	assert.deepEqual(fresh.unevaluated, []);
});

test("pruneAdviceSnapshot：清掉已消失技能，保留仍在的", () => {
	const snapshot = {
		generatedAt: "t",
		model: "m",
		items: {
			a: { bucket: "keep" as const, frequency: "daily" as const, reason: "x" },
			gone: { bucket: "skip" as const, frequency: "rare" as const, reason: "y" },
		},
	};
	const pruned = pruneAdviceSnapshot(snapshot, ["a"]);
	assert.deepEqual(Object.keys(pruned.items), ["a"]);
	// 原快照不被改（调用方可能还要用）
	assert.ok(snapshot.items.gone);
});

test("illegalAdviceActions：不在快照的名字报非法；无快照=全部非法", () => {
	const snapshot = {
		generatedAt: "t",
		model: "m",
		items: { a: { bucket: "keep" as const, frequency: "daily" as const, reason: "x" } },
	};
	assert.deepEqual(illegalAdviceActions([{ name: "a", enabled: true }], snapshot), []);
	assert.deepEqual(illegalAdviceActions([{ name: "forge", enabled: true }], snapshot), ["forge"]);
	assert.deepEqual(illegalAdviceActions([{ name: "x", enabled: true }], null), ["x"]);
});

test("readAdviceSnapshot / writeAdviceSnapshot：原子写 + 往返一致 + 坏文件当没有", () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-advice-test-"));
	try {
		const path = join(dir, "nested", "advice.json");
		assert.equal(readAdviceSnapshot(path), null); // 不存在 = null
		const snapshot = {
			generatedAt: "2026-11-10T01:02:03Z",
			model: "p/m",
			items: { a: { bucket: "scene" as const, frequency: "monthly" as const, reason: "场景" } },
		};
		writeAdviceSnapshot(path, snapshot);
		assert.ok(existsSync(path));
		const back = readAdviceSnapshot(path);
		assert.deepEqual(back, snapshot);

		// 坏 JSON / 非 JSON：当没有快照
		writeFileSync(path, "not json", "utf8");
		assert.equal(readAdviceSnapshot(path), null);
		// 旧形状（items 里混非法条目）也能读，非法条目被清洗掉
		writeFileSync(
			path,
			JSON.stringify({
				generatedAt: "t",
				model: "m",
				items: { a: { bucket: "keep", frequency: "daily", reason: "ok" }, bad: { bucket: "???" } },
			}),
			"utf8",
		);
		const cleaned = readAdviceSnapshot(path);
		assert.deepEqual(Object.keys(cleaned?.items ?? {}), ["a"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("skillAdvicePath / skillAdviceEnabled：env 覆盖与回滚开关", () => {
	assert.equal(skillAdviceEnabled({ SKILL_ADVICE: "false" }), false);
	assert.equal(skillAdviceEnabled({ SKILL_ADVICE: "0" }), false);
	assert.equal(skillAdviceEnabled({ SKILL_ADVICE: "off" }), false);
	assert.equal(skillAdviceEnabled({}), true);
	assert.equal(skillAdviceEnabled({ SKILL_ADVICE: "true" }), true);
	assert.match(skillAdvicePath({}), /skills-advice\.json$/);
	const custom = skillAdvicePath({ AGENT_SKILLS_ADVICE_PATH: "D:/x/y.json" });
	assert.match(custom, /y\.json$/);
});

test("renderAdviceUserInput：每行一条 JSON，summary 截 200 字", () => {
	const rows: AdviceSkillRow[] = [
		{ name: "alpha", summary: "好".repeat(300), enabled: true, usageCount: 5, stale: false, origin: "agents" },
		{ name: "beta", summary: "短", enabled: false, usageCount: null, stale: true, origin: "user" },
	];
	const text = renderAdviceUserInput(rows);
	const lines = text.split("\n").filter((line) => line.startsWith("{\"name\""));
	assert.equal(lines.length, 2);
	const first = JSON.parse(lines[0]) as { summary: string };
	assert.equal(first.summary.length, 200);
	const second = JSON.parse(lines[1]) as { usageCount: number | null };
	assert.equal(second.usageCount, null);
});
