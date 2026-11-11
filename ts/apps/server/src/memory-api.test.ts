import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 记忆管理端点（2026-11-06）：GET / DELETE / POST supersede。
 *
 * 真挂 Hono + 真开记忆库（临时目录，不碰 `.data/`）。env 必须在动态 import
 * `agent.ts` 之前设好——记忆引擎是模块级单例，加载即按 env 建库。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-memory-api-"));
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.AGENT_APPROVALS_PATH = join(root, "approvals.json");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
// 整理建议的待决文件：必须隔离，别碰真实 .data/memory-proposals.json
process.env.MEMORY_PROPOSALS_PATH = join(root, "memory-proposals.json");
// 巩固审计 diff 落点（2026-11-10 批 17 §三）：同样隔离
process.env.MEMORY_CONSOLIDATE_DIFF_PATH = join(root, "memory-consolidate-diff.json");
// 证据引文（2026-11-10 对标 Anthropic）默认关掉：别让既有用例真去扫跨会话记录；
// 专测里显式打开（开关是每次请求读的，进程内翻转即可）。
process.env.MEMORY_REVIEW_EVIDENCE = "false";
process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
process.env.PROVIDERS_PATH = join(root, "providers.json");
process.env.DELEGATIONS_DB_PATH = join(root, "delegations.sqlite");
process.env.AGENT_SSE_SEQ_DB_PATH = join(root, "chat-events.sqlite");
process.env.AGENT_POLICY_PATH = join(root, "policy.json");
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.ROUTINES_STATE_PATH = join(root, "routines.json");
process.env.AUTONOMY_STATE_PATH = join(root, "autonomy-state.json");
process.env.LLM_PROVIDER = "faux";
process.env.MEMORY_ENABLED = "true";
// 端点测试不关心抽取档位；锁定 rule 以免将来默认值变化时这里莫名多打一次模型
process.env.MEMORY_EXTRACT = "rule";
process.env.CHANCELLOR_ENABLED = "false";
process.env.COMPANIONS_ENABLED = "false";

const { Hono } = await import("hono");
const { mountMemoryApi } = await import("./memory-api.ts");
const { memoryEngine } = await import("./agent.ts");
const { pendingProposalCount } = await import("./memory-consolidate.ts");
type EvidenceHit = import("./agent.ts").EvidenceHit;

type Generator = (input: { system: string; user: string }) => Promise<string | null>;

function newApp(enabled = true, generate?: Generator) {
	const app = new Hono();
	mountMemoryApi(app, { enabled, ...(generate ? { generate } : {}) });
	return app;
}

test("记忆端点：列表按 kind 分组，偏好排最前", async () => {
	assert.ok(memoryEngine, "记忆引擎应已按 env 建好");
	memoryEngine.remember({ kind: "episode", scope: { type: "global" }, content: "上周去了杭州" });
	memoryEngine.remember({ kind: "fact", scope: { type: "global" }, content: "住在上海" });
	memoryEngine.remember({
		kind: "preference",
		scope: { type: "global" },
		content: "不喜欢被追问太多\nWhy: 说过会累\nHow: 一次只问一个",
	});

	const response = await newApp().request("/api/v1/agent/memory");
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		ok: boolean;
		enabled: boolean;
		total: number;
		byKind: Record<string, number>;
		items: Array<{ id: string; kind: string; content: string }>;
	};
	assert.equal(body.ok, true);
	assert.equal(body.enabled, true);
	assert.equal(body.total, 3);
	assert.equal(body.byKind.preference, 1);
	assert.deepEqual(
		body.items.map((item) => item.kind),
		["preference", "fact", "episode"],
		"列表应按 preference → fact → episode 分组",
	);
	assert.ok(body.items[0]!.content.includes("Why:"), "正文应保留 Why/How 段");
});

test("记忆端点：删除是硬删，重复删除 404", async () => {
	const engine = memoryEngine!;
	const record = engine.remember({ kind: "fact", scope: { type: "global" }, content: "待删除的一条" });
	const app = newApp();

	const first = await app.request(`/api/v1/agent/memory/${encodeURIComponent(record.id)}`, {
		method: "DELETE",
	});
	assert.equal(first.status, 200);
	assert.equal(((await first.json()) as { deleted: string }).deleted, record.id);

	const second = await app.request(`/api/v1/agent/memory/${encodeURIComponent(record.id)}`, {
		method: "DELETE",
	});
	assert.equal(second.status, 404);
	assert.equal(((await second.json()) as { error: string }).error, "not_found");
});

