import type { Harness } from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listManagers } from "../../../../../../chancellor/src/manager/registry.ts";
import { TERMINAL_TICKET_STATUS } from "../delegation-receipts.ts";
import { getHarness } from "./lifecycle.ts";
import {
	CTX,
	Chats,
	ChatKinds,
	TASK_CONVERSATION_PREFIX,
} from "./shared.ts";
import {
	archiveChat,
	chatKindOfInternal,
	readChatMeta,
	readChatStats,
} from "./session.ts";

/**
 * 自动归档调度器（2026-11-13 归档管理对齐 ZCode 批A，方案 §3）。
 *
 * **翻案登记**：2026-11-12 拍板"不做自动过期"，2026-11-13 翻回"有这个能力，但默认关"；
 * 2026-11-15 用户再拍板"做出来的功能默认就开"，改为**默认开**（只有明确 false/0/off 才关）。
 * 开关 `ARCHIVE_AUTO_ENABLED`（默认 true）+ `ARCHIVE_AUTO_DAYS`（默认 30，最小 1），
 * 都是 hot 开关，每轮懒读。
 *
 * **范式**照 autonomy.ts 的 syncSweepTimer（按需开关 + unref）：启动首轮延迟 5 分钟
 * （setTimeout），之后每小时一轮（setInterval），都 unref。**不走 durable sleepUntil**：
 * 这是低频清扫型任务，不需要"到点必响"的可靠性，错过一轮下轮补上（差异已登记，
 * 不动系统架构 §3 的口径——那说的是触发型提醒）。
 *
 * **判定**（只收"不动了很久的、已经翻不了身的会话"）：
 *   - 全量枚举 `Chats.byExternal`（**不走 listChats**——它按 limit 截断，要收的恰是
 *     旧会话，截断会漏）；
 *   - 收两种：① `chatKind=worker` 的普通对话（chief 是主对话、执事与群 `partner-`
 *     不是主人对话，都不收）；② `task-` 任务专线——**但只收单已经落终态的**
 *     （`ticket.json` 的 status ∈ TERMINAL_TICKET_STATUS，或单在磁盘上已不存在；
 *     在办/在等/跑着的单不收，2026-11-14 按用户口径从"一律不收"改成"收已结束的"）；
 *   - `lastAt`（readChatStats 口径，现场重放算）< now - days；
 *   - 跳过已归档（chat-meta.archived）、跳过置顶（chat-meta.pins）、跳过运行中（pi.live.run）；
 *   - **每轮上限 50 条**防长阻塞，剩余下轮继续（最旧的优先）。
 *
 * 归档动作复用 `archiveChat()`（记 archivedAt）。日志一轮一行：扫描数 / 命中数 /
 * 跳过原因计数，只记条数与 id 数量，不含标题正文。
 *
 * **已知边界（方案登记，如实写）**：不做"归档事件广播"——正在界面里开着的会话被
 * 自动归档后，要等下次 loadChats 才从列表消失；该会话仍可继续聊（归档不影响正文读写）。
 * 任务专线被归档后同样不影响派活：`/tickets/:id/say` 与镜像写入照常，归档只是把它记进
 * chat-meta（终态单本来也不会再有进度写入了）。
 */

/** 开关消费处：默认开（2026-11-15 用户口径），只有显式 false/0/off 才关（与 flags defaultValue "true" 同口径）。 */
export function archiveAutoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.ARCHIVE_AUTO_ENABLED ?? "").trim().toLowerCase();
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 天数消费处：非整数 / 小于 1 落回默认 30（与 flags 校验同口径：≥1 的整数）。 */
export function archiveAutoDays(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number((env.ARCHIVE_AUTO_DAYS ?? "").trim());
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : 30;
}

// ── 派活单是否"已经翻不了身"（任务专线专用）──────────────

/** 派活侧工作根。与 `delegation-delegation-kickoff.ts` 的 `chancellorWorkRoot()` 同口径；
 *  这里自己算而不是 import：采集器不该为了一个 env 把整套派活模块拉进依赖图。 */
