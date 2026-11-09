import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MemoryScope } from "@lifediary/memory";
import type { ChancellorEvent, ChancellorRequest, TicketResult } from "../../../../../chancellor/src/index.ts";
import type { SkillStore } from "./skills.ts";
import { createTools } from "./tools.ts";
import {
	ATTENTION_ONE_QUESTION,
	CLARIFY_CONTRACT,
	GROUNDING_DISCIPLINE,
	REPORT_FOUR_LINES,
	WORK_SILENCE_DISCIPLINE,
	clarifyContractEnabled,
	clarifyContractFor,
	formatReport,
	startDelegation,
	type DelegationEvent,
	type DelegationReport,
} from "./delegation.ts";
import {
	RULING_DISCIPLINE,
	TAKEOVER_HINT,
	VERIFICATION_IRON_LAW,
	lifecycleOwnsVerification,
	verificationIronLawFor,
} from "./agent/turn-gate.ts";
import {
	ARTIFACT_HANDOFF,
	OWNER_DATA_DISCIPLINE,
	buildPartnerDisciplineSection,
	buildPartnerTurnContext,
	ownerDataDisciplineEnabled,
} from "./agent/partner-context.ts";
import { PARTNER_CONTRACT_SECTIONS, PartnersStore, partnerContractTemplate } from "./partners.ts";
import { failureStreak } from "./failure-streak.ts";

/**
 * 批 12（保证实现提示词七件）的口径断言：常量实文、装配点、四行回报、
 * 失败连击的接管提示。全部临时目录，不碰真实 `.data/`。
 */

const FIXED_TEXTS: Array<[string, string]> = [
	["VERIFICATION_IRON_LAW", VERIFICATION_IRON_LAW],
	["RULING_DISCIPLINE", RULING_DISCIPLINE],
	["WORK_SILENCE_DISCIPLINE", WORK_SILENCE_DISCIPLINE],
	["GROUNDING_DISCIPLINE", GROUNDING_DISCIPLINE],
	["ATTENTION_ONE_QUESTION", ATTENTION_ONE_QUESTION],
	["REPORT_FOUR_LINES", REPORT_FOUR_LINES],
	["TAKEOVER_HINT", TAKEOVER_HINT],
	["CLARIFY_CONTRACT", CLARIFY_CONTRACT],
	["ARTIFACT_HANDOFF", ARTIFACT_HANDOFF],
	["OWNER_DATA_DISCIPLINE", OWNER_DATA_DISCIPLINE],
];

test("固定字节：八段口径都不含日期 / 时刻 / 会话 id", () => {
	for (const [name, text] of FIXED_TEXTS) {
		assert.ok(text.length > 0, `${name} 不能为空`);
		assert.equal(/20\d{2}-\d{1,2}-\d{1,2}/.test(text), false, `${name} 不含日期`);
		assert.equal(/\d{1,2}:\d{2}/.test(text), false, `${name} 不含时刻`);
	}
});

test("开工前先问清：三件事 + 一次一问 + 小活不问；只给总管", () => {
	assert.match(CLARIFY_CONTRACT, /大活（要改 3 个以上文件 \/ 要跑命令 \/ 涉及不可逆操作）/);
	assert.match(CLARIFY_CONTRACT, /对象是什么/);
	assert.match(CLARIFY_CONTRACT, /期望的结果长什么样/);
	assert.match(CLARIFY_CONTRACT, /怎么算做好了/);
	assert.match(CLARIFY_CONTRACT, /一次只问一个/);
	assert.match(CLARIFY_CONTRACT, /小活不问/);
	// 只给总管 / 主对话：普通执事走 partner-context 的提问纪律。
	assert.equal(clarifyContractFor(null), CLARIFY_CONTRACT);
	assert.equal(clarifyContractFor("chief"), CLARIFY_CONTRACT);
	assert.equal(clarifyContractFor("partner-uuid"), undefined);
	// 开关旁路（缺省开；显式 false 关）。
	assert.equal(clarifyContractEnabled({} as NodeJS.ProcessEnv), true);
	assert.equal(clarifyContractEnabled({ AGENT_CLARIFY_CONTRACT: "false" } as NodeJS.ProcessEnv), false);
	const saved = process.env.AGENT_CLARIFY_CONTRACT;
	process.env.AGENT_CLARIFY_CONTRACT = "false";
	try {
		assert.equal(clarifyContractFor(null), undefined);
	} finally {
		if (saved === undefined) delete process.env.AGENT_CLARIFY_CONTRACT;
		else process.env.AGENT_CLARIFY_CONTRACT = saved;
	}
});

