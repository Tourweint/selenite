import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PairingStore, deviceFingerprint, hardwareHashForRequest, pairTwoStepEnabled } from "./pairing.ts";
import type { RedeemResult } from "./pairing.ts";

/**
 * 两段式配对（2026-11-10 批 28 §一）：begin 拿 code + confirmToken，confirm 才发令牌。
 *
 * 安全语义：**只扫码（只有 code）不能完成配对**——必须有人在电脑端交出 confirmToken。
 * 这里覆盖任务书 §1.6 六条（成功 / 只有 code / confirmToken 错 / 过期 / 重放 / 开关回滚），
 * 外加「明文不落盘」「失败计入既有 attempts 限流」两条硬约束。
 */

/**
 * 配对设备指纹 + 键变更 fail-closed（2026-11-10 批 26 §四）。
 *
 * 指纹只用来人眼核对；键变更在服务端表现为：文件里的 tokenHash 与指纹对不上 →
 * 该设备凭据一律失效，直到主人撤销 / 重配。这里直接改文件模拟"键被换掉"。
 */

interface StoredFile {
	devices: Array<{
		id: string;
		name: string;
		tokenHash: string;
		fingerprint?: string;
		keyChangedAt?: number;
		createdAt: number;
	}>;
}

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `lifediary-${prefix}-`));
}

function readStore(file: string): StoredFile {
	return JSON.parse(readFileSync(file, "utf8")) as StoredFile;
}

function pairOne(file: string, name = "测试机"): { store: PairingStore; redeemed: RedeemResult } {
	const store = new PairingStore(file);
	const code = store.issueCode().code;
	const redeemed = store.redeem(code, name);
	assert.notEqual(typeof redeemed, "string", "配对应当成功");
	return { store, redeemed: redeemed as RedeemResult };
}

