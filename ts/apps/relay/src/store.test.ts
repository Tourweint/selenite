import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RelayHub } from "./hub.ts";
import { RelayPairing } from "./pairing.ts";
import { createRelayApp } from "./server.ts";
import { RelayStore, hardwareHashForRequest } from "./store.ts";

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

// ── 硬件归并（2026-11-24 C-10）────────────────────────────────────
//
// 同一台手机重复扫码加入中继不再堆记录：中继只存 hardwareId 的二次 hash，
// 命中未撤销记录就复用 id（主机位 / 描述 / 伙伴归属都挂在 id 上，不用迁移）。
const HARDWARE_A = "a".repeat(64);
const HARDWARE_B = "b".repeat(64);

function redeemWith(
	store: RelayStore,
	hardwareId: string | undefined,
	name = "Pixel 6a",
	platform = "android",
): { deviceId: string; deviceToken: string } {
	const { code } = store.issueCode();
	const outcome = store.redeem(code, name, platform, ["matrix"], Date.now(), hardwareHashForRequest(hardwareId));
	assert.ok(typeof outcome === "object");
	return outcome;
}

describe("RelayStore 硬件归并（2026-11-24 C-10）", () => {
	it("同 hardwareId 重复加入 → 名册 1 条、id 不变、主机位/描述不断、旧令牌失效", () => {
		const store = freshStore();
		const first = redeemWith(store, HARDWARE_A);
		store.setHomeDevice(first.deviceId);
		store.setDescription(first.deviceId, "存储机");

		const second = redeemWith(store, HARDWARE_A, "Pixel 6a（新）");

		assert.equal(second.deviceId, first.deviceId, "复用原 id");
		assert.equal(store.listDevices().length, 1);
		assert.equal(store.homeDeviceId(), first.deviceId, "主机位引用不断");
		assert.equal(store.listDevices()[0]?.description, "存储机", "设备描述不丢");
		assert.equal(store.listDevices()[0]?.name, "Pixel 6a（新）", "名字随最近一次加入刷新");
		assert.equal(store.verifyDeviceToken(first.deviceToken), null, "旧令牌被覆盖后自然失效");
		assert.equal(store.verifyDeviceToken(second.deviceToken), first.deviceId);
	});

	it("不同 hardwareId 不合并；不带字段保持旧行为（每次新建）", () => {
		const store = freshStore();
		const a = redeemWith(store, HARDWARE_A);
		const b = redeemWith(store, HARDWARE_B);
		assert.notEqual(b.deviceId, a.deviceId);
		assert.equal(store.listDevices().length, 2);

		const legacyFirst = redeemWith(store, undefined);
		const legacySecond = redeemWith(store, undefined);
		assert.notEqual(legacySecond.deviceId, legacyFirst.deviceId);
		assert.equal(store.listDevices().length, 4, "老客户端两次加入仍是两条（叠加前两条）");
	});

	it("已撤销的记录不复活：撤销后同 hardwareId 再加入走新建", () => {
		const store = freshStore();
		const first = redeemWith(store, HARDWARE_A);
		store.revokeDevice(first.deviceId);
		const again = redeemWith(store, HARDWARE_A);
		assert.notEqual(again.deviceId, first.deviceId);
		assert.equal(store.verifyDeviceToken(again.deviceToken), again.deviceId);
		assert.equal(store.listDevices().length, 1, "名册只留未撤销那条");
	});

	it("名册投影不带硬件哈希（RelayDeviceView 形状不变）", () => {
		const store = freshStore();
		redeemWith(store, HARDWARE_A);
		const view = store.listDevices()[0] as unknown as Record<string, unknown>;
		assert.equal("hardwareHash" in view, false);
		assert.equal("tokenHash" in view, false);
	});

	it("开关 / 形状：DEVICE_HARDWARE_MERGE=false 或字段形状不对 → 当没带", () => {
		assert.equal(hardwareHashForRequest(HARDWARE_A, {}), hardwareHashForRequest(HARDWARE_A));
		assert.equal(hardwareHashForRequest(HARDWARE_A, { DEVICE_HARDWARE_MERGE: "false" }), undefined);
		assert.equal(hardwareHashForRequest(HARDWARE_A, { DEVICE_HARDWARE_MERGE: "0" }), undefined);
		assert.equal(hardwareHashForRequest(HARDWARE_A, { DEVICE_HARDWARE_MERGE: "off" }), undefined);
		assert.equal(hardwareHashForRequest(undefined), undefined);
		assert.equal(hardwareHashForRequest(42), undefined);
		assert.equal(hardwareHashForRequest("x".repeat(129)), undefined);
	});
});

