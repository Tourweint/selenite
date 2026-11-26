import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 默认页单测（2026-11-16 工具裁剪 B 扩）：工具面按 role 对应的人设 disabledTools 过滤。
 * 真起 faux Harness + 临时 SQLite / 伙伴家目录，不碰 .data / .env / 39847 活服务。
 * 先钉环境再动态 import —— memoryEngine / skillStore 在 assist.ts 模块顶层构造，
 * 静态 import 会读真实 .data（companion-api.test.ts 同款口径）。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-ctx-defaults-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "homes");
process.env.COMPANIONS_ENABLED = "true";
process.env.LLM_PROVIDER = "faux";
process.env.MEMORY_ENABLED = "false";
process.env.CHANCELLOR_ENABLED = "false";
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.AGENT_SSE_SEQ_DB_PATH = join(root, "chat-events.sqlite");
process.env.AGENT_APPROVALS_PATH = join(root, "approvals.json");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
process.env.PROVIDERS_PATH = join(root, "providers.json");
process.env.DELEGATIONS_DB_PATH = join(root, "delegations.sqlite");
process.env.AGENT_POLICY_PATH = join(root, "policy.json");
process.env.ROUTINES_STATE_PATH = join(root, "routines.json");
process.env.AUTONOMY_STATE_PATH = join(root, "autonomy-state.json");
process.env.AGENT_SKILLS_STATE_PATH = join(root, "skills-state.json");
process.env.PARTNER_TOOLS_ENABLED = "true";
process.env.WORKER_TOOLS_PATH = join(root, "worker-tools.json");
// 2026-11-25 按需池默认空：把池配置也挪到临时目录，断言"默认全部常驻"时不受 .data/tool-pool.json 影响。
process.env.AGENT_TOOL_POOL_PATH = join(root, "tool-pool.json");

const {
  DEFAULT_SECTION_KEYS,
  completeDefaultSections,
  contextDefaultPayload,
} = await import("./context-defaults.ts");
const { partnersStore } = await import("./partners.ts");
const { CHIEF_PARTNER_ID } = await import("./partner-contract.ts");

after(() => {
  partnersStore().close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 上 Harness 的 SQLite 句柄可能还没放：临时目录留着不挡测试通过
  }
});

/**
 * 默认开销的完整字段清单（2026-11-16）：
 * 不管总管 / 执事 / worker，页面都按同一份清单显示；不适用字段保留 0 字槽位。
 */
test("完整清单：固定 28 个字段（2026-11-25 移除 tool_index 段），缺的补空；已有内容原位保留", () => {
	const sections = completeDefaultSections([
		{ key: "persona", text: "总管人设" },
		{ key: "partner_voice", text: "" },
	]);
	assert.equal(
		DEFAULT_SECTION_KEYS.length,
		28,
		"2026-11-25 按需工具默认常驻：tool_index 改走尾部注入，system 段清单再减一（旧断言 29）",
	);
	assert.deepEqual(
		sections.map((section) => section.key),
		[...DEFAULT_SECTION_KEYS],
	);
	assert.equal(sections.find((section) => section.key === "persona")?.text, "总管人设");
	assert.equal(sections.find((section) => section.key === "partner_voice")?.text, "");
	assert.equal(sections.find((section) => section.key === "partner_values")?.text, "");
});

test("skills 是单独块：不占字段位，但保留在系统段末尾", () => {
	const sections = completeDefaultSections([
		{ key: "persona", text: "人设" },
		{ key: "skills", text: "- 查资料：先搜再答" },
	]);
	assert.equal(sections.at(-1)?.key, "skills");
	assert.equal(sections.at(-1)?.text, "- 查资料：先搜再答");
	assert.equal(sections.filter((section) => section.key === "skills").length, 1);
	assert.equal(sections.length, DEFAULT_SECTION_KEYS.length + 1);
});

test("普通 worker 档已从默认开销目录移除（2026-11-24）", async () => {
	const payload = await contextDefaultPayload("chief");
	assert.ok(payload, "总管默认页可读");
	assert.ok(
		!(payload!.roles ?? []).some((role) => role.id === "worker"),
		"角色目录不再列出普通 worker",
	);
	assert.equal(await contextDefaultPayload("worker"), null, "worker 角色不再可读（路由 404）");
});

