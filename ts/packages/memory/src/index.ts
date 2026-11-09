export * from "./types.ts";
export * from "./store.ts";
export * from "./redact.ts";
export * from "./extract.ts";
export * from "./consolidate.ts";
export * from "./decay.ts";
export * from "./recall.ts";
export * from "./engine.ts";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryEngine } from "./engine.ts";
import type { Extractor } from "./extract.ts";
import { SqliteMemoryStore } from "./store.ts";

/**
 * 按环境变量装配一个默认引擎。KEY 之外的东西都给默认值，
 * 目标是"不配置也能跑，配置了才花心思"。
 */
export function createMemoryEngine(options: {
	dbPath?: string;
	enabled?: boolean;
	/** 召回候选窗口下限（2026-11-04 批次一 A2-S）；env 由调用方读取，这一层不碰。 */
	candidateFloor?: number;
	/** FTS5 trigram 候选集开关（2026-11-04 批次三）；默认 true，false = 回到批次一行为。 */
	fts?: boolean;
	/**
	 * 抽取器（2026-11-06）。不传 = `HeuristicExtractor`（原行为）；
	 * 装配策略（用哪个模型、回滚开关）在 server 的 `memory-extract.ts`，这一层只收实现。
	 */
	extractor?: Extractor;
	/** 日衰减系数（2026-11-08 扫尾批 6）；不传 = 不衰减（旧行为）。 */
	decayDaily?: number;
}): MemoryEngine | null {
	if (options.enabled === false) return null;

	const dbPath = options.dbPath ?? process.env.MEMORY_DB_PATH ?? ".data/memory.db";
	// SQLite 不会自己建目录，先兜住
	mkdirSync(dirname(dbPath), { recursive: true });
	return new MemoryEngine({
		store: new SqliteMemoryStore(dbPath, { fts: options.fts }),
		...(options.candidateFloor === undefined ? {} : { candidateFloor: options.candidateFloor }),
		...(options.extractor === undefined ? {} : { extractor: options.extractor }),
		...(options.decayDaily === undefined ? {} : { decayDaily: options.decayDaily }),
	});
}
