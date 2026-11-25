import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 目标模式探针（2026-11-25）：真起服务 + 真 HTTP + faux 模型。
 *
 * 覆盖：
 *   1. `GOAL_MODE=false`（回滚形态）：详情 / PATCH 不带 `goal`、动作端点 404、403 空体照旧
 *   2. `GOAL_MODE=true`：
 *      设目标 = `paused / not_started` → 动作端点的 400 各分支 → start（立刻排一轮续跑）→
 *      **durable 续跑任务真醒真跑**（faux 走 runPartnerTurn 同一条路）→ 轮末结算记账 →
 *      零工具连击 `paused / no_progress` → 用户亲手的那一轮不记连击 →
 *      轮数上限 `budget_limited` → resume 不抬上限 400 / 抬了能续 → pause 后在路上的续跑作废 →
 *      clear 同事务清正文与状态行
 *
 *   真模型才看得出的东西（末行标记、Stop 暂停、首页主对话结算）这里**不覆盖**，见
 *   `docs/变更记录/2026-11-25-目标模式.md` 的未验证项。
 *
 *   pnpm --filter @lifediary/server goal
 */

const PORT = 8216;
const ROOT = mkdtempSync(join(tmpdir(), "lifediary-goal-probe-"));

function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) process.exitCode = 1;
}

const GOAL_KEYS = ["status", "reason", "roundsUsed", "maxRounds", "tokensUsed", "tokenBudget"];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sameGoal(a: any, expected: Record<string, unknown>): boolean {
	if (!a || typeof a !== "object") return false;
	const keys = Object.keys(a).sort();
	if (JSON.stringify(keys) !== JSON.stringify([...GOAL_KEYS].sort())) return false;
	return Object.entries(expected).every(([key, value]) => a[key] === value);
}

async function waitForGoal(
	partnerId: string,
	predicate: (goal: any) => boolean,
	timeoutMs = 25_000,
): Promise<any | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const detail = await api("GET", `/api/v1/partners/${partnerId}`, null);
		if (detail.status === 200 && detail.body.goal && predicate(detail.body.goal)) return detail.body.goal;
		if (Date.now() > deadline) return detail.status === 200 ? detail.body.goal : null;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
}

