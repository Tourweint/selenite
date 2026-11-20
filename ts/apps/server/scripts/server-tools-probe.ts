/**
 * 服务端联网工具探针（2026-11-19）。
 *
 * 真走 `buildApi()` 那一层（含 onPayload 注入），对 magpie 的官方 DeepSeek 路由发一次流式请求，
 * 确认三件事：
 *   1. 注入日志出现（tools 里 function 版 web_search 被替换）；
 *   2. 请求不报错、流式解析正常（服务端工具不会以 tool_calls 形式冒出来）；
 *   3. 回答内容来自实时网页（带来源），而不是旧知识。
 *
 * 用法：SERVER_WEB_SEARCH_TOOLS=on pnpm exec tsx scripts/server-tools-probe.ts
 * 不进单测：要真实网络与真实 key。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApi } from "../src/provider.ts";

const envPath = join(import.meta.dirname, "..", ".env");
try {
	for (const line of readFileSync(envPath, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
	}
} catch {
	// 没有 .env 就用当前环境
}

const SYSTEM = process.env.PROBE_SYSTEM ?? "You are a helpful assistant.";

const QUESTION = process.env.PROBE_QUESTION ?? "今天呼和浩特的天气和气温是多少？给出来源链接。";

// 探针默认开开关：我们要验证的就是「开着的时候注入对不对」
process.env.SERVER_WEB_SEARCH_TOOLS ??= "on";

/** pi-ai 把工具挂在 system 消息的 toolsAdded 上（utils/transcript.js:41）。 */
const localWebSearch = {
	name: "web_search",
	description: "Search the web. (probe stub)",
	parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const model = {
	id: "deepseek/deepseek-flash",
	name: "deepseek/deepseek-flash",
	provider: "magpie",
	baseUrl: "http://127.0.0.1:3425/v1",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

const api = buildApi();
const started = Date.now();
const stream = api.stream(
	model as never,
	{
		messages: [
			{ role: "system", content: SYSTEM, toolsAdded: [localWebSearch] },
			{ role: "user", content: [{ type: "text", text: QUESTION }] },
		],
	} as never,
	{ apiKey: process.env.MAGPIE_API_KEY } as never,
);

const message = await stream.result();
const elapsed = Date.now() - started;
const text = (message.content ?? [])
	.filter((block) => block.type === "text")
	.map((block) => (block as { text: string }).text)
	.join("");

console.log("\n=== 结果 ===");
console.log("stopReason:", message.stopReason);
console.log("耗时:", `${elapsed}ms`);
console.log("文本:", text.slice(0, 320));
console.log("含链接:", /https?:\/\//.test(text) ? "是" : "否");
