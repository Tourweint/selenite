import assert from "node:assert/strict";
import { test } from "node:test";
import { describeStreamError } from "./stream-error.ts";

/**
 * 上游错误分类器（2026-11-10 批 32）钉住的口径：
 *   - aborted/reset 不发错误帧（前端已有「已中断生成」）；
 *   - no_model 归到 auth（动作都是"去设置页"）；
 *   - model_error 按原文关键词分类（限流/密钥/超时/连不上/上下文超长）；
 *   - detail 脱敏：key/token/JWT/长随机串打码、上游地址剥主机、超长截断。
 * 不测真上游调用——这是纯函数。
 */

test("aborted / reset 不需要错误卡", () => {
	assert.equal(describeStreamError("aborted"), null);
	assert.equal(describeStreamError("reset"), null);
});

test("no_model 归 auth：动作都是去设置页", () => {
	const result = describeStreamError("no_model");
	assert.equal(result?.code, "auth");
	assert.ok(result?.message.includes("设置"));
	// 没有原文就不带 detail
	assert.equal(result?.detail, undefined);
});

test("限流措辞识别（中英文两种常见形态）", () => {
	for (const raw of [
		"Error 429: Too Many Requests",
		"rate limit exceeded for org",
		"Arrearage: 您的配额已用尽",
	]) {
		const result = describeStreamError("model_error", raw);
		assert.equal(result?.code, "rate_limited", raw);
	}
});

test("密钥错误识别，detail 里的 key 被打码", () => {
	const result = describeStreamError(
		"model_error",
		'{"error":{"message":"Invalid API key: sk-abc123def456ghi789","code":"invalid_api_key"}}',
	);
	assert.equal(result?.code, "auth");
	assert.ok(!result?.detail?.includes("sk-abc123"), "key 片段不许出现在 detail 里");
});

test("超时与连不上分开", () => {
	assert.equal(describeStreamError("model_error", "request timed out after 30000ms")?.code, "timeout");
	assert.equal(
		describeStreamError("model_error", "fetch failed: connect ECONNREFUSED 1.2.3.4:443")?.code,
		"network",
	);
});

test("上下文超长识别", () => {
	const result = describeStreamError(
		"model_error",
		"This model's maximum context length is 32768 tokens",
	);
	assert.equal(result?.code, "context_overflow");
});

test("认不出的原文归 model_error，不谎报具体原因", () => {
	const result = describeStreamError("model_error", "some totally novel failure");
	assert.equal(result?.code, "model_error");
});

test("detail 脱敏：上游地址剥主机留路径", () => {
	const result = describeStreamError(
		"model_error",
		"POST https://api.secret-gateway.example.com/v1/chat/completions returned 500",
	);
	assert.ok(!result?.detail?.includes("secret-gateway"), "上游主机名不许外泄");
	assert.ok(result?.detail?.includes("/v1/chat/completions"), "路径留下帮助认出是哪家");
});

test("detail 截断到上限并标注剩余", () => {
	// 刻意用普通词组拼长文：连串 x 会被当成密钥打码，测不出截断
	const long = Array.from({ length: 200 }, (_, i) => `第${i}个词`).join(" ");
	const result = describeStreamError("model_error", long);
	assert.ok((result?.detail?.length ?? 0) <= 450);
	assert.ok(result?.detail?.includes("还有"));
});
