import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

const { Hono } = await import("hono");
const { mountCompanions } = await import("./companion-api.ts");
const { PARTNER_SLOT_LIMIT, partnersStore } = await import("./partners.ts");

const store = partnersStore();
const app = new Hono();
mountCompanions(app);

after(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
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
		soulVersion: store.currentVersion(id)?.version ?? null,
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
