/**
 * 搜索编排（2026-11-07 单一 DeepSeek；2026-11-12 多供应商）。
 *
 * 配置在 `search-config.ts`，单源请求/回包在 `search-vendors.ts`。
 * 本文件只做三件事：
 *   1. 「有没有可用的搜索」= `web_search` 工具能不能真查（未配源返回引导错误）；
 *   2. 按配置顺序问源，失败 / 零命中就试下一个，第一个有结果的说了算；
 *   3. 把稳定枚举错误交给 `web_search` 工具与设置页。
 *
 * 纪律（沿用 2026-11-07）：
 *   - 没配时返回 `search_not_configured`，**不许返回假结果、不许空转**；
 *   - 日志最多记 query 字数、源 id、结果条数，绝不打印 key / URL / 响应体；
 *   - 上游报错的 message 只写状态码或稳定说明，不带上游返回原文。
 */

import {
	callSearchVendor,
	type SearchErrorCode,
	type SearchHit,
	type SearchVendor,
	type VendorCallResult,
} from "./search-vendors.ts";
import {
	searchSourceStates,
	usableSearchSources,
	type SearchSourceState,
} from "./search-config.ts";

export type { SearchHit } from "./search-vendors.ts";
export { SEARCH_VENDORS, searchVendorOf } from "./search-vendors.ts";

export type SearchResult =
	| { ok: true; hits: SearchHit[] }
	| {
			ok: false;
			error: "search_not_configured" | SearchErrorCode;
			message: string;
	  };

const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;

export const NOT_CONFIGURED_MESSAGE =
	"搜索还没配置：去 设置 → 模型 → 搜索 添加一个搜索源。";

/** 搜索 key 的 env 变量名（只回变量名，给设置页 / 文档展示用，绝不回值）。 */
export function searchKeyEnv(): string {
	return searchSourceStates()[0]?.keyEnv ?? "DEEPSEEK_SEARCH_API_KEY";
}

/** 搜索是否可用：任一源「该有 key 的有 key、该有地址的有地址」。 */
export function searchConfigured(): boolean {
	return usableSearchSources().length > 0;
}

/** 把 count 收敛到 1..10；非数字 / 缺省走默认 5。 */
function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COUNT;
	return Math.min(MAX_COUNT, Math.max(1, Math.floor(value)));
}

async function askSource(
	source: SearchSourceState,
	query: string,
	count: number,
): Promise<VendorCallResult> {
	const key = process.env[source.keyEnv]?.trim() ?? "";
	return callSearchVendor({
		vendor: source.vendorInfo,
		baseUrl: source.baseUrl,
		key,
		query,
		count,
	});
}

/**
 * 查一次公开网络资料：按配置顺序试源。
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
	const sources = usableSearchSources();
	if (!sources.length) {
		return { ok: false, error: "search_not_configured", message: NOT_CONFIGURED_MESSAGE };
	}

	let sawEmpty = false;
	let lastFailure: { ok: false; error: SearchErrorCode; message: string } | null = null;
	for (const source of sources) {
		const result = await askSource(source, keyword, limit);
		if (result.ok) {
			// 只记条数 / 字数 / 源 id，不记 query 原文与 URL（2026-11-07 日志纪律）。
			console.log(`[search] vendor=${source.vendor} q=${keyword.length}字 hits=${result.hits.length}`);
			if (result.hits.length > 0) return result;
			sawEmpty = true;
			continue;
		}
		lastFailure = result;
		console.warn(`[search] vendor=${source.vendor} error=${result.error}`);
	}
	// 所有源都合法答了但都没命中：这不是错误，如实回空。
	if (sawEmpty) return { ok: true, hits: [] };
	return lastFailure ?? { ok: false, error: "search_not_configured", message: NOT_CONFIGURED_MESSAGE };
}

/**
 * 连接测试：指定源就测它，不指定就测第一个可用源。
 * 与 webSearch 共用适配层；UI 的「测试」按钮走这里，不污染正式搜索的回退顺序。
 */
export async function testSearchVendor(vendorId?: string): Promise<SearchResult> {
	const states = searchSourceStates();
	const source = vendorId
		? states.find((state) => state.vendor === vendorId) ?? null
		: states.find((state) => state.usable) ?? null;
	if (!source) {
		return { ok: false, error: "search_not_configured", message: NOT_CONFIGURED_MESSAGE };
	}
	if (!source.usable) {
		const missing = source.vendorInfo.needsUrl && !source.baseUrl ? "地址" : "Key";
		return {
			ok: false,
			error: "search_not_configured",
			message: `${source.vendorInfo.name} 还缺${missing}。`,
		};
	}
	return askSource(source, "连接测试", 1);
}

/** 工具层注入的形状：测试可替换实现，生产用上面的真函数。 */
export interface SearchModule {
	searchConfigured: () => boolean;
	searchKeyEnv: () => string;
	webSearch: (query: string, count?: number) => Promise<SearchResult>;
}

export const searchModule: SearchModule = {
	searchConfigured,
	searchKeyEnv,
	webSearch,
};

/** 给设置页的源状态（不含任何 key 值）。 */
export function searchSourceSummary(): Array<{
	vendor: string;
	name: string;
	keyEnv: string;
	hasKey: boolean;
	baseUrl: string;
	usable: boolean;
	keyOptional: boolean;
	needsUrl: boolean;
	keyUrl: string;
	note: string;
}> {
	return searchSourceStates().map((state) => ({
		vendor: state.vendor,
		name: state.vendorInfo.name,
		keyEnv: state.keyEnv,
		hasKey: state.hasKey,
		baseUrl: state.baseUrl,
		usable: state.usable,
		keyOptional: state.vendorInfo.keyOptional === true,
		needsUrl: state.vendorInfo.needsUrl === true,
		keyUrl: state.vendorInfo.keyUrl,
		note: state.vendorInfo.note ?? "",
	}));
}

export type { SearchVendor };
