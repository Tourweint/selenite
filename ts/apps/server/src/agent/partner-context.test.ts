import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../../../packages/chancellor/src/store.ts";
import type { Ticket } from "../../../../packages/chancellor/src/types.ts";
import {
	BRIEF_CARD_RULES,
	briefCardRulesEnabled,
	buildPartnerDisciplineSection,
	buildPartnerDisciplineDefault,
	buildPartnerStatusSection,
	buildPartnerTurnContext,
	renderContractSection,
	splitContractSections,
	validateDisciplineSource,
} from "./partner-context.ts";
import { ATTENTION_REPLY_GUIDANCE } from "../delegation.ts";
import {
	PARTNER_CONTRACT_SECTIONS,
	PartnersStore,
	partnerContractEnabled,
	partnerContractTemplate,
} from "../partners.ts";
import {
	PartnerPersonaScenarioSchema,
	PartnerPersonaStyleSchema,
	PartnerPersonaValuesSchema,
	type PartnerPersonaContents,
} from "@lifediary/shared";
import {
	PERSONA_PRESETS,
	defaultPersonaModules,
	effectivePersonaModules,
	personaModulesEnabled,
	readPersonaContents,
	renderPersonaBlocks,
	renderPersonaSection,
	writePersonaContents,
} from "../partner-persona.ts";

/**
 * 员工人格化刀一（E1 契约 / E5 状态感 / B2 受阻口径）的最小充分单测。
 *
 * 全程临时目录：不碰真实 `.data/`（AGENTS 的测试纪律）；审批用桩（ApprovalStore
 * 是进程单例，单测里不该去读真实的 approvals.json）。
 */

function tempRoot(): { root: string; db: string; homes: string; workRoot: string } {
	const root = mkdtempSync(join(tmpdir(), "lifediary-partner-context-"));
	return {
		root,
		db: join(root, "partners.sqlite"),
		homes: join(root, "homes"),
		workRoot: join(root, "runs"),
	};
}

function ticketFixture(
	workRoot: string,
	id: string,
	status: string,
	extra: Record<string, unknown> = {},
): Ticket {
	const now = new Date().toISOString();
	return {
		id,
		prompt: `夹具 ${id}`,
		status,
		created_at: now,
		updated_at: now,
		options: { dry: true, maxTasks: 8, workRoot },
		...extra,
	} as Ticket;
}

