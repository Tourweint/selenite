/**
 * 注入框架批 A（2026-11-10 批 26b §二 / #7）单测。
 *
 * 钉住五件事：条目形状 / 排序稳定（打乱输入顺序输出一致）/ 同 id 去重（后者覆盖）/
 * 只接管了一个 / 审计不返正文；外加硬标准——接管后 injection_guard 正文逐字节一致。
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { INJECTION_GUARD } from "./injection-guard.ts";
import {
	INJECTION_REGISTRY,
	auditInjections,
	collectInjections,
	guardProvider,
	injectionAuditEnabled,
	type InjectionContext,
	type InjectionEntry,
	type InjectionProvider,
} from "./injection.ts";

const ctx: InjectionContext = { conversationId: 1 };

/** guardProvider 读 AGENT_INJECTION_GUARD；整份文件统一保证它开着，避免被开发机 env 干扰。 */
let savedGuard: string | undefined;
before(() => {
	savedGuard = process.env.AGENT_INJECTION_GUARD;
	delete process.env.AGENT_INJECTION_GUARD;
});
after(() => {
	if (savedGuard === undefined) delete process.env.AGENT_INJECTION_GUARD;
	else process.env.AGENT_INJECTION_GUARD = savedGuard;
});

function sys(id: string, text: string, order: number): InjectionEntry {
	return { id, text, order, scope: "session", channel: "system" };
}

// ── 硬标准 ─────────────────────────────────────────────
test("硬标准：collectInjections([guardProvider], ctx).system[0].text === INJECTION_GUARD", () => {
	const collected = collectInjections([guardProvider], ctx);
	assert.equal(collected.system.length, 1);
	assert.equal(collected.system[0].text, INJECTION_GUARD, "注入正文逐字节一致");
	assert.equal(collected.message.length, 0, "guard 只走 system 通道");
});

// ── 条目形状 ───────────────────────────────────────────
test("条目形状：恰好 {id,text,order,scope,channel} 五个字段、类型正确", () => {
	const entry = collectInjections([guardProvider], ctx).system[0];
	assert.deepEqual(Object.keys(entry).sort(), ["channel", "id", "order", "scope", "text"]);
	assert.equal(entry.id, "injection_guard");
	assert.equal(entry.channel, "system");
	assert.equal(entry.scope, "session");
	assert.equal(typeof entry.order, "number");
	assert.equal(typeof entry.text, "string");
});

// ── 排序稳定：打乱输入顺序输出一致 ───────────────────────
test("排序：order 升序 / 同 order 按 id 字典序；打乱 providers 顺序输出一致", () => {
	const pA: InjectionProvider = () => sys("b", "B", 2);
	const pB: InjectionProvider = () => sys("a", "A", 1);
	const pC: InjectionProvider = () => sys("c", "C", 1);
	const out1 = collectInjections([pA, pB, pC], ctx);
	const out2 = collectInjections([pC, pA, pB], ctx);
	assert.deepEqual(out1, out2, "打乱输入顺序输出不变");
	assert.deepEqual(out1.system.map((e) => e.id), ["a", "c", "b"], "order 升序，同 order 按 id");
});

// ── 同 id 去重：后者覆盖 ────────────────────────────────
test("同 id 去重：后者覆盖（规范序里最后一次出现胜出），且不受 provider 顺序影响", () => {
	const single: InjectionProvider = () => [
		sys("dup", "FIRST", 1),
		sys("dup", "LATER", 2),
	];
	const out = collectInjections([single], ctx);
	assert.equal(out.system.length, 1);
	assert.equal(out.system[0].text, "LATER");

	const p1: InjectionProvider = () => sys("x", "P1", 1);
	const p2: InjectionProvider = () => sys("x", "P2", 2);
	assert.equal(collectInjections([p1, p2], ctx).system[0].text, "P2");
	assert.equal(collectInjections([p2, p1], ctx).system[0].text, "P2", "打乱后仍是 P2");
});

// ── 按 channel 分流 ────────────────────────────────────
test("按 channel 分流：system / message 各归各位", () => {
	const s = sys("s", "S", 0);
	const m: InjectionEntry = { id: "m", text: "M", order: 0, scope: "turn", channel: "message" };
	const out = collectInjections([() => [m, s]], ctx);
	assert.deepEqual(out.system.map((e) => e.id), ["s"]);
	assert.deepEqual(out.message.map((e) => e.id), ["m"]);
});

// ── 只接管了一个 ───────────────────────────────────────
test("批 A 只接管了一个注入（injection_guard）", () => {
	assert.equal(INJECTION_REGISTRY.length, 1, "其余 6 个 section / 5 处 extra.push 一个都没登记");
	assert.equal(INJECTION_REGISTRY[0].source, "injection_guard");
	assert.equal(auditInjections(ctx).length, 1, "审计也只一行");
});

// ── guard 开关：关时省略整段（与改造前逐字节一致）────────
test("guardProvider 关时返回 undefined → system 为空（整段省略）", () => {
	const prev = process.env.AGENT_INJECTION_GUARD;
	try {
		process.env.AGENT_INJECTION_GUARD = "false";
		const collected = collectInjections([guardProvider], ctx);
		assert.equal(collected.system.length, 0);
		assert.equal(collected.message.length, 0);
		assert.equal(auditInjections(ctx).length, 0, "关时审计也不列这一条");
	} finally {
		delete process.env.AGENT_INJECTION_GUARD;
		if (prev !== undefined) process.env.AGENT_INJECTION_GUARD = prev;
	}
});

// ── 审计不返正文 ───────────────────────────────────────
test("审计只回 {id,source,scope,length}，不回正文", () => {
	const rows = auditInjections(ctx);
	assert.equal(rows.length, 1);
	const row = rows[0];
	assert.deepEqual(Object.keys(row).sort(), ["id", "length", "scope", "source"]);
	assert.equal(row.id, "injection_guard");
	assert.equal(row.length, INJECTION_GUARD.length);
	assert.ok(!("text" in row), "没有 text 字段");
	assert.ok(!JSON.stringify(rows).includes(INJECTION_GUARD), "全文不含注入正文");
});

// ── 审计开关：默认开，显式 false 关 ─────────────────────
test("审计开关 AGENT_INJECTION_AUDIT：默认开，显式 false 关", () => {
	assert.equal(injectionAuditEnabled({}), true);
	assert.equal(injectionAuditEnabled({ AGENT_INJECTION_AUDIT: "" }), true);
	assert.equal(injectionAuditEnabled({ AGENT_INJECTION_AUDIT: "0" }), true);
	assert.equal(injectionAuditEnabled({ AGENT_INJECTION_AUDIT: "FALSE" }), false);
});
