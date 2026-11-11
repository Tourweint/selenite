import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryScope } from "@lifediary/memory";
import { DEFAULT_CRITICAL_TOOLS, WRITE_TOOLS, declaredCriticalTools } from "./approval-policy.ts";
import type { SkillStore } from "./skills.ts";
import { createTools, type ToolDeps } from "./tools.ts";
import { TOOL_CAPABILITIES, capabilityOf, declaredToolNames } from "./tool-capability.ts";

/**
 * 能力声明的一致性守卫（2026-11-09 任务书 T3 §1.3；2026-11-10 批 21 §一.4 加强）。
 *
 * 自从 `needsApproval()` 改读声明（批 21），这张表就是审批的事实源：
 * 漏登记 / 登记错一个 `destructive`，等于闸门悄悄改了口径。所以这里做**双向集合等值**，
 * 而不是逐项 `assert.equal`：两边多一个或少一个都会红。
 */

const GLOBAL_SCOPE: MemoryScope = { type: "global" };
const MOCK_SKILLS: SkillStore = {
	names: () => [],
	manual: () => undefined,
	indexFor: () => undefined,
};

function makeDeps(over: Partial<ToolDeps> = {}): ToolDeps {
	return { memory: null, scopeOf: () => GLOBAL_SCOPE, ...over };
}

/** 内核五件不在 createTools 里（装的是 CodingTools），手工补名。 */
const KERNEL_TOOLS = ["read", "write", "edit", "bash", "powershell"];

/** 本次上架的全集：10 基线 + 条件注册 + ask_user（本批之后）。 */
const EXPECTED_TOOLS = [
	...KERNEL_TOOLS,
	"remember",
	"recall",
	"set_reminder",
	"propose_project",
	"delegate",
	"skill",
	"partner_skill_write",
	"partner_manage",
	"group_manage",
	"routine_manage",
	"web_search",
	"propose_topic",
	"send_to_agent",
	"persona_recall",
	"ask_user",
	"report_progress",
	// 批 30 修订：save_skill_advice（SKILL_ADVICE 开时上架；能力表已登记）
	"save_skill_advice",
].sort();

function registeredToolNames(): string[] {
	const tools = createTools(
		makeDeps({
			delegate: true,
			skills: MOCK_SKILLS,
			partners: true,
			relay: { deliver: async () => ({ ok: false, error: "stub" }) },
			routineSelfService: true,
			scheduleRoutine: async () => undefined,
			// persona 检索（2026-11-09 批一）：条件注册，给个不落盘替身把全集覆盖进来。
			personaAsk: async () => ({ ok: true, question: "stub" }),
			skillAdviceSave: () => ({ ok: true, saved: 0, kept: 0 }),
			// 中途播报（2026-11-10 批 13）：条件注册，显式开才上架。
			progressReport: true,
		}),
	);
	return [...new Set([...KERNEL_TOOLS, ...tools.map((t) => t.name)])].sort();
}

test("能力声明：声明表覆盖已知工具全集（新增工具必须登记）", () => {
	assert.deepEqual(
		declaredToolNames(),
		EXPECTED_TOOLS,
		"声明表与已知工具全集不一致：加/删工具时同步 tool-capability.ts",
	);
});

test("能力声明：每个实际注册的工具都有声明", () => {
	const missing = registeredToolNames().filter((name) => capabilityOf(name) === undefined);
	assert.deepEqual(missing, [], `这些工具注册了却没登记能力声明：${missing.join(", ")}`);
});

test("能力声明：destructive 集合 === WRITE_TOOLS 集合（双向，集合级）", () => {
	const byDeclaration = new Set(
		Object.values(TOOL_CAPABILITIES)
			.filter((cap) => cap.destructive)
			.map((cap) => cap.name),
	);
	assert.deepEqual(
		[...byDeclaration].sort(),
		[...WRITE_TOOLS].sort(),
		"声明的 destructive 集合与 WRITE_TOOLS 不等（多一个/少一个都会让审批口径漂移）",
	);
	for (const name of WRITE_TOOLS) {
		assert.equal(capabilityOf(name)?.destructive, true, `${name} 在 WRITE_TOOLS 里但未标 destructive`);
	}
	for (const name of byDeclaration) {
		assert.ok(WRITE_TOOLS.has(name), `${name} 声明 destructive 却不在 WRITE_TOOLS 里`);
	}
});

test("能力声明：needsApproval === critical 的集合 === DEFAULT_CRITICAL_TOOLS（双向，集合级）", () => {
	const byDeclaration = new Set(
		Object.values(TOOL_CAPABILITIES)
			.filter((cap) => cap.needsApproval === "critical")
			.map((cap) => cap.name),
	);
	const critical = new Set<string>(DEFAULT_CRITICAL_TOOLS);
	assert.deepEqual(
		[...byDeclaration].sort(),
		[...critical].sort(),
		"高危清单与声明里的 needsApproval 对不上（改了一边忘了另一边）",
	);
	// 运行时判定读的就是这个函数：它与常量必须是同一份真话
	assert.deepEqual(
		[...declaredCriticalTools()].sort(),
		[...critical].sort(),
		"declaredCriticalTools() 与 DEFAULT_CRITICAL_TOOLS 不一致",
	);
});

test("能力声明：只读工具不可能是 destructive，写类也不可能是 readOnly", () => {
	for (const cap of Object.values(TOOL_CAPABILITIES)) {
		if (cap.readOnly) {
			// `recall` 的命中强化算在 memory 作用域里，仍属读路径——只钉"不是不可撤销写"。
			assert.equal(cap.destructive, false, `${cap.name} 既只读又不可撤销`);
			assert.notEqual(cap.sideEffectScope, "workspace", `${cap.name} 只读却会改工作区`);
			assert.notEqual(cap.sideEffectScope, "process", `${cap.name} 只读却会起进程`);
		}
		if (cap.destructive) {
			assert.equal(cap.readOnly, false, `${cap.name} 标了不可撤销却又是只读`);
		}
	}
});
