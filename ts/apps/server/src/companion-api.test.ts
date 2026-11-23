import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { deflateSync } from "node:zlib";
import { partnerAvatarProblem, PARTNER_AVATAR_PREFIX } from "@lifediary/shared";

/**
 * 头像定点返修（2026-11-06）：真挂 Hono + 临时 SQLite / 伙伴家目录，不碰 .data / .env。
 *
 * 覆盖两类问题：
 *   1. PATCH 的 name / SOUL / modelChain 原先在写头像、改名之后才校验 → 半写入；
 *      现在整个对象先校验，失败 400 且所有字段不变。
 *   2. shared 只解头尾 32 字符 → 结构坏图能覆盖旧头像；现在完整解码 + 块边界 / IHDR / CRC /
 *      IDAT / IEND 校验，服务端再用 zlib 复核 deflate 流。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-partner-avatar-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.COMPANIONS_ENABLED = "true";
process.env.LLM_PROVIDER = "faux";
process.env.MEMORY_ENABLED = "false";
process.env.CHANCELLOR_ENABLED = "false";
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
// 2026-11-15 按人技能状态：指到临时文件，绝不碰真实 .data/skills-state.json
process.env.AGENT_SKILLS_STATE_PATH = join(root, "skills-state.json");
// 2026-11-16 Worker 人设：同样指到临时文件，不碰真实 .data/worker-persona.md
process.env.WORKER_PERSONA_PATH = join(root, "worker-persona.md");

const { Hono } = await import("hono");
const { mountCompanions } = await import("./companion-api.ts");
const { mountSkills } = await import("./skills-api.ts");
const { PARTNER_SLOT_LIMIT, partnersStore } = await import("./partners.ts");
const { getSkillState } = await import("./skill-state.ts");
const {
  mountWorkerPersonaRoutes,
  workerPersonaDefault,
  WORKER_PERSONA_LIMIT,
} = await import("./worker-persona.ts");

const store = partnersStore();
const app = new Hono();
mountCompanions(app);
// 技能管理面单独挂一个 app：GET /agent/skills?partnerId 的按人字段用它验，
// 不跟执事端点混在同一条路由表里。
const skillsApp = new Hono();
mountSkills(skillsApp, { enabled: true });
// Worker 人设端点单独挂一条路由表（真 Hono 路由，不是 mock），验 GET/PUT 形状与 400。
const workerApp = new Hono();
mountWorkerPersonaRoutes(workerApp);

// 项目记忆归属（2026-11-15 跟人走方案）：PATCH 校验用。PROJECTS_DB_PATH 已指到临时库。
const { projectsStore } = await import("./project-api.ts");

after(async () => {
	store.close();
	// 项目记忆归属（2026-11-15）动过项目库：sqlite 句柄不关，Windows 上 rmSync 会 EPERM。
	projectsStore().close();
	// 工具勾选端点会 getHarness()（真开 durable SQLite）：先交出句柄再删临时目录。
	const { closeHarnessForMaintenance } = await import("./agent/lifecycle.ts");
	await closeHarnessForMaintenance().catch(() => undefined);
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// 极端情况下句柄仍未释放：留着临时目录不挡测试收尾
	}
});

// ── 真实 PNG fixture ─────────────────────────────────────

/** 1×1 透明像素（真实 PNG，IHDR/IDAT/IEND 与 CRC 全合法）。 */
const SMALL_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * 16×16 RGBA 渐变图：结构与浏览器 canvas `toDataURL("image/png")` 一致
 * （8-bit / color type 6 / 非隔行 / 单 IDAT）。
 */
const CANVAS_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAB7ElEQVR4nBXS0RRAIQAE0YcQQgghhBBCCCEsQgghhBBCCCFksG/6vufM13zfJ4dPjp+cPjl/cvnk+sntk4V3fOATX/jGD37x7wtyCHIMcgpyDnIJcg1yC7Lwjg984gvf+MFveIEohyjHKKco5yiXKNcotygL7/jAJ77wjR/8xhdIckhyTHJKck5ySXJNckuy8I4PfOIL3/jBb3qBLIcsxyynLOcslyzXLLcsC+/4wCe+8I0f/OYXKHIocixyKnIucilyLXIrsvCOD3ziC9/4wW95gSqHKscqpyrnKpcq1yq3Kgvv+MAnvvCNH/zWF2hyaHJscmpybnJpcm1ya7Lwjg984gvf+MFvewHxgfhAfCA+EB+ID8QH4gO84wOf+MI3fvCrF+h80Pmg80Hng84HnQ86H3Q+wDs+8IkvfOMHv/0FBh8MPhh8MPhg8MHgg8EHgw/wjg984gvf+MHveIHJB5MPJh9MPph8MPlg8sHkA7zjA5/4wjd+8DtfYPHB4oPFB4sPFh8sPlh8sPgA7/jAJ77wjR/8rhfYfLD5YPPB5oPNB5sPNh9sPsA7PvCJL3zjB7/7BQ4fHD44fHD44PDB4YPDB4cP8I4PfOIL3/jB73mByweXDy4fXD64fHD54PLB5QO84wOf+MI3fvCL/05Lbx/BFbi+AAAAAElFTkSuQmCC";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CANVAS_BYTES = Buffer.from(CANVAS_PNG.slice(PARTNER_AVATAR_PREFIX.length), "base64");

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return (c ^ 0xffffffff) >>> 0;
}

/** 按 PNG 规范造块：长度 + 类型 + 数据 + CRC（测试里的坏图要能精确只坏一处）。 */
function chunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
	return Buffer.concat([length, typeBytes, data, crc]);
}

function ihdr(
	width: number,
	height: number,
	bitDepth = 8,
	colorType = 6,
	interlace = 0,
): Buffer {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	data[8] = bitDepth;
	data[9] = colorType;
	data[10] = 0;
	data[11] = 0;
	data[12] = interlace;
	return chunk("IHDR", data);
}

function dataUrl(bytes: Buffer): string {
	return `${PARTNER_AVATAR_PREFIX}${bytes.toString("base64")}`;
}

interface PngPart {
	type: string;
	data: Buffer;
	dataStart: number;
}

function partsOf(bytes: Buffer): PngPart[] {
	const parts: PngPart[] = [];
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		parts.push({
			type: bytes.subarray(offset + 4, offset + 8).toString("ascii"),
			data: bytes.subarray(offset + 8, offset + 8 + length),
			dataStart: offset + 8,
		});
		offset += 12 + length;
	}
	return parts;
}

const CANVAS_PARTS = partsOf(CANVAS_BYTES);
const CANVAS_IHDR = CANVAS_PARTS.find((part) => part.type === "IHDR")?.data as Buffer;
const CANVAS_IDAT = CANVAS_PARTS.find((part) => part.type === "IDAT")?.data as Buffer;
const IEND = chunk("IEND", Buffer.alloc(0));

/** CRC 错：翻 IDAT 数据字节但不重算 CRC。 */
const BAD_CRC = (() => {
	const bytes = Buffer.from(CANVAS_BYTES);
	const idat = CANVAS_PARTS.find((part) => part.type === "IDAT") as PngPart;
	bytes[idat.dataStart + 10] ^= 0xff;
	return dataUrl(bytes);
})();

/** IHDR 长度 14（结构里只有 IHDR 长度不对，CRC 是对的）。 */
const BAD_IHDR_LENGTH = dataUrl(
	Buffer.concat([
		SIGNATURE,
		chunk("IHDR", Buffer.concat([CANVAS_IHDR, Buffer.from([0])])),
		chunk("IDAT", CANVAS_IDAT),
		IEND,
	]),
);

/** IHDR 参数非法：color type 6 配 bit depth 7。 */
const BAD_IHDR_PARAMS = dataUrl(
	Buffer.concat([SIGNATURE, ihdr(16, 16, 7, 6), chunk("IDAT", CANVAS_IDAT), IEND]),
);

/** 没有 IDAT。 */
const NO_IDAT = dataUrl(Buffer.concat([SIGNATURE, ihdr(16, 16), IEND]));

/** 压缩流坏：结构 / CRC 全对，但 IDAT 不是合法 deflate 流。 */
const BAD_COMPRESSED = dataUrl(
	Buffer.concat([
		SIGNATURE,
		ihdr(16, 16),
		chunk("IDAT", Buffer.alloc(64, 0x41)),
		IEND,
	]),
);

