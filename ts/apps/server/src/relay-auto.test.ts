import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { RelayDeviceView } from "@lifediary/shared";
import {
	queryBusyMap,
	selectAutoDevice,
	type BusyQueryClient,
} from "./relay-auto.ts";

/**
 * 自动挑机决策器（2026-11-05 自动分发方案 §2.5）。
 *
 * 决策是纯函数，这组测试不碰网络：忙碌度直接喂表；只有 queryBusyMap
 * 用替身客户端验"一半成功一半超时"的容错口径。
 */

function device(
	id: string,
	overrides: Partial<RelayDeviceView> = {},
): RelayDeviceView {
	return {
		id,
		name: id,
		platform: "win32",
		online: true,
		capabilities: ["mirror", "matrix"],
		...overrides,
	};
}

const SELF = "self-device";

describe("selectAutoDevice：候选过滤", () => {
	test("零设备 → no_candidate", () => {
		const result = selectAutoDevice({
			devices: [],
			selfDeviceId: SELF,
			busyMap: {},
			maxActivePerDevice: 3,
		});
		assert.deepEqual(result, { fallback: "local", reason: "no_candidate" });
	});

	test("离线 / 无 matrix / 本机 / 手机 全部不算候选", () => {
		const result = selectAutoDevice({
			devices: [
				device("offline", { online: false }),
				device("no-matrix", { capabilities: ["mirror"] }),
				device(SELF),
				device("phone-android", { platform: "android 14" }),
				device("phone-ios", { platform: "iOS" }),
			],
			selfDeviceId: SELF,
			busyMap: {},
			maxActivePerDevice: 3,
		});
		assert.deepEqual(result, { fallback: "local", reason: "no_candidate" });
	});

	test("非手机 platform 大小写不敏感地保留（Desktop / win32 都可候选）", () => {
		const result = selectAutoDevice({
			devices: [device("win", { platform: "win32" }), device("mac", { platform: "darwin" })],
			selfDeviceId: SELF,
			busyMap: {},
			maxActivePerDevice: 3,
		});
		assert.equal("picked" in result && result.picked, "mac");
	});
});

describe("selectAutoDevice：排序与满载", () => {
	test("busy 升序：挑最闲的一台，并把 busy 带回去", () => {
		const result = selectAutoDevice({
			devices: [device("busy-2"), device("busy-0"), device("busy-1")],
			selfDeviceId: SELF,
			busyMap: { "busy-2": 2, "busy-0": 0, "busy-1": 1 },
			maxActivePerDevice: 3,
		});
		assert.deepEqual(result, { picked: "busy-0", busy: 0 });
	});

	test("busy 并列：lastSeenAt 新者优先；undefined 当 0", () => {
		const result = selectAutoDevice({
			devices: [
				device("old", { lastSeenAt: 100 }),
				device("never"),
				device("new", { lastSeenAt: 900 }),
				device("mid", { lastSeenAt: 500 }),
			],
			selfDeviceId: SELF,
			busyMap: {},
			maxActivePerDevice: 3,
		});
		assert.equal("picked" in result && result.picked, "new");
	});

	test("busy 与 lastSeenAt 都并列：id 字典序收敛（同输入同输出）", () => {
		const input = {
			devices: [device("b-dev"), device("a-dev"), device("c-dev")],
			selfDeviceId: SELF,
			busyMap: {},
			maxActivePerDevice: 3,
		};
		const first = selectAutoDevice(input);
		assert.equal("picked" in first && first.picked, "a-dev");
		// 名册顺序打乱也不影响结果
		const reversed = { ...input, devices: [...input.devices].reverse() };
		const picked = selectAutoDevice(reversed);
		assert.equal("picked" in picked && picked.picked, "a-dev");
	});

	test("满载剔除：busy ≥ 阈值的不参与，哪怕它 lastSeenAt 最新", () => {
		const result = selectAutoDevice({
			devices: [device("full", { lastSeenAt: 999 }), device("idle", { lastSeenAt: 1 })],
			selfDeviceId: SELF,
			busyMap: { full: 3, idle: 2 },
			maxActivePerDevice: 3,
		});
		assert.deepEqual(result, { picked: "idle", busy: 2 });
	});

	test("全部满载 → all_busy", () => {
		const result = selectAutoDevice({
			devices: [device("a"), device("b")],
			selfDeviceId: SELF,
			busyMap: { a: 3, b: 5 },
			maxActivePerDevice: 3,
		});
		assert.deepEqual(result, { fallback: "local", reason: "all_busy" });
	});

	test("忙碌度缺失按 0（不因为名册里没有记录就漏掉候选）", () => {
		const result = selectAutoDevice({
			devices: [device("a"), device("b")],
			selfDeviceId: SELF,
			busyMap: { b: 1 },
			maxActivePerDevice: 3,
		});
		assert.deepEqual(result, { picked: "a", busy: 0 });
	});
});

