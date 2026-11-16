import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryStore, MemoryEngine } from "@lifediary/memory";
import { buildSplitPlan } from "./memory-split.ts";
import {
	applySmartSplit,
	locateQuote,
	MAX_SMART_SPLIT_RECORDS,
	parseSmartSplitJson,
	runSmartSplit,
} from "./memory-split-smart.ts";

const LONG = [
	"2026-11-12 桌面端设置页重做：工作区根与项目改为平级；项目可以在任意位置，不要求在工作区内。",
	"助手物理边界是所有已登记且未移除的根之并集；写入落在任一根内放行。",
	"「完全访问」只是审批档，不绕过边界；要访问新位置必须登记为项目。",
	"回滚开关 PROJECT_OUTSIDE_WORKSPACE=false 恢复单根口径。",
	"移除项目不连带批量归档普通会话，历史任务和会话都保留。",
	"项目之间不允许同路径、嵌套或包含工作区根；路径可改，移除是软删，可在已移除里恢复。",
].join("");

function engineWith(content: string): { engine: MemoryEngine; id: string } {
	const store = new InMemoryStore({ redact: false });
	const engine = new MemoryEngine({ store });
	const record = engine.remember({
		kind: "fact",
		scope: { type: "global" },
		content,
		source: "import:zcode-projects",
		importance: 0.8,
	});
	return { engine, id: record.id };
}

test("引文校验：直配 / 空白折叠命中，找不到返回 null", () => {
	assert.deepEqual(locateQuote(LONG, "助手物理边界是所有已登记且未移除的根之并集"), {
		start: LONG.indexOf("助手物理边界"),
		end: LONG.indexOf("助手物理边界") + "助手物理边界是所有已登记且未移除的根之并集".length,
	});
	// 原文里的换行被模型折叠成空格，仍应命中
	const spaced = "第一段\n第二段";
	assert.ok(locateQuote(spaced, "第一段 第二段"));
	// 模型改写过的引文不算数
	assert.equal(locateQuote(LONG, "助手边界就是所有根"), null);
	assert.equal(locateQuote(LONG, "太短"), null);
});

test("解析模型输出：容忍围栏与前后废话，丢弃缺字段的条目", () => {
	const raw = '好的，结果如下：\n```json\n{"atoms":[{"content":"工作区根与项目平级","quote":"工作区根与项目改为平级"},{"content":""},{"content":"缺引文"}]}\n```';
	const atoms = parseSmartSplitJson(raw);
	assert.ok(atoms);
	assert.equal(atoms!.length, 1);
	assert.equal(atoms![0]!.content, "工作区根与项目平级");
	assert.equal(parseSmartSplitJson("不是 JSON"), null);
});

test("智能拆分：模型产出过引文校验，失败的原子被丢弃", async () => {
	const { engine, id } = engineWith(LONG);
	const preview = buildSplitPlan(engine, "global");
	assert.equal(preview.candidates.length, 1);
	const result = await runSmartSplit(engine, preview.plans, {
		deps: {
			model: { provider: "test", modelId: "fake" },
			generate: async () =>
				JSON.stringify({
					atoms: [
						{ content: "工作区根与项目平级", quote: "工作区根与项目改为平级" },
						{ content: "物理边界是所有登记根之并集", quote: "助手物理边界是所有已登记且未移除的根之并集" },
						{ content: "编出来的东西", quote: "原文里根本没有这句话" },
					],
				}),
		},
	});
	assert.equal(result.ok, true);
	assert.equal(result.calls, 1);
	const record = result.records[0]!;
	assert.equal(record.recordId, id);
	assert.equal(record.atoms.length, 2, "两条引文能对上，编造的那条被丢");
	assert.equal(record.dropped, 1);
	for (const atom of record.atoms) {
		assert.ok(LONG.includes(atom.quote), `引文必须来自原文: ${atom.quote}`);
	}
});

test("智能拆分：模型返回空 / 非 JSON 时该条报失败，不影响其它", async () => {
	const { engine } = engineWith(LONG);
	const preview = buildSplitPlan(engine, "global");
	const result = await runSmartSplit(engine, preview.plans, {
		deps: { model: { provider: "test", modelId: "fake" }, generate: async () => "抱歉，我无法完成" },
	});
	assert.equal(result.ok, true);
	assert.equal(result.records[0]!.atoms.length, 0);
	assert.equal(result.records[0]!.error, "parse_failed");
});

test("智能拆分：模型不可用时报 model_unavailable", async () => {
	const { engine } = engineWith(LONG);
	const preview = buildSplitPlan(engine, "global");
	const result = await runSmartSplit(engine, preview.plans, { deps: { model: null } });
	assert.equal(result.ok, false);
	assert.equal(result.error, "model_unavailable");
});

test("智能拆分解析层：逐字引文保留、编造引文丢弃", async () => {
	const { engine } = engineWith(LONG);
	const preview = buildSplitPlan(engine, "global");
	const plan = preview.plans[0]!;
	// 构造一条记录级候选，验证 applySmartSplit 的二次校验
	const applied = applySmartSplit(engine, preview.plans, [
		{
			recordId: plan.recordId,
			title: "t",
			kind: "fact",
			chars: LONG.length,
			dropped: 0,
			atoms: [
				{ content: "工作区根与项目平级", quote: "工作区根与项目改为平级", quoteStart: null, quoteEnd: null },
				{ content: "编出来的", quote: "原文没有这句", quoteStart: null, quoteEnd: null },
			],
		},
	]);
	assert.equal(applied.documents, 1);
	assert.equal(applied.atoms, 1, "只有引文能对上的那条落库");
	const docs = engine.listDocuments({ scopes: ["global"] });
	assert.equal(docs.length, 1);
});

test("智能拆分一次最多处理固定条数", async () => {
	const store = new InMemoryStore({ redact: false });
	const engine = new MemoryEngine({ store });
	for (let i = 0; i < MAX_SMART_SPLIT_RECORDS + 2; i += 1) {
		engine.remember({
			kind: "fact",
			scope: { type: "global" },
			content: `${LONG}（第 ${i} 条）`,
			source: "import:zcode-projects",
		});
	}
	const preview = buildSplitPlan(engine, "global");
	assert.ok(preview.plans.length > MAX_SMART_SPLIT_RECORDS);
	const result = await runSmartSplit(engine, preview.plans, {
		deps: { model: { provider: "test", modelId: "fake" }, generate: async () => null },
	});
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /too_many_records/);
});
