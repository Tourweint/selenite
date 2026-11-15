import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
	DOMAIN_PATTERN,
	archiveManager,
	ensureManager,
	listManagers,
} from "../../../../../chancellor/src/manager/registry.ts";
import type {
	ChancellorEvent,
	ChancellorRequest,
	TicketResult,
} from "../../../../../chancellor/src/index.ts";
import {
	buildManagerIdentity,
	MANAGER_SOUL_LIMIT_BYTES,
	startDelegation,
} from "./delegation.ts";
import {
	delegationSoulSeed,
	partnerIdentityForDomain,
	PartnersStore,
} from "./partners.ts";

function tempRoot(): { db: string; homes: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "lifediary-d2-"));
	return {
		db: join(root, "partners.sqlite"),
		homes: join(root, "homes"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("domain 校验：与 chancellor DOMAIN_PATTERN 同口径（小写 ASCII）", () => {
	for (const good of ["finance", "desktop-shell", "a1", "a-b-c"]) {
		assert.equal(DOMAIN_PATTERN.test(good), true, `${good} 应合法`);
	}
	for (const bad of ["前端", "UPPER", "-bad", "bad-", "a_b", "a b", ""]) {
		assert.equal(DOMAIN_PATTERN.test(bad), false, `${bad} 应非法`);
	}
});

test("执事：create 带 domain → 反查命中；普通执事无 domain；旧领域查不到", () => {
	const { db, homes, cleanup } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const plain = store.create("小澈");
		const hand = store.create("阿岚", {
			domain: "desktop-shell",
			soulSeed: delegationSoulSeed("阿岚", "desktop-shell"),
		});
		assert.equal(plain.domain, null, "普通执事 domain 为 null（行为不变）");
		assert.equal(hand.domain, "desktop-shell");
		assert.match(store.readSoulFromHome(hand.id) ?? "", /你是阿岚，desktop-shell 领域的负责人/);
		assert.equal(store.partnerIdByDomain("desktop-shell"), hand.id);
		assert.equal(store.partnerIdByDomain("never-existed"), null, "旧领域查不到（兼容）");

		const link = store.findSessionLink(hand.id, "delegation", "desktop-shell");
		assert.ok(link, "delegation 链接已登记");
		assert.equal(link.role, "delegation");
		assert.equal(link.routeKey, "desktop-shell");
		assert.equal(store.partnerIdOfSession(0), null, "占位 session_id=0 不能被当成真实会话");
	} finally {
		store.close();
		cleanup();
	}
});

test("旧库补列：partners 表缺 domain 时自动 ALTER TABLE，老行按 null 读", () => {
	const { db, homes, cleanup } = tempRoot();
	const legacy = new DatabaseSync(db);
	legacy.exec(
		"CREATE TABLE partners (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', current_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
	);
	legacy.exec(
		"INSERT INTO partners (id, name, status, current_version, created_at, updated_at) VALUES ('old-1', '老执事', 'active', NULL, '2026-01-01', '2026-01-01')",
	);
	legacy.close();

	const store = new PartnersStore(db, homes);
	try {
		const old = store.get("old-1");
		assert.ok(old);
		assert.equal(old.domain, null, "老行补不上信息，按 null 读");
		const fresh = store.create("新执事", { domain: "finance", soulSeed: "一句话 SOUL。" });
		assert.equal(fresh.domain, "finance");
		assert.equal(store.partnerIdByDomain("finance"), fresh.id);
	} finally {
		store.close();
		cleanup();
	}
});

test("身份注入查询：soul 读磁盘当前值（2026-11-15 快照退役），未命中领域返回 null", () => {
	const { db, homes, cleanup } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const hand = store.create("阿岚", {
			domain: "finance",
			soulSeed: "v1 快照正文。",
		});
		// 直接改磁盘 SOUL.md，不走 bumpSoul——磁盘是当前值唯一事实源（手改下一轮生效，
		// 与详情端点 / 导出 / 问候生成同一口径；原批次D 的「快照优先」随版本表一起退役）。
		store.atomicWrite(join(store.homeOf(hand.id), "SOUL.md"), "磁盘手改正文。");
		const hit = partnerIdentityForDomain(store, "finance");
		assert.ok(hit);
		assert.equal(hit.name, "阿岚");
		assert.equal(hit.soul, "磁盘手改正文。", "磁盘是当前值唯一事实源");
		assert.equal(partnerIdentityForDomain(store, "no-such-domain"), null);
	} finally {
		store.close();
		cleanup();
	}
});