test("记忆端点：取代后旧条不再进召回，历史仍可查", async () => {
	const engine = memoryEngine!;
	const old = engine.remember({ kind: "fact", scope: { type: "global" }, content: "我住在北京" });
	const fresh = engine.remember({ kind: "fact", scope: { type: "global" }, content: "我搬到上海了" });
	const app = newApp();

	const response = await app.request(
		`/api/v1/agent/memory/${encodeURIComponent(old.id)}/supersede`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ byId: fresh.id }),
		},
	);
	assert.equal(response.status, 200);
	const body = (await response.json()) as { superseded: string; byId: string };
	assert.equal(body.byId, fresh.id);

	assert.ok(!engine.recall({ text: "北京", scopes: ["global"] }).some((hit) => hit.record.id === old.id));
	assert.ok(engine.list({ scopes: ["global"], includeSuperseded: true }).some((row) => row.id === old.id));
});

test("记忆端点：缺 id / 替代者不存在 / byId 类型不对，各归其位", async () => {
	const engine = memoryEngine!;
	const record = engine.remember({ kind: "fact", scope: { type: "global" }, content: "一条普通事实" });
	const app = newApp();

	const badType = await app.request(
		`/api/v1/agent/memory/${encodeURIComponent(record.id)}/supersede`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ byId: 42 }),
		},
	);
	assert.equal(badType.status, 400);

	const missing = await app.request("/api/v1/agent/memory/不存在的-id/supersede", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	assert.equal(missing.status, 404);
});

test("记忆端点：只有 global 以外的 scope 时不串（session 沉淀不进列表）", async () => {
	const engine = memoryEngine!;
	engine.remember({ kind: "episode", scope: { type: "session", id: "999" }, content: "只在会话里的一条" });
	const response = await newApp().request("/api/v1/agent/memory?scope=global&limit=200");
	const body = (await response.json()) as { items: Array<{ content: string }> };
	assert.ok(
		!body.items.some((item) => item.content.includes("只在会话里的一条")),
		"默认列 global，不应带出 session scope 的记录",
	);
});

