#!/usr/bin/env node
/**
 * 测试基线哨兵（2026-11-21）。
 *
 * 只跑三支与业务改动无关、必须常绿的测试：
 *   - arch-guard.test.ts   架构硬约束（闸门完整性 / 依赖方向 / 只读档）
 *   - auxiliary.test.ts    杂活模型用途枚举（AUX_USES 与解析）
 *   - partner-work.test.ts 执事履历 / 例行（含 Windows 临时目录清理）
 *
 * 用途：全量套件出现红条时，先跑这一支确认「噪音基线」是绿的，
 * 再判断红条是不是自己的改动弄的。判定口径见
 * docs/变更记录/2026-11-21-测试基线现状与归属判定.md。
 *
 * 用法（任意目录均可）：
 *   node ts/apps/server/scripts/test-baseline.mjs
 * 退出码：0 = 三支全绿；非 0 = 有红条。
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
	"src/arch-guard.test.ts",
	"src/auxiliary.test.ts",
	"src/partner-work.test.ts",
];

const result = spawnSync(
	process.execPath,
	["--import", "tsx", "--test", ...files],
	{ cwd: pkgRoot, stdio: "inherit" },
);

if (result.error) {
	console.error(`[baseline] 起不来 tsx：${result.error.message}`);
	console.error("[baseline] 先在 ts/ 下跑一次 pnpm install");
	process.exit(1);
}

if (result.status === 0) {
	console.log("\n[baseline] 基线绿：三支哨兵全过。红条若在别处，按变更记录的口径核对自己的改动集。");
} else {
	console.error("\n[baseline] 基线红：先对照 docs/变更记录/2026-11-21-测试基线现状与归属判定.md，");
	console.error("[baseline] 不要先改业务代码；确认是新增失败还是环境串扰。");
}

process.exit(result.status ?? 1);
