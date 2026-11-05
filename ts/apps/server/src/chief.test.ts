import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSkillStore } from "./skills.ts";
import {
	CHIEF_PARTNER_ID,
	PartnersStore,
	chiefPartnerEnabled,
	chiefSkillsDir,
	chiefSoul,
	effectivePartnerIdOfSession,
	resolvePartnerScope,
	resolvePersona,
} from "./partners.ts";

/**
 * 总管身份化（批次D D1）单测。
 * 不碰真实 .data/：全部用临时目录建 PartnersStore / 技能目录。
 * 对应任务书 §4 的三项 + §验证 4 的回滚开关。
 */

const PERSONA_FALLBACK = "原始 PERSONA 正文（回落用）";
const CHIEF_SEED = "总管 SOUL 播种正文 = 旧 PERSONA 原文";

function tempRoot(): { root: string; db: string; homes: string } {
	const root = mkdtempSync(join(tmpdir(), "lifediary-chief-"));
	return { root, db: join(root, "partners.sqlite"), homes: join(root, "homes") };
}

/** 在指定 env 下跑同步断言，结束还原（node:test 文件内用例顺序执行，仍显式还原防泄漏）。 */
function withEnv(name: string, value: string, fn: () => void): void {
	const prev = process.env[name];
	process.env[name] = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env[name];
		else process.env[name] = prev;
	}
}

