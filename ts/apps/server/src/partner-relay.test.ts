import assert from "node:assert/strict";
import { test } from "node:test";
import {
	RELAY_HOP_TAG,
	RELAY_MAX_PER_RUN,
	RELAY_RECEIPT_QUEUED,
	RELAY_RECEIPT_SETTLED,
	beginRelayRun,
	claimRelayTarget,
	clearRelayTarget,
	currentRelayRunKey,
	isRelayRun,
	markRelayRun,
	markRelayTarget,
	partnerRelayEnabled,
	partnerRelayReceiptEnabled,
	relayBody,
	relayDeliveredText,
	relayNoticeText,
	relayOutcomeEntry,
	relayRunKey,
	relaySettledText,
	resetRelayState,
	resolveRelayTarget,
	takeRelaySlot,
} from "./partner-relay.ts";
import type { PartnerRow } from "./partners.ts";

/**
 * 执事间递话单测（2026-11-08 扫尾批 8d，方案 §三）。
 *
 * 只测**纯逻辑与进程内状态**：目标解析（名/域/长标签/歧义/排除项）、正文包装与 hop 标记、
 * 每 run 上限计数、递话触发的轮次标记。送达（submit 进目标会话）在探针里验，
 * 那需要真 harness。
 */

function partner(over: Partial<PartnerRow> & { id: string; name: string }): PartnerRow {
	return {
		status: "active",
		currentVersion: 1,
		createdAt: "2026-11-08T00:00:00.000Z",
		updatedAt: "2026-11-08T00:00:00.000Z",
		domain: null,
		avatar: null,
		dispatchAuthority: false,
		toolProjection: null,
		currentGoal: null,
		tagline: null,
		diary: false,
		personaPreset: "work",
		personaModules: {},
		personaSwitches: {},
		ownerTier: "生疏",
		nearby: null,
		mood: "平静",
		moodReason: null,
		moodUpdatedAt: null,
		moodSource: null,
		...over,
	};
}

const SELF = "p-self";
const PARTNERS: PartnerRow[] = [
	partner({ id: "chief", name: "总管" }),
	partner({ id: SELF, name: "信使甲", domain: "inbox" }),
	partner({ id: "p-b", name: "信使乙", domain: "calendar" }),
	partner({ id: "p-dup-1", name: "同名", domain: "alpha" }),
	partner({ id: "p-dup-2", name: "同名", domain: "beta" }),
	partner({ id: "p-paused", name: "休假中", status: "paused" }),
];

// ── 目标解析 ─────────────────────────────────────────────

test("解析：名字唯一 → 命中", () => {
	const out = resolveRelayTarget("信使乙", PARTNERS, SELF);
	assert.equal(out.ok, true);
	assert.equal(out.ok && out.target.id, "p-b");
});

test("解析：domain → 命中（大小写不敏感，domain 是 ASCII 标签）", () => {
	const out = resolveRelayTarget("Calendar", PARTNERS, SELF);
	assert.equal(out.ok, true);
	assert.equal(out.ok && out.target.name, "信使乙");
});

test("解析：长标签「名字·domain」→ 命中唯一那位", () => {
	const out = resolveRelayTarget("同名·beta", PARTNERS, SELF);
	assert.equal(out.ok, true);
	assert.equal(out.ok && out.target.id, "p-dup-2");
});

test("解析：长标签写错域 → 不猜、不回退短名", () => {
	const out = resolveRelayTarget("同名·gamma", PARTNERS, SELF);
	assert.equal(out.ok, false);
	assert.equal(out.ok === false && out.reason, "missing");
});

test("解析：重名 → 歧义并给候选（供模型改用长标签）", () => {
	const out = resolveRelayTarget("同名", PARTNERS, SELF);
	assert.equal(out.ok, false);
	if (out.ok) return;
	assert.equal(out.reason, "ambiguous");
	assert.deepEqual(
		out.candidates?.map((candidate) => `${candidate.name}·${candidate.domain}`),
		["同名·alpha", "同名·beta"],
	);
	assert.match(out.message, /同名·alpha/);
});

