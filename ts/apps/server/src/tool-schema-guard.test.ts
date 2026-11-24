import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryScope } from "@lifediary/memory";
import type { SkillStore } from "./skills.ts";
import type { SearchModule } from "./search.ts";

/**
 * 工具 schema 缓存守卫（2026-11-10 批 16 §二；全景调研七 #9）。
 *
 * 工具清单是**提示词前缀**的一部分：模型看到的系统提示里工具按注册顺序排列，
 * 顺序一变（或描述改动）前缀就变，上游的 prompt cache 整段失效——一次改动带来
 * 每轮全量 token 的重算。这不是运行时问题，是**每次发版都在付的账单**，
 * 所以用快照式断言钉住：顺序变了就红，逼人先确认这是有意的。
 *
 * 为什么不做运行时检查：运行时检查只能拦"这一次请求"，拦不住"发版后一直贵"；
 * 而且多一次分支。纪律归测试。
 *
 * 这份清单只覆盖**顺序**；描述正文的改动仍靠 变更记录 记（AGENTS.md 硬约束）。
 * 更新清单 = 一次有意的契约变更：同步在 `docs/变更记录/` 里写清为什么。
 */

/** 当前注册顺序（2026-11-10 批 16 核对）。改动它之前先读文件头的理由。 */
const REGISTERED_ORDER = [
	"remember",
	"recall",
	"set_reminder",
	"recall_sessions",
	"skill",
	"send_to_agent",
	"delegate",
	"propose_project",
	"ask_user",
	// respond_escalation（2026-11-19 批2 决策上报链）：插在 ask_user 之后；
	// 默认按需（tool-pool 名单），常驻形态才进前缀——前缀资产变动由验收方在
	// docs/变更记录/ 交代（工具描述原文见 escalation.ts 的 RESPOND_ESCALATION_DESCRIPTION）。
	"respond_escalation",
	"report_progress",
	"partner_skill_write",
	"partner_manage",
	"group_manage",
	"routine_manage",
	"web_search",
	// tool_search（2026-11-16 工具裁剪 C 段新增，2026-11-17 补钉清单）：deferred 工具按需
	// 加载的搜索入口，注册在末位——不动既有顺序，既有前缀不受影响；新工具本身换前缀
	// 已在 docs/变更记录/2026-11-16-工具裁剪（delegate 手册与工具勾选）.md 交代。
	// save_reminder_advice（2026-11-19 批4 提醒沉淀）：插在 tool_search 之前（tools.ts
	// 末段、tool_search 块之前注册）；默认按需（tool-pool 名单），常驻形态才进前缀——
	// 前缀资产变动由验收方在 docs/变更记录/ 交代（描述原文见 reminder-advice.ts 的
	// SAVE_REMINDER_ADVICE_DESCRIPTION）。
	"save_reminder_advice",
	"tool_search",
];

const CACHE_WARNING =
	"工具注册顺序 / 描述变动会打掉提示词缓存（前缀资产）：确认是有意的再更新这份清单，" +
	"并在 docs/变更记录/ 里写清为什么。";

// 全开装配：把条件注册的工具全部纳入快照，否则"条件分支顺序"这半边没人守。
process.env.AGENT_ASK_USER = "true";
process.env.COMPANIONS_ENABLED = "true";
process.env.GROUPS_ENABLED = "true";

const { createTools } = await import("./tools.ts");

const SCOPE: MemoryScope = { type: "global" };
const SKILLS: SkillStore = { names: () => [], manual: () => undefined, indexFor: () => undefined };
// 只为了让条件注册成立，执行期不会被调到。
const SEARCH = {} as unknown as SearchModule;

function fullTools() {
	return createTools({
		memory: null,
		scopeOf: () => SCOPE,
		skills: SKILLS,
		recallSessions: async () => [],
		relay: { deliver: async () => ({ ok: false, error: "stub" }) },
		// 提醒沉淀落盘（2026-11-19 批4）：条件注册，给个不落盘替身把顺序快照覆盖进来。
		reminderAdviceSave: () => ({ ok: true, saved: 0 }),
		progressReport: true,
		partners: true,
		groups: true,
		routineSelfService: true,
		search: SEARCH,
	});
}

test("工具注册顺序稳定（缓存前缀资产，顺序见测试文件头）", () => {
	const actual = fullTools().map((tool) => tool.name);
	assert.deepEqual(actual, REGISTERED_ORDER, CACHE_WARNING);
});

test("记忆工具面恒为 2 个（recall / remember）；旧 persona 工具不再出现", () => {
	// 2026-11-24 旧形态退役：MEMORY_BANK 总闸删除后，任何装配形态都只挂这两把记忆工具。
	const minimal = createTools({ memory: null, scopeOf: () => SCOPE }).map((tool) => tool.name);
	assert.ok(minimal.includes("recall"), "基线必须有 recall");
	assert.ok(minimal.includes("remember"), "基线必须有 remember");
	assert.ok(!minimal.includes("persona_recall"), "persona_recall 已退役");
	assert.ok(!minimal.includes("persona_write"), "persona_write 已退役");
	const full = fullTools().map((tool) => tool.name);
	assert.ok(!full.includes("persona_recall"), "全开装配也不得注册 persona_recall");
	assert.ok(!full.includes("persona_write"), "全开装配也不得注册 persona_write");
});

test("快照没有重名（重名等于同一个工具被注册两次，前缀也会变）", () => {
	assert.equal(new Set(REGISTERED_ORDER).size, REGISTERED_ORDER.length, CACHE_WARNING);
});
