/**
 * 服务端联网工具白名单（2026-11-19）。
 *
 * 背景：DeepSeek 的 `deepseek_web_search` / `deepseek_read_url` 是**服务端工具**，
 * 只由「实际收到请求的那个端点」认。模型名里带 deepseek 不算数——百炼、中转站
 * 会直接 400，或者更糟：静默丢弃、看起来答了其实没搜。
 *
 * 判据只有一条：baseUrl 的 origin（协议 + 主机 + 端口）与白名单**精确相等**。
 * 绝不用 includes / startsWith——`api.deepseek.com.evil.cc` 会骗过字符串包含。
 * 模型名再卡一道：官方文档点名要求 `deepseek-flash`。
 *
 * 回滚：`SERVER_WEB_SEARCH_TOOLS` 不是 `on` 时一律返回不支持（默认关闭）。
 *
 * 实测记录（2026-11-19，本机实测，非推测）：
 *   - `https://dashscope.aliyuncs.com/compatible-mode/v1`（百炼）→ HTTP 400
 *     `'function' is a required property, expected an object - 'tools.0'`，整个请求打回。
 *   - `http://127.0.0.1:3425/v1`（magpie 本地网关）逐个实测 7 个 DeepSeek 路由，
 *     **只有 `deepseek/deepseek-flash` 认**（HTTP 200，回答引用了多条实时气象来源）。
 *     其余 6 个见 `SERVER_TOOL_REJECTIONS`：5 个返回 200 但**静默丢弃工具**
 *     （模型自称「无法联网搜索」「系统没有提供浏览工具」），1 个 404 路由不存在。
 *     另注：非官方路由自述的「当前日期」是 2026-05-07，比真实日期晚半年，
 *     说明它们接的不是同一份上游快照。
 *   - `deepseek/deepseek-flash` 经用户确认（2026-11-19）就是官方那条路由。
 *     这一点与实测互为印证：服务端工具只有 DeepSeek 官方后端能执行，
 *     能执行即证明请求最终到达官方服务器。**剩余不确定项只有一个**：
 *     网关用的是哪个账号（自有官方 key / 共享池），它决定计费是否享受官方口径，
 *     客户端看不到。
 *   - 官方 `https://api.deepseek.com` 本轮**未**实测（没有可用的官方 key），
 *     仅按官方文档口径登记，标为未验证。
 */

export const OFFICIAL_DEEPSEEK_ORIGIN = "https://api.deepseek.com";
export const MAGPIE_GATEWAY_ORIGIN = "http://127.0.0.1:3425";

export interface ServerToolProvider {
	/** 白名单内的稳定 id，用于日志与回显 */
	id: string;
	/** 精确匹配的 origin：协议 + host + 端口，不带路径 */
	origin: string;
	/** 该端点上允许的模型名（精确相等） */
	models: string[];
	/** 一行说明：谁验的、什么状态 */
	note: string;
	/** 是否已实测通过（未实测的仍可登记，但审阅时要看得见） */
	verified: boolean;
}

export const SERVER_TOOL_PROVIDERS: ServerToolProvider[] = [
	{
		id: "deepseek-official",
		origin: OFFICIAL_DEEPSEEK_ORIGIN,
		models: ["deepseek-flash"],
		note: "官方端点；官方文档点名 deepseek-flash。2026-11-19 未实测（无 key）",
		verified: false,
	},
	{
		id: "magpie-local",
		origin: MAGPIE_GATEWAY_ORIGIN,
		models: ["deepseek/deepseek-flash"],
		note: "本机 magpie 网关的官方那条路由；2026-11-19 实测能执行服务端工具（即到达官方后端）。计费按网关所用账号走，客户端不可见",
		verified: true,
	},
];

/**
 * 实测过**不认**服务端工具的端点 × 模型（2026-11-19）。
 *
 * 存在的意义：以后有人看到「magpie 里有一堆 deepseek」想往白名单里加，
 * 先看这张反例表。它们大多返回 200，只看状态码会以为成功。
 */
export interface ServerToolRejection {
	origin: string;
	model: string;
	/** 实测表现：状态码 + 模型原话或错误摘要 */
	evidence: string;
	verifiedAt: string;
}

