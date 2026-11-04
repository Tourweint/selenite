import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
	type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ThinkingLevelSchema, type ThinkingLevel } from "@lifediary/shared";
import { z } from "zod";
import { KEY_ENV_PATTERN, removeProviderKeys, writeProviderKey } from "./provider-secrets.ts";

/**
 * 模型接入（2026-11-04 批次五重写）。
 *
 * 模型不再是"一个 env 里的模型名"，而是**供应商 + 模型**：
 * `.data/providers.json` 存供应商清单（只存 keyEnv 变量名，绝不存密钥值），
 * 会话与运行时选择存 `ModelRef = { providerId, modelId }`。
 *
 * 目录的生命周期（审查 S2 定死）：
 *   - `Models` 是**单例**，Harness 拿到的是 `currentModels` 这个访问器（每个使用点现调）；
 *   - 配置每次访问都查文件版本，变了才重建；绝不每请求重建，也绝不缓存陈旧目录；
 *   - 重建 = 与单例 diff → setProvider / deleteProvider 原子应用，顺手清掉基座已消失的派生模型。
 *
 * 身份比较也是成对的（审查 S1）：同名模型跨供应商必须当换模型处理，
 * 否则 `providerId` 不同、`modelId` 相同会被误判成"没变"，切换成了空操作。
 */

const DEFAULT_PROVIDER_ID = "bailian";
const DEFAULT_MODEL = "deepseek-v4.1-flash";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** 自定义供应商暂不区分窗口：沿用现状硬编码值（接口文档 §2.10） */
const CUSTOM_CONTEXT_WINDOW = 131_072;
const CUSTOM_MAX_TOKENS = 4096;

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_PROVIDER_IDS = new Set(["faux", "mock"]);
/** 这些字段写进 providers.json 就整份拒绝：密钥值只能待在 .env */
const FORBIDDEN_FIELDS = new Set(["apiKey", "key", "headers"]);

/**
 * 思考档位（2026-11-04 思考档位方案 D2）：
 * - 缺省支持域 = `["off","low","high"]`，**刻意不含 medium**（glm-5.3 实测 400）；
 * - 序是 `off < low < medium < high`，换模型回退按这个序取"≤ 当前档的最高档"。
 */
const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "high"];
const THINKING_LEVEL_ORDER: ThinkingLevel[] = ["off", "low", "medium", "high"];
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVEL_ORDER);

// ── 类型 ─────────────────────────────────────────────────

/** 会话与 durable 用的模型引用（字段名跟内核一致） */
export interface ModelRef {
	provider: string;
	modelId: string;
}

/** 对外接口用的模型引用（接口文档 §2.8） */
export interface PublicModelRef {
	providerId: string;
	modelId: string;
}

export interface LlmConfig {
	/** 当前选中的模型（深档；快/深同款，D1 不变） */
	model: ModelRef;
	/**
	 * 部署别名（`LLM_MODEL_FAST`）：**不入 providers.json**，仍从 env 读。
	 * D1 之后快/深同款，这个字段只剩兼容意义；env 为空时跟随 `model`。
	 */
	fastModel: ModelRef;
}

export interface ProviderEntry {
	id: string;
	name: string;
	baseUrl: string;
	keyEnv: string;
	models: string[];
	/**
	 * 每模型支持的思考档（键 = modelId）。可选：旧文件没有就是缺省域。
	 * 用供应商级 record 而不是改 `models[]` 的形状，对 `.strict()` 侵入最小（方案 D9）。
	 */
	modelThinkingLevels?: Record<string, ThinkingLevel[]>;
	createdAt: string;
}

interface ProvidersDocument {
	schemaVersion: 1;
	providers: ProviderEntry[];
	defaultSelection: PublicModelRef | null;
}

/** 设置页投影用的行：清单仍是扁平字符串（脚本与表单只认 id） */
export interface ProviderSummary {
	id: string;
	name: string;
	models: string[];
	hasKey: boolean;
}

export interface ProviderDetail extends ProviderSummary {
	baseUrl: string;
	keyEnv: string;
	isDefault: boolean;
}

/** composer 投影的模型行（2026-11-04 思考档位方案 D9）：UI 要逐模型支持域才能渲染选择器 */
export interface CatalogModel {
	id: string;
	thinkingLevels: ThinkingLevel[];
}

export interface CatalogProvider {
	id: string;
	name: string;
	models: CatalogModel[];
	hasKey: boolean;
}

export interface ModelCatalog {
	current: PublicModelRef | null;
	providers: CatalogProvider[];
}

// ── 校验 ─────────────────────────────────────────────────

const SelectionSchema = z
	.object({
		providerId: z.string().trim().min(1),
		modelId: z.string().trim().min(1),
	})
	.strict();

const ProviderEntrySchema = z
	.object({
		id: z.string().regex(PROVIDER_ID_PATTERN),
		name: z.string().trim().min(1).max(80),
		baseUrl: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.refine((value) => validBaseUrl(value), "baseUrl 需要 http/https 绝对地址"),
		keyEnv: z.string().regex(KEY_ENV_PATTERN),
		models: z.array(z.string().trim().min(1).max(200)).min(1),
		// 只校验"是字符串数组"，具体档位在 parseProvidersFile 里过滤：
		// 一个拼错的档位名不该让整份配置读不了（旧文件兼容，方案 D2）
		modelThinkingLevels: z.record(z.string(), z.array(z.string())).optional(),
		createdAt: z.string().min(1),
	})
	.strict();

const ProvidersFileSchema = z
	.object({
		schemaVersion: z.literal(1),
		providers: z.array(ProviderEntrySchema),
		defaultSelection: SelectionSchema.nullable(),
	})
	.strict();

/** `.strict()` 报的是 unrecognized_keys；这里显式点名，错误信息才说得清"只能填变量名" */
function assertNoSecretFields(raw: unknown, path = "providers.json"): void {
	if (!raw || typeof raw !== "object") return;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (FORBIDDEN_FIELDS.has(key)) {
			throw new Error(
				`${path}.${key} 不允许出现：这里只存环境变量名（keyEnv），密钥值请放 .env`,
			);
		}
		assertNoSecretFields(value, `${path}.${key}`);
	}
}

function parseProvidersFile(text: string): ProvidersDocument {
	const raw = JSON.parse(text) as unknown;
	assertNoSecretFields(raw);
	const parsed = ProvidersFileSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
	}
	const document: ProvidersDocument = {
		schemaVersion: 1,
		providers: parsed.data.providers.map(({ modelThinkingLevels, ...entry }) => {
			const levels = modelThinkingLevels
				? normalizeThinkingLevels(modelThinkingLevels, entry.models)
				: {};
			return {
				...entry,
				models: dedupe(entry.models),
				...(Object.keys(levels).length > 0 ? { modelThinkingLevels: levels } : {}),
			};
		}),
		defaultSelection: parsed.data.defaultSelection,
	};
	if (document.providers.some((entry) => RESERVED_PROVIDER_IDS.has(entry.id))) {
		throw new Error("供应商 id 不能用保留字 faux / mock");
	}
	return document;
}

