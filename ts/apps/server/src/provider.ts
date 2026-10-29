import {
	createModels,
	createProvider,
	envApiKeyAuth,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * 模型接入。
 *
 * 换 1.x 之后 pi-ai 的用法变了：模型不再是一个裸 `Model` 对象塞给 Agent，
 * 而是「provider → models 集合 → 用 provider/modelId 引用」。
 * harness 存的是**引用**（名字），不是对象 —— 换模型只要改一次 env，
 * 所有历史会话下一轮就跟着换，不用迁移任何数据。
 *
 * 百炼这类 OpenAI 兼容端点不需要 pi 内置模型表：`createProvider` 手搓一个就行。
 */

const PROVIDER_ID = "bailian";

export interface LlmConfig {
	/** 传给 Harness 的模型集合 */
	models: Models;
	/** 会话里存的模型引用（深档：会思考，用于成稿/复杂任务） */
	model: { provider: string; modelId: string };
	/**
	 * 快档引用（2026-10-29）：**不思考**的模型，用于日常聊天。
	 *
	 * 实测同一收敛任务：`qwen-flash` 1.47s / 157 tokens，`deepseek-v4.1-flash` 10.17s / 1591 tokens，
	 * 质量差距远小于 7 倍的时间差 —— 所以聊天默认走快档，成稿类仍走深档。
	 * 用 `LLM_MODEL_FAST` 换（默认 `qwen-flash`）；设为空串则快档 = 深档（退回单模型）。
	 */
	fastModel: { provider: string; modelId: string };
}

let cached: LlmConfig | null | undefined;

/**
 * 密钥只从环境变量来，绝不进代码、不进库、不下发给 App。
 * 返回 null 表示未配置 —— 此时走 mock，链路照样能验证。
 *
 * `LLM_PROVIDER=faux` 时换成 pi 自带的假模型，返回固定一句话。
 * 它跟「未配置 → mock」的区别很重要：faux 走的是**真实的 durable 链路**
 * （会话落库、工具、压缩、记忆全都在跑），只是模型是假的。
 * 所以整条 HTTP 接口不花钱就能验，而 mock 只验证了 SSE 通路。
 */
export function readLlmConfig(): LlmConfig | null {
	if (cached !== undefined) return cached;

	const mode = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
	if (mode === "faux") {
		const faux = fauxProvider({ models: [{ id: "faux" }], tokensPerSecond: 120 });
		const models = createModels();
		models.setProvider(faux.provider);
		// 每次模型请求消耗一条；给足量，省得探针里还要续队列。
		// LLM_FAUX_TOOL 让它"只会调工具、永远不收尾"，专门用来验工具回合上限。
		const toolName = process.env.LLM_FAUX_TOOL?.trim();
		const respond = () =>
			toolName
				? fauxAssistantMessage(
						[fauxToolCall(toolName, toolName === "recall" ? { query: "faux" } : {})],
						{ stopReason: "toolUse" },
					)
				: fauxAssistantMessage("（faux 模型）链路已通。");
		faux.setResponses(Array.from({ length: 500 }, () => respond));
		const model = faux.getModel();
		const ref = { provider: model.provider, modelId: model.id };
		cached = { models, model: ref, fastModel: ref };
		return cached;
	}

	const apiKey = process.env.LLM_API_KEY?.trim();
	if (!apiKey) {
		cached = null;
		return null;
	}

	const modelId = process.env.LLM_MODEL?.trim() || "qwen-plus";
	const baseUrl = (
		process.env.LLM_BASE_URL?.trim() ||
		"https://dashscope.aliyuncs.com/compatible-mode/v1"
	).replace(/\/+$/, "");

	// 快档：同 provider 下再挂一个模型 id（不思考的那类）。留空 = 退回单模型
	const fastModelId = process.env.LLM_MODEL_FAST?.trim() || "qwen-flash";

	const buildModel = (id: string): Model<"openai-completions"> => ({
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl,
		reasoning: false,
		input: ["text"],
		// 单价填 0：用量按 token 计数，不假装知道人民币价格
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 4096,
	});

	const model = buildModel(modelId);
	const fastModel = buildModel(fastModelId);
	const declared = fastModelId === modelId ? [model] : [model, fastModel];

	const provider = createProvider({
		id: PROVIDER_ID,
		name: "百炼（OpenAI 兼容）",
		baseUrl,
		// 存的凭据优先，其次读 LLM_API_KEY；两者都没有时 provider 就是「未配置」
		auth: { apiKey: envApiKeyAuth("百炼 API key", ["LLM_API_KEY"]) },
		models: declared,
		api: openAICompletionsApi(),
	});

	const models = createModels();
	models.setProvider(provider);

	cached = {
		models,
		model: { provider: PROVIDER_ID, modelId },
		fastModel: { provider: PROVIDER_ID, modelId: fastModelId },
	};
	return cached;
}
