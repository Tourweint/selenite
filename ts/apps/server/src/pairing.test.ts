import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PairingStore, deviceFingerprint } from "./pairing.ts";
import type { RedeemResult } from "./pairing.ts";

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