describe("中继 HTTP 面：hardwareId 端到端（2026-11-24 C-10）", () => {
	function freshApp(): { app: ReturnType<typeof createRelayApp>; store: RelayStore } {
		const store = freshStore();
		return { app: createRelayApp(store, new RelayHub(store, () => {})), store };
	}

	async function postJson(
		app: ReturnType<typeof createRelayApp>,
		path: string,
		body: Record<string, unknown>,
	): Promise<{ status: number; text: string }> {
		const response = await app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: response.status, text: await response.text() };
	}

	it("POST /api/relay/join：同 hardwareId 两次 → 名册 1 条、deviceId 相同、响应不含明文/哈希", async () => {
		const { app, store } = freshApp();
		const pairing = new RelayPairing(store);

		const firstCode = pairing.issue().joinCode;
		const first = await postJson(app, "/api/relay/join", {
			joinCode: firstCode,
			deviceName: "Pixel 6a",
			platform: "android",
			hardwareId: HARDWARE_A,
		});
		assert.equal(first.status, 200);
		assert.equal(first.text.includes(HARDWARE_A), false, "响应不回显明文 hardwareId");

		const secondCode = pairing.issue().joinCode;
		const second = await postJson(app, "/api/relay/join", {
			joinCode: secondCode,
			deviceName: "Pixel 6a",
			platform: "android",
			hardwareId: HARDWARE_A,
		});
		assert.equal(second.status, 200);

		const firstBody = JSON.parse(first.text) as { deviceId: string; deviceToken: string };
		const secondBody = JSON.parse(second.text) as { deviceId: string; deviceToken: string };
		assert.equal(secondBody.deviceId, firstBody.deviceId);
		assert.equal(store.listDevices().length, 1);
		assert.equal(store.verifyDeviceToken(firstBody.deviceToken), null, "第一次的令牌应已失效");
		assert.equal(store.verifyDeviceToken(secondBody.deviceToken), firstBody.deviceId);
	});

	it("POST /api/relay/join：不带 hardwareId 两次 → 两条（旧行为）", async () => {
		const { app, store } = freshApp();
		const pairing = new RelayPairing(store);
		for (const name of ["老客户端一", "老客户端二"]) {
			const response = await postJson(app, "/api/relay/join", {
				joinCode: pairing.issue().joinCode,
				deviceName: name,
				platform: "android",
			});
			assert.equal(response.status, 200);
		}
		assert.equal(store.listDevices().length, 2);
	});

	it("POST /api/relay/pair/redeem：同 hardwareId 两次 → 一条；主机位保持不变", async () => {
		const { app, store } = freshApp();
		const firstCode = store.issueCode().code;
		const first = await postJson(app, "/api/relay/pair/redeem", {
			code: firstCode,
			deviceName: "Pixel 6a",
			platform: "android",
			capabilities: ["matrix"],
			hardwareId: HARDWARE_A,
		});
		assert.equal(first.status, 200);
		const firstId = (JSON.parse(first.text) as { deviceId: string }).deviceId;
		store.setHomeDevice(firstId);

		const secondCode = store.issueCode().code;
		const second = await postJson(app, "/api/relay/pair/redeem", {
			code: secondCode,
			deviceName: "Pixel 6a",
			platform: "android",
			capabilities: ["matrix"],
			hardwareId: HARDWARE_A,
		});
		assert.equal(second.status, 200);
		assert.equal((JSON.parse(second.text) as { deviceId: string }).deviceId, firstId);
		assert.equal(store.listDevices().length, 1);
		assert.equal(store.homeDeviceId(), firstId);
	});
});