describe("queryBusyMap：容错", () => {
	test("成功取 active；超时/错误一律记 1", async () => {
		const client: BusyQueryClient = {
			async invoke(dst) {
				if (dst === "ok") return { active: 2 };
				if (dst === "idle") return { active: 0 };
				throw new Error("timeout");
			},
		};
		const result = await queryBusyMap(
			client,
			[device("ok"), device("idle"), device("dead")],
			50,
		);
		assert.deepEqual(result, { ok: 2, idle: 0, dead: 1 });
	});

	test("回包形状不对（缺 active / 负数）同样记 1", async () => {
		const client: BusyQueryClient = {
			async invoke(dst) {
				if (dst === "garbage") return { nope: true };
				if (dst === "negative") return { active: -1 };
				return { active: 1 };
			},
		};
		const result = await queryBusyMap(
			client,
			[device("garbage"), device("negative"), device("fine")],
			50,
		);
		assert.deepEqual(result, { garbage: 1, negative: 1, fine: 1 });
	});

	test("真超时：单台拖过 timeoutMs 也不拖垮其它结果", async () => {
		const client: BusyQueryClient = {
			async invoke(dst, _channel, _payload, timeoutMs = 10) {
				if (dst === "slow") {
					await new Promise((resolve) => setTimeout(resolve, timeoutMs + 20));
					return { active: 0 };
				}
				return { active: 2 };
			},
		};
		// 替身自己模拟 RelayClient 的超时语义：超时就 reject（真实客户端由 invoke 的 timer 做）。
		const racing: BusyQueryClient = {
			invoke: async (dst, channel, payload, timeoutMs) => {
				const timer = new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("timeout")), timeoutMs),
				);
				return Promise.race([client.invoke(dst, channel, payload, timeoutMs), timer]);
			},
		};
		const result = await queryBusyMap(racing, [device("slow"), device("fast")], 20);
		assert.deepEqual(result, { slow: 1, fast: 2 });
	});
});

test("relay-matrix 台账：旧行没有 pickedBy / pickReason 仍可读", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lifediary-matrix-"));
	const file = join(dir, "remote.json");
	writeFileSync(
		file,
		JSON.stringify({
			rows: [
				{
					requestId: "r-old",
					targetDeviceId: "device-b",
					targetDeviceName: "乙机",
					targetTicketId: "T-old",
					domain: "",
					originInternalId: 1,
					phase: "done",
					updatedAt: 1_700_000_000_000,
					finishedAt: 1_700_000_000_001,
				},
			],
		}),
		"utf8",
	);
	process.env.REMOTE_DELEGATIONS_PATH = file;
	try {
		// 动态 import 是刻意的：STORE_PATH 在 relay-matrix 模块加载期取 env，
		// 必须先设好临时路径再加载，免得到开发机的 .data 里读真实台账。
		const { listRemoteDelegations } = await import("./relay-matrix.ts");
		const rows = listRemoteDelegations();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.requestId, "r-old");
		assert.equal(rows[0]?.pickedBy, undefined);
		assert.equal(rows[0]?.pickReason, undefined);
	} finally {
		delete process.env.REMOTE_DELEGATIONS_PATH;
		rmSync(dir, { recursive: true, force: true });
	}
});
