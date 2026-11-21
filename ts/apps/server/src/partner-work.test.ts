import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SqliteMemoryStore, scopeKey } from "@lifediary/memory";
import type {
	ChancellorEvent,
	ChancellorRequest,
	TicketResult,
} from "../../../packages/chancellor/src/index.ts";
import type { WorkSettlementInput } from "./work-record.ts";

/**
 * 员工人格化刀二（E2 履历 / E4 自建巡逻）单测。
 *
 * 全程临时目录，不碰真实 .data/：模块顶部把 PARTNERS_DB_PATH / MEMORY_DB_PATH /
 * PARTNER_HOMES_ROOT 指到临时根。partnersStore() 是进程单例，恰好被
 * `recordWorkSettlement` 与 `routine_manage` 工具共用，这里只建一次。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-partner-work-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
process.env.COMPANIONS_ENABLED = "true";
process.env.PARTNER_WORK_RECORD = "true";
// 不设 MEMORY_ENABLED（本文件进程内缺省 = 开）；也不 import assist.ts，避免起全局记忆引擎。

const { partnersStore, PartnersStore } = await import("./partners.ts");
const { startDelegation } = await import("./delegation.ts");
const {
	closeWorkStore,
	experienceInsight,
	experienceRecordEnabled,
	formatWorkContent,
	recordWorkSettlement,
	workRecordEnabled,
	workSummaryFor,
} = await import("./work-record.ts");
const { createTools } = await import("./tools.ts");
const {
	ROUTINE_SELF_SERVICE_LIMIT,
	performRoutineAction,
	validateTriggers,
} = await import("./routine-manage.ts");
const { WRITE_TOOLS, DEFAULT_CRITICAL_TOOLS } = await import("./approval-policy.ts");

const singleton = partnersStore();
const partnerA = singleton.create("甲执事");
singleton.linkSession({
	partnerId: partnerA.id,
	role: "canonical",
	routeKey: "canonical",
	sessionId: 101,
});
const partnerB = singleton.create("乙执事");
singleton.linkSession({
	partnerId: partnerB.id,
	role: "canonical",
	routeKey: "canonical",
	sessionId: 202,
});
const scopeA = scopeKey({ type: "partner", id: partnerA.id });
const scopeB = scopeKey({ type: "partner", id: partnerB.id });

after(() => {
	closeWorkStore();
	singleton.close();
	// Windows 上 sqlite 句柄释放有延迟，直接删临时目录会偶发 EPERM（全量套件下才现）。
	// 删不掉不影响本文件任何断言的结论，重试几次后仍失败就留给系统清理，
	// 不要用清理失败把一批已经通过的用例染红（同 approval-resume-memory.test.ts）。
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		/* 临时目录，清理失败不影响结论 */
	}
});

function settlement(over: Partial<WorkSettlementInput> = {}): WorkSettlementInput {
	return {
		ticketId: "T-a",
		requirement: "整理本周纪要",
		status: "done",
		line: "三个探针全绿",
		productDirs: ["runs/T-a/1-note"],
		originConversationId: 101,
		domain: "frontend",
		...over,
	};
}

/** 从写口之外的连接读回，验的确实是落盘后的记录。 */
function workRows(scope = scopeA): Array<{ id: string; kind: string; content: string; source: string }> {
	const db = new SqliteMemoryStore(process.env.MEMORY_DB_PATH as string);
	try {
		return db.search({ scopes: [scope], kinds: ["work"], limit: 1000 });
	} finally {
		db.close();
	}
}

/** 经验层（2026-11-10 批 17 §一）：同 scope 下 kind=experience 的记录。 */
function experienceRows(scope = scopeA) {
	const db = new SqliteMemoryStore(process.env.MEMORY_DB_PATH as string);
	try {
		return db.search({ scopes: [scope], kinds: ["experience"], limit: 1000 });
	} finally {
		db.close();
	}
}

// ─────────────────────────────────────────────────────────
// E2：结算落 work 记录
// ─────────────────────────────────────────────────────────

