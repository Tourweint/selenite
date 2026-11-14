import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 员工人格 · 主动性（2026-11-15 批3）单测。
 *
 * 不真起提醒链：`send` 注入捕获正文；记忆用 `intentions` 注入。
 * 断言四条红线：默认关 / 子开关关 / 一天一条 / 必须带执事身份。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-partner-proactive-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "homes");
delete process.env.PARTNER_PERSONA_MODULES;

const { PartnersStore } = await import("./partners.ts");
const { defaultPersonaModules } = await import("./partner-persona.ts");
const { buildPartnerTurnContext } = await import("./agent/partner-context.ts");
const {
	buildNudgeText,
	buildProactivitySection,
	maybeScheduleNudge,
	nudgeEnabledOn,
	pickTodayIntention,
	proactivityView,
	readNudgeState,
} = await import("./partner-proactive.ts");

const store = new PartnersStore(process.env.PARTNERS_DB_PATH, process.env.PARTNER_HOMES_ROOT);

after(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

function makePartner(name: string, on: boolean, nudge = on) {
	const partner = store.create(name);
	const modules = { ...defaultPersonaModules("custom") };
	modules.proactivity = on;
	return store.setPersona(partner.id, {
		preset: "custom",
		modules,
		switches: { nudgeEnabled: nudge },
	})!;
}

const NOW = new Date(2026, 10, 15, 9, 0, 0);

test("默认关：work 预设 proactivity=false，不注入、不排提醒", async () => {
	const partner = store.create("默认关主动执事");
	assert.equal(nudgeEnabledOn(partner), false);
	assert.equal(buildProactivitySection(partner), undefined);
	let sent = 0;
	const result = await maybeScheduleNudge(partner.id, {
		store,
		now: () => NOW,
		intentions: () => [{ content: "今天要取件", createdAt: NOW.toISOString() }],
		send: async () => {
			sent += 1;
			return true;
		},
	});
	assert.equal(result, false);
	assert.equal(sent, 0);
	const context = buildPartnerTurnContext(partner.id, 0, { store, workRoot: join(root, "runs") });
	assert.equal(context.proactivity, null);
});

test("模块开、子开关关：不排；子开关开：排一条，正文带【执事名】", async () => {
	const partner = makePartner("挂念执事", true, false);
	assert.equal(buildProactivitySection(partner)?.includes("【主动一点】"), true);
	let sentText = "";
	assert.equal(
		await maybeScheduleNudge(partner.id, {
			store,
			now: () => NOW,
			intentions: () => [{ content: "今天要取件", createdAt: NOW.toISOString() }],
			send: async (_id, text) => {
				sentText = text;
				return true;
			},
		}),
		false,
		"子开关关着不排",
	);

	const on = store.setPersona(partner.id, {
		preset: "custom",
		modules: { ...defaultPersonaModules("custom"), proactivity: true },
		switches: { nudgeEnabled: true },
	})!;
	assert.equal(
		await maybeScheduleNudge(on.id, {
			store,
			now: () => NOW,
			intentions: () => [{ content: "今天要取件", createdAt: NOW.toISOString() }],
			send: async (_id, text) => {
				sentText = text;
				return true;
			},
		}),
		true,
	);
	assert.match(sentText, /^【挂念执事】/, "必须带执事身份");
	assert.match(sentText, /取件/);
	assert.ok([...sentText].length <= 80);
	assert.match(buildProactivitySection(on) ?? "", /【主动一点】/);
});

test("一天最多一条：同一天第二次不排；隔天可再排；状态落 persona/nudge.json", async () => {
	const partner = makePartner("日限执事", true, true);
	const intentions = () => [{ content: "今天要取件", createdAt: NOW.toISOString() }];
	let sent = 0;
	const send = async () => {
		sent += 1;
		return true;
	};
	assert.equal(await maybeScheduleNudge(partner.id, { store, now: () => NOW, intentions, send }), true);
	assert.equal(await maybeScheduleNudge(partner.id, { store, now: () => NOW, intentions, send }), false);
	assert.equal(sent, 1);
	const state = readNudgeState(store, partner.id);
	assert.equal(state.lastDate, "2026-11-15");
	assert.equal(state.lastAt, NOW.toISOString());

	const nextDay = new Date(2026, 10, 16, 9, 0, 0);
	assert.equal(
		await maybeScheduleNudge(partner.id, {
			store,
			now: () => nextDay,
			intentions: () => [{ content: "今天要交房租", createdAt: nextDay.toISOString() }],
			send,
		}),
		true,
	);
	assert.equal(sent, 2);
	assert.deepEqual(proactivityView(partner, store), {
		nudgeEnabled: true,
		lastNudgeAt: nextDay.toISOString(),
	});
});

test("只挑今天相关的意图：明天 / 已过期的不发；没有可发的当天不落状态（晚些还能试）", async () => {
	const partner = makePartner("挑事执事", true, true);
	let sent = 0;
	const send = async () => {
		sent += 1;
		return true;
	};
	assert.equal(
		await maybeScheduleNudge(partner.id, {
			store,
			now: () => NOW,
			intentions: () => [
				{ content: "明天要去医院", createdAt: NOW.toISOString() },
				{ content: "上周的旧事", createdAt: "2026-11-01T00:00:00Z" },
			],
			send,
		}),
		false,
	);
	assert.equal(sent, 0);
	assert.equal(readNudgeState(store, partner.id).lastDate, null);

	const picked = pickTodayIntention(
		[
			{ content: "今天要取件", createdAt: "2026-11-15T01:00:00Z" },
			{ content: "今天交房租", createdAt: "2026-11-15T02:00:00Z" },
		],
		NOW,
	);
	assert.equal(picked?.content, "今天交房租", "取最新一条");
	assert.equal(buildNudgeText("小七", "今天要取件").startsWith("【小七】"), true);
});

test("总开关 false：全停（不注入、不排）", async () => {
	const partner = makePartner("回滚主动执事", true, true);
	const previous = process.env.PARTNER_PERSONA_MODULES;
	process.env.PARTNER_PERSONA_MODULES = "false";
	try {
		assert.equal(nudgeEnabledOn(partner), false);
		assert.equal(buildProactivitySection(partner), undefined);
		assert.equal(
			await maybeScheduleNudge(partner.id, {
				store,
				now: () => NOW,
				intentions: () => [{ content: "今天要取件", createdAt: NOW.toISOString() }],
				send: async () => true,
			}),
			false,
		);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_PERSONA_MODULES;
		else process.env.PARTNER_PERSONA_MODULES = previous;
	}
});