// ── 文件位置与原子写 ──────────────────────────────────────

function providersPath(): string {
	return process.env.PROVIDERS_PATH?.trim() || ".data/providers.json";
}

function runtimeStatePath(): string {
	return process.env.MODEL_RUNTIME_PATH?.trim() || ".data/runtime.json";
}

/** 回滚开关：false = 忽略 providers.json、不播种、纯 env（接口文档 §2.10） */
export function providersConfigEnabled(): boolean {
	return (process.env.PROVIDERS_CONFIG ?? "").trim().toLowerCase() !== "false";
}

/**
 * 回滚开关（2026-11-05 密钥直填）：false = 端点一律 400 `secrets_disabled`。
 * 启动注入不受它影响——文件里已有的 key 照常生效，只是界面不能再写。
 */
export function providerSecretsEnabled(): boolean {
	return (process.env.PROVIDER_SECRETS ?? "").trim().toLowerCase() !== "false";
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temp, path);
}

function fileSignature(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

function dedupe(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** 过滤非法档位值（拼错的名字丢掉而不是整份拒绝），按档位序排好 */
function normalizeThinkingLevels(
	raw: Record<string, string[]>,
	models: string[],
): Record<string, ThinkingLevel[]> {
	const normalized: Record<string, ThinkingLevel[]> = {};
	for (const [modelId, levels] of Object.entries(raw)) {
		if (!models.includes(modelId)) continue;
		const kept = new Set<ThinkingLevel>();
		for (const value of levels) {
			const level = value.trim().toLowerCase();
			if (THINKING_LEVEL_SET.has(level)) kept.add(level as ThinkingLevel);
		}
		const ordered = THINKING_LEVEL_ORDER.filter((level) => kept.has(level));
		// 过滤后为空 = 没声明过，按缺省域处理（不写进文件形状）
		if (ordered.length > 0) normalized[modelId] = ordered;
	}
	return normalized;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── env 派生 / 播种 ──────────────────────────────────────

function isFaux(): boolean {
	return (process.env.LLM_PROVIDER ?? "").trim().toLowerCase() === "faux";
}
export { isFaux };

function envModelId(): string {
	return process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
}

function envBaseUrl(): string {
	return (process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** env 清单：`LLM_MODELS` 逗号分隔；没配 = 只有当前模型（选择器退化成只读行） */
function declaredModelIds(envId: string): string[] {
	const list = (process.env.LLM_MODELS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return dedupe(list.includes(envId) ? list : [envId, ...list]);
}

/** env 派生的一份供应商（不落盘）：播种失败、文件被删、`PROVIDERS_CONFIG=false` 都走它 */
function envDocument(): ProvidersDocument | null {
	if (isFaux()) return null;
	if (!process.env.LLM_API_KEY?.trim()) return null;
	const modelId = envModelId();
	return {
		schemaVersion: 1,
		providers: [
			{
				id: DEFAULT_PROVIDER_ID,
				name: "默认供应商",
				baseUrl: envBaseUrl(),
				keyEnv: "LLM_API_KEY",
				models: declaredModelIds(modelId),
				createdAt: new Date().toISOString(),
			},
		],
		defaultSelection: { providerId: DEFAULT_PROVIDER_ID, modelId },
	};
}

/** 首启播种：faux / 无 key 不播种，免得探针与 mock 环境生成假配置 */
function seedDocument(): ProvidersDocument | null {
	const base = envDocument();
	if (!base) return null;
	const seeded = base.providers[0];
	if (seeded) seeded.name = envBaseUrl().includes("dashscope") ? "百炼" : "默认供应商";
	return base;
}

// ── 目录状态 ─────────────────────────────────────────────

let document: ProvidersDocument | null = null;
let documentLoaded = false;
/** 当前 document 对应的文件签名（或 "env" / "missing"） */
let documentSignature: string | null = null;
/** 启动时文件损坏 → 回退 env 后记下签名，别每次访问都重复解析同一份坏文件 */
let warnedSignature: string | null = null;
/** 目录代数：文件变化 / 派生模型增删都 +1；`builtRevision` 落后就重建 */
let revision = 0;
let builtRevision = -1;
let singleton: ReturnType<typeof createModels> | null = null;

interface VariantSpec {
	/** 派生模型 id（`<真实模型>#think-<档>` / `<真实模型>#t0.4m4000r…`） */
	id: string;
	providerId: string;
	/** 基座模型：基座没了，派生模型也一起清掉 */
	baseModelId: string;
	samplingParams: Record<string, unknown>;
}
/** 派生模型按 `${providerId}|${id}` 存：同名模型跨供应商不能共用一个键（审查 S1） */
const variantSpecs = new Map<string, VariantSpec>();

function variantKey(providerId: string, id: string): string {
	return `${providerId}|${id}`;
}

/** `models()` 传给 Harness 的访问器：先查文件版本，没变直接返回单例（审查 S2） */
export function currentModels(): Models {
	if (isFaux()) return fauxModels();
	ensureDocument();
	if (!document) {
		if (!singleton) singleton = createModels();
		return singleton;
	}
	if (!singleton) singleton = createModels();
	if (builtRevision !== revision) rebuild();
	return singleton;
}

function rebuild(): void {
	const doc = document;
	const models = singleton ?? (singleton = createModels());
	if (!doc) return;

	// 基座已消失的派生模型先清掉（供应商被删 / 模型被移出清单）
	for (const [key, spec] of variantSpecs) {
		const entry = doc.providers.find((provider) => provider.id === spec.providerId);
		if (!entry || !entry.models.includes(spec.baseModelId)) variantSpecs.delete(key);
	}

	const desired = new Map<string, Provider>();
	for (const entry of doc.providers) desired.set(entry.id, buildProvider(entry));

	for (const provider of models.getProviders()) {
		if (!desired.has(provider.id)) models.deleteProvider(provider.id);
	}
	for (const provider of desired.values()) models.setProvider(provider);
	builtRevision = revision;
}

function buildModel(entry: ProviderEntry, modelId: string): Model<"openai-completions"> {
	return {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: entry.id,
		baseUrl: entry.baseUrl,
		reasoning: false,
		input: ["text"],
		// 单价填 0：用量按 token 计数，不假装知道人民币价格
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CUSTOM_CONTEXT_WINDOW,
		maxTokens: CUSTOM_MAX_TOKENS,
	};
}

function buildProvider(entry: ProviderEntry): Provider {
	const models = entry.models.map((modelId) => buildModel(entry, modelId));
	for (const spec of variantSpecs.values()) {
		if (spec.providerId !== entry.id) continue;
		const base = models.find((model) => model.id === spec.baseModelId);
		if (!base) continue;
		models.push({
			...(base as Model<"openai-completions">),
			id: spec.id,
			name: spec.id,
			samplingParams: spec.samplingParams,
		});
	}
	return createProvider({
		id: entry.id,
		name: entry.name,
		baseUrl: entry.baseUrl,
		// 每次解析都读 env：换 key 不用重启，也永远不会把值写进配置
		auth: { apiKey: envApiKeyAuth(`${entry.name} API key`, [entry.keyEnv]) },
		models,
		api: openAICompletionsApi(),
	});
}

/** 文件变没变：变了才重载；运行期坏文件保留上一份可用配置（不静默换端点） */
function ensureDocument(): void {
	if (!providersConfigEnabled()) {
		if (documentSignature !== "env") {
			document = envDocument();
			documentLoaded = true;
			documentSignature = "env";
			revision += 1;
		}
		return;
	}

	const path = providersPath();
	const signature = fileSignature(path);
	if (documentLoaded && signature === documentSignature) return;

	if (signature === "missing") {
		if (!documentLoaded) {
			// 首启：能播种就播种，播不了就按 env 跑（或 mock）
			const seeded = seedDocument();
			if (seeded) {
				try {
					writeJsonAtomic(path, seeded);
					document = seeded;
					documentSignature = fileSignature(path);
					documentLoaded = true;
					revision += 1;
					console.log(`[provider] 已按 env 播种 ${path}（env 仅播种，此后以文件为准）`);
					return;
				} catch (error) {
					console.warn(
						`[provider] 播种 ${path} 失败，本次回退 env-only: ${errorText(error)}`,
					);
				}
			}
			document = envDocument();
			documentLoaded = true;
			documentSignature = "missing";
			revision += 1;
			return;
		}
		// 运行期文件被删：env 接管（不重新播种，避免"删了又长回来"）
		document = envDocument();
		documentLoaded = true;
		documentSignature = "missing";
		revision += 1;
		return;
	}

	try {
		document = parseProvidersFile(readFileSync(path, "utf8"));
		documentLoaded = true;
		documentSignature = signature;
		warnedSignature = null;
		revision += 1;
	} catch (error) {
		const detail = errorText(error);
		if (warnedSignature !== signature) {
			warnedSignature = signature;
			console.error(
				`[provider] ${path} 不可用（${detail}）；${documentLoaded ? "保留上一份配置" : "本次回退 env-only"}`,
			);
		}
		if (documentLoaded) return; // 运行期：上一份配置继续用
		document = envDocument();
		documentLoaded = true;
		documentSignature = signature;
		revision += 1;
	}
}

// ── 运行时选择 ───────────────────────────────────────────

let storedSignature: string | null = null;
let storedLoaded = false;
let storedSelection: PublicModelRef | null = null;

/** 回滚开关：`MODEL_RUNTIME_OVERRIDE=false` = 关闭运行时切模型（接口拒绝 + 启动忽略选择） */
export function modelOverrideEnabled(): boolean {
	return (process.env.MODEL_RUNTIME_OVERRIDE ?? "").trim().toLowerCase() !== "false";
}

/** 读运行时选择；旧版裸 id 按默认供应商解释（接口文档 §2.8） */
function readStoredSelection(): PublicModelRef | null {
	const path = runtimeStatePath();
	const signature = fileSignature(path);
	if (storedLoaded && signature === storedSignature) return storedSelection;
	storedLoaded = true;
	storedSignature = signature;

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown };
		const raw = parsed.model;
		if (raw && typeof raw === "object") {
			const ref = raw as { providerId?: unknown; modelId?: unknown };
			if (typeof ref.providerId === "string" && typeof ref.modelId === "string") {
				storedSelection = { providerId: ref.providerId.trim(), modelId: ref.modelId.trim() };
				return storedSelection;
			}
		}
		if (typeof raw === "string" && raw.trim()) {
			const providerId = document?.defaultSelection?.providerId ?? document?.providers[0]?.id;
			storedSelection = providerId ? { providerId, modelId: raw.trim() } : null;
			return storedSelection;
		}
		storedSelection = null;
	} catch {
		storedSelection = null; // 没有覆盖值 / 坏了都当没有，文件默认接管
	}
	return storedSelection;
}

function selectionValid(ref: PublicModelRef | null): boolean {
	if (!ref || !document) return false;
	const entry = document.providers.find((provider) => provider.id === ref.providerId);
	return Boolean(entry?.models.includes(ref.modelId));
}

/** 优先级：runtime.json > defaultSelection > 第一个供应商的第一个模型 */
function resolveSelection(): PublicModelRef | null {
	if (!document) return null;
	const stored = modelOverrideEnabled() ? readStoredSelection() : null;
	if (selectionValid(stored)) return stored;
	if (selectionValid(document.defaultSelection)) return document.defaultSelection;
	const first = document.providers.find((entry) => entry.models.length > 0);
	return first ? { providerId: first.id, modelId: first.models[0] } : null;
}

function fastModelIdOf(modelId: string): string {
	// 部署别名只从 env 读，不写进 providers.json（接口文档 §2.10）；空则跟随当前模型
	return process.env.LLM_MODEL_FAST?.trim() || modelId;
}

function writeStoredSelection(ref: PublicModelRef): void {
	try {
		writeJsonAtomic(runtimeStatePath(), {
			model: { providerId: ref.providerId, modelId: ref.modelId },
			at: new Date().toISOString(),
		});
		storedSelection = ref;
		storedLoaded = true;
		storedSignature = fileSignature(runtimeStatePath());
	} catch (error) {
		// 写不进去只影响"重启后是否记得"，本轮已经生效，不当致命错误
		console.warn(
			`[model] 选择写不进 ${runtimeStatePath()}: ${errorText(error)}`,
		);
	}
}

/**
 * 当前模型配置。返回 null = 未配置（mock 流）。
 *
 * 注意：`providerId` 与 `modelId` 必须成对看待。只比 `modelId` 会把
 * "同名模型换供应商"误判成没变（审查 S1）。
 */
export function readLlmConfig(): LlmConfig | null {
	if (isFaux()) return fauxConfig();
	ensureDocument();
	if (!document) return null;
	const selected = resolveSelection();
	if (!selected) return null;
	const provider = document.providers.find((entry) => entry.id === selected.providerId);
	if (!provider) return null;
	return {
		model: { provider: selected.providerId, modelId: selected.modelId },
		fastModel: {
			provider: selected.providerId,
			modelId: fastModelIdOf(selected.modelId),
		},
	};
}

// ── 派生模型 ─────────────────────────────────────────────

/**
 * 聊天档位的**思考变体**（2026-11-04 思考档位方案 D1/D3）。
 *
 * 档位不靠换模型（换模型 = 上游缓存清零），而是**同一个模型的四条思考变体**：
 * `off → enable_thinking:false`；`low/medium/high → reasoning_effort:<档>`。
 * 透传手段与任务派生模型同款：`samplingParams` 的键原样合并进上游请求体、且最后写入，
 * `model` 盖回真实模型名（派生 id 漏到上游就 404）。
 * 支持域校验在调用方（/mode 直接 400；X-Mode / D3 按 `clampThinkingLevel` 落回）。
 */
export function chatModelRef(thinking: ThinkingLevel): ModelRef {
	const config = readLlmConfig();
	if (!config) throw new Error("LLM 未配置");
	if (isFaux()) return config.model;

	const { provider, modelId } = config.model;
	const id = `${modelId}#think-${thinking}`;
	const key = variantKey(provider, id);
	if (!variantSpecs.has(key)) {
		const base = currentModels().getModel(provider, modelId);
		if (!base) throw new Error("聊天模型不在目录里，无法派生思考变体");
		variantSpecs.set(key, {
			id,
			providerId: provider,
			baseModelId: modelId,
			// `model` 盖回真实模型名；思考档显式声明，不赌上游默认值。
			// 两档形状不同：off 只发 enable_thinking:false，其余只发 reasoning_effort
			// （同时带两个会让上游按自己的优先级挑，档位就不可预测了）
			samplingParams:
				thinking === "off"
					? { model: modelId, enable_thinking: false }
					: { model: modelId, reasoning_effort: thinking },
		});
		revision += 1;
		currentModels(); // 立刻把新变体发布进单例
	}
	return { provider, modelId: id };
}

/** 某模型支持的思考档：providers.json 声明优先，缺省 `["off","low","high"]` */
export function thinkingLevelsFor(providerId: string, modelId: string): ThinkingLevel[] {
	const entry = document?.providers.find((provider) => provider.id === providerId);
	const declared = entry?.modelThinkingLevels?.[modelId];
	return declared && declared.length > 0 ? [...declared] : [...DEFAULT_THINKING_LEVELS];
}

/** 当前选中模型的支持域（/mode 校验、换模型回退都用它） */
export function currentThinkingLevels(): ThinkingLevel[] {
	const config = readLlmConfig();
	if (!config) return [...DEFAULT_THINKING_LEVELS];
	return thinkingLevelsFor(config.model.provider, config.model.modelId);
}

/**
 * 落回支持域内 **≤ 目标档的最高档**（序 `off < low < medium < high`），没有就 `off` 兜底。
 * 2026-11-04 思考档位 D8：换模型 / X-Mode / D3 目标档越界时用，不靠报错把用户卡住。
 */
export function clampThinkingLevel(level: ThinkingLevel, domain: ThinkingLevel[]): ThinkingLevel {
	const supported = domain.length > 0 ? domain : DEFAULT_THINKING_LEVELS;
	for (let index = THINKING_LEVEL_ORDER.indexOf(level); index >= 0; index -= 1) {
		const candidate = THINKING_LEVEL_ORDER[index];
		if (candidate && supported.includes(candidate)) return candidate;
	}
	return "off";
}

// ── 思考档自动探活（2026-11-04 D1）───────────────────────

/**
 * 从没声明过档位的模型，切过去时后台试一遍真实支持域。
 *
 * 判定口径（任务书 §2.1）：
 *   - 2xx → 支持；
 *   - 400/404/422 且错误体提到 reasoning/effort/thinking/InvalidParameter/invalid → 不支持；
 *   - 其他（5xx/认证/网络/超时）→ **未知**，一个未知就整份不写（写一半等于撒谎），UI 走缺省域。
 *
 * `off` 不探：`enable_thinking:false` 是兼容基线，一律视为支持。
 * 探活只读 providers.json 里的 baseUrl / keyEnv，密钥现读 env，绝不落盘、绝不进日志。
 */
const PROBE_LEVELS: ThinkingLevel[] = ["low", "medium", "high"];
const PROBE_TIMEOUT_MS = 8_000;
/** 同一时刻最多两个模型的探活（串行跑档位）；超出的排队，避免上游限流连坐 */
const PROBE_MAX_CONCURRENT = 2;
/** 错误体里出现这些词 = 上游在抱怨思考档（大小写不敏感） */
const PROBE_REJECT_PATTERN = /reasoning|effort|thinking|invalidparameter|invalid/i;

type ProbeVerdict =
	| { kind: "ok" }
	| { kind: "rejected"; status: number; reason: string }
	| { kind: "unknown"; cause: string };

/** 回滚开关：false = 完全不探不写（UI 走缺省域） */
export function thinkingProbeEnabled(): boolean {
	return (process.env.MODEL_PROBE_LEVELS ?? "").trim().toLowerCase() !== "false";
}

/** 错误体里的命中词只用于日志枚举；`InvalidParameter` 归一成 `invalid_parameter` */
function normalizeProbeReason(value: string): string {
	const lower = value.trim().toLowerCase();
	if (lower === "invalidparameter") return "invalid_parameter";
	return lower.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "invalid";
}

/** 优先取结构化 error.code（上游多半有），没有再看命中词 */
function probeReasonOf(body: string): string | null {
	const code = /"code"\s*:\s*"([^"]+)"/i.exec(body)?.[1];
	if (code && PROBE_REJECT_PATTERN.test(code)) return normalizeProbeReason(code);
	const hit = PROBE_REJECT_PATTERN.exec(body)?.[0];
	return hit ? normalizeProbeReason(hit) : null;
}

async function probeLevel(
	entry: ProviderEntry,
	modelId: string,
	level: ThinkingLevel,
): Promise<ProbeVerdict> {
	const key = process.env[entry.keyEnv]?.trim();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`${entry.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(key ? { authorization: `Bearer ${key}` } : {}),
			},
			body: JSON.stringify({
				model: modelId,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 16,
				reasoning_effort: level,
				stream: false,
			}),
			signal: controller.signal,
		});
		if (response.ok) {
			// 只要状态码；正文丢弃（最多是个 pong，不记内容）
			await response.text().catch(() => "");
			return { kind: "ok" };
		}
		// 错误体最多读 2KB：只用来匹配枚举词，绝不写进日志
		const body = (await response.text().catch(() => "")).slice(0, 2_000);
		if (response.status === 400 || response.status === 404 || response.status === 422) {
			const reason = probeReasonOf(body);
			if (reason) return { kind: "rejected", status: response.status, reason };
		}
		return { kind: "unknown", cause: `http_${response.status}` };
	} catch {
		return { kind: "unknown", cause: controller.signal.aborted ? "timeout" : "network" };
	} finally {
		clearTimeout(timer);
	}
}

let activeProbes = 0;
const waitingProbes: (() => void)[] = [];

/** 模型级并发闸：最多两个在探，其余排队（同模型已在 Map 里，不会重复入队） */
async function withProbeSlot<T>(run: () => Promise<T>): Promise<T> {
	if (activeProbes >= PROBE_MAX_CONCURRENT) {
		await new Promise<void>((resolve) => waitingProbes.push(resolve));
	}
	activeProbes += 1;
	try {
		return await run();
	} finally {
		activeProbes -= 1;
		waitingProbes.shift()?.();
	}
}

/** 进行中的探活（键 = provider|model）：同模型并发切换只探一次 */
const probeTasks = new Map<string, Promise<void>>();

function describeVerdict(verdict: ProbeVerdict): string {
	if (verdict.kind === "ok") return "ok";
	if (verdict.kind === "rejected") return `rejected(${verdict.status} ${verdict.reason})`;
	return `unknown(${verdict.cause})`;
}

/** 探完落盘；任何异常只记日志，绝不外抛到聊天主链路 */
async function probeAndPersist(providerId: string, modelId: string): Promise<void> {
	const verdicts = new Map<ThinkingLevel, ProbeVerdict>();
	let entry: ProviderEntry | undefined;
	for (const level of PROBE_LEVELS) {
		// 每档前重读：用户可能在探活期间改了地址 / 删了模型
		ensureDocument();
		entry = document?.providers.find((provider) => provider.id === providerId);
		if (!entry || !entry.models.includes(modelId)) return;
		verdicts.set(level, await probeLevel(entry, modelId, level));
	}

	const summary = PROBE_LEVELS.map(
		(level) => `${level}=${describeVerdict(verdicts.get(level)!)}`,
	).join(" ");
	const unknown = PROBE_LEVELS.filter((level) => verdicts.get(level)?.kind === "unknown");
	if (unknown.length > 0) {
		// 未知不等于不支持：宁可不写，让 UI 按缺省域兜底
		console.log(`[probe] ${providerId}/${modelId} ${summary} -> 未写入(unknown)`);
		return;
	}

	// 落盘前再确认一次：期间可能已被声明（声明 = 事实源，永不覆盖）
	ensureDocument();
	const latest = document?.providers.find((provider) => provider.id === providerId);
	if (!latest || !latest.models.includes(modelId)) return;
	const declared = latest.modelThinkingLevels?.[modelId];
	if (declared && declared.length > 0) {
		console.log(
			`[probe] ${providerId}/${modelId} ${summary} -> 已声明(${JSON.stringify(declared)})，不覆盖`,
		);
		return;
	}

	const supported = new Set(
		PROBE_LEVELS.filter((level) => verdicts.get(level)?.kind === "ok"),
	);
	const levels = THINKING_LEVEL_ORDER.filter(
		(level) => level === "off" || supported.has(level),
	);
	const next: ProvidersDocument = {
		...document!,
		providers: document!.providers.map((provider) =>
			provider.id === providerId
				? {
						...provider,
						modelThinkingLevels: {
							...(provider.modelThinkingLevels ?? {}),
							[modelId]: levels,
						},
					}
				: provider,
		),
	};
	persistDocument(next);
	console.log(`[probe] ${providerId}/${modelId} ${summary} -> ${JSON.stringify(levels)}`);
}

/**
 * 切模型成功后的后台触发（任务书 §2.3）。
 *
 * 不阻塞响应、不返回结果：写盘后下一次打开菜单 / 对齐会话自然按新声明走。
 * 已声明 / faux / `PROVIDERS_CONFIG=false` / 没有 key 的供应商一律跳过；
 * 同模型并发只探一次（in-flight Map）。
 */
export function scheduleThinkingProbe(providerId: string, modelId: string): void {
	if (!thinkingProbeEnabled() || isFaux() || !providersConfigEnabled()) return;
	const key = variantKey(providerId, modelId);
	if (probeTasks.has(key)) return;

	ensureDocument();
	// env 派生（文件缺失 / 运行期被删）没有落盘目标：探了也写不了，
	// 更不能顺手把文件"种"回来（ensureDocument 的既有口径）
	if (!document || documentSignature === "missing" || documentSignature === "env") return;
	const entry = document.providers.find((provider) => provider.id === providerId);
	if (!entry || !entry.models.includes(modelId)) return;
	// 声明 = 事实源：探过就不再探
	if ((entry.modelThinkingLevels?.[modelId]?.length ?? 0) > 0) return;
	if (!hasKey(entry)) {
		console.log(`[probe] ${providerId}/${modelId} skip(no-key)`);
		return;
	}

	const task = withProbeSlot(() => probeAndPersist(providerId, modelId))
		.catch((error) => {
			// 探活失败永不影响聊天；原始错误只进服务端日志
			console.warn(`[probe] ${providerId}/${modelId} 异常（忽略）: ${errorText(error)}`);
		})
		.finally(() => {
			probeTasks.delete(key);
		});
	probeTasks.set(key, task);
}

/**
 * 从会话里存的模型引用读档位（`<模型>#think-<档>`）。
 *
 * 旧后缀读兼容（方案 D3）：`#think-on` 按 `high`、`#think-off` 按 `off`；
 * 不带后缀（更早的会话）返回 null，由调用方按粘性/默认处理。
 */
export function levelFromModelId(modelId: string): ThinkingLevel | null {
	const suffix = /#think-([a-z]+)$/.exec(modelId)?.[1];
	if (!suffix) return null;
	if (suffix === "on") return "high";
	return THINKING_LEVEL_SET.has(suffix) ? (suffix as ThinkingLevel) : null;
}

export interface TaskSampling {
	temperature?: number;
	maxTokens?: number;
	responseFormat?: unknown;
}

/** 参数 → 稳定后缀。同参数复用同一个派生模型，避免每次请求都往目录里塞新模型 */
function variantSuffix(params: TaskSampling): string {
	const temperature = typeof params.temperature === "number" ? params.temperature : "-";
	const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : "-";
	const format = params.responseFormat ? String(JSON.stringify(params.responseFormat)) : "-";
	// 只取哈希的前 8 位：够区分，也不会把整段 JSON 塞进模型 id
	const digest = createHash("sha256").update(format).digest("hex").slice(0, 8);
	// 任务一律思考开：把思考标志编进 id，避免同参数两种思考档互相覆盖
	return `t${temperature}m${maxTokens}r${format === "-" ? "-" : digest}th1`;
}

/**
 * 任务通道要用哪个模型引用：在当前模型上挂参数派生一份。
 *
 * - faux 模式只有一个模型、上游请求体也不存在 → 直接返回当前引用；
 * - 未配置 LLM → 抛错（调用方已经先判过 `readLlmConfig()`）。
 */
export function taskModelRef(params: TaskSampling): ModelRef {
	const config = readLlmConfig();
	if (!config) throw new Error("LLM 未配置");
	if (isFaux()) return config.model;

	const { provider, modelId } = config.model;
	const id = `${modelId}#${variantSuffix(params)}`;
	const key = variantKey(provider, id);
	if (!variantSpecs.has(key)) {
		const base = currentModels().getModel(provider, modelId);
		if (!base) throw new Error("当前模型不在目录里，无法派生任务模型");
		const samplingParams: Record<string, unknown> = {
			// 关键：派生模型只活在 harness 的模型目录里，**上游必须收到真实模型名**
			model: modelId,
			// 任务一律思考开：一次性会话无历史包袱，质量优先
			enable_thinking: true,
		};
		if (typeof params.temperature === "number") samplingParams.temperature = params.temperature;
		// max_tokens 也走 samplingParams：它最后写入，能盖掉模型自身的默认上限
		if (typeof params.maxTokens === "number") samplingParams.max_tokens = params.maxTokens;
		if (params.responseFormat) samplingParams.response_format = params.responseFormat;
		variantSpecs.set(key, { id, providerId: provider, baseModelId: modelId, samplingParams });
		revision += 1;
		currentModels();
	}
	return { provider, modelId: id };
}

// ── faux / mock ──────────────────────────────────────────

let faux: { models: Models; config: LlmConfig } | null = null;

function fauxConfig(): LlmConfig {
	if (faux) return faux.config;
	const provider = fauxProvider({ models: [{ id: "faux" }], tokensPerSecond: 120 });
	const models = createModels();
	models.setProvider(provider.provider);
	// 每次模型请求消耗一条；给足量，省得探针里还要续队列。
	// LLM_FAUX_TOOL 让它"只会调工具、永远不收尾"，专门用来验工具回合上限。
	// bash 要给一份合法参数：默认空对象过不了内核校验，审批探针根本走不到 beforeTool。
	const toolName = process.env.LLM_FAUX_TOOL?.trim();
	const fauxArgs: Record<string, string> =
		toolName === "recall"
			? { query: "faux" }
			: toolName === "bash"
				? { command: "sleep 2" }
				: {};
	const respond = () =>
		toolName
			? fauxAssistantMessage([fauxToolCall(toolName, fauxArgs)], { stopReason: "toolUse" })
			: fauxAssistantMessage("（faux 模型）链路已通。");
	provider.setResponses(Array.from({ length: 500 }, () => respond));
	const model = provider.getModel();
	const ref = { provider: model.provider, modelId: model.id };
	faux = { models, config: { model: ref, fastModel: ref } };
	return faux.config;
}

function fauxModels(): Models {
	fauxConfig();
	return faux!.models;
}

// ── 对外投影（接口文档 §2.8 / §2.10）────────────────────

function hasKey(entry: ProviderEntry): boolean {
	return Boolean(process.env[entry.keyEnv]?.trim());
}

/** composer 投影：不含 baseUrl / keyEnv / 任何密钥值 */
export function modelCatalog(): ModelCatalog {
	ensureDocument();
	if (isFaux()) {
		return {
			current: { providerId: "faux", modelId: "faux" },
			providers: (document?.providers ?? []).map(catalogOf),
		};
	}
	const config = readLlmConfig();
	return {
		current: config ? { providerId: config.model.provider, modelId: config.model.modelId } : null,
		providers: (document?.providers ?? []).map(catalogOf),
	};
}

/**
 * composer 的模型行（2026-11-04 思考档位）：`{ id, thinkingLevels }`。
 * 设置页与 POST /agent/model 仍是扁平字符串，别顺手统一——那会破旧字段兼容。
 */
function catalogOf(entry: ProviderEntry): CatalogProvider {
	return {
		id: entry.id,
		name: entry.name,
		models: entry.models.map((modelId) => ({
			id: modelId,
			thinkingLevels: thinkingLevelsFor(entry.id, modelId),
		})),
		hasKey: hasKey(entry),
	};
}

function summaryOf(entry: ProviderEntry): ProviderSummary {
	return { id: entry.id, name: entry.name, models: [...entry.models], hasKey: hasKey(entry) };
}

/** 设置页投影：回填编辑需要 baseUrl / keyEnv；仍无任何密钥值 */
export function providerCatalog(): {
	providers: ProviderDetail[];
	defaultSelection: PublicModelRef | null;
} {
	ensureDocument();
	const defaultId = document?.defaultSelection?.providerId ?? null;
	return {
		providers: (document?.providers ?? []).map((entry) => ({
			...summaryOf(entry),
			baseUrl: entry.baseUrl,
			keyEnv: entry.keyEnv,
			isDefault: entry.id === defaultId,
		})),
		defaultSelection: document?.defaultSelection ?? null,
	};
}

export interface RuntimeModelInfo {
	/** 当前生效的模型 id；未配置（mock 流）时是 null */
	model: string | null;
	/** /healthz 的扁平清单：默认供应商的模型；不可切 / faux / mock 时 [] */
	models: string[];
}

/** /healthz：`models` 语义收窄为"默认供应商的清单"（接口文档 §2.5） */
export function runtimeModelInfo(): RuntimeModelInfo {
	if (isFaux()) return { model: "faux", models: [] };
	const config = readLlmConfig();
	if (!config) return { model: null, models: [] };
	if (!modelOverrideEnabled()) return { model: config.model.modelId, models: [] };
	const defaultId = document?.defaultSelection?.providerId ?? document?.providers[0]?.id;
	const provider = document?.providers.find((entry) => entry.id === defaultId);
	return { model: config.model.modelId, models: provider ? [...provider.models] : [] };
}

export type SetModelResult =
	| { ok: true; model: string; provider: string; models: string[] }
	| {
			ok: false;
			reason:
				| "override_disabled"
				| "faux"
				| "llm_not_configured"
				| "unknown_provider"
				| "unknown_model";
			message: string;
	  };

/** 运行时切模型（接口文档 §2.8）。校验、生效、持久化都在这一处。 */
export function setRuntimeModel(input: { modelId: string; providerId?: string }): SetModelResult {
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
	ensureDocument();
	if (!document) {
		return {
			ok: false,
			reason: "llm_not_configured",
			message: "未配置 LLM_API_KEY（mock 流），没有模型可切",
		};
	}
	const providerId = input.providerId?.trim() || document.defaultSelection?.providerId;
	const entry = document.providers.find((provider) => provider.id === providerId);
	if (!providerId || !entry) {
		return {
			ok: false,
			reason: "unknown_provider",
			message: `没有这个供应商：${providerId ?? "（未指定默认供应商）"}`,
		};
	}
	const modelId = input.modelId.trim();
	if (!entry.models.includes(modelId)) {
		return {
			ok: false,
			reason: "unknown_model",
			message: `模型不在 ${entry.name} 的清单里：${modelId}`,
		};
	}
	const ref = { providerId: entry.id, modelId };
	writeStoredSelection(ref);
	return { ok: true, model: modelId, provider: entry.id, models: [...entry.models] };
}

// ── 供应商 CRUD（接口文档 §2.10）─────────────────────────

export interface ProviderInput {
	id?: string;
	previousId?: string;
	name?: string;
	baseUrl?: string;
	keyEnv?: string;
	models?: unknown;
	modelsUrl?: string;
	test?: boolean;
}

export type ProviderResult =
	| { ok: true; provider: ProviderDetail; message?: string }
	| { ok: false; status: 400 | 404; error: string; message: string };

function detailOf(entry: ProviderEntry, defaultId: string | null): ProviderDetail {
	return {
		...summaryOf(entry),
		baseUrl: entry.baseUrl,
		keyEnv: entry.keyEnv,
		isDefault: entry.id === defaultId,
	};
}

function bad(error: string, message: string): ProviderResult {
	return { ok: false, status: 400, error, message };
}

/**
 * 界面直填密钥的绑定变量名：`LIFEDIARY_KEY_<ID大写>`，`-` → `_`。
 * id 只可能是 `[a-z0-9-]`，前缀以字母开头 —— 结果必然符合 KEY_ENV_PATTERN，
 * 因此**不需要放宽正则**（用户手填走的是原有校验）。
 */
export function providerKeyEnv(id: string): string {
	return `LIFEDIARY_KEY_${id.toUpperCase().replace(/-/g, "_")}`;
}

export type SetProviderSecretResult =
	| { ok: true; keyEnv: string }
	| { ok: false; status: 400 | 404 | 500; error: string; message: string };

/**
 * 密钥直填（接口文档 §2.10，2026-11-05）。
 *
 * 顺序是**先落盘再生效**：写密钥文件 → 同步 providers.json 的 keyEnv → 热注入 env。
 * 任一步失败都不谎报成功；错误信息里不含密钥值，日志只记 id 与变量名。
 */
export function setProviderSecret(providerId: string, rawKey: string): SetProviderSecretResult {
	if (!providersConfigEnabled()) {
		return { ok: false, status: 400, error: "providers_disabled", message: "PROVIDERS_CONFIG=false：供应商配置文件已停用" };
	}
	if (!providerSecretsEnabled()) {
		return { ok: false, status: 400, error: "secrets_disabled", message: "PROVIDER_SECRETS=false：界面直填密钥已停用" };
	}
	ensureDocument();
	const entry = document?.providers.find((provider) => provider.id === providerId);
	if (!entry) {
		return { ok: false, status: 404, error: "unknown_provider", message: `没有这个供应商：${providerId}` };
	}
	const apiKey = rawKey.trim();
	if (apiKey.length < 1 || apiKey.length > 512) {
		return { ok: false, status: 400, error: "bad_request", message: "apiKey 需要 1–512 个字符" };
	}

	const keyEnv = providerKeyEnv(entry.id);
	try {
		writeProviderKey(keyEnv, apiKey);
	} catch {
		// 失败原因（文件只读 / 内容损坏）只写服务端日志；响应不回显任何细节
		console.error(`[secret] provider ${entry.id} 密钥写入失败`);
		return { ok: false, status: 500, error: "secrets_write_failed", message: "密钥保存失败，请检查服务端数据目录" };
	}

	const next: ProvidersDocument = {
		...document!,
		providers: document!.providers.map((provider) =>
			provider.id === entry.id ? { ...provider, keyEnv } : provider,
		),
	};
	try {
		persistDocument(next);
	} catch {
		console.error(`[secret] provider ${entry.id} 的 keyEnv 写入 providers.json 失败`);
		return { ok: false, status: 500, error: "secrets_write_failed", message: "密钥已保存，但供应商配置写入失败" };
	}

	// 热注入：pi-ai 的 auth 层每次请求现读 env，下一轮立即用新 key；无需重启
	process.env[keyEnv] = apiKey;
	console.log(`[secret] provider ${entry.id} keyEnv 已更新（来源=界面）`);
	return { ok: true, keyEnv };
}

function normalizeModels(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return dedupe(value.filter((item): item is string => typeof item === "string"));
}

function slugify(name: string): string {
	const base = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return base || `provider-${Date.now().toString(36)}`;
}

function uniqueId(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	let index = 2;
	while (taken.has(`${base}-${index}`)) index += 1;
	return `${base}-${index}`;
}

/** 从中文名生成的 slug 可能是保留字：加后缀再查重，不能直接落成 faux/mock */
function generatedId(name: string, taken: Set<string>): string {
	let base = slugify(name);
	if (RESERVED_PROVIDER_IDS.has(base)) base = `${base}-provider`;
	return uniqueId(base, taken);
}

function validBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.host);
	} catch {
		return false;
	}
}