function mkResult(status: TicketResult["status"], ticketId = "T-1"): TicketResult {
	return {
		ticketId,
		status,
		line: "结论一行",
		tasks: [
			{
				seq: 1,
				slug: "note",
				title: "整理",
				status: "passed",
				reason: "",
				dir: "runs/T-1/1-note",
			},
		],
	} as TicketResult;
}

async function settleWith(opts: {
	status?: TicketResult["status"];
	reject?: boolean;
	canceled?: boolean;
}): Promise<WorkSettlementInput[]> {
	const calls: WorkSettlementInput[] = [];
	const finish: Promise<TicketResult> = opts.reject
		? Promise.reject(new Error("boom"))
		: Promise.resolve(mkResult(opts.status ?? "done"));
	const { outcome } = startDelegation(
		{ conversationId: 101, domain: "frontend", requirement: "把按钮改成蓝色" },
		{
			run: (_request: ChancellorRequest, options: { onEvent?: (e: ChancellorEvent) => void }) => {
				options.onEvent?.({ type: "ticket", ticketId: "T-1", message: "已受理" } as ChancellorEvent);
				return finish;
			},
			emit: () => undefined,
			report: () => undefined,
			autoReport: false,
			...(opts.canceled ? { isCanceled: () => true } : {}),
			recordWork: (input: WorkSettlementInput) => calls.push(input),
		},
	);
	await outcome.catch(() => undefined);
	return calls;
}

test("结算落 work：done / aborted / canceled（取消）/ failed（跑挂）各落一条，中间态不写", async () => {
	const done = await settleWith({ status: "done" });
	assert.equal(done.length, 1, "done 终态写一次");
	assert.equal(done[0]?.status, "done");
	assert.equal(done[0]?.ticketId, "T-1");
	assert.equal(done[0]?.productDirs[0], "runs/T-1/1-note");
	assert.equal(done[0]?.originConversationId, 101);

	const aborted = await settleWith({ status: "aborted" });
	assert.equal(aborted.length, 1, "中止也结算");
	assert.equal(aborted[0]?.status, "aborted");

	const canceled = await settleWith({ status: "done", canceled: true });
	assert.equal(canceled.length, 1, "取消也结算，且记成 canceled");
	assert.equal(canceled[0]?.status, "canceled");

	const failed = await settleWith({ reject: true });
	assert.equal(failed.length, 1, "派单失败也结算");
	assert.equal(failed[0]?.status, "failed");
	assert.equal(failed[0]?.line, "派单失败，请稍后再试", "结果行不带原始错误");

	const canceledFail = await settleWith({ reject: true, canceled: true });
	assert.equal(canceledFail.length, 1, "作废单失败也结算");
	assert.equal(canceledFail[0]?.status, "canceled", "与 settle 口径一致：用户的取消优先");

	// needs_you / idle 是"等回答 / 等子单"的中间态：续跑会再 settle，写了就重复。
	assert.equal((await settleWith({ status: "needs_you" })).length, 0, "needs_you 不写");
	assert.equal((await settleWith({ status: "idle" })).length, 0, "idle 不写");
});