test("契约：新建执事播种四节标题（决策分级带调查铁律）；改契约 / 改 SOUL 只写盘 + 计数，留上一份可回滚", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("小澈");
		assert.equal(partner.currentVersion, 1);
		assert.ok(existsSync(join(store.homeOf(partner.id), "CONTRACT.md")), "新建执事要有 CONTRACT.md");
		const template = store.readContractFromHome(partner.id) ?? "";
		assert.equal(template, partnerContractTemplate());
		// 2026-11-10 批 12 §一.5：四节标题逐字不动，「决策分级」带调查铁律默认正文。
		for (const section of PARTNER_CONTRACT_SECTIONS) {
			assert.ok(template.includes(`## ${section}`), `标题逐字保留：${section}`);
		}
		assert.match(template, /没有调查不许改/);
		assert.match(template, /同一条思路连修 3 次还不行/);
		assert.match(renderContractSection(template) ?? "", /## 决策分级[\s\S]*自带验收证据/);

		// 2026-11-15 快照退役：改契约 = 写盘 + 计数 +1，SOUL 正文不动、没有快照行。
		const soulBefore = store.readSoulFromHome(partner.id) ?? "";
		const contract1 = [
			"## 职责范围",
			"负责前端与桌面壳。",
			"",
			"## 决策分级",
			"改样式自己定；改接口先申请。",
			"",
			"## 验收标准",
			"跑通 typecheck + 探针。",
			"",
			"## 汇报对象",
			"向总管汇报，每周一次。",
		].join("\n");
		const v2 = store.bumpContract(partner.id, contract1);
		assert.equal(v2, 2);
		assert.equal(store.readContractFromHome(partner.id), contract1);
		assert.equal(store.readSoulFromHome(partner.id), soulBefore, "改契约不动 SOUL 正文");

		// 改 SOUL：写盘 + 上一份进 SOUL.prev.md（单槽）
		const v3 = store.bumpSoul(partner.id, "你是小澈，改过的人格。");
		assert.equal(v3, 3);
		assert.equal(store.readSoulFromHome(partner.id), "你是小澈，改过的人格。");
		assert.equal(store.readHomeFile(partner.id, "SOUL.prev.md"), soulBefore);

		// 回滚 = 与上一份交换；再按一次 = 撤销回滚
		const rolled = store.rollbackSoul(partner.id);
		assert.equal(rolled, soulBefore);
		assert.equal(store.readSoulFromHome(partner.id), soulBefore);
		assert.equal(store.readHomeFile(partner.id, "SOUL.prev.md"), "你是小澈，改过的人格。");
		assert.equal(store.get(partner.id)?.currentVersion, 4);

		// 候选链：家目录 model-chain.json 是唯一事实源（不再寄存版本行）
		const v5 = store.setModelChain(partner.id, [
			{ providerId: "faux", modelId: "faux", keyEnv: "PROBE_KEY" },
		]);
		assert.equal(v5, 5);
		assert.deepEqual(store.getModelChain(partner.id), [
			{ providerId: "faux", modelId: "faux", keyEnv: "PROBE_KEY" },
		]);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("老库迁移：partner_versions 整表退役——候选链搬进家目录、表 DROP、计数保留", () => {
	const { root, db, homes } = tempRoot();
	try {
		// 手工造一份带版本表的旧库（当前版本行挂着候选链）
		const legacy = new DatabaseSync(db);
		legacy.exec(`
			CREATE TABLE partners (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
				current_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
			CREATE TABLE partner_versions (
				partner_id TEXT NOT NULL, version INTEGER NOT NULL, soul_source TEXT NOT NULL,
				contract_source TEXT, capabilities TEXT, created_at TEXT NOT NULL,
				PRIMARY KEY (partner_id, version)
			);
		`);
		const now = new Date().toISOString();
		legacy.prepare(
			"INSERT INTO partners (id, name, status, current_version, created_at, updated_at) VALUES (?, ?, 'active', 3, ?, ?)",
		).run("legacy-id", "老执事", now, now);
		legacy.prepare(
			"INSERT INTO partner_versions (partner_id, version, soul_source, contract_source, capabilities, created_at) VALUES (?, 3, ?, NULL, ?, ?)",
		).run(
			"legacy-id",
			"老身份",
			JSON.stringify({ modelChain: [{ providerId: "faux", modelId: "faux", keyEnv: "PROBE_KEY" }] }),
			now,
		);
		legacy.close();

		const store = new PartnersStore(db, homes);
		try {
			const partner = store.get("legacy-id");
			assert.ok(partner, "旧库打开后档案还在");
			assert.equal(partner?.currentVersion, 3, "计数保留（下一轮生效的记账位）");
			assert.deepEqual(store.getModelChain("legacy-id"), [
				{ providerId: "faux", modelId: "faux", keyEnv: "PROBE_KEY" },
			], "候选链搬进 model-chain.json");
			assert.ok(existsSync(join(store.homeOf("legacy-id"), "model-chain.json")));
			// 表已退役：新保存照常走磁盘 + 计数
			const next = store.bumpContract("legacy-id", "## 职责范围\n新契约");
			assert.equal(next, 4);
			assert.equal(store.readContractFromHome("legacy-id"), "## 职责范围\n新契约");
		} finally {
			store.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("开关旁路：PARTNER_CONTRACT=false → 不播种文件、不渲染契约；在办段不受影响", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const previous = process.env.PARTNER_CONTRACT;
	process.env.PARTNER_CONTRACT = "false";
	const store = new PartnersStore(db, homes);
	try {
		assert.equal(partnerContractEnabled(), false);
		const partner = store.create("小澈");
		assert.equal(existsSync(join(store.homeOf(partner.id), "CONTRACT.md")), false, "关着就不建文件");
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 101,
		});
		// 即使库里有契约快照，关着也不渲染
		assert.equal(renderContractSection("## 职责范围\n写点什么"), undefined);

		const saved = new Store(workRoot);
		saved.saveTicket(ticketFixture(workRoot, "T-off", "dispatching", { originConversationId: "101" }));
		saved.close();

		const context = buildPartnerTurnContext(partner.id, 101, {
			store,
			workRoot,
			approvals: { pendingOf: () => [] },
		});
		assert.equal(context.contract, null);
		assert.match(context.status ?? "", /T-off/, "在办段与契约开关无关");
		assert.ok(!(context.text ?? "").includes("【岗位契约】"));
	} finally {
		store.close();
		if (previous === undefined) delete process.env.PARTNER_CONTRACT;
		else process.env.PARTNER_CONTRACT = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("装配：SOUL / 岗位契约 / 当前在办三段各自可见，顺序 = 契约 → 在办", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("阿岚", { soulSeed: "你是阿岚，管桌面壳。" });
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 202,
		});
		store.bumpContract(
			partner.id,
			[
				"## 职责范围",
				"桌面壳与安装包。",
				"",
				"## 决策分级",
				"文案自己定；动安装流程先申请。",
				"",
				"## 验收标准",
				"能装能卸，探针全绿。",
				"",
				"## 汇报对象",
				"向总管汇报。",
			].join("\n"),
		);

		const saved = new Store(workRoot);
		saved.saveTicket(
			ticketFixture(workRoot, "T-doing", "dispatching", {
				originConversationId: "202",
				lastAction: "在改安装脚本",
			}),
		);
		saved.saveTicket(
			ticketFixture(workRoot, "T-done", "done", {
				originConversationId: "202",
				lastAction: "三个探针全绿",
				updated_at: new Date(Date.now() + 1000).toISOString(),
			}),
		);
		// 别人发起的单不该出现在他的在办里
		saved.saveTicket(
			ticketFixture(workRoot, "T-other", "dispatching", { originConversationId: "999" }),
		);
		saved.close();

		const context = buildPartnerTurnContext(partner.id, 202, {
			store,
			workRoot,
			approvals: { pendingOf: () => [{ tool: "bash", args: "npm run build" }] },
		});

		// ① SOUL（身份正文）
		assert.match(context.soul, /你是阿岚/, "SOUL 段来自当前版本快照");
		// ② 岗位契约：四节全文
		assert.match(context.contract ?? "", /【岗位契约】/);
		assert.match(context.contract ?? "", /## 职责范围\n桌面壳与安装包。/);
		assert.match(context.contract ?? "", /## 决策分级/);
		assert.match(context.contract ?? "", /## 验收标准/);
		assert.match(context.contract ?? "", /## 汇报对象/);
		// ③ 当前在办：在办单 / 待审批 / 最近一单
		assert.match(context.status ?? "", /【当前在办】/);
		assert.match(context.status ?? "", /T-doing（进行中）：在改安装脚本/);
		assert.match(context.status ?? "", /bash：npm run build/);
		assert.match(context.status ?? "", /最近一单：T-done（已完成）：三个探针全绿/);
		assert.ok(!(context.status ?? "").includes("T-other"), "别人发起的单不进他的在办");

		// 合并文本：契约在前、在办在后
		const text = context.text ?? "";
		assert.ok(text.indexOf("【岗位契约】") < text.indexOf("【当前在办】"));
		assert.ok(text.includes("【岗位契约】") && text.includes("【当前在办】"));
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("空态省略：空契约 + 无在办 → 契约与在办不注入；纪律段与防线照常", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("空空");
		// 新执事的模板自 2026-11-10 起带「决策分级」默认正文；这里改回纯标题，验证空节省略。
		store.bumpContract(
			partner.id,
			PARTNER_CONTRACT_SECTIONS.map((section) => `## ${section}`).join("\n\n"),
		);
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 303,
		});
		const context = buildPartnerTurnContext(partner.id, 303, {
			store,
			workRoot,
			approvals: { pendingOf: () => [] },
		});
		assert.match(context.soul, /空空/, "SOUL 永远在");
		assert.equal(context.contract, null);
		assert.equal(context.status, null);
		// 2026-11-10 批 12：纪律段固定注入（非总管执事含验证铁律），在办清单空不影响它。
		assert.match(context.discipline, /【验证铁律】/);
		assert.match(context.discipline, /【裁决纪律】/);
		assert.match(context.discipline, /【干活期间】/);
		assert.match(context.discipline, /【提问纪律】/);
		// 2026-11-10 批 27 §5.1：注入防线（injection_guard）已由 lifecycle 的 system 段注入，
		// 执事尾巴这份同 id 同正文的重复合并掉了——合并文本 = 纪律段，不含【材料安全】。
		assert.equal(context.text, context.discipline);
		assert.ok(!(context.text ?? "").includes("【材料安全】"), "执事尾巴不再重复注入防线");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("在办段：明细 ≤3 条 + 超出只报条数；attention 口径文案在段内", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("忙人");
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 404,
		});
		const saved = new Store(workRoot);
		for (let index = 0; index < 5; index += 1) {
			saved.saveTicket(
				ticketFixture(workRoot, `T-${index}`, "dispatching", {
					originConversationId: "404",
					updated_at: new Date(Date.now() + index * 1000).toISOString(),
				}),
			);
		}
		saved.close();

		const section = buildPartnerStatusSection(partner.id, 404, {
			store,
			workRoot,
			approvals: {
				pendingOf: () => [
					{ tool: "bash", args: "npm test" },
					{ tool: "write", args: "a.ts" },
					{ tool: "edit", args: "b.ts" },
					{ tool: "bash", args: "rm -rf x" },
				],
			},
		});
		assert.ok(section);
		assert.equal((section.match(/^- T-/gm) ?? []).length, 3, "在办明细最多 3 条");
		assert.match(section ?? "", /另有 2 单在办/);
		assert.match(section ?? "", /另有 1 条待批/);
		// 只说"有几条"不说全量参数正文（日志 / 提示词纪律）
		assert.equal((section.match(/^- (bash|write|edit)：/gm) ?? []).length, 3);
		assert.match(section ?? "", /先跳过，继续其余部分，这项回头再补/);
		assert.equal(ATTENTION_REPLY_GUIDANCE.includes("答得了就直接答"), true);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("刀二：当前目标 + 履历摘要在同一装配点；顺序 = 契约 → 目标 → 在办；零记录不加", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("阿岚");
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 505,
		});
		store.bumpContract(partner.id, "## 职责范围\n桌面壳与安装包。");
		store.setCurrentGoal(partner.id, "本季度把安装包做稳");

		// 一张在办单，让【当前在办】段存在（履历摘要挂在段末尾）。
		const saved = new Store(workRoot);
		saved.saveTicket(
			ticketFixture(workRoot, "T-505", "dispatching", { originConversationId: "505" }),
		);
		saved.close();

		const deps = {
			store,
			workRoot,
			approvals: { pendingOf: () => [] },
			workSummary: () => ({ done: 8, failed: 1, stopped: 1, total: 10 }),
		};
		const context = buildPartnerTurnContext(partner.id, 505, deps);

		// ① 目标段（不版本化、现取现用）
		assert.equal(context.goal, "【当前目标】本季度把安装包做稳");
		// ② 契约段照旧
		assert.match(context.contract ?? "", /【岗位契约】/);
		// ③ 在办段末尾的履历摘要（过去时）+ 盘点口径（不打分 / 不自动建规则）
		assert.match(context.status ?? "", /【当前在办】/);
		assert.match(context.status ?? "", /近 10 单：完成 8、失败 1、中止 1/);
		assert.match(context.status ?? "", /不打分、不列 KPI 数字/);
		assert.match(context.status ?? "", /不要自己悄悄创建回顾规则/);
		const text = context.text ?? "";
		assert.ok(text.indexOf("【岗位契约】") < text.indexOf("【当前目标】"));
		assert.ok(text.indexOf("【当前目标】") < text.indexOf("【当前在办】"));

		// 零记录：段还在（有在办单），但不加履历摘要行、不带盘点口径。
		const zero = buildPartnerTurnContext(partner.id, 505, { ...deps, workSummary: () => null });
		assert.ok(!(zero.status ?? "").includes("近 10 单"), "零记录不加");
		assert.ok(!(zero.status ?? "").includes("不打分"), "零记录不带盘点口径");
		assert.match(zero.status ?? "", /【当前在办】/, "在办段照常");

		// 清除目标：目标段消失，其余不变。
		store.setCurrentGoal(partner.id, null);
		const noGoal = buildPartnerTurnContext(partner.id, 505, deps);
		assert.equal(noGoal.goal, null);
		assert.ok(!(noGoal.text ?? "").includes("【当前目标】"));
		assert.match(noGoal.text ?? "", /近 10 单：完成 8、失败 1、中止 1/, "履历摘要不受影响");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("契约解析：只认四个固定标题，空节连标题一起省略", () => {
	const source = [
		"# 我的契约（这行不是节标题，忽略）",
		"",
		"## 职责范围",
		"只管前端。",
		"",
		"### 子标题保留",
		"细节。",
		"",
		"## 决策分级",
		"",
		"## 验收标准",
		"探针全绿。",
		"",
		"## 汇报对象",
		"## 无关章节",
		"不该出现。",
	].join("\n");
	const sections = splitContractSections(source);
	assert.deepEqual([...sections.keys()].sort(), [...PARTNER_CONTRACT_SECTIONS].sort());
	assert.equal(sections.get("职责范围"), "只管前端。\n\n### 子标题保留\n细节。");
	assert.equal(sections.get("决策分级"), "");
	const rendered = renderContractSection(source) ?? "";
	assert.match(rendered, /## 职责范围/);
	assert.ok(!rendered.includes("## 决策分级"), "空节省略标题");
	assert.ok(!rendered.includes("不该出现"), "四节之外的内容不注入");
});

// ── 批 15 §二：汇报卡三规则 ───────────────────────────────

test("汇报卡常量：三条纪律逐字在、固定字节不含日期 / 时刻", () => {
	assert.match(BRIEF_CARD_RULES, /没有值得报的就不发/);
	assert.match(BRIEF_CARD_RULES, /今天一切正常/);
	assert.match(BRIEF_CARD_RULES, /就地编辑/);
	assert.match(BRIEF_CARD_RULES, /不要新开一条/);
	assert.match(BRIEF_CARD_RULES, /离开三小时以上回来/);
	assert.match(BRIEF_CARD_RULES, /永不抢屏/);
	assert.equal(/20\d{2}-\d{1,2}-\d{1,2}/.test(BRIEF_CARD_RULES), false);
	assert.equal(/\d{1,2}:\d{2}/.test(BRIEF_CARD_RULES), false);
});

test("汇报卡注入：普通执事有、总管没有（总管纪律段固定字节不变）", () => {
	assert.ok(buildPartnerDisciplineSection("partner-uuid").includes(BRIEF_CARD_RULES));
	assert.ok(!buildPartnerDisciplineSection("chief").includes(BRIEF_CARD_RULES));
});

test("汇报卡开关：BRIEF_CARD_RULES=false 时纪律段回到改动前", () => {
	const previous = process.env.BRIEF_CARD_RULES;
	process.env.BRIEF_CARD_RULES = "false";
	try {
		assert.equal(briefCardRulesEnabled(), false);
		assert.ok(!buildPartnerDisciplineSection("partner-uuid").includes(BRIEF_CARD_RULES));
	} finally {
		if (previous === undefined) delete process.env.BRIEF_CARD_RULES;
		else process.env.BRIEF_CARD_RULES = previous;
	}
});

// ── 员工人格模块（2026-11-14 批1）────────────────────────────

/** 三份静态内容的完整夹具：每个字段都填上，用来断言"全都在"。 */
const FULL_PERSONA: PartnerPersonaContents = {
	style: {
		speakStyle: "短句，先给结论，再给理由。",
		sentenceLength: "短",
		catchphrases: ["稳住", "先查"],
		taboos: ["好的呢", "亲"],
		exampleDialogues: ["主人：好了吗？\n我：跑通了，三个探针全绿。"],
		altStyle: "正式汇报时用书面语。",
		switchProbability: 30,
		emojiHabit: "几乎不用表情，只在收尾用一个句号。",
		openingLine: "我来了，先说结论。",
	},
	values: {
		cares: "把活办完，不留半截。",
		bottomLines: "不编造没查过的事。",
		fears: "假装知道。",
		likes: ["安静的下午", "把问题拆小"],
		dislikes: ["空话", "催"],
		motivator: "别人说这个不可能的时候。",
		valueKeywords: ["准确", "克制"],
	},
	scenario: {
		situation: "手上有三个工人，在等两单回执。",
		knowledgeBoundary: "不知道主人的账户密码，也不该知道。",
		relations: ["总管：上级，向他汇报", "小记：搭档"],
	},
};

test("人格预设：三套默认表逐键定死；work 是建档默认（静态模块关、岗位类开）", () => {
	const ids = Object.keys(PERSONA_PRESETS.work).sort();
	assert.equal(ids.length, 14, "14 个模块 id 一次定全");
	for (const preset of ["work", "companion", "custom"] as const) {
		assert.deepEqual(
			Object.keys(PERSONA_PRESETS[preset]).sort(),
			ids,
			`${preset} 预设必须覆盖全部 14 个 id`,
		);
	}

	// work（默认）：expression / values / scenario 关，岗位类五件开，批2/批3 全关。
	assert.deepEqual(defaultPersonaModules("work"), {
		expression: false,
		values: false,
		scenario: false,
		contract: true,
		discipline: true,
		goal: true,
		workHistory: true,
		currentWork: true,
		impression: false,
		mood: false,
		heart: false,
		learning: false,
		proactivity: false,
		profiles: false,
	});

	// companion：口吻 / 里子 / 处境 + 目标开；岗位类关（红线不在开关里，照旧注入）。
	const companion = defaultPersonaModules("companion");
	for (const id of ["expression", "values", "scenario", "goal"] as const) {
		assert.equal(companion[id], true, `companion 该开：${id}`);
	}
	for (const id of ["contract", "discipline", "workHistory", "currentWork"] as const) {
		assert.equal(companion[id], false, `companion 该关：${id}`);
	}
	// impression / mood / heart 在 schema 里可置 true，但批1 不注入（批2 生效）。
	for (const id of ["impression", "mood", "heart"] as const) {
		assert.equal(companion[id], true, `companion 预设先置上：${id}`);
	}

	// custom：全关起步，只由用户自己开。
	assert.ok(Object.values(defaultPersonaModules("custom")).every((value) => value === false));
});

test("人格开关合并：行上显式值覆盖预设默认，缺省键仍按预设算", () => {
	const partner = { personaPreset: "work" as const, personaModules: { expression: true } };
	const modules = effectivePersonaModules(partner);
	assert.equal(modules.expression, true, "显式开覆盖预设的关");
	assert.equal(modules.contract, true, "没写过的键仍按预设默认");
	// 脏键 / 非布尔被忽略
	const dirty = effectivePersonaModules({
		personaPreset: "work",
		personaModules: { nope: true, goal: "yes" } as never,
	});
	assert.equal(dirty.goal, true, "非布尔被忽略，回落预设");
	assert.equal((dirty as Record<string, unknown>).nope, undefined, "未知键不进来");
});

test("静态人格：固定顺序 口吻 → 里子 → 处境，字段齐全；空字段 / 空模块整段跳过", () => {
	const blocks = renderPersonaBlocks(FULL_PERSONA) ?? "";
	assert.ok(blocks.startsWith("【口吻】"), "口吻在最前");
	assert.ok(blocks.includes("【里子】") && blocks.includes("【处境】"));
	assert.ok(blocks.indexOf("【口吻】") < blocks.indexOf("【里子】"));
	assert.ok(blocks.indexOf("【里子】") < blocks.indexOf("【处境】"));
	for (const line of [
		"说话风格：",
		"句子长度：短",
		"口癖：「稳住」「先查」",
		"忌用语：",
		"示例对话：",
		"备用风格：正式汇报时用书面语。（切换概率 30%）",
		"表情习惯：",
		"开场白：",
		"在乎：",
		"底线：",
		"怕：",
		"喜欢：",
		"厌恶：",
		"来劲的事：",
		"关键词：准确、克制",
		"眼下处境：",
		"知道与不知道：",
		"人物关系：",
	]) {
		assert.ok(blocks.includes(line), `缺一行：${line}`);
	}

	// 空字段跳过：只填一句说话风格 → 没有口癖 / 里子 / 处境
	const onlyStyle = renderPersonaBlocks({
		style: { speakStyle: "只说实话。" },
		values: {},
		scenario: {},
	});
	assert.equal(onlyStyle, "【口吻】\n- 说话风格：只说实话。");
	// 全空 → undefined（不注入空壳标题）
	assert.equal(renderPersonaBlocks({ style: {}, values: {}, scenario: {} }), undefined);
	// 备用风格空时，单独一个切换概率不产生孤儿行
	const altOnly = renderPersonaBlocks({
		style: { switchProbability: 50 },
		values: {},
		scenario: {},
	});
	assert.equal(altOnly, undefined);
});

test("静态人格：关掉的静态模块不读也不渲染；PARTNER_PERSONA_MODULES=false 整段不注入", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	const previous = process.env.PARTNER_PERSONA_MODULES;
	try {
		const partner = store.create("阿岚");
		writePersonaContents(store, partner.id, FULL_PERSONA);
		assert.equal(readPersonaContents(store, partner.id).style.catchphrases?.length, 2);

		// work 预设：expression / values / scenario 全关 → 内容还在盘上，但一句都不注入。
		const work = store.get(partner.id);
		assert.ok(work);
		assert.equal(renderPersonaSection(store, work), undefined);

		// 只开 expression：只出口吻，里子 / 处境仍不注入。
		store.setPersona(partner.id, {
			preset: "work",
			modules: { ...defaultPersonaModules("work"), expression: true },
		});
		const exprOnly = renderPersonaSection(store, store.get(partner.id)!) ?? "";
		assert.match(exprOnly, /【口吻】/);
		assert.ok(!exprOnly.includes("【里子】"));
		assert.ok(!exprOnly.includes("【处境】"));

		// companion：三段全出。
		store.setPersona(partner.id, {
			preset: "companion",
			modules: defaultPersonaModules("companion"),
		});
		const full = renderPersonaSection(store, store.get(partner.id)!) ?? "";
		assert.ok(full.includes("【口吻】") && full.includes("【里子】") && full.includes("【处境】"));

		// 回滚开关：显式 false → 整段不注入（旧行为），内容仍留在盘上。
		process.env.PARTNER_PERSONA_MODULES = "false";
		assert.equal(personaModulesEnabled(), false);
		assert.equal(renderPersonaSection(store, store.get(partner.id)!), undefined);
		assert.equal(readPersonaContents(store, partner.id).values.cares, FULL_PERSONA.values.cares);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_PERSONA_MODULES;
		else process.env.PARTNER_PERSONA_MODULES = previous;
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("岗位类开关：contract / goal / discipline 能关；在办 / 履历固定注入；红线永不裁", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const store = new PartnersStore(db, homes);
	const previous = process.env.PARTNER_PERSONA_MODULES;
	try {
		const partner = store.create("阿岚");
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 606,
		});
		store.bumpContract(partner.id, "## 职责范围\n桌面壳与安装包。");
		store.setCurrentGoal(partner.id, "本季度把安装包做稳");

		const saved = new Store(workRoot);
		saved.saveTicket(
			ticketFixture(workRoot, "T-606", "dispatching", { originConversationId: "606" }),
		);
		saved.close();

		const deps = {
			store,
			workRoot,
			approvals: { pendingOf: () => [{ tool: "bash", args: "npm run build" }] },
			workSummary: () => ({ done: 8, failed: 1, stopped: 1, total: 10 }),
		};

		// 默认（work 预设）：五段都在
		const all = buildPartnerTurnContext(partner.id, 606, deps);
		assert.match(all.contract ?? "", /【岗位契约】/);
		assert.equal(all.goal, "【当前目标】本季度把安装包做稳");
		assert.match(all.status ?? "", /【当前在办】/);
		assert.match(all.status ?? "", /近 10 单：完成 8、失败 1、中止 1/);
		assert.match(all.discipline, /【验证铁律】/);
		assert.match(all.discipline, /【主人数据红线】/);

		// 全关（custom 起步）：契约 / 目标不在，纪律只剩红线；
		// 在办 / 履历固定注入（2026-11-15 人设页打磨：不再是闸，记忆全注入口径）
		store.setPersona(partner.id, {
			preset: "custom",
			modules: defaultPersonaModules("custom"),
		});
		const none = buildPartnerTurnContext(partner.id, 606, deps);
		assert.equal(none.contract, null);
		assert.equal(none.goal, null);
		assert.match(none.status ?? "", /【当前在办】/, "在办固定注入");
		assert.match(none.status ?? "", /近 10 单/, "履历摘要固定注入");
		assert.ok(!(none.text ?? "").includes("【岗位契约】"));
		assert.equal(none.discipline.includes("【主人数据红线】"), true, "红线不可关");
		assert.equal(none.discipline.includes("【验证铁律】"), false, "其余纪律随模块关掉");

		// 行上显式 false 也不再生效（存储兼容：旧 companion 行上的 false 照样注入）
		store.setPersona(partner.id, {
			preset: "companion",
			modules: { ...defaultPersonaModules("companion"), workHistory: false, currentWork: false },
		});
		const forced = buildPartnerTurnContext(partner.id, 606, deps);
		assert.match(forced.status ?? "", /【当前在办】/);
		assert.match(forced.status ?? "", /近 10 单/);

		// 回滚开关：显式 false → 全部按旧行为注入（不读 personaModules）
		process.env.PARTNER_PERSONA_MODULES = "false";
		const legacy = buildPartnerTurnContext(partner.id, 606, deps);
		assert.match(legacy.contract ?? "", /【岗位契约】/);
		assert.match(legacy.status ?? "", /【当前在办】/);
		assert.match(legacy.status ?? "", /近 10 单/);
		assert.match(legacy.discipline, /【验证铁律】/);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_PERSONA_MODULES;
		else process.env.PARTNER_PERSONA_MODULES = previous;
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("纪律覆盖：DISCIPLINE.md 按固定标题替换 / 空节删除；红线固定；清空恢复宿主默认", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("阿岚");
		const defaults = buildPartnerDisciplineDefault(partner.id, store);
		assert.match(defaults, /## 验证铁律/);
		assert.match(defaults, /## 裁决纪律/);
		assert.ok(!defaults.includes("【主人数据红线】"), "默认模板不含红线（红线固定另注）");

		store.writeDisciplineToHome(
			partner.id,
			"## 验证铁律\n- 先跑我指定的验收脚本，再汇报。\n\n## 裁决纪律\n",
		);
		const ctx = buildPartnerTurnContext(partner.id, 0, { store });
		assert.match(ctx.discipline, /【验证铁律】\n- 先跑我指定的验收脚本，再汇报。/);
		assert.equal(ctx.discipline.includes("【裁决纪律】"), false, "空节 = 删除该条");
		assert.match(ctx.discipline, /【主人数据红线】/, "红线始终固定注入");
		assert.equal(ctx.disciplineFields[0]?.id, "partner_verification");
		assert.equal(ctx.disciplineFields[0]?.title, "验证铁律");
		assert.equal(ctx.disciplineFields.length, 8, "七个行为节 + 红线都保留成字段槽位");
		const rulingField = ctx.disciplineFields.find((field) => field.id === "partner_ruling");
		assert.ok(rulingField, "删掉的节仍要留在字段表里，默认页才能把它加回来");
		assert.equal(rulingField?.text, "", "删掉的节正文为空");
		assert.ok(
			ctx.disciplineFields.some(
				(field) => field.id === "partner_owner_data" && field.title === "主人数据红线",
			),
			"红线要作为独立只读字段保留，不能从拆节里消失",
		);
		assert.equal(
			validateDisciplineSource("## 主人数据红线\n- 我想改"),
			"「主人数据红线」由宿主固定注入，不能覆盖；其余纪律可以改",
		);
		assert.match(
			validateDisciplineSource("## 没这个标题\n- x") ?? "",
			/不认识的纪律标题/,
		);

		store.writeDisciplineToHome(partner.id, "");
		assert.match(buildPartnerTurnContext(partner.id, 0, { store }).discipline, /【裁决纪律】/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("字段上限：三份 zod schema 在写时拦超限（字 / 条数 / 概率）", () => {
	const long = (count: number) => "字".repeat(count);
	// 口吻
	assert.equal(PartnerPersonaStyleSchema.safeParse({ speakStyle: long(300) }).success, true);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ speakStyle: long(301) }).success, false);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ sentenceLength: "中" }).success, true);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ sentenceLength: "很长" }).success, false);
	assert.equal(
		PartnerPersonaStyleSchema.safeParse({ catchphrases: Array.from({ length: 8 }, () => "好") })
			.success,
		true,
	);
	assert.equal(
		PartnerPersonaStyleSchema.safeParse({ catchphrases: Array.from({ length: 9 }, () => "好") })
			.success,
		false,
	);
	assert.equal(
		PartnerPersonaStyleSchema.safeParse({ catchphrases: [long(25)] }).success,
		false,
		"单条口癖 ≤24 字",
	);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ taboos: Array.from({ length: 7 }, () => "x") }).success, false);
	assert.equal(
		PartnerPersonaStyleSchema.safeParse({ exampleDialogues: Array.from({ length: 4 }, () => "x") })
			.success,
		false,
	);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ switchProbability: 0 }).success, true);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ switchProbability: 100 }).success, true);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ switchProbability: 101 }).success, false);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ switchProbability: 10.5 }).success, false);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ emojiHabit: long(81) }).success, false);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ openingLine: long(121) }).success, false);
	assert.equal(PartnerPersonaStyleSchema.safeParse({ speakStyle: "嗯", extra: "多出来的键" }).success, false);
	// 里子
	assert.equal(PartnerPersonaValuesSchema.safeParse({ cares: long(201) }).success, false);
	assert.equal(PartnerPersonaValuesSchema.safeParse({ dislikes: Array.from({ length: 11 }, () => "x") }).success, false);
	assert.equal(PartnerPersonaValuesSchema.safeParse({ valueKeywords: ["一二三四五六七八"] }).success, true);
	assert.equal(PartnerPersonaValuesSchema.safeParse({ valueKeywords: ["一二三四五六七八九"] }).success, false);
	assert.equal(PartnerPersonaValuesSchema.safeParse({ valueKeywords: ["a", "b", "c", "d"] }).success, false);
	// 处境
	assert.equal(PartnerPersonaScenarioSchema.safeParse({ situation: long(301) }).success, false);
	assert.equal(PartnerPersonaScenarioSchema.safeParse({ relations: Array.from({ length: 11 }, () => "x") }).success, false);
	assert.equal(PartnerPersonaScenarioSchema.safeParse({ relations: [long(61)] }).success, false);
});

