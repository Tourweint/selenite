import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryScope } from "@lifediary/memory";
import { DEFAULT_CRITICAL_TOOLS, WRITE_TOOLS } from "./approval-policy.ts";
import type { SkillStore } from "./skills.ts";
import { createTools, type ToolDeps } from "./tools.ts";
import { TOOL_CAPABILITIES, capabilityOf, declaredToolNames } from "./tool-capability.ts";

/**
 * 能力声明的一致性守卫（2026-11-09 任务书 T3 §1.3）。
 *
 * 这是本项真正的价值：以后新增工具**忘了登记**、或登记了但 `destructive` 跟
 * `WRITE_TOOLS` 对不上，这里立刻红。声明本身不改任何判定逻辑（见文件头注释）。
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

test("能力声明：destructive 与 WRITE_TOOLS 逐项等值（双向）", () => {
	for (const [name, cap] of Object.entries(TOOL_CAPABILITIES)) {
		assert.equal(
			cap.destructive,
			WRITE_TOOLS.has(name),
			`${name}: destructive=${cap.destructive} 与 WRITE_TOOLS.has=${WRITE_TOOLS.has(name)} 不一致`,
		);
	}
	for (const name of WRITE_TOOLS) {
		assert.ok(capabilityOf(name), `WRITE_TOOLS 里的 ${name} 没有能力声明`);
		assert.equal(capabilityOf(name)?.destructive, true, `${name} 在 WRITE_TOOLS 里但未标 destructive`);
	}
});

test("能力声明：needsApproval !== never 的集合 = DEFAULT_CRITICAL_TOOLS", () => {
	const byCapability = new Set(
		Object.values(TOOL_CAPABILITIES)
			.filter((cap) => cap.needsApproval !== "never")
			.map((cap) => cap.name),
	);
	const critical = new Set<string>(DEFAULT_CRITICAL_TOOLS);
	assert.deepEqual(
		[...byCapability].sort(),
		[...critical].sort(),
		"高危清单与声明里的 needsApproval 对不上（改了一边忘了另一边）",
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
