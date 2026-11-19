import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 员工人格 · 学习模块（2026-11-15 批3）单测。
 *
 * 全程临时目录：不碰真实 `.data/`。红线断言：
 *   - 落盘只有「规则 + ≤40 字短例句」，不出现整段对话原文；
 *   - 模块关 / `MEMORY_ENABLED=false` / 总开关 false 时全链不跑；
 *   - 模型提炼用注入替身，不真调上游。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-partner-learning-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "homes");
delete process.env.PARTNER_PERSONA_MODULES;
delete process.env.MEMORY_ENABLED;
delete process.env.PARTNER_LEARNING_FREQUENCY;

const { PartnersStore } = await import("./partners.ts");
const { defaultPersonaModules } = await import("./partner-persona.ts");
const { buildPartnerTurnContext } = await import("./agent/partner-context.ts");
const {
	LEARNING_REFRESH_EVERY,
	buildLearningSection,
	deriveVoiceRules,
	learningFrequency,
	learningModuleOn,
	mergeVoiceTurn,
	noteOwnerStyle,
	readVoice,
	reflectVoiceWeekly,
	refineVoice,
	turnStyleSignals,
	voiceView,
} = await import("./partner-learning.ts");

const store = new PartnersStore(process.env.PARTNERS_DB_PATH, process.env.PARTNER_HOMES_ROOT);