/**
 * 拉模型清单：三种响应形状兼容；超时 5s、响应 ≤1MB；错误里绝不带 key。
 * `allowEmpty` 只给「空清单 + modelsUrl 建档」用：上游返回空列表不是拉取失败，
 * 要由调用方区分为 `bad_models`（提示上游清单为空），而不是 models_fetch_failed。
 */
async function fetchModelList(
	baseUrl: string,
	keyEnv: string,
	options: { allowEmpty?: boolean } = {},
): Promise<{ ok: true; models: string[] } | { ok: false; error: string; message: string }> {
	const key = process.env[keyEnv]?.trim();
	let response: Response;
	try {
		response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(5_000),
		});
	} catch {
		return { ok: false, error: "models_fetch_failed", message: "拉不到模型清单：连不上或超时" };
	}
	if (!response.ok) {
		return {
			ok: false,
			error: "models_fetch_failed",
			message: `拉不到模型清单：上游返回 ${response.status}`,
		};
	}
	const text = await response.text().catch(() => "");
	if (text.length > 1_000_000) {
		return { ok: false, error: "models_fetch_failed", message: "模型清单超过 1MB，拒绝读取" };
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return { ok: false, error: "models_fetch_failed", message: "模型清单不是合法 JSON" };
	}
	const models = modelIdsFrom(payload);
	if (models.length === 0 && !options.allowEmpty) {
		return { ok: false, error: "models_fetch_failed", message: "模型清单为空或形状不认识" };
	}
	return { ok: true, models };
}

