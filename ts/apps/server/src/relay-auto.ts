import type { RelayDeviceView } from "@lifediary/shared";

/**
 * 设备矩阵自动挑机（2026-11-05 自动分发方案 §2.2）。
 *
 * 决策函数刻意做成**纯函数**：同输入同输出，不受时间、随机数、IO 影响。
 * 忙碌度由调用方先查好（queryBusyMap）再传进来——决策与查询分离，
 * 单测才能把"挑谁"和"查不到怎么办"分别钉死。
 *
 * 回滚开关：DEVICE_AUTO_DISPATCH（默认关，见 relay-config.ts）。
 * 关着时 `"auto"` 按非法参数拒绝，不进入本文件。
 */

/** `delegation/busy` 通道：目标机返回自己的在跑单数。 */
export const DELEGATION_BUSY_CHANNEL = "delegation/busy";

/** 查忙碌度的默认超时（方案 §2.2：3 秒，超时当 1）。 */
export const BUSY_QUERY_TIMEOUT_MS = 3_000;

export interface AutoPickInput {
	devices: RelayDeviceView[];
	selfDeviceId: string;
	/** 设备 id → 在跑单数；缺省按 0 算（离线/查失败的由 queryBusyMap 记 1） */
	busyMap: Record<string, number>;
	/** 单机在跑单数达到这个值即视为满载（来自 DEVICE_MAX_ACTIVE_PER_DEVICE，默认 3） */
	maxActivePerDevice: number;
}

export type AutoPickResult =
	| { picked: string; busy: number }
	| { fallback: "local"; reason: "no_candidate" | "all_busy" };

/** 只认数值型忙碌度；NaN / 负数 / 非数字一律按 0（决策不能因为脏数据崩掉）。 */
function busyOf(busyMap: Record<string, number>, deviceId: string): number {
	const raw = busyMap[deviceId];
	return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/** 手机不算执行候选：派过去也只能看到手机屏幕，干不了电脑上的活。 */
const PHONE_PLATFORM = /android|ios/i;

/** 单台设备是否够格当自动派活的目标（在线 + 矩阵能力 + 非本机 + 非手机）。 */
export function isAutoCandidate(device: RelayDeviceView, selfDeviceId: string): boolean {
	return (
		device.online === true &&
		device.capabilities.includes("matrix") &&
		device.id !== selfDeviceId &&
		!PHONE_PLATFORM.test(device.platform)
	);
}

/** 候选集合：查询忙碌度与决策共用同一份过滤，避免两处规则漂移。 */
export function autoCandidates(devices: RelayDeviceView[], selfDeviceId: string): RelayDeviceView[] {
	return devices.filter((device) => isAutoCandidate(device, selfDeviceId));
}

/**
 * 自动挑一台：
 * 1. 过滤（在线 / matrix / 非本机 / 非手机）；
 * 2. busy 升序 → lastSeenAt 新者优先（undefined 当 0）→ id 字典序；
 * 3. 剔除 busy ≥ maxActivePerDevice；全剔除 → all_busy；零候选 → no_candidate。
 *
 * 后两级 tie-break 不是"顺手排个序"：没有它，并列时结果取决于数组顺序，
 * 同一份名册两次决策可能挑到不同机器，单测和线上行为都没法复现。
 */
export function selectAutoDevice(input: AutoPickInput): AutoPickResult {
	const candidates = autoCandidates(input.devices, input.selfDeviceId);
	if (candidates.length === 0) {
		return { fallback: "local", reason: "no_candidate" };
	}
	// 配置层已经兜过非法值；这里再兜一次，保证纯函数单独被调用时也是确定行为。
	const limit =
		Number.isFinite(input.maxActivePerDevice) && input.maxActivePerDevice > 0
			? Math.floor(input.maxActivePerDevice)
			: 3;
	const ranked = candidates
		.map((device) => ({
			device,
			busy: busyOf(input.busyMap, device.id),
			// lastSeenAt 缺失按 0：从未报到过的设备排在同 busy 的后面
			lastSeen: device.lastSeenAt ?? 0,
		}))
		.sort(
			(a, b) =>
				a.busy - b.busy ||
				b.lastSeen - a.lastSeen ||
				// 字典序用码点比较（不用 localeCompare）：不随运行环境的语言设置变化
				(a.device.id < b.device.id ? -1 : a.device.id > b.device.id ? 1 : 0),
		);
	const available = ranked.filter((row) => row.busy < limit);
	if (available.length === 0) {
		return { fallback: "local", reason: "all_busy" };
	}
	const picked = available[0]!;
	return { picked: picked.device.id, busy: picked.busy };
}

/** 只依赖 invoke 的最小客户端面：单测用替身，不必造整个 RelayClient。 */
export interface BusyQueryClient {
	invoke(dst: string, channel: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
}

/**
 * 并发查每台候选的在跑单数。
 *
 * **任何失败都记 1**（超时 / 错误帧 / 设备离线 / 回包形状不对）：宁可低估它的空闲度，
 * 也不把活派给一台"问都问不应"的机器。查询之间互不阻塞，单台坏掉不影响其余结果。
 */
export async function queryBusyMap(
	client: BusyQueryClient,
	devices: RelayDeviceView[],
	timeoutMs: number = BUSY_QUERY_TIMEOUT_MS,
): Promise<Record<string, number>> {
	const entries = await Promise.all(
		devices.map(async (device): Promise<[string, number]> => {
			try {
				const result = await client.invoke(device.id, DELEGATION_BUSY_CHANNEL, {}, timeoutMs);
				const active = (result as { active?: unknown } | null)?.active;
				if (typeof active === "number" && Number.isFinite(active) && active >= 0) {
					return [device.id, Math.floor(active)];
				}
				return [device.id, 1];
			} catch {
				return [device.id, 1];
			}
		}),
	);
	return Object.fromEntries(entries);
}
