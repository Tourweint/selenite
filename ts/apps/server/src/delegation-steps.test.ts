import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DELEGATION_STEPS_MAX,
	DELEGATION_STEP_MAX_CHARS,
	normalizeDelegationIsolation,
	normalizeDelegationSteps,
	startDelegation,
} from "./delegation.ts";
import { runChancellor } from "../../../packages/chancellor/src/index.ts";
import { intake } from "../../../packages/chancellor/src/intake.ts";
import { appendPlanSteps } from "../../../packages/chancellor/src/plan.ts";
import { Store } from "../../../packages/chancellor/src/store.ts";
import { resetDelegationMessages } from "./delegation-messages.ts";
import type {
	ChancellorEvent,
	ChancellorRequest,
	Ticket,
	TicketResult,
} from "../../../packages/chancellor/src/types.ts";

/**
 * 计划附件（2026-11-09 保证实现纵深 §2）：delegate 参数校验 + 落点 + 规划器可见。
 */

test("steps 校验：不传/空数组 = 旧行为；超 12 条 / 超 200 字 / 非字符串都拒绝", () => {
	assert.deepEqual(normalizeDelegationSteps(undefined), { ok: true });
	assert.deepEqual(normalizeDelegationSteps(null), { ok: true });
	assert.deepEqual(normalizeDelegationSteps([]), { ok: true });

	assert.equal(normalizeDelegationSteps(["a", "b"]).ok, true);
	const long = normalizeDelegationSteps(Array.from({ length: DELEGATION_STEPS_MAX + 1 }, (_, i) => `第${i}步`));
	assert.equal(long.ok, false);
	assert.equal(
		normalizeDelegationSteps(["x".repeat(DELEGATION_STEP_MAX_CHARS + 1)]).ok,
		false,
	);
	assert.equal(normalizeDelegationSteps([1] as unknown).ok, false);
	assert.equal(normalizeDelegationSteps(["  "]).ok, false);
	assert.equal(normalizeDelegationSteps("不是数组").ok, false);

	const trimmed = normalizeDelegationSteps(["  读 src/a.ts  ", "改完跑测试"]);
	assert.deepEqual(trimmed, { ok: true, steps: ["读 src/a.ts", "改完跑测试"] });
});