function modelIdsFrom(payload: unknown): string[] {
	const bucket = payload as { data?: unknown; models?: unknown } | null;
	const arrays: unknown[] = [
		payload,
		bucket?.data,
		bucket?.models,
	];
	const ids: string[] = [];
	for (const candidate of arrays) {
		if (!Array.isArray(candidate)) continue;
		for (const item of candidate) {
			if (typeof item === "string" && item.trim()) {
				ids.push(item.trim());
				continue;
			}
			if (item && typeof item === "object") {
				const record = item as { id?: unknown; name?: unknown; model?: unknown };
				const value = record.id ?? record.model ?? record.name;
				if (typeof value === "string" && value.trim()) ids.push(value.trim());
			}
		}
	}
	// 上游清单混着语音/嵌入/重排等非对话模型，塞进切换菜单是噪音；明显非对话的直接滤掉。
	// 命中不了的全部保留（宁可多给也不能悄悄丢掉能用的对话模型）。
	const NON_CHAT = /audio|realtime|embedding|rerank|tts|asr|moderation|transcription/i;
	return dedupe(ids.filter((id) => !NON_CHAT.test(id))).slice(0, 500);
}

/** 新增 / 更新供应商（带 id 且存在 = 更新） */
export async function saveProvider(input: ProviderInput): Promise<ProviderResult> {
	if (!providersConfigEnabled()) {
		return bad("providers_disabled", "PROVIDERS_CONFIG=false：供应商配置文件已停用");
	}
	ensureDocument();
	const doc = document ?? { schemaVersion: 1 as const, providers: [], defaultSelection: null };

	if (input.previousId && input.id && input.previousId.trim() !== input.id.trim()) {
		return bad("provider_id_locked", "供应商 id 不能改；要换 id 请新建一个供应商");
	}

	const name = input.name?.trim() ?? "";
	const baseUrl = (input.baseUrl?.trim() ?? "").replace(/\/+$/, "");
	const keyEnv = input.keyEnv?.trim() ?? "";
	if (!name || name.length > 80) return bad("bad_provider_name", "名称需要 1–80 个字符");
	if (!validBaseUrl(baseUrl)) return bad("bad_base_url", "baseUrl 需要 http/https 绝对地址");
	if (!KEY_ENV_PATTERN.test(keyEnv)) {
		return bad("bad_key_env", "keyEnv 只能是大写字母、数字、下划线，且不以数字开头（例如 LLM_API_KEY）");
	}

	const taken = new Set(doc.providers.map((entry) => entry.id));
	const requestedId = input.id?.trim();
	let id: string;
	if (requestedId) {
		if (!PROVIDER_ID_PATTERN.test(requestedId)) {
			return bad("bad_provider_id", "id 只能是小写字母、数字、连字符（例如 bailian）");
		}
		if (RESERVED_PROVIDER_IDS.has(requestedId)) {
			return bad("bad_provider_id", `id ${requestedId} 是保留字，不能用作供应商`);
		}
		id = requestedId;
	} else {
		const existing = input.previousId?.trim();
		id = existing ?? generatedId(name, taken);
	}

	const existing = doc.providers.find((entry) => entry.id === id);
	let models = normalizeModels(input.models);
	if (input.test) {
		// 测试只证明"key 有值 + 端点可访问"，不写文件，也不要求先填模型清单
		if (!process.env[keyEnv]?.trim()) {
			return bad("missing_key", `环境变量 ${keyEnv} 还没有值：把钥匙放进 .env 再来测`);
		}
		const fetched = await fetchModelList(baseUrl, keyEnv);
		if (!fetched.ok) return bad(fetched.error, fetched.message);
		return {
			ok: true,
			provider: {
				id,
				name,
				baseUrl,
				keyEnv,
				models: models.length > 0 ? models : fetched.models,
				hasKey: true,
				isDefault: doc.defaultSelection?.providerId === id,
			},
			message: "钥匙已就位（变量有值且模型清单可访问；不代表模型一定可用）",
		};
	}
	// 带 modelsUrl = 服务端代拉：允许先建空清单，拉取结果直接作为清单。
	// allowEmpty 让"上游清单为空"落到 bad_models（区别于是连不上 / 形状不认识）。
	const modelsUrl = input.modelsUrl?.trim() ?? "";
	if (modelsUrl) {
		const fetched = await fetchModelList(baseUrl, keyEnv, { allowEmpty: true });
		if (!fetched.ok) return bad(fetched.error, fetched.message);
		models = fetched.models;
		// 拉取成功但上游是空列表：明确报上游为空，不能借用旧清单假装拉到了
		if (models.length === 0) {
			return bad("bad_models", "上游清单为空：确认 Key 与 baseUrl 后再拉，或直接填几个模型 id");
		}
	}
	// 编辑既有供应商且没填新清单时，沿用原清单（避免清空后选中的模型悬空）
	if (models.length === 0 && existing) models = [...existing.models];
	if (models.length === 0) {
		return bad("bad_models", "模型清单不能为空：填几个模型 id，或先存 Key 后拉取清单");
	}

	// 编辑不变量：当前选中 / 默认选择的模型不能被悄悄删掉（先切走再来改）
	const current = resolveSelection();
	if (existing) {
		const defaultHit =
			doc.defaultSelection?.providerId === id && !models.includes(doc.defaultSelection.modelId);
		const currentHit = current?.providerId === id && !models.includes(current.modelId);
		if (defaultHit || currentHit) {
			return bad("selected_model_missing", "这个供应商上还选着模型；先把当前模型切到别处，再改模型清单");
		}
	}

	// 思考档声明不在表单里编辑（settings 页不收集它），但编辑供应商不能把它悄悄抹掉：
	// 只保留仍在模型清单里的键（2026-11-04 思考档位）
	const keptLevels = Object.fromEntries(
		Object.entries(existing?.modelThinkingLevels ?? {}).filter(([modelId]) => models.includes(modelId)),
	);
	const entry: ProviderEntry = {
		id,
		name,
		baseUrl,
		keyEnv,
		models,
		...(Object.keys(keptLevels).length > 0 ? { modelThinkingLevels: keptLevels } : {}),
		createdAt: existing?.createdAt ?? new Date().toISOString(),
	};
	const providers = existing
		? doc.providers.map((item) => (item.id === id ? entry : item))
		: [...doc.providers, entry];
	const defaultSelection =
		doc.defaultSelection && providers.some((item) => item.id === doc.defaultSelection?.providerId)
			? doc.defaultSelection
			: { providerId: id, modelId: models[0] };

	persistDocument({ schemaVersion: 1, providers, defaultSelection });
	return { ok: true, provider: detailOf(entry, defaultSelection.providerId) };
}

