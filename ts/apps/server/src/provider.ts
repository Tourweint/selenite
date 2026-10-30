import { createHash } from "node:crypto";
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
 * 任务通道的**派生模型**（2026-10-30）。
 *
 * 为什么需要它：pi-durable 的 `configure()` 只认 `ModelRef`（provider + modelId），
 * 没有"这一轮传 temperature"的口子；而 pi-ai 会把 `model.samplingParams` 的键
 * **原样合并进上游请求体**，且最后写入（`openai-completions.js:752`）。
 * 所以"参数透传"的做法是：按参数派生一个模型 id，把参数挂在它的 `samplingParams` 上，
 * 再把这个 id 配给会话；会话存的是引用，重启后照样按 id 找回来（id 由参数确定性生成）。
 *
 * 只在**任务通道**用：通用聊天仍走 `LLM_MODEL` / `LLM_MODEL_FAST`，行为一个字都不变。
 */
export interface TaskSampling {
	temperature?: number;
	maxTokens?: number;
	responseFormat?: unknown;
}

const taskVariants = new Map<string, Model<"openai-completions">>();
/** 重新发布 provider（新增派生模型后调用），由 readLlmConfig 装配时挂上 */
let publishProvider: (() => void) | null = null;

function isFaux(): boolean {
	return (process.env.LLM_PROVIDER ?? "").trim().toLowerCase() === "faux";
}

/** 参数 → 稳定后缀。同参数复用同一个派生模型，避免每次请求都往目录里塞新模型 */
function variantKey(params: TaskSampling): string {
	const temperature = typeof params.temperature === "number" ? params.temperature : "-";
	const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : "-";
	const format = params.responseFormat ? String(JSON.stringify(params.responseFormat)) : "-";
	// 只取哈希的前 8 位：够区分，也不会把整段 JSON 塞进模型 id
	const digest = createHash("sha256").update(format).digest("hex").slice(0, 8);
	return `t${temperature}m${maxTokens}r${format === "-" ? "-" : digest}`;
}

/**
 * 任务通道要用哪个模型引用：在深档模型上挂参数派生一份。
 *
 * - faux 模式只有一个模型、上游请求体也不存在 → 直接返回深档引用（参数无处生效，探针用假上游验）；
 * - 未配置 LLM → 抛错（调用方已经先判过 `readLlmConfig()`，走到这里说明配置被中途清空）。
 */
export function taskModelRef(params: TaskSampling): { provider: string; modelId: string } {
	const config = readLlmConfig();
	if (!config) throw new Error("LLM 未配置");
	if (isFaux()) return config.model;

	const id = `${config.model.modelId}#${variantKey(params)}`;
	if (!taskVariants.has(id)) {
		const base = config.models.getModel(config.model.provider, config.model.modelId);
		if (!base) throw new Error("深档模型不在目录里，无法派生任务模型");
		const samplingParams: Record<string, unknown> = {
			// 关键：派生模型只活在 harness 的模型目录里，**上游必须收到真实模型名**。
			// 2026-10-30 真机联调抓到：不盖这一行，上游收到 `qwen-plus#t0.4m4000r-` → 404
			// `model_not_found` → Agent 空轮 → 界面只有"这次没能生成回复"。
			// 能盖是因为 pi-ai 把 `samplingParams` **最后** `Object.assign` 进请求体（openai-completions.js:752）。
			model: config.model.modelId,
		};
		if (typeof params.temperature === "number") samplingParams.temperature = params.temperature;
		// max_tokens 也走 samplingParams：它最后写入，能盖掉模型自身的默认上限
		if (typeof params.maxTokens === "number") samplingParams.max_tokens = params.maxTokens;
		if (params.responseFormat) samplingParams.response_format = params.responseFormat;
		taskVariants.set(id, {
			...(base as Model<"openai-completions">),
			id,
			name: id,
			samplingParams,
		});
		publishProvider?.();
	}
	return { provider: config.model.provider, modelId: id };
}

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

	const models = createModels();
	// provider 是可替换的：任务通道要往里加"带采样参数的派生模型"，
	// 每次加完重发一次（Models 被 durable 代理着读，写进去下一轮就生效）
	const publish = (): void => {
		models.setProvider(
			createProvider({
				id: PROVIDER_ID,
				name: "百炼（OpenAI 兼容）",
				baseUrl,
				// 存的凭据优先，其次读 LLM_API_KEY；两者都没有时 provider 就是「未配置」
				auth: { apiKey: envApiKeyAuth("百炼 API key", ["LLM_API_KEY"]) },
				models: [...declared, ...taskVariants.values()],
				api: openAICompletionsApi(),
			}),
		);
	};
	publish();
	publishProvider = publish;

	cached = {
		models,
		model: { provider: PROVIDER_ID, modelId },
		fastModel: { provider: PROVIDER_ID, modelId: fastModelId },
	};
	return cached;
}
