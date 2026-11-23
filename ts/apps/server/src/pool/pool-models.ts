import {
	createModels,
	createProvider,
	envApiKeyAuth,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
	type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/** 池进程真实模型用的 provider id（与宿主 / 宰相侧区分开，避免串源）。 */
export const POOL_PROVIDER_ID = "pool-bailian";
/** 缺省模型，与宿主 / 宰相侧同源。 */
export const POOL_DEFAULT_MODEL = "deepseek-v4.1-flash";

export interface PoolModelTarget {
	provider: string;
	modelId: string;
}

type Env = Record<string, string | undefined>;

/**
 * `createModels()` 的具体实例类型。导出类型 `Models` 只是查询面（getModel / getProviders），
 * 变异方法 `setProvider` 只在该实例类型上——provider.ts:427 用 `ReturnType<typeof createModels>` 即同一原因。
 */
type PoolModels = ReturnType<typeof createModels>;

/**
 * `createPoolModels` 装 faux provider 时记录的真实 model ref。
 * `configurePoolModel` 的 faux 分支读它，而不是猜 "faux" 这个字符串。
 */
let fauxRef: PoolModelTarget | null = null;

/** 读 env 拼 baseUrl/key/model；faux 模式返回 faux 标记。 */
export function poolLlmConfig(env: Env = process.env): {
	faux: boolean;
	baseUrl: string;
	apiKey: string;
	defaultModel: string;
} {
	const faux =
		(env.LLM_PROVIDER ?? env.CHANCELLOR_LLM_PROVIDER ?? "").trim().toLowerCase() === "faux";
	const apiKey = (env.CHANCELLOR_LLM_API_KEY || env.LLM_API_KEY || "").trim();
	const defaultModel = (
		env.CHANCELLOR_LLM_MODEL ||
		env.LLM_MODEL ||
		POOL_DEFAULT_MODEL
	).trim();
	const baseUrl = (
		env.CHANCELLOR_LLM_BASE_URL ||
		env.LLM_BASE_URL ||
		"https://dashscope.aliyuncs.com/compatible-mode/v1"
	).replace(/\/+$/, "");
	return { faux, baseUrl, apiKey, defaultModel };
}

function modelSpec(
	modelId: string,
	baseUrl: string,
	contextWindow = 131_072,
): Model<"openai-completions"> {
	return {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: POOL_PROVIDER_ID,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		// 输出上限刻意压到 4096：池内干的是"改文件 / 写 REPORT"，不是长文创作；
		// 给太大主要是在放大单轮成本，不给用户造成任何可见差异。
		maxTokens: 4096,
	};
}

/**
 * 把 models 里的 provider 重新配置成这一票要用的模型，返回 createConversation 要的 model ref。
 * 每票开始时调一次（同一个 Models 对象可反复 setProvider 覆盖）。
 *
 * `route` 来自派单快照（`EmployeeProfile.modelRoute`，2026-11-19 模型分工）：跨供应商时
 * `baseUrl` 换成该供应商端点、key 从 `process.env[keyEnv]` 现读。**密钥值不经 HTTP 传输**，
 * 池进程只收到变量名。没给 route = 用启动 env 的 LLM_BASE_URL / LLM_API_KEY。
 */
export function configurePoolModel(
	models: PoolModels,
	modelId: string | undefined,
	env: Env = process.env,
	route?: { baseUrl: string; keyEnv: string },
	contextWindow = 131_072,
): PoolModelTarget {
	const cfg = poolLlmConfig(env);
	const id = (modelId ?? "").trim() || cfg.defaultModel;

	if (cfg.faux) {
		// faux 由 createPoolModels 装好；这里只回它的 model ref，不再 setProvider。
		return fauxRef ?? { provider: fauxProvider({ models: [{ id: "faux" }] }).provider.id, modelId: "faux" };
	}

	const baseUrl = route?.baseUrl?.trim().replace(/\/+$/, "") || cfg.baseUrl;
	const routeKey = route?.keyEnv ? (env[route.keyEnv] ?? "").trim() : "";
	const apiKeyEnvNames = route?.keyEnv
		? [route.keyEnv, "CHANCELLOR_LLM_API_KEY", "LLM_API_KEY"]
		: ["CHANCELLOR_LLM_API_KEY", "LLM_API_KEY"];
	if (!routeKey && !cfg.apiKey) {
		throw new Error(
			`LLM_API_KEY 未配置：池进程需要真实模型（route keyEnv=${route?.keyEnv ?? "未指定"}）；没有 key 时用 LLM_PROVIDER=faux`,
		);
	}

	models.setProvider(
		createProvider({
			id: POOL_PROVIDER_ID,
			name: "池（OpenAI 兼容）",
			baseUrl,
			auth: {
				apiKey: envApiKeyAuth("池 API key", apiKeyEnvNames),
			},
			models: [modelSpec(id, baseUrl, contextWindow)],
			api: openAICompletionsApi(),
		}),
	);
	return { provider: POOL_PROVIDER_ID, modelId: id };
}

/**
 * 造一个 Models + 一个默认 model ref（进程启动时调一次）。
 *
 * faux 模式额外返回 `armFaux`：**每票开工前用它换一次脚本**。faux 的
 * `setResponses` 只替换待发队列、不重置 `callCount`，而池进程跨票复用，
 * 所以必须按票重新装一份工厂实例（工厂自己数步数，见 `poolFauxResponseFactory`）。
 */
export function createPoolModels(
	env: Env = process.env,
	fauxFactory?: FauxResponseFactory,
): {
	models: PoolModels;
	defaultModelId: string;
	armFaux?: (factory: FauxResponseFactory) => void;
} {
	const cfg = poolLlmConfig(env);
	const models = createModels();

	if (cfg.faux) {
		const fp = fauxProvider({ models: [{ id: "faux" }], tokensPerSecond: 120 });
		const armFaux = (factory: FauxResponseFactory): void => {
			fp.setResponses(Array.from({ length: 200 }, () => factory));
		};
		if (fauxFactory) armFaux(fauxFactory);
		models.setProvider(fp.provider);
		const model = fp.getModel();
		fauxRef = { provider: model.provider, modelId: model.id };
		return { models, defaultModelId: "faux", armFaux };
	}

	// 真实分支不在启动时 setProvider——交给每票的 configurePoolModel，按那一票的模型覆盖。
	return { models, defaultModelId: cfg.defaultModel };
}

/**
 * faux 上游（自测）：第 1 次请求调 write 写 REPORT.md，第 2 次请求回一句话收尾。
 *
 * **步数用本工厂自己的闭包计数，不用 `state.callCount`**：faux 的 callCount 是
 * provider 级的进程累计，池进程跨票复用，第二票会从 3 开始、落到"收尾话"分支，
 * 结果第二票根本不写 REPORT（2026-11-22 冒烟实测踩到）。每票 `setupFauxForTicket`
 * 重新 `armFaux` 一次，工厂是新实例 → 步数从 1 开始。
 */
export function poolFauxResponseFactory(taskDirOf: () => string): FauxResponseFactory {
	let step = 0;
	const writeReport = (status: string, summary: string): ReturnType<typeof fauxAssistantMessage> => {
		const report = ["```json", JSON.stringify({ status, summary, artifacts: [] }), "```", ""].join("\n");
		return fauxAssistantMessage(
			[fauxToolCall("write", { path: `${taskDirOf()}/REPORT.md`, content: report })],
			{ stopReason: "toolUse" },
		);
	};
	const factory: FauxResponseFactory = () => {
		step += 1;
		const mode = process.env.WORKER_POOL_FAUX_MODE?.trim();

		// 续行自测：第 1 段写 waiting（非终态）→ 主循环应自动接续轮 → 第 2 段写 ready。
		if (mode === "continue") {
			if (step === 1) return writeReport("waiting", "第一段干完，还差一点");
			if (step === 2) return writeReport("ready", "续行后完成");
			return fauxAssistantMessage("（faux）续行脚本收尾");
		}

		// 上报自测：先 escalate → 写 waiting REPORT → 收尾等答复；
		// 答复（say）进来后主循环继续 → 第 4 步写 ready。
		if (mode === "escalate") {
			if (step === 1) {
				return fauxAssistantMessage(
					[
						fauxToolCall("escalate", {
							question: "目录结构选 A 还是 B？",
							context: "两种都可行，需要拍板。",
							urgency: "normal",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (step === 2) return writeReport("waiting", "已上报，等答复");
			if (step === 3) return fauxAssistantMessage("（faux）已上报，本轮收尾等答复");
			if (step === 4) return writeReport("ready", "收到答复后按 A 完成");
			return fauxAssistantMessage("（faux）上报脚本收尾");
		}

		if (step === 1) return writeReport("ready", "faux 票完成");
		// 自测用：`WORKER_POOL_FAUX_CALLS=N` → 第 2..N+1 步继续发 write。
		// - 默认每条路径不同（`probe-<n>.txt`）→ 验回合上限：N 大于上限时只落地前几条。
		// - `WORKER_POOL_FAUX_SPAM=1` 时每条**同名同内容** → 指纹相同，验防打转。
		const extra = Number(process.env.WORKER_POOL_FAUX_CALLS ?? 0);
		if (Number.isFinite(extra) && step <= extra + 1) {
			const spam = process.env.WORKER_POOL_FAUX_SPAM?.trim() === "1";
			if (spam) {
				// 指纹必须完全一样：同命令、同输出。`>>` 追加让执行次数可数（数行数）。
				return fauxAssistantMessage(
					[fauxToolCall("bash", { command: "echo x >> counter.txt" })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage(
				[fauxToolCall("write", { path: `${taskDirOf()}/probe-${step - 1}.txt`, content: `probe ${step - 1}` })],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("（faux）已写 REPORT");
	};
	return factory;
}