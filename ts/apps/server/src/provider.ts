import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

const DEFAULT_MODEL = "deepseek-v4.1-flash";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

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
	 *
	 * 2026-10-31 方案 D1 起：快/深**同模型**，档位走 `chatModelRef()` 的思考变体；
	 * 这个字段退化为部署别名（`LLM_MODEL_FAST` 不再承载快慢语义），保留只为兼容存量装配。
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

/** 上游目录里的静态模型（LLM_MODEL / LLM_MODEL_FAST / 运行时切换补进来的）；派生模型在 taskVariants */
let declaredModels: Model<"openai-completions">[] = [];
/** 当前上游 baseUrl（applyModelId 补模型时要用；env 静态，进程内不变） */
let upstreamBaseUrl = DEFAULT_BASE_URL;

function buildModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: upstreamBaseUrl,
		reasoning: false,
		input: ["text"],
		// 单价填 0：用量按 token 计数，不假装知道人民币价格
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 4096,
	};
}

/**
 * 聊天档位的**思考变体**（2026-10-31，方案 D1/D2）。
 *
 * 快档与深档是**同一个模型**（换模型 = 上游缓存清零，方案 §2.2 实测），
 * 区别只剩 `enable_thinking`。透传手段与任务派生模型同款：
 * `samplingParams` 的键原样合并进上游请求体、且最后写入。
 * 两条变体链的头块不同（方案 §2.3：25 token 差在头部），缓存互不命中 —— 所以这是刻意的两条链，
 * id 里显式带上 think 标志，别让两条链共用一个派生 id。
 */
export function chatModelRef(thinking: boolean): { provider: string; modelId: string } {
	const config = readLlmConfig();
	if (!config) throw new Error("LLM 未配置");
	if (isFaux()) return config.model;

	const id = `${config.model.modelId}#think-${thinking ? "on" : "off"}`;
	if (!taskVariants.has(id)) {
		const base = config.models.getModel(config.model.provider, config.model.modelId);
		if (!base) throw new Error("聊天模型不在目录里，无法派生思考变体");
		taskVariants.set(id, {
			...(base as Model<"openai-completions">),
			id,
			name: id,
			// `model` 盖回真实模型名（理由同 taskModelRef：派生 id 不能漏到上游，否则 404）；
			// `enable_thinking` 显式声明档位，不赌上游默认值
			samplingParams: { model: config.model.modelId, enable_thinking: thinking },
		});
		publishProvider?.();
	}
	return { provider: config.model.provider, modelId: id };
}

function isFaux(): boolean {
	return (process.env.LLM_PROVIDER ?? "").trim().toLowerCase() === "faux";
}
export { isFaux };

/** ── 模型运行时覆盖（2026-11-04，界面第三轮方案 §四）──────────────────────────
 *
 * 密钥与上游地址永远只走环境变量（仓库硬约束），这里能动的**只有模型名**。
 * env `LLM_MODEL` 是出厂默认；设置页切模型 = 写运行时覆盖（`.data/runtime.json`，
 * 只存模型 id），`readLlmConfig` 返回的引用跟着变，下一轮对话生效。
 * `MODEL_RUNTIME_OVERRIDE=false` 一行回滚：接口拒绝、启动忽略已存覆盖值。
 */

/** env 清单：`LLM_MODELS` 逗号分隔；没配 = 只有当前模型（选择器退化成只读行） */
function declaredModelIds(envId: string): string[] {
	const list = (process.env.LLM_MODELS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return list.includes(envId) ? list : [envId, ...list];
}

const runtimeStatePath = (): string =>
	process.env.MODEL_RUNTIME_PATH?.trim() || ".data/runtime.json";

/** 回滚开关：`MODEL_RUNTIME_OVERRIDE=false` = 关闭运行时切模型（接口拒绝 + 启动忽略覆盖值） */
export function modelOverrideEnabled(): boolean {
	return (process.env.MODEL_RUNTIME_OVERRIDE ?? "").trim().toLowerCase() !== "false";
}

function readStoredModel(): string | null {
	try {
		const parsed = JSON.parse(readFileSync(runtimeStatePath(), "utf8")) as {
			model?: unknown;
		};
		return typeof parsed.model === "string" && parsed.model.trim()
			? parsed.model.trim()
			: null;
	} catch {
		return null; // 没有覆盖值 / 坏了都当没有，env 默认接管
	}
}

function writeStoredModel(id: string): void {
	const path = runtimeStatePath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ model: id, at: new Date().toISOString() })}\n`);
	} catch (error) {
		// 覆盖值写不进去只影响"重启后是否记得"，本轮已经生效，不当致命错误
		console.warn(
			`[model] 覆盖值写不进 ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export interface RuntimeModelInfo {
	/** 当前生效的模型 id；未配置（mock 流）时是 null */
	model: string | null;
	/** 可切清单；faux / mock / 清单只有一项 / 覆盖被关 时是 []（前端据此退化成只读行） */
	models: string[];
}

/** /healthz 的模型段：一次调用拿全"现在是什么、能切什么" */
export function runtimeModelInfo(): RuntimeModelInfo {
	if (isFaux()) return { model: "faux", models: [] };
	const config = readLlmConfig();
	if (!config) return { model: null, models: [] };
	const current = config.model.modelId;
	if (!modelOverrideEnabled()) return { model: current, models: [] };
	const list = declaredModelIds(envModelId());
	return { model: current, models: list.includes(current) ? list : [current, ...list] };
}