// ── 1. 总管播种幂等 ──────────────────────────────────────
test("总管播种：首次建 chief + SOUL=PERSONA + v1；二次启动不覆盖改过的 SOUL", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		store.ensureChief(CHIEF_SEED);
		assert.equal(store.get(CHIEF_PARTNER_ID)?.id, CHIEF_PARTNER_ID, "固定字面量 id = chief");
		assert.equal(store.readSoulFromHome(CHIEF_PARTNER_ID), CHIEF_SEED, "SOUL 播种 = PERSONA 原文");
		assert.equal(store.currentVersion(CHIEF_PARTNER_ID)?.soulSource, CHIEF_SEED, "v1 快照 = SOUL");
		assert.ok(existsSync(join(homes, CHIEF_PARTNER_ID, "SOUL.md")), "SOUL 文件已生成");
		assert.ok(existsSync(join(homes, CHIEF_PARTNER_ID, "skills")), "技能目录已建");

		// 用户改过 SOUL（模拟 PATCH/bumpSoul 推进新版本）
		store.bumpSoul(CHIEF_PARTNER_ID, "改过的总管身份");
		assert.equal(store.currentVersion(CHIEF_PARTNER_ID)?.version, 2);

		// 二次启动 = 新的 store 实例、同库同家目录，再用旧 seed 播种：绝不覆盖
		const restarted = new PartnersStore(db, homes);
		try {
			restarted.ensureChief(CHIEF_SEED);
			assert.equal(
				restarted.readSoulFromHome(CHIEF_PARTNER_ID),
				"改过的总管身份",
				"二次启动不覆盖改过的 SOUL",
			);
			assert.equal(restarted.currentVersion(CHIEF_PARTNER_ID)?.version, 2, "版本不回退");
		} finally {
			restarted.close();
		}
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

// ── 2. PERSONA 回落路径 ─────────────────────────────────
test("PERSONA 回落：执事库不可用 / 总管未播种时主对话仍有人格", () => {
	withEnv("CHIEF_PARTNER", "true", () => {
		// (a) 执事库初始化失败：取 store 抛错 → 回落（主对话不哑）
		assert.equal(
			resolvePersona(
				() => {
					throw new Error("db down");
				},
				PERSONA_FALLBACK,
			),
			PERSONA_FALLBACK,
			"执事库抛错 → 回落 PERSONA",
		);

		const { root, db, homes } = tempRoot();
		const store = new PartnersStore(db, homes);
		try {
			// (b) 执事库可用但总管不存在 → 回落
			assert.equal(resolvePersona(() => store, PERSONA_FALLBACK), PERSONA_FALLBACK);
			assert.equal(chiefSoul(store), null);

			// (c) 播种后：用 SOUL 当前版本快照，不再回落
			store.ensureChief(CHIEF_SEED);
			assert.equal(resolvePersona(() => store, PERSONA_FALLBACK), CHIEF_SEED);
			assert.equal(chiefSoul(store), CHIEF_SEED);

			// 改 SOUL 走 bumpSoul → 新版本快照，下一轮生效语义的基础
			store.bumpSoul(CHIEF_PARTNER_ID, "新版总管身份");
			assert.equal(resolvePersona(() => store, PERSONA_FALLBACK), "新版总管身份");
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ── 3. chief 例外（partnerScopeOf 对 chief 返 null）──────
test("chief 例外：resolvePartnerScope 对 chief 返 null（不吃 partner: 键空间）", () => {
	withEnv("CHIEF_PARTNER", "true", () => {
		const { root, db, homes } = tempRoot();
		const store = new PartnersStore(db, homes);
		try {
			store.ensureChief(CHIEF_SEED);

			// 主对话（owner 会话，无链接）解析为 chief → scope 为 null（仍读写 global + session）
			assert.equal(effectivePartnerIdOfSession(store, 777), CHIEF_PARTNER_ID);
			assert.equal(resolvePartnerScope(store, 777), null, "主对话 → null scope");

			// 会话显式链接到 chief 也照样返 null（例外判定本身）
			store.linkSession({
				partnerId: CHIEF_PARTNER_ID,
				role: "canonical",
				routeKey: "canonical",
				sessionId: 888,
			});
			assert.equal(effectivePartnerIdOfSession(store, 888), CHIEF_PARTNER_ID);
			assert.equal(resolvePartnerScope(store, 888), null, "链接到 chief → 仍 null");

			// 普通执事会话行为不变：返回 partner scope
			const other = store.create("小澈");
			store.linkSession({
				partnerId: other.id,
				role: "canonical",
				routeKey: "canonical",
				sessionId: 999,
			});
			assert.equal(effectivePartnerIdOfSession(store, 999), other.id);
			assert.deepEqual(resolvePartnerScope(store, 999), { type: "partner", id: other.id });
			// 裸 partnerIdOfSession 语义不变：主人会话仍为 null（autonomy/routines 防自环依赖）
			assert.equal(store.partnerIdOfSession(777), null);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ── 4. 回滚开关 CHIEF_PARTNER=false ──────────────────────
test("回滚：CHIEF_PARTNER=false → PERSONA 常量直读、owner 会话不解析为 chief", () => {
	withEnv("CHIEF_PARTNER", "false", () => {
		assert.equal(chiefPartnerEnabled(), false);
		const { root, db, homes } = tempRoot();
		const store = new PartnersStore(db, homes);
		try {
			// 即便留有 SOUL，开关关掉也直读常量
			store.ensureChief(CHIEF_SEED);
			assert.equal(resolvePersona(() => store, PERSONA_FALLBACK), PERSONA_FALLBACK, "常量直读");
			assert.equal(effectivePartnerIdOfSession(store, 777), null, "owner 会话不解析为 chief");
			assert.equal(resolvePartnerScope(store, 777), null);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ── 5. 技能落点一致（§3：skillStore 读的目录 = partner_skill_write 写的目录）──
test("技能落点：chiefSkillsDir() 与 store.skillsDirOf('chief') 同址", () => {
	const { root, db, homes } = tempRoot();
	const prev = process.env.PARTNER_HOMES_ROOT;
	process.env.PARTNER_HOMES_ROOT = homes;
	const store = new PartnersStore(db, homes);
	try {
		assert.equal(chiefSkillsDir(), store.skillsDirOf(CHIEF_PARTNER_ID));
		assert.ok(chiefSkillsDir().endsWith(join("chief", "skills")), "落在 partner-homes/chief/skills/");
	} finally {
		store.close();
		if (prev === undefined) delete process.env.PARTNER_HOMES_ROOT;
		else process.env.PARTNER_HOMES_ROOT = prev;
		rmSync(root, { recursive: true, force: true });
	}
});

// ── 6. 技能合并（§3 的索引口径）──────────────────────────
test("技能合并：总管技能目录优先、全局兜底，同名总管覆盖全局", () => {
	const root = mkdtempSync(join(tmpdir(), "lifediary-chief-skills-"));
	const chiefDir = join(root, "chief-skills");
	const globalDir = join(root, "global-skills");
	mkdirSync(chiefDir, { recursive: true });
	mkdirSync(globalDir, { recursive: true });
	try {
		writeFileSync(join(globalDir, "shared.md"), "全局摘要\n全局手册正文");
		writeFileSync(join(globalDir, "global-only.md"), "仅全局摘要\n仅全局手册");
		writeFileSync(join(chiefDir, "shared.md"), "总管摘要\n总管手册正文");
		writeFileSync(join(chiefDir, "chief-only.md"), "仅总管摘要\n仅总管手册");

		const store = createSkillStore([chiefDir, globalDir]);
		assert.ok(store, "合并后至少有一条技能");
		assert.deepEqual(store.names().sort(), ["chief-only", "global-only", "shared"]);
		assert.equal(store.manual("shared"), "总管手册正文", "同名时总管技能覆盖全局");
		assert.equal(store.manual("global-only"), "仅全局手册", "全局技能兜底");
		assert.equal(store.manual("chief-only"), "仅总管手册");
		assert.match(store.indexFor(1) ?? "", /总管摘要/, "索引用总管版摘要");

		// 单目录形态（改动前）仍可用
		assert.equal(createSkillStore(globalDir)?.manual("shared"), "全局手册正文");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
