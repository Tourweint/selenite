import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_USER_INPUT_WHEN_BUSY, defaultUserInputWhenBusy, userInputSubmission } from "./agent/user-input.ts";

/**
 * 产品承诺（2026-11-09 T2 §5 立此；2026-11-19 插话统一 批1 改口径）：人的消息永远插得上话。
 * 这里只钉"入队形状"：缺省 steer（插进当前轮，2026-11-19 改）、原文与 parts 不丢。
 * 真正的插话/排队/落库仍是 durable 的职责（http 探针 §19 已覆盖 whenBusy 契约）。
 */

test("缺省 whenBusy = steer（忙时插话，不拒；2026-11-19 插话统一改缺省）", () => {
	assert.equal(DEFAULT_USER_INPUT_WHEN_BUSY, "steer");
	const body = userInputSubmission({ text: "在吗" });
	assert.equal(body.whenBusy, "steer");
	assert.equal(body.type, "input");
	assert.equal(body.content, "在吗");
});

test("回滚开关：AGENT_STEER_DEFAULT=false → 缺省回 followUp（改动前口径）", () => {
	assert.equal(defaultUserInputWhenBusy({ AGENT_STEER_DEFAULT: "false" }), "followUp");
	assert.equal(defaultUserInputWhenBusy({ AGENT_STEER_DEFAULT: "0" }), "followUp");
	assert.equal(defaultUserInputWhenBusy({}), "steer");
	assert.equal(defaultUserInputWhenBusy({ AGENT_STEER_DEFAULT: "true" }), "steer");
});

test("客户端明确要 steer 时不被改写", () => {
	assert.equal(userInputSubmission({ text: "补一句", whenBusy: "steer" }).whenBusy, "steer");
});

test("带图：content 走 parts，纯文本 text 不被合并或丢失", () => {
	const parts = [
		{ type: "text" as const, text: "图里是什么" },
		{ type: "image" as const, mimeType: "image/png", data: "AAAA" },
	];
	const body = userInputSubmission({ text: "图里是什么", parts });
	assert.deepEqual(body.content, parts, "分段原样提交");
});

test("requestId 原样带上（重试幂等）；没有就不带键", () => {
	assert.equal(userInputSubmission({ text: "x", requestId: "req-1" }).requestId, "req-1");
	assert.equal("requestId" in userInputSubmission({ text: "x" }), false);
});

test("忙时入队：提交不抛、正文不丢（模拟一轮还在跑的会话）", async () => {
	const seen: unknown[] = [];
	let busy = true;
	const conversation = {
		submit: async (body: unknown) => {
			// 模拟 durable：忙时不是拒绝，而是受理并排队（这里只验调用不抛、入参完整）
			await new Promise((resolve) => setTimeout(resolve, 5));
			seen.push(body);
			return { status: busy ? "queued" : "done" };
		},
	};
	const body = userInputSubmission({ text: "趁它跑着，再加一句" });
	const receipt = (await conversation.submit(body)) as { status: string };
	assert.equal(receipt.status, "queued", "忙时是排队，不是报错");
	assert.equal(seen.length, 1, "消息已受理（没被丢弃）");
	assert.deepEqual(seen[0], body, "排队的那条就是用户原话");
	busy = false;
});