test("活模块注入（批2）：印象 → 心情 → 心里话挂在在办之后；模块关 / 总开关关都不注", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const store = new PartnersStore(db, homes);
	const previous = process.env.PARTNER_PERSONA_MODULES;
	try {
		const partner = store.create("小满");
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 707,
		});
		const living = {
			impression: "【印象】\n- 和主人的关系：熟络",
			mood: "【此刻状态】\n- 愉悦（刚被谢过）",
			heart: "【心里话】\n- 想做的事：早点收工",
		};
		const deps = { store, workRoot, living };

		// 全开：三段都在，顺序固定在在办段之后
		store.setPersona(partner.id, {
			preset: "custom",
			modules: {
				...defaultPersonaModules("custom"),
				impression: true,
				mood: true,
				heart: true,
			},
		});
		const all = buildPartnerTurnContext(partner.id, 707, deps);
		assert.match(all.impression ?? "", /【印象】/);
		assert.match(all.mood ?? "", /愉悦/);
		assert.match(all.heart ?? "", /【心里话】/);
		const text = all.text ?? "";
		assert.ok(text.indexOf("【印象】") < text.indexOf("【此刻状态】"));
		assert.ok(text.indexOf("【此刻状态】") < text.indexOf("【心里话】"));

		// 关掉 heart：只有印象与心情
		store.setPersona(partner.id, {
			preset: "custom",
			modules: { ...defaultPersonaModules("custom"), impression: true, mood: true },
		});
		const noHeart = buildPartnerTurnContext(partner.id, 707, deps);
		assert.equal(noHeart.heart, null);
		assert.ok(!(noHeart.text ?? "").includes("【心里话】"));

		// 全关：三段都不在
		store.setPersona(partner.id, {
			preset: "custom",
			modules: defaultPersonaModules("custom"),
		});
		const none = buildPartnerTurnContext(partner.id, 707, deps);
		assert.equal(none.impression, null);
		assert.equal(none.mood, null);
		assert.equal(none.heart, null);
		assert.ok(!(none.text ?? "").includes("【印象】"));

		// 总开关 false：即使 deps 给了活内容也不注（活模块在旧行为里不存在）
		process.env.PARTNER_PERSONA_MODULES = "false";
		store.setPersona(partner.id, {
			preset: "companion",
			modules: defaultPersonaModules("companion"),
		});
		const legacy = buildPartnerTurnContext(partner.id, 707, deps);
		assert.equal(legacy.impression, null);
		assert.equal(legacy.mood, null);
		assert.equal(legacy.heart, null);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_PERSONA_MODULES;
		else process.env.PARTNER_PERSONA_MODULES = previous;
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
