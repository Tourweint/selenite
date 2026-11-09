/**
 * 例行任务条件门控（2026-11-10 批 13 §四，全景调研 #19）。
 *
 * 三件事都是**确定性纯逻辑**，单独成文件（照 cron.ts / routine-quiet.ts 的纪律）：
 *   1. `until`：模型给一句文字条件，每轮自己判断"达成没有"；判达成 → 规则置停（不删）。
 *      **不做通用表达式引擎**——文字条件由模型理解，宿主只认一个显式标记。
 *   2. `maxRuns`：跑满 N 次自动停。简单、确定、可测。
 *   3. `lastOutcome`：上一轮的结果（枚举）带给下一次触发，让规则能接着上次往下做。
 *
 * 开关 `ROUTINE_CONDITIONAL` 默认开；`false`/`0`/`off` 时新字段全部被忽略，
 * 提示词与 run 记录回到改动前（回滚一行 env）。
 */

/** 模型声明"完成条件已达成"的固定标记（回复最后单独一行）。 */
export const ROUTINE_DONE_MARKER = "[[routine-done]]";

export type RoutineOutcome = "success" | "quiet" | "skipped" | "failed" | "done";

/** 回滚开关：默认开；只有明确写 false / 0 / off 才关。 */
export function routineConditionalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.ROUTINE_CONDITIONAL ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

export interface RoutinePromptInput {
	/** 规则原文（已按上限截断） */
	prompt: string;
	/** 上一次的结局枚举；没有历史 = undefined */
	lastOutcome?: RoutineOutcome;
	/** 完成条件的文字说明 */
	untilNote?: string;
	/** 开关形态：false 时两段上下文都不加（回到旧提示词） */
	conditional: boolean;
}

/**
 * 组装这一轮的提示词：`[上一次的结果]` → 原文 → `[完成条件]`。
 * 顺序刻意固定：上一次的结局在前（模型先知道接着做什么），完成条件在后（最后才判停）。
 */
export function buildRoutinePrompt(input: RoutinePromptInput): string {
	if (!input.conditional) return input.prompt;
	const blocks: string[] = [];
	if (input.lastOutcome) blocks.push(`上一次的结果是 ${input.lastOutcome}。`);
	blocks.push(input.prompt);
	if (input.untilNote?.trim()) {
		blocks.push(
			`[完成条件] ${input.untilNote.trim()}\n` +
				`如果这个条件已经达成，在回复最后单独一行写 ${ROUTINE_DONE_MARKER}；没达成就不要写。`,
		);
	}
	return blocks.join("\n\n");
}

/** 从回复里认出完成标记（并把它从正文里剔除，标记本身不写进摘要）。 */
export function extractRoutineDone(raw: string): { text: string; done: boolean } {
	if (!raw.includes(ROUTINE_DONE_MARKER)) return { text: raw, done: false };
	return { text: raw.split(ROUTINE_DONE_MARKER).join("").trim(), done: true };
}

export interface RoutineRunVerdictInput {
	ok: boolean;
	quiet: boolean;
	/** 本轮无人值守跳过的工具数（>0 = outcome 记 skipped） */
	skippedToolCount: number;
	/** 模型是否声明完成条件达成（只在 conditional && until 存在时有意义） */
	untilMet: boolean;
	conditional: boolean;
	/** 跑满多少次自动停 */
	maxRuns?: number;
	/** 本轮之前已完成的次数（不含本轮） */
	completedRunsBefore: number;
}

export interface RoutineRunVerdict {
	outcome: RoutineOutcome;
	/** true = 这一轮之后要把规则置停（until 达成 / 跑满 maxRuns） */
	stop: boolean;
}

/**
 * 一轮跑完的结局与是否停表。
 *
 * 判定顺序：
 *   - 失败 → failed（失败也计数；跑满上限时照样停，但结局仍是 failed——不能把失败说成完成）；
 *   - until 达成 → done 且停（只在开关开时看）；
 *   - 跳过过步骤 → skipped（比 quiet 更该被看见）；
 *   - 安静轮 → quiet；
 *   - 其余 → success；
 *   - 最后判 maxRuns：本轮跑完正好满 N → 停；非失败结局升为 done。
 */
export function routineRunVerdict(input: RoutineRunVerdictInput): RoutineRunVerdict {
	const maxed =
		input.conditional &&
		typeof input.maxRuns === "number" &&
		input.maxRuns > 0 &&
		input.completedRunsBefore + 1 >= input.maxRuns;

	if (!input.ok) return { outcome: "failed", stop: maxed };
	if (input.conditional && input.untilMet) return { outcome: "done", stop: true };
	if (input.skippedToolCount > 0) {
		return { outcome: "skipped", stop: maxed };
	}
	if (input.quiet) return { outcome: "quiet", stop: maxed };
	return { outcome: maxed ? "done" : "success", stop: maxed };
}
