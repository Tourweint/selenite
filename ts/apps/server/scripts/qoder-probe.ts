import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runQoderCn,
	runQoderIntl,
} from "../../../packages/chancellor/src/employee/qoder.ts";

/**
 * 真跑一次 Qoder 适配器的最小任务（纯问答，不写文件）。
 *
 * 用法：pnpm --filter @lifediary/server exec tsx scripts/qoder-probe.ts [intl|cn] ["提示词"]
 *
 * 两个版本的登录态互相独立；CN 首次冷启动约 100 秒，超时给到 10 分钟。
 */
const which = process.argv[2] === "cn" ? "cn" : "intl";
const prompt = process.argv.slice(3).join(" ").trim() || "只回答两个字：收到";
const cwd = mkdtempSync(join(tmpdir(), `qoder-${which}-probe-`));
const startedAt = Date.now();

const result = await (which === "cn" ? runQoderCn : runQoderIntl)({
	prompt,
	cwd,
	tools: "none",
	timeoutMs: 10 * 60_000,
	label: `qoder-${which}-probe`,
});

console.log(
	JSON.stringify(
		{ which, ...result, promptLength: prompt.length, cwd, elapsedMs: Date.now() - startedAt },
		null,
		2,
	),
);
process.exit(result.ok ? 0 : 1);
