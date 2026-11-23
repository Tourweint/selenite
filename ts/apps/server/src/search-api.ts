import type { Hono } from "hono";
import { providerSecretsEnabled } from "./provider.ts";
import { removeProviderKeys, writeProviderKey } from "./provider-secrets.ts";
import {
	SEARCH_VENDORS,
	searchConfigured,
	searchKeyEnv,
	searchSourceSummary,
	searchVendorOf,
	testSearchVendor,
} from "./search.ts";
import {
	reorderSearchSources,
	removeSearchSource,
	searchSourceStates,
	upsertSearchSource,
} from "./search-config.ts";

/**
 * 搜索源配置接口（2026-11-07 建；2026-11-12 多供应商，web 专用）。
 *
 * 注册形态照 group-api：只做 HTTP 形状映射，鉴权走 index.ts 的全局中间件。
 * 落点拆两处（各有分工）：
 *   - `.data/search.json`：用哪些源、顺序、地址覆盖（本文件经 search-config 读写）；
 *   - `.data/provider-keys.json`：key（与供应商密钥同一份，按 vendor.keyEnv 取 env）。
 *
 * 纪律：响应只回变量名与「有没有」，**绝不回显密钥值**；日志只记 vendor / 成功失败，
 * 不记 query 原文与 key。
 */

/** 设置页投影：已配置的源 + 可添加的目录。不含任何 key 值。 */
function providerState() {
	const sources = searchSourceSummary();
	const configured = searchConfigured();
	return {
		ok: true as const,
		configured,
		// 旧客户端字段：给一个「当前首个源」的变量名 / 有没有可用的搜索
		keyEnv: sources[0]?.keyEnv ?? searchKeyEnv(),
		hasKey: configured,
		sources,
		vendors: SEARCH_VENDORS.map((vendor) => {
			const selected = sources.some((source) => source.vendor === vendor.id);
			return {
				id: vendor.id,
				name: vendor.name,
				keyEnv: vendor.keyEnv,
				baseUrl: vendor.baseUrl,
				keyUrl: vendor.keyUrl,
				note: vendor.note ?? "",
				keyOptional: vendor.keyOptional === true,
				needsUrl: vendor.needsUrl === true,
				configured: selected,
			};
		}),
	};
}

function vendorById(raw: unknown): { id: string } | { error: string } {
	const id = typeof raw === "string" ? raw.trim() : "";
	if (!id) return { id: "deepseek" };
	if (!searchVendorOf(id)) return { error: "unknown_vendor" };
	return { id };
}

export function mountSearch(app: Hono): void {
	// ── 查状态 ───────────────────────────────────────────
	app.get("/api/v1/agent/search-provider", (c) => c.json(providerState()));

	// ── 新增 / 更新一个源（可同时写 key / 地址）──────────
	app.put("/api/v1/agent/search-provider", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { vendor?: unknown; apiKey?: unknown; baseUrl?: unknown }
			| null;
		const picked = vendorById(body?.vendor);
		if ("error" in picked) {
			return c.json({ error: "unknown_vendor", message: "没有这个搜索源" }, 400);
		}
		const vendor = searchVendorOf(picked.id);
		if (!vendor) return c.json({ error: "unknown_vendor", message: "没有这个搜索源" }, 400);

		const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
		if (apiKey) {
			// 回滚开关与供应商密钥直填同一口径（PROVIDER_SECRETS=false → 400 secrets_disabled）
			if (!providerSecretsEnabled()) {
				return c.json(
					{ error: "secrets_disabled", message: "PROVIDER_SECRETS=false：界面直填密钥已停用" },
					400,
				);
			}
			if (apiKey.length > 512) {
				return c.json({ error: "bad_request", message: "apiKey 需要 1–512 个字符" }, 400);
			}
			try {
				writeProviderKey(vendor.keyEnv, apiKey);
			} catch {
				// 失败原因只进服务端日志；响应不回显任何细节
				console.error(`[search] 密钥写入失败 vendor=${vendor.id}`);
				return c.json(
					{ error: "secrets_write_failed", message: "密钥保存失败，请检查服务端数据目录" },
					500,
				);
			}
			// 热注入：search.ts 每次现读 process.env，下一轮 / 下次测试立刻生效
			process.env[vendor.keyEnv] = apiKey;
		}

		// 有 env key（.env 手写 / 之前直填）也算有 key；一个都没有就拒绝「加了个空源」。
		if (!vendor.keyOptional && !process.env[vendor.keyEnv]?.trim()) {
			return c.json(
				{ error: "missing_key", message: "这个搜索源还需要 Key：填 Key 或写进 .env。" },
				400,
			);
		}

		const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : undefined;
		const result = upsertSearchSource(vendor.id, baseUrl);
		if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
		console.log(`[search] 搜索源已保存 vendor=${vendor.id} keyEnv=${vendor.keyEnv}`);
		return c.json(providerState());
	});

	// ── 删除一个源（界面「移除」）────────────────────────
	app.delete("/api/v1/agent/search-provider", (c) => {
		const picked = vendorById(c.req.query("vendor"));
		if ("error" in picked) {
			return c.json({ error: "unknown_vendor", message: "没有这个搜索源" }, 400);
		}
		const vendor = searchVendorOf(picked.id);
		if (!vendor) return c.json({ error: "unknown_vendor", message: "没有这个搜索源" }, 400);
		const result = removeSearchSource(vendor.id);
		if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
		try {
			removeProviderKeys([vendor.keyEnv]);
		} catch {
			console.error(`[search] 密钥删除失败 vendor=${vendor.id}`);
		}
		// 只清运行期 env：.env 里的值重启后照旧在（但那一路归用户自己管；
		// search.json 已经不含这个源，不会被偷偷用起来）。
		delete process.env[vendor.keyEnv];
		console.log(`[search] 搜索源已移除 vendor=${vendor.id}`);
		return c.json(providerState());
	});

	// ── 重排（列表顺序 = 尝试顺序）───────────────────────
	app.put("/api/v1/agent/search-provider/order", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { vendors?: unknown } | null;
		if (!Array.isArray(body?.vendors)) {
			return c.json({ error: "bad_request", message: "vendors 需要是字符串数组" }, 400);
		}
		const ids = body.vendors.filter((id): id is string => typeof id === "string");
		const result = reorderSearchSources(ids);
		if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
		return c.json(providerState());
	});

	// ── 连接测试：真调一次搜索（指定 vendor，缺省测第一个）──
	app.post("/api/v1/agent/search-provider/test", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { vendor?: unknown } | null;
		const raw = typeof body?.vendor === "string" ? body.vendor.trim() : "";
		if (raw && !searchVendorOf(raw)) {
			return c.json({ error: "unknown_vendor", message: "没有这个搜索源" }, 400);
		}
		// 老客户端不带 vendor：沿用「测第一个可用源」
		const vendorId = raw || searchSourceStates().find((state) => state.usable)?.vendor;
		const result = await testSearchVendor(vendorId);
		if (result.ok) {
			console.log(`[search] 测试成功 vendor=${vendorId ?? "auto"} hits=${result.hits.length}`);
			return c.json({
				ok: true,
				vendor: vendorId ?? "",
				hits: result.hits.length,
				message: `搜索通了，返回 ${result.hits.length} 条`,
			});
		}
		console.warn(`[search] 测试失败 vendor=${vendorId ?? "auto"} error=${result.error}`);
		return c.json({ ok: false, vendor: vendorId ?? "", error: result.error, message: result.message });
	});
}