export const SERVER_TOOL_REJECTIONS: ServerToolRejection[] = [
	{
		origin: MAGPIE_GATEWAY_ORIGIN,
		model: "qwen-cn/deepseek-v4.1-flash-1017",
		evidence: "HTTP 200；模型自述「系统没有提供浏览工具」，未搜索",
		verifiedAt: "2026-11-19",
	},
	{
		origin: MAGPIE_GATEWAY_ORIGIN,
		model: "workbuddy/deepseek-v4.1-flash",
		evidence: "HTTP 200；模型自述「我无法联网搜索」，未搜索",
		verifiedAt: "2026-11-19",
	},
	{
		origin: MAGPIE_GATEWAY_ORIGIN,
		model: "auto/deepseek-v4.1-flash",
		evidence: "HTTP 200；模型自述「没有实时联网能力」，未搜索",
		verifiedAt: "2026-11-19",
	},
	{
		origin: MAGPIE_GATEWAY_ORIGIN,
		model: "codearts/deepseek-v4.1-flash",
		evidence: "HTTP 200；模型自述「系统没有 web 工具列表」，未搜索",
		verifiedAt: "2026-11-19",
	},
	{
		origin: MAGPIE_GATEWAY_ORIGIN,
		model: "trae-cn/deepseek-v4.1-flash-max",
		evidence: "HTTP 200（17s）；自述日期停在 2026-05-07，未搜索",
		verifiedAt: "2026-11-19",
	},
	{
		origin: MAGPIE_GATEWAY_ORIGIN,
		model: "raccoon/sn-deepseek-v4-1-flash-1017",
		evidence: "HTTP 404；magpie knows no model，providers.json 里是过期配置",
		verifiedAt: "2026-11-19",
	},
];

export interface ServerToolSupport {
	supported: boolean;
	/** 命中的白名单条目（端点命中但模型不符时也会回填，便于排错） */
	providerId: string | null;
	/** 给人看的一句原因，不含密钥与请求体 */
	reason: string;
}

/**
 * 取 origin：protocol + host（含端口）。解析不了返回 null。
 * 不用正则拼字符串——手写解析会在 IPv6、默认端口、大小写上出错。
 */
export function originOf(baseUrl: string): string | null {
	try {
		const url = new URL(baseUrl.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return `${url.protocol}//${url.host}`.toLowerCase();
	} catch {
		return null;
	}
}

/** 服务端工具总开关：默认关闭，只有显式 `on` 才放行。 */
export function serverToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.SERVER_WEB_SEARCH_TOOLS ?? "").trim().toLowerCase() === "on";
}

/**
 * 判定某次模型请求能否携带 DeepSeek 服务端工具。
 *
 * 返回结构而不是抛错：调用方要把「为什么不支持」如实交给日志/设置页，
 * 而不是默默把工具塞进一个不认它的端点。
 */
export function serverToolSupport(
	baseUrl: string,
	model: string,
	env: NodeJS.ProcessEnv = process.env,
): ServerToolSupport {
	if (!serverToolsEnabled(env)) {
		return { supported: false, providerId: null, reason: "服务端工具开关未开（SERVER_WEB_SEARCH_TOOLS≠on）" };
	}

	const origin = originOf(baseUrl);
	if (origin === null) {
		return { supported: false, providerId: null, reason: "baseUrl 不是 http/https 绝对地址" };
	}

	const wanted = model.trim();
	for (const provider of SERVER_TOOL_PROVIDERS) {
		if (provider.origin.toLowerCase() !== origin) continue;
		if (provider.models.includes(wanted)) {
			return { supported: true, providerId: provider.id, reason: `命中 ${provider.id}` };
		}
		return {
			supported: false,
			providerId: provider.id,
			reason: `${provider.id} 端点命中，但模型 ${wanted} 不在该条目名单`,
		};
	}

	return { supported: false, providerId: null, reason: `端点 ${origin} 不在白名单` };
}

/** OpenAI 兼容 tools 数组里的一项：只关心 type 与 function.name。 */
interface ToolLike {
	type?: string;
	function?: { name?: string };
}

function isFunctionTool(tool: unknown, name: string): boolean {
	const item = tool as ToolLike | null;
	return !!item && item.type === "function" && item.function?.name === name;
}

export interface ToolSwapResult {
	/** 实际要发出去的 tools；未改动时与入参是同一个数组 */
	tools: unknown[];
	/** 是否发生了替换 */
	swapped: boolean;
	/** 命中（或被端点命中但模型不符）的白名单条目，供日志 */
	providerId: string | null;
}

/**
 * 命中白名单时，把 function 版 `web_search` 换成服务端工具 `deepseek_web_search`。
 *
 * 纯函数、不改入参：
 *   - 原 tools 里没有 `web_search` → 原样返回（尊重「搜索被禁用」的既有语义）；
 *   - 不在白名单 → 原样返回（不认服务端工具的端点会 400 或静默丢工具）；
 *   - 命中 → 摘掉本地那个、追加服务端那个。只加 `web_search`，不加 `read_url`（最小变更）。
 */
export function swapWebSearchTool(
	tools: readonly unknown[],
	baseUrl: string,
	model: string,
	env: NodeJS.ProcessEnv = process.env,
): ToolSwapResult {
	const support = serverToolSupport(baseUrl, model, env);
	const hasLocalSearch = tools.some((tool) => isFunctionTool(tool, "web_search"));
	if (!hasLocalSearch || !support.supported) {
		return { tools: tools as unknown[], swapped: false, providerId: support.providerId };
	}
	return {
		tools: [...tools.filter((tool) => !isFunctionTool(tool, "web_search")), { type: "deepseek_web_search" }],
		swapped: true,
		providerId: support.providerId,
	};
}