test("work 记录：落到发起执事 scope、格式一行、稳定 id 幂等、非执事不落、开关关不落", () => {
	const before = workRows().length;
	recordWorkSettlement(settlement());
	const rows = workRows();
	assert.equal(rows.length, before + 1, "落一条 work 记录");
	const row = rows.find((r) => r.id === "work:T-a")!;
	assert.ok(row, "id = work:<票号>");
	assert.equal(row.kind, "work");
	assert.equal(row.source, "work");
	assert.equal(row.content.includes("\n"), false, "content 是一行");
	assert.match(row.content, /T-a/);
	assert.match(row.content, /终态=done/);
	assert.match(row.content, /产物=runs\/T-a\/1-note/);
	assert.equal(
		formatWorkContent(settlement()),
		row.content,
		"formatWorkContent 是 content 的唯一来源",
	);

	// 终态重入：同票号是 upsert，不产生第二条履历。
	recordWorkSettlement(settlement({ status: "failed", line: "改判失败" }));
	assert.equal(workRows().length, before + 1, "终态写一次，重入不新增");

	// 主人 / 总管会话没有执事链接 → 不落账。
	recordWorkSettlement(settlement({ ticketId: "T-owner", originConversationId: 999 }));
	assert.equal(workRows().some((r) => r.id === "work:T-owner"), false, "非执事不落履历");

	// PARTNER_WORK_RECORD=false 一行回滚：一个字节都不写。
	const previous = process.env.PARTNER_WORK_RECORD;
	process.env.PARTNER_WORK_RECORD = "false";
	try {
		assert.equal(workRecordEnabled(), false);
		recordWorkSettlement(settlement({ ticketId: "T-off" }));
		assert.equal(workRows().some((r) => r.id === "work:T-off"), false, "开关关不落履历");
	} finally {
		if (previous === undefined) delete process.env.PARTNER_WORK_RECORD;
		else process.env.PARTNER_WORK_RECORD = previous;
	}
});

// ─────────────────────────────────────────────────────────
// 批 17 §一：经验层（experience）
// ─────────────────────────────────────────────────────────

test("experienceInsight：过门槛（≥40 字 + 动作词）才给，宁缺毋滥", () => {
	assert.equal(experienceInsight("做完了"), null, "太短不存");
	assert.equal(
		experienceInsight("这次把三个页面的标题都改成了蓝色，顺便统一了间距"),
		null,
		"没有具体动作词不存（哪怕够长）",
	);
	const insight = experienceInsight("先把原文件读一遍，改完再跑一次探针确认，最后把结果记进变更记录，并把踩过的坑补进说明");
	assert.ok(insight, "够长且含动作词应通过");
	assert.match(insight!, /下次同类活可以这样做/);
	assert.match(insight!, /读|改|跑/);
});

test("经验落账：done + 过门槛才写一条；失败 / 不过门槛 / 开关关都不写", () => {
	assert.equal(experienceRecordEnabled(), true, "PARTNER_EXPERIENCE 默认开");

	// done + 过门槛：work 与 experience 各一条
	recordWorkSettlement(
		settlement({
			ticketId: "T-exp",
			status: "done",
			line: "先把原文件读一遍，改完再跑一次探针确认，最后把结果记进变更记录，并把踩过的坑补进说明",
		}),
	);
	const rows = experienceRows();
	const row = rows.find((entry) => entry.id === "experience:T-exp")!;
	assert.ok(row, "id = experience:<票号>");
	assert.equal(row.kind, "experience");
	assert.equal(row.source, "work");
	assert.match(row.content, /下次同类活可以这样做/);
	assert.equal(workRows().some((entry) => entry.id === "work:T-exp"), true, "work 履历照旧落");

	// 重入不新增（稳定 id upsert）
	recordWorkSettlement(
		settlement({
			ticketId: "T-exp",
			status: "done",
			line: "先把原文件读一遍，改完再跑一次探针确认，最后把结果记进变更记录，并把踩过的坑补进说明",
		}),
	);
	assert.equal(experienceRows().filter((entry) => entry.id === "experience:T-exp").length, 1, "不重复落");

	// done 但不过门槛：只有 work，没有 experience
	recordWorkSettlement(settlement({ ticketId: "T-short", status: "done", line: "做完了" }));
	assert.equal(experienceRows().some((entry) => entry.id === "experience:T-short"), false, "不过门槛不写");

	// failed 哪怕结果行过门槛也不抽经验
	recordWorkSettlement(
		settlement({
			ticketId: "T-fail",
			status: "failed",
			line: "先把原文件读一遍，改完再跑一次探针确认，最后把结果记进变更记录，并把踩过的坑补进说明",
		}),
	);
	assert.equal(experienceRows().some((entry) => entry.id === "experience:T-fail"), false, "只有 done 才抽");

	// 开关 false：work 照落，experience 一个字节都不写
	const previous = process.env.PARTNER_EXPERIENCE;
	process.env.PARTNER_EXPERIENCE = "false";
	try {
		assert.equal(experienceRecordEnabled(), false);
		recordWorkSettlement(
			settlement({
				ticketId: "T-exp-off",
				status: "done",
				line: "先把原文件读一遍，改完再跑一次探针确认，最后把结果记进变更记录，并把踩过的坑补进说明",
			}),
		);
		assert.equal(
			experienceRows().some((entry) => entry.id === "experience:T-exp-off"),
			false,
			"开关关不抽经验",
		);
		assert.equal(
			workRows().some((entry) => entry.id === "work:T-exp-off"),
			true,
			"work 履历不受经验开关影响",
		);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_EXPERIENCE;
		else process.env.PARTNER_EXPERIENCE = previous;
	}
});