test("steps 落点：ticket.json 带 steps（不传时没有这个键）", () => {
	const root = mkdtempSync(join(tmpdir(), "steps-ticket-"));
	try {
		const store = new Store(root);
		try {
			const withSteps = intake(
				store,
				"把两件事做完",
				{ dry: true, maxTasks: 3, workRoot: root },
				"pool",
				undefined,
				undefined,
				undefined,
				["读 a.ts", "改 b.ts"],
			);
			const raw = JSON.parse(
				readFileSync(join(root, withSteps.id, "ticket.json"), "utf8"),
			) as Ticket;
			assert.deepEqual(raw.steps, ["读 a.ts", "改 b.ts"]);

			const without = intake(
				store,
				"一件小事",
				{ dry: true, maxTasks: 3, workRoot: root },
				"pool",
			);
			const plain = JSON.parse(
				readFileSync(join(root, without.id, "ticket.json"), "utf8"),
			) as Ticket;
			assert.equal("steps" in plain, false);
		} finally {
			store.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("steps 进规划器：拼成 ## 步骤 段；没有 steps 时逐字节不变", () => {
	assert.equal(appendPlanSteps("做两件事"), "做两件事");
	assert.equal(appendPlanSteps("做两件事", []), "做两件事");
	const withSteps = appendPlanSteps("做两件事", ["读 a.ts", "改 b.ts"]);
	assert.match(withSteps, /## 步骤/);
	assert.match(withSteps, /1\. 读 a\.ts\n2\. 改 b\.ts/);
	assert.ok(withSteps.startsWith("做两件事"));
});

// ── 按单隔离（2026-11-23）──────────────────────────────────

test("isolation 校验：auto / worktree / direct 三种；非法值明确拒绝，不静默改", () => {
	assert.deepEqual(normalizeDelegationIsolation(undefined), { ok: true });
	assert.deepEqual(normalizeDelegationIsolation(null), { ok: true });
	assert.deepEqual(normalizeDelegationIsolation(""), { ok: true });
	assert.deepEqual(normalizeDelegationIsolation("auto"), { ok: true, isolation: "auto" });
	assert.deepEqual(normalizeDelegationIsolation("worktree"), {
		ok: true,
		isolation: "worktree",
	});
	assert.deepEqual(normalizeDelegationIsolation("direct"), { ok: true, isolation: "direct" });

	for (const bad of ["AUTO", "none", "git", 1, true, {}]) {
		const checked = normalizeDelegationIsolation(bad);
		assert.equal(checked.ok, false, `${JSON.stringify(bad)} 必须拒绝`);
		assert.match(checked.ok ? "" : checked.message, /auto \/ worktree \/ direct/);
	}
});

test("isolation 透传：worktree / direct 进 ChancellorRequest；auto / 不传 / 续跑都不带", async () => {
	// settle 会落「交回结论」留言：指到临时库，别污染工作区的 .data。
	const dbDir = mkdtempSync(join(tmpdir(), "isolation-db-"));
	resetDelegationMessages(join(dbDir, "delegations.sqlite"));
	try {
		const seen: ChancellorRequest[] = [];
		const finish = (ticketId: string): TicketResult => ({
			ticketId,
			status: "done",
			line: "好",
			tasks: [],
		});
		const run = (
			request: ChancellorRequest,
			options: { onEvent?: (event: ChancellorEvent) => void },
		) => {
			seen.push(request);
			const ticketId = request.resumeTicketId ?? "T-iso";
			// 同步段先发单号：与 runChancellor 一致，避免把「续跑被拒」误判成回退重派。
			options.onEvent?.({ type: "ticket", ticketId, message: "已受理" });
			return Promise.resolve(finish(ticketId));
		};

		const first = startDelegation(
			{ conversationId: 1, domain: "", requirement: "改一下", isolation: "worktree" },
			{ run, emit: () => undefined, autoReport: false },
		);
		await first.outcome;

		const second = startDelegation(
			{ conversationId: 2, domain: "", requirement: "再改一下", isolation: "direct" },
			{ run, emit: () => undefined, autoReport: false },
		);
		await second.outcome;

		const third = startDelegation(
			{ conversationId: 3, domain: "", requirement: "随便改", isolation: "auto" },
			{ run, emit: () => undefined, autoReport: false },
		);
		await third.outcome;

		const resume = startDelegation(
			{
				conversationId: 4,
				domain: "",
				requirement: "回答",
				isolation: "worktree",
				resumeTicketId: "T-old",
			},
			{ run, emit: () => undefined, autoReport: false },
		);
		await resume.outcome;

		assert.equal(seen.length, 4, "四次派单各只发一次请求（没有误走回退重派）");
		assert.equal(seen[0]?.isolation, "worktree");
		assert.equal(seen[1]?.isolation, "direct");
		assert.equal(seen[2]?.isolation, undefined, "auto 不该被当成 direct / worktree 写死");
		assert.equal(seen[3]?.resumeTicketId, "T-old");
		assert.equal(seen[3]?.isolation, undefined, "续跑沿用原单快照，不接受新参数");
	} finally {
		resetDelegationMessages();
		rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test("isolation 快照：chancellor 把 worktree 写进 ticket.options；auto 不落键", async () => {
	const worktreeRoot = mkdtempSync(join(tmpdir(), "isolation-snapshot-"));
	const autoRoot = mkdtempSync(join(tmpdir(), "isolation-auto-"));
	const ticketOf = (root: string): Ticket => {
		const dir = readdirSync(root).find((name) => name.startsWith("t-"));
		assert.ok(dir, "chancellor 没建单");
		return JSON.parse(
			readFileSync(join(root, dir, "ticket.json"), "utf8"),
		) as Ticket;
	};
	try {
		// dry + domain：走分管分支的 dry 早退，不拆单、不派活，但收单快照已落盘。
		await runChancellor({
			requirement: "把项目里的日志格式统一",
			domain: "frontend",
			dry: true,
			workRoot: worktreeRoot,
			employee: "pool",
			isolation: "worktree",
		});
		const withIsolation = ticketOf(worktreeRoot);
		assert.equal(withIsolation.options.isolation, "worktree");

		await runChancellor({
			requirement: "看下项目结构",
			domain: "frontend",
			dry: true,
			workRoot: autoRoot,
			employee: "pool",
			isolation: "auto",
		});
		const withoutIsolation = ticketOf(autoRoot);
		assert.equal("isolation" in withoutIsolation.options, false, "auto 不写快照");
	} finally {
		rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		rmSync(autoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

// ── 外部 CLI 步骤事件（2026-11-23 流式事件）────────────────────────

test("step 事件：只更新任务中心最近动作，不 mirror 进专线 / 模型上下文", async () => {
	const dbDir = mkdtempSync(join(tmpdir(), "steps-event-db-"));
	resetDelegationMessages(join(dbDir, "delegations.sqlite"));
	try {
		const emitted: Array<Record<string, unknown>> = [];
		const mirrored: string[] = [];
		const run = (
			request: ChancellorRequest,
			options: { onEvent?: (event: ChancellorEvent) => void },
		) => {
			const ticketId = request.resumeTicketId ?? "T-step";
			options.onEvent?.({ type: "ticket", ticketId, message: "已受理" });
			options.onEvent?.({
				type: "step",
				ticketId,
				seq: 1,
				slug: "demo",
				message: "读取 a.txt",
				step: { type: "tool", name: "read", detail: "a.txt", at: "" },
			});
			return Promise.resolve({
				ticketId,
				status: "done",
				line: "好",
				tasks: [],
			} satisfies TicketResult);
		};
		const begun = startDelegation(
			{ conversationId: 7, domain: "", requirement: "看下 a.txt" },
			{
				run,
				emit: (_conversationId, event) => {
					emitted.push(event as unknown as Record<string, unknown>);
				},
				mirror: (_ticketId, entry) => {
					mirrored.push(entry.text);
				},
				autoReport: false,
			},
		);
		await begun.outcome;

		const stepEvent = emitted.find(
			(event) => event.type === "delegate" && event.lastAction === "读取 a.txt",
		);
		assert.ok(stepEvent, "step 必须走 delegate 事件到任务中心");
		assert.equal(stepEvent?.phase, "running");
		assert.equal(stepEvent?.seq, undefined, "delegate 事件不带任务序号，保持既有契约");
		assert.equal(
			mirrored.some((text) => text.includes("读取 a.txt")),
			false,
			"步骤不许 mirror 成专线消息（那会变成模型可见上下文）",
		);
	} finally {
		resetDelegationMessages();
		rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
