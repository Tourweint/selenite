import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeToolResult, err, ok } from "./tool-result.ts";

/**
 * 工具返回统一契约（2026-11-10 批 16 §1.4）：形状正确、`hint` 可选。
 *
 * 断言的是**逐字节形状**而不是"包含这些字段"：这份契约要给手机端 / 未来的
 * 浏览器自动化消费，多一个键少一个键都算契约变化。
 */

test("ok：成功只带 ok + data，不夹带 error", () => {
	const result = ok({ count: 2, message: "找到了" });
	assert.deepEqual(result, { ok: true, data: { count: 2, message: "找到了" } });
	assert.equal(Object.keys(result).length, 2);
	assert.equal("error" in result, false);
});

test("err：给 hint 时三件齐全，不给时 error 里不许出现 hint 键", () => {
	const withHint = err("progress_too_long", "超长了", "压成一句");
	assert.deepEqual(withHint, {
		ok: false,
		error: { code: "progress_too_long", message: "超长了", hint: "压成一句" },
	});

	const withoutHint = err("progress_empty", "不能为空");
	assert.deepEqual(withoutHint, {
		ok: false,
		error: { code: "progress_empty", message: "不能为空" },
	});
	assert.equal("hint" in withoutHint.error, false, "没给 hint 时不该写 undefined 进去");
});

test("encodeToolResult：同输入逐字节相同，且能原样解回来", () => {
	const success = ok({ status: "waiting", callId: "call-1" });
	const encoded = encodeToolResult(success);
	assert.equal(encoded, encodeToolResult(ok({ status: "waiting", callId: "call-1" })));
	assert.deepEqual(JSON.parse(encoded), success);

	const failure = encodeToolResult(err("recall_failed", "没跑成"));
	assert.deepEqual(JSON.parse(failure), {
		ok: false,
		error: { code: "recall_failed", message: "没跑成" },
	});
});
