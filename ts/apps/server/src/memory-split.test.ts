import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryStore, MemoryEngine } from "@lifediary/memory";
import { applySplitPlan, buildSplitPlan } from "./memory-split.ts";

function engineWithLongFact(content: string): { engine: MemoryEngine; id: string } {
	const store = new InMemoryStore({ redact: false });
	const engine = new MemoryEngine({ store });
	const record = engine.remember({
		kind: "fact",
		scope: { type: "global" },
		content,
		source: "test",
		importance: 0.8,
	});
	return { engine, id: record.id };
}

const LONG = [
	"2026-11-12 桌面端设置页重做：工作区根与项目改为平级；项目可以在任意位置，不要求在工作区内。",
	"助手物理边界是所有已登记且未移除的根之并集；写入落在任一根内放行。",
	"「完全访问」只是审批档，不绕过边界；要访问新位置必须登记为项目。",
	"回滚开关 PROJECT_OUTSIDE_WORKSPACE=false 恢复单根口径。",
	"移除项目不连带批量归档普通会话，历史任务和会话都保留。",
	"项目之间不允许同路径、嵌套或包含工作区根；路径可改，移除是软删，可在已移除里恢复。",
	"设置页只留一节「项目」：工作区根与项目同一种行、同一字号，路径可直接编辑保存。",
].join("");

test("长记忆拆成多条原子，引文都能在原文里找到", () => {
	const { engine, id } = engineWithLongFact(LONG);
	const preview = buildSplitPlan(engine, "global");
	assert.equal(preview.candidates.length, 1);
	const plan = preview.plans[0]!;
	assert.equal(plan.recordId, id);
	assert.ok(plan.atoms.length >= 2, `expected multiple atoms, got ${plan.atoms.length}`);
	for (const atom of plan.atoms) {
		assert.ok(plan.doc.content.includes(atom.quote), `quote not in doc: ${atom.quote}`);
		assert.ok(atom.content.length <= 200, `atom too long: ${atom.content.length}`);
	}
});

test("应用拆分：原文进文档、原子进记忆、原记录归档且不再召回", () => {
	const { engine, id } = engineWithLongFact(LONG);
	const preview = buildSplitPlan(engine, "global");
	const result = applySplitPlan(engine, preview);
	assert.equal(result.documents, 1);
	assert.equal(result.archived, 1);
	assert.ok(result.atoms >= 2);

	const archived = engine.getRecord(id);
	assert.ok(archived?.archivedAt, "原记录应归档");
	assert.ok(archived?.docId, "原记录应指回原文档案");

	const active = engine.list({ scopes: ["global"] });
	assert.ok(active.length >= 2);
	assert.ok(active.every((record) => !record.archivedAt));
	assert.ok(active.every((record) => Boolean(record.docId)));

	const docs = engine.listDocuments({ scopes: ["global"] });
	assert.equal(docs.length, 1);
	assert.equal(docs[0]!.id, archived?.docId);
	assert.ok(docs[0]!.content.includes("PROJECT_OUTSIDE_WORKSPACE"));

	// 召回只看原子，不再把归档的长记录拉回来。
	const hits = engine.recall({ text: "PROJECT_OUTSIDE_WORKSPACE 回滚", scopes: ["global"], limit: 10 });
	assert.ok(hits.length > 0);
	assert.ok(hits.every((hit) => !hit.record.archivedAt));
});

test("ids 传空数组 = 一条都不拆（前端取消全选）", () => {
	const { engine } = engineWithLongFact(LONG);
	const preview = buildSplitPlan(engine, "global", { ids: [] });
	assert.equal(preview.candidates.length, 0);
	assert.equal(preview.plans.length, 0);
});

test("拆分幂等：同一份计划应用两次不会重复产出", () => {
	const { engine } = engineWithLongFact(LONG);
	const preview = buildSplitPlan(engine, "global");
	const first = applySplitPlan(engine, preview);
	const second = applySplitPlan(engine, preview);
	assert.ok(first.atoms >= 2);
	assert.equal(second.documents, 0);
	assert.equal(second.atoms, 0);
});

test("短记忆不进入拆分候选", () => {
	const { engine } = engineWithLongFact("我养了一只叫豆豆的猫。");
	const preview = buildSplitPlan(engine, "global");
	assert.equal(preview.candidates.length, 0);
});
