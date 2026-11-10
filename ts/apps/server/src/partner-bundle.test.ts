import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createMemoryEngine, type MemoryEngine } from "@lifediary/memory";

/**
 * 团队包（2026-11-10 批 25 §二）。
 *
 * 用两套临时库验"包能把东西搬过去、搬不过去的也不装"：
 *   - 导出只含四类内容（档案 / SOUL+契约 / 技能 / 偏好+经验），work 履历不导；
 *   - 双重脱敏：字段级 + 序列化后各一遍，导出文本里不能出现原 secret；
 *   - 导入不信包里的开关，落成 paused + SAFE_ARRIVAL；重名 400 不覆盖。
 *
 * 端点另起一个真 Hono，验 Content-Disposition 与开关 404。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-bundle-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.COMPANIONS_ENABLED = "true";
process.env.MEMORY_ENABLED = "false"; // 端点用例不需要记忆；函数级用例自建引擎
process.env.CHANCELLOR_ENABLED = "false";
process.env.LLM_PROVIDER = "faux";
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.AGENT_APPROVALS_PATH = join(root, "approvals.json");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
process.env.PROVIDERS_PATH = join(root, "providers.json");
process.env.DELEGATIONS_DB_PATH = join(root, "delegations.sqlite");
process.env.AGENT_SSE_SEQ_DB_PATH = join(root, "chat-events.sqlite");
process.env.AGENT_POLICY_PATH = join(root, "policy.json");
process.env.ROUTINES_STATE_PATH = join(root, "routines.json");
process.env.AUTONOMY_STATE_PATH = join(root, "autonomy-state.json");
process.env.AGENT_FLAGS_PATH = join(root, "flags.json");
process.env.AGENT_SKILLS_STATE_PATH = join(root, "skill-state.json");

const { Hono } = await import("hono");
const { mountCompanions } = await import("./companion-api.ts");
const { PartnersStore, partnersStore } = await import("./partners.ts");
const { exportPartnerBundle, importPartnerBundle, SAFE_ARRIVAL, partnerBundleEnabled } =
	await import("./partner-bundle.ts");

const globalStore = partnersStore();

after(() => {
	globalStore.close();
	rmSync(root, { recursive: true, force: true });
});

interface Fixture {
	store: InstanceType<typeof PartnersStore>;
	memory: MemoryEngine;
	cleanup: () => void;
}

function fixture(tag: string): Fixture {
	const dir = mkdtempSync(join(tmpdir(), `lifediary-bundle-${tag}-`));
	const store = new PartnersStore(join(dir, "partners.sqlite"), join(dir, "homes"));
	const memory = createMemoryEngine({ dbPath: join(dir, "memory.db") })!;
	return {
		store,
		memory,
		cleanup: () => {
			memory.close();
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const SECRET_KEY = "sk-live-abcdefgh12345678";
const SECRET_PASSWORD = "hunter2-correct-horse";

function seededPartner(env: Fixture) {
	const partner = env.store.create("阿岚", { domain: "finance", soulSeed: `你是阿岚。\napi_key=${SECRET_KEY}` });
	env.store.atomicWrite(
		join(env.store.skillsDirOf(partner.id), "daily-brief.md"),
		"# 日报\n先读任务书，再按顺序做。password=" + SECRET_PASSWORD,
	);
	env.store.bumpContract(
		partner.id,
		"## 职责范围\n记账。\n\n## 决策分级\n小额自己定。",
	);
	const scope = { type: "partner" as const, id: partner.id };
	env.memory.remember({ kind: "preference", scope, content: "不喜欢被追问太多" });
	env.memory.remember({ kind: "experience", scope, content: "对账先跑一遍小数校验" });
	env.memory.remember({ kind: "work", scope, content: "2026-11-01 完成月度对账" });
	env.memory.remember({ kind: "fact", scope, content: "住在杭州" });
	return partner;
}

test("导出：四类内容齐全，只带 preference + experience，不带 work 履历", () => {
	const env = fixture("export");
	try {
		const partner = seededPartner(env);
		const exported = exportPartnerBundle(partner.id, env);
		assert.ok(exported, "存在的执事应该能导出");
		const bundle = JSON.parse(exported.content) as Record<string, any>;

		assert.equal(bundle.format, "lifediary-partner-bundle");
		assert.equal(bundle.version, 1);
		assert.equal(bundle.partner.name, "阿岚");
		assert.equal(bundle.partner.domain, "finance");
		assert.equal(bundle.partner.status, "active");
		assert.match(bundle.soul, /你是阿岚/);
		assert.match(bundle.contract, /## 职责范围/);
		assert.equal(bundle.skills.length, 1);
		assert.equal(bundle.skills[0].name, "daily-brief");

		const kinds = bundle.memories.map((item: { kind: string }) => item.kind).sort();
		assert.deepEqual(kinds, ["experience", "preference"], "work / fact 不导");
		assert.ok(
			bundle.memories.some((item: { content: string }) => item.content.includes("不喜欢被追问太多")),
		);
		assert.equal(exported.filename, "阿岚-bundle.json");
	} finally {
		env.cleanup();
	}
});

test("双重脱敏：SOUL / 技能 / 记忆里的凭据都被打码，导出文本不含原文", () => {
	const env = fixture("redact");
	try {
		const partner = seededPartner(env);
		const exported = exportPartnerBundle(partner.id, env)!;
		assert.equal(exported.content.includes(SECRET_KEY), false, "裸 key 不能出现在包里");
		assert.equal(exported.content.includes(SECRET_PASSWORD), false, "密码不能出现在包里");
		assert.match(exported.content, /«redacted»/, "占位符要在（读包的人知道这里原来是个凭据）");
		// 标签保留：不是整段抹掉
		assert.match(exported.content, /api_key=«redacted»/);
	} finally {
		env.cleanup();
	}
});

test("导入：落成安全态（paused + SAFE_ARRIVAL），内容搬过去但领域不继承", () => {
	const source = fixture("src");
	const target = fixture("dst");
	try {
		const partner = seededPartner(source);
		const bundle = JSON.parse(exportPartnerBundle(partner.id, source)!.content) as Record<
			string,
			any
		>;
		// 手改包里的开关与状态：导入必须无视它们（不信包里的值）。
		bundle.safety = { approvalLevel: "none", skillsEnabled: true, routinesPaused: false };
		bundle.partner.status = "active";
		bundle.partner.name = "阿岚（导入）";

		const result = importPartnerBundle(bundle, target);
		assert.equal(result.ok, true);
		if (!result.ok) return;

		assert.equal(result.partner.status, "paused", "到货即暂停，确认前不跑回合");
		assert.equal(result.partner.domain, null, "领域标签不随包迁移（避免导入即接单）");
		assert.deepEqual(result.safety, SAFE_ARRIVAL);
		assert.match(result.warnings.join("\n"), /领域标签未随包迁移/);
		assert.equal(result.imported.skills, 1);
		assert.equal(result.imported.memories, 2);

		// SOUL / 契约 / 技能真的落到了新执事家里
		assert.match(target.store.readSoulFromHome(result.partner.id) ?? "", /你是阿岚/);
		assert.match(target.store.readContractFromHome(result.partner.id) ?? "", /## 职责范围/);
		assert.match(
			target.store.readHomeFile(result.partner.id, join("skills", "daily-brief.md")) ?? "",
			/# 日报/,
		);
		// 记忆进了新 scope，且来源标 imported
		const imported = target.memory.list({
			scopes: [`partner:${encodeURIComponent(result.partner.id)}`],
		});
		assert.equal(imported.length, 2);
		assert.ok(imported.every((record) => record.source === "import"));
		assert.deepEqual(
			imported.map((record) => record.kind).sort(),
			["experience", "preference"],
		);
		// 规则一条都不导入
		assert.equal(target.store.listRoutines(result.partner.id).length, 0);
	} finally {
		source.cleanup();
		target.cleanup();
	}
});

test("导入：重名 400 口径，不覆盖现有执事", () => {
	const source = fixture("dup-src");
	const target = fixture("dup-dst");
	try {
		const partner = seededPartner(source);
		const bundle = JSON.parse(exportPartnerBundle(partner.id, source)!.content) as unknown;
		target.store.create("阿岚", { soulSeed: "现有执事，别动我" });

		const result = importPartnerBundle(bundle, target);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "duplicate_name");
		assert.match(result.message, /已经有一位叫「阿岚」的执事/);
		assert.equal(target.store.readSoulFromHome(target.store.list()[0]!.id), "现有执事，别动我");
	} finally {
		source.cleanup();
		target.cleanup();
	}
});

test("导入：不是团队包 / 版本不对 / 没名字都拒，不建半个执事", () => {
	const env = fixture("invalid");
	try {
		const notBundle = importPartnerBundle({ hello: "world" }, env);
		assert.equal(notBundle.ok === false && notBundle.code, "invalid_bundle");

		const badVersion = importPartnerBundle(
			{
				format: "lifediary-partner-bundle",
				version: 99,
				partner: { name: "阿岚" },
			},
			env,
		);
		assert.equal(badVersion.ok === false && badVersion.code, "invalid_bundle");
		assert.match(badVersion.ok === false ? badVersion.message : "", /版本不支持/);

		const noName = importPartnerBundle(
			{ format: "lifediary-partner-bundle", version: 1, partner: {} },
			env,
		);
		assert.equal(noName.ok === false && noName.code, "invalid_bundle");
		assert.equal(env.store.list().length, 0, "拒了就不能留半个执事");
	} finally {
		env.cleanup();
	}
});

// ── 端点 ─────────────────────────────────────────────────
const app = new Hono();
mountCompanions(app);

test("GET /partners/:id/bundle：JSON 附件；不存在 404；开关关掉两个端点都 404", async () => {
	const created = await app.request("/api/v1/partners", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "导出探针" }),
	});
	const createdBody = (await created.json()) as { partner?: { id?: string } };
	const id = createdBody.partner?.id ?? "";

	const got = await app.request(`/api/v1/partners/${id}/bundle`);
	assert.equal(got.status, 200);
	assert.match(got.headers.get("content-disposition") ?? "", /^attachment; filename=".*-bundle\.json"/);
	const bundle = (await got.json()) as Record<string, any>;
	assert.equal(bundle.partner.name, "导出探针");
	assert.deepEqual(bundle.safety, SAFE_ARRIVAL);

	const missing = await app.request("/api/v1/partners/not-a-uuid/bundle");
	assert.equal(missing.status, 404);

	const previous = process.env.PARTNER_BUNDLE;
	process.env.PARTNER_BUNDLE = "false";
	try {
		assert.equal(partnerBundleEnabled(), false);
		assert.equal((await app.request(`/api/v1/partners/${id}/bundle`)).status, 404);
		assert.equal(
			(
				await app.request("/api/v1/partners/import-bundle", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(bundle),
				})
			).status,
			404,
		);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_BUNDLE;
		else process.env.PARTNER_BUNDLE = previous;
	}
});

test("POST /partners/import-bundle：201 + paused；重名 400", async () => {
	const created = await app.request("/api/v1/partners", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "打包源" }),
	});
	const createdBody = (await created.json()) as { partner?: { id?: string } };
	const id = createdBody.partner?.id ?? "";
	const exported = (await (await app.request(`/api/v1/partners/${id}/bundle`)).json()) as Record<
		string,
		any
	>;
	exported.partner.name = "打包到货";

	const imported = await app.request("/api/v1/partners/import-bundle", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(exported),
	});
	assert.equal(imported.status, 201);
	const body = (await imported.json()) as Record<string, any>;
	assert.equal(body.ok, true);
	assert.equal(body.partner.status, "paused");
	assert.deepEqual(body.safety, SAFE_ARRIVAL);

	const duplicate = await app.request("/api/v1/partners/import-bundle", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...exported, partner: { ...exported.partner, name: "打包到货" } }),
	});
	assert.equal(duplicate.status, 400);
	const duplicateBody = (await duplicate.json()) as Record<string, any>;
	assert.equal(duplicateBody.code, "duplicate_name");
});
