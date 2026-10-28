/**
 * 记忆框架自测：把四层串起来跑一遍，验证边界是否成立。
 * 用内存存储，不落盘、不污染开发数据。
 *
 *   pnpm --filter @lifediary/memory selftest
 */
import {
	InMemoryStore,
	MemoryEngine,
	type ExtractMessage,
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

console.log("✓ 记忆框架自测通过");
