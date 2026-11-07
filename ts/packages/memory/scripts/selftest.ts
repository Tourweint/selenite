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
	InMemoryStore,
	MAX_PREFERENCES_PER_TURN,
	MemoryEngine,
	MIN_PREFERENCE_CONFIDENCE,
	NoopExtractor,
	PreferenceExtractor,
	SqliteMemoryStore,
	parsePreferenceJson,
	renderPreference,
	scopeKey,
	type ExtractMessage,
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

	// 10.5 PreferenceExtractor：模型给了就落 preference，模型挂了就返回空（绝不抛）
	const engineWithModel = new MemoryEngine({
		store: new InMemoryStore(),
		extractor: new PreferenceExtractor(async () =>
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
		extractor: new PreferenceExtractor(async () => {
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

console.log("✓ 记忆框架自测通过");