test("解析：查无此人 → missing 且列出可用执事", () => {
	const out = resolveRelayTarget("不存在", PARTNERS, SELF);
	assert.equal(out.ok, false);
	if (out.ok) return;
	assert.equal(out.reason, "missing");
	assert.match(out.message, /信使乙/);
});

test("解析：指向自己 / 总管 → 拒绝（各自有话说）", () => {
	const self = resolveRelayTarget("信使甲", PARTNERS, SELF);
	assert.equal(self.ok === false && self.reason, "self");
	const chief = resolveRelayTarget("总管", PARTNERS, SELF);
	assert.equal(chief.ok === false && chief.reason, "chief");
});

test("解析：暂停的执事不可递（active 之外一律不算）", () => {
	const out = resolveRelayTarget("休假中", PARTNERS, SELF);
	assert.equal(out.ok === false && out.reason, "missing");
});

// ── 正文包装 / hop 标记 / 通知文案 ───────────────────────

test("包装：hop 标记 + 来信人 + 「主人看不到原文」的出口指引", () => {
	const body = relayBody({ name: "信使甲", domain: "inbox" }, "帮我看下日历");
	assert.ok(body.startsWith(RELAY_HOP_TAG), "hop 标记必须在最前（转述检测靠它）");
	assert.match(body, /\[来自执事 信使甲（inbox）\] 帮我看下日历/);
	assert.match(body, /主人看不到原文/);
	assert.match(body, /汇报或主人对话/);
});

test("包装：没有领域时写「无领域」，不留空括号", () => {
	assert.match(relayBody({ name: "信使甲", domain: null }, "在吗"), /（无领域）/);
});

test("通知只报「谁 → 谁」，不含正文", () => {
	const notice = relayNoticeText(
		{ name: "信使甲", domain: "inbox" },
		{ id: "p-b", name: "信使乙", domain: "calendar" },
	);
	assert.match(notice, /信使甲/);
	assert.match(notice, /信使乙/);
	assert.match(notice, /递了一条话/);
	assert.doesNotMatch(notice, /帮我看下日历/);
});

// ── 每 run 上限 ─────────────────────────────────────────

test(`上限：同一 run 内最多 ${RELAY_MAX_PER_RUN} 次，第 ${RELAY_MAX_PER_RUN + 1} 次拒绝`, () => {
	resetRelayState();
	const runKey = "1:run-a";
	for (let i = 1; i <= RELAY_MAX_PER_RUN; i += 1) {
		const slot = takeRelaySlot(1, runKey);
		assert.equal(slot.allowed, true, `第 ${i} 次应该放行`);
		assert.equal(slot.used, i);
	}
	const rejected = takeRelaySlot(1, runKey);
	assert.equal(rejected.allowed, false);
	assert.equal(rejected.used, RELAY_MAX_PER_RUN);
});

test("上限：换 run 就重新计数（计数按 run 键，不按会话累计）", () => {
	resetRelayState();
	for (let i = 0; i < RELAY_MAX_PER_RUN; i += 1) takeRelaySlot(1, "1:run-a");
	assert.equal(takeRelaySlot(1, "1:run-a").allowed, false);
	assert.equal(takeRelaySlot(1, "1:run-b").allowed, true, "新 run 的第一条必须放行");
});

test("run 键：与 turn-gate 同口径（inputs[0] 优先，其次 taskId）", () => {
	assert.equal(relayRunKey(7, { run: { inputs: ["sub-1"], taskId: "t-1" } }), "7:sub-1");
	assert.equal(relayRunKey(7, { run: { inputs: [], taskId: "t-2" } }), "7:t-2");
	assert.equal(relayRunKey(7, null), "7:none");
});

// ── 递话触发的轮次标记（防乒乓的事实源）────────────────

test("标记：一次认领即失效（pendingRelay 是一次性的）", () => {
	resetRelayState();
	markRelayTarget(42);
	assert.equal(claimRelayTarget(42), true);
	assert.equal(claimRelayTarget(42), false, "同一份标记不能被两轮认领");
	assert.equal(claimRelayTarget(43), false);
});

test("标记：投递失败撤销后不再影响下一轮", () => {
	resetRelayState();
	markRelayTarget(42);
	clearRelayTarget(42);
	assert.equal(claimRelayTarget(42), false);
});

