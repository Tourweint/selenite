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
import { toDisabledTools } from "./partner-rows.ts";
// 人格挂载的纯解析（2026-11-15 跟人走立项、同日多挂载方案扩化）：纯函数收 store，单测直接喂临时库。
import {
	composeProjectRecallScopes,
	isRecallableProjectId,
	personaProjectIdsOfSession,
	projectStateOf,
	recallableProjectIds,
	resolveProjectWriteTarget,
	setProjectStateResolver,
	type ProjectState,
} from "./agent/project-scope.ts";
import { CHIEF_PARTNER_ID } from "./partner-contract.ts";

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

test("执事：bumpSoul 只写盘 + 计数（快照退役），上一份进 SOUL.prev.md，候选链在 model-chain.json", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("阿岚");
		store.setModelChain(partner.id, [
			{ providerId: "p-a", modelId: "m-1", keyEnv: "KEY_A" },
		]);
		// setModelChain 自己占一个计数（2），bumpSoul 再占一个（3）
		const v3 = store.bumpSoul(partner.id, "你是阿岚，改过的身份。");
		assert.equal(v3, 3);
		// 上一份在 SOUL.prev.md（2026-11-15 快照退役：单槽，不攒历史）
		assert.equal(store.readHomeFile(partner.id, "SOUL.prev.md")?.includes("阿岚"), true);
		assert.equal(store.readSoulFromHome(partner.id)?.includes("改过"), true);
		// 候选链照常可读（model-chain.json）
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

test("执事：canonicalPartnerIdOfSession 只认 canonical 主会话（批 29 返工）", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("门面执事");
		// canonical：命中
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 7101,
		});
		assert.equal(store.canonicalPartnerIdOfSession(7101), partner.id);

		// 群成员 / 例行专线 / 课题专线：原函数认，canonical 版不认
		store.linkSession({
			partnerId: partner.id,
			role: "group",
			routeKey: "group:g1",
			sessionId: 7102,
		});
		store.linkSession({
			partnerId: partner.id,
			role: "routine",
			routeKey: "routine:fresh:t1",
			sessionId: 7103,
		});
		store.linkSession({
			partnerId: partner.id,
			role: "topic",
			routeKey: "topic:tp1",
			sessionId: 7104,
		});
		for (const sessionId of [7102, 7103, 7104]) {
			assert.equal(store.partnerIdOfSession(sessionId), partner.id, `${sessionId} 原函数仍认`);
			assert.equal(
				store.canonicalPartnerIdOfSession(sessionId),
				null,
				`${sessionId} 不是 canonical 主会话`,
			);
		}

		// delegation 占位行 session_id=0：两种查法都不命中
		store.linkDelegation(partner.id, "前端");
		assert.equal(store.canonicalPartnerIdOfSession(0), null, "占位行不算任何会话");
		assert.equal(store.partnerIdOfSession(0), null);
		// 没链接：null
		assert.equal(store.canonicalPartnerIdOfSession(7199), null);
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