function ticketWorkRoot(): string {
	const configured = process.env.CHANCELLOR_WORK_ROOT?.trim();
	return resolve(configured || join(process.cwd(), "runs"));
}

/** 单可能落在的目录：顶层 `runs/` + 各领域 `managers/<domain>/runs/`
 *  （与 delegation-mount 的 `findTicket`、partner-context 的扫描同一份口径）。 */
function ticketRunDirs(workRoot: string): string[] {
	const dirs = [workRoot];
	try {
		for (const entry of listManagers(workRoot)) {
			const runsDir = entry.meta?.runs_dir;
			if (runsDir && existsSync(runsDir)) dirs.push(runsDir);
		}
	} catch {
		// 领域清单读不出来就只看顶层：不能因为一个目录坏了把采集整轮停掉
	}
	return dirs;
}

/**
 * 这张单是不是已经结束：
 *   - `ticket.json` 落了终态（TERMINAL_TICKET_STATUS）→ 结束；
 *   - 哪个目录都找不到 `ticket.json` → 单已不在磁盘上，也不可能再动 → 结束；
 *   - 读得出来但状态不是终态（在办 / 在等 / 跑着）→ **不收**；
 *   - 文件坏了、读不出来 → 当"还可能活"，**不收**（宁可漏收，也不收在办的单）。
 */
function ticketSettled(dirs: readonly string[], ticketId: string): boolean {
	const safe = ticketId.trim();
	if (!safe || safe.includes("/") || safe.includes("\\") || safe.includes("..")) return false;
	for (const dir of dirs) {
		const file = join(dir, safe, "ticket.json");
		if (!existsSync(file)) continue;
		try {
			const status = String(
				(JSON.parse(readFileSync(file, "utf8")) as { status?: unknown }).status ?? "",
			);
			return TERMINAL_TICKET_STATUS.has(status);
		} catch {
			return false;
		}
	}
	return true;
}

// ── 判定（纯函数，单测直接喂）──────────────────────────────

/** 一条待判定会话的完整快照（sweep 现场算好，判定不看 durable）。 */
export interface AutoArchiveCandidateInput {
	externalId: string;
	/** readChatStats 口径的最后一句时间；空会话（没有轮次）为 null */
	lastAt: number | null;
	worker: boolean;
	/** `task-` 任务专线（打手那张单的回声会话）。worker 与 task 互斥 */
	task: boolean;
	/** 任务专线的那张单是否已落终态 / 已不在磁盘；非 task 恒为 true（这一关不判它） */
	ticketSettled: boolean;
	archived: boolean;
	pinned: boolean;
	busy: boolean;
}

export interface AutoArchiveSkipCounts {
	/** 非普通对话、也不是任务专线（chief / partner / 群） */
	kind: number;
	/** 任务专线对应的单还在办 / 在等 / 读不出来 */
	openTicket: number;
	archived: number;
	pinned: number;
	/** 没有任何轮次的空会话 */
	empty: number;
	/** 还没到天数门槛 */
	fresh: number;
	busy: number;
}

export interface AutoArchiveSelection {
	/** 命中且按最旧优先排好序（上限在调用处截） */
	hits: { externalId: string; lastAt: number }[];
	skipped: AutoArchiveSkipCounts;
}

/**
 * 自动归档判定：非（普通对话 | 任务专线）→ 单没结束 → 已归档 → 置顶 → 空会话 →
 * 未到期 → 忙，逐一跳过；过了全部关卡的按 lastAt 升序（最旧的先收）。
 * **上限不在纯函数里截**——调用方按"上限 50"截取（便于日志里报"命中 X 收 N 剩 M"），
 * 单测直接断言顺序。
 */
