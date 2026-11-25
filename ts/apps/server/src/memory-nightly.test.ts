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
process.env.MEMORY_CONSOLIDATE_DIFF_PATH = join(root, "memory-consolidate-diff.json");
// 开关覆盖文件隔离：别读开发机真实 .data/agent-flags.json（2026-11-25）
process.env.AGENT_FLAGS_PATH = join(root, "agent-flags.json");

const { memoryNightlyEnabled, memoryNightlyAt, memoryNightlySplitEnabled, nextNightlyAt, runMemoryNightlyReview } = await import(
	"./memory-nightly.ts"
);
const { memoryEngine } = await import("./agent.ts");

function local(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("开关：MEMORY_NIGHTLY_REVIEW=false 视为关闭", () => {
	assert.equal(memoryNightlyEnabled(), false);
});

test("每晚拆分开关：默认开，false/0/off 关", () => {
	delete process.env.MEMORY_NIGHTLY_SPLIT;
	// 2026-11-25 补真实父闸：MEMORY_NIGHTLY_SPLIT 现在 requires 每晚整理 + 拆分能力。
	// 本文件顶部把 review 置成 false（为了测「关掉不跑」），这里显式打开两个父，
	// 否则子项被父锁成 false，测的就不是它自己的默认值了。
	process.env.MEMORY_NIGHTLY_REVIEW = "true";
	process.env.MEMORY_SPLIT = "true";
	try {
		assert.equal(memoryNightlySplitEnabled(), true);
		for (const value of ["false", "0", "off"]) {
			process.env.MEMORY_NIGHTLY_SPLIT = value;
			assert.equal(memoryNightlySplitEnabled(), false, value);
		}
	} finally {
		delete process.env.MEMORY_NIGHTLY_SPLIT;
		delete process.env.MEMORY_SPLIT;
		process.env.MEMORY_NIGHTLY_REVIEW = "false";
	}
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

test("每晚拆分：没有可用模型也照拆，长记忆变原子、原文进档案", async () => {
	assert.ok(memoryEngine, "记忆引擎应已按 env 建好");
	const long = [
		"2026-11-16 每晚整理合并验收：长记忆先拆成原子，再对账。",
		"拆分是机械动作，不需要模型；没有可用模型时对账跳过，但拆分照跑。",
		"原记录不删除，标记 archivedAt；原文进 memory_documents，原子带 docId 和 quote。",
		"这条记录用来验证每晚任务确实会先拆分，而不是只出对账建议。",
		"拆分必须幂等；同一天再跑不会重复产出原子。",
		"没有可用模型时对账跳过，但拆分和确定性审计仍然要跑完。",
		"每晚状态文件要记下拆分产出的文档数、原子数、归档数和失败数，方便第二天核对。",
		"项目 scope 不在每晚任务里，需要时在项目 tab 手动点拆分记忆。",
	].join("");
	assert.ok(long.length > 200);
	const record = memoryEngine.remember({ kind: "fact", scope: { type: "global" }, content: long, source: "test" });
	process.env.MEMORY_NIGHTLY_REVIEW = "true";
	try {
		await runMemoryNightlyReview(new Date(2026, 10, 15, 3, 30));
	} finally {
		process.env.MEMORY_NIGHTLY_REVIEW = "false";
	}
	const archived = memoryEngine.getRecord(record.id);
	assert.ok(archived?.archivedAt, "长记录应被归档");
	const docs = memoryEngine.listDocuments({ scopes: ["global"] });
	assert.ok(docs.length >= 1, "原文档案应至少有一份");
	assert.ok(
		memoryEngine.list({ scopes: ["global"] }).some((item) => item.docId === archived?.docId),
		"应至少产出一条指向该原文的原子",
	);
	const state = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(root, "memory-nightly.json"), "utf8"))) as {
		lastScopes: Array<{ scope: string; split?: { atoms: number } }>;
	};
	const global = state.lastScopes.find((item) => item.scope === "global");
	assert.ok(global?.split && global.split.atoms > 0, "状态里应记下拆分产出的原子数");
});