test("标记：只有被标记的那个 run 摘工具，下一轮恢复正常", () => {
	resetRelayState();
	markRelayTarget(42);
	const keys = ["42:run-relay"];
	for (const key of keys) {
		beginRelayRun(42, key);
		if (claimRelayTarget(42)) markRelayRun(42, key);
	}
	assert.equal(currentRelayRunKey(42), "42:run-relay");
	assert.equal(isRelayRun(42, "42:run-relay"), true);
	// 下一轮（主人自己说的）：没有标记 → 工具复活
	beginRelayRun(42, "42:run-owner");
	assert.equal(isRelayRun(42, "42:run-owner"), false);
});

test("回滚开关：只有明确写 false/0 才关（缺省与新值都开）", () => {
	assert.equal(partnerRelayEnabled({} as NodeJS.ProcessEnv), true);
	assert.equal(partnerRelayEnabled({ PARTNER_RELAY_ENABLED: "true" } as NodeJS.ProcessEnv), true);
	assert.equal(partnerRelayEnabled({ PARTNER_RELAY_ENABLED: "false" } as NodeJS.ProcessEnv), false);
	assert.equal(partnerRelayEnabled({ PARTNER_RELAY_ENABLED: "0" } as NodeJS.ProcessEnv), false);
});

// ── 批 15 §五：两态回执（queued / settled）───────────────

test("回执开关：默认开；false/0/off 才关", () => {
	assert.equal(partnerRelayReceiptEnabled({}), true);
	assert.equal(partnerRelayReceiptEnabled({ PARTNER_RELAY_RECEIPT: "false" }), false);
	assert.equal(partnerRelayReceiptEnabled({ PARTNER_RELAY_RECEIPT: "0" }), false);
	assert.equal(partnerRelayReceiptEnabled({ PARTNER_RELAY_RECEIPT: "off" }), false);
	assert.equal(partnerRelayReceiptEnabled({ PARTNER_RELAY_RECEIPT: "true" }), true);
});

test("queued 文案：开关关着逐字节等于旧文案（回滚口径）", () => {
	const when = "对方正在忙，这条排在它本轮之后";
	const legacy =
		`已递给「信使乙」（${when}）。` +
		"主人那边只会看到一条通知、看不到原文；需要主人知道的事，你自己也要在回复里说。";
	assert.equal(relayDeliveredText("信使乙", true, false), legacy);
	assert.equal(
		relayDeliveredText("信使乙", false, false),
		`已递给「信使乙」（对方空闲，已开始看）。` +
			"主人那边只会看到一条通知、看不到原文；需要主人知道的事，你自己也要在回复里说。",
	);
});

test("queued 文案：开着时明确两态，不把“已投递”说成“已处理”", () => {
	const out = relayDeliveredText("信使乙", false, true);
	assert.ok(out.includes(RELAY_RECEIPT_QUEUED));
	assert.match(out, /对方跑完后会回你一条结果/);
	assert.ok(!out.includes(RELAY_RECEIPT_SETTLED));
});

test("settled 文案：一句话 + 长度限制 + 空结果兜底", () => {
	const out = relaySettledText("信使乙", "查完了。\n明天上午十点开会。");
	assert.equal(out, "「信使乙」处理完了你递的那条话：查完了。 明天上午十点开会。");

	const long = relaySettledText("信使乙", "字".repeat(400));
	assert.ok(long.length <= 200, `实际 ${long.length}`);
	assert.ok(long.endsWith("…"));

	assert.match(relaySettledText("信使乙", "  "), /没有给出结论/);
});

test("settled 落点：发送方 transcript 记一条 pi.assistant 留言", () => {
	const entry = relayOutcomeEntry("【留言】「信使乙」处理完了你递的那条话：好");
	assert.equal(entry.kind, "pi.assistant");
	const data = entry.data as { relay?: string; receipt?: string } | undefined;
	assert.equal(data?.relay, "outcome");
	assert.equal(data?.receipt, RELAY_RECEIPT_SETTLED);
	const text = entry.model?.[0]?.content;
	assert.ok(JSON.stringify(text).includes("【留言】"));
});