export function selectAutoArchiveCandidates(
	entries: readonly AutoArchiveCandidateInput[],
	cutoff: number,
): AutoArchiveSelection {
	const skipped: AutoArchiveSkipCounts = { kind: 0, openTicket: 0, archived: 0, pinned: 0, empty: 0, fresh: 0, busy: 0 };
	const hits: { externalId: string; lastAt: number }[] = [];
	for (const entry of entries) {
		if (!entry.worker && !entry.task) {
			skipped.kind += 1;
			continue;
		}
		if (entry.task && !entry.ticketSettled) {
			skipped.openTicket += 1;
			continue;
		}
		if (entry.archived) {
			skipped.archived += 1;
			continue;
		}
		if (entry.pinned) {
			skipped.pinned += 1;
			continue;
		}
		if (entry.lastAt === null) {
			skipped.empty += 1;
			continue;
		}
		if (entry.lastAt >= cutoff) {
			skipped.fresh += 1;
			continue;
		}
		if (entry.busy) {
			skipped.busy += 1;
			continue;
		}
		hits.push({ externalId: entry.externalId, lastAt: entry.lastAt });
	}
	hits.sort((a, b) => a.lastAt - b.lastAt);
	return { hits, skipped };
}

// ── 调度器 ───────────────────────────────────────────────

const FIRST_RUN_DELAY_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** 每轮归档上限（方案口径）：防长阻塞，剩余下轮继续。 */
export const AUTO_ARCHIVE_BATCH_LIMIT = 50;

/** 注入缝（生产不传；单测传假 sweep 输入与假 archive，不碰真实 .data 与真实会话）。 */
export interface AutoArchiveDeps {
	enabled?: () => boolean;
	days?: () => number;
	/** 一轮的实际动作（默认 sweepOnce）；单测可换 */
	sweep?: () => Promise<void>;
}

