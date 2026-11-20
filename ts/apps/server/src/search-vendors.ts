/**
 * 搜索源目录与单源适配（2026-11-12 多供应商）。
 *
 * 参考 magpie 的「Search API」做法：每个供应商只描述四件事——
 * 去哪找 key、默认地址、怎么发请求、怎么把回包读成 `{ title, url, summary }`。
 * 编排（按顺序试、回退、错误枚举）在 `search.ts`；本文件不读配置文件。
 *
 * 纪律：
 *   - key 只进请求头 / 请求体，不进日志、不进错误文案；
 *   - 上游错误的 message 只说状态码 / 稳定枚举，不贴回包原文；
 *   - 回包结构一律防御式读取，缺字段当空串，绝不让一条脏结果炸整次搜索。
 */

export interface SearchHit {
	title: string;
	url: string;
	summary: string;
}

export type SearchErrorCode = "upstream_error" | "bad_response";

export interface SearchVendor {
	id: string;
	name: string;
	/** 供应商给 key 的控制台地址（只展示，不请求） */
	keyUrl: string;
	/** key 的环境变量名；搜素 key 与供应商 key 同落 `.data/provider-keys.json` */
	keyEnv: string;
	/** 默认地址；空串 = 必须由用户给（SearXNG） */
	baseUrl: string;
	/** 不需要 key 也能问（SearXNG） */
	keyOptional?: boolean;
	/** 必须给地址才能问（SearXNG） */
	needsUrl?: boolean;
	/** 上游对 query 的字数上限；超了先截断，不让整次搜索 400 */
	queryLimit?: number;
	/** 设置页一行说明，只写差异，不写「搜索」两个字 */
	note?: string;
}

export const SEARCH_VENDORS: SearchVendor[] = [
	{
		id: "deepseek",
		name: "DeepSeek",
		keyUrl: "https://platform.deepseek.com/api_keys",
		keyEnv: "DEEPSEEK_SEARCH_API_KEY",
		baseUrl: "https://api.deepseek.com",
		queryLimit: 128,
		note: "原有搜索源",
	},
	{
		id: "tavily",
		name: "Tavily",
		keyUrl: "https://app.tavily.com/home",
		keyEnv: "TAVILY_API_KEY",
		baseUrl: "https://api.tavily.com",
		note: "英文资料强",
	},
	{
		id: "exa",
		name: "Exa",
		keyUrl: "https://dashboard.exa.ai/api-keys",
		keyEnv: "EXA_API_KEY",
		baseUrl: "https://api.exa.ai",
		note: "语义检索",
	},
	{
		id: "baidu",
		name: "百度搜索",
		keyUrl: "https://console.bce.baidu.com/qianfan/ais/console/apiKey",
		keyEnv: "BAIDU_SEARCH_API_KEY",
		baseUrl: "https://qianfan.baidubce.com",
		note: "千帆 AI 搜索",
	},
	{
		id: "yuanbao",
		name: "元宝搜索",
		keyUrl: "https://console.cloud.tencent.com/wsapi/index",
		keyEnv: "YUANBAO_SEARCH_API_KEY",
		baseUrl: "https://api.wsa.cloud.tencent.com",
		note: "腾讯云 WSA",
	},
	{
		id: "brave",
		name: "Brave Search",
		keyUrl: "https://api-dashboard.search.brave.com/app/keys",
		keyEnv: "BRAVE_SEARCH_API_KEY",
		baseUrl: "https://api.search.brave.com",
	},
	{
		id: "firecrawl",
		name: "Firecrawl",
		keyUrl: "https://www.firecrawl.dev/app/api-keys",
		keyEnv: "FIRECRAWL_API_KEY",
		baseUrl: "https://api.firecrawl.dev",
	},
	{
		id: "doubao",
		name: "豆包搜索",
		keyUrl: "https://console.volcengine.com/search-infinity/api-key",
		keyEnv: "DOUBAO_SEARCH_API_KEY",
		baseUrl: "https://open.feedcoopapi.com",
		queryLimit: 100,
		note: "火山引擎",
	},
	{
		id: "tinyfish",
		name: "TinyFish",
		keyUrl: "https://agent.tinyfish.ai/api-keys",
		keyEnv: "TINYFISH_API_KEY",
		baseUrl: "https://api.search.tinyfish.ai",
	},
	{
		id: "searxng",
		name: "SearXNG",
		keyUrl: "https://docs.searxng.org/",
		keyEnv: "SEARXNG_API_KEY",
		baseUrl: "",
		keyOptional: true,
		needsUrl: true,
		note: "自建实例",
	},
];

