/**
 * DeepSeek 搜索适配层（2026-11-07 长期课题跟进 §一）。
 *
 * 上游固定 `POST {SEARCH_BASE_URL}/v1/tools/search`，Bearer 认证，
 * 入参 `{ query, count, need_content }`，出参 `results[]`。
 *
 * **明确不做**搜索供应商抽象：要换 / 加搜索源是二期立项（方案 S1）。
 * `SEARCH_BASE_URL` 只给探针把请求指向本地假上游用，是测试开关，不是供应商抽象。
 *
 * 纪律：
 *   - 没配 key 时返回 `search_not_configured`，**不许返回假结果、不许空转**（mock 纪律）；
 *   - 日志最多记 query 字数与结果条数，绝不打印 key / URL / 响应体；
 *   - 上游报错的 message 只写状态码，不带上游返回原文（原文可能含敏感内容）。
 */

export interface SearchHit {
	title: string;
	url: string;
	summary: string;
}

export type SearchResult =
	| { ok: true; hits: SearchHit[] }
	| {
			ok: false;
			error: "search_not_configured" | "upstream_error" | "bad_response";
			message: string;
	  };

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const TIMEOUT_MS = 20_000;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;

const NOT_CONFIGURED_MESSAGE =
	"搜索还没配置：去 设置 → 服务页 填 DEEPSEEK_SEARCH_API_KEY（可在 .env 直接写）。";

/** 搜索 key 的 env 变量名（只回变量名，给设置页 / 文档展示用，绝不回值）。 */
export function searchKeyEnv(): "DEEPSEEK_SEARCH_API_KEY" {
	return "DEEPSEEK_SEARCH_API_KEY";
}

/** 搜索是否可用：唯一判据是 key 有值。没有 key 的"每周研究"就是纯推理瞎说（方案 S4）。 */
export function searchConfigured(): boolean {
	return Boolean(process.env[searchKeyEnv()]?.trim());
}

function baseUrl(): string {
	return process.env.SEARCH_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

/** 把 count 收敛到 1..10；非数字 / 缺省走默认 5。 */
function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COUNT;
	return Math.min(MAX_COUNT, Math.max(1, Math.floor(value)));
}

/**
 * 查一次公开网络资料。
 *
 * 返回结构化结果而不是抛错：调用方（web_search 工具 / 研究回合）要把
 * "没配搜索" 这种可引导的状态原样交给模型，让模型去提示用户配置。
 */
export async function webSearch(query: string, count?: number): Promise<SearchResult> {
	const keyword = query.trim();
	if (!keyword) {
		return { ok: false, error: "bad_response", message: "query 不能为空" };
	}
	const limit = normalizeCount(count);
	const key = process.env[searchKeyEnv()]?.trim();
	if (!key) {
		return { ok: false, error: "search_not_configured", message: NOT_CONFIGURED_MESSAGE };
	}

	let response: Response;
	try {
		response = await fetch(`${baseUrl()}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${key}`,
			},
			body: JSON.stringify({ query: keyword, count: limit, need_content: true }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		// fetch 的错误信息可能带上游地址；只给一个稳定的枚举说明。
		return { ok: false, error: "upstream_error", message: "搜索服务不可达" };
	}

	if (!response.ok) {
		return {
			ok: false,
			error: "upstream_error",
			message: `搜索服务返回 ${response.status}`,
		};
	}

	const data = (await response.json().catch(() => null)) as
		| { results?: unknown }
		| null;
	if (!data || !Array.isArray(data.results)) {
		return { ok: false, error: "bad_response", message: "搜索服务返回格式异常" };
	}

	const hits: SearchHit[] = [];
	for (const item of data.results.slice(0, limit)) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		hits.push({
			title: typeof row.title === "string" ? row.title : "",
			url: typeof row.url === "string" ? row.url : "",
			summary: typeof row.summary === "string" ? row.summary : "",
		});
	}
	// 只记条数 / 字数，不记 query 原文与 URL（2026-11-07 日志纪律）。
	console.log(`[search] q=${keyword.length}字 hits=${hits.length}`);
	return { ok: true, hits };
}

/** 工具层注入的形状：测试可替换实现，生产用上面的真函数。 */
export interface SearchModule {
	searchConfigured: () => boolean;
	searchKeyEnv: () => "DEEPSEEK_SEARCH_API_KEY";
	webSearch: (query: string, count?: number) => Promise<SearchResult>;
}

export const searchModule: SearchModule = {
	searchConfigured,
	searchKeyEnv,
	webSearch,
};