test("例行条件：until / maxRuns 存取、可清除，老规则默认没有", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("条件执事");
		const plain = store.createRoutine({
			partnerId: partner.id,
			name: "老规则",
			prompt: "照旧跑",
			triggers: [{ type: "cron", expr: "0 9 * * *" }],
			sessionMode: "persistent",
			enabled: true,
		});
		assert.equal(plain.until, undefined);
		assert.equal(plain.maxRuns, undefined);

		const conditional = store.createRoutine({
			partnerId: partner.id,
			name: "有条件的规则",
			prompt: "整理到没有待办为止",
			triggers: [{ type: "interval", seconds: 600 }],
			sessionMode: "fresh",
			enabled: true,
			until: { note: "待办清零" },
			maxRuns: 5,
		});
		assert.deepEqual(conditional.until, { note: "待办清零" });
		assert.equal(conditional.maxRuns, 5);

		// 重开存储：值必须还在（落库而不是只在内存）
		store.close();
		const reopened = new PartnersStore(db, homes);
		try {
			const back = reopened.getRoutine(conditional.id);
			assert.deepEqual(back?.until, { note: "待办清零" });
			assert.equal(back?.maxRuns, 5);

			const cleared = reopened.updateRoutine(conditional.id, { until: null, maxRuns: null });
			assert.equal(cleared?.until, undefined, "null = 清掉完成条件");
			assert.equal(cleared?.maxRuns, undefined, "null = 取消次数上限");

			const restored = reopened.updateRoutine(conditional.id, {
				until: { note: "改过的条件" },
				maxRuns: 2,
			});
			assert.deepEqual(restored?.until, { note: "改过的条件" });
			assert.equal(restored?.maxRuns, 2);
			// 不传的字段保持原值（部分更新）
			const kept = reopened.updateRoutine(conditional.id, { enabled: false });
			assert.deepEqual(kept?.until, { note: "改过的条件" });
			assert.equal(kept?.maxRuns, 2);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

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

test("项目记忆挂载：设置多个 / 替换 / 清空（2026-11-15 多挂载方案）", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("小澄");
		assert.deepEqual(partner.projectIds, [], "新档案默认不挂");

		const attached = store.setProjectIds(partner.id, [
			"00000000-0000-4000-8000-000000000001",
			"00000000-0000-4000-8000-000000000002",
		]);
		assert.deepEqual(attached?.projectIds, [
			"00000000-0000-4000-8000-000000000001",
			"00000000-0000-4000-8000-000000000002",
		]);
		assert.deepEqual(store.get(partner.id)?.projectIds, [
			"00000000-0000-4000-8000-000000000001",
			"00000000-0000-4000-8000-000000000002",
		]);

		// 整体替换：数组是全集，不是增量
		const replaced = store.setProjectIds(partner.id, ["00000000-0000-4000-8000-000000000003"]);
		assert.deepEqual(replaced?.projectIds, ["00000000-0000-4000-8000-000000000003"]);

		const cleared = store.setProjectIds(partner.id, []);
		assert.deepEqual(cleared?.projectIds, [], "空数组 = 清空");

		assert.equal(store.setProjectIds("no-such-partner", ["00000000-0000-4000-8000-000000000004"]), null,
			"档案不存在返回 null（端点层先 404，这里只是兜底）");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目记忆挂载：detachProject 批量解除（2026-11-15 删除项目登记的连带）", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const project = "00000000-0000-4000-8000-0000000000f1";
		const other = "00000000-0000-4000-8000-0000000000f2";
		const a = store.create("小澄");
		const b = store.create("阿蓝");
		const c = store.create("未挂的");
		// a 同时挂两个：detach 只摘指向被删项目的那一个
		store.setProjectIds(a.id, [project, other]);
		store.setProjectIds(b.id, [other]);
		// 总管也挂同一个项目：detach 不挑身份，全摘
		store.ensureChief("总管");
		const chief = store.get(CHIEF_PARTNER_ID);
		assert.ok(chief);
		store.setProjectIds(CHIEF_PARTNER_ID, [project]);
		store.setProjectIds(c.id, []);

		assert.equal(store.detachProject(project), 2, "只清指向该项目的，含总管");
		assert.deepEqual(store.get(a.id)?.projectIds, [other], "只摘那一个，别的保留");
		assert.deepEqual(store.get(CHIEF_PARTNER_ID)?.projectIds, []);
		assert.deepEqual(store.get(b.id)?.projectIds, [other], "挂别的项目的不动");
		assert.deepEqual(store.get(c.id)?.projectIds, []);

		assert.equal(store.detachProject(project), 0, "再解一次 = 0 条（幂等）");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目记忆挂载：旧库（没有 project_ids 列）自动补列；单值列旧数据搬进数组", () => {
	const { root, db, homes } = tempRoot();
	// 先造一张多挂载之前的老库：有单值列 project_id、没有 project_ids
	const raw = new DatabaseSync(db);
	raw.exec(`
			CREATE TABLE IF NOT EXISTS partners (
				id              TEXT PRIMARY KEY,
				name            TEXT NOT NULL,
				status          TEXT NOT NULL DEFAULT 'active',
				current_version INTEGER,
				created_at      TEXT NOT NULL,
				updated_at      TEXT NOT NULL
			);
			ALTER TABLE partners ADD COLUMN project_id TEXT;
	`);
	const at = new Date().toISOString();
	raw.prepare(
		"INSERT INTO partners (id, name, status, created_at, updated_at, project_id) VALUES (?, ?, 'active', ?, ?, ?)",
	).run("legacy-1", "老执事", at, at, "00000000-0000-4000-8000-0000000000e1");
	raw.prepare(
		"INSERT INTO partners (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
	).run("legacy-2", "没挂的老执事", at, at);
	raw.close();

	const store = new PartnersStore(db, homes);
	try {
		const mounted = store.get("legacy-1");
		assert.ok(mounted, "老记录读得出来");
		assert.deepEqual(mounted.projectIds, ["00000000-0000-4000-8000-0000000000e1"],
			"单值旧数据搬进数组");
		const bare = store.get("legacy-2");
		assert.ok(bare);
		assert.deepEqual(bare.projectIds, [], "没挂的老记录 = 空数组");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目记忆写入解析：指名 → 绑定 → 唯一挂载 → 报错引导（2026-11-15 多挂载）", () => {
	const atlas = { id: "00000000-0000-4000-8000-0000000000a1", name: "atlas" };
	const harness = { id: "00000000-0000-4000-8000-0000000000a2", name: "lifediary-harness" };

	// 指名命中：精确（含忽略大小写）→ 直落
	assert.deepEqual(
		resolveProjectWriteTarget("atlas", null, [atlas, harness]),
		{ ok: true, projectId: atlas.id },
	);
	assert.deepEqual(
		resolveProjectWriteTarget("ATLAS", null, [atlas, harness]),
		{ ok: true, projectId: atlas.id },
		"忽略大小写唯一命中也算",
	);
	// 指名优先于绑定：显式说了写哪个就写哪个
	assert.deepEqual(
		resolveProjectWriteTarget("atlas", harness.id, [atlas, harness]),
		{ ok: true, projectId: atlas.id },
		"指名优先于会话绑定",
	);
	// 指名不在负责清单 → 报错带清单
	const notMounted = resolveProjectWriteTarget("别的项目", harness.id, [harness]);
	assert.ok(!notMounted.ok, "指名不在负责清单 → 拒绝");
	if (!notMounted.ok) {
		assert.equal(notMounted.code, "project_not_mounted");
		assert.ok(notMounted.message.includes("lifediary-harness"), "报错列出负责清单");
	}

	// 不指名：绑定优先（此刻就在这个项目里干活）
	assert.deepEqual(
		resolveProjectWriteTarget(undefined, harness.id, [atlas, harness]),
		{ ok: true, projectId: harness.id },
	);
	// 不指名 + 无绑定 + 唯一挂载 → 自动落（单挂载免指名）
	assert.deepEqual(
		resolveProjectWriteTarget(undefined, null, [atlas]),
		{ ok: true, projectId: atlas.id },
	);
	// 不指名 + 无绑定 + 多挂载 → 引导指名，报错列清单
	const ambiguous = resolveProjectWriteTarget(undefined, null, [atlas, harness]);
	assert.ok(!ambiguous.ok, "多挂载不指名 → 引导指名");
	if (!ambiguous.ok) {
		assert.equal(ambiguous.code, "project_ambiguous");
		assert.ok(ambiguous.message.includes("atlas"), "报错列出全部负责项目");
	}
	// 不指名 + 无绑定 + 零挂载 → 引导去挂载
	const none = resolveProjectWriteTarget(undefined, null, []);
	assert.ok(!none.ok, "零挂载 → 引导去挂载");
	if (!none.ok) assert.equal(none.code, "no_project_scope");
	// 名字两侧空白：trim 后再比
	assert.deepEqual(
		resolveProjectWriteTarget(" atlas ", null, [atlas]),
		{ ok: true, projectId: atlas.id },
		"指名两侧空白剥掉再匹配",
	);
});

test("每轮注入的项目 scope 组装：绑定全权、其余挂载走闸门、重叠去重", () => {
	const a = "00000000-0000-4000-8000-0000000000b1";
	const b = "00000000-0000-4000-8000-0000000000b2";

	// 绑定 + 两个挂载（其一就是绑定）：绑定不重复、其余进 gated
	const both = composeProjectRecallScopes(a, [a, b], true);
	assert.deepEqual(both.fullKeys, [], "绑定进 scopes 主列，compose 不再返回它");
	assert.deepEqual(both.gatedKeys, [`project:${b}`], "其余挂载进 gated，且与绑定去重");

	// 闸门关（PROJECT_MEMORY_GATE=false）：挂载并回全权池 = 跟人走当日形态
	// （绑定的 key 由 recallContext 主列另带，compose 只管挂载部分、与绑定去重）
	const gateOff = composeProjectRecallScopes(a, [a, b], false);
	assert.deepEqual(gateOff.fullKeys, [`project:${b}`], "闸门关 = 其余挂载全权进池（绑定主列另带）");
	assert.deepEqual(gateOff.gatedKeys, []);

	// 无绑定：挂载全走 gated
	const unbound = composeProjectRecallScopes(null, [a, b], true);
	assert.deepEqual(unbound.gatedKeys, [`project:${a}`, `project:${b}`]);
	// 重复挂载 id：去重
	const duped = composeProjectRecallScopes(null, [a, a], true);
	assert.deepEqual(duped.gatedKeys, [`project:${a}`]);
	// 零挂载：两边都空
	const empty = composeProjectRecallScopes(a, [], true);
	assert.deepEqual(empty.fullKeys, []);
	assert.deepEqual(empty.gatedKeys, []);
});

test("归档 / 删除的项目退出召回库：状态解析、id 过滤、降级口径", () => {
	const live = "00000000-0000-4000-8000-0000000000c1";
	const archived = "00000000-0000-4000-8000-0000000000c2";
	const deleted = "00000000-0000-4000-8000-0000000000c3";
	const states = new Map<string, ProjectState>([
		[live, "active"],
		[archived, "archived"],
		[deleted, "missing"],
	]);

	// 未接线 = 旧行为：一律按 active（记忆不能因为一次辅助读取失败就不召回）
	assert.equal(projectStateOf(archived), "active");
	assert.equal(isRecallableProjectId(archived), true);
	const previousFlag = process.env.PROJECT_MEMORY_ACTIVE_ONLY;
	process.env.PROJECT_MEMORY_ACTIVE_ONLY = "true";
	try {
		setProjectStateResolver((id) => states.get(id) ?? "active");
		assert.equal(projectStateOf(live), "active");
		assert.equal(projectStateOf(archived), "archived");
		assert.equal(projectStateOf(deleted), "missing");
		// 绑定与挂载共用同一判据：只有活着（登记存在且未归档）的项目进召回池
		assert.deepEqual(recallableProjectIds([live, archived, deleted]), [live]);
		assert.equal(isRecallableProjectId(archived), false);
		assert.equal(isRecallableProjectId(deleted), false);
		// 回滚开关：PROJECT_MEMORY_ACTIVE_ONLY=false = 旧形态，归档项目照旧召回
		process.env.PROJECT_MEMORY_ACTIVE_ONLY = "false";
		assert.equal(isRecallableProjectId(archived), true);
		assert.deepEqual(recallableProjectIds([live, archived, deleted]), [live, archived, deleted]);
		process.env.PROJECT_MEMORY_ACTIVE_ONLY = "true";
		// 解析器抛错同样退回 active，不把对话卡住
		setProjectStateResolver(() => {
			throw new Error("boom");
		});
		assert.equal(projectStateOf(archived), "active");
	} finally {
		setProjectStateResolver(null);
		if (previousFlag === undefined) delete process.env.PROJECT_MEMORY_ACTIVE_ONLY;
		else process.env.PROJECT_MEMORY_ACTIVE_ONLY = previousFlag;
	}
});

test("人格挂载解析：链接执事吃自己的挂载（数组），总管主对话吃总管的，worker 谁的都不吃", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("负责项目的执事");
		store.setProjectIds(partner.id, ["00000000-0000-4000-8000-00000000000a"]);
		store.ensureChief("总管");
		store.setProjectIds(CHIEF_PARTNER_ID, [
			"00000000-0000-4000-8000-00000000000b",
			"00000000-0000-4000-8000-00000000000c",
		]);

		// 执事专线：吃执事自己的挂载
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 9001,
		});
		assert.deepEqual(personaProjectIdsOfSession(store, 9001, "chief"),
			["00000000-0000-4000-8000-00000000000a"]);

		// 总管主对话（未链接 + kind=chief）：吃总管的挂载（多个全给）
		assert.deepEqual(personaProjectIdsOfSession(store, 9002, "chief"), [
			"00000000-0000-4000-8000-00000000000b",
			"00000000-0000-4000-8000-00000000000c",
		]);

		// worker（干活会话）：跟文件夹走，谁的挂载都不吃
		assert.deepEqual(personaProjectIdsOfSession(store, 9003, "worker"), []);
		// kind 判不出来（缓存未接线）：保守不当 chief
		assert.deepEqual(personaProjectIdsOfSession(store, 9002, null), []);

		// 执事没挂 → 空数组（不吃总管的）
		const bare = store.create("没挂的执事");
		store.linkSession({
			partnerId: bare.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 9004,
		});
		assert.deepEqual(personaProjectIdsOfSession(store, 9004, "chief"), []);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("执事：setDisabledTools 往返 + 坏 JSON 当空 + 不 bump 身份版本（2026-11-16 工具裁剪 B）", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("工具勾选测试");
		assert.equal(partner.currentVersion, 1);
		assert.deepEqual(partner.disabledTools, [], "新档案默认全开");

		const updated = store.setDisabledTools(partner.id, ["write", "delegate"]);
		assert.ok(updated);
		assert.deepEqual(updated.disabledTools, ["write", "delegate"]);
		assert.equal(updated.currentVersion, 1, "只写取消名单，不 bump 身份版本");
		assert.deepEqual(store.get(partner.id)?.disabledTools, ["write", "delegate"]);

		// 清空 = 全开；仍不 bump 版本（同一行只动两列）
		const cleared = store.setDisabledTools(partner.id, []);
		assert.deepEqual(cleared?.disabledTools, []);
		assert.equal(cleared?.currentVersion, 1);

		assert.equal(store.setDisabledTools("不存在的执事", ["read"]), null);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("toDisabledTools：坏 JSON / 非数组 / 非字符串项当空数组（2026-11-16 工具裁剪 B）", () => {
	for (const dirty of [null, undefined, "", "not-json", "{}", "null", "[1,2]", "[1]"]) {
		assert.deepEqual(toDisabledTools(dirty), [], `脏值 ${String(dirty)} 当空`);
	}
	assert.deepEqual(toDisabledTools('["read","write"]'), ["read", "write"]);
	assert.deepEqual(toDisabledTools('["", "read"]'), ["read"], "空串项滤掉");
	assert.deepEqual(toDisabledTools('["read", 3]'), ["read"], "非字符串项滤掉（同 toProjectIds）");
});
