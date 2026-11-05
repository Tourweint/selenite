import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PARTNER_SLOT_LIMIT, PartnersStore } from "./partners.ts";

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