test("记忆端点：未启用时三个端点统一 404 memory_disabled", async () => {
	const app = newApp(false);
	const list = await app.request("/api/v1/agent/memory");
	assert.equal(list.status, 404);
	assert.equal(((await list.json()) as { error: string }).error, "memory_disabled");

	const remove = await app.request("/api/v1/agent/memory/any-id", { method: "DELETE" });
	assert.equal(remove.status, 404);

	const supersede = await app.request("/api/v1/agent/memory/any-id/supersede", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	assert.equal(supersede.status, 404);
});

// ── 整理记忆（2026-11-08 扫尾批 6 §二）────────────────────

/** 从模型的输入清单里按正文找 id —— 假模型只"看得到"和真模型一样的东西。 */
function idOf(user: string, content: string): string {
	const line = user.split("\n").find((row) => row.includes(content));
	assert.ok(line, `输入清单里应包含「${content}」`);
	return /id=([^\s]+)/.exec(line!)?.[1] ?? "";
}

test("整理建议带证据引文：命中挂 evidence；查不到 = null；开关关 = 字段不下发", async () => {
	const engine = memoryEngine!;
	engine.remember({ kind: "episode", scope: { type: "global" }, content: "证据测试：我先给结论再给细节" });
	engine.remember({ kind: "fact", scope: { type: "global" }, content: "证据测试：养了一只猫" });
	const generate: Generator = async ({ user }) =>
		JSON.stringify({
			proposals: [
				{ keepId: idOf(user, "养了一只猫"), dropId: idOf(user, "我先给结论再给细节"), reason: "后者并进前者" },
			],
		});
	// 假证据查找：只有"先给结论"那条命中，另一条没有出处
	const findEvidence = async (needles: string[]) => {
		const hits = new Map<string, EvidenceHit>();
		for (const needle of needles) {
			if (needle.includes("我先给结论")) {
				hits.set(needle, { conversationId: "conv-1", at: 1234, role: "user", text: "…我先给结论再给细节…" });
			}
		}
		return hits;
	};

	// 顶部把开关锁成了 false；这里显式开回来（开关每次请求都读，进程内翻转即可）
	const previous = process.env.MEMORY_REVIEW_EVIDENCE;
	process.env.MEMORY_REVIEW_EVIDENCE = "";
	try {
		const app = new Hono();
		mountMemoryApi(app, { enabled: true, generate, findEvidence });
		const reviewed = await app.request("/api/v1/agent/memory/consolidate/review", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scope: "global" }),
		});
		assert.equal(reviewed.status, 200);
		const body = (await reviewed.json()) as {
			proposals: Array<{ drop: { content: string }; evidence?: { conversationId: string; text: string } | null }>;
		};
		assert.equal(body.proposals.length, 1);
		assert.ok(body.proposals[0]!.evidence, "命中应有证据引文");
		assert.equal(body.proposals[0]!.evidence!.conversationId, "conv-1");
		assert.ok(body.proposals[0]!.evidence!.text.includes("先给结论"), "引文应带原文片段");

		// evidence 只进响应、不落待决文件（接口文档 §2.15.1"只存 id/理由/两端正文快照"口径）
		const pendingRaw = JSON.parse(
			readFileSync(join(root, "memory-proposals.json"), "utf8"),
		) as { global?: { proposals: Array<Record<string, unknown>> } };
		assert.equal(
			"evidence" in pendingRaw.global!.proposals[0]!,
			false,
			"evidence 不应落待决文件",
		);

		// 查不到 = null，不挡应用（下一单证明 apply 照常）
		const missGenerate: Generator = async ({ user }) =>
			JSON.stringify({
				proposals: [{ keepId: idOf(user, "养了一只猫"), dropId: idOf(user, "我先给结论再给细节"), reason: "并进" }],
			});
		const missApp = new Hono();
		mountMemoryApi(missApp, {
			enabled: true,
			generate: missGenerate,
			findEvidence: async () => new Map(),
		});
		const missed = await missApp.request("/api/v1/agent/memory/consolidate/review", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scope: "global" }),
		});
		assert.equal(missed.status, 200);
		const missBody = (await missed.json()) as { proposals: Array<{ evidence: string | null }> };
		assert.equal(missBody.proposals[0]!.evidence, null, "查不到应是 null 而不是缺字段");

		// 开关关掉：字段整个不下发（JSON 序列化丢 undefined）
		process.env.MEMORY_REVIEW_EVIDENCE = "false";
		const offApp = new Hono();
		mountMemoryApi(offApp, { enabled: true, generate, findEvidence });
		const off = await offApp.request("/api/v1/agent/memory/consolidate/review", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scope: "global" }),
		});
		assert.equal(off.status, 200);
		const offBody = (await off.json()) as { proposals: Array<Record<string, unknown>> };
		assert.equal("evidence" in offBody.proposals[0]!, false, "开关关着时不应出现 evidence 字段");
	} finally {
		if (previous === undefined) delete process.env.MEMORY_REVIEW_EVIDENCE;
		else process.env.MEMORY_REVIEW_EVIDENCE = previous;
	}
});