export function removeProvider(id: string): ProviderResult {
	if (!providersConfigEnabled()) {
		return bad("providers_disabled", "PROVIDERS_CONFIG=false：供应商配置文件已停用");
	}
	ensureDocument();
	if (!document) {
		return { ok: false, status: 404, error: "unknown_provider", message: `没有这个供应商：${id}` };
	}
	const entry = document.providers.find((provider) => provider.id === id);
	if (!entry) {
		return { ok: false, status: 404, error: "unknown_provider", message: `没有这个供应商：${id}` };
	}
	if (document.defaultSelection?.providerId === id) {
		return bad("provider_is_default", "这是默认供应商，不能删；要换默认请先改 defaultSelection");
	}
	const current = isFaux() ? null : resolveSelection();
	if (current?.providerId === id) {
		return bad("provider_in_use", "当前模型还选在这个供应商上；先切到别的供应商再删");
	}
	const providers = document.providers.filter((provider) => provider.id !== id);
	persistDocument({ ...document, providers });
	// 删除联动（2026-11-05 H2）：旧 keyEnv 与界面直填绑定名都试一遍。
	// 清理失败只告警，不改删除结果——供应商已经删掉，残留条目最多是条无主密钥。
	try {
		const removed = removeProviderKeys([entry.keyEnv, providerKeyEnv(entry.id)]);
		if (removed > 0) {
			console.log(`[secret] provider ${entry.id} 的密钥条目已清除（${removed} 个）`);
		}
	} catch {
		console.warn(`[secret] provider ${entry.id} 的密钥条目清除失败（不影响删除结果）`);
	}
	return { ok: true, provider: detailOf(entry, document.defaultSelection?.providerId ?? null) };
}

function persistDocument(next: ProvidersDocument): void {
	writeJsonAtomic(providersPath(), next);
	document = next;
	documentLoaded = true;
	documentSignature = fileSignature(providersPath());
	warnedSignature = null;
	revision += 1;
}
