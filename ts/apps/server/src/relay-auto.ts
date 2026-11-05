import type { RelayDeviceView } from "@lifediary/shared";

/**
 * 设备矩阵自动挑机（2026-11-05 自动分发方案 §2.2；同日升级为 v2 主机优先制）。
 *
 * 决策函数刻意做成**纯函数**：同输入同输出，不受时间、随机数、IO 影响。
 * 忙碌度由调用方先查好（queryBusyMap）再传进来——决策与查询分离，
 * 单测才能把"挑谁"和"查不到怎么办"分别钉死。
 *
 * v2 只加一条产品规则：**主机优先、满溢才外流**。没设主机时输出与 v1 完全一致
 * （回归红线）。设备描述只给人看，决策器不读。
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
	/**
	 * 任务主机位（2026-11-05 主机优先制）：`null` = 未设 → 沿用 v1「全员挑最闲」。
	 * 主机在线且未满载时**永远选它**，busy 不参与比较（产品口径，见下面 selectAutoDevice）。
	 */
	homeDeviceId: string | null;
}

export type AutoPickResult =
	| {
			picked: string;
			busy: number;
			/** 挑中的是不是主机位（台账 `pickedHome` 与探针断言用；主机外流时为 false） */
			pickedHome: boolean;
	  }
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
 * 自动挑一台（v2，2026-11-05 主机优先制）：
 * 1. 过滤（在线 / matrix / 非本机 / 非手机）；
 * 2. 设了主机且主机在候选里：
 *    - 主机 busy < maxActivePerDevice → **直接返回主机**；
 *    - 主机满载 → 去掉主机，其余候选按"busy 升序 → lastSeenAt 新者优先 → id 字典序"挑；
 * 3. 没设主机 / 主机不在候选（离线、撤销、没 matrix、是手机）→ 沿用 v1：
 *    全员按同一排序挑最闲；
 * 4. 剔除 busy ≥ maxActivePerDevice；全剔除 → all_busy；零候选 → no_candidate。
 *
 * **"主机未满载时 busy 不参与比较"是产品口径，不是实现偷懒**：用户定调大部分工作
 * 都该落在主机上，别的机器更闲也不换（方案 §1.2）。别把它"优化"成全局按 busy 排序。
 *
 * 后两级 tie-break 不是"顺手排个序"：没有它，并列时结果取决于数组顺序，
 * 同一份名册两次决策可能挑到不同机器，单测和线上行为都没法复现。
 * 设备描述（description）**不参与**这里的任何一步（只给人看）。
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
	const rank = (list: RelayDeviceView[]): Array<{ device: RelayDeviceView; busy: number; lastSeen: number }> =>
		list
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

	// 空串与 null 同义：都表示"没设主机"（调用方可能把 env / 接口的可选值直接透传）
	const homeId = input.homeDeviceId?.trim() || null;
	const home = homeId ? candidates.find((device) => device.id === homeId) : undefined;
	if (home) {
		const homeBusy = busyOf(input.busyMap, home.id);
		// 主机优先：未满载就选它，不看别的机器多闲（产品口径）
		if (homeBusy < limit) {
			return { picked: home.id, busy: homeBusy, pickedHome: true };
		}
		// 主机满载 → 满溢外流：主机退出本轮，其余候选按 v1 排序挑最闲
		const spilled = rank(candidates.filter((device) => device.id !== home.id)).filter(
			(row) => row.busy < limit,
		);
		if (spilled.length === 0) {
			return { fallback: "local", reason: "all_busy" };
		}
		const picked = spilled[0]!;
		return { picked: picked.device.id, busy: picked.busy, pickedHome: false };
	}

	// 没设主机 / 主机不在候选 → v1 行为原样（回归红线：此时输出必须与 v1 完全一致）
	const available = rank(candidates).filter((row) => row.busy < limit);
	if (available.length === 0) {
		return { fallback: "local", reason: "all_busy" };
	}
	const picked = available[0]!;
	return { picked: picked.device.id, busy: picked.busy, pickedHome: false };
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
