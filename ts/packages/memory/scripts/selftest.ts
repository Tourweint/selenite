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
	MemoryEngine,
	SqliteMemoryStore,
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

console.log("✓ 记忆框架自测通过");
