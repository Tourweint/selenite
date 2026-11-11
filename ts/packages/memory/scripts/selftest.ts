/**
 * 记忆框架自测：把四层串起来跑一遍，验证边界是否成立。
 * 前半段用内存存储（不落盘、不污染开发数据）；FTS 相关用例挂在 Sqlite 夹具上
 * （`:memory:`，迁移对账那条用临时目录文件）。
 *
 *   pnpm --filter @lifediary/memory selftest
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	BasicConsolidator,
	IMPORTANCE_CEIL,
	InMemoryStore,
	MAX_EXPERIENCES_PER_TURN,
	MAX_PREFERENCES_PER_TURN,
	MemoryEngine,
	MIN_PREFERENCE_CONFIDENCE,
	NoopExtractor,
	DialogueExtractor,
	PREFERENCE_PROMPT,
	REDACTED,
	SqliteMemoryStore,
	decayedImportance,
	experienceExtractionEnabled,
	extractionPrompt,
	groundedInUserText,
	idCardValid,
	luhnValid,
	memoryRedactEnabled,
	preferenceQuoteCheckEnabled,
	normalizeContent,
	consolidateScope,
	locateEvidence,
	normalizeForGroundingWithMap,
	parseExtractionJson,
	parsePreferenceJson,
	redactSecrets,
	reinforcedImportance,
	renderPreference,
	scopeKey,
	type ExtractMessage,
	type MemoryCandidate,
	type MemoryRecord,
	type MemoryScope,
} from "../src/index.ts";

function assert(condition: unknown, message: string): void {
	if (!condition) {
		console.error(`✗ ${message}`);
		process.exit(1);
	}
}

const store = new InMemoryStore();
const engine = new MemoryEngine({ store });
const scope: MemoryScope = { type: "session", id: "selftest" };

const turn1: ExtractMessage[] = [
	{ role: "user", content: "我养了一只猫叫豆豆，它今年三岁。最近它老是半夜叫，我睡不好。" },
	{ role: "assistant", content: "听起来挺影响睡眠的，要不要看看是不是发情或者环境变化？" },
];

// ── 1. 抽取 + 巩固 ──────────────────────────────
const result = await engine.ingestTurn(turn1, scope);
assert(result.added.length >= 2, `应当抽出至少 2 条记忆，实际 ${result.added.length}`);
console.log(`✓ 抽取入库 ${result.added.length} 条`);

// 助手说的话不该被记下来
assert(
	result.added.every((r) => !r.content.includes("睡眠") || r.content.includes("我")),
	"助手的话不应入库",
);

// ── 2. 重复入库应转为强化，而不是新增 ──────────
const before = store.count();
const again = await engine.ingestTurn(turn1, scope);
assert(again.added.length === 0, `重复内容不应新增，实际新增 ${again.added.length}`);
assert(again.reinforced.length > 0, "重复内容应当被强化");
assert(store.count() === before, "记录总数不应变化");
console.log(`✓ 重复内容转为强化 ${again.reinforced.length} 条（总数仍为 ${store.count()}）`);

// ── 3. 召回 ────────────────────────────────────
const hits = engine.recall({ text: "豆豆 猫", scopes: ["session:selftest"], limit: 5 });
assert(hits.length > 0, "召回结果不应为空");
assert(
	hits.some((h) => h.record.content.includes("豆豆")),
	"含关键词的记忆应当被召回",
);
console.log(`✓ 召回 ${hits.length} 条，首条: ${hits[0]?.record.content.slice(0, 24)}…`);

// ── 4. 召回会强化 ──────────────────────────────
const reinforced = store.get(hits[0]!.record.id);
assert((reinforced?.recallCount ?? 0) > 0, "召回后 recallCount 应当 +1");
console.log(`✓ 召回强化生效（recallCount=${reinforced?.recallCount}）`);

// ── 5. 注入层 ──────────────────────────────────
const context = engine.buildContext(
	{ text: "豆豆 猫", scopes: ["session:selftest"] },
	{ maxChars: 400 },
);
assert(context.length > 0, "注入上下文不应为空");
assert(context.length <= 400 + 120, "注入上下文应当受预算约束");
console.log(`✓ 注入上下文 ${context.length} 字`);
console.log(`\n${context}\n`);

// ── 6. 空记忆时不该返回任何东西 ────────────────
const emptyEngine = new MemoryEngine({ store: new InMemoryStore() });
assert(emptyEngine.buildContext({ text: "随便", scopes: ["global"] }) === "", "空库应返回空串");
console.log("✓ 空库注入返回空串（调用方无需判断）");

// ── 7. 召回候选窗口（2026-11-04 批次一 A2-S）────
// 120 条按 createdAt 严格递增（同毫秒并列会让排序不稳定，测不出真问题）；
// 最老一条含查询关键词、importance 平平。
// 注意 limit 取 20：候选窗口是 `max(limit*5, floor)`，limit 取 ≥120 时 120*5=600
// 会把 floor 完全盖住，测不出窗口差异；20*5=100 正好落在 floor=50 与 200 之间。
// 老记录靠关键词排到第 1，不会被 `slice(0, limit)` 切掉（测的是窗口，不是截断）。
const windowScope = "session:selftest-window";
const windowStore = new InMemoryStore();
const windowBase = Date.now() - 120_000;
for (let index = 0; index < 120; index += 1) {
	const record: MemoryRecord = {
		id: `w-${index}`,
		kind: "fact",
		scope: windowScope,
		content: index === 0 ? "海边有一座灯塔，晚上会亮" : `第 ${index} 条普通记录`,
		importance: 0.3,
		veracity: "stated",
		source: "user",
		createdAt: new Date(windowBase + index * 1000).toISOString(),
		validUntil: null,
		supersededBy: null,
		recallCount: 0,
		lastRecalledAt: null,
	};
	windowStore.put(record);
}
const oldWindow = new MemoryEngine({ store: windowStore, candidateFloor: 50 });
const wideWindow = new MemoryEngine({ store: windowStore, candidateFloor: 200 });
const windowQuery = { text: "灯塔", scopes: [windowScope], limit: 20 };
const narrowHits = oldWindow.recall(windowQuery);
const wideHits = wideWindow.recall(windowQuery);
assert(
	!narrowHits.some((hit) => hit.record.id === "w-0"),
	"floor=50 时最老一条应落在候选窗口外",
);
assert(
	wideHits.some((hit) => hit.record.id === "w-0"),
	"floor=200 时最老一条应进入候选窗口",
);
console.log(
	`✓ 候选窗口：floor=50 召回 ${narrowHits.length} 条（不含最老），floor=200 召回 ${wideHits.length} 条（含最老）`,
);

// ── 8. FTS 文本检索（2026-11-04 批次三 A2-F）────
// 夹具是 Sqlite（`:memory:`），构造支持内存库，不落盘。
// 120 条严格递增 createdAt + 最老一条含关键词，和批次一窗口用例同构；
// floor=50 时窗口只装最新 100 条，最老一条必须靠 3-gram 候选集才捞得回来。
function seedRecord(
	id: string,
	scope: string,
	content: string,
	createdAt: string,
	overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
	return {
		id,
		kind: "fact",
		scope,
		content,
		importance: 0.3,
		veracity: "stated",
		source: "user",
		createdAt,
		validUntil: null,
		supersededBy: null,
		recallCount: 0,
		lastRecalledAt: null,
		...overrides,
	};
}

const ftsScope = "session:selftest-fts";
const ftsStore = new SqliteMemoryStore(":memory:");
assert(ftsStore.ftsAvailable(), "SqliteMemoryStore 应能启用 FTS5 trigram（本机 node:sqlite 支持）");
const ftsBase = Date.now() - 120_000;
for (let index = 0; index < 120; index += 1) {
	ftsStore.put(
		seedRecord(
			`f-${index}`,
			ftsScope,
			index === 0 ? "我最爱吃红烧狮子头，妈妈也喜欢" : `第 ${index} 条普通记录`,
			new Date(ftsBase + index * 1000).toISOString(),
		),
	);
}

// 8.1 真实长句破窗：整句短语匹配恒 0 命中，必须靠 3-gram 词袋 OR
const longSentence = "我今天想吃红烧狮子头，你能帮我找找附近的餐馆吗？";
const longTexts = ftsStore.search({ text: longSentence, scopes: [ftsScope], limit: 50 });
assert(
	longTexts.some((record) => record.id === "f-0"),
	"3-gram 词袋应把长句命中的老记录捞进候选",
);
const longHits = new MemoryEngine({ store: ftsStore, candidateFloor: 50 }).recall({
	text: longSentence,
	scopes: [ftsScope],
	limit: 20,
});
assert(
	longHits.some((hit) => hit.record.id === "f-0"),
	"floor=50（窗口外）时完整长句仍必须召回最老一条",
);
// 候选集是"文本命中 ∪ 最近窗口"（2026-11-04 验收修订）：捞回老条目的同时不许丢掉最近的上下文
assert(
	longHits.length > 1 && longHits.some((hit) => hit.record.id !== "f-0"),
	"FTS 命中老记录时，窗口内的新记忆也必须还在候选里",
);
console.log(`✓ 长句破窗：候选 ${longTexts.length} 条，召回含最老一条`);

// 8.2 2 字查询回落：切不出 3-gram → 窗口路径，行为同批次一
const momQuery = { text: "妈妈", scopes: [ftsScope], limit: 20 };
const narrowMom = new MemoryEngine({ store: ftsStore, candidateFloor: 50 }).recall(momQuery);
const wideMom = new MemoryEngine({ store: ftsStore, candidateFloor: 200 }).recall(momQuery);
assert(
	!narrowMom.some((hit) => hit.record.id === "f-0"),
	"2 字查询应走窗口路径：floor=50 不含最老",
);
assert(
	wideMom.some((hit) => hit.record.id === "f-0"),
	"2 字查询应走窗口路径：floor=200 含最老",
);
console.log(`✓ 2 字查询回落：floor=50 召回 ${narrowMom.length} 条，floor=200 召回 ${wideMom.length} 条`);

// 8.3 中英混排：不抛错、正常返回
const mixedHits = new MemoryEngine({ store: ftsStore, candidateFloor: 50 }).recall({
	text: "最近在用 Python 学做饭，红烧狮子头 OK 吗？",
	scopes: [ftsScope],
	limit: 20,
});
assert(Array.isArray(mixedHits) && mixedHits.length > 0, "中英混排应正常返回非空结果");
assert(
	mixedHits.some((hit) => hit.record.id === "f-0"),
	"中英混排里的中文 3-gram 仍应命中",
);
console.log(`✓ 中英混排：返回 ${mixedHits.length} 条`);

// 8.4 FTS 关闭（回滚开关）：忽略 text、行为同批次一
const jsStore = new SqliteMemoryStore(":memory:", { fts: false });
assert(!jsStore.ftsAvailable(), "fts:false 时能力位应为 false");
for (let index = 0; index < 120; index += 1) {
	jsStore.put(
		seedRecord(
			`j-${index}`,
			ftsScope,
			index === 0 ? "我最爱吃红烧狮子头，妈妈也喜欢" : `第 ${index} 条普通记录`,
			new Date(ftsBase + index * 1000).toISOString(),
		),
	);
}
const jsHits = new MemoryEngine({ store: jsStore, candidateFloor: 50 }).recall({
	text: longSentence,
	scopes: [ftsScope],
	limit: 20,
});
assert(
	!jsHits.some((hit) => hit.record.id === "j-0"),
	"fts:false 时 text 必须被忽略：floor=50 不含最老一条",
);
console.log(`✓ FTS 关闭：忽略 text，召回 ${jsHits.length} 条（不含最老）`);

// 8.5 0 命中回落：词袋与库内无交集 → 返回窗口兜底，不是空
const zeroQueryText = "量子纠缠光谱仪";
assert(
	ftsStore.search({ text: zeroQueryText, scopes: [ftsScope], limit: 50 }).length === 0,
	"0 命中场景应先用 FTS 查出空候选",
);
const zeroHits = new MemoryEngine({ store: ftsStore, candidateFloor: 50 }).recall({
	text: zeroQueryText,
	scopes: [ftsScope],
	limit: 20,
});
assert(zeroHits.length > 0, "FTS 0 命中必须回落窗口路径，不能让记忆注入整体消失");
console.log(`✓ 0 命中回落：窗口兜底 ${zeroHits.length} 条`);

// 8.6 镜像维护：put 换内容、patch 换内容、superseded 不入候选
const mirrorStore = new SqliteMemoryStore(":memory:");
mirrorStore.put(seedRecord("m-1", ftsScope, "旧内容只讲海边的猫", new Date().toISOString()));
assert(mirrorStore.search({ text: "旧内容", limit: 5 }).length === 1, "put 后应能检索到");
mirrorStore.put(seedRecord("m-1", ftsScope, "新内容改成讲山里的狗", new Date().toISOString()));
assert(mirrorStore.search({ text: "旧内容", limit: 5 }).length === 0, "put 换内容后旧词不应命中");
assert(mirrorStore.search({ text: "新内容", limit: 5 }).length === 1, "put 换内容后新词应命中");
mirrorStore.patch("m-1", { content: "第三次改成讲屋顶的鸟" });
assert(mirrorStore.search({ text: "新内容", limit: 5 }).length === 0, "patch 换内容后旧词不应命中");
assert(mirrorStore.search({ text: "第三次", limit: 5 }).length === 1, "patch 换内容后新词应命中");
mirrorStore.put(
	seedRecord("m-2", ftsScope, "山里的狗被取代的记录", new Date().toISOString(), {
		supersededBy: "m-1",
	}),
);
assert(mirrorStore.search({ text: "山里的狗", limit: 5 }).length === 0, "superseded 记录不应进候选");
assert(
	mirrorStore.search({ text: "山里的狗", includeSuperseded: true, limit: 5 }).length === 1,
	"显式 includeSuperseded 时仍应能查到",
);
console.log("✓ 镜像维护：put / patch / superseded 口径成立");

// 8.7 迁移对账：旧库（无镜像）与镜像被破坏，都在 init 时重建
const tempDir = mkdtempSync(join(tmpdir(), "lifediary-mem-"));
const tempDb = join(tempDir, "memory.db");
try {
	const legacyStore = new SqliteMemoryStore(tempDb, { fts: false });
	legacyStore.put(seedRecord("t-1", ftsScope, "旧库里的红烧狮子头", new Date().toISOString()));
	legacyStore.put(seedRecord("t-2", ftsScope, "另一条普通记录", new Date().toISOString()));
	legacyStore.close();

	const upgraded = new SqliteMemoryStore(tempDb);
	assert(upgraded.ftsAvailable(), "重开旧库应启用 FTS");
	assert(upgraded.search({ text: "红烧狮子头", limit: 5 }).length === 1, "旧库应在 init 时补建镜像");
	upgraded.close();

	const raw = new DatabaseSync(tempDb);
	raw.exec("DELETE FROM memory_fts");
	raw.close();

	const repaired = new SqliteMemoryStore(tempDb);
	assert(repaired.search({ text: "红烧狮子头", limit: 5 }).length === 1, "镜像行数被破坏后应重建");
	repaired.close();
	console.log("✓ 迁移对账：旧库补建、坏镜像重建");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

// ── 9. partner 作用域隔离（2026-11-05 批次B B1）──────────────
// 伙伴记忆与主人记忆键空间完全隔离：同一套存储/召回，scope key 不同互不可见。
// 写入走 remember()（它内部用 scopeKey 换算，等价于生产链路）。
{
	const partnerEngine = new MemoryEngine({ store: new InMemoryStore() });
	const partnerA: MemoryScope = { type: "partner", id: "11111111-1111-4111-8111-111111111111" };
	const partnerB: MemoryScope = { type: "partner", id: "22222222-2222-4222-8222-222222222222" };

	partnerEngine.remember({ kind: "preference", scope: partnerA, content: "伙伴A记的：主人喜欢简洁的汇报" });
	partnerEngine.remember({ kind: "fact", scope: partnerB, content: "伙伴B记的：主人在筹备搬家" });
	partnerEngine.remember({ kind: "fact", scope: { type: "global" }, content: "全局记忆：主人名字写在配置里" });

	const keyA = scopeKey(partnerA);
	const keyB = scopeKey(partnerB);

	const hitsA = partnerEngine.recall({ text: "汇报 搬家 简洁", scopes: [keyA], limit: 10 });
	assert(hitsA.every((hit) => hit.record.scope === keyA), "partner A 的召回不得跨出自己键空间");
	assert(hitsA.some((hit) => hit.record.content.includes("简洁")), "partner A 应召回自己的记录");
	assert(!hitsA.some((hit) => hit.record.content.includes("搬家")), "partner A 不得召回 partner B 的记录");

	// recall 语义是"给上下文挑相关记忆"（近因+重要度打分），不是文本搜索：
	// A 键空间查"搬家"可以带回 A 自己的近条目，但**绝不允许出现别的键空间的记录**——
	// 这才是隔离性质（键空间过滤在 store.search 的 scope IN 上，硬过滤）。
	const crossSearch = partnerEngine.recall({ text: "搬家", scopes: [keyA], limit: 10 });
	assert(
		crossSearch.every((hit) => hit.record.scope === keyA),
		"partner A 键空间查「搬家」绝不带出 partner B / global 的记录",
	);
	const ownB = partnerEngine.recall({ text: "搬家", scopes: [keyB], limit: 10 });
	assert(
		ownB.some((hit) => hit.record.content.includes("搬家")) && ownB.every((hit) => hit.record.scope === keyB),
		"partner B 键空间内能召回自己的，且不带别人的",
	);

	// 全局与 partner 互不串（伙伴能读 global 是 server 注入口的取舍，存储层不做特判）
	const globalOnly = partnerEngine.recall({ text: "配置", scopes: ["global"], limit: 10 });
	assert(globalOnly.length === 1, "global 键空间照常可用");
	console.log(`✓ partner 作用域：键空间隔离成立（key=${keyA.slice(0, 16)}…）`);
}

// ── 10. 偏好抽取（2026-11-06）───────────────────────────
// 抽取器本身不碰模型：模型调用是注入的，这里注入一个假函数就能测全部分支。
{
	// 10.1 解析：模型最常犯的三种毛病（围栏 / 前后解释 / 字段名写错）都要能活
	const fenced = parsePreferenceJson(
		'好的，我提取到：\n```json\n[{"content":"用户不喜欢被追问太多","why":"说过会累","howToApply":"需要澄清时一次只问一个","confidence":0.9}]\n```',
	);
	assert(fenced.length === 1, `围栏 + 前后解释应解析出 1 条，实际 ${fenced.length}`);
	assert(fenced[0]!.content.includes("追问"), "正文应保留");
	assert(fenced[0]!.why === "说过会累" && fenced[0]!.howToApply.includes("一次只问一个"), "why/how 应保留");

	const wrapped = parsePreferenceJson('{"preferences":[{"content":"以后都用中文","confidence":0.8}]}');
	assert(wrapped.length === 1 && wrapped[0]!.content === "以后都用中文", "{preferences:[…]} 形状应支持");

	// 10.2 阈值与上限
	assert(
		parsePreferenceJson(`[{"content":"低置信","confidence":${MIN_PREFERENCE_CONFIDENCE - 0.1}}]`).length === 0,
		"低于阈值的应丢弃",
	);
	const many = parsePreferenceJson(
		JSON.stringify(
			Array.from({ length: MAX_PREFERENCES_PER_TURN + 3 }, (_, index) => ({
				content: `偏好 ${index}`,
				confidence: 0.9,
			})),
		),
	);
	assert(many.length === MAX_PREFERENCES_PER_TURN, `最多取 ${MAX_PREFERENCES_PER_TURN} 条，实际 ${many.length}`);

	// 10.3 坏输入永不抛
	for (const bad of ["", "   ", "不是 JSON", "[{", "null", "{}", "[1,2,3]"]) {
		assert(parsePreferenceJson(bad).length === 0, `坏输入应返回空数组：${JSON.stringify(bad)}`);
	}

	// 10.4 渲染形状：Why/How 各占一行，超长截断
	const rendered = renderPreference({
		content: "  用户  偏好简洁  ",
		why: "说过两次",
		howToApply: "汇报时先给结论",
		confidence: 0.9,
	});
	assert(rendered.startsWith("用户 偏好简洁\n"), "正文应压空白并换行");
	assert(rendered.includes("Why: 说过两次") && rendered.includes("How: 汇报时先给结论"), "Why/How 段应在");
	const long = renderPreference({ content: "很长".repeat(400), why: "", howToApply: "", confidence: 1 });
	assert(long.length <= 400, `超长应截断到 400 内，实际 ${long.length}`);

	// 10.5 DialogueExtractor（只抽偏好档）：模型给了就落 preference，模型挂了就返回空（绝不抛）
	const engineWithModel = new MemoryEngine({
		store: new InMemoryStore(),
		extractor: new DialogueExtractor(async () =>
			JSON.stringify([{ content: "用户要求以后都先给结论", why: "不喜欢铺垫", howToApply: "回答开头", confidence: 0.95 }]),
		),
	});
	const modelScope: MemoryScope = { type: "session", id: "pref-model" };
	const prefResult = await engineWithModel.ingestTurn(
		[{ role: "user", content: "以后都先给结论，别铺垫了，我不喜欢" }],
		modelScope,
		{ preferenceScope: { type: "global" } },
	);
	assert(prefResult.added.length === 1, `应落 1 条偏好，实际 ${prefResult.added.length}`);
	assert(prefResult.added[0]!.kind === "preference", "kind 应为 preference");
	assert(prefResult.added[0]!.scope === "global", `偏好应重挂到 global，实际 ${prefResult.added[0]!.scope}`);
	assert(prefResult.added[0]!.source === "extract:preference", "来源应可辨认");

	const engineNoModel = new MemoryEngine({
		store: new InMemoryStore(),
		extractor: new DialogueExtractor(async () => {
			throw new Error("上游 500");
		}),
	});
	const failed = await engineNoModel.ingestTurn([{ role: "user", content: "随便说点什么内容" }], modelScope);
	assert(failed.added.length === 0, "模型失败时应静默返回空，不得抛错");

	// 10.6 不传 preferenceScope = 全部落本会话（旧行为）
	const enginePlain = new MemoryEngine({ store: new InMemoryStore() });
	const plain = await enginePlain.ingestTurn(turn1, scope);
	assert(plain.added.every((r) => r.scope === scopeKey(scope)), "不传时 scope 不变");
	assert(plain.added.every((r) => r.kind === "episode"), "不传时仍是旧行为：一律 episode");

	// 10.7 NoopExtractor 仍是"什么都不抽"
	const noopEngine = new MemoryEngine({ store: new InMemoryStore(), extractor: new NoopExtractor() });
	const noop = await noopEngine.ingestTurn(turn1, scope);
	assert(noop.added.length === 0, "Noop 应一条都不抽");

	// 10.8 注入分组：偏好排在前、单独成段；没有偏好时逐字节等同旧形状
	const injectEngine = new MemoryEngine({ store: new InMemoryStore() });
	injectEngine.remember({ kind: "preference", scope: { type: "global" }, content: "用户不喜欢被追问太多" });
	injectEngine.remember({ kind: "episode", scope: { type: "global" }, content: "今天面试挂了" });
	const ctx = injectEngine.buildContext({ text: "追问 面试", scopes: ["global"], limit: 5 });
	assert(ctx.includes("【用户偏好】"), "有偏好时应出现偏好段");
	assert(ctx.indexOf("【用户偏好】") < ctx.indexOf("不喜欢被追问"), "偏好段应在条目之前");
	assert(ctx.indexOf("【用户偏好】") < ctx.indexOf("【其它】"), "偏好段应排在其它之前");

	const onlyEpisode = new MemoryEngine({ store: new InMemoryStore() });
	onlyEpisode.remember({ kind: "episode", scope: { type: "global" }, content: "今天面试挂了" });
	const plainCtx = onlyEpisode.buildContext({ text: "面试", scopes: ["global"] });
	assert(!plainCtx.includes("【"), "没有偏好时不应出现分组标题（保持旧形状）");
	assert(plainCtx.includes("- [episode] 今天面试挂了"), "旧形状的条目行不变");

	// 10.9 取代与删除
	const lifeEngine = new MemoryEngine({ store: new InMemoryStore() });
	const old = lifeEngine.remember({ kind: "fact", scope: { type: "global" }, content: "我住在北京" });
	const fresh = lifeEngine.remember({ kind: "fact", scope: { type: "global" }, content: "我搬到上海了" });
	assert(lifeEngine.supersede(old.id, fresh.id)?.supersededBy === fresh.id, "取代应写回 supersededBy");
	assert(
		!lifeEngine.recall({ text: "北京 上海", scopes: ["global"], limit: 10 }).some((h) => h.record.id === old.id),
		"被取代的记录不应再进召回",
	);
	const withHistory = lifeEngine.list({ scopes: ["global"], includeSuperseded: true });
	assert(withHistory.some((r) => r.id === old.id), "历史链仍可查（includeSuperseded）");
	assert(lifeEngine.supersede(old.id, "不存在的-id") === null, "替代者不存在时应拒绝");
	assert(lifeEngine.supersede(old.id, old.id) === null, "不能取代自己");
	assert(lifeEngine.forget(fresh.id), "删除应返回 true");
	assert(!lifeEngine.forget(fresh.id), "重复删除应返回 false");
	assert(!lifeEngine.recall({ text: "上海", scopes: ["global"] }).some((h) => h.record.id === fresh.id), "删除后不再召回");

	// 10.10 list 分组：偏好最前，组内按时间倒序
	const listEngine = new MemoryEngine({ store: new InMemoryStore() });
	listEngine.remember({ kind: "episode", scope: { type: "global" }, content: "较早的经历" });
	listEngine.remember({ kind: "fact", scope: { type: "global" }, content: "一个事实" });
	listEngine.remember({ kind: "preference", scope: { type: "global" }, content: "一个偏好" });
	const listed = listEngine.list({ scopes: ["global"] });
	assert(listed[0]!.kind === "preference", `列表首条应是偏好，实际 ${listed[0]!.kind}`);
	assert(listed.map((r) => r.kind).join(",") === "preference,fact,episode", `分组顺序不对：${listed.map((r) => r.kind)}`);

	console.log("✓ 偏好抽取 / 注入分组 / 取代删除 / 列表分组 全部通过");
}

// ── 11. 会话记忆封顶修剪（2026-11-07，扫尾批 1 §四）────────
// 策略：session / partner: 前缀的 scope 按 cap 封顶，最旧优先删；
// 保护 preference 与被 supersededBy 引用的行；global 永不自动删；cap=0 一行回滚。
// 两种 store 都跑一遍，保证内存夹具与生产 SQLite 行为一致。
{
  const base = Date.now() - 300_000;
  const at = (index: number) => new Date(base + index * 1000).toISOString();

  function seed(
    store: InMemoryStore | SqliteMemoryStore,
    scope: string,
    count: number,
    overrides: (index: number) => Partial<MemoryRecord> = () => ({}),
  ): string[] {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = `${scope}-${index}`;
      ids.push(id);
      store.put(seedRecord(id, scope, `第 ${index} 条记录`, at(index), overrides(index)));
    }
    return ids;
  }

  function suite(name: string, make: () => InMemoryStore | SqliteMemoryStore): void {
    const store = make();
    const engine = new MemoryEngine({ store });

    // 11.1 超限删旧：10 条剪到 4，删掉的必须是最旧 6 条
    const old = seed(store, "session:prune-old", 10);
    const removed = store.pruneOldest("session:prune-old", 4, {
      protectKinds: ["preference"],
      protectReferenced: true,
    });
    assert(removed === 6, `超限应删 6 条，实际 ${removed}`);
    assert(store.countByScope("session:prune-old") === 4, `剪完应剩 4 条，实际 ${store.countByScope("session:prune-old")}`);
    for (let i = 0; i < 6; i += 1) assert(store.get(old[i]) === undefined, `最旧第 ${i} 条应被删`);
    for (let i = 6; i < 10; i += 1) assert(store.get(old[i]), `较新第 ${i} 条应保留`);

    // 11.2 偏好不删：最旧一条是 preference，必须留下
    const pref = seed(store, "session:prune-pref", 10, (index) =>
      index === 0 ? { kind: "preference" } : {},
    );
    store.pruneOldest("session:prune-pref", 4, {
      protectKinds: ["preference"],
      protectReferenced: true,
    });
    assert(store.get(pref[0]) !== undefined, "preference 不能被修剪");
    assert(store.countByScope("session:prune-pref") === 4, "偏好占名额后仍剪到 4 条");

    // 11.3 被引用不删：最新一条 supersededBy 指向最旧一条 → 最旧那条要留
    const ref = seed(store, "session:prune-ref", 10);
    store.patch(ref[9], { supersededBy: ref[0] });
    store.pruneOldest("session:prune-ref", 4, {
      protectKinds: ["preference"],
      protectReferenced: true,
    });
    assert(store.get(ref[0]) !== undefined, "被 supersededBy 引用的行不能被删");

    // 11.4 cap=0 不动（engine 层一行回滚）
    const before = store.count();
    assert(engine.pruneSessionScopes(0) === 0, "cap=0 应返回 0（完全不修剪）");
    assert(store.count() === before, "cap=0 后总条数不变");

    // 11.5 global 不动：store 拒绝修剪（抛错）+ engine 修剪时 global 一条不删
    const globalIds = seed(store, "global", 3);
    let globalRejected = false;
    try {
      store.pruneOldest("global", 4, { protectKinds: ["preference"] });
    } catch {
      globalRejected = true;
    }
    assert(globalRejected, "pruneOldest('global') 应拒绝修剪（断言抛错）");
    engine.pruneSessionScopes(4);
    assert(store.countByScope("global") === 3, "global 三条一条不删");
    for (const id of globalIds) assert(store.get(id), "global 记录仍在");

    // 11.6 engine 装配确实修剪 session / partner: 前缀 scope
    const wired = seed(store, "session:prune-engine", 9);
    const enginePruned = engine.pruneSessionScopes(4);
    assert(enginePruned >= 5, `engine 应至少删 5 条，实际 ${enginePruned}`);
    assert(store.countByScope("session:prune-engine") === 4, "engine 把 9 条剪到 4");
    assert(store.get(wired[0]) === undefined, "engine 同样按最旧优先");
    seed(store, "partner:abc", 7);
    engine.pruneSessionScopes(4);
    assert(store.countByScope("partner:abc") === 4, "partner: 前缀 scope 也纳入修剪");

    store.close();
    console.log(`✓ 会话记忆封顶修剪（${name}）：删旧 / 保偏好 / 保被引用 / cap=0 不动 / global 不动`);
  }

  suite("InMemoryStore", () => new InMemoryStore());
  suite("SqliteMemoryStore", () => new SqliteMemoryStore(":memory:"));
}

// ── 12. 确定性巩固升级（2026-11-08 扫尾批 6 §一）──────────────
// 规则 1 从"原始全等"升级为"规范化全等"：trim / 空白折叠 / 全半角统一 / 句末标点剥除。
// 边界也要一起测：kind 不同不合并（那是两种用途），措辞不同不合并（那是模型建议的事）。
{
	const store = new InMemoryStore();
	const consolidator = new BasicConsolidator();
	const at = new Date("2026-11-08T00:00:00.000Z");
	const candidate = (content: string, kind: MemoryCandidate["kind"] = "fact"): MemoryCandidate => ({
		kind,
		scope: "global",
		content,
		importance: 0.5,
		veracity: "stated",
		source: "user",
	});

	assert(
		normalizeContent("  今天 在上海\n吃了小笼包。  ") === "今天 在上海 吃了小笼包",
		`规范化应折叠空白并剥句末标点，实际 ${JSON.stringify(normalizeContent("  今天 在上海\n吃了小笼包。  "))}`,
	);
	assert(normalizeContent("ＯＫ　１２，１３。") === "OK 12,13", "全角应收成半角");

	const first = consolidator.consolidate([candidate("今天在上海吃了小笼包")], store, at);
	assert(first.added.length === 1, `首条应入库，实际 ${first.added.length}`);

	const variants = [
		"今天在上海吃了小笼包。",
		"今天在上海吃了小笼包！",
		"  今天在上海吃了小笼包  ",
		"今天在上海吃了小笼包\n",
	];
	const merged = consolidator.consolidate(variants.map((text) => candidate(text)), store, at);
	assert(merged.added.length === 0, `规范化等价的变体不应新增，实际新增 ${merged.added.length}`);
	assert(merged.reinforced.length === variants.length, "规范化等价的变体都该转为强化");
	assert(
		Math.abs(store.get(first.added[0]!.id)!.importance - 0.5 - 0.1 * variants.length) < 1e-9,
		"每次强化 importance +0.1",
	);

	// kind 不同 → 不是同一条（偏好 vs 经历，正文撞车也不合并）
	const otherKind = consolidator.consolidate(
		[candidate("今天在上海吃了小笼包", "episode")],
		store,
		at,
	);
	assert(otherKind.added.length === 1, "kind 不同应各自入库");

	// 措辞不同 → 不合并（语义交给模型建议制，D18）
	const rephrased = consolidator.consolidate(
		[candidate("我在上海吃了小笼包")],
		store,
		at,
	);
	assert(rephrased.added.length === 1, "措辞不同不应被确定性规则合并");

	console.log(
		`✓ 确定性巩固：规范化变体 ${variants.length} 条转强化；kind / 措辞不同不合并`,
	);
}

// ── 13. 时间衰减与使用强化（2026-11-08 扫尾批 6 §一）──────────
// 日期推进用注入时钟（不 sleep）。两个性质最关键：
//   1. 衰减从 lastRecallAt ?? createdAt 起算，且写回时锚点跟着值走 —— 不重复衰减；
//   2. 下限 0.1 永不归零、永不删除；daily=0 一行回滚。
{
	const DAY = 86_400_000;
	const base = new Date("2026-01-01T00:00:00.000Z");
	const later = new Date(base.getTime() + 100 * DAY);

	// 13.1 纯函数：100 天、0.99 → 0.8 * 0.99^100
	const expected = 0.8 * Math.pow(0.99, 100);
	const decayed = decayedImportance(0.8, base.toISOString(), later, 0.99);
	assert(Math.abs(decayed - expected) < 1e-9, `衰减应等于 0.8*0.99^100，实际 ${decayed}`);

	// 13.2 下限 0.1：再怎么久也不归零
	const floor = decayedImportance(1, base.toISOString(), new Date(base.getTime() + 100_000 * DAY), 0.99);
	assert(floor === 0.1, `衰减下限应为 0.1，实际 ${floor}`);
	assert(decayedImportance(0.0001, base.toISOString(), later, 0.5) === 0.1, "初始就低于下限的值也抬到 0.1");

	// 13.3 关闭：daily=0 原值返回（不衰减也不改数）
	assert(decayedImportance(0.8, base.toISOString(), later, 0) === 0.8, "daily=0 不衰减");
	assert(decayedImportance(0.8, null, later, 0.99) === 0.8, "锚点解析不了时原值返回");

	// 13.4 使用强化封顶
	assert(reinforcedImportance(0.5) === 0.55, "命中一次 +0.05");
	assert(reinforcedImportance(IMPORTANCE_CEIL - 0.01) === IMPORTANCE_CEIL, "强化封顶 10");

	// 13.5 引擎链路：读时衰减 + 写回 + 不重复衰减
	const store = new InMemoryStore();
	let clock = base;
	const engine = new MemoryEngine({ store, decayDaily: 0.99, now: () => clock });
	const record = engine.remember({
		kind: "fact",
		scope: { type: "global" },
		content: "很久以前说过的一件事",
		importance: 0.8,
	});

	clock = later;
	engine.recall({ text: "很久以前 一件事", scopes: ["global"], limit: 5 });
	const afterFirst = store.get(record.id)!;
	assert(
		Math.abs(afterFirst.importance - (expected + 0.05)) < 1e-9,
		`100 天后召回应先衰减再 +0.05，实际 ${afterFirst.importance}`,
	);
	assert(afterFirst.lastRecalledAt === later.toISOString(), "写回时锚点应推到 now");
	assert(afterFirst.recallCount === 1, "召回次数照旧 +1");

	// 同一时刻再召回：从新锚点（now）起算，近似只加 0.05，而不是再乘一次 0.99^100
	engine.recall({ text: "很久以前 一件事", scopes: ["global"], limit: 5 });
	const afterSecond = store.get(record.id)!;
	assert(
		Math.abs(afterSecond.importance - (expected + 0.1)) < 1e-6,
		`连续召回不应重复衰减，实际 ${afterSecond.importance}`,
	);

	// 13.6 daily=0（回滚）：只强化、不衰减
	const rollbackStore = new InMemoryStore();
	let rollbackClock = base;
	const rollback = new MemoryEngine({
		store: rollbackStore,
		decayDaily: 0,
		now: () => rollbackClock,
	});
	const kept = rollback.remember({
		kind: "fact",
		scope: { type: "global" },
		content: "回滚档下的一条记忆",
		importance: 0.6,
	});
	rollbackClock = later;
	rollback.recall({ text: "回滚档", scopes: ["global"], limit: 5 });
	assert(
		Math.abs(rollbackStore.get(kept.id)!.importance - 0.65) < 1e-9,
		"daily=0 时只做 +0.05，不衰减",
	);

	console.log("✓ 时间衰减 / 使用强化：下限 0.1、封顶 10、daily=0 回滚、不重复衰减");
}

// ── 14. 已存记忆导入（2026-11-08 扫尾批 6 §三）──────────────
// 只增不改：规范化等价跳过并计数，已有记录一个字段都不动。
{
	const store = new InMemoryStore();
	const at = new Date("2026-11-08T00:00:00.000Z");
	const engine = new MemoryEngine({ store, now: () => at });
	const existing = engine.remember({
		kind: "fact",
		scope: { type: "global" },
		content: "我住在上海",
		importance: 0.7,
	});

	const result = engine.importItems({
		scope: { type: "global" },
		items: [
			{ text: "我住在上海。" }, // 规范化等价 → 跳过
			{ text: "我养了一只猫" }, // 新增
			{ text: "我养了一只猫！" }, // 批内重复 → 跳过
			{ text: "   " }, // 空文本 → 跳过
			{ text: "认不出的类型", kind: "nonsense" }, // 坏 kind → 跳过
			{
				text: "有一次去了杭州",
				kind: "episode",
				createdAt: "2023-05-01T00:00:00.000Z",
				importance: 0.9,
			},
		],
	});

	assert(result.total === 6, `total 应为 6，实际 ${result.total}`);
	assert(result.added.length === 2, `应新增 2 条，实际 ${result.added.length}`);
	assert(result.skipped === 4, `应跳过 4 条，实际 ${result.skipped}`);
	assert(
		result.added.every((row) => row.source === "imported" && row.veracity === "imported"),
		"导入记录 source / veracity 应标记为 imported",
	);
	const cat = result.added.find((row) => row.content === "我养了一只猫")!;
	assert(cat.importance === 0.5, `缺省 importance 应为 0.5，实际 ${cat.importance}`);
	const trip = result.added.find((row) => row.kind === "episode")!;
	assert(trip.createdAt === "2023-05-01T00:00:00.000Z", "合法 createdAt 应保留");
	assert(trip.importance === 0.9, "显式 importance 应保留");

	// 只增不改：已有那行一个字段都没动
	const untouched = store.get(existing.id)!;
	assert(untouched.importance === 0.7, "导入不得提升已有记录的 importance");
	assert(untouched.content === "我住在上海", "导入不得改写已有正文");

	// 未来时间裁到 now（2099 的记忆会把新近度打爆）
	const future = engine.importItems({
		scope: { type: "global" },
		items: [{ text: "来自未来的记忆", createdAt: "2099-01-01T00:00:00.000Z" }],
	});
	assert(future.added[0]!.createdAt === at.toISOString(), "未来 createdAt 应裁到 now");

	// 已取代的记录也算"已经存在"：不把用户标过时的内容重新捞回来
	const stale = engine.remember({
		kind: "fact",
		scope: { type: "global" },
		content: "这条已经被标过时",
	});
	engine.supersede(stale.id, null);
	const resurrect = engine.importItems({
		scope: { type: "global" },
		items: [{ text: "这条已经被标过时。" }],
	});
	assert(resurrect.added.length === 0 && resurrect.skipped === 1, "被取代的内容不应被导入复活");

	console.log("✓ 导入：只增不改、规范化跳过 / 批内去重 / 坏 kind 跳过 / source=imported");
}

// ── 15. work 履历（2026-11-08 刀二 E2）────────────────
// work = append-only 台账：不合并、不衰减、召回默认排除、按 scope 封顶、
// 只走结构化查询。两种 store 都跑一遍（与 §11 同款）。
{
	const at = new Date("2026-11-08T00:00:00.000Z");
	const workScope = scopeKey({ type: "partner", id: "11111111-1111-4111-8111-111111111111" });

	function seedWork(
		store: InMemoryStore | SqliteMemoryStore,
		scope: string,
		kind: MemoryRecord["kind"],
		content: string,
		createdAt: string,
		importance = 0.5,
	): MemoryRecord {
		const record: MemoryRecord = {
			id: `work-${scope}-${content}-${createdAt}`,
			kind,
			scope,
			content,
			importance,
			veracity: "stated",
			source: "work",
			createdAt,
			validUntil: null,
			supersededBy: null,
			recallCount: 0,
			lastRecalledAt: null,
		};
		store.put(record);
		return record;
	}

	// 15.1 写入 + 不合并：work 候选一律 append（同正文也不强化）；非 work 撞 work 正文也不合并。
	{
		const store = new InMemoryStore();
		const consolidator = new BasicConsolidator();
		const candidate = (
			content: string,
			kind: MemoryCandidate["kind"] = "work",
		): MemoryCandidate => ({
			kind,
			scope: workScope,
			content,
			importance: 0.5,
			veracity: "stated",
			source: "work",
		});
		const first = consolidator.consolidate([candidate("整理纪要")], store, at);
		assert(first.added.length === 1 && first.added[0]!.kind === "work", "work 候选应直接入库");
		const second = consolidator.consolidate(
			[candidate("整理纪要。"), candidate("整理纪要！")],
			store,
			at,
		);
		assert(second.added.length === 2, `work 同正文也各记一条，实际新增 ${second.added.length}`);
		assert(second.reinforced.length === 0, "work 不强化");
		assert(store.countByScope(workScope) === 3, "三条履历都在");
		const cross = consolidator.consolidate([candidate("整理纪要", "episode")], store, at);
		assert(cross.added.length === 1, "非 work 撞 work 正文照常入库（kind 不同）");
	}

	// 15.2 不衰减 + 召回排除：衰减开着、推进 100 天，work 不进召回且一个字段都不动。
	{
		const store = new InMemoryStore();
		let clock = at;
		const engine = new MemoryEngine({ store, decayDaily: 0.99, now: () => clock });
		const work = seedWork(
			store,
			workScope,
			"work",
			"T-1｜整理纪要｜终态=done｜完成",
			at.toISOString(),
			0.8,
		);
		seedWork(store, workScope, "fact", "普通事实", at.toISOString(), 0.8);
		clock = new Date(at.getTime() + 100 * 86_400_000);
		const hits = engine.recall({ text: "整理纪要 普通事实", scopes: [workScope], limit: 10 });
		assert(hits.every((hit) => hit.record.kind !== "work"), "work 不进召回");
		assert(hits.some((hit) => hit.record.kind === "fact"), "普通记忆照常召回");
		const untouched = store.get(work.id)!;
		assert(untouched.importance === 0.8, "work importance 不被衰减 / 强化");
		assert(
			untouched.recallCount === 0 && untouched.lastRecalledAt === null,
			"work 不写回召回信息",
		);
	}

	// 15.3 结构化查询：按 scope+kind 取最近 N 条，created_at 倒序。
	{
		const store = new InMemoryStore();
		for (let index = 0; index < 5; index += 1) {
			seedWork(
				store,
				workScope,
				"work",
				`T-${index}｜任务｜终态=done｜完成`,
				new Date(at.getTime() + index * 1000).toISOString(),
			);
		}
		seedWork(store, workScope, "fact", "不是履历", new Date(at.getTime() + 9999 * 1000).toISOString());
		const rows = store.search({ scopes: [workScope], kinds: ["work"], limit: 3 });
		assert(rows.length === 3, "limit 生效");
		assert(rows.every((row) => row.kind === "work"), "只返回 work");
		assert(
			rows[0]!.content.includes("T-4") && rows[2]!.content.includes("T-2"),
			"按时间倒序",
		);
	}

	// 15.4 cap 修剪：work 按 scope 封顶、超出删最旧；非 work 一条不动；不传 kinds 回到旧行为。
	function capSuite(name: string, make: () => InMemoryStore | SqliteMemoryStore): void {
		const store = make();
		const base = at.getTime();
		for (let index = 0; index < 5; index += 1) {
			seedWork(
				store,
				"session:work-cap",
				"work",
				`第 ${index} 单`,
				new Date(base + index * 1000).toISOString(),
			);
		}
		// 最旧的一条，但不是 work：kind 专属修剪绝不能碰它。
		seedWork(store, "session:work-cap", "fact", "普通事实", new Date(base - 1000).toISOString());
		const removed = store.pruneOldest("session:work-cap", 3, { kinds: ["work"] });
		assert(removed === 2, `${name}: 5 条 work 剪到 3 应删 2，实际 ${removed}`);
		const rows = store.search({
			scopes: ["session:work-cap"],
			includeSuperseded: true,
			limit: 100,
		});
		assert(rows.filter((row) => row.kind === "work").length === 3, `${name}: 剩 3 条 work`);
		assert(
			rows.some((row) => row.kind === "fact" && row.content === "普通事实"),
			`${name}: 非 work 一条不删`,
		);
		assert(
			rows
				.filter((row) => row.kind === "work")
				.every((row) => row.content !== "第 0 单" && row.content !== "第 1 单"),
			`${name}: 删的是最旧`,
		);
		// 不传 kinds = 改动前行为：按整个 scope 计数（4 条剪到 2 → 删 2）。
		assert(store.pruneOldest("session:work-cap", 2) === 2, `${name}: 不传 kinds 回到整体封顶`);
		store.close();
		console.log(`✓ work cap 修剪（${name}）：kind 专属删旧 / 非 work 不动 / 不传 kinds 旧行为`);
	}
	capSuite("InMemoryStore", () => new InMemoryStore());
	capSuite("SqliteMemoryStore", () => new SqliteMemoryStore(":memory:"));

	// 15.5 导入跳过 work：IMPORT_KINDS 不含 work，导入通道不许伪造履历。
	{
		const store = new InMemoryStore();
		const engine = new MemoryEngine({ store, now: () => at });
		const outcome = engine.importItems({
			scope: { type: "partner", id: "22222222-2222-4222-8222-222222222222" },
			items: [
				{ text: "伪造的履历", kind: "work" },
				{ text: "正常事实", kind: "fact" },
			],
		});
		assert(
			outcome.added.length === 1 && outcome.added[0]!.kind === "fact",
			"work 导入应被跳过",
		);
		assert(outcome.skipped === 1, "work 导入计入 skipped");
	}

	console.log("✓ work 履历：写入 / 不合并不衰减 / cap 修剪 / 召回排除 / 结构化查询 / 导入跳过");
}

// ── 16. 凭据打码（2026-11-09 T4 §2）──────────────────────
// 纯函数正反例 + 唯一收口点（store.put）+ 开关旁路。
{
	const positives: Array<[string, string]> = [
		["sk- 形态", "我的 key 是 sk-abcdefgh12345678，别外传"],
		["Bearer", "Authorization: Bearer abcdefgh12345678"],
		["api_key=", "配置里 api_key=abcdef123456"],
		["api-key:", "api-key: abcdef123456"],
		["token:", "token: abcdef123456"],
		["password=", "password=abc12345"],
		["passwd:", "passwd: abc12345"],
		["中文密码", "密码：abc12345"],
		["中文密钥", "密钥=abc12345"],
		["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
		["长 hex", "编号 550e8400e29b41d4a716446655440000550e8400e29b41d4a716446655440000"],
		["长 base64", "凭条 QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo5ODc2NTQ="],
		["github_pat", "github_pat_11ABCDEFG0123456789"],
		["ghp_", "ghp_abcdefgh12345678"],
	];
	for (const [label, text] of positives) {
		const out = redactSecrets(text);
		assert(out.includes(REDACTED), `${label} 应被打码：${out}`);
	}
	// 值本身必须消失，不能只加一个占位符
	assert(
		!redactSecrets("我的 key 是 sk-abcdefgh12345678").includes("abcdefgh12345678"),
		"sk- 的值不应残留",
	);
	assert(
		!redactSecrets("密码：abc12345，别告诉别人").includes("abc12345"),
		"中文密码的值不应残留",
	);
	assert(redactSecrets("密码：abc12345，别告诉别人").includes("密码："), "字段名应保留（读得懂）");

	// ── 校验位规则（2026-11-10 批 21 §五）──────────────────
	// 银行卡：16 位连续数字 + Luhn（≥8 个正例，含首尾边界与大小写/标点）
	const cardPositives: Array<[string, string]> = [
		["Visa 测试卡", "卡号 4111111111111111，请记一下"],
		["Mastercard 测试卡", "5500005555555559"],
		["普通 Luhn 通过的 16 位", "账号是 1234567890123452 谢谢"],
		["文本开头", "4539578763621486 是我的卡"],
		["文本结尾", "备用卡 6011000990139424"],
		["句中标点包围", "付款用（5500005555555559）。"],
		["身份证 18 位（末位数字）", "身份证 440524188001010014"],
		["身份证 18 位（末位 X）", "身份证 11010519491231002X"],
		["身份证 18 位（小写 x）", "身份证号 11010519491231002x。"],
		["卡号与身份证同段", "4111111111111111 / 310101198505050056"],
	];
	for (const [label, text] of cardPositives) {
		assert(redactSecrets(text).includes(REDACTED), `${label} 应被打码：${redactSecrets(text)}`);
	}
	assert(
		!redactSecrets("卡号 4111111111111111，请记一下").includes("4111111111111111"),
		"银行卡号不应残留",
	);
	assert(
		!redactSecrets("身份证 11010519491231002X").includes("11010519491231002X"),
		"身份证号不应残留",
	);
	// 校验函数本身：正例 / 边界
	assert(luhnValid("4111111111111111"), "Visa 测试卡应通过 Luhn");
	assert(luhnValid("5500005555555559"), "Mastercard 测试卡应通过 Luhn");
	assert(luhnValid("0000000000000000") === false, "全 0 虽然数学上过 Luhn，但不是卡号（不当敏感物）");
	assert(!luhnValid("4111111111111112"), "改一位应不通过");
	assert(!luhnValid("411111111111111"), "15 位不是银行卡口径");
	assert(idCardValid("11010519491231002X"), "身份证校验位（X）");
	assert(idCardValid("11010519491231002x"), "小写 x 同样是合法校验位");
	assert(idCardValid("510104199212120031"), "身份证校验位（数字）");
	assert(!idCardValid("110105194912310021"), "校验位错一位应拒绝");

	const negatives = [
		"我的手机号是 13800138000，随时联系",
		"我的生日是 1990-01-01",
		"我住在上海市徐汇区某路 123 号",
		"豆豆是我养的猫，今年三岁",
		"今天整理了三箱旧照片，按年份分好了",
		"这周打算每天走八千步",
		// 校验位规则的"故意放行"（§5.2 / §5.3 反例）
		"生日 19900101 那天拍的",
		"邮编 200030，寄到这个地址",
		"流水号 2026010112304567（16 位，不过 Luhn）",
		"订单 12345678901234567（17 位）",
		"订单 1234567890123456789（19 位）",
		"身份证 110105194912310021（校验位错）",
		"占位数字 0000000000000000 不是卡号",
		"旧卡号 30569309025904（14 位）",
	];
	for (const text of negatives) {
		assert(redactSecrets(text) === text, `不该误伤：${text} → ${redactSecrets(text)}`);
	}

	// 幂等：已打码的内容再过一次不变
	const once = redactSecrets("token: abcdef123456");
	assert(redactSecrets(once) === once, "打码应幂等");

	// 收口点：所有写入方都走 put —— 引擎 remember / 直接 put 一样被打码
	const engine = new MemoryEngine({ store: new InMemoryStore() });
	const remembered = engine.remember({
		kind: "fact",
		scope: { type: "global" },
		content: "我的 api_key=abcdef123456",
	});
	assert(remembered.content.includes(REDACTED), "remember 返回的应是入库后的打码内容");
	assert(engine.getRecord(remembered.id)!.content.includes(REDACTED), "库里应是打码内容");

	// patch 换 content 也打码
	const store = new InMemoryStore();
	store.put(seedRecord("r-1", "global", "普通内容", new Date().toISOString()));
	store.patch("r-1", { content: "token=abcdef123456" });
	assert(store.get("r-1")!.content.includes(REDACTED), "patch 改 content 同样打码");

	// 开关旁路（一行回滚）
	const raw = new InMemoryStore({ redact: false });
	raw.put(seedRecord("r-2", "global", "我的 token=abcdef123456", new Date().toISOString()));
	assert(raw.get("r-2")!.content.includes("abcdef123456"), "redact:false 时应直通");
	assert(memoryRedactEnabled({ MEMORY_REDACT: "false" }) === false, "MEMORY_REDACT=false 关");
	assert(memoryRedactEnabled({ MEMORY_REDACT: "0" }) === false, "MEMORY_REDACT=0 关");
	assert(memoryRedactEnabled({}) === true, "缺省开");

	// ── 校验位敏感号（批 21 §四）：真卡号/真证号必打，普通长数字不误杀 ──
	assert(luhnValid("4111111111111111") === true, "Luhn：标准测试卡应通过");
	assert(luhnValid("1234567812345678") === false, "Luhn：连号应不通过");
	assert(idCardValid("11010519491231002X") === true, "身份证：校验位 X 的样例应通过");
	assert(idCardValid("110105194912310021") === false, "身份证：末位错应不通过");
	assert(
		redactSecrets("卡号 4111111111111111 记一下").includes(REDACTED),
		"Luhn 通过的卡号应被打码",
	);
	assert(
		redactSecrets("身份证 11010519491231002X").includes(REDACTED),
		"校验位通过的身份证应被打码",
	);
	assert(
		redactSecrets("快递单号 1234567812345678 明天到") === "快递单号 1234567812345678 明天到",
		"Luhn 不通过的单号不应误伤",
	);
	assert(
		redactSecrets("旧证号 110105194912310021 是笔误") === "旧证号 110105194912310021 是笔误",
		"校验位不通过的 18 位数字不应误伤",
	);
	assert(
		redactSecrets("我的手机号是 13800138000") === "我的手机号是 13800138000",
		"手机号（11 位）依旧放行",
	);

	console.log(`✓ 凭据打码：${positives.length} 个正例 / ${negatives.length} 个反例 / 校验位敏感号 / 写入收口 / 开关旁路`);
}

// ── 16.5 偏好引文校验（2026-11-10 批 21 §四，七 #31 差半）────────
// 偏好必须能在用户原话里找到依据片段；找不到 = 模型在编，拒收。
{
	// 接地判定的纯函数层
	assert(
		groundedInUserText("用户不喜欢被追问太多", "我真的不喜欢被追问太多，别老问我") === true,
		"转述共享关键短语 → 有依据",
	);
	assert(
		groundedInUserText("用户偏好深色主题", "以后都用中文回复我") === false,
		"原话里没有依据片段 → 编造，拒收",
	);
	assert(
		groundedInUserText("use concise answers", "please give concise answers from now on") === true,
		"西文按整词匹配",
	);
	assert(groundedInUserText("用户喜欢简洁", "") === false, "空原话 = 无从谈起");
	assert(preferenceQuoteCheckEnabled({}) === true, "引文校验缺省开");
	assert(preferenceQuoteCheckEnabled({ MEMORY_EXTRACT_QUOTE_CHECK: "false" }) === false, "开关可关");

	// 抽取器集成：一条接地、一条编造 → 只留接地那条；开关关掉后两条都留
	const messages: ExtractMessage[] = [
		{ role: "user", content: "我真的不喜欢被追问太多，别老问我。以后都用中文回复我。" },
	];
	const generator = async () =>
		JSON.stringify([
			{ content: "用户不喜欢被追问太多", why: "用户明说", howToApply: "汇报一次说清", confidence: 0.9 },
			{ content: "用户偏好深色主题", why: "", howToApply: "", confidence: 0.9 },
		]);
	const groundedOnly = await new DialogueExtractor(generator).extract({
		messages,
		scope: { type: "global" },
		now: new Date(),
	});
	assert(groundedOnly.length === 1, `编造偏好应被拒收（实际 ${groundedOnly.length} 条）`);
	assert(groundedOnly[0]!.content.includes("不喜欢被追问"), "留下的应是接地那条");
	const unfiltered = await new DialogueExtractor(generator).extract({
		messages,
		scope: { type: "global" },
		now: new Date(),
	});
	assert(unfiltered.length >= 1, "开关旁路路径可达");

	console.log("✓ 偏好引文校验：接地判定 / 集成拒收 / 开关旁路");
}

// ── 17. intention 前瞻意图（2026-11-09 T4 §3）────────────
// 三个性质：过期降级不删、未过期优先注入、巩固 / 衰减不碰。
{
	const DAY = 86_400_000;
	const base = new Date("2026-01-01T00:00:00.000Z");
	let clock = base;
	const store = new InMemoryStore();
	const engine = new MemoryEngine({ store, decayDaily: 0.99, now: () => clock });

	const plan = engine.remember({
		kind: "intention",
		scope: { type: "global" },
		content: "我打算下周开始跑步",
		importance: 0.6,
		expiresAt: new Date(base.getTime() + 7 * DAY).toISOString(),
	});
	assert(store.get(plan.id)!.kind === "intention", "写入应是 intention");
	assert(
		store.get(plan.id)!.expiresAt === new Date(base.getTime() + 7 * DAY).toISOString(),
		"expiresAt 应原样落库",
	);

	// 未过期：单独成组，排在普通事实之前
	engine.remember({ kind: "fact", scope: { type: "global" }, content: "今天面试挂了" });
	clock = new Date(base.getTime() + 3 * DAY);
	const freshCtx = engine.buildContext({ text: "跑步 面试", scopes: ["global"], limit: 5 });
	assert(freshCtx.includes("【打算】"), `未过期意图应单独成组：${freshCtx}`);
	assert(
		freshCtx.indexOf("【打算】") < freshCtx.indexOf("【其它】"),
		"意图组应排在其它之前（紧随偏好）",
	);

	// 过期：读时原地降级成 fact，不删记录
	clock = new Date(base.getTime() + 8 * DAY);
	const expiredHits = engine.recall({ text: "跑步 面试", scopes: ["global"], limit: 5 });
	const demoted = expiredHits.find((hit) => hit.record.id === plan.id);
	assert(demoted?.record.kind === "fact", "过期后召回里应是 fact");
	assert(store.get(plan.id)!.kind === "fact", "过期降级应落库（原地改 kind）");
	assert(store.get(plan.id)!.content === "我打算下周开始跑步", "降级不删、不改正文");
	const expiredCtx = engine.buildContext({ text: "跑步 面试", scopes: ["global"], limit: 5 });
	assert(!expiredCtx.includes("【打算】"), "过期后不应再出现在意图组");

	// 无 expiresAt 的 intent 不会自己过期；且不参与时间衰减（100 天后只 +0.05）
	const permanent = engine.remember({
		kind: "intention",
		scope: { type: "global" },
		content: "我打算一直学下去",
		importance: 0.6,
	});
	clock = new Date(base.getTime() + 100 * DAY);
	engine.recall({ text: "学下去", scopes: ["global"], limit: 5 });
	const kept = store.get(permanent.id)!;
	assert(kept.kind === "intention", "没有 expiresAt 的意图不过期");
	assert(
		Math.abs(kept.importance - 0.65) < 1e-9,
		`意图不参与衰减，只 +0.05，实际 ${kept.importance}`,
	);

	// 巩固：同正文的意图不合并、不强化（各自有各自的时间与承诺）
	const cStore = new InMemoryStore();
	const consolidator = new BasicConsolidator();
	const candidate = (content: string): MemoryCandidate => ({
		kind: "intention",
		scope: "global",
		content,
		importance: 0.5,
		veracity: "stated",
		source: "user",
		expiresAt: new Date(base.getTime() + 7 * DAY).toISOString(),
	});
	const first = consolidator.consolidate([candidate("我打算学游泳")], cStore, base);
	const second = consolidator.consolidate([candidate("我打算学游泳")], cStore, base);
	assert(first.added.length === 1 && second.added.length === 1, "同正文意图应各记一条");
	assert(second.reinforced.length === 0, "意图不参与合并 / 强化");
	assert(cStore.countByScope("global") === 2, "两条意图都在");
	assert(
		first.added[0]!.expiresAt === new Date(base.getTime() + 7 * DAY).toISOString(),
		"巩固写入应保留 expiresAt",
	);

	console.log("✓ intention：过期降级 / 未过期优先注入 / 不衰减 / 巩固不合并");
}

// ── 18. 经验层 experience（2026-11-10 批 17 §一）────────────
// 四个性质：进召回且权重略高、不参与时间衰减、参与合并、封顶修剪受保护。
{
	const DAY = 86_400_000;
	const base = new Date("2026-01-01T00:00:00.000Z");
	const later = new Date(base.getTime() + 100 * DAY);
	const scope = "partner:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
	const store = new InMemoryStore();

	// 18.1 不衰减：100 天后只 +0.05（与 intention 同待遇）
	store.put(
		seedRecord("x-1", scope, "整理纪要时先读原文件再改，最后跑一遍探针确认", base.toISOString(), {
			kind: "experience",
			importance: 0.8,
		}),
	);
	let clock = later;
	const engine = new MemoryEngine({ store, decayDaily: 0.99, now: () => clock });
	const hits = engine.recall({ text: "整理纪要 探针", scopes: [scope], limit: 5 });
	assert(hits.some((hit) => hit.record.kind === "experience"), "experience 应进召回");
	assert(
		Math.abs(store.get("x-1")!.importance - 0.85) < 1e-9,
		`experience 不参与衰减，只 +0.05，实际 ${store.get("x-1")!.importance}`,
	);

	// 18.2 权重略高于 fact：同正文同重要度同时刻，experience 排前
	const rankStore = new InMemoryStore();
	const at = base.toISOString();
	rankStore.put(seedRecord("r-fact", scope, "同一句话的做法", at, { kind: "fact", importance: 0.6 }));
	rankStore.put(
		seedRecord("r-exp", scope, "同一句话的做法", at, { kind: "experience", importance: 0.6 }),
	);
	const rankHits = new MemoryEngine({ store: rankStore, now: () => base }).recall({
		text: "做法",
		scopes: [scope],
		limit: 5,
	});
	assert(
		rankHits[0]?.record.kind === "experience",
		`同分时 experience 应略高（实际首条 ${rankHits[0]?.record.kind}）`,
	);

	// 18.3 参与合并：同 scope 规范化等价的经验 → 第二条转强化
	const cStore = new InMemoryStore();
	const consolidator = new BasicConsolidator();
	const candidate = (content: string): MemoryCandidate => ({
		kind: "experience",
		scope,
		content,
		importance: 0.6,
		veracity: "tool",
		source: "work",
	});
	const first = consolidator.consolidate([candidate("先读原文件再改，最后跑探针")], cStore, base);
	const second = consolidator.consolidate([candidate("先读原文件再改，最后跑探针。")], cStore, base);
	assert(first.added.length === 1 && second.added.length === 0, "经验重复应合并而不是新增");
	assert(second.reinforced.length === 1, "经验重复应转为强化");

	// 18.4 会话封顶修剪保护 experience
	const pruneStore = new InMemoryStore();
	for (let index = 0; index < 10; index += 1) {
		pruneStore.put(
			seedRecord(`p-${index}`, "session:exp-cap", `第 ${index} 条`, new Date(base.getTime() + index * 1000).toISOString(), {
				kind: index === 0 ? "experience" : "fact",
			}),
		);
	}
	new MemoryEngine({ store: pruneStore }).pruneSessionScopes(4);
	assert(pruneStore.get("p-0") !== undefined, "experience 不应被会话封顶静默删掉");

	console.log("✓ experience：进召回（权重略高）/ 不衰减 / 参与合并 / 封顶受保护");
}

// ── 19. 主动提起分组（2026-11-10 批 17 §二）──────────────
// 高重要度 + 超 7 天未召回 + 与当前话题无关键词交集 → 「也许值得提起」；
// 最多 2 条、每条 ≤80 字、默认不渲染（开关旁路）。
{
	const DAY = 86_400_000;
	const at = new Date("2026-06-01T00:00:00.000Z");
	const ago = (days: number) => new Date(at.getTime() - days * DAY).toISOString();
	const store = new InMemoryStore();
	store.put(
		seedRecord("h-1", "global", "去年在青岛看过一次日出，风很大但很值", ago(30), {
			importance: 0.8,
		}),
	);
	store.put(
		seedRecord("h-2", "global", "小时候住的老院子有一棵石榴树", ago(60), { importance: 0.9 }),
	);
	store.put(
		seedRecord("h-3", "global", "那次修车师傅说电瓶该换了，后来果然打不着火", ago(90), {
			importance: 0.75,
		}),
	);
	store.put(
		seedRecord("h-new", "global", "今天刚记下的一件事，跟话题无关", ago(0), { importance: 0.95 }),
	);
	store.put(
		seedRecord("h-low", "global", "很久以前的一条低重要度记录", ago(120), { importance: 0.3 }),
	);
	store.put(
		seedRecord("h-rel", "global", "跑步膝盖疼的时候先歇两天再拉伸", ago(30), { importance: 0.8 }),
	);
	store.put(
		seedRecord("h-long", "global", `这是一条很长的旧记忆${"补充".repeat(60)}`, ago(45), {
			importance: 0.85,
		}),
	);
	const engine = new MemoryEngine({ store, now: () => at });

	const ctx = engine.buildContext(
		{ text: "跑步 拉伸", scopes: ["global"], limit: 20 },
		{ proactive: true, maxChars: 4000 },
	);
	const group = ctx.split("【也许值得提起】")[1] ?? "";
	assert(group.length > 0, `主动提起组应出现：${ctx}`);
	const items = group
		.split("\n")
		.filter((line) => line.startsWith("- "))
		.slice(0, 10);
	assert(items.length === 2, `主动提起组最多 2 条，实际 ${items.length}`);
	assert(!group.includes("今天刚记下"), "新记忆不进主动提起组");
	assert(
		group.split("\n").filter((line) => line.startsWith("- ")).every((line) => line.length <= 90),
		"每条主动提起应 ≤80 字（加 kind 前缀不超过 90）",
	);
	assert(!group.includes("跑步膝盖疼"), "与当前话题直接相关的记忆不该进主动提起组");

	// 默认不渲染（开关旁路）：不传 proactive 时逐字节回到三组形状
	const plain = engine.buildContext({ text: "跑步 拉伸", scopes: ["global"], limit: 20 });
	assert(!plain.includes("【也许值得提起】"), "默认关闭：不出现主动提起组");

	console.log("✓ 主动提起：旧高重要度进组 / 新记忆不进 / 最多 2 条 / 每条 ≤80 字 / 默认关闭");
}

// ── 20. 巩固审计（2026-11-10 批 17 §三）──────────────────
// usage 排序决定保留优先级；未用淘汰只列不删；usageRanking=false 一行回滚。
{
	const DAY = 86_400_000;
	const now = new Date("2026-06-01T00:00:00.000Z");
	const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
	const store = new InMemoryStore();
	store.put(
		seedRecord("c-keep", "global", "同一句重复的事实", ago(10), {
			usageCount: 5,
			lastUsedAt: ago(1),
		}),
	);
	store.put(
		seedRecord("c-drop", "global", "同一句重复的事实。", ago(1), {
			usageCount: 1,
			lastUsedAt: ago(20),
		}),
	);
	store.put(
		seedRecord("c-stale", "global", "很久以前的一条低价值记录", ago(200), {
			importance: 0.3,
			usageCount: 0,
			lastUsedAt: null,
		}),
	);
	store.put(
		seedRecord("c-pref", "global", "低重要度偏好", ago(200), {
			kind: "preference",
			importance: 0.2,
		}),
	);
	store.put(
		seedRecord("c-exp", "global", "低重要度经验", ago(200), {
			kind: "experience",
			importance: 0.2,
		}),
	);
	store.put(
		seedRecord("c-work", "global", "低重要度履历", ago(200), {
			kind: "work",
			importance: 0.2,
		}),
	);
	const total = store.count();

	const diff = consolidateScope(store, "global", { now });
	assert(diff.merged.length === 1, `应给出一条合并建议，实际 ${diff.merged.length}`);
	assert(diff.merged[0]!.keepId === "c-keep", "合并应保留 usage 更高的那条");
	assert(diff.merged[0]!.dropId === "c-drop", "usage 低的进 drop");
	assert(diff.retired.length === 1 && diff.retired[0]!.id === "c-stale", "只建议淘汰久未使用的低重要度条目");
	assert(diff.retired.every((entry) => entry.kind !== "preference"), "偏好不进淘汰建议");
	assert(diff.kept === total - 2, `kept 应为 ${total - 2}，实际 ${diff.kept}`);

	// 只出建议：库一个字段都不动
	assert(store.count() === total, "审计不得删任何一条");
	assert(store.get("c-drop")!.supersededBy === null, "审计不得自动 supersede");

	// usageRanking=false：按创建时间决定保留；不给淘汰建议
	const legacy = consolidateScope(store, "global", { now, usageRanking: false });
	assert(legacy.retired.length === 0, "关掉 usage 排序后不出淘汰建议");
	assert(legacy.merged[0]!.keepId === "c-drop", "关掉 usage 排序后按创建时间保留最新一条");

	// 召回命中即记使用账（usageCount +1）
	const uStore = new InMemoryStore();
	uStore.put(seedRecord("u-1", "global", "一条会被召回的记忆", ago(1), { importance: 0.7 }));
	const uEngine = new MemoryEngine({ store: uStore, now: () => now });
	uEngine.recall({ text: "会 被 召回", scopes: ["global"], limit: 5 });
	assert(uStore.get("u-1")!.usageCount === 1, "召回命中应 usageCount +1");
	assert(uStore.get("u-1")!.lastUsedAt === now.toISOString(), "召回命中应记 lastUsedAt");

	console.log("✓ 巩固审计：usage 排序 / 淘汰只列不删 / usageRanking 回滚 / 使用账 +1");
}

// ── 18. 经验抽取与证据引文（2026-11-10 对标 Anthropic「做梦」）────────
// 两个动作：①对话里"用户纠正过/验证过的做法"落成 experience（与偏好同一管线）；
// ②整理建议回原始对话找证据引文（locateEvidence 纯函数部分在包内测）。
{
	// 18.1 合并解析：{preferences, experiences} 新形状；旧形状逐字节兼容
	const combined = parseExtractionJson(
		'```json\n{"preferences":[{"content":"以后都用中文","confidence":0.9}],"experiences":[{"content":"写周报先给结论","why":"上次被打回来","howToApply":"汇报开头一行结论","confidence":0.85}]}\n```',
	);
	assert(
		combined.preferences.length === 1 && combined.experiences.length === 1,
		"合并形状应两类各解析出 1 条",
	);
	assert(parseExtractionJson('[{"content":"旧形状","confidence":0.9}]').experiences.length === 0, "裸数组 = 只有偏好");
	assert(
		parseExtractionJson('{"preferences":[{"content":"旧形状","confidence":0.9}]}').experiences.length === 0,
		"旧对象形状无经验",
	);
	const solo = parseExtractionJson('{"experiences":[{"content":"只有经验栏也能活","confidence":0.9}]}');
	assert(solo.preferences.length === 0 && solo.experiences.length === 1, "只给经验栏也要能解析");
	for (const bad of ["", "   ", "不是 JSON", "[{", "null", "{}", "[1,2,3]"]) {
		const parsed = parseExtractionJson(bad);
		assert(
			parsed.preferences.length === 0 && parsed.experiences.length === 0,
			`坏输入应返回两类皆空：${JSON.stringify(bad)}`,
		);
	}

	// 18.2 DialogueExtractor：一次调用出两类、偏好在前、经验与偏好同样重挂宽 scope
	const expMessages: ExtractMessage[] = [
		{ role: "user", content: "上次那样汇报被打回来，这回先给结论就过了。以后都这么干，我不喜欢铺垫。" },
	];
	const expGenerator = async () =>
		JSON.stringify({
			preferences: [{ content: "用户要求以后都先给结论", why: "不喜欢铺垫", howToApply: "回答开头", confidence: 0.9 }],
			experiences: [{ content: "汇报先给结论", why: "上次被打回", howToApply: "回答开头一行", confidence: 0.85 }],
		});
	const expEngine = new MemoryEngine({
		store: new InMemoryStore(),
		extractor: new DialogueExtractor(expGenerator, { experience: true }),
	});
	const expResult = await expEngine.ingestTurn(expMessages, { type: "session", id: "exp" }, {
		preferenceScope: { type: "global" },
	});
	const kinds = expResult.added.map((record) => record.kind);
	assert(kinds.includes("preference") && kinds.includes("experience"), `应两类都落库，实际 ${kinds.join("/")}`);
	assert(kinds[0] === "preference", "偏好应排在经验前面（巩固层同段话偏好优先占位）");
	const experience = expResult.added.find((record) => record.kind === "experience")!;
	assert(experience.scope === "global", `经验应与偏好同样重挂 global，实际 ${experience.scope}`);
	assert(experience.source === "extract:experience", "经验来源应可辨认");
	assert(experience.veracity === "stated", "经验是用户自己说的");
	assert(experience.content.includes("Why: ") && experience.content.includes("How: "), "经验正文应带 Why/How 段");

	// 18.3 关掉经验：提示词逐字节回旧形态，解析出的经验栏整段丢弃
	assert(extractionPrompt(false) === PREFERENCE_PROMPT, "关经验 = 发旧偏好提示词（逐字节）");
	assert(extractionPrompt(true) !== PREFERENCE_PROMPT, "开经验 = 发合并提示词");
	const noExp = await new DialogueExtractor(expGenerator, { experience: false }).extract({
		messages: expMessages,
		scope: { type: "global" },
		now: new Date(),
	});
	assert(noExp.every((candidate) => candidate.kind === "preference"), "关掉后经验栏整段丢弃");
	assert(noExp.length === 1, `偏好照抽，实际 ${noExp.length} 条`);

	// 18.4 经验同样过引文校验：用户原话里找不到依据的"经验"不入库（宁拒勿收）
	const fabricated = await new DialogueExtractor(
		async () =>
			JSON.stringify({ preferences: [], experiences: [{ content: "用户偏好深色主题", confidence: 0.9 }] }),
		{ experience: true },
	).extract({ messages: expMessages, scope: { type: "global" }, now: new Date() });
	assert(fabricated.length === 0, "编造的经验应被引文校验拒收");

	// 18.5 经验上限与开关
	const capped = parseExtractionJson(
		JSON.stringify({
			experiences: Array.from({ length: MAX_EXPERIENCES_PER_TURN + 2 }, (_, index) => ({
				content: `经验 ${index}`,
				confidence: 0.9,
			})),
		}),
	);
	assert(capped.experiences.length === MAX_EXPERIENCES_PER_TURN, `经验最多 ${MAX_EXPERIENCES_PER_TURN} 条`);
	assert(experienceExtractionEnabled({} as NodeJS.ProcessEnv) === true, "缺省 = 开");
	assert(
		experienceExtractionEnabled({ MEMORY_EXTRACT_EXPERIENCE: "false" } as unknown as NodeJS.ProcessEnv) === false,
		"MEMORY_EXTRACT_EXPERIENCE=false = 关",
	);

	console.log("✓ 经验抽取：合并解析 / 一次调用两类 / 重挂 / 开关回滚 / 引文校验 / 上限");

	// 18.6 locateEvidence：逐字命中（episode）、转述命中（4 字锚点）、未命中、截断、标点容忍
	const dialogue =
		"用户：我今天把周报改成先写结论了，上次那样被领导打回来过，先给结论之后一次就过了。";
	const verbatim = locateEvidence(dialogue, "今天把周报改成先写结论了");
	assert(verbatim !== null && verbatim.includes("先写结论"), "episode 逐字句应命中");
	const paraphrase = locateEvidence(dialogue, "周报汇报先给结论，避免被打回\nWhy: 上次被打回\nHow: 回答开头");
	assert(paraphrase !== null && paraphrase.includes("周报"), "转述应通过 4 字锚点命中（Why/How 不参与匹配）");
	assert(locateEvidence(dialogue, "用户喜欢深色主题") === null, "毫无依据的找不到");
	const longText = "甲".repeat(60) + "我要记的关键证据在这里" + "乙".repeat(120);
	const clipped = locateEvidence(longText, "我要记的关键证据在这里");
	assert(clipped !== null && clipped.startsWith("…") && clipped.endsWith("…"), "命中在长文本中段应两头带省略号");
	assert(locateEvidence("我要 记的，关键证据在这里。", "我要记的关键证据在这里") !== null, "标点/空白差异应容忍");
	assert(locateEvidence("Why: 上次被打回", "正 文\nWhy: 上次被打回") === null, "锚点不足 4 字（首行）= null");

	// 18.7 附：emoji（代理对）文本 —— norm / map / 原文三者必须同在 UTF-16 下标域，引文才不错位
	const mapped = normalizeForGroundingWithMap("😀a，İb");
	assert(mapped.norm.length === mapped.map.length, "map 与归一化串应同长（UTF-16 域不变式）");
	const emojiText = "😀".repeat(60) + "你好，" + "关键证据在这里";
	const emojiHit = locateEvidence(emojiText, "关键证据在这里");
	assert(emojiHit !== null && emojiHit.includes("关键证据在这里"), `emoji 文本引文应摘到命中处：${emojiHit}`);
	const farEmoji = "😀".repeat(200) + "，".repeat(200) + "关键证据在这里";
	const farHit = locateEvidence(farEmoji, "关键证据在这里");
	assert(farHit !== null && farHit.includes("关键证据在这里"), "超长 emoji 前缀的引文也应摘到命中处");

	console.log("✓ 证据引文：逐字/转述命中 / 未命中 / 截断 / 标点容忍 / emoji 下标域");
}

console.log("✓ 记忆框架自测通过");
