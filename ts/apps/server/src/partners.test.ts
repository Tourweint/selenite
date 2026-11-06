import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
	PartnerAvatarPatchSchema,
	partnerAvatarProblem,
	PARTNER_AVATAR_MAX_BYTES,
} from "@lifediary/shared";
import { PARTNER_SLOT_LIMIT, PartnersStore } from "./partners.ts";

/** 一张真实的 1×1 PNG（透明像素）：校验会走签名 / IHDR / 尺寸 / IEND 全链 */
const VALID_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * 造一张「块结构合法、只有尺寸不对」的 PNG：用于尺寸校验（不依赖外部图片）。
 * IHDR 的 CRC 必须算对——否则会先被 CRC 校验拦下，测不到尺寸分支。
 */
function fakePng(width: number, height: number): string {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0);
	ihdr.write("IHDR", 4, "ascii");
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	ihdr[16] = 8; // bit depth
	ihdr[17] = 6; // RGBA
	ihdr.writeUInt32BE(crc32(ihdr.subarray(4, 21)), 21);
	const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
	return `data:image/png;base64,${Buffer.concat([signature, ihdr, iend]).toString("base64")}`;
}

function tempRoot(): { root: string; db: string; homes: string } {
	const root = mkdtempSync(join(tmpdir(), "lifediary-partners-"));
	return { root, db: join(root, "partners.sqlite"), homes: join(root, "homes") };
}