test("整理记忆：只出建议不动库；应用落 supersededBy；忽略无副作用", async () => {
	const engine = memoryEngine!;
	const keep1 = engine.remember({ kind: "fact", scope: { type: "global" }, content: "整理测试：我住在北京" });
	const drop1 = engine.remember({ kind: "fact", scope: { type: "global" }, content: "整理测试：我搬到上海了" });
	const keep2 = engine.remember({ kind: "fact", scope: { type: "global" }, content: "整理测试：养了一只猫" });
	const drop2 = engine.remember({ kind: "fact", scope: { type: "global" }, content: "整理测试：猫叫豆豆" });

	const generate: Generator = async ({ user }) =>
		JSON.stringify({
			proposals: [
				{ keepId: idOf(user, "我搬到上海了"), dropId: idOf(user, "我住在北京"), reason: "后者已过时" },
				{ keepId: idOf(user, "猫叫豆豆"), dropId: idOf(user, "养了一只猫"), reason: "前者更完整" },
			],
		});

	const app = newApp(true, generate);
	const reviewed = await app.request("/api/v1/agent/memory/consolidate/review", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "global" }),
	});
	assert.equal(reviewed.status, 200);
	const reviewBody = (await reviewed.json()) as {
		proposals: Array<{ keepId: string; dropId: string; reason: string; keep: { content: string }; drop: { content: string } }>;
	};
	assert.equal(reviewBody.proposals.length, 2, "应返回两条建议");
	assert.ok(reviewBody.proposals.every((item) => item.reason.length > 0), "建议应带理由");
	assert.ok(reviewBody.proposals.every((item) => item.keep.content && item.drop.content), "建议应带两端正文");

	// 只建议、不执行（D18 底线）
	assert.equal(engine.list({ scopes: ["global"], includeSuperseded: true }).find((row) => row.id === drop1.id)!.supersededBy, null);
	assert.equal(engine.list({ scopes: ["global"], includeSuperseded: true }).find((row) => row.id === drop2.id)!.supersededBy, null);
	assert.equal(pendingProposalCount("global"), 2, "待决建议应落到文件，按 scope 记");

	// 应用第一条
	const applied = await app.request("/api/v1/agent/memory/consolidate/apply", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "global", keepId: drop1.id, dropId: keep1.id }),
	});
	assert.equal(applied.status, 200);
	assert.equal(((await applied.json()) as { alreadyApplied: boolean }).alreadyApplied, false);
	assert.equal(
		engine.list({ scopes: ["global"], includeSuperseded: true }).find((row) => row.id === keep1.id)!.supersededBy,
		drop1.id,
		"应用后旧记录应被 supersede（保留可追溯）",
	);
	assert.equal(pendingProposalCount("global"), 1, "应用过的建议应从待决文件摘掉");

	// 幂等：再点一次同一个按钮
	const again = await app.request("/api/v1/agent/memory/consolidate/apply", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "global", keepId: drop1.id, dropId: keep1.id }),
	});
	assert.equal(again.status, 200);
	assert.equal(((await again.json()) as { alreadyApplied: boolean }).alreadyApplied, true);

	// 忽略 = 前端不调 apply：第二条建议涉及的记录一个字段都不动
	const untouched = engine.list({ scopes: ["global"], includeSuperseded: true });
	assert.equal(untouched.find((row) => row.id === drop2.id)!.supersededBy, null, "忽略的建议不得有副作用");
	assert.equal(untouched.find((row) => row.id === keep2.id)!.supersededBy, null);
});

test("整理记忆：没有可用模型（faux）→ 503 不假装", async () => {
	const app = newApp();
	const response = await app.request("/api/v1/agent/memory/consolidate/review", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "global" }),
	});
	assert.equal(response.status, 503);
	assert.equal(((await response.json()) as { error: string }).error, "llm_not_configured");
});

test("整理记忆：模型输出不是 JSON → 502（如实报错不假装）", async () => {
	const app = newApp(true, async () => "好的，我觉得这两条可以合并。");
	const response = await app.request("/api/v1/agent/memory/consolidate/review", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "global" }),
	});
	assert.equal(response.status, 502);
	assert.equal(((await response.json()) as { error: string }).error, "llm_failed");
});

test("整理记忆：id 编造 / 自指的建议被丢掉，只留清单内的", async () => {
	const engine = memoryEngine!;
	const a = engine.remember({ kind: "fact", scope: { type: "global" }, content: "整理测试：编造 id 的保留句" });
	const b = engine.remember({ kind: "fact", scope: { type: "global" }, content: "整理测试：编造 id 的收编句" });
	const app = newApp(true, async () =>
		JSON.stringify({
			proposals: [
				{ keepId: a.id, dropId: b.id, reason: "有效" },
				{ keepId: "不存在的-id", dropId: b.id, reason: "编造" },
				{ keepId: a.id, dropId: a.id, reason: "自指" },
			],
		}),
	);
	const response = await app.request("/api/v1/agent/memory/consolidate/review", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "global" }),
	});
	const body = (await response.json()) as { proposals: Array<{ keepId: string; dropId: string }> };
	assert.equal(body.proposals.length, 1, "只有清单内、非自指的建议保留");
	assert.equal(body.proposals[0]!.keepId, a.id);
});