/** 中间数据损坏：IDAT 中间一字节翻转后重算 CRC（CRC 对，deflate 流坏）。 */
const MIDDLE_DAMAGE = (() => {
	const damaged = Buffer.from(CANVAS_IDAT);
	damaged[Math.floor(damaged.length / 2)] ^= 0xff;
	return dataUrl(Buffer.concat([SIGNATURE, ihdr(16, 16), chunk("IDAT", damaged), IEND]));
})();

/** IHDR 宽度改成 17：CRC / 结构都合法，但解压长度对不上。 */
const WRONG_DIMENSIONS = (() => {
	const wrong = Buffer.from(CANVAS_IHDR);
	wrong.writeUInt32BE(17, 0);
	return dataUrl(Buffer.concat([SIGNATURE, chunk("IHDR", wrong), chunk("IDAT", CANVAS_IDAT), IEND]));
})();

/** 解压后长度对，但第一行 filter 字节是 5：zlib 能解，PNG 渲染器不认。 */
const BAD_FILTER = (() => {
	const raw = Buffer.alloc(16 * (1 + 16 * 4));
	raw[0] = 5;
	return dataUrl(
		Buffer.concat([SIGNATURE, ihdr(16, 16), chunk("IDAT", deflateSync(raw)), IEND]),
	);
})();

/** 截断：去掉最后 8 字节，IEND 不完整。 */
const TRUNCATED = dataUrl(CANVAS_BYTES.subarray(0, CANVAS_BYTES.length - 8));

const VALID_CHAIN = [{ providerId: "faux", modelId: "faux", keyEnv: "AVATAR_KEY" }];

// ── 端点辅助 ─────────────────────────────────────────────

type PatchBody = Record<string, unknown>;

function seed(name: string) {
	const partner = store.create(name);
	store.setAvatar(partner.id, SMALL_PNG);
	store.update(partner.id, { status: "paused" });
	store.bumpSoul(partner.id, "旧身份");
	store.setModelChain(partner.id, [{ providerId: "p", modelId: "m", keyEnv: "OLD_KEY" }]);
	return store.get(partner.id) as NonNullable<ReturnType<typeof store.get>>;
}

function state(id: string) {
	const row = store.get(id);
	return {
		avatar: row?.avatar,
		name: row?.name,
		status: row?.status,
		soul: store.readSoulFromHome(id),
		modelChain: store.getModelChain(id),
		soulVersion: row?.currentVersion ?? null,
		updatedAt: row?.updatedAt,
	};
}