export class AutoArchiveScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private firstRun: ReturnType<typeof setTimeout> | null = null;
	private running = false;

	constructor(private readonly deps: AutoArchiveDeps = {}) {}

	private enabled(): boolean {
		return (this.deps.enabled ?? archiveAutoEnabled)();
	}

	/**
	 * 按需开停定时器（autonomy syncSweepTimer 同款）：开且没定时器才开；
	 * 关了就清。启动时调一次；flags 端点写 `ARCHIVE_AUTO_*` 后由 onChange 再调一次，
	 * 运行中开 / 关都当场生效（否则动态开要等重启，hot 就名不副实）。
	 */
	sync(): void {
		const enabled = this.enabled();
		if (enabled && this.timer === null && this.firstRun === null) {
			this.firstRun = setTimeout(() => {
				this.firstRun = null;
				this.timer = setInterval(() => void this.runSweep(), SWEEP_INTERVAL_MS);
				this.timer.unref?.();
				void this.runSweep();
			}, FIRST_RUN_DELAY_MS);
			this.firstRun.unref?.();
			console.log("[auto-archive] 调度器已开：首轮 5 分钟后，之后每小时一轮");
		} else if (!enabled && (this.timer !== null || this.firstRun !== null)) {
			this.clearTimers();
			console.log("[auto-archive] 调度器已关：定时器清掉");
		}
	}

	private clearTimers(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.firstRun !== null) {
			clearTimeout(this.firstRun);
			this.firstRun = null;
		}
	}

	private async runSweep(): Promise<void> {
		// 每轮懒读：动态关掉的下一轮自己把定时器清掉（sync 的兜底路径）
		if (!this.enabled()) {
			this.sync();
			return;
		}
		if (this.running) return; // 上一轮还没扫完（理论上不会：一小时一轮）
		this.running = true;
		try {
			await (this.deps.sweep ?? (() => this.sweepOnce()))();
		} catch (error) {
			console.warn(
				`[auto-archive] 本轮扫描失败（下轮照常）: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.running = false;
		}
	}

	/** 一轮扫描：全量枚举 → 判定 → 归档（上限 50）。生产路径。 */
	async sweepOnce(harness?: Harness): Promise<void> {
		const harnessToUse = harness ?? (await getHarness());
		const days = archiveAutoDays();
		const cutoff = Date.now() - days * 86_400_000;
		const meta = readChatMeta();
		const archived = new Set(meta.archived);
		const pins = new Set(meta.pins);

		const chats = await harnessToUse.snapshot(Chats, CTX);
		const kinds = (await harnessToUse.snapshot(ChatKinds, CTX))?.byInternal ?? {};
		const byExternal = chats?.byExternal ?? {};

		const entries: AutoArchiveCandidateInput[] = [];
		// 单目录清单按需算：这轮一张老任务专线都没有时，一次磁盘扫描也不做
		let runDirs: string[] | null = null;
		const settledOf = (ticketId: string): boolean => {
			runDirs ??= ticketRunDirs(ticketWorkRoot());
			return ticketSettled(runDirs, ticketId);
		};
		let scanned = 0;
		for (const [externalId, internalRaw] of Object.entries(byExternal)) {
			scanned += 1;
			const internalId = Number(internalRaw);
			const task = externalId.startsWith(TASK_CONVERSATION_PREFIX);
			const worker = !task && chatKindOfInternal(internalId, kinds) === "worker";
			let lastAt: number | null = null;
			let busy = false;
			let settled = true; // 非任务专线不判这一关
			if ((worker || task) && !archived.has(externalId) && !pins.has(externalId)) {
				// 贵的判定（重放 context、开 live、读 ticket.json）只对还没被便宜关卡挡掉的算
				try {
					const stats = await readChatStats(harnessToUse, internalId);
					lastAt = stats ? stats.lastAt : null;
					if (stats && stats.lastAt < cutoff) {
						// 任务专线：单还在办就不收（在等 / 跑着的单随时会有新的进度写进来）
						if (task) settled = settledOf(externalId.slice(TASK_CONVERSATION_PREFIX.length));
						if (settled) {
							const live = await harnessToUse.snapshot(LiveDoc, internalId as never, CTX).catch(() => null);
							busy = Boolean(live?.run);
						}
					}
				} catch {
					// 单会话读失败：当空会话跳过，不挡整轮
					lastAt = null;
				}
			}
			entries.push({
				externalId,
				lastAt,
				worker,
				task,
				ticketSettled: settled,
				archived: archived.has(externalId),
				pinned: pins.has(externalId),
				busy,
			});
		}

		const { hits, skipped } = selectAutoArchiveCandidates(entries, cutoff);
		const batch = hits.slice(0, AUTO_ARCHIVE_BATCH_LIMIT);
		const at = Date.now();
		for (const hit of batch) archiveChat(hit.externalId, at);
		console.log(
			`[auto-archive] 扫描 ${scanned}：命中 ${hits.length}，归档 ${batch.length}` +
				(hits.length > batch.length ? `（上限 ${AUTO_ARCHIVE_BATCH_LIMIT}，余 ${hits.length - batch.length} 下轮继续）` : "") +
				`；跳过（非收集类 ${skipped.kind} / 单还在办 ${skipped.openTicket} / 已归档 ${skipped.archived} / ` +
				`置顶 ${skipped.pinned} / 空会话 ${skipped.empty} / 未到期 ${skipped.fresh} / 忙 ${skipped.busy}）`,
		);
	}

	/** 测试与排查用：定时器状态。 */
	timerState(): { firstRun: boolean; interval: boolean; running: boolean } {
		return {
			firstRun: this.firstRun !== null,
			interval: this.timer !== null,
			running: this.running,
		};
	}

	/** 测试注入：清定时器。 */
	resetForTest(): void {
		this.clearTimers();
		this.running = false;
	}
}

// ── 单例（index.ts 启动时 sync() 一次；flags onChange 再调）──
let scheduler: AutoArchiveScheduler | null = null;

export function autoArchiveScheduler(deps: AutoArchiveDeps = {}): AutoArchiveScheduler {
	if (deps.enabled || deps.days || deps.sweep) {
		// 注入 deps 的新实例（单测用），不换全局单例
		return new AutoArchiveScheduler(deps);
	}
	scheduler ??= new AutoArchiveScheduler();
	return scheduler;
}