export function searchVendorOf(id: string): SearchVendor | null {
	return SEARCH_VENDORS.find((vendor) => vendor.id === id) ?? null;
}

export interface VendorCallInput {
	vendor: SearchVendor;
	baseUrl: string;
	key: string;
	query: string;
	count: number;
}

export type VendorCallResult =
	| { ok: true; hits: SearchHit[] }
	| { ok: false; error: SearchErrorCode; message: string };

const TIMEOUT_MS = 20_000;

/**
 * 问一个供应商一次。
 *
 * 返回结构化结果而不是抛错：编排层要按顺序回退，单源失败不能让整次搜索中断。
 * `baseUrl` 已由调用方收敛（去尾斜杠、空串 = 用默认），这里不再读 env。
 */
export async function callSearchVendor(input: VendorCallInput): Promise<VendorCallResult> {
	const { vendor, baseUrl, key, count } = input;
	const query = clipRunes(input.query.trim(), vendor.queryLimit);
	if (!query) return { ok: false, error: "bad_response", message: "query 不能为空" };

	const request = buildRequest(vendor, baseUrl, key, query, count);
	const fetched = await fetchJson(request.url, request.init);
	if (!fetched.ok) return fetched;

	// 两家云厂商把错误放在 200 回包里：先判错误，再读结果
	const cloudError = vendor.id === "yuanbao" ? yuanbaoError(fetched.data) : vendor.id === "doubao" ? doubaoError(fetched.data) : null;
	if (cloudError) return cloudError;

	const parsed = parseHits(vendor.id, fetched.data);
	if (!parsed) return { ok: false, error: "bad_response", message: "搜索服务返回格式异常" };
	return { ok: true, hits: parsed.slice(0, count) };
}

function buildRequest(
	vendor: SearchVendor,
	baseUrl: string,
	key: string,
	query: string,
	count: number,
): { url: string; init: RequestInit } {
	const base = baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": "lifediary-search/0.1",
	};
	const post = (path: string, body: unknown): { url: string; init: RequestInit } => ({
		url: `${base}${path}`,
		init: {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	});
	const get = (path: string, params: Record<string, string>): { url: string; init: RequestInit } => {
		const search = new URLSearchParams(params).toString();
		return { url: `${base}${path}${search ? `?${search}` : ""}`, init: { method: "GET", headers } };
	};

	switch (vendor.id) {
		case "tavily": {
			setAuth(headers, vendor, key);
			return post("/search", { query, max_results: count, search_depth: "basic" });
		}
		case "exa": {
			if (key) headers["x-api-key"] = key;
			return post("/search", {
				query,
				numResults: count,
				contents: { text: { maxCharacters: 1500 } },
			});
		}
		case "baidu": {
			setAuth(headers, vendor, key);
			return post("/v2/ai_search/web_search", {
				messages: [{ role: "user", content: query }],
				search_source: "baidu_search_v2",
				edition: "standard",
				resource_type_filter: [{ type: "web", top_k: count }],
			});
		}
		case "yuanbao": {
			setAuth(headers, vendor, key);
			// Cnt 只收 10/20/30/40/50；工具层最多要 10 条，这里取 10
			return post("/SearchPro", { Query: query, Cnt: Math.max(10, Math.ceil(count / 10) * 10) });
		}
		case "brave": {
			if (key) headers["X-Subscription-Token"] = key;
			return get("/res/v1/web/search", { q: query, count: String(count) });
		}
		case "firecrawl": {
			setAuth(headers, vendor, key);
			return post("/v2/search", { query, limit: count });
		}
		case "doubao": {
			setAuth(headers, vendor, key);
			return post("/search_api/web_search", {
				Query: query,
				SearchType: "web",
				Count: count,
				Filter: { NeedUrl: true },
			});
		}
		case "tinyfish": {
			if (key) headers["X-API-Key"] = key;
			return get("/", { query });
		}
		case "searxng": {
			setAuth(headers, vendor, key);
			return get("/search", { q: query, format: "json" });
		}
		case "deepseek":
		default: {
			setAuth(headers, vendor, key);
			return post("/v1/tools/search", { query, count, need_content: true });
		}
	}
}

