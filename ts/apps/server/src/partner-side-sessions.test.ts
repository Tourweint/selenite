/**
 * 一人多会话批1（2026-11-17）链接存储与索引字段单测。
 * 自己造临时库 / 临时家目录，测完清理；不碰真实 `.data`。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PartnersStore } from "./partner-store.ts";

const root = mkdtempSync(join(tmpdir(), "lifediary-side-sessions-"));
after(() => {
	// Windows 上 sqlite 句柄可能晚一拍才放，清理失败不让整个测试文件红。
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		/* 临时目录清不掉不影响断言 */
	}
});

test("side 链接登记 + linkOfSession / sideLinksOf / sessionLinksMap；sessionIdOfPartner 仍只认 canonical", () => {
	const store = new PartnersStore(join(root, "links.sqlite"), join(root, "homes"));
	try {
		const partner = store.create("diary");
		const sideExternalId = "partner-diary-side-1a2b3c4d";
		store.linkSession({
			partnerId: partner.id,
			role: "side",
			routeKey: sideExternalId,
			sessionId: 42,
		});
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 7,
		});

		const sides = store.sideLinksOf(partner.id);
		assert.equal(sides.length, 1);
		assert.equal(sides[0].role, "side");
		assert.equal(sides[0].routeKey, sideExternalId);
		assert.equal(sides[0].sessionId, 42);
		assert.deepEqual(store.sideLinksOf("nobody"), []);

		const viaSession = store.linkOfSession(42);
		assert.equal(viaSession?.partnerId, partner.id);
		assert.equal(viaSession?.role, "side");
		assert.equal(viaSession?.routeKey, sideExternalId);
		assert.equal(store.linkOfSession(999), null);

		const map = store.sessionLinksMap();
		assert.deepEqual(map.get(42), {
			partnerId: partner.id,
			role: "side",
			routeKey: sideExternalId,
		});
		assert.equal(map.get(7)?.role, "canonical");

		// 反向助手只认 canonical：副会话不能被当成主会话
		assert.equal(store.sessionIdOfPartner(partner.id), 7);
		assert.equal(store.canonicalPartnerIdOfSession(42), null);
	} finally {
		store.close();
	}
});

test("ChatIndexEntry 增量字段：有链接带 partnerId / sessionRole / isCanonical，无链接不带", async () => {
	// env 必须在动态 import 之前设好：partnersStore 是懒单例，读了才会指向临时库
	process.env.PARTNERS_DB_PATH = join(root, "index.sqlite");
	process.env.PARTNER_HOMES_ROOT = join(root, "index-homes");
	const { partnersStore } = await import("./partner-rows.ts");
	const { chatEntryOf } = await import("./agent/session-index.ts");
	const { readChatMeta } = await import("./agent/session-meta.ts");
	try {
		const meta = readChatMeta();
		const stats = { firstText: "今天怎么样", turns: 3, createdAt: 100, lastAt: 200 };
		const withLink = chatEntryOf("partner-x-side-1a2b3c4d", 42, stats, meta, {}, {
			partnerId: "x",
			role: "side",
			routeKey: "partner-x-side-1a2b3c4d",
		});
		assert.equal(withLink.partnerId, "x");
		assert.equal(withLink.sessionRole, "side");
		assert.equal(withLink.isCanonical, false);

		const canonical = chatEntryOf("partner-x", 7, stats, meta, {}, {
			partnerId: "x",
			role: "canonical",
			routeKey: "canonical",
		});
		assert.equal(canonical.isCanonical, true);

		const plain = chatEntryOf("worker-123", 9, stats, meta, { "9": "worker" });
		assert.equal(plain.partnerId, undefined);
		assert.equal(plain.sessionRole, undefined);
		assert.equal(plain.isCanonical, undefined);
	} finally {
		partnersStore().close();
	}
});