test("产物交接：产物落盘、点名路径、下一棒从产物开始", () => {
	assert.match(ARTIFACT_HANDOFF, /产出物必须落盘/);
	assert.match(ARTIFACT_HANDOFF, /下一棒从产物开始，不要从转述开始/);
	assert.match(ARTIFACT_HANDOFF, /点名产物路径/);
	assert.match(ARTIFACT_HANDOFF, /没有落盘的「做完了」不算交接完成/);
	assert.ok(buildPartnerDisciplineSection("partner-uuid").includes(ARTIFACT_HANDOFF), "执事纪律段包含产物交接");
	assert.ok(buildPartnerDisciplineSection("chief").includes(ARTIFACT_HANDOFF), "总管纪律段同样包含");
	const saved = process.env.PARTNER_ARTIFACT_HANDOFF;
	process.env.PARTNER_ARTIFACT_HANDOFF = "false";
	try {
		assert.ok(!buildPartnerDisciplineSection("partner-uuid").includes(ARTIFACT_HANDOFF), "开关关掉整段不注入");
	} finally {
		if (saved === undefined) delete process.env.PARTNER_ARTIFACT_HANDOFF;
		else process.env.PARTNER_ARTIFACT_HANDOFF = saved;
	}
});

test("主人数据红线（批 21 §七）：分级 / 提案制 / 日记不可重写 / 引原话不打分", () => {
	assert.match(OWNER_DATA_DISCIPLINE, /数据域分级/);
	assert.match(OWNER_DATA_DISCIPLINE, /只能追加或经提案/);
	assert.match(OWNER_DATA_DISCIPLINE, /主人配置=只读/);
	assert.match(OWNER_DATA_DISCIPLINE, /有判断，无权力/);
	assert.match(OWNER_DATA_DISCIPLINE, /一次批准只覆盖一件事/);
	assert.match(OWNER_DATA_DISCIPLINE, /日记域永不删除、重写、重排/);
	assert.match(OWNER_DATA_DISCIPLINE, /引原文并标日期/);
	assert.match(OWNER_DATA_DISCIPLINE, /不打分不评判/);
	assert.ok(
		buildPartnerDisciplineSection("partner-uuid").includes(OWNER_DATA_DISCIPLINE),
		"执事纪律段包含主人数据红线",
	);
	assert.ok(buildPartnerDisciplineSection("chief").includes(OWNER_DATA_DISCIPLINE), "总管纪律段同样包含");
	const saved = process.env.PARTNER_OWNER_DATA_DISCIPLINE;
	process.env.PARTNER_OWNER_DATA_DISCIPLINE = "false";
	try {
		assert.ok(
			!buildPartnerDisciplineSection("partner-uuid").includes(OWNER_DATA_DISCIPLINE),
			"开关关掉整段不注入",
		);
		assert.equal(ownerDataDisciplineEnabled({} as NodeJS.ProcessEnv), true, "缺省开");
	} finally {
		if (saved === undefined) delete process.env.PARTNER_OWNER_DATA_DISCIPLINE;
		else process.env.PARTNER_OWNER_DATA_DISCIPLINE = saved;
	}
});

test("验证铁律：五步门 + 对照表 + 红旗，≤500 字", () => {
	assert.equal(VERIFICATION_IRON_LAW.length <= 500, true, `实际 ${VERIFICATION_IRON_LAW.length} 字`);
	assert.match(VERIFICATION_IRON_LAW, /这一轮里没有真的跑过验证/);
	assert.match(VERIFICATION_IRON_LAW, /五步门/);
	assert.match(VERIFICATION_IRON_LAW, /说「测试通过」→ 要有 0 失败的输出/);
	assert.match(VERIFICATION_IRON_LAW, /说「做完了」→ 要有落盘的改动/);
	assert.match(VERIFICATION_IRON_LAW, /应该 \/ 大概 \/ 看起来没问题/);
});

