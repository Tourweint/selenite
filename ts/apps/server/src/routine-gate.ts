/**
 * 例行任务的「前置条件」判定（2026-11-10 批 21 §三）。
 *
 * `RoutineTrigger.if` 是**一句人话条件**（"今天有新的日记条目吗"），宿主不解析它，
 * 只在触发前问一次模型"这个条件此刻成立吗"：
 *   - 一次独立的一次性调用（`completeSimple`），不进会话、不留历史，开销就是一小段 tokens；
 *   - **失败即跳过**（没配模型 / faux / 超时 / 报错 / 答非 YES/NO）——宁可不跑，
 *     也不能把"没验证成"当成"成立"让无人值守的轮次自己跑起来；
 *   - 只认明确答案：解析不出来一律当"不成立"（§3.2）。
 *
 * 开关沿用批 13 的 `ROUTINE_CONDITIONAL`（见 routine-conditions.ts），关着时 `if` 完全不看。
 * 日志纪律：只记枚举与耗时，不记条件原文（条件可能带用户私事）。
 */

import { contentText } from "@earendil-works/pi-ai";
import { auxiliaryModel } from "./auxiliary.ts";
import { currentModels, isFaux, readLlmConfig } from "./provider.ts";

/** 单次判定超时：例行轮本来就是后台动作，不能挂住整条 lane。 */
export const CONDITION_TIMEOUT_MS = 15_000;

export type RoutineConditionVerdict = "met" | "not_met" | "unavailable";

const YES = new Set(["yes", "y", "true", "1", "是", "是的", "成立", "满足", "可以"]);
const NO = new Set(["no", "n", "false", "0", "否", "不是", "不", "不成立", "不满足", "不可以"]);

/**
 * 解析模型的回答：只看第一个词（按中英文标点/空白切）。
 * 返回 null = 没给出明确答案（调用方按"不成立"处理）。
 */
export function parseConditionAnswer(raw: string): boolean | null {
	const head = raw
		.trim()
		.toLowerCase()
		.split(/[\s,，。.!！?？:：;；、"'“”‘’()（）]+/)[0] ?? "";
	if (YES.has(head)) return true;
	if (NO.has(head)) return false;
	return null;
}

const SYSTEM_PROMPT = [
	"你是例行任务的前置条件判断器。",
	"判断给出的条件在当下是否成立。只根据条件本身与任务说明判断，不要臆造外部事实。",
	"只回答一个词：YES 或 NO。不要解释。",
].join("\n");

/**
 * 问一次模型"条件成立吗"。
 *
 * 任何一步拿不到明确答案都返回 `unavailable`（调用方按不成立跳过）。
 * 模型走 `auxiliaryModel("review")`：这是短输入短输出的判断，适合单独 pin 一个小模型。
 */
export async function evaluateRoutineCondition(input: {
	note: string;
	/** 规则正文：给判断器一点上下文，避免孤立一句看不懂 */
	prompt?: string;
}): Promise<RoutineConditionVerdict> {
	const note = input.note.trim();
	if (!note) return "unavailable";

	const config = readLlmConfig();
	// faux 是"真实 durable 链路 + 假模型"：它的回答对条件判定没有意义，直接当没有模型。
	if (!config || isFaux()) return "unavailable";
	const ref = auxiliaryModel("review", { current: config.model }) ?? config.model;
	const models = currentModels();
	const model = models.getModel(ref.provider, ref.modelId);
	if (!model) return "unavailable";

	const question = [
		...(input.prompt?.trim() ? [`任务说明：${input.prompt.trim().slice(0, 2000)}`] : []),
		`条件：${note}`,
		"这个条件此刻成立吗？只回答 YES 或 NO。",
	].join("\n\n");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CONDITION_TIMEOUT_MS);
	const started = Date.now();
	try {
		const response = await models.completeSimple(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [{ role: "user" as const, content: question, timestamp: Date.now() }],
			},
			{ signal: controller.signal, maxTokens: 4, temperature: 0 },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return "unavailable";
		}
		const parsed = parseConditionAnswer(contentText(response.content));
		if (parsed === null) {
			console.log(`[routine] 前置条件判定没有明确答案（${Date.now() - started}ms），按不成立处理`);
			return "unavailable";
		}
		return parsed ? "met" : "not_met";
	} catch (error) {
		// 只记摘要，不记条件原文
		console.warn(
			`[routine] 前置条件判定失败（按不成立处理）: ${
				error instanceof Error ? error.message.slice(0, 120) : "unknown"
			}`,
		);
		return "unavailable";
	} finally {
		clearTimeout(timer);
	}
}
