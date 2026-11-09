/**
 * 偏好抽取的**装配层**（2026-11-06）。
 *
 * 分工：
 * - `@lifediary/memory` 只提供 `PreferenceExtractor` 的形状与解析（不碰模型、不读 env）；
 * - 这里负责"用哪个模型、超时多久、失败怎么办、日志记什么"。
 *
 * 为什么值得单独一层：memory 包是纯内核，装配策略会随供应商/配额/开关变；
 * 混在一起会让"记忆包能单独跑 selftest"这件事失效。
 *
 * 红线（AGENTS.md）：日志不含对话内容。这里只记条数 / 字数 / 耗时 / 枚举，
 * 原始错误只留摘要（不含消息正文）。
 */
import { contentText } from "@earendil-works/pi-ai";
import {
	HeuristicExtractor,
	PreferenceExtractor,
	renderTranscript,
	type ExtractMessage,
	type Extractor,
	type MemoryCandidate,
	type MemoryScope,
} from "@lifediary/memory";
import { auxiliaryModel } from "./auxiliary.ts";
import { currentModels, isFaux, readLlmConfig } from "./provider.ts";

/**
 * `MEMORY_EXTRACT`（2026-11-06，回滚开关）：
 * - `auto`（默认）：有可用模型 → 偏好走 LLM、其余走规则；模型不可用 → 全走规则；
 * - `llm`：同上但**不因模型不可用而退化**（拿不到就不写偏好），用于验收"LLM 档到底抽到了什么"；
 * - `rule`：**逐字节回到 2026-11-06 之前**（装配处直接用老引擎，连这一层都不进）。
 */
export function memoryExtractMode(): "auto" | "llm" | "rule" {
	const raw = (process.env.MEMORY_EXTRACT ?? "").trim().toLowerCase();
	return raw === "rule" || raw === "llm" ? raw : "auto";
}

/** 单次偏好抽取的超时。记忆写入是后台动作，宁可丢一轮也不能挂着不结束。 */
const PREFERENCE_TIMEOUT_MS = 20_000;

/**
 * 一次性模型调用：**独立请求、不进主会话**。
 *
 * 用 `completeSimple` 而不是再开一个 durable 会话：
 * - 它是一次"有输入、要一段输出"的判断，不需要历史、不需要工具、不需要落库；
 * - 失败就是失败，不会在会话库里留一个半截的空会话。
 *
 * 模型走 `auxiliaryModel("extract")`（2026-11-10 批 20 §二）：`AUX_MODEL_EXTRACT`
 * 可以给偏好抽取单独 pin 一个小模型；没配 / `AUX_LLM=false` 时回落当前会话模型。
 *
 * 返回 null = 这次没拿到文本（未配置 / faux / 报错 / 超时）。
 */
async function generateOnce(messages: ExtractMessage[]): Promise<string | null> {
	const config = readLlmConfig();
	if (!config) return null;
	// faux 是"真实 durable 链路 + 假模型"，它的输出对抽取没有意义；
	// 走它只会把假文本写成偏好，所以直接当"没有模型"。
	if (isFaux()) return null;

	const ref = auxiliaryModel("extract", { current: config.model }) ?? config.model;
	const models = currentModels();
	const model = models.getModel(ref.provider, ref.modelId);
	if (!model) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PREFERENCE_TIMEOUT_MS);
	try {
		const response = await models.completeSimple(
			model,
			{
				systemPrompt: messages.find((message) => message.role === "system")?.content,
				messages: messages
					.filter((message) => message.role !== "system")
					.map((message) => ({
						role: "user" as const,
						content: message.content,
						timestamp: Date.now(),
					})),
			},
			{ signal: controller.signal, maxTokens: 600, temperature: 0 },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") return null;
		return contentText(response.content) || null;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// 只有错误摘要，没有对话正文
		console.warn(`[memory] 偏好抽取调用失败: ${detail.slice(0, 200)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 组合抽取器：**偏好走 LLM，其余走规则**。
 *
 * 为什么两类都跑（而不是二选一）：
 * - LLM 只抽偏好（窄口径，可预算），事实/经历仍然靠规则——它做这件事已经够好且免费；
 * - 两套产出的 kind 不相交（preference vs episode），不会互相打架；
 * - `auto` 档的语义因此是"在旧行为之上**增加**偏好"，而不是"换一套行为"。
 *   这一点很重要：升级不该让用户已经习惯的记忆突然少一半。
 */
class LayeredExtractor implements Extractor {
	private readonly preference = new PreferenceExtractor(generateOnce);
	private readonly fallback = new HeuristicExtractor();

	async extract(input: {
		messages: ExtractMessage[];
		scope: MemoryScope;
		now: Date;
	}): Promise<MemoryCandidate[]> {
		const started = Date.now();
		const [preferences, episodes] = await Promise.all([
			this.preference.extract(input).catch(() => [] as MemoryCandidate[]),
			this.fallback.extract(input),
		]);
		if (preferences.length > 0) {
			console.log(
				`[memory] 偏好抽取 +${preferences.length} 条（${Date.now() - started}ms，输入 ${renderTranscript(input.messages).length} 字）`,
			);
		}
		// 偏好在前：巩固层按顺序处理，同一段话里"偏好"优先占位
		return [...preferences, ...episodes];
	}
}

/**
 * 按当前开关给出这次要用的抽取器；返回 null = 调用方应保持 2026-11-06 之前的装配。
 */
export function preferenceExtractor(): Extractor | null {
	const mode = memoryExtractMode();
	if (mode === "rule") return null;
	if (mode === "auto" && (!readLlmConfig() || isFaux())) return null;
	return new LayeredExtractor();
}

/** 供探针/测试：当前会不会真的发模型调用。 */
export function preferenceExtractionEnabled(): boolean {
	return preferenceExtractor() !== null;
}