test("整理记忆：MEMORY_CONSOLIDATE_LLM=false → 两个端点 404，列表能力位为 false", async () => {
	process.env.MEMORY_CONSOLIDATE_LLM = "false";
	try {
		const app = newApp(true, async () => '{"proposals":[]}');
		const review = await app.request("/api/v1/agent/memory/consolidate/review", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scope: "global" }),
		});
		assert.equal(review.status, 404);
		const apply = await app.request("/api/v1/agent/memory/consolidate/apply", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scope: "global", keepId: "a", dropId: "b" }),
		});
		assert.equal(apply.status, 404);

		const list = (await (await app.request("/api/v1/agent/memory")).json()) as {
			canConsolidate: boolean;
			canImport: boolean;
		};
		assert.equal(list.canConsolidate, false, "能力位关着时前端不该渲染按钮");
		assert.equal(list.canImport, true, "导入是另一条开关，互不牵连");
	} finally {
		delete process.env.MEMORY_CONSOLIDATE_LLM;
	}
});

// ── 巩固审计（2026-11-10 批 17 §三）────────────────────────

test("巩固审计：pass 只出建议并落 diff；usage 排序 / 未用淘汰 / 库一个字段都不动", async () => {
	const { SqliteMemoryStore } = await import("@lifediary/memory");
	const engine = memoryEngine!;
	const partnerId = "77777777-7777-4777-8777-777777777777";
	const scope = `partner:${partnerId}`;
	const partnerScope = { type: "partner" as const, id: partnerId };

	const keep = engine.remember({
		kind: "fact",
		scope: partnerScope,
		content: "审计测试：同一条重复事实",
		importance: 0.4,
	});
	const drop = engine.remember({
		kind: "fact",
		scope: partnerScope,
		content: "审计测试：同一条重复事实。",
		importance: 0.4,
	});
	const stale = engine.remember({
		kind: "fact",
		scope: partnerScope,
		content: "审计测试：很久以前的低价值记录",
		importance: 0.3,
	});
	const pref = engine.remember({
		kind: "preference",
		scope: partnerScope,
		content: "审计测试：低重要度偏好",
		importance: 0.2,
	});

	// 用量 / 创建时间只能直接改库（remember 不接受这两个字段）
	const db = new SqliteMemoryStore(process.env.MEMORY_DB_PATH as string);
	const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
	db.patch(keep.id, {
		usageCount: 5,
		lastUsedAt: new Date().toISOString(),
		createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
	});
	db.patch(drop.id, {
		usageCount: 0,
		lastUsedAt: null,
		createdAt: new Date().toISOString(),
	});
	db.patch(stale.id, { usageCount: 0, lastUsedAt: null, createdAt: old, importance: 0.3 });
	db.patch(pref.id, { usageCount: 0, lastUsedAt: null, createdAt: old, importance: 0.2 });
	db.close();

	const before = engine.list({ scopes: [scope], includeSuperseded: true }).length;
	const response = await newApp().request("/api/v1/agent/memory/consolidate/pass", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope }),
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		merged: Array<{ keepId: string; dropId: string; summary: string }>;
		retired: Array<{ id: string; kind: string; summary: string }>;
		kept: number;
	};
	assert.equal(body.merged.length, 1, "一条合并建议");
	assert.equal(body.merged[0]!.keepId, keep.id, "保留 usage 更高的那条");
	assert.equal(body.merged[0]!.dropId, drop.id);
	assert.deepEqual(
		body.retired.map((entry) => entry.id),
		[stale.id],
		"只建议淘汰久未使用的低重要度条目；偏好不动",
	);
	assert.equal(body.kept, before - 2);

	// 红线：库一个字段都不动
	assert.equal(engine.list({ scopes: [scope], includeSuperseded: true }).length, before, "不删任何一条");
	assert.equal(engine.getRecord(drop.id)!.supersededBy, null, "不自动 supersede");
	assert.equal(engine.getRecord(stale.id)!.supersededBy, null);

	// diff 文件形状：只 id / kind / ≤40 字摘要，不抄正文
	const raw = readFileSync(process.env.MEMORY_CONSOLIDATE_DIFF_PATH as string, "utf8");
	const file = JSON.parse(raw) as Record<string, unknown>;
	assert.deepEqual(
		Object.keys(file).sort(),
		["generatedAt", "kept", "merged", "retired", "scope"],
		"diff 形状 = { merged, retired, kept }（加 scope / generatedAt）",
	);
	assert.ok(body.retired.every((entry) => entry.summary.length <= 40), "摘要 ≤40 字");

	// 界面可查：GET 读回同一份
	const read = await newApp().request("/api/v1/agent/memory/consolidate/diff");
	assert.equal(read.status, 200);
	const readBody = (await read.json()) as { scope: string; retired: Array<{ id: string }> };
	assert.equal(readBody.scope, scope);
	assert.deepEqual(readBody.retired.map((entry) => entry.id), [stale.id]);

	// 回滚开关：MEMORY_USAGE_RANKING=false → 给不出淘汰建议，保留优先级回到创建时间
	process.env.MEMORY_USAGE_RANKING = "false";
	try {
		const legacy = await newApp().request("/api/v1/agent/memory/consolidate/pass", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scope }),
		});
		const legacyBody = (await legacy.json()) as {
			merged: Array<{ keepId: string }>;
			retired: unknown[];
		};
		assert.equal(legacy.status, 200);
		assert.equal(legacyBody.retired.length, 0, "关掉 usage 排序后不出淘汰建议");
		assert.equal(legacyBody.merged[0]!.keepId, drop.id, "按创建时间保留最新一条");
	} finally {
		delete process.env.MEMORY_USAGE_RANKING;
	}
});