test("裁决纪律：继续干 + 四停 + 一行账", () => {
	assert.match(RULING_DISCIPLINE, /要不要我继续/);
	assert.match(RULING_DISCIPLINE, /只有四种情况停下问人/);
	assert.match(RULING_DISCIPLINE, /不可逆或破坏性的操作/);
	assert.match(RULING_DISCIPLINE, /裁决：<决定了什么>/);
});

test("答案接地：数值 / 日期 / 引文要查得到，查不到就说记不清", () => {
	assert.match(GROUNDING_DISCIPLINE, /必须真的能在记忆 \/ transcript \/ 文件里查到/);
	assert.match(GROUNDING_DISCIPLINE, /recall_sessions/);
	assert.match(GROUNDING_DISCIPLINE, /我记不清了/);
	assert.match(GROUNDING_DISCIPLINE, /不要编/);
});

test("四行回报：状态 / 结果 / 证据 / 解锁 逐行", () => {
	const lines = REPORT_FOUR_LINES.split("\n");
	assert.equal(lines.length, 4);
	assert.match(lines[0] ?? "", /^状态：完成 \/ 部分完成 \/ 卡住$/);
	assert.match(lines[1] ?? "", /^结果：/);
	assert.match(lines[2] ?? "", /^证据：/);
	assert.match(lines[3] ?? "", /^解锁：/);
});

test("归属：总管与普通会话归 lifecycle，普通执事归 partner-context", () => {
	assert.equal(verificationIronLawFor("partner-uuid"), VERIFICATION_IRON_LAW);
	assert.equal(verificationIronLawFor("chief"), undefined);
	assert.equal(verificationIronLawFor(null), undefined);
	assert.equal(lifecycleOwnsVerification(null), true);
	assert.equal(lifecycleOwnsVerification("chief"), true);
	assert.equal(lifecycleOwnsVerification("partner-uuid"), false);
});

