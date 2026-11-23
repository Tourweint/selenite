import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { RelayDeviceView } from "@lifediary/shared";
import {
	queryBusyMap,
	queryBusyMaps,
	selectAutoDevice,
	type BusyQueryClient,
} from "./relay-auto.ts";

/**
 * 自动挑机决策器（2026-11-05 自动分发方案 §2.5；同日 v2 主机优先制）。
 *
 * 决策是纯函数，这组测试不碰网络：忙碌度直接喂表；只有 queryBusyMap
 * 用替身客户端验"一半成功一半超时"的容错口径。
 *
 * v1 用例全部保留（没设主机时的输出必须一字不变——回归红线），
 * 另加"主机优先 / 满溢外流 / 主机离线 / 描述不参与"一组。
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
			homeDeviceId: null,
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
			homeDeviceId: null,
		});
		assert.deepEqual(result, { fallback: "local", reason: "no_candidate" });
	});

	test("非手机 platform 大小写不敏感地保留（Desktop / win32 都可候选）", () => {
		const result = selectAutoDevice({
			devices: [device("win", { platform: "win32" }), device("mac", { platform: "darwin" })],
			selfDeviceId: SELF,
			busyMap: {},
			maxActivePerDevice: 3,
			homeDeviceId: null,
		});
		assert.equal("picked" in result && result.picked, "mac");
	});
});

describe("selectAutoDevice：排序与满载（v1 回归，未设主机）", () => {
	test("busy 升序：挑最闲的一台，并把 busy 带回去；没设主机时 pickedHome=false", () => {
		const result = selectAutoDevice({
			devices: [device("busy-2"), device("busy-0"), device("busy-1")],
			selfDeviceId: SELF,
			busyMap: { "busy-2": 2, "busy-0": 0, "busy-1": 1 },
			maxActivePerDevice: 3,
			homeDeviceId: null,
		});
		assert.deepEqual(result, { picked: "busy-0", busy: 0, pickedHome: false });
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
			homeDeviceId: null,
		});
		assert.equal("picked" in result && result.picked, "new");
	});

	test("busy 与 lastSeenAt 都并列：id 字典序收敛（同输入同输出）", () => {
		const input = {
			devices: [device("b-dev"), device("a-dev"), device("c-dev")],
			selfDeviceId: SELF,
			busyMap: {},
			maxActivePerDevice: 3,
			homeDeviceId: null,
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
			homeDeviceId: null,
		});
		assert.deepEqual(result, { picked: "idle", busy: 2, pickedHome: false });
	});

	test("全部满载 → all_busy", () => {
		const result = selectAutoDevice({
			devices: [device("a"), device("b")],
			selfDeviceId: SELF,
			busyMap: { a: 3, b: 5 },
			maxActivePerDevice: 3,
			homeDeviceId: null,
		});
		assert.deepEqual(result, { fallback: "local", reason: "all_busy" });
	});

	test("忙碌度缺失按 0（不因为名册里没有记录就漏掉候选）", () => {
		const result = selectAutoDevice({
			devices: [device("a"), device("b")],
			selfDeviceId: SELF,
			busyMap: { b: 1 },
			maxActivePerDevice: 3,
			homeDeviceId: null,
		});
		assert.deepEqual(result, { picked: "a", busy: 0, pickedHome: false });
	});
});

describe("selectAutoDevice：主机优先（v2）", () => {
	test("主机未满载 → 永远选主机，哪怕别的机器更闲、更近", () => {
		const result = selectAutoDevice({
			devices: [
				device("home", { lastSeenAt: 1 }),
				device("idle-new", { lastSeenAt: 9_999 }),
			],
			selfDeviceId: SELF,
			// 主机忙 2，另一台完全空闲：产品口径仍选主机
			busyMap: { home: 2, "idle-new": 0 },
			maxActivePerDevice: 3,
			homeDeviceId: "home",
		});
		assert.deepEqual(result, { picked: "home", busy: 2, pickedHome: true });
	});

	test("主机满载 → 外流：按 busy 升序挑其余最闲，pickedHome=false", () => {
		const result = selectAutoDevice({
			devices: [device("home"), device("busy-2"), device("busy-1")],
			selfDeviceId: SELF,
			busyMap: { home: 3, "busy-2": 2, "busy-1": 1 },
			maxActivePerDevice: 3,
			homeDeviceId: "home",
		});
		assert.deepEqual(result, { picked: "busy-1", busy: 1, pickedHome: false });
	});

	test("主机满载且其余也满载 → all_busy（不硬塞回主机）", () => {
		const result = selectAutoDevice({
			devices: [device("home"), device("other")],
			selfDeviceId: SELF,
			busyMap: { home: 3, other: 4 },
			maxActivePerDevice: 3,
			homeDeviceId: "home",
		});
		assert.deepEqual(result, { fallback: "local", reason: "all_busy" });
	});

	test("主机离线（不在候选）→ 按其余最闲挑，pickedHome=false", () => {
		const result = selectAutoDevice({
			devices: [device("home", { online: false }), device("b"), device("c")],
			selfDeviceId: SELF,
			busyMap: { home: 0, b: 2, c: 1 },
			maxActivePerDevice: 3,
			homeDeviceId: "home",
		});
		assert.deepEqual(result, { picked: "c", busy: 1, pickedHome: false });
	});

	test("主机没有 matrix 能力（不在候选）→ 同样外流", () => {
		const result = selectAutoDevice({
			devices: [device("home", { capabilities: ["mirror"] }), device("worker")],
			selfDeviceId: SELF,
			busyMap: { home: 0, worker: 1 },
			maxActivePerDevice: 3,
			homeDeviceId: "home",
		});
		assert.deepEqual(result, { picked: "worker", busy: 1, pickedHome: false });
	});

	test("主机位指向已不在名册的 id / 空串 → 与 v1 完全一致", () => {
		const base = {
			devices: [device("x"), device("y")],
			selfDeviceId: SELF,
			busyMap: { x: 2, y: 1 },
			maxActivePerDevice: 3,
		};
		const v1 = selectAutoDevice({ ...base, homeDeviceId: null });
		const stale = selectAutoDevice({ ...base, homeDeviceId: "ghost-device" });
		const blank = selectAutoDevice({ ...base, homeDeviceId: "" });
		assert.deepEqual(stale, v1);
		assert.deepEqual(blank, v1);
		assert.deepEqual(v1, { picked: "y", busy: 1, pickedHome: false });
	});

	test("描述字段不参与决策（同一名册只加 description，结果不变）", () => {
		const input = {
			devices: [device("home"), device("other")],
			selfDeviceId: SELF,
			busyMap: { home: 1, other: 0 },
			maxActivePerDevice: 3,
			homeDeviceId: "home",
		};
		const plain = selectAutoDevice(input);
		const described = selectAutoDevice({
			...input,
			devices: [
				device("home", { description: "存储机" }),
				device("other", { description: "计算用" }),
			],
		});
		assert.deepEqual(described, plain);
		assert.deepEqual(plain, { picked: "home", busy: 1, pickedHome: true });
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

	test("排队深度：有 queued 就带回来，没有按 0（老对端只回 active 也不报错）", async () => {
		const client: BusyQueryClient = {
			async invoke(dst) {
				if (dst === "new") return { active: 1, queued: 4 };
				return { active: 0 };
			},
		};
		const { busyMap, queuedMap } = await queryBusyMaps(
			client,
			[device("new"), device("legacy")],
			50,
		);
		assert.deepEqual(busyMap, { new: 1, legacy: 0 });
		assert.deepEqual(queuedMap, { new: 4, legacy: 0 });
	});

	test("挑机：busy 相同时优先挑排队短的；没给 queuedMap 输出与旧版一致", () => {
		const devices = [device("long-queue"), device("short-queue")];
		const withQueue = selectAutoDevice({
			devices,
			selfDeviceId: "self",
			busyMap: { "long-queue": 1, "short-queue": 1 },
			queuedMap: { "long-queue": 9, "short-queue": 1 },
			maxActivePerDevice: 3,
			homeDeviceId: null,
		});
		assert.deepEqual(withQueue, { picked: "short-queue", busy: 1, pickedHome: false });

		// 回归红线：没有 queuedMap 时 tie-break 仍按 lastSeenAt → id，与 v1 逐字一致。
		const legacy = selectAutoDevice({
			devices,
			selfDeviceId: "self",
			busyMap: { "long-queue": 1, "short-queue": 1 },
			maxActivePerDevice: 3,
			homeDeviceId: null,
		});
		assert.ok("picked" in legacy, "两台都未满载，必须挑出一台");
		assert.equal(legacy.picked, "long-queue");
	});
});

test("relay-matrix 台账：旧行没有 pickedBy / pickReason / pickedHome 仍可读", async () => {
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
	// 本测试只验字段兼容（旧行缺新字段仍可读），不验 TTL：显式关掉清扫，
	// 否则 2023 年的 finishedAt 会被批 31 的 7 天 TTL 清掉（那是 relay-matrix.test.ts 的事）。
	process.env.REMOTE_DELEGATIONS_TTL_DAYS = "0";
	try {
		// 动态 import 是刻意的：STORE_PATH 在 relay-matrix 模块加载期取 env，
		// 必须先设好临时路径再加载，免得到开发机的 .data 里读真实台账。
		const { listRemoteDelegations } = await import("./relay-matrix.ts");
		const rows = listRemoteDelegations();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.requestId, "r-old");
		assert.equal(rows[0]?.pickedBy, undefined);
		assert.equal(rows[0]?.pickReason, undefined);
		assert.equal(rows[0]?.pickedHome, undefined);
	} finally {
		delete process.env.REMOTE_DELEGATIONS_PATH;
		delete process.env.REMOTE_DELEGATIONS_TTL_DAYS;
		rmSync(dir, { recursive: true, force: true });
	}
});