after(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

function makePartner(name: string, learning = true) {
	const partner = store.create(name);
	const modules = { ...defaultPersonaModules("custom") };
	modules.learning = learning;
	return store.setPersona(partner.id, { preset: "custom", modules })!;
}

const AT = "2026-11-15T10:00:00.000Z";

test("学习默认关：work 预设 learning=false，不落 voice.json、不注入", async () => {
	const partner = store.create("默认关执事");
	const called = await noteOwnerStyle({
		partnerId: partner.id,
		messages: [{ role: "user", content: "今天先把方案收个尾" }],
		at: AT,
		store,
	});
	assert.equal(called, false);
	assert.equal(existsSync(join(store.homeOf(partner.id), "persona", "voice.json")), false);
	const context = buildPartnerTurnContext(partner.id, 0, {
		store,
		workRoot: join(root, "runs"),
	});
	assert.equal(context.learning, null);
});

test("总开关 false / MEMORY_ENABLED=false：learningModuleOn 全 false，不更新", async () => {
	const partner = makePartner("回滚执事");
	const previous = process.env.PARTNER_PERSONA_MODULES;
	process.env.PARTNER_PERSONA_MODULES = "false";
	try {
		assert.equal(learningModuleOn(store.get(partner.id)!), false);
		assert.equal(
			await noteOwnerStyle({
				partnerId: partner.id,
				messages: [{ role: "user", content: "今天先把方案收个尾" }],
				store,
			}),
			false,
		);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_PERSONA_MODULES;
		else process.env.PARTNER_PERSONA_MODULES = previous;
	}

	process.env.MEMORY_ENABLED = "false";
	try {
		assert.equal(learningModuleOn(store.get(partner.id)!), false);
	} finally {
		delete process.env.MEMORY_ENABLED;
	}
	assert.equal(learningModuleOn(store.get(partner.id)!), true);
});

test("确定性统计：句长 / 称呼 / 语气词；落盘只有 ≤40 字短例句，不存整段原文", async () => {
	const partner = makePartner("风格执事");
	const long = "亲爱的你听我说，今天这件事情其实可以拆成三步来做，第一步先把材料备齐，第二步再对齐口径，第三步收尾。";
	assert.match(long, /亲爱的/);
	const signals = turnStyleSignals(long);
	assert.equal(signals.address.includes("亲爱的"), true);
	assert.equal(signals.long, true);
	assert.equal(turnStyleSignals("好的呢").short, true);
	assert.equal(turnStyleSignals("哈哈今天真不错呢").interjections.includes("哈哈"), true);

	await noteOwnerStyle({
		partnerId: partner.id,
		messages: [{ role: "user", content: long }],
		at: AT,
		store,
	});
	const voice = readVoice(store, partner.id);
	assert.equal(voice.stats.turns, 1);
	assert.ok(voice.rules.length >= 2);
	assert.equal(voice.samples.length, 1);
	assert.ok([...(voice.samples[0]?.text ?? "")].length <= 40);
	const file = readFileSync(join(store.homeOf(partner.id), "persona", "voice.json"), "utf8");
	assert.equal(file.includes(long), false, "不存整段对话原文");
	assert.match(file, /亲爱的/);
});

test("模块关 = 不注入；模块开且规则非空 = 注入【表达习惯】", async () => {
	const partner = makePartner("注入执事", false);
	assert.equal(buildLearningSection(partner, store), undefined);

	const on = store.setPersona(partner.id, {
		preset: "custom",
		modules: { ...defaultPersonaModules("custom"), learning: true },
	})!;
	await noteOwnerStyle({
		partnerId: on.id,
		messages: [{ role: "user", content: "好的呢" }],
		at: AT,
		store,
	});
	const section = buildLearningSection(on, store);
	assert.match(section ?? "", /【表达习惯】/);
	const context = buildPartnerTurnContext(on.id, 0, {
		store,
		workRoot: join(root, "runs"),
	});
	assert.match(context.learning ?? "", /【表达习惯】/);

	// 关回去：不注入了，但内容保留
	const off = store.setPersona(on.id, {
		preset: "custom",
		modules: { ...defaultPersonaModules("custom"), learning: false },
	})!;
	assert.equal(buildLearningSection(off, store), undefined);
	assert.equal(readVoice(store, on.id).rules.length > 0, true, "内容保留");
});

test("模型提炼：只喂统计 + 短例句；输出黑话解释落 rules；失败保留确定性规则", async () => {
	const partner = makePartner("提炼执事");
	const long = "yyds 这个说法是永远的神的意思，今天真的绝了，我们下次还用这个说法吧，记住了啊";
	await noteOwnerStyle({
		partnerId: partner.id,
		messages: [{ role: "user", content: long }],
		at: AT,
		store,
	});
	let prompt = "";
	const ok = await refineVoice(
		partner.id,
		{
			complete: async (input) => {
				prompt = input;
				return JSON.stringify({
					rules: [
						{ kind: "sentenceLength", text: "主人说话短，常带笑", example: "哈哈真不错" },
						{ kind: "jargon", text: "「yyds」= 永远的神", example: "yyds" },
					],
				});
			},
		},
		store,
	);
	assert.equal(ok, true);
	assert.match(prompt, /短例句/);
	assert.equal(prompt.includes(long), false, "提示词只有 ≤40 字样本，没有整段原文");
	const voice = readVoice(store, partner.id);
	assert.equal(voice.rules.some((rule) => rule.kind === "jargon" && rule.text.includes("永远的神")), true);
	assert.equal(voice.rules.some((rule) => rule.text.includes("常带笑")), true);

	const before = readVoice(store, partner.id).rules;
	const failed = await refineVoice(
		partner.id,
		{ complete: async () => null },
		store,
	);
	assert.equal(failed, false);
	assert.deepEqual(readVoice(store, partner.id).rules, before, "失败不覆盖已有规则");

	// settle 档：周盘点不再额外提炼（抽查只在结算钩子）
	process.env.PARTNER_LEARNING_FREQUENCY = "settle";
	try {
		assert.equal(
			await reflectVoiceWeekly(
				partner.id,
				{ complete: async () => JSON.stringify({ rules: [] }) },
				store,
			),
			false,
		);
	} finally {
		delete process.env.PARTNER_LEARNING_FREQUENCY;
	}
});

test("纯函数：deriveVoiceRules 不丢历史黑话；voiceView 计数；settle 档常量", () => {
	const rules = deriveVoiceRules(
		{
			turns: 2,
			totalChars: 20,
			shortTurns: 2,
			longTurns: 0,
			address: { 你: 2 },
			interjections: { 哈哈: 2 },
		},
		[{ text: "好的呢", at: AT }],
		[{ kind: "jargon", text: "「yyds」= 永远的神", at: AT }],
		AT,
	);
	assert.equal(rules.some((rule) => rule.kind === "jargon"), true);
	const voice = mergeVoiceTurn(
		{ version: 1, updatedAt: AT, samples: [], stats: { turns: 0, totalChars: 0, shortTurns: 0, longTurns: 0, address: {}, interjections: {} }, rules: [] },
		"好的呢",
		AT,
	);
	assert.equal(voice.samples.length, 1);
	assert.equal(LEARNING_REFRESH_EVERY, 5);
	assert.equal(learningFrequency({}), "weekly");
	assert.equal(learningFrequency({ PARTNER_LEARNING_FREQUENCY: "settle" }), "settle");
	assert.equal(learningFrequency({ PARTNER_LEARNING_FREQUENCY: "off" }), "off", "2026-11-18 关档：不做模型反思");
	assert.equal(learningFrequency({ PARTNER_LEARNING_FREQUENCY: "nonsense" }), "weekly", "拼错按每周");
	const view = voiceView(makePartner("计数执事"), store);
	assert.equal(view.ruleCount, 0);
	assert.equal(view.updatedAt, null);
});