test("装配：执事轮输入含四段纪律；总管轮不重复验证铁律", () => {
	const root = mkdtempSync(join(tmpdir(), "lifediary-batch12-"));
	const store = new PartnersStore(join(root, "partners.sqlite"), join(root, "homes"));
	try {
		const partner = store.create("阿岚");
		store.linkSession({ partnerId: partner.id, role: "canonical", routeKey: "canonical", sessionId: 606 });
		const context = buildPartnerTurnContext(partner.id, 606, {
			store,
			workRoot: join(root, "runs"),
			approvals: { pendingOf: () => [] },
		});
		const text = context.text ?? "";
		assert.match(text, /【验证铁律】/);
		assert.match(text, /【裁决纪律】/);
		assert.match(text, /【干活期间】/);
		assert.match(text, /【提问纪律】/);
		assert.ok(text.indexOf("【验证铁律】") < text.indexOf("【裁决纪律】"));

		store.ensureChief("你是总管。");
		store.linkSession({ partnerId: "chief", role: "canonical", routeKey: "canonical", sessionId: 607 });
		const chief = buildPartnerTurnContext("chief", 607, {
			store,
			workRoot: join(root, "runs"),
			approvals: { pendingOf: () => [] },
		});
		assert.ok(!(chief.discipline.includes("【验证铁律】")), "总管的验证铁律由 lifecycle 注入，这里不重复");
		assert.match(chief.discipline, /【裁决纪律】/);
		assert.equal(
			buildPartnerDisciplineSection("chief"),
			[
				RULING_DISCIPLINE,
				WORK_SILENCE_DISCIPLINE,
				GROUNDING_DISCIPLINE,
				ARTIFACT_HANDOFF,
				OWNER_DATA_DISCIPLINE,
				ATTENTION_ONE_QUESTION,
			].join("\n\n"),
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("delegate 描述：尾部带四行回报与裁决纪律", () => {
	const scope: MemoryScope = { type: "global" };
	const skills: SkillStore = { names: () => [], manual: () => undefined, indexFor: () => undefined };
	const tool = createTools({ memory: null, scopeOf: () => scope, delegate: true, skills }).find(
		(entry) => entry.name === "delegate",
	);
	assert.ok(tool, "delegate 应注册");
	const description = String(tool.description ?? "");
	assert.ok(description.includes(REPORT_FOUR_LINES), "四行格式原文被注入");
	assert.ok(description.includes(RULING_DISCIPLINE), "裁决纪律原文被注入");
	assert.match(description, /给<你的名字>：/);
});

test("formatReport：needs_you 带接管建议时追加；不带时逐字节不变", () => {
	const result: TicketResult = {
		ticketId: "T-1",
		status: "needs_you",
		line: "等你",
		tasks: [],
		attention: { kind: "need_decision", question: "选哪个？" },
	};
	const plain = formatReport(result, "frontend");
	assert.ok(!plain.text.includes("建议你来接手"));
	const hinted = formatReport(result, "frontend", { takeover: true });
	assert.match(hinted.text, /建议你来接手/);
	assert.match(hinted.text, /选哪个？/);
});

/** 跑一张 needs_you 单：同步发单号，settle 在后台完成。 */
async function runNeedsYou(domain: string, ticketId: string, conversationId: number) {
	const events: DelegationEvent[] = [];
	const reports: DelegationReport[] = [];
	const { outcome } = startDelegation(
		{ conversationId, domain, requirement: "随便一件活" },
		{
			run: (_request: ChancellorRequest, options: { onEvent?: (event: ChancellorEvent) => void }) => {
				options.onEvent?.({ type: "ticket", ticketId, message: "已受理" });
				return Promise.resolve({
					ticketId,
					status: "needs_you",
					line: "等你回答",
					tasks: [],
					attention: { kind: "need_decision", question: "选哪个？" },
				} as TicketResult);
			},
			emit: (_conversationId, event) => events.push(event),
			report: (_conversationId, report) => reports.push(report),
			autoReport: true,
		},
	);
	await outcome;
	return {
		questions: events.filter((event) => event.type === "attention").map((event) => event.question),
		reports,
	};
}

test("三次同类失败：第 3 次在 attention 卡片与汇报行都追加接管建议", async () => {
	const domain = "batch12-streak-hint";
	failureStreak().recordSuccess(domain);
	const first = await runNeedsYou(domain, "T-s1", 701);
	const second = await runNeedsYou(domain, "T-s2", 701);
	const third = await runNeedsYou(domain, "T-s3", 701);
	assert.ok(!first.questions[0]?.includes(TAKEOVER_HINT), "第 1 次不提示");
	assert.ok(!second.questions[0]?.includes(TAKEOVER_HINT), "第 2 次不提示");
	assert.match(third.questions[0] ?? "", /建议你来接手/);
	assert.ok(!first.reports[0]?.text.includes("建议你来接手"));
	assert.match(third.reports[0]?.text ?? "", /建议你来接手/);
});

test("连击开关关闭：记录照常、卡片不追加", async () => {
	const domain = "batch12-streak-off";
	failureStreak().recordSuccess(domain);
	const previous = process.env.AGENT_TAKEOVER_HINT;
	process.env.AGENT_TAKEOVER_HINT = "false";
	try {
		await runNeedsYou(domain, "T-o1", 702);
		await runNeedsYou(domain, "T-o2", 702);
		const third = await runNeedsYou(domain, "T-o3", 702);
		assert.ok(!third.questions[0]?.includes(TAKEOVER_HINT));
		assert.ok(!third.reports[0]?.text.includes("建议你来接手"));
	} finally {
		if (previous === undefined) delete process.env.AGENT_TAKEOVER_HINT;
		else process.env.AGENT_TAKEOVER_HINT = previous;
	}
});

test("中间成功一次：连击清零，后面两次失败不触发", async () => {
	const domain = "batch12-streak-reset";
	failureStreak().recordSuccess(domain);
	await runNeedsYou(domain, "T-r1", 703);
	await runNeedsYou(domain, "T-r2", 703);
	failureStreak().recordSuccess(domain); // 相当于同一来源成功了一单
	await runNeedsYou(domain, "T-r3", 703);
	const last = await runNeedsYou(domain, "T-r4", 703);
	assert.ok(!last.questions[0]?.includes(TAKEOVER_HINT));
});

test("契约模板：四节标题逐字，决策分级带调查铁律", () => {
	assert.deepEqual([...PARTNER_CONTRACT_SECTIONS], ["职责范围", "决策分级", "验收标准", "汇报对象"]);
	const template = partnerContractTemplate();
	for (const section of PARTNER_CONTRACT_SECTIONS) {
		assert.ok(template.includes(`## ${section}`));
	}
	assert.match(template, /没有调查不许改/);
});
