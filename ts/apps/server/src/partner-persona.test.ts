/**
 * 人格模块开关层的单测（2026-11-15 人设页打磨起建）：
 * - 预设推导 `derivePresetFromModules`：表匹配 → 标该预设，不匹配 → custom，改回 → 跳回；
 * - 新预设 allrounder / apprentice 的表；
 * - workHistory / currentWork 固定注入：行上显式 false 不再生效（`effectivePersonaModules`）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	defaultPersonaModules,
	derivePresetFromModules,
	effectivePersonaModules,
	PERSONA_FIXED_ON_IDS,
	PERSONA_PRESET_MATCH_IDS,
	renderPersonaFieldBlocks,
} from "./partner-persona.ts";

test("derivePresetFromModules：五张表各自自洽（铺默认表就推导回自己）", () => {
	for (const preset of ["work", "companion", "allrounder", "apprentice", "custom"] as const) {
		assert.equal(derivePresetFromModules(defaultPersonaModules(preset)), preset, preset);
	}
});

test("derivePresetFromModules：改一键跳自定义，改回跳回原预设；固定注入的两个 id 不参与比较", () => {
	const modules = defaultPersonaModules("companion");
	modules.expression = false; // 随便改一个可配置键
	assert.equal(derivePresetFromModules(modules), "custom");
	modules.expression = true;
	assert.equal(derivePresetFromModules(modules), "companion");

	// workHistory / currentWork 不在比较集合里（固定注入后表上这两个值无关推导）
	assert.ok(!PERSONA_PRESET_MATCH_IDS.includes("workHistory"));
	assert.ok(!PERSONA_PRESET_MATCH_IDS.includes("currentWork"));
	const weird = defaultPersonaModules("work");
	weird.workHistory = false;
	weird.currentWork = false;
	assert.equal(derivePresetFromModules(weird), "work", "存储里的脏 false 不影响推导");
});

test("新预设：全才 = 岗位+内心全开；学徒 = 学习观察位", () => {
	const all = defaultPersonaModules("allrounder");
	assert.equal(all.contract, true);
	assert.equal(all.discipline, true);
	assert.equal(all.expression, true);
	assert.equal(all.heart, true);
	assert.equal(all.learning, false, "学习默认不开（存数据）");
	assert.equal(all.proactivity, false, "挂念默认不开（发消息）");

	const app = defaultPersonaModules("apprentice");
	assert.equal(app.expression, true);
	assert.equal(app.learning, true);
	assert.equal(app.proactivity, true);
	assert.equal(app.profiles, true);
	assert.equal(app.contract, false);
	assert.equal(app.heart, false);
});

test("workHistory / currentWork 固定注入：行上显式 false 不再生效", () => {
	const row = {
		personaPreset: "companion" as const,
		personaModules: { workHistory: false, currentWork: false },
	};
	const modules = effectivePersonaModules(row);
	for (const id of PERSONA_FIXED_ON_IDS) {
		assert.equal(modules[id], true, `${id} 固定注入`);
	}
	assert.equal(modules.discipline, false, "其余键照旧（companion 纪律关）");
});

test("身份展示字段：口吻 / 里子 / 处境固定三个槽位；空模块也返回空 text", () => {
	const store = {
		homeOf: () => "C:/tmp/persona-home",
		readHomeFile: (_partnerId: string, relative: string) =>
			relative.endsWith("style.json")
				? JSON.stringify({ speakStyle: "说话简短，先给结论。" })
				: null,
		atomicWrite: () => {},
	};
	const partner = {
		id: "persona-test",
		personaPreset: "work" as const,
		personaModules: { expression: true },
	};
	const blocks = renderPersonaFieldBlocks(store, partner);
	assert.deepEqual(blocks.map((block) => block.id), [
		"partner_voice",
		"partner_values",
		"partner_scenario",
	]);
	assert.deepEqual(blocks.map((block) => block.title), [
		"说话方式（口吻）",
		"里子",
		"处境",
	]);
	assert.match(blocks[0]!.text, /【口吻】/);
	assert.match(blocks[0]!.text, /说话简短，先给结论。/);
	assert.equal(blocks[1]!.text, "", "里子空模块给空 text");
	assert.equal(blocks[2]!.text, "", "处境空模块给空 text");
});
