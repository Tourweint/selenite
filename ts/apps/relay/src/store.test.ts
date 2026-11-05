import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RelayStore } from "./store.ts";

function freshStore(): RelayStore {
	return new RelayStore(join(mkdtempSync(join(tmpdir(), "relay-store-")), `${randomUUID()}.json`));
}

describe("RelayStore 配对与名册", () => {
	it("签码→兑换→令牌验证闭环", () => {
		const store = freshStore();
		const { code } = store.issueCode();
		const outcome = store.redeem(code, "测试机", "win32", ["matrix"]);
		assert.ok(typeof outcome === "object");
		assert.equal(store.verifyDeviceToken(outcome.deviceToken), outcome.deviceId);
	});

	it("错码累计 5 次作废整枚码", () => {
		const store = freshStore();
		const { code } = store.issueCode();
		for (let i = 0; i < 5; i += 1) {
			assert.equal(store.redeem("000000" === code ? "111111" : "000000", "x", "test", []), i < 4 ? "unknown_code" : "too_many_attempts");
		}
		// 正确的码也被连坐作废（错满 5 次整码不可用）
		assert.equal(store.redeem(code, "x", "test", []), "too_many_attempts");
	});

	it("码过期 / 已用不可再兑", () => {
		const store = freshStore();
		const { code } = store.issueCode(Date.now() - 10_000);
		// issueCode 用传入 now 算过期，这里直接构造过期场景：重签一枚再快进
		const fresh = store.issueCode();
		const t1 = store.redeem(fresh.code, "a", "test", []);
		assert.ok(typeof t1 === "object");
		assert.equal(store.redeem(fresh.code, "a", "test", []), "code_used");

		const expired = store.issueCode(Date.now() - 301_000);
		assert.equal(store.redeem(expired.code, "a", "test", []), "code_expired");
		void code;
	});

	it("撤销后令牌立即失效", () => {
		const store = freshStore();
		const { code } = store.issueCode();
		const outcome = store.redeem(code, "被撤机", "test", []);
		assert.ok(typeof outcome === "object");
		assert.equal(store.revokeDevice(outcome.deviceId), true);
		assert.equal(store.verifyDeviceToken(outcome.deviceToken), null);
		assert.equal(store.revokeDevice(outcome.deviceId), false);
	});

	it("设备上限踢最久未用（默认 32）", () => {
		const store = freshStore();
		const ids: string[] = [];
		for (let i = 0; i < 33; i += 1) {
			const { code } = store.issueCode();
			const outcome = store.redeem(code, `机-${i}`, "test", []);
			assert.ok(typeof outcome === "object");
			ids.push(outcome.deviceId);
		}
		const listed = store.listDevices();
		assert.equal(listed.length, 32);
		// 最老的一台被挤出
		assert.equal(listed.some((d) => d.id === ids[0]), false);
		assert.equal(listed.some((d) => d.id === ids[32]), true);
	});

	it("名册投影不含令牌哈希且带在线位", () => {
		const store = freshStore();
		const { code } = store.issueCode();
		const outcome = store.redeem(code, "在线机", "linux", ["matrix"]);
		assert.ok(typeof outcome === "object");
		const view = store.listDevices(Date.now(), new Set([outcome.deviceId]))[0];
		assert.equal(view.online, true);
		assert.equal(view.capabilities.includes("matrix"), true);
		assert.equal("tokenHash" in view, false);
	});
});

describe("RelayStore 任务主机位与描述（2026-11-05 主机优先制）", () => {
	/** 配一台设备并返回 id。 */
	function pair(store: RelayStore, name: string): string {
		const { code } = store.issueCode();
		const outcome = store.redeem(code, name, "linux", ["matrix"]);
		assert.ok(typeof outcome === "object");
		return outcome.deviceId;
	}

	it("setHomeDevice：设 / 清 / 非法 id 不动现状", () => {
		const store = freshStore();
		const a = pair(store, "甲机");
		const b = pair(store, "乙机");

		assert.equal(store.homeDeviceId(), null);
		assert.equal(store.setHomeDevice(b), true);
		// 唯一主机位：再设一台就顶替，不是并列
		assert.equal(store.setHomeDevice(a), true);
		assert.equal(store.homeDeviceId(), a);

		// 非法 id 返回 false 且不把现状改坏
		assert.equal(store.setHomeDevice("no-such-device"), false);
		assert.equal(store.homeDeviceId(), a);

		// null = 清除
		assert.equal(store.setHomeDevice(null), true);
		assert.equal(store.homeDeviceId(), null);
	});

	it("名册投影带 isHome（同刻只有一台）与 description", () => {
		const store = freshStore();
		const a = pair(store, "甲机");
		const b = pair(store, "乙机");
		store.setHomeDevice(a);
		assert.equal(store.setDescription(b, "存储机"), true);

		const views = store.listDevices();
		const viewA = views.find((view) => view.id === a)!;
		const viewB = views.find((view) => view.id === b)!;
		assert.equal(viewA.isHome, true);
		assert.equal(viewA.description, undefined);
		assert.equal(viewB.isHome, false);
		assert.equal(viewB.description, "存储机");
	});

	it("setDescription：≤200 字截断、空串清除、未知设备 false", () => {
		const store = freshStore();
		const id = pair(store, "机");
		const long = "存".repeat(250);

		assert.equal(store.setDescription(id, long), true);
		assert.equal(store.listDevices()[0]?.description?.length, 200);

		// 空串（含纯空白）= 清除
		assert.equal(store.setDescription(id, "   "), true);
		assert.equal(store.listDevices()[0]?.description, undefined);

		assert.equal(store.setDescription("no-such-device", "x"), false);
	});

	it("主机位与描述落盘：重启后仍在（load 不丢字段）", () => {
		const path = join(mkdtempSync(join(tmpdir(), "relay-store-")), `${randomUUID()}.json`);
		const first = new RelayStore(path);
		const id = pair(first, "持久机");
		first.setHomeDevice(id);
		first.setDescription(id, "计算用");

		const second = new RelayStore(path);
		assert.equal(second.homeDeviceId(), id);
		assert.equal(second.listDevices()[0]?.description, "计算用");
		assert.equal(second.listDevices()[0]?.isHome, true);
	});

	it("主机设备被撤销后按'没设'处理（不吐幽灵 id）", () => {
		const store = freshStore();
		const id = pair(store, "待撤主机");
		store.setHomeDevice(id);
		store.revokeDevice(id);
		assert.equal(store.homeDeviceId(), null);
		// 撤销设备本身也不在名册投影里了
		assert.equal(store.listDevices().length, 0);
	});
});