test("执事：创建即建家 + 首个身份版本；SOUL 播种最后写（家建好的标志）", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("小澈");
		assert.ok(partner.id.length > 0);
		assert.equal(partner.currentVersion, 1);

		const home = store.homeOf(partner.id);
		assert.ok(existsSync(join(home, "SOUL.md")), "SOUL.md 必须存在（播种最后写）");
		assert.ok(existsSync(join(home, "memories", "USER.md")));
		assert.ok(existsSync(store.workspaceOf(partner.id)));
		assert.ok(existsSync(store.skillsDirOf(partner.id)));
		assert.match(store.readSoulFromHome(partner.id) ?? "", /小澈/);

		// 再播种一次不覆盖已有内容（幂等）
		store.atomicWrite(join(home, "memories", "USER.md"), "用户改过的画像");
		store.ensureHome(partner.id, "小澈");
		assert.equal(store.readUserMd(partner.id), "用户改过的画像");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("执事：bumpSoul 落新版本快照（旧版本保留），能力随版本延续", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("阿岚");
		store.setModelChain(partner.id, [
			{ providerId: "p-a", modelId: "m-1", keyEnv: "KEY_A" },
		]);
		// setModelChain 自己占一个版本（v2），bumpSoul 再占一个（v3）
		const v3 = store.bumpSoul(partner.id, "你是阿岚，改过的身份。");
		assert.equal(v3, 3);
		// 旧版本快照还在（演化链可追溯）
		assert.equal(store.getVersion(partner.id, 1)?.soulSource.includes("阿岚"), true);
		assert.equal(store.getVersion(partner.id, 3)?.soulSource.includes("改过"), true);
		// 候选链没被 SOUL 更新冲掉
		assert.equal(store.getModelChain(partner.id).length, 1);
		assert.equal(store.getModelChain(partner.id)[0]?.keyEnv, "KEY_A");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("执事：64KB 槽位护栏 + 原子写不留临时文件", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("墨墨");
		const soulPath = join(store.homeOf(partner.id), "SOUL.md");
		assert.throws(
			() => store.atomicWrite(soulPath, "x".repeat(PARTNER_SLOT_LIMIT + 1)),
			/64 \* 1024|上限/,
			"超上限必须拒写",
		);
		store.atomicWrite(soulPath, "新的身份正文");
		assert.equal(store.readSoulFromHome(partner.id), "新的身份正文");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("执事：会话链接与反向查询（scopeOf 的数据源）", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("南南");
		assert.equal(store.partnerIdOfSession(4242), null, "没链接的会话不属于任何执事");
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 4242,
		});
		assert.equal(store.partnerIdOfSession(4242), partner.id);
		// 重复登记幂等（UNIQUE 约束 + INSERT OR IGNORE）
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 4242,
		});
		// 身份版本记账：下一轮生效契约的判定位
		assert.equal(store.appliedVersionOf(partner.id, 4242), null);
		store.setAppliedVersion(partner.id, 4242, 3);
		assert.equal(store.appliedVersionOf(partner.id, 4242), 3);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("执事：删除连家目录一起清；例行任务 revision 自增", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("青青");
		const home = store.homeOf(partner.id);
		assert.ok(existsSync(home));

		const routine = store.createRoutine({
			partnerId: partner.id,
			name: "晚间整理",
			prompt: "整理今天的记录",
			triggers: [{ type: "cron", expr: "30 21 * * *" }],
			sessionMode: "persistent",
			enabled: true,
		});
		const updated = store.updateRoutine(routine.id, { prompt: "整理并汇总" });
		assert.equal(updated?.revision, 2, "改动必须 revision+1（在飞任务据此作废）");
		assert.equal(store.listRoutines(partner.id).length, 1);

		assert.equal(store.delete(partner.id), true);
		assert.equal(existsSync(home), false, "家目录必须一起删");
		assert.equal(store.listRoutines(partner.id).length, 0);
		assert.equal(store.delete(partner.id), false, "重复删除幂等返回 false");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

// ── 头像（2026-11-06 侧栏调整 B1）───────────────────────────

test("头像：保存 / 清除 / 重开存储仍在，旧记录读 null", () => {
	const { root, db, homes } = tempRoot();
	const first = new PartnersStore(db, homes);
	const partner = first.create("头像执事");
	try {
		assert.equal(partner.avatar, null, "新建默认无头像 → 前端首字兜底");

		const saved = first.setAvatar(partner.id, VALID_PNG);
		assert.equal(saved?.avatar, VALID_PNG);
		assert.equal(first.get(partner.id)?.avatar, VALID_PNG);
	} finally {
		first.close();
	}

	const reopened = new PartnersStore(db, homes);
	try {
		assert.equal(reopened.get(partner.id)?.avatar, VALID_PNG, "重开存储必须保留头像");

		const cleared = reopened.setAvatar(partner.id, null);
		assert.equal(cleared?.avatar, null, "null = 清除");
		assert.equal(reopened.setAvatar("不存在", VALID_PNG), null);
	} finally {
		reopened.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("头像：旧库（没有 avatar 列）自动补列，旧记录读 null", () => {
	const { root, db, homes } = tempRoot();
	// 手工造一张改动前的 partners 表（只有老列），模拟真实旧库
	const raw = new DatabaseSync(db);
	raw.exec(`
		CREATE TABLE partners (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			current_version INTEGER,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			domain TEXT
		);
	`);
	raw.prepare(
		"INSERT INTO partners (id, name, status, current_version, created_at, updated_at, domain) VALUES (?, ?, 'active', 1, ?, ?, NULL)",
	).run("old-partner", "旧执事", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
	raw.close();

	const store = new PartnersStore(db, homes);
	try {
		const row = store.get("old-partner");
		assert.ok(row, "旧记录必须还能读");
		assert.equal(row?.avatar, null);
		assert.equal(store.setAvatar("old-partner", VALID_PNG)?.avatar, VALID_PNG);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("头像契约：只收有界 PNG；JPEG / 外链 / SVG / 坏 base64 / 超限 / 截断 / 超大尺寸一律拒", () => {
	assert.equal(partnerAvatarProblem(VALID_PNG), null, "合法 1×1 PNG 必须通过");
	assert.equal(PartnerAvatarPatchSchema.safeParse(VALID_PNG).success, true);
	assert.equal(PartnerAvatarPatchSchema.safeParse(null).success, true, "null = 清除，合法");

	const rejected: Array<[string, string]> = [
		["data:image/jpeg;base64,/9j/4AAQ", "只收 PNG"],
		["https://example.com/a.png", "不收外部 URL"],
		["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "不收 SVG（可执行内容）"],
		["data:image/png;base64,不是base64", "base64 非法字符"],
		["data:image/png;base64,AAAA", "长度/内容不构成 PNG"],
		[VALID_PNG.slice(0, -16), "截断的 PNG"],
		[fakePng(300, 16), "尺寸超过 256"],
		[fakePng(0, 16), "尺寸为 0"],
	];
	for (const [value, why] of rejected) {
		assert.notEqual(partnerAvatarProblem(value), null, `应拒绝：${why}`);
		assert.equal(PartnerAvatarPatchSchema.safeParse(value).success, false, `schema 应拒绝：${why}`);
	}
	// 尺寸用例必须真的走到尺寸分支（CRC 已算对，不会先被其它校验拦掉）
	assert.match(partnerAvatarProblem(fakePng(300, 16)) ?? "", /尺寸/);
	assert.match(partnerAvatarProblem(fakePng(0, 16)) ?? "", /尺寸/);

	// 解码后超 128KiB（但字符串仍在 180000 字符内）
	const oversizedBytes = `data:image/png;base64,${"A".repeat(174_800)}`;
	assert.ok((174_800 / 4) * 3 > PARTNER_AVATAR_MAX_BYTES);
	assert.ok(oversizedBytes.length < 180_000, "这条用例必须落在字符上限内，才测得到字节上限");
	assert.match(partnerAvatarProblem(oversizedBytes) ?? "", /KiB/);
	// 字符串本身超 180000 字符
	const oversizedChars = `data:image/png;base64,${"A".repeat(180_001)}`;
	assert.match(partnerAvatarProblem(oversizedChars) ?? "", /字符上限/);
});
