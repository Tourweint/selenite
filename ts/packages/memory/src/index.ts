export * from "./types.ts";
export * from "./store.ts";
export * from "./extract.ts";
export * from "./consolidate.ts";
export * from "./recall.ts";
export * from "./engine.ts";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryEngine } from "./engine.ts";
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
}): MemoryEngine | null {
	if (options.enabled === false) return null;

	const dbPath = options.dbPath ?? process.env.MEMORY_DB_PATH ?? ".data/memory.db";
	// SQLite 不会自己建目录，先兜住
	mkdirSync(dirname(dbPath), { recursive: true });
	return new MemoryEngine({
		store: new SqliteMemoryStore(dbPath, { fts: options.fts }),
		...(options.candidateFloor === undefined ? {} : { candidateFloor: options.candidateFloor }),
	});
}