test("buildManagerIdentity：命中组装 / 未命中 undefined / soul 按字节截 ≤4KB 不切坏中文", () => {
	assert.deepEqual(buildManagerIdentity({ name: "阿岚", soul: "正文" }), {
		name: "阿岚",
		soul: "正文",
	});
	assert.equal(buildManagerIdentity(null), undefined);
	assert.equal(buildManagerIdentity(undefined), undefined);

	const long = "界".repeat(3000); // 9000 bytes，远超 4KB
	const built = buildManagerIdentity({ name: "阿岚", soul: long });
	assert.ok(built);
	assert.ok(Buffer.byteLength(built.soul, "utf8") <= MANAGER_SOUL_LIMIT_BYTES);
	assert.equal(built.soul.includes("\uFFFD"), false, "截断不产生替换字符 U+FFFD");
	assert.ok(built.soul.endsWith("界"), "每个中文都是完整字符，没有半个字");
});

test("startDelegation：命中带 managerIdentity，未命中 / 无 seam / 无 domain 都不带", async () => {
	const finish: Promise<TicketResult> = Promise.resolve({
		ticketId: "T-1",
		status: "done",
		line: "ok",
		tasks: [],
	});
	let seen: ChancellorRequest | undefined;
	const runtime = {
		run: (request: ChancellorRequest, options: { onEvent?: (e: ChancellorEvent) => void }) => {
			seen = request;
			options.onEvent?.({ type: "ticket", ticketId: "T-1", message: "已受理" });
			return finish;
		},
		emit: () => undefined,
		autoReport: false,
	};

	const hit = startDelegation(
		{ conversationId: 1, domain: "finance", requirement: "做账" },
		{ ...runtime, identityHitFor: () => ({ name: "阿岚", soul: "你是阿岚，finance 负责人。" }) },
	);
	assert.equal(hit.ticketId, "T-1");
	assert.equal(seen?.domain, "finance");
	assert.deepEqual(seen?.managerIdentity, {
		name: "阿岚",
		soul: "你是阿岚，finance 负责人。",
	});
	await hit.outcome;

	const miss = startDelegation(
		{ conversationId: 2, domain: "legacy", requirement: "旧活" },
		{ ...runtime, identityHitFor: () => null },
	);
	assert.equal(seen?.managerIdentity, undefined, "查不到执事照旧，兼容旧领域");
	await miss.outcome;

	const remote = startDelegation(
		{ conversationId: 3, domain: "finance", requirement: "远程锚点" },
		runtime,
	);
	assert.equal(seen?.managerIdentity, undefined, "不装配缝（远程路径）不注入身份");
	await remote.outcome;

	const noDomain = startDelegation(
		{ conversationId: 4, domain: "", requirement: "直派 worker" },
		{ ...runtime, identityHitFor: () => ({ name: "x", soul: "y" }) },
	);
	assert.equal(seen?.managerIdentity, undefined);
	assert.equal(seen?.domain, undefined);
	await noDomain.outcome;
});

test("archive 幂等：目录改名 .archived-、listManagers 不列出、二次返回 null", () => {
	const root = mkdtempSync(join(tmpdir(), "lifediary-d2-mgr-"));
	const workRoot = join(root, "runs");
	try {
		const info = ensureManager(workRoot, "finance", { partnerId: "p-1" });
		assert.equal(info.partner_id, "p-1");
		assert.equal(listManagers(workRoot).some((e) => e.domain === "finance"), true);

		const archived = archiveManager(workRoot, "finance");
		assert.ok(archived && archived.includes(".archived-finance-"));
		assert.ok(existsSync(archived));
		assert.equal(existsSync(info.root), false, "原目录被改名，不是复制");
		assert.equal(
			listManagers(workRoot).some((e) => e.domain === "finance"),
			false,
			"归档后不再作为可用领域列出",
		);
		assert.equal(archiveManager(workRoot, "finance"), null, "二次归档幂等");
		assert.equal(archiveManager(workRoot, "never-existed"), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