async function patch(id: string, body: PatchBody) {
	const res = await app.request(`/api/v1/partners/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function createPartner(body: Record<string, unknown>) {
	const res = await app.request("/api/v1/partners", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── 测试 ─────────────────────────────────────────────────

test("shared 头像校验：完整块链 / CRC / IDAT / IEND 全过；坏一处就拒", () => {
	assert.equal(partnerAvatarProblem(SMALL_PNG), null);
	assert.equal(partnerAvatarProblem(CANVAS_PNG), null);

	for (const [why, fixture] of [
		["CRC 错", BAD_CRC],
		["IHDR 长度错", BAD_IHDR_LENGTH],
		["IHDR 参数错", BAD_IHDR_PARAMS],
		["没有 IDAT", NO_IDAT],
		["截断", TRUNCATED],
	] as const) {
		assert.notEqual(partnerAvatarProblem(fixture), null, `应拒绝：${why}`);
	}

	// 结构合法但压缩流坏：shared 放行，服务端 zlib 必须接住。
	for (const [why, fixture] of [
		["IDAT 不是 deflate", BAD_COMPRESSED],
		["IDAT 中间损坏", MIDDLE_DAMAGE],
		["解压长度不匹配", WRONG_DIMENSIONS],
		["filter 字节非法", BAD_FILTER],
	] as const) {
		assert.equal(partnerAvatarProblem(fixture), null, `shared 结构层应放行：${why}`);
	}
});

test("PATCH：合法新头像 + 非法 name / SOUL / modelChain / status → 400 且旧值全不变", async () => {
	const partner = seed("旧名字");
	const before = state(partner.id);

	const cases: Array<[string, PatchBody]> = [
		["name 非字符串", { avatar: CANVAS_PNG, name: 123 }],
		["name 超长", { avatar: CANVAS_PNG, name: "x".repeat(41) }],
		["SOUL 非字符串", { avatar: CANVAS_PNG, soul: 123 }],
		["SOUL 超限", { avatar: CANVAS_PNG, soul: "x".repeat(PARTNER_SLOT_LIMIT + 1) }],
		["modelChain 不是数组", { avatar: CANVAS_PNG, modelChain: "not-an-array" }],
		[
			"modelChain 带密钥值",
			{
				avatar: CANVAS_PNG,
				modelChain: [{ providerId: "p", modelId: "m", keyEnv: "KEY", apiKey: "sk-x" }],
			},
		],
		["status 非法", { avatar: CANVAS_PNG, status: "deleted" }],
	];

	for (const [why, body] of cases) {
		const res = await patch(partner.id, body);
		assert.equal(res.status, 400, `应 400：${why}`);
		assert.deepEqual(state(partner.id), before, `400 后旧值必须全不变：${why}`);
	}
});

test("PATCH：坏头像 / 坏压缩数据 → 400，头像与其它字段都不半写", async () => {
	const partner = seed("旧名字");
	const before = state(partner.id);

	const cases: Array<[string, string]> = [
		["CRC 错", BAD_CRC],
		["IHDR 长度错", BAD_IHDR_LENGTH],
		["IHDR 参数错", BAD_IHDR_PARAMS],
		["没有 IDAT", NO_IDAT],
		["截断", TRUNCATED],
		["IDAT 不是 deflate", BAD_COMPRESSED],
		["IDAT 中间损坏", MIDDLE_DAMAGE],
		["解压长度不匹配", WRONG_DIMENSIONS],
		["filter 字节非法", BAD_FILTER],
	];

	for (const [why, avatar] of cases) {
		const res = await patch(partner.id, {
			avatar,
			name: "新名字",
			status: "active",
			soul: "新身份",
			modelChain: VALID_CHAIN,
		});
		assert.equal(res.status, 400, `应 400：${why}`);
		assert.deepEqual(state(partner.id), before, `400 后旧值必须全不变：${why}`);
	}
});

test("PATCH：canvas 兼容 PNG 保存 / 省略 avatar 不清除 / 清除回 null", async () => {
	const partner = seed("头像执事");

	const saved = await patch(partner.id, { avatar: CANVAS_PNG });
	assert.equal(saved.status, 200);
	assert.equal((saved.body.partner as { avatar?: unknown }).avatar, CANVAS_PNG);
	assert.equal(store.get(partner.id)?.avatar, CANVAS_PNG);

	// 省略 avatar 的 PATCH 不能把头像清掉
	const renamed = await patch(partner.id, { name: "换名字" });
	assert.equal(renamed.status, 200);
	assert.equal(store.get(partner.id)?.avatar, CANVAS_PNG);

	// 详情投影也带头像
	const detail = await app.request(`/api/v1/partners/${partner.id}`);
	const detailBody = (await detail.json()) as { partner?: { avatar?: unknown } };
	assert.equal(detailBody.partner?.avatar, CANVAS_PNG);

	const cleared = await patch(partner.id, { avatar: null });
	assert.equal(cleared.status, 200);
	assert.equal((cleared.body.partner as { avatar?: unknown }).avatar, null);
	assert.equal(store.get(partner.id)?.avatar, null);
});

test("PATCH：合法头像 + name/status/SOUL/modelChain 同批提交全部生效", async () => {
	const partner = seed("旧名字");

	const res = await patch(partner.id, {
		avatar: CANVAS_PNG,
		name: "新名字",
		status: "active",
		soul: "新身份",
		modelChain: VALID_CHAIN,
	});
	assert.equal(res.status, 200);

	const row = store.get(partner.id);
	assert.equal(row?.avatar, CANVAS_PNG);
	assert.equal(row?.name, "新名字");
	assert.equal(row?.status, "active");
	assert.equal(store.readSoulFromHome(partner.id), "新身份");
	assert.deepEqual(store.getModelChain(partner.id), VALID_CHAIN);
});

test("PATCH：空 name / 空 soul 仍是不改（既有语义），不会被新校验改写", async () => {
	const partner = seed("旧名字");
	const before = state(partner.id);

	for (const body of [
		{ name: "", soul: "" },
		{ name: "   ", soul: "   " },
	]) {
		const res = await patch(partner.id, body);
		assert.equal(res.status, 200);
		assert.deepEqual(state(partner.id), before);
	}
});

// ── 当前目标（2026-11-08 员工人格化刀二 E4）────────────────

test("currentGoal：PATCH 设置 → detail 读回 → 列表形状不变；空串/null 清除；非法 400", async () => {
	const id = store.create("目标执事").id;

	const set = await patch(id, { currentGoal: "本季度把安装包做稳" });
	assert.equal(set.status, 200);
	assert.equal(set.body.currentGoal, "本季度把安装包做稳");
	assert.equal(store.get(id)?.currentGoal, "本季度把安装包做稳");

	const detailRes = await app.request(`/api/v1/partners/${id}`);
	const detail = (await detailRes.json()) as {
		currentGoal?: unknown;
		partner?: Record<string, unknown>;
	};
	assert.equal(detail.currentGoal, "本季度把安装包做稳", "只进 detail 端点");
	assert.equal("currentGoal" in (detail.partner ?? {}), false, "detail 的 partner 投影形状不变");

	const listRes = await app.request("/api/v1/partners");
	const list = (await listRes.json()) as { partners?: Array<Record<string, unknown>> };
	assert.equal(
		list.partners?.every((row) => !("currentGoal" in row)),
		true,
		"GET /api/v1/partners 列表形状不变（零 shared 改动）",
	);

	// 省略 = 不改
	const omit = await patch(id, { name: "改个名" });
	assert.equal(omit.status, 200);
	assert.equal(store.get(id)?.currentGoal, "本季度把安装包做稳");

	// 空串 / 全空白 / null = 清除
	for (const clear of ["", "   ", null]) {
		const cleared = await patch(id, { currentGoal: clear });
		assert.equal(cleared.status, 200);
		assert.equal(store.get(id)?.currentGoal, null, `currentGoal=${JSON.stringify(clear)} 清除`);
	}

	// 非法类型 / 超长 → 400 且旧值不变（整批先校验再写）
	await patch(id, { currentGoal: "先设一个" });
	for (const bad of [123, true, {}, "x".repeat(1001)]) {
		const res = await patch(id, { currentGoal: bad });
		assert.equal(res.status, 400, `currentGoal=${JSON.stringify(bad)} 应 400`);
		assert.equal(store.get(id)?.currentGoal, "先设一个", "400 后旧值不变");
	}
});

test("currentGoal：老库（partners 无 current_goal 列）打开不炸、旧行读出 null、可写", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-goal-legacy-"));
	const dbPath = join(dir, "partners.sqlite");
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
			CREATE TABLE partners (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
				current_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
		`);
		const now = new Date().toISOString();
		legacy
			.prepare(
				"INSERT INTO partners (id, name, status, current_version, created_at, updated_at) VALUES (?, ?, 'active', 1, ?, ?)",
			)
			.run("legacy-goal", "老执事", now, now);
		legacy.close();

		const { PartnersStore } = await import("./partners.ts");
		const migrated = new PartnersStore(dbPath, join(dir, "homes"));
		try {
			assert.equal(migrated.get("legacy-goal")?.currentGoal, null, "缺列 = null，不补数据");
			migrated.setCurrentGoal("legacy-goal", "补一个目标");
			assert.equal(migrated.get("legacy-goal")?.currentGoal, "补一个目标", "迁移后可写");
		} finally {
			migrated.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── 口头禅（2026-11-12 手机对话身份方案 §四）──────────────

test("tagline：POST 建档时带上 → 响应/列表/详情读回；null/空 = 不设；非法 → 400 且不建档", async () => {
	const before = store.list().length;

	// 建档时直接带：trim 后落库，响应投影直接可读（手机建档页不用再补 PATCH）
	const created = await createPartner({ name: "建档带口头禅", tagline: "  交给我吧  " });
	assert.equal(created.status, 201);
	const partner = created.body.partner as Record<string, unknown>;
	assert.equal(partner.tagline, "交给我吧", "POST 响应投影带 tagline");
	const id = String(partner.id);
	assert.equal(store.get(id)?.tagline, "交给我吧", "trim 后落库");
	assert.equal(store.list().length, before + 1, "成功建档只多一条");

	const detail = (await (await app.request(`/api/v1/partners/${id}`)).json()) as {
		partner?: Record<string, unknown>;
	};
	assert.equal(detail.partner?.tagline, "交给我吧", "详情投影带 tagline");

	const list = (await (await app.request("/api/v1/partners")).json()) as {
		partners?: Array<Record<string, unknown>>;
	};
	assert.equal(
		list.partners?.find((row) => row.id === id)?.tagline,
		"交给我吧",
		"列表投影带 tagline",
	);

	// 不带 / null / 空串 / 全空白：不设，响应与读回都是 null
	for (const empty of [undefined, null, "", "   "]) {
		const res = await createPartner({
			name: `不设口头禅-${String(empty)}`,
			...(empty === undefined ? {} : { tagline: empty }),
		});
		assert.equal(res.status, 201);
		assert.equal(
			(res.body.partner as Record<string, unknown>).tagline,
			null,
			`tagline=${JSON.stringify(empty)} 不设`,
		);
	}

	// 非法类型 / 超长：建档之前 400，档案数不变（不留半建档案）
	const baseline = store.list().length;
	for (const bad of [123, true, {}, "x".repeat(41), "😀".repeat(41)]) {
		const res = await createPartner({ name: "不该建档", tagline: bad });
		assert.equal(res.status, 400, `tagline=${JSON.stringify(bad)} 应 400`);
		assert.equal(store.list().length, baseline, "非法 tagline 不建档");
	}
});

test("tagline：PATCH 设置 → 列表与详情都带；trim；省略不改；null/空串清除；超长/非法 400 且整批不写", async () => {
	const id = store.create("口头禅执事").id;

	// 未设置时列表与详情都给 null（字段一定存在，前端不用猜）
	const initialList = (await (await app.request("/api/v1/partners")).json()) as {
		partners?: Array<Record<string, unknown>>;
	};
	const initialRow = initialList.partners?.find((row) => row.id === id);
	assert.equal(initialRow?.tagline, null, "列表未设置给 null");
	const initialDetail = (await (await app.request(`/api/v1/partners/${id}`)).json()) as {
		partner?: Record<string, unknown>;
	};
	assert.equal(initialDetail.partner?.tagline, null, "详情未设置给 null");

	// 设置：trim 后存，PATCH 回显 + 列表 + 详情都读得到
	const set = await patch(id, { tagline: "  我在呢  " });
	assert.equal(set.status, 200);
	assert.equal(set.body.tagline, "我在呢");
	assert.equal((set.body.partner as Record<string, unknown>).tagline, "我在呢");
	assert.equal(store.get(id)?.tagline, "我在呢");

	const detail = (await (await app.request(`/api/v1/partners/${id}`)).json()) as {
		partner?: Record<string, unknown>;
	};
	assert.equal(detail.partner?.tagline, "我在呢", "详情投影带 tagline");

	const list = (await (await app.request("/api/v1/partners")).json()) as {
		partners?: Array<Record<string, unknown>>;
	};
	assert.equal(
		list.partners?.find((row) => row.id === id)?.tagline,
		"我在呢",
		"列表投影带 tagline（首页 / 空态零额外请求）",
	);

	// 省略 = 不改
	const omit = await patch(id, { name: "改个名" });
	assert.equal(omit.status, 200);
	assert.equal(store.get(id)?.tagline, "我在呢");

	// null / 空串 / 全空白 = 清除
	for (const clear of [null, "", "   "]) {
		await patch(id, { tagline: "先设一个" });
		const cleared = await patch(id, { tagline: clear });
		assert.equal(cleared.status, 200);
		assert.equal(store.get(id)?.tagline, null, `tagline=${JSON.stringify(clear)} 清除`);
	}

	// 40 个 emoji = 40 个 code point（UTF-16 length 是 80）：必须收下，证明按 code point 计数
	const emoji40 = "😀".repeat(40);
	const boundary = await patch(id, { tagline: emoji40 });
	assert.equal(boundary.status, 200);
	assert.equal(store.get(id)?.tagline, emoji40);

	// 非法类型 / 超长 → 400 且整批不写（同批的 name 也不能落地）
	await patch(id, { tagline: "先设一个" });
	const before = store.get(id);
	for (const bad of [123, true, {}, "x".repeat(41), "😀".repeat(41)]) {
		const res = await patch(id, { name: "不该写入", tagline: bad });
		assert.equal(res.status, 400, `tagline=${JSON.stringify(bad)} 应 400`);
		const after = store.get(id);
		assert.equal(after?.tagline, "先设一个", "400 后旧值不变");
		assert.equal(after?.name, before?.name, "400 后同批 name 也不写");
	}
});

/**
 * 日记执事（2026-11-12 日记 v2）：全局至多一个。
 * PATCH 置 true 时服务端同事务清其他执事；false 取消；省略不改；非布尔 400 且整批不写。
 */
test("diary：PATCH 置 true 全局唯一（其他执事自动清）；false 取消；省略不改；非布尔 400", async () => {
	const a = store.create("日记执事甲").id;
	const b = store.create("日记执事乙").id;

	const setA = await patch(a, { diary: true });
	assert.equal(setA.status, 200);
	assert.equal(setA.body.diary, true, "PATCH 回显 diary");
	assert.equal((setA.body.partner as Record<string, unknown>).diary, true, "partner 投影带 diary");
	assert.equal(store.get(a)?.diary, true);

	// 列表投影也带
	const listA = (await (await app.request("/api/v1/partners")).json()) as {
		partners?: Array<Record<string, unknown>>;
	};
	assert.equal(listA.partners?.find((row) => row.id === a)?.diary, true);

	// 置 B = 甲自动清（不允许两个日记执事）
	const setB = await patch(b, { diary: true });
	assert.equal(setB.status, 200);
	assert.equal(store.get(b)?.diary, true);
	assert.equal(store.get(a)?.diary, false, "全局至多一个：甲自动清");

	// 省略 = 不改
	await patch(b, { name: "日记执事乙改名" });
	assert.equal(store.get(b)?.diary, true, "省略 diary 不动");

	// false = 取消
	await patch(b, { diary: false });
	assert.equal(store.get(b)?.diary, false);

	// 非布尔 → 400 且整批不写（同批 name 也不能落地）
	const beforeName = store.get(a)?.name;
	const bad = await patch(a, { name: "不该写入", diary: "true" });
	assert.equal(bad.status, 400);
	assert.equal(store.get(a)?.diary, false, "400 后 diary 不变");
	assert.equal(store.get(a)?.name, beforeName, "400 后同批 name 不写");
});

test("tagline：老库（partners 无 tagline 列）打开不炸、旧行读出 null、可写", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-tagline-legacy-"));
	const dbPath = join(dir, "partners.sqlite");
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
			CREATE TABLE partners (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
				current_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
		`);
		const now = new Date().toISOString();
		legacy
			.prepare(
				"INSERT INTO partners (id, name, status, current_version, created_at, updated_at) VALUES (?, ?, 'active', 1, ?, ?)",
			)
			.run("legacy-tagline", "老执事", now, now);
		legacy.close();

		const { PartnersStore } = await import("./partners.ts");
		const migrated = new PartnersStore(dbPath, join(dir, "homes"));
		try {
			assert.equal(migrated.get("legacy-tagline")?.tagline, null, "缺列 = null，不补数据");
			migrated.setTagline("legacy-tagline", "补一句口头禅");
			assert.equal(
				migrated.get("legacy-tagline")?.tagline,
				"补一句口头禅",
				"迁移后可写",
			);
		} finally {
			migrated.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── 员工档案 · 技能清单（2026-11-09）────────────────────────

test("GET /partners/:id/skills：首行摘要 + mtime，非 md 不收；空目录 / 未知执事", async () => {
	const partner = store.create("技能清单执事");
	const skillsDir = store.skillsDirOf(partner.id);
	mkdirSync(skillsDir, { recursive: true });

	// 目录存在但为空 → 空列表，不报错
	const emptyRes = await app.request(`/api/v1/partners/${partner.id}/skills`);
	assert.equal(emptyRes.status, 200);
	const emptyBody = (await emptyRes.json()) as { ok?: boolean; skills?: unknown[] };
	assert.equal(emptyBody.ok, true);
	assert.deepEqual(emptyBody.skills, []);

	writeFileSync(join(skillsDir, "meeting.md"), "会议纪要的写法\r\n\r\n第一步：先记结论。\n", "utf8");
	writeFileSync(join(skillsDir, "recall.md"), "回忆引导的口径\n正文", "utf8");
	writeFileSync(join(skillsDir, "notes.txt"), "不该被收录", "utf8");

	const listRes = await app.request(`/api/v1/partners/${partner.id}/skills`);
	assert.equal(listRes.status, 200);
	const body = (await listRes.json()) as {
		ok?: boolean;
		skills?: { name: string; summary: string; updatedAt: string }[];
	};
	assert.equal(body.ok, true);
	assert.deepEqual(
		body.skills?.map((skill) => skill.name),
		["meeting", "recall"],
		"只收 *.md、按名字排序",
	);
	assert.equal(body.skills?.[0]?.summary, "会议纪要的写法", "summary = 第一行（CRLF 也只取一行）");
	assert.equal(body.skills?.[1]?.summary, "回忆引导的口径");
	assert.ok(!Number.isNaN(Date.parse(body.skills?.[0]?.updatedAt ?? "")), "updatedAt 是合法时间");

	const missing = await app.request("/api/v1/partners/no-such-partner/skills");
	assert.equal(missing.status, 404, "未知执事 404");
});

test("PUT /partners/:id/skills/:name/enabled：全局关可按人开，全局开 409 锁死", async () => {
	const partner = store.create("技能开关执事");
	const state = getSkillState();
	const endpoint = `/api/v1/partners/${partner.id}/skills/meeting_guide/enabled`;

	// 全局默认全关：可以只给这个执事开
	const onRes = await app.request(endpoint, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: true }),
	});
	assert.equal(onRes.status, 200);
	const onBody = (await onRes.json()) as { ok?: boolean; enabled?: boolean; partnerId?: string };
	assert.equal(onBody.ok, true);
	assert.equal(onBody.enabled, true);
	assert.equal(onBody.partnerId, partner.id);
	assert.equal(state.isEnabledFor(partner.id, "meeting_guide"), true);
	assert.equal(state.isEnabledFor("someone-else", "meeting_guide"), false, "不影响别人");

	// 关掉 = 删覆盖位
	const offRes = await app.request(endpoint, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	assert.equal(offRes.status, 200);
	assert.equal(state.isEnabledFor(partner.id, "meeting_guide"), false);

	// 全局开 = 所有人都有，个人页锁死
	state.setEnabled("meeting_guide", true);
	const locked = await app.request(endpoint, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	assert.equal(locked.status, 409, "全局已开不能按人关");
	const lockedBody = (await locked.json()) as { error?: string };
	assert.equal(lockedBody.error, "locked");
	state.setEnabled("meeting_guide", false);

	// GET /agent/skills?partnerId：按人字段要和 PUT 的结果一致；不带 partnerId 时形状不变
	const onAgain = await app.request(endpoint, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: true }),
	});
	assert.equal(onAgain.status, 200);
	const scoped = (await (
		await skillsApp.request(`/api/v1/agent/skills?partnerId=${encodeURIComponent(partner.id)}`)
	).json()) as { items?: Array<Record<string, unknown>> };
	const scopedSkill = scoped.items?.find((item) => item.name === "meeting_guide");
	assert.equal(scopedSkill?.enabled, false, "全局关");
	assert.equal(scopedSkill?.partnerEnabled, true, "这个人实际可用");
	assert.equal(scopedSkill?.partnerOverride, true, "全局没开、该人独开");
	const globalScoped = (await (await skillsApp.request("/api/v1/agent/skills")).json()) as {
		items?: Array<Record<string, unknown>>;
	};
	const globalSkill = globalScoped.items?.find((item) => item.name === "meeting_guide");
	assert.equal(globalSkill?.partnerEnabled, undefined, "不带 partnerId 不追加按人字段");
	assert.equal(globalSkill?.partnerOverride, undefined);
	await app.request(endpoint, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});

	// 边界：未知执事 / 非法名字 / 不存在的技能 / 非布尔 body
	const noPartner = await app.request(
		"/api/v1/partners/no-such-partner/skills/meeting_guide/enabled",
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		},
	);
	assert.equal(noPartner.status, 404);
	const badName = await app.request(`/api/v1/partners/${partner.id}/skills/Bad%20Name/enabled`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: true }),
	});
	assert.equal(badName.status, 400);
	const noSkill = await app.request(`/api/v1/partners/${partner.id}/skills/no_such_skill/enabled`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: true }),
	});
	assert.equal(noSkill.status, 404);
	const badBody = await app.request(endpoint, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: "yes" }),
	});
	assert.equal(badBody.status, 400);
});

// ── 员工人格模块端点（2026-11-14 批1）────────────────────────

interface PersonaBody {
	ok?: boolean;
	enabled?: boolean;
	preset?: string;
	modules?: Record<string, boolean>;
	switches?: { moodAffectTone?: boolean; nudgeEnabled?: boolean; memoryRecallEnabled?: boolean };
	contents?: { style?: Record<string, unknown>; values?: Record<string, unknown>; scenario?: Record<string, unknown> };
	voice?: { ruleCount?: number; jargonCount?: number; rules?: Array<{ kind?: string; text?: string }>; updatedAt?: string | null } | null;
	proactivity?: { nudgeEnabled?: boolean; lastNudgeAt?: string | null } | null;
	profiles?: {
		limit?: number;
		items?: Array<{ id: string; name: string; createdAt: string; preset: string; modules?: Record<string, boolean> }>;
	} | null;
	living?: {
		ownerTier?: string;
		tierNote?: string | null;
		mood?: { mood?: string; reason?: string; nearby?: string; updatedAt?: string | null; source?: string | null };
		impressions?: Array<{ id: string; subject: string; subjectName: string; text: string; source: string }>;
		diary?: { count?: number; latestText?: string | null; entries?: Array<{ id: string; text: string; liked?: boolean; source?: string }> };
		wishes?: string[];
		growth?: string | null;
	} | null;
	limits?: {
		style?: { speakStyle?: number; catchphrases?: { max?: number; each?: number } };
		living?: { impressionText?: number; diaryText?: number; wishes?: number };
		voice?: { example?: number; ruleText?: number; rules?: number };
		profiles?: { count?: number; name?: number };
	};
	error?: string;
	message?: string;
}

function putPersona(id: string, body: unknown) {
	return app.request(`/api/v1/partners/${id}/persona`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("GET /partners/:id/persona：默认 work 预设 + 空内容 + 上限原样回传；未知执事 404", async () => {
	const partner = store.create("人格执事");
	const res = await app.request(`/api/v1/partners/${partner.id}/persona`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as PersonaBody;
	assert.equal(body.ok, true);
	assert.equal(body.enabled, true, "缺省开");
	assert.equal(body.preset, "work");
	assert.equal(body.modules?.contract, true);
	assert.equal(body.modules?.goal, true);
	assert.equal(body.modules?.expression, false, "work 预设静态模块关");
	assert.deepEqual(body.contents, { style: {}, values: {}, scenario: {} });
	assert.equal(body.limits?.style?.speakStyle, 300);
	assert.equal(body.limits?.style?.catchphrases?.max, 8);
	assert.equal(body.limits?.style?.catchphrases?.each, 24);

	const missing = await app.request("/api/v1/partners/no-such-partner/persona");
	assert.equal(missing.status, 404);
});

test("PUT /partners/:id/persona：换预设一键填开关；逐键覆盖；内容按字段合并", async () => {
	const partner = store.create("人格执事乙");
	const id = partner.id;

	// 换预设 = 一键填开关（companion：口吻 / 里子 / 处境开，岗位类关）
	const presetRes = await putPersona(id, { preset: "companion" });
	assert.equal(presetRes.status, 200);
	const companion = (await presetRes.json()) as PersonaBody;
	assert.equal(companion.preset, "companion");
	assert.equal(companion.modules?.expression, true);
	assert.equal(companion.modules?.contract, false);
	assert.equal(companion.modules?.impression, true, "批2 模块先落开关，本批不注入");

	// 逐键覆盖：只改 contract，其它键不动；表不再匹配 companion → 预设自动跳「自定义」
	// （2026-11-15 人设页打磨：预设名按最终开关表推导）
	const toggle = (await (await putPersona(id, { modules: { contract: true } })).json()) as PersonaBody;
	assert.equal(toggle.preset, "custom", "表不匹配预设 → 自动跳自定义");
	assert.equal(toggle.modules?.contract, true);
	assert.equal(toggle.modules?.expression, true, "没提到的键保持");

	// 改回 companion 原样 → 自动跳回 companion
	const back = (await (await putPersona(id, { modules: { contract: false } })).json()) as PersonaBody;
	assert.equal(back.preset, "companion", "表回到预设原样 → 自动跳回该预设");

	// 内容：按字段合并（先写一句，再补一句，第一句还在）
	await putPersona(id, { contents: { style: { speakStyle: "短句，先给结论。" } } });
	const merged = (await (await putPersona(id, { contents: { style: { openingLine: "我来了。" } } })).json()) as PersonaBody;
	assert.equal(merged.contents?.style?.speakStyle, "短句，先给结论。");
	assert.equal(merged.contents?.style?.openingLine, "我来了。");

	// 清空一个字段：空串写进去，另一字段不动
	const cleared = (await (await putPersona(id, { contents: { style: { speakStyle: "" } } })).json()) as PersonaBody;
	assert.equal(cleared.contents?.style?.speakStyle, "");
	assert.equal(cleared.contents?.style?.openingLine, "我来了。");

	// 三份内容各自独立落盘（重新 GET 也读得回）
	const reread = (await (await app.request(`/api/v1/partners/${id}/persona`)).json()) as PersonaBody;
	assert.deepEqual(reread.contents, cleared.contents);
});

test("PUT /partners/:id/persona：超限 / 未知模块 / 错类型一律 400，且不写半个字节", async () => {
	const partner = store.create("人格执事丙");
	const id = partner.id;
	await putPersona(id, { contents: { values: { cares: "把活办完。" } } });

	const overLimit = await putPersona(id, { contents: { style: { speakStyle: "字".repeat(301) } } });
	assert.equal(overLimit.status, 400);
	assert.match(((await overLimit.json()) as PersonaBody).message ?? "", /不超过 300 字/);

	const tooMany = await putPersona(id, {
		contents: { values: { likes: Array.from({ length: 11 }, () => "喜欢") } },
	});
	assert.equal(tooMany.status, 400);

	const unknownModule = await putPersona(id, { modules: { nope: true } });
	assert.equal(unknownModule.status, 400);

	const wrongType = await putPersona(id, { modules: { expression: "yes" } });
	assert.equal(wrongType.status, 400);

	const badProbability = await putPersona(id, { contents: { style: { switchProbability: 101 } } });
	assert.equal(badProbability.status, 400);

	const unknownTop = await putPersona(id, { vibe: "温柔" });
	assert.equal(unknownTop.status, 400);

	// 全部 400：之前写进去的内容 / 预设一个都没变
	const after = (await (await app.request(`/api/v1/partners/${id}/persona`)).json()) as PersonaBody;
	assert.equal(after.preset, "work");
	assert.equal(after.modules?.expression, false);
	assert.equal(after.contents?.values?.cares, "把活办完。");
	assert.equal(after.contents?.style?.speakStyle, undefined);
});

test("PARTNER_PERSONA_MODULES=false：GET 回默认值且 enabled=false，PUT 400（端点还在）", async () => {
	const partner = store.create("人格执事丁");
	const previous = process.env.PARTNER_PERSONA_MODULES;
	process.env.PARTNER_PERSONA_MODULES = "false";
	try {
		const res = await app.request(`/api/v1/partners/${partner.id}/persona`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as PersonaBody;
		assert.equal(body.enabled, false);
		assert.equal(body.preset, "work", "关着时模块字段回默认值");
		assert.equal(body.modules?.contract, true);
		assert.equal(body.modules?.expression, false);

		const put = await putPersona(partner.id, { preset: "companion" });
		assert.equal(put.status, 400);
		assert.match(((await put.json()) as PersonaBody).message ?? "", /PARTNER_PERSONA_MODULES/);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_PERSONA_MODULES;
		else process.env.PARTNER_PERSONA_MODULES = previous;
	}
});

test("persona 活状态（批2）：GET 带 living 默认值；PUT 手改心情 / 愿望 / 日记写 manual", async () => {
	const partner = store.create("活状态执事");
	const before = (await (
		await app.request(`/api/v1/partners/${partner.id}/persona`)
	).json()) as PersonaBody;
	assert.equal(before.living?.ownerTier, "生疏");
	assert.equal(before.living?.mood?.mood, "平静");
	assert.equal(before.living?.mood?.source, null);
	assert.deepEqual(before.living?.impressions, []);
	assert.equal(before.living?.diary?.count, 0);
	assert.deepEqual(before.living?.wishes, []);
	assert.equal(before.limits?.living?.impressionText, 120);
	assert.equal(before.switches?.moodAffectTone, false);

	const res = await putPersona(partner.id, {
		switches: { moodAffectTone: true },
		living: {
			ownerTier: "认识",
			mood: "疲惫",
			moodReason: "跑了一天",
			nearby: "在补上周的账",
			wishes: ["早点收工"],
			diary: { add: "今天很累，但把账补完了。" },
		},
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as PersonaBody;
	assert.equal(body.switches?.moodAffectTone, true);
	assert.equal(body.living?.ownerTier, "认识");
	assert.equal(body.living?.mood?.mood, "疲惫");
	assert.equal(body.living?.mood?.reason, "跑了一天");
	assert.equal(body.living?.mood?.source, "manual", "手改写 manual 标记");
	assert.equal(body.living?.diary?.count, 1);
	assert.equal(body.living?.diary?.latestText, "今天很累，但把账补完了。");
	assert.equal(body.living?.diary?.entries?.[0]?.source, "manual");
	assert.deepEqual(body.living?.wishes, ["早点收工"]);

	// 赞 → 删（只影响展示排序，不做算法）
	const diaryId = body.living?.diary?.entries?.[0]?.id ?? "";
	const liked = (await (
		await putPersona(partner.id, { living: { diary: { like: diaryId } } })
	).json()) as PersonaBody;
	assert.equal(liked.living?.diary?.entries?.[0]?.liked, true);
	const removed = (await (
		await putPersona(partner.id, { living: { diary: { remove: diaryId } } })
	).json()) as PersonaBody;
	assert.equal(removed.living?.diary?.count, 0);

	// 非法值一律 400，且一个字段都不写
	assert.equal((await putPersona(partner.id, { living: { mood: "开心" } })).status, 400);
	assert.equal(
		(await putPersona(partner.id, { living: { wishes: Array.from({ length: 11 }, () => "想") } })).status,
		400,
	);
	assert.equal(
		(
			await putPersona(partner.id, {
				living: { impression: { add: { subject: "owner", text: "字".repeat(121) } } },
			})
		).status,
		400,
	);
	const still = (await (
		await app.request(`/api/v1/partners/${partner.id}/persona`)
	).json()) as PersonaBody;
	assert.equal(still.living?.mood?.mood, "疲惫", "400 不写");
	assert.deepEqual(still.living?.wishes, ["早点收工"]);
});

test("persona 活状态：PARTNER_PERSONA_MODULES=false 时 living 为 null（整块隐藏）", async () => {
	const partner = store.create("活状态回滚执事");
	const previous = process.env.PARTNER_PERSONA_MODULES;
	process.env.PARTNER_PERSONA_MODULES = "false";
	try {
		const body = (await (
			await app.request(`/api/v1/partners/${partner.id}/persona`)
		).json()) as PersonaBody;
		assert.equal(body.enabled, false);
		assert.equal(body.living, null);
		assert.equal(body.voice, null);
		assert.equal(body.proactivity, null);
		assert.equal(body.profiles, null);
	} finally {
		if (previous === undefined) delete process.env.PARTNER_PERSONA_MODULES;
		else process.env.PARTNER_PERSONA_MODULES = previous;
	}
});

test("persona 批3：voice / proactivity / profiles 投影；人设库存取应用不改 SOUL", async () => {
	const partner = store.create("批3执事");
	const initial = (await (
		await app.request(`/api/v1/partners/${partner.id}/persona`)
	).json()) as PersonaBody;
	assert.equal(initial.voice?.ruleCount, 0);
	assert.equal(initial.voice?.jargonCount, 0);
	assert.deepEqual(initial.voice?.rules, []);
	assert.deepEqual(initial.proactivity, { nudgeEnabled: false, lastNudgeAt: null });
	assert.deepEqual(initial.profiles, { limit: 5, items: [] });
	assert.equal(initial.limits?.voice?.example, 40);
	assert.equal(initial.limits?.profiles?.count, 5);
	assert.equal(initial.switches?.nudgeEnabled, false);

	const on = (await (
		await putPersona(partner.id, {
			modules: { profiles: true, learning: true, proactivity: true },
			switches: { nudgeEnabled: true },
			contents: { style: { speakStyle: "短句，先给结论。" } },
		})
	).json()) as PersonaBody;
	assert.equal(on.modules?.profiles, true);
	assert.equal(on.switches?.nudgeEnabled, true);

	const soulBefore = store.readSoulFromHome(partner.id);
	const saved = (await (
		await putPersona(partner.id, { profiles: { save: { name: "工作态" } } })
	).json()) as PersonaBody;
	assert.equal(saved.profiles?.items?.length, 1);
	assert.equal(saved.profiles?.items?.[0]?.name, "工作态");
	const profileId = saved.profiles?.items?.[0]?.id ?? "";
	assert.equal("contents" in (saved.profiles?.items?.[0] ?? {}), false, "列表只回摘要");

	// 改内容 → 应用快照 → 回到保存当时；SOUL 不动
	await putPersona(partner.id, { contents: { style: { speakStyle: "变了。" } } });
	const applied = (await (
		await putPersona(partner.id, { profiles: { apply: { id: profileId } } })
	).json()) as PersonaBody;
	assert.equal(applied.contents?.style?.speakStyle, "短句，先给结论。");
	assert.equal(store.readSoulFromHome(partner.id), soulBefore, "应用快照不动 SOUL");

	// 一次只能做一件
	const two = await putPersona(partner.id, {
		profiles: { save: { name: "又一份" }, remove: { id: profileId } },
	});
	assert.equal(two.status, 400);
	// 人设库动作不能和 preset / modules / contents 混批（避免半写）
	const mixed = await putPersona(partner.id, {
		preset: "work",
		profiles: { save: { name: "混合" } },
	});
	assert.equal(mixed.status, 400);
	const stillCustom = (await (
		await app.request(`/api/v1/partners/${partner.id}/persona`)
	).json()) as PersonaBody;
	// 上面 1062 那步把 profiles / learning / proactivity 开了：开关表已不匹配 work，
	// 按推导口径（2026-11-15 人设页打磨）预设那时就该已是 custom；混批 400 后保持不变。
	assert.equal(stillCustom.preset, "custom", "混批 400 不改预设（推导口径下此时应为 custom）");
	assert.equal(stillCustom.profiles?.items?.length, 1, "混批 400 不新增快照");

	// 模块关：动作 400；列表仍回读
	await putPersona(partner.id, { modules: { profiles: false } });
	const off = await putPersona(partner.id, { profiles: { remove: { id: profileId } } });
	assert.equal(off.status, 400);
	const reread = (await (
		await app.request(`/api/v1/partners/${partner.id}/persona`)
	).json()) as PersonaBody;
	assert.equal(reread.profiles?.items?.length, 1, "模块关内容保留");
});

test("PUT /persona：新预设（全才 / 学徒）铺表；GET 的 preset 与开关表一致", async () => {
	const partner = store.create("预设执事");

	const allRes = await putPersona(partner.id, { preset: "allrounder" });
	assert.equal(allRes.status, 200);
	const all = (await allRes.json()) as PersonaBody;
	assert.equal(all.preset, "allrounder");
	assert.equal(all.modules?.expression, true);
	assert.equal(all.modules?.heart, true);
	assert.equal(all.modules?.learning, false);

	const appRes = await putPersona(partner.id, { preset: "apprentice" });
	const apprentice = (await appRes.json()) as PersonaBody;
	assert.equal(apprentice.preset, "apprentice");
	assert.equal(apprentice.modules?.learning, true);
	assert.equal(apprentice.modules?.proactivity, true);
	assert.equal(apprentice.modules?.contract, false);

	// 在学徒表上关掉学习 → 表不再匹配任何预设 → 自定义
	const off = (await (
		await putPersona(partner.id, { modules: { learning: false } })
	).json()) as PersonaBody;
	assert.equal(off.preset, "custom");
});

test("GET /partners/:id/injection-preview：纪律跟随开关；在办 / 履历固定给原文", async () => {
	const partner = store.create("预览执事");

	// 缺省 work 预设：纪律开 → 给全文（含红线）
	const onRes = await app.request(`/api/v1/partners/${partner.id}/injection-preview`);
	assert.equal(onRes.status, 200);
	const on = (await onRes.json()) as {
		ok: boolean;
		discipline: string | null;
		currentWork: string | null;
		workHistory: string | null;
	};
	assert.equal(on.ok, true);
	assert.match(on.discipline ?? "", /【主人数据红线】/);
	// 没活干 / 没履历 → 两段都是 null（前端弹层显示空态说明）
	assert.equal(on.currentWork, null);
	assert.equal(on.workHistory, null);

	// 纪律关掉（陪伴预设）→ 纪律段 null；两段在办照旧现拼（仍是空）
	await putPersona(partner.id, { preset: "companion" });
	const offRes = await app.request(`/api/v1/partners/${partner.id}/injection-preview`);
	const off = (await offRes.json()) as { discipline: string | null; currentWork: string | null };
	assert.equal(off.discipline, null, "纪律关 → 不注入");

	// 不存在 → 404
	const missing = await app.request("/api/v1/partners/no-such/injection-preview");
	assert.equal(missing.status, 404);
});

test("纪律覆盖端点：GET 默认 / PUT 覆盖 / 空节删除 / 红线拒绝 / DELETE 恢复", async () => {
	const partner = store.create("纪律执事");
	const base = `/api/v1/partners/${partner.id}/discipline`;

	const read = await app.request(base);
	assert.equal(read.status, 200);
	const initial = (await read.json()) as {
		ok: boolean;
		defaultDiscipline: string;
		override: string | null;
		redLine: string;
	};
	assert.equal(initial.ok, true);
	assert.match(initial.defaultDiscipline, /## 验证铁律/);
	assert.equal(initial.override, null);
	assert.match(initial.redLine, /【主人数据红线】/);

	const blocked = await app.request(base, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ discipline: "## 主人数据红线\n- 我想改" }),
	});
	assert.equal(blocked.status, 400);
	assert.match(((await blocked.json()) as { message: string }).message, /不能覆盖/);

	const put = await app.request(base, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			discipline: "## 验证铁律\n- 先跑指定验收，再汇报。\n\n## 裁决纪律\n",
		}),
	});
	assert.equal(put.status, 200);
	assert.match(((await put.json()) as { discipline: string }).discipline, /先跑指定验收/);

	const preview = (await (
		await app.request(`/api/v1/partners/${partner.id}/injection-preview`)
	).json()) as { discipline: string | null };
	assert.match(preview.discipline ?? "", /【验证铁律】\n- 先跑指定验收/);
	assert.equal((preview.discipline ?? "").includes("【裁决纪律】"), false);

	const restore = await app.request(base, { method: "DELETE" });
	assert.equal(restore.status, 200);
	const cleared = (await restore.json()) as { override: string | null; defaultDiscipline: string };
	assert.equal(cleared.override, null);
	assert.match(cleared.defaultDiscipline, /## 裁决纪律/);

	// 空 textarea 提交 = 清空覆盖（不是“没有标题”的 400）
	const clearByPut = await app.request(base, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ discipline: "" }),
	});
	assert.equal(clearByPut.status, 200);
	assert.equal(((await clearByPut.json()) as { override: string | null }).override, null);

	// 回滚开关：三个端点都 400，且不读写覆盖文件
	const previous = process.env.PARTNER_DISCIPLINE_EDIT;
	try {
		process.env.PARTNER_DISCIPLINE_EDIT = "false";
		for (const method of ["GET", "PUT", "DELETE"] as const) {
			const res = await app.request(base, {
				method,
				...(method === "PUT"
					? {
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ discipline: "## 验证铁律\n- x" }),
						}
					: {}),
			});
			assert.equal(res.status, 400, `${method} 在开关关闭时 400`);
		}
	} finally {
		if (previous === undefined) delete process.env.PARTNER_DISCIPLINE_EDIT;
		else process.env.PARTNER_DISCIPLINE_EDIT = previous;
	}
});

test("记忆召回子开关：默认开 / 关掉后投影回 false / 放回去回 true", async () => {
	const partner = store.create("记忆开关执事");

	const initial = (await (
		await app.request(`/api/v1/partners/${partner.id}/persona`)
	).json()) as PersonaBody;
	assert.equal(initial.switches?.memoryRecallEnabled, true, "默认开（未写过）");

	const off = (await (
		await putPersona(partner.id, { switches: { memoryRecallEnabled: false } })
	).json()) as PersonaBody;
	assert.equal(off.switches?.memoryRecallEnabled, false);

	const back = (await (
		await putPersona(partner.id, { switches: { memoryRecallEnabled: true } })
	).json()) as PersonaBody;
	assert.equal(back.switches?.memoryRecallEnabled, true);
});

test("persona 端点鉴权：没凭据 403 空体", async () => {
	const partner = store.create("人格执事戊");
	// 本机凭据落盘也要隔离（auth 首次取 localSecret 时会写这个文件）
	process.env.AGENT_LOCAL_SECRET_PATH = join(root, "local-secret");
	const { createAuthMiddleware } = await import("./auth.ts");
	const secured = new Hono();
	secured.use("/api/v1/*", createAuthMiddleware("secret-token"));
	mountCompanions(secured);

	const res = await secured.request(`/api/v1/partners/${partner.id}/persona`);
	assert.equal(res.status, 403);
	assert.equal(await res.text(), "");
});

// ── 项目记忆挂载（2026-11-15 跟人走立项、同日多挂载方案扩化）──────────────

test("PATCH projectIds：挂多个 / 替换 / 清空 / 投影带字段；未知项目与坏类型 400 不半写", async () => {
	const partner = store.create("挂项目执事");

	// 校验分支先行：坏类型 / 未知 uuid 都在写之前拦
	const badType = await patch(partner.id, { projectIds: 123 });
	assert.equal(badType.status, 400);
	const badItem = await patch(partner.id, {
		projectIds: ["00000000-0000-4000-8000-999999999998", 9],
	});
	assert.equal(badItem.status, 400);
	const unknown = await patch(partner.id, {
		projectIds: ["00000000-0000-4000-8000-999999999999"],
	});
	assert.equal(unknown.status, 400);
	assert.deepEqual(store.get(partner.id)?.projectIds, [], "400 不半写");

	// 造两个真项目（PROJECTS_DB_PATH 已指到临时库；根目录要在工作区里）
	const projects = projectsStore();
	const ws = mkdtempSync(join(tmpdir(), "lifediary-pf-proj-ws-"));
	projects.setWorkspace(ws);
	const first = projects.confirmProposal(projects.proposeProject("演示项目甲", "demo-a").id);
	const second = projects.confirmProposal(projects.proposeProject("演示项目乙", "demo-b").id);

	const setBoth = await patch(partner.id, { projectIds: [first.id, second.id, first.id] });
	assert.equal(setBoth.status, 200);
	assert.deepEqual(setBoth.body.projectIds, [first.id, second.id], "PATCH 回显去重");
	const partnerBody = setBoth.body.partner as Record<string, unknown>;
	assert.deepEqual(partnerBody.projectIds, [first.id, second.id], "投影带字段");

	const reread = await app.request(`/api/v1/partners/${partner.id}`);
	const rereadBody = (await reread.json()) as { partner: Record<string, unknown> };
	assert.deepEqual(rereadBody.partner.projectIds, [first.id, second.id], "详情端点带字段");

	// 整体替换：数组是全集，不是增量
	const replace = await patch(partner.id, { projectIds: [second.id] });
	assert.equal(replace.status, 200);
	assert.deepEqual(store.get(partner.id)?.projectIds, [second.id], "整体替换");

	const clear = await patch(partner.id, { projectIds: [] });
	assert.equal(clear.status, 200);
	assert.deepEqual(clear.body.projectIds, []);
	assert.deepEqual((clear.body.partner as Record<string, unknown>).projectIds, []);

	rmSync(ws, { recursive: true, force: true });
});

//（"开关关：投影与回显整个字段不出现"用例 2026-11-21 随 PARTNER_PROJECT_MEMORY 退役删除，projectIds 恒投影。）

// ── 人设页工具勾选（2026-11-16 工具裁剪 B）──────────────────

test("GET /partners/:id/tools：默认全开 + 固定形状 + no-store + 未知执事 404", async () => {
	const partner = store.create("工具目录执事");
	const res = await app.request(`/api/v1/partners/${partner.id}/tools`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "no-store");
	const body = (await res.json()) as {
		ok: boolean;
		enabled: boolean;
		disabled: string[];
		groups: string[];
		tools: Array<{ name: string; group: string; summary: string; enabled: boolean }>;
	};
	assert.equal(body.ok, true);
	assert.equal(body.enabled, true);
	assert.deepEqual(body.disabled, []);
	assert.equal(body.groups.length, 6);
	assert.ok(body.tools.length > 0, "真实 extension 已装：目录非空");
	assert.ok(
		body.tools.every(
			(tool) =>
				typeof tool.name === "string" &&
				tool.name.length > 0 &&
				typeof tool.group === "string" &&
				typeof tool.summary === "string" &&
				tool.enabled === true,
		),
		"默认全开：每项 enabled=true 且字段齐全",
	);
	const missing = await app.request("/api/v1/partners/no-such-id/tools");
	assert.equal(missing.status, 404);
});

test("PUT /partners/:id/tools：未知名 400、保存回读、清空回全开、不 bump 版本", async () => {
	const partner = store.create("工具勾选执事");
	const path = `/api/v1/partners/${partner.id}/tools`;
	const first = await app.request(path);
	const view = (await first.json()) as {
		tools: Array<{ name: string; enabled: boolean }>;
	};
	const candidate = view.tools[0]!.name;

	const put = (disabled: unknown) =>
		app.request(path, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ disabled }),
		});

	const bad = await put(["no_such_tool", "another_bad"]);
	assert.equal(bad.status, 400);
	const badBody = (await bad.json()) as { message: string; unknown: string[] };
	assert.match(badBody.message, /未知工具：no_such_tool、another_bad/);
	assert.deepEqual(badBody.unknown, ["no_such_tool", "another_bad"]);
	assert.deepEqual(store.get(partner.id)?.disabledTools, [], "400 不写入");

	const notArray = await put("write");
	assert.equal(notArray.status, 400, "非数组 400");

	// delegate 描述依赖 skill 读手册：只关 skill 不关 delegate 拒（2026-11-16 A+B 联调）。
	const names = new Set(view.tools.map((tool) => tool.name));
	if (names.has("delegate") && names.has("skill")) {
		const dependency = await put(["skill"]);
		assert.equal(dependency.status, 400);
		assert.match(((await dependency.json()) as { message: string }).message, /delegate 依赖 skill/);
		const together = await put(["skill", "delegate"]);
		assert.equal(together.status, 200, "一起关合法：这个人不派活");
		await put([]);
	}

	const saved = await put([candidate, candidate]);
	assert.equal(saved.status, 200);
	const savedBody = (await saved.json()) as {
		disabled: string[];
		tools: Array<{ name: string; enabled: boolean }>;
	};
	assert.deepEqual(savedBody.disabled, [candidate], "重复名去重");
	assert.equal(savedBody.tools.find((tool) => tool.name === candidate)?.enabled, false);
	assert.deepEqual(store.get(partner.id)?.disabledTools, [candidate]);
	assert.equal(store.get(partner.id)?.currentVersion, partner.currentVersion, "不 bump 身份版本");

	const cleared = await put([]);
	assert.equal(cleared.status, 200);
	assert.deepEqual(store.get(partner.id)?.disabledTools, [], "空数组 = 全开");
});

test("PUT /partners/:id/tools：常驻名单回读 / 非按需 400 / 不带 promoted 不清空 / tool_search 守卫（2026-11-17）", async () => {
	const partner = store.create("常驻名单执事");
	const path = `/api/v1/partners/${partner.id}/tools`;
	const view = (await (await app.request(path)).json()) as {
		tools: Array<{ name: string; deferred: boolean; promoted: boolean }>;
	};
	const deferred = view.tools.filter((tool) => tool.deferred).map((tool) => tool.name);
	if (deferred.length === 0) return; // 环境里没有按需工具就不测这条
	const name = deferred[0]!;

	const put = (body: unknown) =>
		app.request(path, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	// 提升：保存回读 + 视图逐项 promoted
	const promoted = await put({ disabled: [], promoted: [name] });
	assert.equal(promoted.status, 200);
	const promotedBody = (await promoted.json()) as {
		promoted: string[];
		tools: Array<{ name: string; promoted: boolean }>;
	};
	assert.deepEqual(promotedBody.promoted, [name]);
	assert.equal(promotedBody.tools.find((tool) => tool.name === name)?.promoted, true);
	assert.deepEqual(store.get(partner.id)?.promotedTools, [name]);

	// 旧形状（只有 disabled）：不改常驻名单
	const legacy = await put({ disabled: [] });
	assert.equal(legacy.status, 200);
	assert.deepEqual(store.get(partner.id)?.promotedTools, [name], "不带 promoted = 不动原名单");

	// 非按需工具不能提升
	const nonDeferred = view.tools.find((tool) => !tool.deferred)?.name;
	if (nonDeferred) {
		const bad = await put({ disabled: [], promoted: [nonDeferred] });
		assert.equal(bad.status, 400);
		assert.match(((await bad.json()) as { message: string }).message, /只能提升按需工具/);
	}

	// 未知工具 400
	const unknown = await put({ disabled: [], promoted: ["no_such_tool"] });
	assert.equal(unknown.status, 400);
	assert.match(((await unknown.json()) as { message: string }).message, /未知工具/);

	// 取消与提升冲突 400
	const conflict = await put({ disabled: [name], promoted: [name] });
	assert.equal(conflict.status, 400);
	assert.match(((await conflict.json()) as { message: string }).message, /不能设为常驻/);

	// tool_search 是唯一入口：取消它 400
	if (view.tools.some((tool) => tool.name === "tool_search")) {
		const guard = await put({ disabled: ["tool_search"] });
		assert.equal(guard.status, 400);
		assert.match(((await guard.json()) as { message: string }).message, /tool_search 是按需工具的唯一入口/);
	}

	// 收回：空数组 = 全部按需
	const cleared = await put({ disabled: [], promoted: [] });
	assert.equal(cleared.status, 200);
	assert.deepEqual(store.get(partner.id)?.promotedTools, []);
});

test("PARTNER_TOOLS_ENABLED=false：GET 200 空形状、PUT 400、未知执事仍 404", async () => {
	const partner = store.create("关工具勾选执事");
	const prev = process.env.PARTNER_TOOLS_ENABLED;
	process.env.PARTNER_TOOLS_ENABLED = "false";
	try {
		const res = await app.request(`/api/v1/partners/${partner.id}/tools`);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), {
			ok: true,
			enabled: false,
			disabled: [],
			promoted: [],
			groups: [],
			tools: [],
		});
		const put = await app.request(`/api/v1/partners/${partner.id}/tools`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ disabled: [] }),
		});
		assert.equal(put.status, 400);
		assert.match(((await put.json()) as { message: string }).message, /PARTNER_TOOLS_ENABLED/);
		const missing = await app.request("/api/v1/partners/no-such-id/tools", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ disabled: [] }),
		});
		assert.equal(missing.status, 404, "404 优先于开关关的 400");
	} finally {
		if (prev === undefined) delete process.env.PARTNER_TOOLS_ENABLED;
		else process.env.PARTNER_TOOLS_ENABLED = prev;
	}
});

// ── Worker 人设端点（2026-11-16，全局一份可编辑）──────────────────────
test("worker-persona: GET 默认 / PUT 保存 / 空串恢复 / 非字符串与超限 400 / 开关关 400", async () => {
  const get = () => workerApp.request("/api/v1/agent/worker-persona");
  const put = (body: unknown) =>
    workerApp.request("/api/v1/agent/worker-persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const r0 = await get();
  assert.equal(r0.status, 200);
  assert.equal(r0.headers.get("cache-control"), "no-store");
  const d0 = (await r0.json()) as Record<string, unknown>;
  assert.equal(d0.ok, true);
  assert.equal(d0.persona, workerPersonaDefault());
  assert.equal(d0.isDefault, true);
  assert.equal(d0.editable, true);
  assert.equal(d0.limit, WORKER_PERSONA_LIMIT);
  assert.equal(d0.chars, String(d0.persona).length);

  const r1 = await put({ persona: 123 });
  assert.equal(r1.status, 400);
  assert.equal(((await r1.json()) as { error: string }).error, "bad_request");

  const text = "你是普通助手，先干活再说话。";
  const r2 = await put({ persona: text });
  assert.equal(r2.status, 200);
  const d2 = (await r2.json()) as Record<string, unknown>;
  assert.equal(d2.persona, text);
  assert.equal(d2.isDefault, false);
  const d2again = (await (await get()).json()) as Record<string, unknown>;
  assert.equal(d2again.persona, text, "GET 读到刚存的值");

  const r3 = await put({ persona: "" });
  assert.equal(r3.status, 200);
  const d3 = (await r3.json()) as Record<string, unknown>;
  assert.equal(d3.persona, workerPersonaDefault(), "空串 = 恢复默认");
  assert.equal(d3.isDefault, true);

  const r4 = await put({ persona: "字".repeat(WORKER_PERSONA_LIMIT) });
  assert.equal(r4.status, 400, "超 8192 字节 → 400");

  const saved = process.env.WORKER_PERSONA_EDIT;
  process.env.WORKER_PERSONA_EDIT = "false";
  try {
    const r5 = await put({ persona: "试试" });
    assert.equal(r5.status, 400);
    assert.match(((await r5.json()) as { message: string }).message, /WORKER_PERSONA_EDIT=false/);
    const dg = (await (await get()).json()) as Record<string, unknown>;
    assert.equal(dg.editable, false);
  } finally {
    if (saved === undefined) delete process.env.WORKER_PERSONA_EDIT;
    else process.env.WORKER_PERSONA_EDIT = saved;
  }
});