test("巩固审计：缺 scope / 非法的 scope → 400；没跑过 diff → 404", async () => {
	const app = newApp();
	const missing = await app.request("/api/v1/agent/memory/consolidate/pass", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	assert.equal(missing.status, 400);
	const bad = await app.request("/api/v1/agent/memory/consolidate/pass", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "session:1" }),
	});
	assert.equal(bad.status, 400);

	// 指到一个从未写过的路径：读口按"还没跑过"处理
	const previous = process.env.MEMORY_CONSOLIDATE_DIFF_PATH;
	process.env.MEMORY_CONSOLIDATE_DIFF_PATH = join(root, "never-written.json");
	try {
		const absent = await app.request("/api/v1/agent/memory/consolidate/diff");
		assert.equal(absent.status, 404);
	} finally {
		if (previous === undefined) delete process.env.MEMORY_CONSOLIDATE_DIFF_PATH;
		else process.env.MEMORY_CONSOLIDATE_DIFF_PATH = previous;
	}
});

// ── 导入（2026-11-08 扫尾批 6 §三）────────────────────────

test("导入：只增不改，返回新增/跳过条数，source=imported", async () => {
	const engine = memoryEngine!;
	const scope = "partner:33333333-3333-4333-8333-333333333333";
	const existing = engine.remember({
		kind: "fact",
		scope: { type: "partner", id: "33333333-3333-4333-8333-333333333333" },
		content: "导入测试：已有的一条",
		importance: 0.8,
	});

	const app = newApp();
	const response = await app.request("/api/v1/agent/memory/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			scope,
			items: [
				{ text: "导入测试：已有的一条。" },
				{ text: "导入测试：新的一条" },
				{ text: "导入测试：新的一条！" },
				{ text: "" },
			],
		}),
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as { added: number; skipped: number; total: number };
	assert.deepEqual([body.added, body.skipped, body.total], [1, 3, 4]);

	const rows = engine.list({ scopes: [scope], includeSuperseded: true });
	assert.equal(rows.filter((row) => row.source === "imported").length, 1, "新记录标记为 imported");
	assert.equal(rows.find((row) => row.id === existing.id)!.importance, 0.8, "已有记录不得被改动");
});

test("导入：MEMORY_IMPORT=false → 404；坏 body 400", async () => {
	const app = newApp();
	const badScope = await app.request("/api/v1/agent/memory/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "session:1", items: [] }),
	});
	assert.equal(badScope.status, 400);

	const badItems = await app.request("/api/v1/agent/memory/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: "global", items: "不是数组" }),
	});
	assert.equal(badItems.status, 400);

	process.env.MEMORY_IMPORT = "false";
	try {
		const off = await app.request("/api/v1/agent/memory/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scope: "global", items: [] }),
		});
		assert.equal(off.status, 404, "开关关着 = 端点不挂");
		const list = (await (await app.request("/api/v1/agent/memory")).json()) as { canImport: boolean };
		assert.equal(list.canImport, false);
	} finally {
		delete process.env.MEMORY_IMPORT;
	}
});
