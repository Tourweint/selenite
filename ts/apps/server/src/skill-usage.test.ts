import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	isSkillStale,
	readSkillUsage,
	recordSkillUse,
	skillUsageEnabled,
} from "./skill-usage.ts";

/**
 * 技能用量账（2026-11-10 批 17 §四）。全程临时文件，不碰真实 `.data/`。
 *
 * 只钉四条：每取一次 +1、lastUsedAt 跟随、开关旁路、stale 只在 >90 天时亮。
 * "永不删除"是纪律不是行为，由 skills-api.ts 的注释守着（删技能仍只走人点的 DELETE）。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-skill-usage-"));
const path = join(root, "skill-usage.json");
const env = { AGENT_SKILL_USAGE_PATH: path } as NodeJS.ProcessEnv;

test.after(() => {
	rmSync(root, { recursive: true, force: true });
});

test("用量计数：每取一次 +1，lastUsedAt 跟随；坏名字不进账", () => {
	const t1 = new Date("2026-06-01T00:00:00.000Z");
	recordSkillUse("daily-brief", t1, env);
	recordSkillUse("daily-brief", new Date("2026-06-02T00:00:00.000Z"), env);
	recordSkillUse("weekly-review", t1, env);

	const usage = readSkillUsage(env);
	assert.equal(usage["daily-brief"]?.count, 2);
	assert.equal(usage["daily-brief"]?.lastUsedAt, "2026-06-02T00:00:00.000Z");
	assert.equal(usage["weekly-review"]?.count, 1);
	assert.equal(usage["not-used"], undefined);
});

test("开关旁路：SKILL_USAGE=false → 不计数，旧账照读", () => {
	const off = { ...env, SKILL_USAGE: "false" } as NodeJS.ProcessEnv;
	assert.equal(skillUsageEnabled(off), false);
	recordSkillUse("daily-brief", new Date("2026-06-03T00:00:00.000Z"), off);
	assert.equal(readSkillUsage(env)["daily-brief"]?.count, 2, "关着时不该 +1");
	assert.equal(skillUsageEnabled({}), true, "缺省开");
});

test("stale：>90 天未用才亮；从没用过以文件 mtime 为基线", () => {
	const now = new Date("2026-06-01T00:00:00.000Z");
	assert.equal(isSkillStale("2026-05-31T00:00:00.000Z", "2020-01-01T00:00:00.000Z", now), false);
	assert.equal(isSkillStale("2026-02-01T00:00:00.000Z", "2026-05-31T00:00:00.000Z", now), true, "用过但超过 90 天");
	assert.equal(isSkillStale(null, "2025-01-01T00:00:00.000Z", now), true, "从没用过、文件又老");
	assert.equal(isSkillStale(null, "2026-05-31T00:00:00.000Z", now), false, "新建技能不 stale");
	assert.equal(isSkillStale("坏时间", "2026-05-31T00:00:00.000Z", now), false, "坏时间不误标");
});
