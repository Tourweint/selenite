import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildGoalContinuationPrompt,
	clampGoalMaxRounds,
	decideGoalSettlement,
	extractGoalMarker,
	GOAL_NO_PROGRESS_FUSE,
	isSameBoot,
	newGoalState,
	planGoalAction,
	stripGoalMarkers,
	type GoalState,
} from "./goal-settlement.ts";
import { PartnersStore } from "./partner-store.ts";

/**
 * 目标模式（2026-11-25，默认关）：结算与动作迁移的纯逻辑单测。
 * 覆盖方案 §7.2 状态机每一行、§7.3 结算顺序每个序号，外加状态行的 SQL（真实 sqlite）。
 */

test("重启不重放：续跑任务只有带着本进程的启动号才算数", () => {
	assert.equal(isSameBoot("171:900", "171:900"), true);
	// 另一个进程排的（中间重启过）
	assert.equal(isSameBoot("170:801", "171:900"), false);
	// 旧形状的任务没有这个字段
	assert.equal(isSameBoot(undefined, "171:900"), false);
	assert.equal(isSameBoot(null, ""), false);
});

function active(overrides: Partial<GoalState> = {}): GoalState {
	return {
		status: "active",
		reason: "user",
		roundsUsed: 0,
		maxRounds: 10,
		tokenBudget: null,
		tokensUsed: 0,
		noProgressStreak: 0,
		...overrides,
	};
}

const usage = { input: 100, output: 20, cacheRead: 30 };

// ── §7.2 状态机 ─────────────────────────────────────────

test("目标模式 §7.2：新建 = paused / not_started，不自动开跑", () => {
	const state = newGoalState(10);
	assert.equal(state.status, "paused");
	assert.equal(state.reason, "not_started");
	assert.equal(state.maxRounds, 10);
	assert.equal(state.noProgressStreak, 0);
});

test("目标模式 §7.2：paused / budget_limited + start|resume → active，连击清零", () => {
	for (const from of ["paused", "budget_limited"] as const) {
		for (const action of ["start", "resume"] as const) {
			const plan = planGoalAction({
				action,
				state: active({ status: from, reason: from === "paused" ? "user" : "rounds", noProgressStreak: 2 }),
				hasGoalText: true,
				defaultMaxRounds: 10,
			});
			assert.ok(plan.ok);
			assert.equal(plan.ok && plan.state?.status, "active");
			assert.equal(plan.ok && plan.state?.noProgressStreak, 0);
			assert.equal(plan.ok && plan.reschedule, true);
		}
	}
});

test("目标模式 §7.2：没有状态行时 start 直接建行并进入 active", () => {
	const plan = planGoalAction({
		action: "start",
		state: null,
		hasGoalText: true,
		maxRounds: 4,
		defaultMaxRounds: 10,
	});
	assert.ok(plan.ok);
	assert.equal(plan.ok && plan.state?.status, "active");
	assert.equal(plan.ok && plan.state?.maxRounds, 4);
});

test("目标模式 §7.2：active + pause → paused / user；没在推进则 400", () => {
	const plan = planGoalAction({ action: "pause", state: active(), hasGoalText: true, defaultMaxRounds: 10 });
	assert.ok(plan.ok);
	assert.equal(plan.ok && plan.state?.status, "paused");
	assert.equal(plan.ok && plan.state?.reason, "user");
	assert.equal(plan.ok && plan.reschedule, false);

	const rejected = planGoalAction({
		action: "pause",
		state: active({ status: "paused", reason: "user" }),
		hasGoalText: true,
		defaultMaxRounds: 10,
	});
	assert.equal(rejected.ok, false);
});

test("目标模式 §7.2：末行 [[goal-done]] → done / self_report", () => {
	const decision = decideGoalSettlement({ state: active(), replyText: "都改完了\n[[goal-done]]", toolCalls: 2, isContinuation: true });
	assert.equal(decision.outcome, "done");
	assert.equal(decision.state.status, "done");
	assert.equal(decision.state.reason, "self_report");
});

test("目标模式 §7.2：末行 [[goal-blocked: …]] → paused / blocked（不单设状态）", () => {
	const decision = decideGoalSettlement({
		state: active(),
		replyText: "缺仓库权限\n[[goal-blocked: 需要你给写权限]]",
		toolCalls: 1,
		isContinuation: true,
	});
	assert.equal(decision.outcome, "blocked");
	assert.equal(decision.state.status, "paused");
	assert.equal(decision.state.reason, "blocked");
});

