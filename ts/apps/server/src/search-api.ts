import type { Hono } from "hono";
import { providerSecretsEnabled } from "./provider.ts";
import { removeProviderKeys, writeProviderKey } from "./provider-secrets.ts";
import { searchConfigured, searchKeyEnv, webSearch } from "./search.ts";

/**
 * 搜索配置接口（2026-11-07 长期课题跟进 S2，web 专用）。
 *
 * 注册形态照 group-api / topic-api：只做 HTTP 形状映射，鉴权走 index.ts 的全局中间件。
 * 落点与供应商密钥同一份（`.data/provider-keys.json`），热注入 process.env 后
 * `searchConfigured()` 立刻为 true——search.ts 读的就是 env。
 *
 * 纪律：响应只回变量名，**绝不回显密钥值**；日志只记"成功 / 失败 + 枚举"，
 * 不记 query 原文与 key。
 */

export function mountSearch(app: Hono): void {
	// ── 查状态 ───────────────────────────────────────────
	app.get("/api/v1/agent/search-provider", (c) => {
		return c.json({
			ok: true,
			keyEnv: searchKeyEnv(),
			hasKey: searchConfigured(),
		});
	});

	// ── 直填（写密钥文件 + 热注入 env）────────────────────
	app.put("/api/v1/agent/search-provider", async (c) => {
		// 回滚开关与供应商密钥直填同一口径（PROVIDER_SECRETS=false → 400 secrets_disabled）
		if (!providerSecretsEnabled()) {
			return c.json(
				{ error: "secrets_disabled", message: "PROVIDER_SECRETS=false：界面直填密钥已停用" },
				400,
			);
		}
		const body = (await c.req.json().catch(() => null)) as { apiKey?: unknown } | null;
		const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
		if (!apiKey) {
			return c.json({ error: "bad_request", message: "apiKey 不能为空" }, 400);
		}
		if (apiKey.length > 512) {
			return c.json({ error: "bad_request", message: "apiKey 需要 1–512 个字符" }, 400);
		}
		const keyEnv = searchKeyEnv();
		try {
			writeProviderKey(keyEnv, apiKey);
		} catch {
			// 失败原因只进服务端日志；响应不回显任何细节
			console.error("[search] 密钥写入失败");
			return c.json(
				{ error: "secrets_write_failed", message: "密钥保存失败，请检查服务端数据目录" },
				500,
			);
		}
		// 热注入：search.ts 每次现读 process.env，下一轮 / 下次测试立刻生效
		process.env[keyEnv] = apiKey;
		console.log(`[search] 密钥已更新 ${keyEnv}`);
		return c.json({ ok: true, keyEnv });
	});

	// ── 删除（界面不提供入口；留着给探针 / 运维）──────────
	app.delete("/api/v1/agent/search-provider", (c) => {
		const keyEnv = searchKeyEnv();
		try {
			removeProviderKeys([keyEnv]);
		} catch {
			console.error("[search] 密钥删除失败");
			return c.json(
				{ error: "secrets_write_failed", message: "密钥删除失败，请检查服务端数据目录" },
				500,
			);
		}
		// 只清运行期 env：.env 里的值重启后照旧生效（那一路归用户自己管）
		delete process.env[keyEnv];
		console.log(`[search] 密钥已从密钥文件移除 ${keyEnv}`);
		return c.json({ ok: true, hasKey: false });
	});

	// ── 连接测试：真调一次搜索 ───────────────────────────
	app.post("/api/v1/agent/search-provider/test", async (c) => {
		const result = await webSearch("连接测试", 1);
		if (result.ok) {
			console.log(`[search] 测试成功 hits=${result.hits.length}`);
			return c.json({
				ok: true,
				hits: result.hits.length,
				message: `搜索通了，返回 ${result.hits.length} 条`,
			});
		}
		console.warn(`[search] 测试失败 error=${result.error}`);
		return c.json({ ok: false, error: result.error, message: result.message });
	});
}