test("履历摘要：workSummaryFor 按 scope+kind 聚合（不打分不搞 KPI）、零记录返回 null", () => {
	// 乙执事（会话 202）的 scope 是干净的，专门验聚合。
	const statuses: WorkSettlementInput["status"][] = [
		"done",
		"done",
		"done",
		"failed",
		"aborted",
		"canceled",
	];
	statuses.forEach((status, index) => {
		recordWorkSettlement(
			settlement({
				ticketId: `B-${index}`,
				status,
				originConversationId: 202,
				line: `结果 ${index}`,
			}),
		);
	});
	const summary = workSummaryFor(partnerB.id);
	assert.deepEqual(summary, { done: 3, failed: 1, stopped: 2, total: 6 }, "完成 3 / 失败 1 / 中止 2");

	// 结构化查询确实按 scope + kind 隔离：甲的记录不进乙的摘要。
	assert.equal(workRows(scopeB).length, 6);
	assert.equal(workRows(scopeB).every((r) => r.kind === "work"), true);

	// 没记录的执事 → null（装配据此整行省略「近 10 单」）。
	const nobody = singleton.create("丙执事");
	assert.equal(workSummaryFor(nobody.id), null, "零记录不加");
});

// ─────────────────────────────────────────────────────────
// E4：routine_manage 核心 + 上架开关
// ─────────────────────────────────────────────────────────

