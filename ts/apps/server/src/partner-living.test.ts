import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SqliteMemoryStore, scopeKey } from "@lifediary/memory";

/**
 * 员工人格 · 活模块（2026-11-15 批2）的单测。
 *
 * 全程临时目录：不碰真实 `.data/`。印象走真 SQLite（`MEMORY_DB_PATH` 指向临时库），
 * 日记 / 成长笔记 / 愿望走临时家目录。环境变量必须在动态 import **之前**落好：
 * `partner-living.ts` 的库句柄是模块级懒开的，第一次调用就认路径。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-partner-living-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "homes");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
delete process.env.PARTNER_PERSONA_MODULES;
delete process.env.MEMORY_ENABLED;

const { PartnersStore } = await import("./partners.ts");
const { defaultPersonaModules } = await import("./partner-persona.ts");
const {
	MOOD_FAIL_STREAK,
	TIER_THANKS_NEEDED,
	addImpression,
	appendDiary,
	appendGrowth,
	applyLivingPatch,
	applyRoutineDigest,
	buildLivingSections,
	closeLivingStore,
	isReviewRoutine,
	livingModuleOn,
	livingView,
	listImpressions,
	moodAfterTurn,
	moodAfterWork,
	noteGroupTurn,
	noteTurnSettlement,
	noteWorkSettlement,
	parsePersonaDigest,
	readDiary,
	readGrowthTail,
	readWishes,
	renderHeartSection,
	renderImpressionSection,
	renderMoodSection,
	tierAfterThanks,
	turnSignals,
	writeWishes,
} = await import("./partner-living.ts");

const store = new PartnersStore(
	process.env.PARTNERS_DB_PATH,
	process.env.PARTNER_HOMES_ROOT,
);

after(() => {
	closeLivingStore();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

function makePartner(name: string, preset: "work" | "companion" = "companion") {
	const partner = store.create(name);
	return store.setPersona(partner.id, { preset, modules: defaultPersonaModules(preset) })!;
}

const AT = "2026-11-15T10:00:00.000Z";

// ── 印象 ────────────────────────────────────────────────

test("印象：只看最后一条用户消息；致谢 / 纠正各提炼一条，普通寒暄一条都不写", () => {
	const partner = makePartner("印象执事");
	// 历史轮里的"谢谢"不算：它已经记过一次，重复数会把一次致谢数成十次
	assert.equal(
		turnSignals([
			{ role: "user", content: "谢谢你" },
			{ role: "assistant", content: "不客气" },
			{ role: "user", content: "继续吧" },
		]).thanked,
		false,
	);
	assert.equal(turnSignals([{ role: "user", content: "谢谢，辛苦了" }]).thanked, true);
	assert.equal(turnSignals([{ role: "user", content: "不对，重来" }]).corrected, true);

	noteTurnSettlement({
		partnerId: partner.id,
		messages: [{ role: "user", content: "今天天气不错" }],
		at: AT,
		store,
	});
	assert.equal(listImpressions(partner.id).length, 0, "没有可提炼的事就不写");

	noteTurnSettlement({
		partnerId: partner.id,
		messages: [{ role: "user", content: "谢谢，干得漂亮" }],
		at: AT,
		store,
	});
	const afterThanks = listImpressions(partner.id);
	assert.equal(afterThanks.length, 1);
	assert.equal(afterThanks[0]?.event, "thanks");
	assert.equal(afterThanks[0]?.subject, "owner");
	assert.equal(afterThanks[0]?.source, "generated");

	noteTurnSettlement({
		partnerId: partner.id,
		messages: [{ role: "user", content: "不对，这个不是这样" }],
		at: AT,
		store,
	});
	const afterCorrection = listImpressions(partner.id);
	assert.equal(afterCorrection.length, 2);
	assert.equal(afterCorrection[1]?.event, "correction");
	assert.match(afterCorrection[1]?.text ?? "", /被主人纠正过：/);
});

test("印象：单对象 20 条封顶，跨档记录不淘汰", () => {
	const partner = makePartner("印象上限执事");
	for (let i = 0; i < 25; i += 1) {
		addImpression(partner.id, { subject: "owner", text: `第 ${i} 条` });
	}
	addImpression(partner.id, {
		subject: "owner",
		text: "温度到「认识」的事件",
		tierChange: "认识",
	});
	const entries = listImpressions(partner.id);
	const plain = entries.filter((entry) => entry.subject === "owner" && !entry.tierChange);
	assert.ok(entries.length <= 20, "单对象总条数封顶 20（跨档账占名额但不淘汰）");
	assert.equal(entries.filter((entry) => entry.tierChange).length, 1, "跨档账不淘汰");
	assert.equal(plain.some((entry) => entry.text === "第 0 条"), false, "最旧的被淘汰");
});

test("温度：同档内不越档；跨档必须有可解释事件（带 tierChange 的账）", () => {
	assert.deepEqual(tierAfterThanks("生疏", 2), { tier: "生疏", changed: false, needed: 3 });
	assert.deepEqual(tierAfterThanks("生疏", 3), { tier: "认识", changed: true, needed: 3 });
	assert.deepEqual(tierAfterThanks("像家人", 99), { tier: "像家人", changed: false, needed: null });

	const partner = makePartner("温度执事");
	assert.equal(partner.ownerTier, "生疏");
	for (let i = 0; i < TIER_THANKS_NEEDED.生疏! - 1; i += 1) {
		noteTurnSettlement({
			partnerId: partner.id,
			messages: [{ role: "user", content: "谢谢" }],
			at: AT,
			store,
		});
	}
	assert.equal(store.get(partner.id)?.ownerTier, "生疏", "差一次不升档（档内微调）");

	noteTurnSettlement({
		partnerId: partner.id,
		messages: [{ role: "user", content: "谢谢" }],
		at: AT,
		store,
	});
	assert.equal(store.get(partner.id)?.ownerTier, "认识", "达到阈值升一档");
	const event = listImpressions(partner.id).find((entry) => entry.tierChange);
	assert.equal(event?.tierChange, "认识");
	assert.match(event?.text ?? "", /累计被谢 3 次/, "跨档能指到一件可解释的事");
});

// ── 心情 ────────────────────────────────────────────────

test("心情规则三例：被谢 → 愉悦、连败 → 低落、久无单 → 平静；手改覆盖并标 manual", () => {
	assert.deepEqual(moodAfterTurn({ thanked: true, idle: false }), {
		mood: "愉悦",
		reason: "刚被主人谢过",
	});
	assert.deepEqual(moodAfterTurn({ thanked: false, idle: true }), {
		mood: "平静",
		reason: "这阵子没什么活儿在办",
	});
	assert.equal(
		moodAfterWork("failed", ["done", "failed"], "平静"),
		null,
		"上一单成了就不算连败",
	);
	assert.deepEqual(moodAfterWork("aborted", ["failed", "aborted"], "平静"), {
		mood: "低落",
		reason: "连续两单没成",
	});

	const partner = makePartner("心情执事");
	noteTurnSettlement({
		partnerId: partner.id,
		messages: [{ role: "user", content: "谢谢" }],
		at: AT,
		store,
	});
	let row = store.get(partner.id);
	assert.equal(row?.mood, "愉悦");
	assert.equal(row?.moodSource, "rule");

	// 手改随时覆盖
	applyLivingPatch(partner.id, { mood: "烦躁", moodReason: "有点吵" }, store);
	row = store.get(partner.id);
	assert.equal(row?.mood, "烦躁");
	assert.equal(row?.moodReason, "有点吵");
	assert.equal(row?.moodSource, "manual", "手改写 manual 标记");

	// 下一次规则事件仍可再改（不是把手改锁死）
	noteTurnSettlement({
		partnerId: partner.id,
		messages: [{ role: "user", content: "谢谢" }],
		at: "2026-11-15T11:00:00.000Z",
		store,
	});
	assert.equal(store.get(partner.id)?.mood, "愉悦");
});

test("心情：派单结算连败两单 → 低落（从 work 履历的结构化查询数）", () => {
	const partner = makePartner("派单心情执事");
	const db = new SqliteMemoryStore(process.env.MEMORY_DB_PATH!);
	const base = { kind: "work" as const, scope: scopeKey({ type: "partner", id: partner.id }), importance: 0.5, veracity: "tool" as const, source: "work", validUntil: null, supersededBy: null, recallCount: 0, lastRecalledAt: null };
	db.put({ ...base, id: "work:T-1", content: "T-1｜第一单｜终态=failed｜没成", createdAt: "2026-11-15T09:00:00.000Z" });
	noteWorkSettlement(partner.id, "failed", store);
	assert.equal(store.get(partner.id)?.mood, "平静", "一单失败还不算连败");

	db.put({ ...base, id: "work:T-2", content: "T-2｜第二单｜终态=aborted｜中止", createdAt: "2026-11-15T09:30:00.000Z" });
	noteWorkSettlement(partner.id, "aborted", store);
	assert.equal(store.get(partner.id)?.mood, "低落");
	assert.equal(store.get(partner.id)?.moodReason, `连续两单没成`);
	assert.equal(MOOD_FAIL_STREAK, 2);
	db.close();
});

// ── 开关 ────────────────────────────────────────────────

test("模块关：不更新、不注入；内容保留（重开即回）", () => {
	const partner = makePartner("关闭执事", "work");
	assert.equal(livingModuleOn(partner, "impression"), false, "work 预设印象关");
	noteTurnSettlement({
		partnerId: partner.id,
		messages: [{ role: "user", content: "谢谢" }],
		at: AT,
		store,
	});
	assert.equal(listImpressions(partner.id).length, 0, "关着不更新");
	assert.equal(buildLivingSections(store.get(partner.id)!, store), undefined);

	// 手动写入内容 → 重新打开后回得来
	addImpression(partner.id, { subject: "owner", text: "手写的一条" });
	const reopened = store.setPersona(partner.id, {
		preset: "companion",
		modules: defaultPersonaModules("companion"),
	})!;
	const sections = buildLivingSections(reopened, store);
	assert.match(sections?.impression ?? "", /手写的一条/, "重开即回（内容保留）");
});

test("PARTNER_PERSONA_MODULES=false：全部回批1 前行为（不更新、不渲染）", () => {
	const partner = makePartner("回滚执事");
	const previous = process.env.PARTNER_PERSONA_MODULES;
	process.env.PARTNER_PERSONA_MODULES = "false";
	try {
		assert.equal(livingModuleOn(store.get(partner.id)!, "impression"), false);
		noteTurnSettlement({
			partnerId: partner.id,
			messages: [{ role: "user", content: "谢谢" }],
			at: AT,
			store,
		});
		assert.equal(listImpressions(partner.id).length, 0);
		assert.equal(buildLivingSections(store.get(partner.id)!, store), undefined);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_PERSONA_MODULES;
		else process.env.PARTNER_PERSONA_MODULES = previous;
	}
});

test("注入：印象 / 心情 / 心里话三段按模块出现，空内容整段不出现", () => {
	const partner = makePartner("注入执事");
	assert.equal(renderImpressionSection(partner, store), undefined, "没有印象不注");
	assert.equal(renderMoodSection(partner), undefined, "初始心情态不注");
	assert.equal(renderHeartSection(store, partner), undefined, "没有愿望与成长笔记不注");

	addImpression(partner.id, { subject: "owner", text: "被主人谢过（11月15日）", event: "thanks" });
	store.setLivingState(partner.id, { mood: "愉悦", moodReason: "刚被主人谢过", moodSource: "rule" });
	writeWishes(store, partner.id, ["把这件事做完"]);
	appendGrowth(store, partner.id, "先给结论再解释，主人更省时间。", AT);

	const fresh = store.get(partner.id)!;
	const impression = renderImpressionSection(fresh, store) ?? "";
	assert.match(impression, /和主人的关系：生疏/);
	assert.match(impression, /对主人：被主人谢过/);

	// 子开关关着：心情块仍在，口吻提示不出现
	const mood = renderMoodSection(fresh) ?? "";
	assert.match(mood, /【此刻状态】/);
	assert.match(mood, /愉悦/);
	assert.doesNotMatch(mood, /口吻/);
	// 子开关开着：多一行口吻提示
	assert.match(renderMoodSection(fresh, true) ?? "", /口吻/);

	const heart = renderHeartSection(store, fresh) ?? "";
	assert.match(heart, /想做的事：把这件事做完/);
	assert.match(heart, /最近想明白的：.*先给结论/);
});

// ── 内心生活 ────────────────────────────────────────────

test("日记 / 成长笔记 / 愿望：写在家目录，SOUL 一个字节都不动", () => {
	const partner = makePartner("日记执事");
	const soulBefore = store.readSoulFromHome(partner.id);

	appendDiary(store, partner.id, { text: "今天把那批单据对完了。", source: "generated", at: AT });
	const diary = readDiary(store, partner.id);
	assert.equal(diary.length, 1);
	assert.equal(diary[0]?.source, "generated");
	assert.equal(readFileSync(join(store.homeOf(partner.id), "persona", "diary.jsonl"), "utf8").includes("对完了"), true);

	appendGrowth(store, partner.id, "对账先跑一遍小数校验。", AT);
	assert.match(readGrowthTail(store, partner.id) ?? "", /小数校验/);
	// 同一条不重复追加
	assert.equal(appendGrowth(store, partner.id, "对账先跑一遍小数校验。", AT), false);

	writeWishes(store, partner.id, ["学会拒绝", "把周报写短"]);
	assert.deepEqual(readWishes(store, partner.id), ["学会拒绝", "把周报写短"]);

	assert.equal(store.readSoulFromHome(partner.id), soulBefore, "成长笔记永不回写 SOUL 本体");
});

test("周报：末尾那一句留在正文里，日记 / 成长笔记摘出去单独存档", () => {
	const partner = makePartner("盘点执事");
	const raw = [
		"这周一共办了 3 单，两单成了，一单还在等回复。",
		"[[日记]] 这周把对账的活做顺了，下次先跑小数校验。",
		"[[成长]] 对账先跑一遍小数校验，再动数据。",
		"[[周报]] 这周忙但踏实，和你配合越来越顺。",
	].join("\n");

	const digest = parsePersonaDigest(raw);
	assert.equal(digest.diary, "这周把对账的活做顺了，下次先跑小数校验。");
	assert.equal(digest.growth, "对账先跑一遍小数校验，再动数据。");
	assert.equal(digest.weekly, "这周忙但踏实，和你配合越来越顺。");
	assert.match(digest.text, /这周忙但踏实/, "周报一句留在可见正文（末尾）");
	assert.doesNotMatch(digest.text, /\[\[日记\]\]/);
	assert.doesNotMatch(digest.text, /对账先跑一遍小数校验/, "日记 / 成长正文不进摘要");

	const applied = applyRoutineDigest({ partnerId: partner.id, text: raw, at: AT, store });
	assert.ok(applied);
	assert.match(applied!.text, /这周忙但踏实/);
	assert.equal(readDiary(store, partner.id).length, 1);
	assert.match(readGrowthTail(store, partner.id) ?? "", /小数校验/);
	assert.equal(readDiary(store, partner.id)[0]?.source, "generated");

	// 非盘点例行不挂生成（识别词全在名字 / 指令里）
	assert.equal(isReviewRoutine({ name: "每周五盘点", prompt: "看看这周" }), true);
	assert.equal(isReviewRoutine({ name: "喝水提醒", prompt: "到点提醒主人喝水" }), false);
});

test("群成员印象：只记「被同事点名」这一种事件，对象是成员 id", () => {
	const partner = makePartner("群里执事");
	const colleague = makePartner("阿青", "work");
	noteGroupTurn({
		partnerId: partner.id,
		partnerName: "小满",
		messages: [
			{ authorKind: "partner", authorId: colleague.id, authorName: "阿青", content: "小满，你来看下这单" },
			{ authorKind: "partner", authorId: colleague.id, authorName: "阿青", content: "今天天气不错" },
			{ authorKind: "user", authorId: null, authorName: "主人", content: "小满在吗" },
		],
		at: AT,
		store,
	});
	const entries = listImpressions(partner.id);
	assert.equal(entries.length, 1, "同一天同名事件只记一次；主人消息不算同事印象");
	assert.equal(entries[0]?.subject, colleague.id);
	assert.match(entries[0]?.text ?? "", /在群里被「阿青」叫到过/);

	// 重复一轮不重复记
	noteGroupTurn({
		partnerId: partner.id,
		partnerName: "小满",
		messages: [{ authorKind: "partner", authorId: colleague.id, authorName: "阿青", content: "小满你看" }],
		at: AT,
		store,
	});
	assert.equal(listImpressions(partner.id).length, 1);
});

test("端点投影：living 含温度 / 心情 / 日记预览 / 愿望；手改印象写 manual", () => {
	const partner = makePartner("投影执事");
	applyLivingPatch(
		partner.id,
		{
			ownerTier: "熟络",
			mood: "疲惫",
			moodReason: "跑了一天",
			nearby: "在补上周的账",
			wishes: ["早点收工"],
			impression: { add: { subject: "owner", text: "主人喜欢先看结论" } },
			diary: { add: "今天有点累，但把账补完了。" },
		},
		store,
	);

	const view = livingView(store.get(partner.id)!, store);
	assert.equal(view.ownerTier, "熟络");
	assert.match(view.tierNote ?? "", /温度由人从「生疏」改成「熟络」/);
	assert.equal(view.mood.mood, "疲惫");
	assert.equal(view.mood.reason, "跑了一天");
	assert.equal(view.mood.source, "manual");
	assert.equal(view.diary.count, 1);
	assert.match(view.diary.latestText ?? "", /补完了/);
	assert.deepEqual(view.wishes, ["早点收工"]);
	const manual = view.impressions.find((entry) => entry.text === "主人喜欢先看结论");
	assert.equal(manual?.source, "manual");
	assert.equal(manual?.subjectName, "主人");
	assert.equal(view.impressions.find((entry) => entry.tierChange)?.source, "manual");
});
