/**
 * 质检 worker 的宿主侧派单实现（2026-11-19 批2，方案 §4）。
 *
 * chancellor 的验收分支（review.ts）在「派质检 worker」方式下经 `QaRunner` 缝
 * 调到这里：**走既有派单器**（runChancellor，managers:false、无领域、无项目）派一单
 * 质检工人，requirement 由 chancellor 的 qa.md 模板拼好。质检单是张真单：
 * 落 runs 目录、进任务中心、自己的验收走内部请求（嵌套 runChancellor 不带
 * qaWorker → 不会递归质检）。
 *
 * 回传的是质检工人的 REPORT.md 原文（结论行 DONE/CONTINUE/BLOCKED 由 chancellor
 * 的 parseQaConclusion 扫描）；读不到回执时退回 chancellor 的结果行。
 *
 * 装配：index.ts 启动段 mountQaRunner() 一次。回滚：派活设置切回「内部一次请求」
 * 即不走这条缝；CHANCELLOR_QA_MODE env 缺省 internal。
 */

import fs from "node:fs";
import path from "node:path";
import { runChancellor } from "../../../packages/chancellor/src/index.ts";
import { setQaRunner } from "../../../packages/chancellor/src/qa.ts";
import { chancellorWorkRoot } from "./delegation.ts";

/** 嵌套保护：质检单自己的验收不可能再进这里（req.qaWorker 未传），这条只防装配错。 */
let qaInFlight = false;

export function mountQaRunner(): void {
	setQaRunner(async (requirement) => {
		if (qaInFlight) {
			throw new Error("质检派单嵌套调用（装配错误：质检单的验收不应再走质检）");
		}
		qaInFlight = true;
		try {
			const result = await runChancellor(
				{
					requirement,
					managers: false,
					workRoot: chancellorWorkRoot(),
				},
				{},
			);
			const dir = result.tasks?.[0]?.dir;
			if (dir) {
				try {
					return fs.readFileSync(path.join(dir, "REPORT.md"), "utf8");
				} catch {
					// 质检单没写 REPORT：退回结果行（解析不到结论行 → blocked 交人，fail-visible）。
				}
			}
			return result.line;
		} finally {
			qaInFlight = false;
		}
	});
}