export type SetModelResult =
	| { ok: true; model: string; models: string[] }
	| {
			ok: false;
			reason: "override_disabled" | "faux" | "llm_not_configured" | "unknown_model";
			message: string;
	  };

/** 设置页切模型（接口文档 §2.8）。校验、生效、持久化都在这一处。 */
export function setRuntimeModel(id: string): SetModelResult {
	if (!modelOverrideEnabled()) {
		return {
			ok: false,
			reason: "override_disabled",
			message: "模型切换被 MODEL_RUNTIME_OVERRIDE=false 关闭",
		};
	}
	if (isFaux()) {
		return { ok: false, reason: "faux", message: "faux 是假模型，没有可切换的真实模型" };
	}
	const config = readLlmConfig();
	if (!config) {
		return { ok: false, reason: "llm_not_configured", message: "未配置 LLM_API_KEY（mock 流），没有模型可切" };
	}
	const target = id.trim();
	if (!declaredModelIds(envModelId()).includes(target)) {
		return { ok: false, reason: "unknown_model", message: `模型不在清单里：${target}` };
	}
	applyModelId(target);
	writeStoredModel(target);
	return { ok: true, model: target, models: runtimeModelInfo().models };
}

/** 直通路径（openai-compat）跟随运行时覆盖；faux/mock 返回 null（直通路径在那两种模式下本来就不可用） */
export function upstreamModelId(): string | null {
	if (isFaux()) return null;
	return readLlmConfig()?.model.modelId ?? null;
}

function envModelId(): string {
	return process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
}

/** 把 cached 的引用指向新模型；目录里没有就补一份再重发 provider */
function applyModelId(id: string): void {
	if (!cached || cached.models.getModel(PROVIDER_ID, id)) {
		// 目录里已有（首次启动恢复场景），只需把引用指过去
		if (cached) {
			cached.model = { provider: PROVIDER_ID, modelId: id };
			cached.fastModel = cached.model;
		}
		return;
	}
	declaredModels.push(buildModel(id));
	publishProvider?.();
	if (cached) {
		cached.model = { provider: PROVIDER_ID, modelId: id };
		cached.fastModel = cached.model;
	}
}

/** 参数 → 稳定后缀。同参数复用同一个派生模型，避免每次请求都往目录里塞新模型 */
function variantKey(params: TaskSampling): string {
	const temperature = typeof params.temperature === "number" ? params.temperature : "-";
	const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : "-";
	const format = params.responseFormat ? String(JSON.stringify(params.responseFormat)) : "-";
	// 只取哈希的前 8 位：够区分，也不会把整段 JSON 塞进模型 id
	const digest = createHash("sha256").update(format).digest("hex").slice(0, 8);
	// 任务一律思考开（2026-10-31 方案 D 表）：把思考标志编进 id，
	// 避免同参数两种思考档共用一个派生 id 互相覆盖。id 变了 = 旧任务会话的存量引用失配；
	// 任务是一次性会话，跑完即弃，可接受（2026-10-31）。
	return `t${temperature}m${maxTokens}r${format === "-" ? "-" : digest}th1`;
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
			// 任务一律思考开（2026-10-31 方案 D 表）：一次性会话无历史包袱，质量优先
			enable_thinking: true,
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

	// 2026-10-31 方案 D1：**一个模型**（快=深同款）。换模型会把上游缓存清零，
	// 快慢一律交给 `enable_thinking` 变体（`chatModelRef`）。默认值改成 deepseek-v4.1-flash：
	// 实测同一句话 qwen-flash ~1.0s，deepseek-v4.1-flash 关思考 0.77–0.93s，质量更好。
	// `LLM_MODEL_FAST` 保留为**部署别名**（语义已不再是"小模型"），留空则跟随 `LLM_MODEL`。
	const modelId = envModelId();
	upstreamBaseUrl = (
		process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL
	).replace(/\/+$/, "");

	const fastModelId = process.env.LLM_MODEL_FAST?.trim() || modelId;

	declaredModels =
		fastModelId === modelId
			? [buildModel(modelId)]
			: [buildModel(modelId), buildModel(fastModelId)];

	const models = createModels();
	// provider 是可替换的：任务通道要往里加"带采样参数的派生模型"，
	// 每次加完重发一次（Models 被 durable 代理着读，写进去下一轮就生效）
	const publish = (): void => {
		models.setProvider(
			createProvider({
				id: PROVIDER_ID,
				name: "百炼（OpenAI 兼容）",
				baseUrl: upstreamBaseUrl,
				// 存的凭据优先，其次读 LLM_API_KEY；两者都没有时 provider 就是「未配置」
				auth: { apiKey: envApiKeyAuth("百炼 API key", ["LLM_API_KEY"]) },
				models: [...declaredModels, ...taskVariants.values()],
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

	// 启动时恢复上一次的运行时选择（2026-11-04）：只在清单内才认，
	// env 换了、清单删了旧模型，就自然回默认，不报错。
	if (modelOverrideEnabled()) {
		const stored = readStoredModel();
		if (stored && stored !== modelId && declaredModelIds(modelId).includes(stored)) {
			applyModelId(stored);
		}
	}
	return cached;
}