async function main(): Promise<void> {
	// ── 阶段一：GOAL_MODE=false（回滚形态）──
	const off = await startServer({ GOAL_MODE: "false" });
	try {
		const created = await api("POST", "/api/v1/partners", { name: "回滚探针执事" });
		const partnerId = created.body.partner?.id as string;
		const patched = await api("PATCH", `/api/v1/partners/${partnerId}`, { currentGoal: "把回滚验明白" });
		check(
			"GOAL_MODE=false：PATCH 回显 currentGoal，但不带 goal 字段",
			patched.status === 200 && patched.body.currentGoal === "把回滚验明白" && !("goal" in patched.body),
			`status=${patched.status} keys=${Object.keys(patched.body ?? {}).join(",")}`,
		);
		const detail = await api("GET", `/api/v1/partners/${partnerId}`, null);
		check("GOAL_MODE=false：详情不带 goal 字段", detail.status === 200 && !("goal" in detail.body));
		const action = await api("POST", `/api/v1/partners/${partnerId}/goal`, { action: "start" });
		check("GOAL_MODE=false：动作端点 404（未启用语义）", action.status === 404, `status=${action.status}`);
	} finally {
		await stopServer(off);
	}

	// ── 阶段二：GOAL_MODE=true + faux 全链路 ──
	const server = await startServer({ GOAL_MODE: "true", LLM_PROVIDER: "faux", GOAL_MAX_ROUNDS: "4" });
	try {
		const created = await api("POST", "/api/v1/partners", { name: "目标探针执事" });
		check("建执事：201", created.status === 201 && !!created.body.partner?.id);
		const partnerId = created.body.partner?.id as string;
		const path = `/api/v1/partners/${partnerId}`;

		const bare = await api("POST", `${path}/goal`, { action: "start" });
		check("没有目标文本时 start：400 带说明", bare.status === 400 && typeof bare.body.message === "string", `message=${bare.body.message}`);

		const patched = await api("PATCH", path, { currentGoal: "把探针跑明白" });
		check(
			"设目标：PATCH 回显 goal = paused / not_started（不自动开跑），六字段",
			patched.status === 200 &&
				sameGoal(patched.body.goal, { status: "paused", reason: "not_started", roundsUsed: 0, maxRounds: 4, tokensUsed: 0, tokenBudget: null }),
			`goal=${JSON.stringify(patched.body.goal)}`,
		);

		// ── 动作端点的 400 分支 ──
		const badAction = await api("POST", `${path}/goal`, { action: "fly" });
		check("不认识的 action：400", badAction.status === 400);
		const badRounds = await api("POST", `${path}/goal`, { action: "start", maxRounds: 0 });
		check("maxRounds=0：400", badRounds.status === 400);
		const badBudget = await api("POST", `${path}/goal`, { action: "start", tokenBudget: 1 });
		check("tokenBudget=1（低于下界）：400", badBudget.status === 400);
		const pauseIdle = await api("POST", `${path}/goal`, { action: "pause" });
		check("没在推进时 pause：400", pauseIdle.status === 400, `message=${pauseIdle.body.message}`);
		const reopenEarly = await api("POST", `${path}/goal`, { action: "reopen" });
		check("没完成时 reopen：400", reopenEarly.status === 400, `message=${reopenEarly.body.message}`);
		const unknown = await api("POST", "/api/v1/partners/not-a-partner/goal", { action: "start" });
		check("执事不存在：404", unknown.status === 404, `status=${unknown.status}`);
		const forbidden = await fetch(`http://127.0.0.1:${PORT}${path}/goal`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "start" }),
		});
		const forbiddenText = await forbidden.text();
		check("没带 token：403 空体", forbidden.status === 403 && forbiddenText === "", `status=${forbidden.status} body=${forbiddenText.slice(0, 40)}`);

		// ── 400 之后状态一行没动 ──
		const detail1 = await api("GET", path, null);
		check("上面一串 400 之后：详情仍是 paused / not_started", sameGoal(detail1.body.goal, { status: "paused", reason: "not_started", roundsUsed: 0 }));

		// ── 列表投影不带 goal ──
		const list = await api("GET", "/api/v1/partners", null);
		const listed = (list.body.partners ?? []).find((item: any) => item.id === partnerId);
		check("列表投影：不带 goal", !!listed && !("goal" in listed), `keysHasGoal=${listed ? "goal" in listed : "n/a"}`);

		// ── 目标没在推进：用户亲手跑一轮不结算 ──
		const idleRun = await api("POST", `${path}/run`, { text: "先聊一句" });
		const afterIdleRun = await api("GET", path, null);
		check(
			"目标没在推进：用户亲手跑一轮（faux 应答）不记账，roundsUsed 仍为 0",
			idleRun.status === 200 && idleRun.body.ok === true && afterIdleRun.body.goal?.roundsUsed === 0 && afterIdleRun.body.goal?.status === "paused",
			`run=${idleRun.status}/${idleRun.body.ok} goal=${JSON.stringify(afterIdleRun.body.goal)}`,
		);

		// ── start：立刻排一轮续跑（延迟 0），之后每轮间隔 3 秒 ──
		const started = await api("POST", `${path}/goal`, { action: "start", maxRounds: 4 });
		check("start（maxRounds=4）：active", started.status === 200 && sameGoal(started.body.goal, { status: "active", reason: "user", maxRounds: 4, roundsUsed: 0 }));
		const twice = await api("POST", `${path}/goal`, { action: "start" });
		check("已在推进再 start：400", twice.status === 400, `message=${twice.body.message}`);

		// faux 不调工具：续跑轮连击 1、2、3 → paused / no_progress。第 3 轮停下，轮数上限 4 没到——
		// 说明是连击闸先起的作用；这三轮全是 durable 任务醒了之后真跑的。
		const stalled = await waitForGoal(partnerId, (goal) => goal.status === "paused" && goal.reason === "no_progress");
		check(
			"durable 续跑任务真醒真跑：连续 3 轮零工具 → paused / no_progress（3/4 轮，没到轮数上限）",
			!!stalled && stalled.status === "paused" && stalled.reason === "no_progress" && stalled.roundsUsed === 3 && stalled.maxRounds === 4 && stalled.tokensUsed > 0,
			`goal=${JSON.stringify(stalled)}`,
		);

		// 停了就不再自己跑：等 6 秒，轮数不该变
		await sleep(6_000);
		const settled = await api("GET", path, null);
		check("暂停后不再自动续跑（等 6 秒轮数没变）", settled.body.goal?.roundsUsed === stalled?.roundsUsed, `roundsUsed=${settled.body.goal?.roundsUsed}`);

		// ── 用户亲手的那一轮记轮数、不记连击（集成点：runPartnerTurn 轮末的 isContinuation）──
		const resumed = await api("POST", `${path}/goal`, { action: "resume", maxRounds: 8 });
		check("resume 并抬到 8：active、轮数与用量保留", resumed.status === 200 && sameGoal(resumed.body.goal, { status: "active", reason: "user", maxRounds: 8, roundsUsed: 3 }), `goal=${JSON.stringify(resumed.body.goal)}`);
		const firstCont = await waitForGoal(partnerId, (goal) => goal.roundsUsed >= 4, 10_000);
		check("resume 后立刻排的那一轮真跑了（第 4 轮）", !!firstCont && firstCont.roundsUsed >= 4, `roundsUsed=${firstCont?.roundsUsed}`);
		const userRun = await api("POST", `${path}/run`, { text: "我亲手发的一轮" });
		const afterUser = await api("GET", path, null);
		check(
			"推进中用户亲手跑一轮：记轮数（faux 应答、roundsUsed +1）",
			userRun.status === 200 && userRun.body.ok === true && afterUser.body.goal?.roundsUsed >= (firstCont?.roundsUsed ?? 0) + 1,
			`run=${userRun.status}/${userRun.body.ok} roundsUsed=${afterUser.body.goal?.roundsUsed}`,
		);
		// 续跑 A（连击 1）→ 用户轮（不计）→ 续跑 B（2）→ 续跑 C（3 → 暂停）：停在**第 7 轮**。
		// 用户轮要是被错记了连击，会提前一轮停在第 6 轮。
		const stalled2 = await waitForGoal(partnerId, (goal) => goal.status === "paused" && goal.reason === "no_progress", 30_000);
		check(
			"用户亲手的那一轮不计零工具连击：连击在续跑轮上凑满 3 次才暂停（第 7 轮）",
			!!stalled2 && stalled2.status === "paused" && stalled2.reason === "no_progress" && stalled2.roundsUsed === 7,
			`goal=${JSON.stringify(stalled2)}`,
		);

		// ── 轮数上限 ──
		const resumed2 = await api("POST", `${path}/goal`, { action: "resume" });
		check("resume：active（上限仍为 8）", resumed2.status === 200 && sameGoal(resumed2.body.goal, { status: "active", reason: "user", maxRounds: 8, roundsUsed: 7 }));
		const limited = await waitForGoal(partnerId, (goal) => goal.status === "budget_limited");
		check(
			"跑满轮数上限：budget_limited(reason=rounds)，停在 8/8",
			!!limited && limited.status === "budget_limited" && limited.reason === "rounds" && limited.roundsUsed === 8 && limited.maxRounds === 8,
			`goal=${JSON.stringify(limited)}`,
		);
		const stuck = await api("POST", `${path}/goal`, { action: "resume" });
		check("上限已满、不抬上限就 resume：400 带说明", stuck.status === 400 && String(stuck.body.message).includes("maxRounds"), `message=${stuck.body.message}`);
		const sameCap = await api("POST", `${path}/goal`, { action: "resume", maxRounds: 8 });
		check("抬到同一个上限：仍 400", sameCap.status === 400, `message=${sameCap.body.message}`);
		const tightBudget = await api("POST", `${path}/goal`, { action: "resume", maxRounds: 10, tokenBudget: 10000 });
		check(
			"抬了轮数但 token 预算低于已用：400（状态一行没动）",
			tightBudget.status === 400 && String(tightBudget.body.message).includes("tokenBudget"),
			`message=${tightBudget.body.message}`,
		);
		const afterReject = await api("GET", path, null);
		check("上面三次被拒之后：仍是 budget_limited、tokenBudget 仍为空", afterReject.body.goal?.status === "budget_limited" && afterReject.body.goal?.tokenBudget === null, `goal=${JSON.stringify(afterReject.body.goal)}`);

		// ── pause：之后在路上的续跑作废 ──
		const resumed3 = await api("POST", `${path}/goal`, { action: "resume", maxRounds: 12 });
		check("resume 并抬到 12：active", resumed3.status === 200 && sameGoal(resumed3.body.goal, { status: "active", reason: "user", maxRounds: 12 }));
		const paused = await api("POST", `${path}/goal`, { action: "pause" });
		check("pause：paused / user", paused.status === 200 && sameGoal(paused.body.goal, { status: "paused", reason: "user" }), `goal=${JSON.stringify(paused.body.goal)}`);
		await sleep(5_000);
		const afterPause = await api("GET", path, null);
		check(
			"暂停后在路上的续跑作废（等 5 秒：仍是 paused、轮数没变）",
			afterPause.body.goal?.status === "paused" && afterPause.body.goal?.roundsUsed === paused.body.goal?.roundsUsed,
			`goal=${JSON.stringify(afterPause.body.goal)}`,
		);

		const cleared = await api("POST", `${path}/goal`, { action: "clear" });
		const detailAfterClear = await api("GET", path, null);
		check(
			"clear：状态行与目标正文一起没了（goal=null、currentGoal=null）",
			cleared.status === 200 && cleared.body.goal === null && detailAfterClear.body.goal === null && detailAfterClear.body.currentGoal === null,
			`patched=${JSON.stringify(cleared.body)} currentGoal=${JSON.stringify(detailAfterClear.body.currentGoal)}`,
		);
	} finally {
		await stopServer(server);
	}
}

