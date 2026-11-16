/**
 * 长记忆拆分一次性迁移脚本（2026-11-16）。
 *
 * 默认 dry-run：只算「会拆多少条、产出多少原子」，不写库。
 * `--apply` 才执行：先 VACUUM INTO 备份，再写原文档案 + 原子 + 归档原记录。
 *
 * 用法（在 ts/apps/server 下）：
 *   pnpm exec tsx scripts/memory-split.ts
 *   pnpm exec tsx scripts/memory-split.ts --apply
 *   pnpm exec tsx scripts/memory-split.ts --scope global --min-chars 300
 *
 * 日志只记条数 / 类型 / 字数 / 耗时，不记正文（D8）。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMemoryEngine } from "@lifediary/memory";
import { applySplitPlan, buildSplitPlan, MIN_SPLIT_CHARS } from "../src/memory-split.ts";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index < 0) return undefined;
	return process.argv[index + 1];
}

const scopeArg = arg("--scope")?.trim() || "global";
const minChars = Number(arg("--min-chars") ?? MIN_SPLIT_CHARS);
const apply = process.argv.includes("--apply");
const dbPath = process.env.MEMORY_DB_PATH?.trim() || join(".data", "memory.db");

if (!existsSync(dbPath)) {
	console.error(`记忆库不存在: ${dbPath}`);
	process.exit(1);
}

const engine = createMemoryEngine({ dbPath });
if (!engine) {
	console.error("记忆引擎初始化失败");
	process.exit(1);
}

const startedAt = Date.now();
const scopes =
	scopeArg === "all"
		? Object.keys(engine.stats().byScope).filter(
				(scope) => scope === "global" || scope.startsWith("partner:") || scope.startsWith("project:"),
			)
		: [scopeArg];

const previews = scopes.map((scope) => buildSplitPlan(engine, scope, { minChars }));
const preview = {
	scope: scopeArg,
	scanned: previews.reduce((sum, item) => sum + item.scanned, 0),
	unmatched: previews.reduce((sum, item) => sum + item.unmatched, 0),
	candidates: previews.flatMap((item) => item.candidates),
	plans: previews.flatMap((item) => item.plans),
};
const totalAtoms = preview.plans.reduce((sum, plan) => sum + plan.atoms.length, 0);
const fallback = preview.plans.filter((plan) => plan.fallback).length;
const fromSource = preview.plans.length - fallback;

console.log(
	`[memory-split] scope=${scopeArg} scopes=${scopes.length} scanned=${preview.scanned} candidates=${preview.candidates.length} atoms=${totalAtoms} source=${fromSource} fallback=${fallback} db=${dbPath}`,
);
for (const scope of scopes) {
	const item = previews.find((entry) => entry.scope === scope);
	if (!item || item.candidates.length === 0) continue;
	console.log(`  ${scope}: ${item.candidates.length} 条`);
}
for (const item of preview.candidates.slice(0, 10)) {
	console.log(
		`  - ${item.id.slice(0, 8)} kind=${item.kind} chars=${item.chars} atoms=${item.atomCount} fallback=${item.fallback ? "yes" : "no"}`,
	);
}
if (preview.candidates.length > 10) {
	console.log(`  … 另有 ${preview.candidates.length - 10} 条`);
}
const show = Number(arg("--show") ?? 0);
if (Number.isFinite(show) && show > 0) {
	for (const plan of preview.plans.slice(0, show)) {
		console.log(`  [${plan.recordId.slice(0, 8)}] ${plan.doc.title}`);
		for (const atom of plan.atoms.slice(0, 3)) {
			console.log(`    · ${atom.content.replace(/\s+/g, " ").slice(0, 200)}`);
		}
	}
}

if (!apply) {
	console.log("[memory-split] dry-run：没有写库。确认后加 --apply。");
	engine.close();
	process.exit(0);
}

if (preview.plans.length === 0) {
	console.log("[memory-split] 没有可拆的记录。");
	engine.close();
	process.exit(0);
}

// 备份：VACUUM INTO 生成一致性快照（比直接 cp 更安全，WAL 也会被折叠进去）。
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupPath = `${dbPath}.bak-split-${stamp}`;
mkdirSync(dirname(backupPath), { recursive: true });
try {
	const source = new DatabaseSync(dbPath);
	source.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
	source.close();
	console.log(`[memory-split] 备份: ${backupPath}`);
} catch (error) {
	console.error(
		`[memory-split] 备份失败，未写库: ${error instanceof Error ? error.message : String(error)}`,
	);
	engine.close();
	process.exit(1);
}

const result = applySplitPlan(engine, preview);
console.log(
	`[memory-split] 完成 documents=${result.documents} atoms=${result.atoms} archived=${result.archived} skipped=${result.skipped} failed=${result.failed} 用时=${Math.round((Date.now() - startedAt) / 1000)}s`,
);
engine.close();
