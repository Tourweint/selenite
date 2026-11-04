import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodeBuddy } from "../../../../../chancellor/src/employee/codebuddy.ts";

/**
 * 真跑一次 CodeBuddy 适配器的最小任务：不经过拆单/验收，只看
 * CLI 起不起得来、退出码与结果解析对不对。
 *
 * 用法：pnpm --filter @lifediary/server exec tsx scripts/codebuddy-probe.ts ["提示词"]
 *
 * 需要用户事先登录一次 CodeBuddy CLI（`codebuddy` 交互模式走完登录）。
 */
const prompt = process.argv.slice(2).join(" ").trim() || "只回答两个字：收到";
const cwd = mkdtempSync(join(tmpdir(), "codebuddy-probe-"));
const startedAt = Date.now();

const result = await runCodeBuddy({
	prompt,
	cwd,
	timeoutMs: 5 * 60_000,
	label: "codebuddy-probe",
});

console.log(
	JSON.stringify(
		{
			...result,
			promptLength: prompt.length,
			cwd,
			elapsedMs: Date.now() - startedAt,
		},
		null,
		2,
	),
);
process.exit(result.ok ? 0 : 1);
