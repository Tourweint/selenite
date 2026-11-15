import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "@earendil-works/pi-durable";
import type { DelegationReport } from "./delegation.ts";
import type { PartnerTurnOptions, PartnerTurnResult } from "./partner-runtime.ts";

/**
 * 派活完成即唤醒（2026-11-10 批 29）单测。
 *
 * 全部用可注入的假 deps + 假时钟：不起服务、不调模型。
 * 覆盖：提示词固定字节 / collectPending 语义 / 守卫链四关 / 忙退避超限改重排 /
 * 连续 flush 保险丝 / 失败回队重排 / 队列落盘与启动恢复（2026-11-15 送达兜底 §C）。
 * 先设 env 再动态 import：delegation-wake 会间接拉起 agent 装配链，避免单测写盘。
 */
process.env.MEMORY_ENABLED = "false";
process.env.LLM_PROVIDER = "faux";
// 队列落盘钉到临时目录（懒读 env）：别把单测的入队写进真实服务的 .data/wake-pending.json
const WAKE_QUEUE_FILE = join(tmpdir(), `wake-pending-test-${process.pid}.json`);
process.env.AGENT_WAKE_PENDING_PATH = WAKE_QUEUE_FILE;
beforeEach(() => rmSync(WAKE_QUEUE_FILE, { force: true }));

const {
	buildWakePrompt,
	collectPending,
	delegationWakeEnabled,
	flushDelegationWake,
	resetDelegationWakeState,
	restoreDelegationWakeQueue,
	wakeOnDelegationReport,
} = await import("./delegation-wake.ts");

type WakeDeps = Parameters<typeof wakeOnDelegationReport>[2];

const sleepTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 假时钟：setTimer 只入队，runAll 按到期顺序逐个触发（异步链每步让一个 tick）。 */
class FakeClock {
	private seq = 0;
	private items: { id: number; at: number; fn: () => void }[] = [];
	now = 0;

	setTimer = (fn: () => void, ms: number): unknown => {
		this.seq += 1;
		this.items.push({ id: this.seq, at: this.now + ms, fn });
		return this.seq;
	};

	clearTimer = (handle: unknown): void => {
		this.items = this.items.filter((item) => item.id !== handle);
	};

	get size(): number {
		return this.items.length;
	}

	async runAll(maxSteps = 20_000): Promise<void> {
		for (let step = 0; step < maxSteps; step += 1) {
			// 让 await 链把新定时器登记进来
			await sleepTick();
			if (this.items.length === 0) return;
			this.items.sort((a, b) => a.at - b.at);
			const next = this.items.shift()!;
			this.now = next.at;
			next.fn();
		}
		throw new Error("假时钟没有跑空（可能死循环）");
	}
}

interface TurnCall {
	partnerId: string;
	prompt: string;
	opts: PartnerTurnOptions;
}

function makeDeps(overrides: Partial<NonNullable<WakeDeps>> = {}): {
	deps: NonNullable<WakeDeps>;
	clock: FakeClock;
	calls: TurnCall[];
} {
	const clock = new FakeClock();
	const calls: TurnCall[] = [];
	const deps: NonNullable<WakeDeps> = {
		wakeEnabled: () => true,
		companionsEnabled: () => true,
		partnerIdOfSession: () => "partner-1",
		partnerStatus: () => "active",
		ensureSession: async () => ({ conversation: {} as Conversation }),
		isBusy: async () => false,
		runTurn: async (partnerId, prompt, opts): Promise<PartnerTurnResult> => {
			calls.push({ partnerId, prompt, opts });
			return { ok: true, text: "ok" };
		},
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		...overrides,
	};
	return { deps, clock, calls };
}

function report(ticketId: string, phase: DelegationReport["phase"] = "done"): DelegationReport {
	return { ticketId, domain: "前端", phase, text: `汇报-${ticketId}` };
}

beforeEach(() => {
	resetDelegationWakeState();
	delete process.env.DELEGATION_WAKE_ENABLED;
});