test("工具面按 role 的 disabledTools 过滤：partner / chief 少一项", async () => {
	const store = partnersStore();
	const partner = store.create("默认页工具执事");

	const baseline = await contextDefaultPayload("chief");
	const total = baseline?.tools.count ?? 0;
	assert.ok(total > 0, "真实 extension 已装：默认工具面非空");
	assert.ok(
		(baseline?.tools.items ?? []).some((tool) => tool.name === "read"),
		"基线含 read（用于过滤对照）",
	);

	store.setDisabledTools(partner.id, ["read"]);
	const filtered = await contextDefaultPayload(`partner:${partner.id}`);
	assert.equal(filtered?.tools.count, total - 1, "执事默认页少一个工具");
	assert.ok(
		!(filtered?.tools.items ?? []).some((tool) => tool.name === "read"),
		"被取消的 read 不出现在执事默认页",
	);

	store.ensureChief("你是总管");
	store.setDisabledTools(CHIEF_PARTNER_ID, ["read"]);
	const chief = await contextDefaultPayload("chief");
	assert.equal(chief?.tools.count, total - 1, "总管默认页同样按总管行过滤");
	assert.ok(!(chief?.tools.items ?? []).some((tool) => tool.name === "read"));

	// 后面的用例还要拿总管当干净基线：这里把总管行的取消名单还原。
	store.setDisabledTools(CHIEF_PARTNER_ID, []);
});

test("默认全部常驻：没有 tool_index 段、没有 tool_search，旧按需工具都在初始工具面（2026-11-25）", async () => {
	const payload = await contextDefaultPayload("chief");
	assert.ok(payload, "总管默认页可读");
	assert.ok(
		!payload!.system.sections.some((item) => item.key === "tool_index"),
		"system 段里不再有 tool_index（改走尾部消息注入）",
	);

	const names = payload!.tools.items.map((item) => item.name);
	assert.ok(!names.includes("tool_search"), "没有按需工具就不注册 tool_search");
	// 旧默认按需池里的四件在本装配环境里一定注册，默认全常驻后应直接出现在初始工具面。
	for (const resident of ["routine_manage", "partner_manage", "group_manage", "send_to_agent"]) {
		assert.ok(names.includes(resident), `${resident} 默认常驻，应在初始工具面`);
	}
});

test("dispatch-worker：池任务 profile 的九段 + 五件工具（2026-11-22）", async () => {
  const payload = await contextDefaultPayload("dispatch-worker");
  assert.ok(payload, "dispatch-worker 默认页可读");
  assert.equal(payload!.role.kind, "dispatch");
  assert.equal(payload!.role.label, "派活工人（池）");
  const keys = payload!.system.sections.map((section) => section.key);
  for (const key of [
    "worker_rules",
    "injection_guard",
    "verification_iron_law",
    "persona",
    "task",
    "project_memory",
    "upstream",
    "delivery_contract",
    "boundary",
  ]) {
    assert.ok(keys.includes(key), `缺 ${key}`);
  }
  const persona = payload!.system.sections.find((section) => section.key === "persona");
  assert.equal(persona?.editable, true, "人设段可编辑（共用的 worker-persona）");
  assert.match(persona?.text ?? "", /^<persona>/);
  assert.deepEqual(
    payload!.tools.items.map((tool) => tool.name),
    ["read", "write", "edit", "bash", "escalate"],
  );
  assert.equal(payload!.skills.count, 0, "池工人不读技能索引");
});


test("PARTNER_TOOLS_ENABLED=false：默认页不过滤（回滚到所有人同一份工具面）", async () => {
	const store = partnersStore();
	const partner = store.create("关过滤执事");
	store.setDisabledTools(partner.id, ["read"]);
	const prev = process.env.PARTNER_TOOLS_ENABLED;
	process.env.PARTNER_TOOLS_ENABLED = "false";
	try {
		const baseline = await contextDefaultPayload("chief");
		const filtered = await contextDefaultPayload(`partner:${partner.id}`);
		assert.equal(filtered?.tools.count, baseline?.tools.count, "开关关：不过滤");
		assert.ok((filtered?.tools.items ?? []).some((tool) => tool.name === "read"));
	} finally {
		if (prev === undefined) delete process.env.PARTNER_TOOLS_ENABLED;
		else process.env.PARTNER_TOOLS_ENABLED = prev;
	}
});