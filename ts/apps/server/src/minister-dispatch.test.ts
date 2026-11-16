import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setMinisterDispatchAuthority } from "./partner-manage.ts";
import {
	ministerDispatchAllowed,
	ministerDispatchMasterEnabled,
	PartnersStore,
} from "./partners.ts";

/**
 * 执事派发权开关单测（2026-11-06，方案：设计方案/2026-11-06-执事派发权开关*.md）。
 *
 * 覆盖方案验证表：默认关、开/关切换、无 domain 拒切、重启持久、
 * 闸门纯函数（总闸 / 每执事 / 查无执事）。端点映射在 companion-api，
 * 工具包装在 tools.ts，核心都在这里验证。
 */

function tempStore() {
	const root = mkdtempSync(join(tmpdir(), "lifediary-dispatch-"));
	const db = join(root, "partners.sqlite");
	const homes = join(root, "homes");
	const store = new PartnersStore(db, homes);
	return {
		store,
		root,
		db,
		homes,
		cleanup: () => {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("新建执事派发权默认关；普通执事也是 false", () => {
	const ctx = tempStore();
	try {
		const minister = ctx.store.create("小明", { domain: "frontend" });
		assert.equal(minister.dispatchAuthority, false);
		const plain = ctx.store.create("普通人");
		assert.equal(plain.dispatchAuthority, false);
	} finally {
		ctx.cleanup();
	}
});

test("setDispatchAuthority 开/关往返，get 读回一致", () => {
	const ctx = tempStore();
	try {
		const minister = ctx.store.create("小明", { domain: "frontend" });
		assert.equal(ctx.store.setDispatchAuthority(minister.id, true)?.dispatchAuthority, true);
		assert.equal(ctx.store.get(minister.id)?.dispatchAuthority, true);
		assert.equal(ctx.store.setDispatchAuthority(minister.id, false)?.dispatchAuthority, false);
		assert.equal(ctx.store.get(minister.id)?.dispatchAuthority, false);
	} finally {
		ctx.cleanup();
	}
});

test("setDispatchAuthority 不存在的 id 返回 null", () => {
	const ctx = tempStore();
	try {
		assert.equal(ctx.store.setDispatchAuthority("no-such-id", true), null);
	} finally {
		ctx.cleanup();
	}
});

test("开关状态重启后持久（关库重开）", () => {
	const ctx = tempStore();
	try {
		const minister = ctx.store.create("小明", { domain: "frontend" });
		ctx.store.setDispatchAuthority(minister.id, true);
		ctx.store.close();
		const reopened = new PartnersStore(ctx.db, ctx.homes);
		assert.equal(reopened.get(minister.id)?.dispatchAuthority, true);
		reopened.close();
		ctx.cleanup = () => rmSync(ctx.root, { recursive: true, force: true });
	} finally {
		ctx.cleanup();
	}
});

test("setMinisterDispatchAuthority：执事可切、普通执事拒、查无拒", () => {
	const ctx = tempStore();
	try {
		const minister = ctx.store.create("小明", { domain: "frontend" });
		const plain = ctx.store.create("普通人");
		assert.equal(setMinisterDispatchAuthority(minister.id, true, { store: ctx.store, workRoot: "" }).ok, true);
		assert.equal(ctx.store.get(minister.id)?.dispatchAuthority, true);
		const plainResult = setMinisterDispatchAuthority(plain.id, true, { store: ctx.store, workRoot: "" });
		assert.equal(plainResult.ok, false);
		if (!plainResult.ok) assert.match(plainResult.error, /domain/);
		assert.equal(
			setMinisterDispatchAuthority("no-such-id", true, { store: ctx.store, workRoot: "" }).ok,
			false,
		);
	} finally {
		ctx.cleanup();
	}
});

test("ministerDispatchAllowed：默认关、开了放行、查无执事不放行", () => {
	const ctx = tempStore();
	try {
		const minister = ctx.store.create("小明", { domain: "frontend" });
		// 默认关
		assert.equal(ministerDispatchAllowed(ctx.store, "frontend"), false);
		ctx.store.setDispatchAuthority(minister.id, true);
		assert.equal(ministerDispatchAllowed(ctx.store, "frontend"), true);
		// 关回去
		ctx.store.setDispatchAuthority(minister.id, false);
		assert.equal(ministerDispatchAllowed(ctx.store, "frontend"), false);
		// 查无执事
		assert.equal(ministerDispatchAllowed(ctx.store, "no-such-domain"), false);
	} finally {
		ctx.cleanup();
	}
});

test("ministerDispatchAllowed：env 总闸关 = 一律不放行（回滚开关）", () => {
	const ctx = tempStore();
	const saved = process.env.MINISTER_DISPATCH_AUTHORITY;
	const savedPath = process.env.AGENT_FLAGS_PATH;
	try {
		const minister = ctx.store.create("小明", { domain: "frontend" });
		ctx.store.setDispatchAuthority(minister.id, true);
		process.env.AGENT_FLAGS_PATH = join(ctx.root, "flags.json");
		writeFileSync(process.env.AGENT_FLAGS_PATH, "{}", "utf8");
		process.env.MINISTER_DISPATCH_AUTHORITY = "false";
		assert.equal(ministerDispatchAllowed(ctx.store, "frontend"), false);
		assert.equal(ministerDispatchMasterEnabled(), false);
		delete process.env.MINISTER_DISPATCH_AUTHORITY;
		assert.equal(ministerDispatchAllowed(ctx.store, "frontend"), true);
		// 明确写 0 也关
		process.env.MINISTER_DISPATCH_AUTHORITY = "0";
		assert.equal(ministerDispatchMasterEnabled(), false);
	} finally {
		if (saved === undefined) delete process.env.MINISTER_DISPATCH_AUTHORITY;
		else process.env.MINISTER_DISPATCH_AUTHORITY = saved;
		if (savedPath === undefined) delete process.env.AGENT_FLAGS_PATH;
		else process.env.AGENT_FLAGS_PATH = savedPath;
		ctx.cleanup();
	}
});
