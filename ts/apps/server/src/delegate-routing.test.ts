import assert from "node:assert/strict";
import { test } from "node:test";
import {
	directDispatchEnabled,
	resolveDelegateRouting,
	routingToRequestFields,
} from "./delegate-routing.ts";

/**
 * 派活路由单测（2026-11-07 消息即引导与执事直派）。
 *
 * 四象限 + 两个回滚：总管原样、执事同域直派、执事跨域拒绝、普通执事原样；
 * 总闸关 → 一律回落到分管路径（行为与改动前逐字一致）。
 */

const ENV_ON = {} as NodeJS.ProcessEnv;
const ENV_OFF = { MINISTER_DIRECT_DISPATCH: "false" } as NodeJS.ProcessEnv;

test("总管 / 主人会话：原样分管，identity 跟着 domain 走", () => {
	const routed = resolveDelegateRouting({ partnerId: "chief", domain: null }, "frontend", ENV_ON);
	assert.equal(routed.kind, "managed");
	assert.deepEqual(routingToRequestFields(routed), { domain: "frontend", injectIdentity: true });
});

test("主人会话不填 domain：保持既有「直派 worker」语义，且不注入身份", () => {
	const routed = resolveDelegateRouting({ partnerId: null, domain: null }, "", ENV_ON);
	assert.equal(routed.kind, "managed");
	assert.deepEqual(routingToRequestFields(routed), { domain: "", injectIdentity: false });
});

test("执事在自己领域内派活：直派，managers=false，不注入身份", () => {
	const routed = resolveDelegateRouting(
		{ partnerId: "p-1", domain: "frontend" },
		"frontend",
		ENV_ON,
	);
	assert.equal(routed.kind, "direct");
	assert.deepEqual(routingToRequestFields(routed), {
		domain: "frontend",
		managers: false,
		injectIdentity: false,
	});
});

test("执事不填 domain：按自己的领域直派，不退化成「再叫一遍自己」", () => {
	const routed = resolveDelegateRouting({ partnerId: "p-1", domain: "frontend" }, "", ENV_ON);
	assert.equal(routed.kind, "direct");
	assert.equal(routingToRequestFields(routed).managers, false);
});

test("执事跨领域：明确拒绝，不静默改道", () => {
	const routed = resolveDelegateRouting(
		{ partnerId: "p-1", domain: "frontend" },
		"backend",
		ENV_ON,
	);
	assert.equal(routed.kind, "rejected");
	if (routed.kind === "rejected") {
		assert.match(routed.reason, /frontend/);
		assert.match(routed.reason, /backend/);
	}
});

test("普通执事（无 domain）：原样照旧，不参与直派", () => {
	const routed = resolveDelegateRouting({ partnerId: "p-2", domain: null }, "frontend", ENV_ON);
	assert.equal(routed.kind, "managed");
	assert.equal(routingToRequestFields(routed).injectIdentity, true);
});

test("回滚：MINISTER_DIRECT_DISPATCH=false 时执事也走分管路径", () => {
	const routed = resolveDelegateRouting(
		{ partnerId: "p-1", domain: "frontend" },
		"frontend",
		ENV_OFF,
	);
	assert.equal(routed.kind, "managed");
	const fields = routingToRequestFields(routed);
	assert.equal(fields.managers, undefined, "回滚后不能带 managers:false");
	assert.equal(fields.injectIdentity, true);
	assert.equal(directDispatchEnabled(ENV_OFF), false);
	assert.equal(directDispatchEnabled(ENV_ON), true);
});

test("总闸读法：只有明确 false / 0 才关", () => {
	for (const raw of ["false", "FALSE", "0", " false "]) {
		assert.equal(directDispatchEnabled({ MINISTER_DIRECT_DISPATCH: raw }), false, raw);
	}
	for (const raw of ["", "true", "1", "off", "no"]) {
		assert.equal(directDispatchEnabled({ MINISTER_DIRECT_DISPATCH: raw }), true, raw);
	}
});