test("buildWakePrompt：固定头逐字、单号截 6 位、多单合并", () => {
	const prompt = buildWakePrompt([
		{ ticketId: "3f2a91ffffff", domain: "前端", phase: "done", text: "示例汇报一" },
		{ ticketId: "8c04d2", domain: "后端", phase: "failed", text: "示例汇报二" },
	]);
	const expected = [
		"[Delegation wake context]",
		"turnAuthority: autonomous",
		"",
		"以下后台任务刚到终态，执行端汇报已写进本会话。逐条接住：",
		"- 完成了：一两句向主人转述结果与落点，不复读执行端原文；",
		"- 失败了：说清原因与下一步建议；",
		"- 需要主人拿主意的：把问题明确提出来。",
		"不要重新派同样的活。没有要补充的就一句话收尾。",
		"",
		"本批终态：",
		"- 单 3f2a91（done）：示例汇报一",
		"- 单 8c04d2（failed）：示例汇报二",
	].join("\n");
	assert.equal(prompt, expected);
	assert.ok(!prompt.includes("3f2a91f"), "单号只取前 6 位");
});

test("buildWakePrompt：带产物指针追加落点行，无指针逐字节同旧（批 31）", () => {
	// 有指针：单行下挂"落点"行
	const withDirs = buildWakePrompt([
		{
			ticketId: "3f2a91ffffff",
			domain: "前端",
			phase: "done",
			text: "示例汇报一",
			productDirs: ["runs/3f2a91/task-1", "runs/3f2a91/task-2"],
		},
	]);
	assert.ok(
		withDirs.includes("- 单 3f2a91（done）：示例汇报一\n  落点：runs/3f2a91/task-1、runs/3f2a91/task-2"),
		"落点行紧跟单行、缩进两格",
	);
	// 无指针：与固定头 + 裸单行的旧形态逐字节一致（既有测试 104 行同款断言兜回归）
	const legacy = buildWakePrompt([
		{ ticketId: "8c04d2", domain: "后端", phase: "failed", text: "示例汇报二" },
	]);
	assert.ok(legacy.endsWith("- 单 8c04d2（failed）：示例汇报二"), "无指针不加落点行");
	assert.ok(!legacy.includes("\n  落点："), "无指针不出现落点续行（固定头里的「落点」二字除外）");
});

test("buildWakePrompt：失败单带续接行（批次二），成功单不加", () => {
	const withResume = buildWakePrompt([
		{
			ticketId: "3f2a91ff-ffff-4fff-8fff-ffffffffffff",
			domain: "前端",
			phase: "failed",
			text: "示例失败汇报",
			resume: {
				id: "3f2a91ff-ffff-4fff-8fff-ffffffffffff",
				conversationId: "task-3f2a91ff-ffff-4fff-8fff-ffffffffffff",
				partialReport: "已完成前两步，第三步类型错误",
			},
		},
	]);
	assert.ok(
		withResume.includes("\n  续接：子单 3f2a91ff-ffff-4fff-8fff-ffffffffffff，子会话 task-3f2a91ff-ffff-4fff-8fff-ffffffffffff 仍在，已知进展：已完成前两步"),
		"续接行带子单号、子会话与部分报告",
	);
	const noResume = buildWakePrompt([
		{ ticketId: "8c04d2", domain: "后端", phase: "done", text: "示例汇报" },
	]);
	assert.ok(!noResume.includes("续接："), "成功单不出现续接行");
});

test("collectPending：取走即清空、同会话合并、跨会话互不串", () => {
	const store = new Map<number, DelegationReport[]>([
		[1, [report("a"), report("b")]],
		[2, [report("c")]],
	]);
	const first = collectPending(store, 1);
	assert.deepEqual(first.map((item) => item.ticketId), ["a", "b"]);
	assert.equal(store.has(1), false, "取走即清空");
	assert.deepEqual(
		collectPending(store, 2).map((item) => item.ticketId),
		["c"],
		"另一会话不受影响",
	);
	assert.deepEqual(collectPending(store, 3), [], "没有 pending → 空数组");
});