// ── 起服务 / 请求辅助（companion-probe 同款骨架）────────────────────
let child: ReturnType<typeof spawn> | null = null;

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: "Bearer probe-token" };
}

async function startServer(extraEnv: Record<string, string>): Promise<ReturnType<typeof spawn>> {
	const proc = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		env: {
			...process.env,
			PORT: String(PORT),
			AGENT_TOKEN: "probe-token",
			AGENT_DB_PATH: join(ROOT, "agent.sqlite"),
			MEMORY_DB_PATH: join(ROOT, "memory.db"),
			MEMORY_ENABLED: "false",
			PROJECTS_DB_PATH: join(ROOT, "projects.sqlite"),
			PROVIDERS_PATH: join(ROOT, "providers.json"),
			DELEGATIONS_DB_PATH: join(ROOT, "delegations.sqlite"),
			AGENT_SSE_SEQ_DB_PATH: join(ROOT, "chat-events.sqlite"),
			AUTONOMY_ENABLED: "false",
			AGENT_APPROVALS_PATH: join(ROOT, "approvals.json"),
			AGENT_POLICY_PATH: join(ROOT, "policy.json"),
			PARTNERS_DB_PATH: join(ROOT, "partners.sqlite"),
			PARTNER_HOMES_ROOT: join(ROOT, "partner-homes"),
			ROUTINES_STATE_PATH: join(ROOT, "routines.json"),
			AUTONOMY_STATE_PATH: join(ROOT, "autonomy-state.json"),
			CHANCELLOR_ENABLED: "false",
			COMPANIONS_ENABLED: "true",
			// 探针默认用系统里可能已有的 .env / 环境：这两个开关一律显式给，不读继承值
			GOAL_MODE: "false",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`  [server] ${chunk}`));
	proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`  [server!] ${chunk}`));
	child = proc;

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (res.ok) return proc;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) {
			throw new Error("服务 30 秒没起来（看上面的 [server!] 输出）");
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

async function stopServer(proc: ReturnType<typeof spawn>): Promise<void> {
	if (child !== proc) return;
	child = null;
	proc.kill();
	await new Promise((resolve) => setTimeout(resolve, 300));
}

async function api(
	method: string,
	path: string,
	body: unknown,
): Promise<{ status: number; body: any }> {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
		method,
		headers: authHeaders(),
		...(body === null ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	let parsed: any = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = { raw: text.slice(0, 200) };
	}
	return { status: res.status, body: parsed };
}

main()
	.catch((error) => {
		console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			rmSync(ROOT, { recursive: true, force: true });
		} catch {
			/* Windows 句柄延迟：留着下轮清 */
		}
	});
