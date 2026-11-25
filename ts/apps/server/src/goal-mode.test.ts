import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { goalModeEnabled, scheduleGoalContinuation, settleGoalTurn } from "./goal-mode.ts";
import { partnersStore } from "./partners.ts";

/**
 * 目标模式运行时的回归（2026-11-25 返工：两处可靠性小口）。
 *
 * 纯判定在 goal-settlement.test.ts；这里只钉"目标模式的运行时入口对调用方的承诺"：
 *   1. 开关关 → settleGoalTurn 返回 false（调用方按"没开"处理，返回值形状不变）；
 *   2. 开关开、结算抛异常 → 仍返回 true（调用方照常剔掉末行标记、带上工具数），
 *      而且自己不抛——结算失败不能把已经跑完的那一轮变成失败；
 *   3. scheduleGoalContinuation 保证不 reject（动作端点那条路是 void 调用，没人接）。
 *
 * 造异常的办法：把库关掉。之后任何一次查询都抛，正好落在结算与取会话的路上。
 * 库是临时文件，不碰仓库里的真实数据。
 */

const ROOT = mkdtempSync(join(tmpdir(), "lifediary-goal-mode-test-"));
process.env.PARTNERS_DB_PATH = join(ROOT, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(ROOT, "partner-homes");
process.env.COMPANIONS_ENABLED = "true";

test.after(() => {
	try {
		partnersStore().close();
	} catch {
		/* 已经关过了 */
	}
	try {
		rmSync(ROOT, { recursive: true, force: true });
	} catch {
		/* Windows 句柄延迟 */
	}
});

const SIGNAL = {
	partnerId: "goal-mode-test-partner",
	// 会话内部 id 是数字（durable 的自增整数，不对外）；这里随便给一个，库关着走不到查会话那一步
	conversationId: 0,
	replyText: "做完了\n[[goal-done]]",
	toolCalls: 0,
	isContinuation: true,
};

test("开关关：settleGoalTurn 返回 false，不碰库", async () => {
	delete process.env.GOAL_MODE;
	assert.equal(goalModeEnabled(), false);
	assert.equal(await settleGoalTurn(SIGNAL), false);
});

test("开关开、结算抛异常：仍返回 true（标记照剔），且自己不抛", async () => {
	process.env.GOAL_MODE = "true";
	assert.equal(goalModeEnabled(), true);
	// 下面两条日志（"结算失败""执事会话打不开"）是本测试故意造出来的，不是故障。
	partnersStore().close();
	assert.equal(await settleGoalTurn(SIGNAL), true);
});

test("scheduleGoalContinuation 取会话失败：返回 false，不 reject", async () => {
	assert.equal(await scheduleGoalContinuation(SIGNAL.partnerId, "token", 0), false);
});