function setAuth(headers: Record<string, string>, vendor: SearchVendor, key: string): void {
	if (!key) return;
	switch (vendor.id) {
		case "exa":
		case "tinyfish":
			headers["X-API-Key"] = key;
			return;
		case "brave":
			headers["X-Subscription-Token"] = key;
			return;
		default:
			headers.Authorization = `Bearer ${key}`;
	}
}

type FetchResult =
	| { ok: true; data: unknown }
	| { ok: false; error: SearchErrorCode; message: string };

async function fetchJson(url: string, init: RequestInit): Promise<FetchResult> {
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			// 不跟重定向：跨站跳转会把 key 带去别处（与 magpie 同口径）
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		return { ok: false, error: "upstream_error", message: "搜索服务不可达" };
	}
	if (response.status >= 300 && response.status < 400) {
		return { ok: false, error: "upstream_error", message: "搜索服务返回重定向" };
	}
	if (!response.ok) {
		return { ok: false, error: "upstream_error", message: `搜索服务返回 ${response.status}` };
	}
	const data = (await response.json().catch(() => null)) as unknown;
	if (!data || typeof data !== "object") {
		return { ok: false, error: "bad_response", message: "搜索服务返回格式异常" };
	}
	return { ok: true, data };
}

function parseHits(vendorId: string, data: unknown): SearchHit[] | null {
	const root = asRecord(data);
	if (!root) return null;
	switch (vendorId) {
		case "brave": {
			const web = asRecord(root.web);
			return web ? readRows(web.results, ["title", "url", "description"]) : null;
		}
		case "firecrawl": {
			const payload = root.data;
			if (Array.isArray(payload)) return readRows(payload, ["title", "url", "description", "markdown"]);
			const box = asRecord(payload);
			if (!box) return null;
			if (Array.isArray(box.web)) return readRows(box.web, ["title", "url", "description", "markdown"]);
			return readRows(box.results, ["title", "url", "description", "markdown"]);
		}
		case "baidu":
			return readRows(root.references, ["title", "url", "content", "snippet"]);
		case "yuanbao":
			return readYuanbaoPages(root);
		case "doubao": {
			const result = asRecord(root.Result);
			return result ? readRows(result.WebResults, ["Title", "Url", "Summary", "Snippet"]) : null;
		}
		default:
			// deepseek / tavily / exa / tinyfish / searxng：都是 { results: [...] }
			return readRows(root.results, ["title", "url", "summary", "content", "text", "snippet", "description"]);
	}
}

/** 通用结果行：字段名按优先级取第一个非空；URL 为空的行丢掉（点不开的来源没有用）。
 *  不是数组 = 回包形状不对（null），与「合法但零命中」的 [] 分开。 */
function readRows(value: unknown, fields: string[]): SearchHit[] | null {
	if (!Array.isArray(value)) return null;
	const [titleKey, urlKey, ...textKeys] = fields;
	const hits: SearchHit[] = [];
	for (const item of value) {
		const row = asRecord(item);
		if (!row) continue;
		const url = text(row[urlKey ?? "url"]);
		if (!url) continue;
		const title = plainText(text(row[titleKey ?? "title"])) || url;
		let summary = "";
		for (const key of textKeys) {
			summary = plainText(text(row[key]));
			if (summary) break;
		}
		hits.push({
			title: clipText(title, 300),
			url,
			summary: clipText(summary, 2000),
		});
	}
	return hits;
}

