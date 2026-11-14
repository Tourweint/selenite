import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 每晚整理（2026-11-14）：只测"什么时候跑"和"关掉就不跑"。
 * 真模型 / 真建议不在这里打；那是 memory-api.test.ts 的整理用例。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-memory-nightly-"));
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.LLM_PROVIDER = "faux";
process.env.MEMORY_ENABLED = "true";
process.env.MEMORY_EXTRACT = "rule";
process.env.COMPANIONS_ENABLED = "false";
process.env.MEMORY_NIGHTLY_REVIEW = "false";

const { memoryNightlyEnabled, memoryNightlyAt, nextNightlyAt, runMemoryNightlyReview } = await import(
	"./memory-nightly.ts"
);

function local(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("开关：MEMORY_NIGHTLY_REVIEW=false 视为关闭", () => {
	assert.equal(memoryNightlyEnabled(), false);
});

test("时点：MEMORY_NIGHTLY_AT 非法值回落到 03:30", () => {
	process.env.MEMORY_NIGHTLY_AT = "25:99";
	assert.equal(memoryNightlyAt(), "03:30");
	process.env.MEMORY_NIGHTLY_AT = "4:05";
	assert.equal(memoryNightlyAt(), "04:05");
	delete process.env.MEMORY_NIGHTLY_AT;
	assert.equal(memoryNightlyAt(), "03:30");
});

test("下一班：未到点排今天，过点排明天", () => {
	const before = new Date(2026, 10, 14, 2, 0);
	assert.equal(local(nextNightlyAt(before, "03:30")), "2026-11-14 03:30");

	const after = new Date(2026, 10, 14, 4, 0);
	assert.equal(local(nextNightlyAt(after, "03:30")), "2026-11-15 03:30");
});

test("关掉时 run 直接返回，不落状态文件", async () => {
	await runMemoryNightlyReview(new Date(2026, 10, 14, 3, 30));
	assert.equal(existsSync(join(root, "memory-nightly.json")), false);
});
