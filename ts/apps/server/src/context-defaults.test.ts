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
test("完整清单：固定 29 个字段，缺的补空；已有内容原位保留", () => {
	const sections = completeDefaultSections([
		{ key: "persona", text: "总管人设" },
		{ key: "partner_voice", text: "" },
		{ key: "topics", text: "课题正文" },
	]);
	assert.equal(DEFAULT_SECTION_KEYS.length, 29, "2026-11-16 C 段：末尾加了 tool_index");
	assert.deepEqual(
		sections.map((section) => section.key),
		[...DEFAULT_SECTION_KEYS],
	);
	assert.equal(sections.find((section) => section.key === "persona")?.text, "总管人设");
	assert.equal(sections.find((section) => section.key === "topics")?.text, "课题正文");
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

test("工具面按 role 的 disabledTools 过滤：partner / chief 少一项，worker 不受影响", async () => {
	const store = partnersStore();
	const partner = store.create("默认页工具执事");

	const baseline = await contextDefaultPayload("worker");
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

	const worker = await contextDefaultPayload("worker");
	assert.equal(worker?.tools.count, total, "worker 不过滤");

	store.ensureChief("你是总管");
	store.setDisabledTools(CHIEF_PARTNER_ID, ["read"]);
	const chief = await contextDefaultPayload("chief");
	assert.equal(chief?.tools.count, total - 1, "总管默认页同样按总管行过滤");
	assert.ok(!(chief?.tools.items ?? []).some((tool) => tool.name === "read"));
});

test("默认页含 tool_index 段，但 tools 不含 deferred 工具（2026-11-16 C 段）", async () => {
	const payload = await contextDefaultPayload("worker");
	assert.ok(payload, "worker 默认页可读");
	const section = payload!.system.sections.find((item) => item.key === "tool_index");
	assert.ok(section, "默认页出现 tool_index 段");
	assert.match(section!.text, /^<tool_index>/);
	assert.match(section!.text, /按需工具（初始不加载）/);

	const names = payload!.tools.items.map((item) => item.name);
	for (const deferred of [
		"routine_manage",
		"partner_manage",
		"group_manage",
		"send_to_agent",
	]) {
		assert.ok(!names.includes(deferred), `${deferred} 不在初始默认工具面`);
	}
});

test("PARTNER_TOOLS_ENABLED=false：默认页不过滤（回滚到所有人同一份工具面）", async () => {
	const store = partnersStore();
	const partner = store.create("关过滤执事");
	store.setDisabledTools(partner.id, ["read"]);
	const prev = process.env.PARTNER_TOOLS_ENABLED;
	process.env.PARTNER_TOOLS_ENABLED = "false";
	try {
		const baseline = await contextDefaultPayload("worker");
		const filtered = await contextDefaultPayload(`partner:${partner.id}`);
		assert.equal(filtered?.tools.count, baseline?.tools.count, "开关关：不过滤");
		assert.ok((filtered?.tools.items ?? []).some((tool) => tool.name === "read"));
	} finally {
		if (prev === undefined) delete process.env.PARTNER_TOOLS_ENABLED;
		else process.env.PARTNER_TOOLS_ENABLED = prev;
	}
});