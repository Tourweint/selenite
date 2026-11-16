import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryScope } from "@lifediary/memory";
import type { SkillStore } from "./skills.ts";
import type { TopicsStore } from "./topics.ts";
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
	"persona_recall",
	// persona_write（2026-11-17 persona_write 批）：插在 persona_recall 之后；
	// 前缀资产变动已在变更记录里交代（新工具注册本身就换前缀）。
	"persona_write",
	"skill",
	"send_to_agent",
	"delegate",
	"propose_project",
	"ask_user",
	"report_progress",
	"partner_skill_write",
	"partner_manage",
	"group_manage",
	"routine_manage",
	"web_search",
	"propose_topic",
];

const CACHE_WARNING =
	"工具注册顺序 / 描述变动会打掉提示词缓存（前缀资产）：确认是有意的再更新这份清单，" +
	"并在 docs/变更记录/ 里写清为什么。";

// 全开装配：把条件注册的工具全部纳入快照，否则"条件分支顺序"这半边没人守。
process.env.AGENT_ASK_USER = "true";
process.env.COMPANIONS_ENABLED = "true";
process.env.GROUPS_ENABLED = "true";
process.env.TOPICS_ENABLED = "true";

const { createTools } = await import("./tools.ts");

const SCOPE: MemoryScope = { type: "global" };
const SKILLS: SkillStore = { names: () => [], manual: () => undefined, indexFor: () => undefined };
// 只为了让条件注册成立，执行期不会被调到。
const TOPICS = {} as unknown as TopicsStore;
const SEARCH = {} as unknown as SearchModule;

function fullTools() {
	return createTools({
		memory: null,
		scopeOf: () => SCOPE,
		skills: SKILLS,
		recallSessions: async () => [],
		personaAsk: async () => ({ ok: true, question: "stub" }),
		// persona 写入（2026-11-17 persona_write 批）：条件注册，快照要覆盖它。
		personaWrite: async () => ({ ok: true }),
		relay: { deliver: async () => ({ ok: false, error: "stub" }) },
		progressReport: true,
		partners: true,
		groups: true,
		routineSelfService: true,
		topics: TOPICS,
		search: SEARCH,
	});
}

test("工具注册顺序稳定（缓存前缀资产，顺序见测试文件头）", () => {
	const actual = fullTools().map((tool) => tool.name);
	assert.deepEqual(actual, REGISTERED_ORDER, CACHE_WARNING);
});

test("快照没有重名（重名等于同一个工具被注册两次，前缀也会变）", () => {
	assert.equal(new Set(REGISTERED_ORDER).size, REGISTERED_ORDER.length, CACHE_WARNING);
});