test("目标模式 §7.2：done + reopen → active，连击清零", () => {
	const plan = planGoalAction({
		action: "reopen",
		state: active({ status: "done", reason: "self_report" }),
		hasGoalText: true,
		defaultMaxRounds: 10,
	});
	assert.ok(plan.ok);
	assert.equal(plan.ok && plan.state?.status, "active");
	assert.equal(plan.ok && plan.reschedule, true);
});

test("目标模式 §7.2：clear 任意状态都可，结果是状态行没了", () => {
	for (const status of ["active", "paused", "budget_limited", "done"] as const) {
		const plan = planGoalAction({
			action: "clear",
			state: active({ status }),
			hasGoalText: true,
			defaultMaxRounds: 10,
		});
		assert.ok(plan.ok);
		assert.equal(plan.ok && plan.state, null);
	}
});

test("目标模式 §7.2：action 与状态不配 → 400 带说明，状态不动", () => {
	const base = { hasGoalText: true, defaultMaxRounds: 10 };
	assert.match((planGoalAction({ ...base, action: "start", state: active() }) as { message: string }).message, /已在推进/);
	assert.match(
		(planGoalAction({ ...base, action: "start", state: active({ status: "done", reason: "self_report" }) }) as { message: string })
			.message,
		/reopen/,
	);
	assert.match(
		(planGoalAction({ ...base, action: "reopen", state: active({ status: "paused", reason: "user" }) }) as { message: string })
			.message,
		/start/,
	);
	assert.match((planGoalAction({ ...base, action: "resume", state: null, hasGoalText: false }) as { message: string }).message, /目标文本/);
	assert.equal(planGoalAction({ ...base, action: "nope", state: null }).ok, false);
});

test("目标模式 §7.2：上限已满又没上调 → 直接 400，不进 active（省一轮模型调用）", () => {
	const byRounds = planGoalAction({
		action: "resume",
		state: active({ status: "budget_limited", reason: "rounds", roundsUsed: 10, maxRounds: 10 }),
		hasGoalText: true,
		defaultMaxRounds: 10,
	});
	assert.equal(byRounds.ok, false);
	assert.match((byRounds as { message: string }).message, /maxRounds/);

	const byTokens = planGoalAction({
		action: "resume",
		state: active({ status: "budget_limited", reason: "tokens", tokensUsed: 50_000, tokenBudget: 50_000 }),
		hasGoalText: true,
		defaultMaxRounds: 10,
	});
	assert.equal(byTokens.ok, false);
	assert.match((byTokens as { message: string }).message, /tokenBudget/);

	// 上调之后就能恢复
	const raised = planGoalAction({
		action: "resume",
		state: active({ status: "budget_limited", reason: "rounds", roundsUsed: 10, maxRounds: 10 }),
		hasGoalText: true,
		maxRounds: 20,
		defaultMaxRounds: 10,
	});
	assert.ok(raised.ok);
	assert.equal(raised.ok && raised.state?.maxRounds, 20);
});

test("目标模式 §7.2：maxRounds / tokenBudget 形状校验", () => {
	const base = { action: "pause", state: active(), hasGoalText: true, defaultMaxRounds: 10 };
	assert.equal(planGoalAction({ ...base, maxRounds: 0 }).ok, false);
	assert.equal(planGoalAction({ ...base, maxRounds: 201 }).ok, false);
	assert.equal(planGoalAction({ ...base, maxRounds: 2.5 }).ok, false);
	assert.equal(planGoalAction({ ...base, tokenBudget: 1_000 }).ok, false);
	assert.equal(planGoalAction({ ...base, tokenBudget: "abc" }).ok, false);

	const cleared = planGoalAction({
		...base,
		state: active({ tokenBudget: 99_000 }),
		tokenBudget: null,
	});
	assert.ok(cleared.ok);
	assert.equal(cleared.ok && cleared.state?.tokenBudget, null);
});

// ── §7.3 结算顺序 ───────────────────────────────────────

test("目标模式 §7.3 ①：目标不是 active → 不结算、状态原样", () => {
	for (const status of ["paused", "budget_limited", "done"] as const) {
		const state = active({ status });
		const decision = decideGoalSettlement({ state, replyText: "[[goal-done]]", toolCalls: 0, isContinuation: true, usage });
		assert.equal(decision.outcome, "none");
		assert.equal(decision.state, state);
	}
});