function tempStore(): { store: InstanceType<typeof PartnersStore>; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-routine-manage-"));
	const store = new PartnersStore(join(dir, "partners.sqlite"), join(dir, "homes"));
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const goodTriggers = [{ type: "cron", expr: "0 18 * * 5" }] as const;

test("routine_manage create：建自己的规则、校验与 HTTP 端点共用一份", () => {
	const { store, cleanup } = tempStore();
	try {
		const a = store.create("甲");
		const ctx = { store, partnerId: a.id };
		const created = performRoutineAction(
			{
				action: "create",
				name: "每周五盘点",
				prompt: "读履历，写一段总结，向主人汇报",
				triggers: [...goodTriggers],
				sessionMode: "fresh",
			},
			ctx,
		);
		assert.equal(created.ok, true);
		assert.equal(created.schedule, true, "create 要排 durable 闹钟");
		const routine = store.getRoutine(created.routineId!)!;
		assert.equal(routine.partnerId, a.id);
		assert.equal(routine.enabled, true);
		assert.equal(routine.sessionMode, "fresh");
		assert.equal(routine.revision, 1);

		// 坏参数：name 空 / prompt 空 / triggers 坏 → bad_request，不落库。
		assert.equal(
			performRoutineAction({ action: "create", name: "", prompt: "x", triggers: [...goodTriggers] }, ctx).code,
			"bad_request",
		);
		assert.equal(
			performRoutineAction({ action: "create", name: "x", prompt: "", triggers: [...goodTriggers] }, ctx).code,
			"bad_request",
		);
		assert.equal(
			performRoutineAction({ action: "create", name: "x", prompt: "x", triggers: [] }, ctx).code,
			"bad_request",
		);
		assert.equal(store.listRoutines(a.id).length, 1, "坏参数不落库");
		assert.equal(
			validateTriggers([{ type: "cron", expr: "0 18" }]),
			"cron 触发器需要 5 段表达式（分 时 日 月 周）",
		);
	} finally {
		cleanup();
	}
});

test("routine_manage 只动自己的：动别人的规则一律 not_found（不泄存在性），且不改动", () => {
	const { store, cleanup } = tempStore();
	try {
		const a = store.create("甲");
		const b = store.create("乙");
		const own = performRoutineAction(
			{ action: "create", name: "甲的规则", prompt: "x", triggers: [...goodTriggers] },
			{ store, partnerId: a.id },
		);
		const id = own.routineId!;
		for (const action of ["disable", "enable", "delete"] as const) {
			const result = performRoutineAction({ action, id }, { store, partnerId: b.id });
			assert.equal(result.code, "not_found", `${action} 别人的规则 → not_found`);
			assert.equal(result.message, "找不到这条例行规则（只能管理自己的）", "找不到/不是自己的同一句话");
		}
		assert.equal(store.getRoutine(id)?.enabled, true, "别人的规则一个字段都没动");
		assert.equal(store.getRoutine(id) !== null, true, "没被删掉");
	} finally {
		cleanup();
	}
});

test(`routine_manage 上限：每执事活动规则 ≤${ROUTINE_SELF_SERVICE_LIMIT} 条，create / enable 都挡`, () => {
	const { store, cleanup } = tempStore();
	try {
		const a = store.create("甲");
		const ctx = { store, partnerId: a.id };
		for (let index = 0; index < ROUTINE_SELF_SERVICE_LIMIT; index += 1) {
			assert.equal(
				performRoutineAction(
					{ action: "create", name: `规则 ${index}`, prompt: "x", triggers: [...goodTriggers] },
					ctx,
				).ok,
				true,
			);
		}
		const extra = performRoutineAction(
			{ action: "create", name: "第 11 条", prompt: "x", triggers: [...goodTriggers] },
			ctx,
		);
		assert.equal(extra.code, "limit");
		assert.equal(extra.ok, false);
		assert.match(extra.message, /最多 10 条/);
		assert.equal(store.listRoutines(a.id).length, ROUTINE_SELF_SERVICE_LIMIT, "超限不落库");

		// 停一条 → 腾出名额可建；再启用被停的那条时又满 → enable 也挡。
		const first = store.listRoutines(a.id)[0]!;
		performRoutineAction({ action: "disable", id: first.id }, ctx);
		assert.equal(
			performRoutineAction({ action: "create", name: "新的一条", prompt: "x", triggers: [...goodTriggers] }, ctx).ok,
			true,
		);
		assert.equal(performRoutineAction({ action: "enable", id: first.id }, ctx).code, "limit", "活动满 10 条时启用也挡");
	} finally {
		cleanup();
	}
});

test("routine_manage disable / enable / delete：revision+1 作废在飞闹钟，enable 重排", () => {
	const { store, cleanup } = tempStore();
	try {
		const a = store.create("甲");
		const ctx = { store, partnerId: a.id };
		const created = performRoutineAction(
			{ action: "create", name: "巡检", prompt: "x", triggers: [...goodTriggers] },
			ctx,
		);
		const id = created.routineId!;
		assert.equal(performRoutineAction({ action: "disable", id }, ctx).ok, true);
		assert.equal(store.getRoutine(id)?.enabled, false);
		assert.equal(store.getRoutine(id)?.revision, 2, "disable 也 revision+1，在飞闹钟作废");

		const enabled = performRoutineAction({ action: "enable", id }, ctx);
		assert.equal(enabled.schedule, true, "enable 要重排");
		assert.equal(store.getRoutine(id)?.enabled, true);
		assert.equal(store.getRoutine(id)?.revision, 3);

		assert.equal(performRoutineAction({ action: "delete", id }, ctx).ok, true);
		assert.equal(store.getRoutine(id), null, "delete 后定义没了，在飞闹钟醒来自然作废");
	} finally {
		cleanup();
	}
});

test("routine_manage 上架开关：不传 / false → 工具不上架；true → 上架且进闸门与高危档", () => {
	const base = { memory: null, scopeOf: (() => ({ type: "global" })) as never, partners: true };
	assert.equal(
		createTools({ ...base, routineSelfService: false }).some((t) => t.name === "routine_manage"),
		false,
		"ROUTINE_SELF_SERVICE=false 不上架",
	);
	assert.equal(
		createTools({ ...base }).some((t) => t.name === "routine_manage"),
		false,
		"不传也不上架（单测 / 探针零改动）",
	);
	assert.equal(
		createTools({
			...base,
			routineSelfService: true,
			scheduleRoutine: async () => undefined,
		}).some((t) => t.name === "routine_manage"),
		true,
		"显式开才上架",
	);
	assert.equal(WRITE_TOOLS.has("routine_manage"), true, "新工具进 WRITE_TOOLS 过闸门");
	assert.equal(
		DEFAULT_CRITICAL_TOOLS.includes("routine_manage"),
		true,
		"10-C 三档里归高危（与 partner_manage 同档）",
	);
});

test("routine_manage 工具：非执事会话拒；执事会话 create 落库并排链；描述带盘点口径", async () => {
	const scheduled: string[] = [];
	const tools = createTools({
		memory: null,
		scopeOf: (() => ({ type: "global" })) as never,
		partners: true,
		routineSelfService: true,
		scheduleRoutine: async (id: string) => {
			scheduled.push(id);
		},
	});
	const tool = tools.find((entry) => entry.name === "routine_manage")!;
	const run = async (args: Record<string, unknown>, conversationId: number): Promise<string> => {
		const result = await tool.execute(args as never, { conversationId } as never, {} as never);
		return (result.output ?? [])
			.map((item) => (item.type === "text" ? item.text : ""))
			.join("");
	};

	// 主人会话（没有执事链接）→ 明确拒绝，不落库。
	const owner = await run(
		{ action: "create", name: "不该出生", prompt: "x", triggers: [...goodTriggers] },
		999,
	);
	assert.match(owner, /不属于任何执事/);
	// 契约（批 25 §一）：拒绝走 err(not_partner_session)，不是 ok。
	const ownerParsed = JSON.parse(owner) as {
		ok: boolean;
		error?: { code: string; message: string };
	};
	assert.equal(ownerParsed.ok, false);
	assert.equal(ownerParsed.error?.code, "not_partner_session");
	assert.equal(
		ownerParsed.error?.message,
		"这个会话不属于任何执事，不能自建巡逻（只有执事能给自己建规则）。",
	);

	// 执事会话（101 = 甲）→ 建自己的规则，且排链函数被调用一次。
	const before = singleton.listRoutines(partnerA.id).length;
	const ok = await run(
		{
			action: "create",
			name: "自建周盘点",
			prompt: "读履历，写一段总结，向主人汇报",
			triggers: [...goodTriggers],
		},
		101,
	);
	assert.match(ok, /已建好例行规则/);
	const okParsed = JSON.parse(ok) as { ok: boolean; data?: { message?: string } };
	assert.equal(okParsed.ok, true);
	assert.match(okParsed.data?.message ?? "", /^已建好例行规则「自建周盘点」/);
	assert.equal(singleton.listRoutines(partnerA.id).length, before + 1);
	const created = singleton.listRoutines(partnerA.id).at(-1)!;
	assert.equal(created.partnerId, partnerA.id, "partnerId 绑定调用者会话，不是模型传的");
	assert.equal(scheduled.filter((id) => id === created.id).length, 1, "create 排一次 durable 闹钟");

	// 提示词层口径：不自动建周回顾规则、盘点落 episode、向主人汇报、不搞 KPI。
	assert.match(String(tool.description), /不打分、不列 KPI 数字/);
	assert.match(String(tool.description), /不要自己悄悄创建回顾规则/);
});