test("delegationWakeEnabled：默认开，只有明确 false 才关", () => {
	const env: NodeJS.ProcessEnv = {};
	assert.equal(delegationWakeEnabled(env), true, "不配 = 开");
	env.DELEGATION_WAKE_ENABLED = "false";
	assert.equal(delegationWakeEnabled(env), false);
	env.DELEGATION_WAKE_ENABLED = " FALSE ";
	assert.equal(delegationWakeEnabled(env), false, "大小写与空白不敏感");
	env.DELEGATION_WAKE_ENABLED = "0";
	assert.equal(delegationWakeEnabled(env), true, "0 不是 false（与 partners.ts:40 同口径）");
	env.DELEGATION_WAKE_ENABLED = "bogus";
	assert.equal(delegationWakeEnabled(env), true, "拼错值不误关");
});

test("守卫链四关：任一不过都不排定时器、不跑唤醒轮", async () => {
	// 第一关走真实 env 读法（其余三关注入替身，避免碰真实执事库）
	const cases: Array<{ name: string; overrides: Partial<NonNullable<WakeDeps>> }> = [
		{ name: "开关关", overrides: { wakeEnabled: () => delegationWakeEnabled() } },
		{ name: "COMPANIONS 关", overrides: { companionsEnabled: () => false } },
		{ name: "非 canonical 主会话", overrides: { partnerIdOfSession: () => null } },
		{ name: "partner 停用", overrides: { partnerStatus: () => "stopped" } },
	];
	for (const item of cases) {
		// 只有第一关关 env；其余三关 env 保持开，才能证明是那一关挡下的
		process.env.DELEGATION_WAKE_ENABLED = item.name === "开关关" ? "false" : "true";
		const { deps, clock, calls } = makeDeps(item.overrides);
		wakeOnDelegationReport(7, report("t"), deps);
		assert.equal(clock.size, 0, `${item.name}：不该排定时器`);
		await flushDelegationWake(7, deps);
		assert.equal(calls.length, 0, `${item.name}：不该跑唤醒轮`);
	}
});

test("防抖合并：同会话 2 秒合成一轮，跨会话各跑各的，quiet 显式 false", async () => {
	const { deps, clock, calls } = makeDeps({
		partnerIdOfSession: (conversationId) => `partner-${conversationId}`,
	});
	wakeOnDelegationReport(11, report("t1"), deps);
	wakeOnDelegationReport(11, report("t2", "failed"), deps);
	wakeOnDelegationReport(12, report("t3"), deps);
	assert.equal(clock.size, 2, "同会话只排一个定时器");

	await clock.runAll();
	await sleepTick();
	assert.equal(calls.length, 2, "两个会话各一轮");
	const merged = calls.find((call) => call.partnerId === "partner-11");
	assert.ok(merged?.prompt.includes("单 t1"), "合并里有第一张单");
	assert.ok(merged?.prompt.includes("单 t2"), "合并里有第二张单");
	assert.deepEqual(
		merged?.opts,
		{ authority: "autonomous", quiet: false, sessionMode: "persistent" },
		"唤醒轮必带 quiet=false / autonomous / persistent",
	);
});

test("忙退避：假时钟下超 150 次不再原地等，改重排；连续 3 次重排后放弃并 warn", async () => {
	const { deps, clock, calls } = makeDeps({ isBusy: async () => true });
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (message: string) => {
		warnings.push(String(message));
	};
	try {
		wakeOnDelegationReport(21, report("t"), deps);
		const running = flushDelegationWake(21, deps);
		await clock.runAll();
		await running;
	} finally {
		console.warn = original;
	}
	assert.equal(calls.length, 0, "一直忙 → 不跑唤醒轮");
	assert.ok(
		warnings.some((line) => line.includes("[wake] 会话 21 忙超 5 分钟，改 10 分钟后重试 tickets=1")),
		`耗尽 warn 口径：${warnings.join(" / ")}`,
	);
	assert.ok(
		warnings.some((line) => line.includes("重排 3 次仍未成功（忙退避耗尽），放弃唤醒 tickets=1")),
		"重排 3 次后放弃（2026-11-15 送达兜底 §C，翻案批 29 的耗尽即放弃）",
	);
});

