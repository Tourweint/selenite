import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 员工人格 · 人设库（2026-11-15 批3）单测。
 *
 * 覆盖任务书红线：应用快照后 SOUL 不变、上限 5 份、同份数/同名拒绝、
 * 模块关 / 总开关 false 时动作全拒；应用是整份覆盖（不是字段合并）。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-partner-profiles-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "homes");
delete process.env.PARTNER_PERSONA_MODULES;

const { PartnersStore } = await import("./partners.ts");
const { defaultPersonaModules, readPersonaContents, writePersonaContents } = await import("./partner-persona.ts");
const {
	applyProfile,
	profilesModuleOn,
	profilesView,
	readProfiles,
	removeProfile,
	saveProfile,
} = await import("./partner-profiles.ts");

const store = new PartnersStore(process.env.PARTNERS_DB_PATH, process.env.PARTNER_HOMES_ROOT);

after(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

function makePartner(name: string, on = true) {
	const partner = store.create(name);
	const modules = { ...defaultPersonaModules("custom") };
	modules.profiles = on;
	return store.setPersona(partner.id, { preset: "custom", modules })!;
}

test("存一份快照：整套 contents + modules + preset；上限 5 份、同名拒绝", () => {
	const partner = makePartner("人设库执事");
	writePersonaContents(store, partner.id, {
		style: { speakStyle: "短句，先给结论。" },
		values: { cares: "把活办完。" },
		scenario: { situation: "在补上周的账。" },
	});
	const first = saveProfile(partner.id, "工作态", store, "2026-11-15T10:00:00.000Z");
	assert.equal(first.ok, true);
	const items = readProfiles(store, partner.id);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.name, "工作态");
	assert.equal(items[0]?.preset, "custom");
	assert.equal(items[0]?.modules.profiles, true);
	assert.equal(items[0]?.contents.style.speakStyle, "短句，先给结论。");

	assert.equal(saveProfile(partner.id, "工作态", store).ok, false, "同名拒绝");
	for (let index = 2; index <= 5; index += 1) {
		assert.equal(saveProfile(partner.id, `人设${index}`, store).ok, true);
	}
	assert.equal(readProfiles(store, partner.id).length, 5);
	assert.equal(saveProfile(partner.id, "第六份", store).ok, false, "上限 5 份");
	const view = profilesView(partner, store);
	assert.equal(view.limit, 5);
	assert.equal(view.items.length, 5);
	assert.equal("contents" in (view.items[0] ?? {}), false, "列表只回摘要，不回 contents");
});

test("5 份接近字段上限的快照可以落盘（不被身份文件的 64KB 槽位护栏拦住）", () => {
	const partner = makePartner("大快照执事");
	writePersonaContents(store, partner.id, {
		style: {
			speakStyle: "字".repeat(300),
			catchphrases: Array.from({ length: 8 }, () => "口".repeat(24)),
			taboos: Array.from({ length: 6 }, () => "忌".repeat(48)),
			exampleDialogues: Array.from({ length: 3 }, () => "例".repeat(400)),
			altStyle: "替".repeat(300),
			emojiHabit: "表".repeat(80),
			openingLine: "开".repeat(120),
		},
		values: {
			cares: "在".repeat(200),
			bottomLines: "底".repeat(200),
			fears: "怕".repeat(120),
			likes: Array.from({ length: 10 }, () => "喜".repeat(30)),
			dislikes: Array.from({ length: 10 }, () => "厌".repeat(30)),
			motivator: "劲".repeat(100),
			valueKeywords: Array.from({ length: 3 }, () => "关".repeat(8)),
		},
		scenario: {
			situation: "处".repeat(300),
			knowledgeBoundary: "知".repeat(300),
			relations: Array.from({ length: 10 }, () => "系".repeat(60)),
		},
	});
	for (let index = 1; index <= 5; index += 1) {
		assert.equal(saveProfile(partner.id, `大快照${index}`, store).ok, true, `第 ${index} 份`);
	}
	assert.equal(readProfiles(store, partner.id).length, 5);
	const raw = readFileSync(join(store.homeOf(partner.id), "persona", "profiles.json"), "utf8");
	assert.ok(Buffer.byteLength(raw, "utf8") > 64 * 1024, "这份文件已经超过 64KB");
});

test("应用快照 = 整份写回（不是字段合并）；SOUL 一个字节都不动", () => {
	const partner = makePartner("应用执事");
	writePersonaContents(store, partner.id, {
		style: { speakStyle: "短句。", openingLine: "我来了。" },
	});
	assert.equal(saveProfile(partner.id, "旧态", store).ok, true);
	const snapshot = readProfiles(store, partner.id)[0]!;
	const soulBefore = store.readSoulFromHome(partner.id) ?? "";

	// 保存后改内容 + 加字段；应用后必须回到保存当时（新字段消失）
	writePersonaContents(store, partner.id, {
		style: { speakStyle: "变了。", emojiHabit: "爱用表情" },
		values: { likes: ["咖啡"] },
	});
	const applied = applyProfile(partner.id, snapshot.id, store);
	assert.equal(applied.ok, true);
	const contents = readPersonaContents(store, partner.id);
	assert.equal(contents.style.speakStyle, "短句。");
	assert.equal(contents.style.openingLine, "我来了。");
	assert.equal(contents.style.emojiHabit, undefined, "整份覆盖，快照之后加的字段要消失");
	assert.equal(contents.values.likes, undefined);
	assert.equal(store.readSoulFromHome(partner.id) ?? "", soulBefore, "SOUL 不变");

	// 删一份
	assert.equal(removeProfile(partner.id, snapshot.id, store).ok, true);
	assert.equal(readProfiles(store, partner.id).length, 0);
	assert.equal(removeProfile(partner.id, snapshot.id, store).ok, false);
});

test("模块关：存 / 应用 / 删都拒绝，但已有列表仍回读（内容保留）", () => {
	const partner = makePartner("开关执事", true);
	writePersonaContents(store, partner.id, { style: { speakStyle: "短句。" } });
	assert.equal(saveProfile(partner.id, "先存一份", store).ok, true);
	const id = readProfiles(store, partner.id)[0]!.id;

	const off = store.setPersona(partner.id, {
		preset: "custom",
		modules: { ...defaultPersonaModules("custom"), profiles: false },
	})!;
	assert.equal(profilesModuleOn(off), false);
	assert.equal(profilesView(off, store).items.length, 1, "模块关仍回读（内容保留）");
	assert.equal(saveProfile(partner.id, "再存一份", store).ok, false);
	assert.equal(applyProfile(partner.id, id, store).ok, false);
	assert.equal(removeProfile(partner.id, id, store).ok, false);

	const previous = process.env.PARTNER_PERSONA_MODULES;
	process.env.PARTNER_PERSONA_MODULES = "false";
	try {
		assert.equal(profilesModuleOn(off), false);
		assert.equal(saveProfile(partner.id, "总开关关", store).ok, false);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_PERSONA_MODULES;
		else process.env.PARTNER_PERSONA_MODULES = previous;
	}
});