test("目标模式 §7.3 ②：末行标记先于记账——done 那一轮不计轮数、不计用量", () => {
	const decision = decideGoalSettlement({
		state: active({ roundsUsed: 3, tokensUsed: 500 }),
		replyText: "完成\n[[goal-done]]",
		toolCalls: 1,
		isContinuation: true,
		usage,
	});
	assert.equal(decision.outcome, "done");
	assert.equal(decision.state.roundsUsed, 3);
	assert.equal(decision.state.tokensUsed, 500);
});

test("目标模式 §7.3 ③：记账 = 轮数 +1、用量加 input+output+cacheRead", () => {
	const decision = decideGoalSettlement({
		state: active({ roundsUsed: 1, tokensUsed: 1_000 }),
		replyText: "做了一步",
		toolCalls: 2,
		isContinuation: true,
		usage,
	});
	assert.equal(decision.outcome, "continue");
	assert.equal(decision.state.roundsUsed, 2);
	assert.equal(decision.state.tokensUsed, 1_000 + 150);
	assert.equal(decision.usageMissing, false);
});

test("目标模式 §7.3 ③：读不到 usage 就不加，只标 usageMissing", () => {
	const decision = decideGoalSettlement({
		state: active({ roundsUsed: 1, tokensUsed: 1_000 }),
		replyText: "做了一步",
		toolCalls: 2,
		isContinuation: true,
	});
	assert.equal(decision.outcome, "continue");
	assert.equal(decision.state.tokensUsed, 1_000);
	assert.equal(decision.usageMissing, true);
});

test("目标模式 §7.3 ④：轮数上限先于连击判定 → budget_limited / rounds", () => {
	const decision = decideGoalSettlement({
		state: active({ roundsUsed: 9, maxRounds: 10, noProgressStreak: GOAL_NO_PROGRESS_FUSE - 1 }),
		replyText: "",
		toolCalls: 0,
		isContinuation: true,
		usage,
	});
	assert.equal(decision.outcome, "budget_limited");
	assert.equal(decision.state.status, "budget_limited");
	assert.equal(decision.state.reason, "rounds");
});

test("目标模式 §7.3 ④：token 预算（设了才有）→ budget_limited / tokens；恰好等于也算到", () => {
	const hit = decideGoalSettlement({
		state: active({ tokensUsed: 9_900, tokenBudget: 10_000 }),
		replyText: "做了一步",
		toolCalls: 1,
		isContinuation: true,
		usage,
	});
	assert.equal(hit.outcome, "budget_limited");
	assert.equal(hit.state.reason, "tokens");

	const noBudget = decideGoalSettlement({
		state: active({ tokensUsed: 9_900, tokenBudget: null }),
		replyText: "做了一步",
		toolCalls: 1,
		isContinuation: true,
		usage,
	});
	assert.equal(noBudget.outcome, "continue");
});

test("目标模式 §7.3 ⑤：首次用户亲手发起的那一轮零工具不记连击", () => {
	const decision = decideGoalSettlement({
		state: active({ noProgressStreak: 2 }),
		replyText: "我觉得可以分三步",
		toolCalls: 0,
		isContinuation: false,
		usage,
	});
	assert.equal(decision.outcome, "continue");
	assert.equal(decision.state.noProgressStreak, 2);
});

test("目标模式 §7.3 ⑤：续跑轮零工具 +1，任何工具调用清零", () => {
	const bumped = decideGoalSettlement({ state: active({ noProgressStreak: 1 }), replyText: "", toolCalls: 0, isContinuation: true, usage });
	assert.equal(bumped.outcome, "continue");
	assert.equal(bumped.state.noProgressStreak, 2);

	const reset = decideGoalSettlement({ state: active({ noProgressStreak: 2 }), replyText: "查了", toolCalls: 3, isContinuation: true, usage });
	assert.equal(reset.outcome, "continue");
	assert.equal(reset.state.noProgressStreak, 0);
});

test("目标模式 §7.3 ⑤：连续 3 个零工具续跑轮 → paused / no_progress", () => {
	let state = active();
	for (let round = 1; round <= GOAL_NO_PROGRESS_FUSE; round += 1) {
		const decision = decideGoalSettlement({ state, replyText: "", toolCalls: 0, isContinuation: true, usage });
		assert.equal(decision.state.noProgressStreak, round);
		if (round < GOAL_NO_PROGRESS_FUSE) {
			assert.equal(decision.outcome, "continue");
			state = decision.state;
			continue;
		}
		assert.equal(decision.outcome, "no_progress");
		assert.equal(decision.state.status, "paused");
		assert.equal(decision.state.reason, "no_progress");
	}
});