test("指纹人眼可核：4-4-4 大写十六进制，同设备稳定、不同设备不同；清单不含 tokenHash", () => {
	const dir = tempDir("pair-fingerprint");
	try {
		const file = join(dir, "pairing.json");
		const { store, redeemed } = pairOne(file);
		assert.match(redeemed.fingerprint ?? "", /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);

		const stored = readStore(file).devices[0]!;
		assert.equal(
			redeemed.fingerprint,
			deviceFingerprint(stored.id, stored.tokenHash),
			"指纹必须能由落盘的 id + tokenHash 复算",
		);

		const listed = store.listDevices();
		assert.equal(listed[0]?.fingerprint, redeemed.fingerprint);
		assert.equal("tokenHash" in (listed[0] as Record<string, unknown>), false, "清单不下发哈希");

		const second = pairOne(file, "第二台");
		assert.notEqual(second.redeemed.fingerprint, redeemed.fingerprint, "两台设备指纹必须不同");
		assert.equal(store.verifyDeviceToken(redeemed.deviceToken), true);
		assert.equal(second.store.verifyDeviceToken(second.redeemed.deviceToken), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("键变更 fail-closed：文件里的 tokenHash 被换掉 → 标记 + 凭据立即失效", () => {
	const dir = tempDir("pair-key-change");
	try {
		const file = join(dir, "pairing.json");
		const { redeemed } = pairOne(file);

		const tampered = readStore(file);
		tampered.devices[0]!.tokenHash = createHash("sha256").update("另一把钥匙").digest("hex");
		writeFileSync(file, JSON.stringify(tampered, null, 2), "utf8");

		const reloaded = new PairingStore(file);
		assert.equal(reloaded.verifyDeviceToken(redeemed.deviceToken), false, "键变了就不认旧凭据");
		const device = reloaded.listDevices()[0];
		assert.equal(typeof device?.keyChangedAt, "number", "要留下键变更标记");
		assert.equal(device?.fingerprint, redeemed.fingerprint, "指纹仍是配对时那一枚，便于人眼对照");

		// 标记是持久的：再加载一次不能把它洗掉。
		const again = new PairingStore(file);
		assert.equal(typeof again.listDevices()[0]?.keyChangedAt, "number");
		// 撤销 / 重配仍可用：新码换新设备不受影响。
		const fresh = pairOne(file, "重新配对");
		assert.equal(fresh.store.verifyDeviceToken(fresh.redeemed.deviceToken), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("老记录迁移：没有指纹的文件加载时补算，不误判键变更", () => {
	const dir = tempDir("pair-legacy");
	try {
		const file = join(dir, "pairing.json");
		const token = "legacy-device-token";
		const tokenHash = createHash("sha256").update(token).digest("hex");
		writeFileSync(
			file,
			JSON.stringify(
				{ devices: [{ id: "legacy0001", name: "老手机", tokenHash, createdAt: 1 }] },
				null,
				2,
			),
			"utf8",
		);

		const store = new PairingStore(file);
		assert.equal(store.verifyDeviceToken(token), true, "迁移不能把老设备踢下线");
		const device = store.listDevices()[0];
		assert.equal(device?.fingerprint, deviceFingerprint("legacy0001", tokenHash));
		assert.equal(device?.keyChangedAt, undefined);
		assert.equal(readStore(file).devices[0]?.fingerprint, device?.fingerprint, "补算要落盘");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("开关 PAIR_DEVICE_FINGERPRINT=false：不生成 / 不下发指纹，也不做键变更判定", () => {
	const dir = tempDir("pair-fingerprint-off");
	const saved = process.env.PAIR_DEVICE_FINGERPRINT;
	process.env.PAIR_DEVICE_FINGERPRINT = "false";
	try {
		const file = join(dir, "pairing.json");
		const { store, redeemed } = pairOne(file);
		assert.equal(redeemed.fingerprint, undefined);
		const device = store.listDevices()[0];
		assert.equal("fingerprint" in (device as Record<string, unknown>), false);
		assert.equal("keyChangedAt" in (device as Record<string, unknown>), false);
		assert.equal("fingerprint" in readStore(file).devices[0]!, false);

		// 开关关着 → 不判键变更（回到本批之前的形态）：文件改坏也只按哈希自然失效。
		const tampered = readStore(file);
		tampered.devices[0]!.tokenHash = createHash("sha256").update("x").digest("hex");
		writeFileSync(file, JSON.stringify(tampered, null, 2), "utf8");
		const reloaded = new PairingStore(file);
		assert.equal(reloaded.listDevices()[0]?.keyChangedAt, undefined);
		assert.equal(reloaded.verifyDeviceToken(redeemed.deviceToken), false);
	} finally {
		if (saved === undefined) delete process.env.PAIR_DEVICE_FINGERPRINT;
		else process.env.PAIR_DEVICE_FINGERPRINT = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── 两段式配对（2026-11-10 批 28 §一）──────────────────────────────
function twoStepFixture(): { dir: string; file: string; store: PairingStore } {
	const dir = tempDir("pair-two-step");
	const file = join(dir, "pairing.json");
	return { dir, file, store: new PairingStore(file) };
}

test("两段式成功：begin 拿 code+confirmToken，confirm 才发令牌；两者都只存 sha256", () => {
	const { dir, file, store } = twoStepFixture();
	try {
		const { code, expiresAt, confirmToken } = store.begin();
		assert.match(code, /^\d{6}$/);
		assert.ok(expiresAt > 0);
		assert.ok(confirmToken.length >= 20, "confirmToken 应是高熵随机串，不是短码");

		const result = store.confirm(code, confirmToken, "测试机");
		assert.notEqual(typeof result, "string", "code 与 confirmToken 都交齐才成功");
		assert.equal(store.verifyDeviceToken((result as RedeemResult).deviceToken), true);

		// 硬约束：明文码 / 明文 confirmToken 都不落盘，落盘只有哈希。
		// 不比对整串 raw（6 位数字可能是时间戳的子串），只查落盘字段的值。
		const stored = JSON.parse(readFileSync(file, "utf8")) as {
			code?: Record<string, unknown>;
		};
		const values = Object.values(stored.code ?? {});
		assert.ok(!values.includes(code), "明文 code 不作为任何字段落盘");
		assert.ok(!values.includes(confirmToken), "明文 confirmToken 不作为任何字段落盘");
		assert.ok(stored.code?.hash && stored.code?.confirmHash, "落盘只留两枚哈希");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("只扫码不能完成：confirm 只给 code（无 confirmToken）→ 拒绝；单段 redeem 也兑不了两段式码", () => {
	const { dir, store } = twoStepFixture();
	try {
		const { code } = store.begin();
		assert.equal(store.confirm(code, "", "手机"), "confirm_required", "只有 code 不能完成配对");
		// 即便绕过 confirm 直接走单段 redeem，两段式码也不该被兑掉
		assert.equal(store.redeem(code, "手机"), "unknown_code");
		assert.equal(store.listDevices().length, 0, "到这一步不能产生任何设备");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("confirmToken 错 → 拒绝；连续错计入既有 attempts，撞上限作废", () => {
	const { dir, store } = twoStepFixture();
	try {
		const { code } = store.begin();
		assert.equal(store.confirm(code, "不是那枚令牌", "手机"), "bad_confirm");
		// 既有 attempts 限流：与 redeem 共用一个计数器，错满 5 次作废这枚码
		for (let i = 0; i < 3; i += 1) {
			assert.equal(store.confirm(code, "还是错", "手机"), "bad_confirm");
		}
		assert.equal(store.confirm(code, "第五次错", "手机"), "too_many_attempts");
		assert.equal(store.confirm(code, "正确令牌也没用了", "手机"), "too_many_attempts");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("两段式过期 → 拒绝（code 与 confirmToken 同生共死，默认 5 分钟）", () => {
	const { dir, store } = twoStepFixture();
	try {
		const t0 = 1_700_000_000_000;
		const { code, expiresAt, confirmToken } = store.begin(t0);
		assert.equal(expiresAt - t0, 300_000, "默认 5 分钟");
		assert.equal(store.confirm(code, confirmToken, "手机", t0 + 301_000), "code_expired");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("一次性（重放失败）：confirm 成功后第二次 → code_used", () => {
	const { dir, store } = twoStepFixture();
	try {
		const { code, confirmToken } = store.begin();
		assert.notEqual(typeof store.confirm(code, confirmToken, "手机"), "string");
		assert.equal(store.confirm(code, confirmToken, "手机"), "code_used", "confirmToken 不能重放");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("开关 PAIR_TWO_STEP=false 回滚到单段：默认 true，关掉后 issueCode→redeem 照常", () => {
	assert.equal(pairTwoStepEnabled({}), true, "缺省 true（收紧，但为了安全默认开）");
	assert.equal(pairTwoStepEnabled({ AUX_LLM: "false" }), true, "只认 PAIR_TWO_STEP");
	for (const off of ["false", "0", "off", "FALSE"]) {
		assert.equal(pairTwoStepEnabled({ PAIR_TWO_STEP: off }), false, `${off} 关`);
	}
	const { dir, store } = twoStepFixture();
	try {
		// 回滚形态：只有单段链路；begin/confirm 端点在服务端由开关关掉，这里验旧链路仍可用
		const code = store.issueCode().code;
		assert.notEqual(typeof store.redeem(code, "手机"), "string", "旧单段 redeem 回滚用，照常可用");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * 连接方式记录（2026-11-14 连接页两分）：服务端按请求来的地址判定，不由手机上报。
 * 这里只验存储语义：连上了就记下方式与时刻；方式变了要留旧方式的时刻（页面说"上次走数据线"）。
 */
test("连接方式：首次请求记下 local，换成 usb 时保留 local 的时刻", () => {
	const dir = tempDir("transport");
	const file = join(dir, "pairing.json");
	try {
		const { store, redeemed } = pairOne(file);
		const t0 = 1_700_000_000_000;

		assert.equal(store.verifyDeviceToken(redeemed.deviceToken, t0, "local"), true);
		let device = store.listDevices().find((item) => item.id === redeemed.deviceId);
		assert.equal(device?.lastTransport, "local");
		assert.equal(device?.lastTransportAt, t0);
		assert.equal(device?.transportAt?.local, t0);

		// 同一种方式：60 秒内不再落盘，时刻往后推由 lastSeenAt 管
		assert.equal(store.verifyDeviceToken(redeemed.deviceToken, t0 + 30_000, "local"), true);
		device = store.listDevices().find((item) => item.id === redeemed.deviceId);
		assert.equal(device?.lastTransportAt, t0, "同方式 30 秒内不重写时刻");

		// 换方式：当前变 usb，local 的时刻原样留着
		const t1 = t0 + 120_000;
		assert.equal(store.verifyDeviceToken(redeemed.deviceToken, t1, "usb"), true);
		device = store.listDevices().find((item) => item.id === redeemed.deviceId);
		assert.equal(device?.lastTransport, "usb");
		assert.equal(device?.lastTransportAt, t1);
		assert.equal(device?.transportAt?.local, t0, "旧方式时刻保留");
		assert.equal(device?.transportAt?.usb, t1);

		// 不传方式（老调用面）：只刷新 lastSeenAt，不编一个方式出来
		assert.equal(store.verifyDeviceToken(redeemed.deviceToken, t1 + 120_000), true);
		device = store.listDevices().find((item) => item.id === redeemed.deviceId);
		assert.equal(device?.lastTransport, "usb");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("连接方式：撤销的设备不再记方式（凭据已经失效）", () => {
	const dir = tempDir("transport-revoked");
	const file = join(dir, "pairing.json");
	try {
		const { store, redeemed } = pairOne(file, "平板");
		assert.equal(store.revokeDevice(redeemed.deviceId), true);
		assert.equal(store.verifyDeviceToken(redeemed.deviceToken, 1_700_000_000_000, "local"), false);
		const device = store.listDevices().find((item) => item.id === redeemed.deviceId);
		assert.equal(device?.lastTransport, undefined, "被撤销的设备不该再被记成「连过」");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── 硬件归并（2026-11-24 C-10）────────────────────────────────────
//
// 同一台手机重复扫码不再堆同名记录：客户端带 hardwareId，服务端只存它的二次 hash，
// 命中未撤销记录就复用 id（旧令牌因 tokenHash 被覆盖自然 403）。缺字段 / 开关关 = 旧行为。
const HARDWARE_A = createHash("sha256").update("android-id-a|com.lifediary").digest("hex");
const HARDWARE_B = createHash("sha256").update("android-id-b|com.lifediary").digest("hex");

function redeemWith(
	store: PairingStore,
	hardwareId: string | undefined,
	name = "Pixel 6a",
): RedeemResult {
	const redeemed = store.redeem(store.issueCode().code, name, Date.now(), hardwareHashForRequest(hardwareId));
	assert.notEqual(typeof redeemed, "string", "配对应当成功");
	return redeemed as RedeemResult;
}

test("同 hardwareId 两次配对 → 名册 1 条、deviceId 不变、旧令牌 403、名字刷新", () => {
	const dir = tempDir("hw-merge");
	const file = join(dir, "pairing.json");
	try {
		const store = new PairingStore(file);
		const first = redeemWith(store, HARDWARE_A, "Pixel 6a");
		const second = redeemWith(store, HARDWARE_A, "Pixel 6a（新）");

		assert.equal(second.deviceId, first.deviceId, "复用原 id（主机位 / 描述挂在 id 上）");
		assert.equal(store.listDevices().length, 1, "同一台手机只留一条记录");
		assert.equal(store.verifyDeviceToken(first.deviceToken), false, "旧令牌因 tokenHash 被覆盖自然失效");
		assert.equal(store.verifyDeviceToken(second.deviceToken), true);

		const stored = readStore(file).devices;
		assert.equal(stored.length, 1);
		assert.equal(stored[0]?.name, "Pixel 6a（新）", "名字随最近一次配对刷新");
		// 指纹重算：能由落盘的 id + tokenHash 复算（复用时不能沿用旧指纹）
		assert.equal(stored[0]?.fingerprint, deviceFingerprint(stored[0]!.id, stored[0]!.tokenHash));

		// 隐私边界：明文 hardwareId 不落盘，二次 hash 只在内部存储、不进对外投影。
		const raw = readFileSync(file, "utf8");
		assert.equal(raw.includes(HARDWARE_A), false, "明文 hardwareId 不落盘");
		assert.equal(raw.includes(hardwareHashForRequest(HARDWARE_A)!), true, "落盘的是二次 hash");
		const listed = store.listDevices()[0] as Record<string, unknown>;
		assert.equal("hardwareHash" in listed, false, "对外投影不带硬件哈希");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("不同 hardwareId 不合并；不带字段保持旧行为（每次新建）", () => {
	const dir = tempDir("hw-distinct");
	const file = join(dir, "pairing.json");
	try {
		const store = new PairingStore(file);
		const a = redeemWith(store, HARDWARE_A);
		const b = redeemWith(store, HARDWARE_B);
		assert.notEqual(b.deviceId, a.deviceId);
		assert.equal(store.listDevices().length, 2, "两台不同手机必须各留一条");

		// 老客户端（完全不带 hardwareId）：逐字旧行为 —— 两次配对 = 两条记录。
		const legacyFile = join(dir, "legacy.json");
		const legacy = new PairingStore(legacyFile);
		const l1 = redeemWith(legacy, undefined);
		const l2 = redeemWith(legacy, undefined);
		assert.notEqual(l2.deviceId, l1.deviceId);
		assert.equal(legacy.listDevices().length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("形状不对的 hardwareId（非字符串 / 空 / 超长）当没带：不报错、不合并", () => {
	const dir = tempDir("hw-shape");
	const file = join(dir, "pairing.json");
	try {
		assert.equal(hardwareHashForRequest(undefined), undefined);
		assert.equal(hardwareHashForRequest(""), undefined);
		assert.equal(hardwareHashForRequest(123), undefined);
		assert.equal(hardwareHashForRequest("x".repeat(129)), undefined, "超 128 字符忽略");
		assert.equal(hardwareHashForRequest(` ${HARDWARE_A} `), hardwareHashForRequest(HARDWARE_A), "两侧空白容忍");

		const store = new PairingStore(file);
		const first = store.redeem(store.issueCode().code, "手机", Date.now(), hardwareHashForRequest(123));
		const second = store.redeem(store.issueCode().code, "手机", Date.now(), hardwareHashForRequest("y".repeat(200)));
		assert.notEqual(typeof first, "string");
		assert.notEqual(typeof second, "string");
		assert.equal(store.listDevices().length, 2, "忽略字段即旧行为");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("已撤销的记录不复活：撤销后同 hardwareId 重配走新建（新 id）", () => {
	const dir = tempDir("hw-revoked");
	const file = join(dir, "pairing.json");
	try {
		const store = new PairingStore(file);
		const first = redeemWith(store, HARDWARE_A);
		assert.equal(store.revokeDevice(first.deviceId), true);

		const again = redeemWith(store, HARDWARE_A);
		assert.notEqual(again.deviceId, first.deviceId, "撤销是明确作废意图，不复用");
		assert.equal(store.verifyDeviceToken(again.deviceToken), true);
		assert.equal(store.verifyDeviceToken(first.deviceToken), false);
		assert.equal(store.listDevices().length, 1, "名册投影只剩新的那条");
		// 既有行为：配对时的设备上限过滤会把已撤销记录清出文件（不是本卡改的），所以文件里也只剩新那条。
		assert.equal(readStore(file).devices.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("复用时清 keyChangedAt：被标记 fail-closed 的设备重配对后新令牌可用", () => {
	const dir = tempDir("hw-key-changed");
	const file = join(dir, "pairing.json");
	try {
		const store = new PairingStore(file);
		const first = redeemWith(store, HARDWARE_A);

		// 模拟文件被改（tokenHash 与指纹对不上）→ 服务重启时标记 keyChangedAt
		const tampered = readStore(file);
		tampered.devices[0]!.tokenHash = createHash("sha256").update("另一把钥匙").digest("hex");
		writeFileSync(file, JSON.stringify(tampered, null, 2), "utf8");

		const reloaded = new PairingStore(file);
		assert.equal(typeof reloaded.listDevices()[0]?.keyChangedAt, "number");
		assert.equal(reloaded.verifyDeviceToken(first.deviceToken), false);

		const again = redeemWith(reloaded, HARDWARE_A);
		assert.equal(again.deviceId, first.deviceId, "重配对复用同一 id");
		assert.equal(reloaded.listDevices()[0]?.keyChangedAt, undefined, "重配对 = 重新认领，清掉旧标记");
		assert.equal(reloaded.verifyDeviceToken(again.deviceToken), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("两段式 confirm 同样归并：begin/confirm 各两次、同 hardwareId → 1 条且 id 不变", () => {
	const dir = tempDir("hw-two-step");
	const file = join(dir, "pairing.json");
	try {
		const store = new PairingStore(file);
		const first = store.begin();
		const firstResult = store.confirm(
			first.code,
			first.confirmToken,
			"Pixel 6a",
			Date.now(),
			hardwareHashForRequest(HARDWARE_A),
		);
		assert.notEqual(typeof firstResult, "string");

		const second = store.begin();
		const secondResult = store.confirm(
			second.code,
			second.confirmToken,
			"Pixel 6a",
			Date.now(),
			hardwareHashForRequest(HARDWARE_A),
		);
		assert.notEqual(typeof secondResult, "string");
		assert.equal((secondResult as RedeemResult).deviceId, (firstResult as RedeemResult).deviceId);
		assert.equal(store.listDevices().length, 1);
		assert.equal(store.verifyDeviceToken((firstResult as RedeemResult).deviceToken), false);
		assert.equal(store.verifyDeviceToken((secondResult as RedeemResult).deviceToken), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("开关 DEVICE_HARDWARE_MERGE=false：完全忽略 hardwareId（逐字旧行为）", () => {
	assert.equal(hardwareHashForRequest(HARDWARE_A, {}), hardwareHashForRequest(HARDWARE_A));
	for (const off of ["false", "0", "off", "FALSE"]) {
		assert.equal(hardwareHashForRequest(HARDWARE_A, { DEVICE_HARDWARE_MERGE: off }), undefined, `${off} 关`);
	}

	const dir = tempDir("hw-switch-off");
	const file = join(dir, "pairing.json");
	try {
		const store = new PairingStore(file);
		// 路由算出来的 hash 是 undefined → 与改动前完全一致：两次配对两条记录。
		const first = store.redeem(store.issueCode().code, "手机", Date.now(), hardwareHashForRequest(HARDWARE_A, { DEVICE_HARDWARE_MERGE: "false" }));
		const second = store.redeem(store.issueCode().code, "手机", Date.now(), hardwareHashForRequest(HARDWARE_A, { DEVICE_HARDWARE_MERGE: "false" }));
		assert.notEqual(typeof first, "string");
		assert.notEqual(typeof second, "string");
		assert.equal(store.listDevices().length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("指纹开关关着时复用：不返回指纹、清掉旧指纹（下次开启不误判键变更）", () => {
	const dir = tempDir("hw-fingerprint-off-reuse");
	const file = join(dir, "pairing.json");
	const saved = process.env.PAIR_DEVICE_FINGERPRINT;
	try {
		const store = new PairingStore(file);
		const first = redeemWith(store, HARDWARE_A);
		assert.match(first.fingerprint ?? "", /^[0-9A-F]{4}-/);

		process.env.PAIR_DEVICE_FINGERPRINT = "false";
		const second = redeemWith(store, HARDWARE_A);
		assert.equal(second.deviceId, first.deviceId);
		assert.equal(second.fingerprint, undefined, "开关关着不下发指纹");

		// 关掉期间复用的旧值必须清掉：再开启时 sealFingerprints 只会补算（补算 = 迁移，不判键变更）。
		delete process.env.PAIR_DEVICE_FINGERPRINT;
		const reloaded = new PairingStore(file);
		const device = reloaded.listDevices()[0];
		assert.equal(typeof device?.fingerprint, "string");
		assert.equal(device?.keyChangedAt, undefined, "不能把重配对误判成键被换过");
		assert.equal(reloaded.verifyDeviceToken(second.deviceToken), true);
	} finally {
		if (saved === undefined) delete process.env.PAIR_DEVICE_FINGERPRINT;
		else process.env.PAIR_DEVICE_FINGERPRINT = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});