test("保险丝：连续 flush 超过 5 轮就停本链，改重排；重排 3 次后清空", async () => {
	let depsRef: NonNullable<WakeDeps> | null = null;
	const { deps, clock, calls } = makeDeps({
		runTurn: async (partnerId, prompt, opts) => {
			calls.push({ partnerId, prompt, opts });
			// 模拟唤醒轮自己又派了活：跑的同时新汇报继续落 pending
			wakeOnDelegationReport(31, report(`t${calls.length}`), depsRef!);
			return { ok: true, text: "ok" };
		},
	});
	depsRef = deps;
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (message: string) => {
		warnings.push(String(message));
	};
	try {
		wakeOnDelegationReport(31, report("seed"), deps);
		await clock.runAll();
	} finally {
		console.warn = original;
	}
	// 每条链 5 轮；重排 3 次（每次又是一条 5 轮链）后放弃 → 4 × 5 = 20 轮
	assert.equal(calls.length, 20, "每链 5 轮 × 首链 + 3 次重排链");
	assert.ok(
		warnings.some((line) => line.includes("连续唤醒超过 5 轮")),
		`保险丝 warn：${warnings.join(" / ")}`,
	);
	assert.ok(
		warnings.some((line) => line.includes("重排 3 次仍未成功（链保险丝）")),
		"重排耗尽后放弃并留一行日志",
	);
	// 清空后不在 pending 里留残货：再 flush 一轮也不该跑
	await flushDelegationWake(31, deps);
	assert.equal(calls.length, 20, "超限后 pending 已清空");
});

test("唤醒轮失败：取走的汇报回灌队首，10 分钟后重排；连续 3 次失败后放弃", async () => {
	const { deps, clock, calls } = makeDeps({
		runTurn: async (partnerId, prompt, opts): Promise<PartnerTurnResult> => {
			calls.push({ partnerId, prompt, opts });
			return { ok: false, text: "", error: "上游炸了" };
		},
	});
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (message: string) => {
		warnings.push(String(message));
	};
	try {
		wakeOnDelegationReport(41, report("t1"), deps);
		wakeOnDelegationReport(41, report("t2"), deps);
		const running = flushDelegationWake(41, deps);
		await clock.runAll();
		await running;
	} finally {
		console.warn = original;
	}
	// 首链 1 轮 + 3 次重排链各 1 轮 = 4 次唤醒尝试，每次都带全部两条
	assert.equal(calls.length, 4, `失败也会重试（2026-11-15 送达兜底 §C.4）`);
	for (const call of calls) {
		assert.ok(call.prompt.includes("t1") && call.prompt.includes("t2"), "回灌后两条都在队首");
	}
	assert.ok(
		warnings.some((line) => line.includes("重排 3 次仍未成功（唤醒轮失败）")),
		`放弃 warn：${warnings.join(" / ")}`,
	);
});

test("队列落盘与启动恢复：入队写文件，restore 读回并重排；坏文件当空", async () => {
	const { deps, clock } = makeDeps();
	wakeOnDelegationReport(51, report("persisted"), deps);
	const raw = JSON.parse(readFileSync(WAKE_QUEUE_FILE, "utf8")) as {
		entries: Array<{ conversationId: number; reports: DelegationReport[] }>;
	};
	assert.equal(raw.entries.length, 1, "入队即落盘");
	assert.equal(raw.entries[0].conversationId, 51);

	// 模拟重启：清内存态后从文件读回
	resetDelegationWakeState();
	const restored = restoreDelegationWakeQueue(deps);
	assert.equal(restored, 1, "读回一条");
	// 恢复后防抖到点会真正跑唤醒轮
	await clock.runAll();

	// 坏文件 / 不存在的文件都当空队列，不抛
	rmSync(WAKE_QUEUE_FILE, { force: true });
	assert.equal(restoreDelegationWakeQueue(deps), 0);
});

test("wakeOnDelegationReport 绝不抛：依赖异常静默返回", () => {
	const { deps } = makeDeps({
		partnerIdOfSession: () => {
			throw new Error("store 挂了");
		},
	});
	assert.doesNotThrow(() => wakeOnDelegationReport(41, report("t"), deps));
});