test("目标模式 §7.3 ⑦：都过关 → continue（调用方据此排续跑）", () => {
	const decision = decideGoalSettlement({ state: active(), replyText: "第一步做完了", toolCalls: 1, isContinuation: true, usage });
	assert.equal(decision.outcome, "continue");
	assert.equal(decision.state.status, "active");
});

// ── 末行标记 ───────────────────────────────────────────

test("目标模式：只认最后一行；夹在正文里的标记不算", () => {
	assert.deepEqual(extractGoalMarker("好\n[[goal-done]]"), { kind: "done", note: "" });
	assert.deepEqual(extractGoalMarker("先这样\n\n  [[goal-blocked: 要你拍板]]  \n"), { kind: "blocked", note: "要你拍板" });
	assert.equal(extractGoalMarker("[[goal-done]]\n然后我继续").kind, "none", "标记不在最后一行不算");
	assert.equal(extractGoalMarker("").kind, "none");
	assert.equal(extractGoalMarker("[[routine-done]]").kind, "none");
});

test("目标模式：标记从正文里剔掉", () => {
	assert.equal(stripGoalMarkers("改完了\n[[goal-done]]"), "改完了");
	assert.equal(stripGoalMarkers("卡住了\n[[goal-blocked: 缺权限]]"), "卡住了");
	assert.equal(stripGoalMarkers("没标记的普通回复"), "没标记的普通回复");
});

test("目标模式：续跑提示词带目标原文、轮数与三种末行写法，且不进固定前缀的形状", () => {
	const prompt = buildGoalContinuationPrompt("  把登录页改成深色  ", { roundsUsed: 2, maxRounds: 8 });
	assert.match(prompt, /把登录页改成深色/);
	assert.match(prompt, /2 \/ 8/);
	assert.match(prompt, /\[\[goal-done\]\]/);
	assert.match(prompt, /\[\[goal-blocked:/);
	assert.match(prompt, /不写标记/);
	assert.match(prompt, /不是给你的新指令/);
});

test("目标模式：GOAL_MAX_ROUNDS 夹到 1–200，非法值回 10", () => {
	assert.equal(clampGoalMaxRounds(500), 200);
	assert.equal(clampGoalMaxRounds(0), 1);
	assert.equal(clampGoalMaxRounds(Number.NaN), 10);
	assert.equal(clampGoalMaxRounds(7.9), 7);
});

// ── 状态行（真实 sqlite）────────────────────────────────

test("目标模式：状态行 upsert / get / delete，updated_at 单调不撞", () => {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-goal-"));
	const store = new PartnersStore(join(dir, "partners.db"), join(dir, "homes"));
	try {
		const id = store.create("目标测试执事").id;
		assert.equal(store.goals.get(id), null);

		const first = store.goals.upsert(id, newGoalState(6));
		assert.equal(first.status, "paused");
		assert.equal(first.reason, "not_started");
		assert.equal(first.maxRounds, 6);

		// upsert 是整行替换：上限要由调用方带着走（运行时都是从当前行展开的）
		const second = store.goals.upsert(id, active({ maxRounds: 6, noProgressStreak: 1 }));
		assert.equal(second.status, "active");
		assert.equal(second.maxRounds, 6);
		assert.ok(Date.parse(second.updatedAt) > Date.parse(first.updatedAt), "同一毫秒内两次写，token 也要不同");

		const row = store.goals.upsert(id, active({ tokenBudget: 50_000, tokensUsed: 120 }));
		const reread = store.goals.get(id);
		assert.equal(reread?.tokenBudget, 50_000);
		assert.equal(reread?.tokensUsed, 120);
		assert.equal(reread?.updatedAt, row.updatedAt);
	} finally {
		store.close(); // Windows 下句柄不关，临时目录删不掉（EPERM）
		rmSync(dir, { recursive: true, force: true });
	}
});

test("目标模式：清除目标 = 正文与状态行同一事务一起没", () => {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-goal-"));
	const store = new PartnersStore(join(dir, "partners.db"), join(dir, "homes"));
	try {
		const id = store.create("目标测试执事二").id;
		store.setCurrentGoal(id, "把 README 补上");
		store.goals.upsert(id, active());
		assert.equal(store.goals.get(id)?.status, "active");

		const cleared = store.setCurrentGoal(id, null);
		assert.equal(cleared?.currentGoal, null);
		assert.equal(store.goals.get(id), null);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