/** 元宝搜索：Response.Pages 是「JSON 字符串数组」，每个字符串一个页面对象。 */
function readYuanbaoPages(root: Record<string, unknown>): SearchHit[] | null {
	const response = asRecord(root.Response);
	if (!response || !Array.isArray(response.Pages)) return null;
	const hits: SearchHit[] = [];
	for (const page of response.Pages) {
		if (typeof page !== "string") continue;
		let row: Record<string, unknown> | null = null;
		try {
			row = asRecord(JSON.parse(page));
		} catch {
			row = null;
		}
		if (!row) continue;
		// 2026-11-19 实测：页内字段实际是小写（title/url/passage/content），
		// 文档示例与旧测试是按大写写的。这里统一折成小写读，两种大小写都认。
		const fields = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
		const url = text(fields.get("url"));
		if (!url) continue;
		// passage 是标准摘要；只有标题时用 content（针对 query 的摘要）
		const title = text(fields.get("title"));
		let summary = plainText(text(fields.get("passage")));
		if (!summary || summary === plainText(title)) summary = plainText(text(fields.get("content")));
		hits.push({
			title: clipText(plainText(title) || url, 300),
			url,
			summary: clipText(summary, 2000),
		});
	}
	return hits;
}

function yuanbaoError(data: unknown): Extract<VendorCallResult, { ok: false }> | null {
	const root = asRecord(data);
	const response = root ? asRecord(root.Response) : null;
	const error = response ? asRecord(response.Error) : null;
	if (!error) return null;
	const code = text(error.Code);
	const kind = code.split(".")[0];
	let message = "搜索服务报错";
	if (kind === "AuthFailure" || kind === "UnauthorizedOperation" || kind === "ResourceNotFound") {
		message = "搜索 key 被拒绝或服务未开通";
	} else if (kind === "ResourceUnavailable" || kind === "LimitExceeded" || kind === "ResourceInsufficient") {
		message = "搜索额度不足";
	} else if (kind === "RequestLimitExceeded") {
		message = "搜索太频繁，稍后再试";
	}
	return { ok: false, error: "upstream_error", message };
}

function doubaoError(data: unknown): Extract<VendorCallResult, { ok: false }> | null {
	const root = asRecord(data);
	const metadata = root ? asRecord(root.ResponseMetadata) : null;
	const error = metadata ? asRecord(metadata.Error) : null;
	if (!error) return null;
	const code = Number(error.CodeN ?? Number.NaN);
	const codeText = text(error.Code);
	let message = "搜索服务报错";
	if ([10401, 10403, 10409].includes(code) || /Auth|Unauthorized/i.test(codeText)) {
		message = "搜索 key 被拒绝或服务未开通";
	} else if ([10406, 10408, 10410, 10412].includes(code)) {
		message = "搜索额度不足";
	} else if (code === 700429 || /Limit/i.test(codeText)) {
		message = "搜索太频繁，稍后再试";
	}
	return { ok: false, error: "upstream_error", message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** 去标签 / 解常见实体 / 收成一行：Brave 会用 <strong> 标命中词。 */
export function plainText(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (entity) => {
			switch (entity.toLowerCase()) {
				case "&amp;":
					return "&";
				case "&lt;":
					return "<";
				case "&gt;":
					return ">";
				case "&quot;":
					return '"';
				case "&#39;":
					return "'";
				default:
					return " ";
			}
		})
		.replace(/\s+/g, " ")
		.trim();
}

/** 按字符（非 UTF-16 码元）截断；中文不会被切成半个字。 */
function clipRunes(value: string, limit: number | undefined): string {
	if (!limit || value.length <= limit) return value;
	return Array.from(value).slice(0, limit).join("");
}

/** 摘要 / 标题进模型前的上限：一家回包塞几千字，不裁会把一轮研究撑爆。 */
function clipText(value: string, limit: number): string {
	if (!value) return value;
	const chars = Array.from(value);
	return chars.length <= limit ? value : `${chars.slice(0, limit).join("")}…`;
}
