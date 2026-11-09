/**
 * 同类失败连击记账（2026-11-10 批 12 §一.4，对应差距条目七 #6 = 三#5）。
 *
 * 为什么要有：现有两套计数都不是这个语义——loop-guard 数的是「完全相同的工具调用」
 * 且每轮清零（`lifecycle.ts` 的 resetLoopGuard），delegation-receipts 的
 * countRetries / countResumes 数的是重派 / 续跑次数。它们都回答不了
 * 「同一个来源在同一个类别上连着栽了几次」——而那正是该把决定权交回人手里的信号。
 *
 * 形状：纯状态、可序列化（Serialize / restore），不碰文件、不读时间、不写日志。
 * 落盘与清理交给调用方；进程内单例只做一次低成本计数，重启即清零——
 * 「连续」本来就该跟着进程走，把一份临时连击写进磁盘反而会让旧失败阴魂不散。
 */

/** 连到几次算「该建议人接管」。 */
export const FAILURE_STREAK_THRESHOLD = 3;

/**
 * 失败类别：取现有枚举的粗分。
 * - `tool-error`：工具执行报错；
 * - `timeout`：等待 / 执行超时；
 * - `rejected`：审批被拒；
 * - `needs_you`：派单停在等人；
 * - `unresolved`：终态失败 / 中止（跑完了但没解决）。
 */
export const FAILURE_CATEGORIES = [
	"tool-error",
	"timeout",
	"rejected",
	"needs_you",
	"unresolved",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** 可序列化快照：键 = `来源\0类别`，值 = 连续失败次数；hinted = 已经提示过的键。 */
export interface FailureStreakSnapshot {
	counts: Record<string, number>;
	hinted: string[];
}

const SEP = "\u0000";

function keyOf(source: string, category: FailureCategory): string {
	return `${source}${SEP}${category}`;
}

/** 从序列化键里拆回 (来源, 类别)；来源里万一含分隔符，按**最后**一个拆。 */
function splitKey(key: string): { source: string; category: string } {
	const at = key.lastIndexOf(SEP);
	if (at < 0) return { source: key, category: "" };
	return { source: key.slice(0, at), category: key.slice(at + 1) };
}

export class FailureStreak {
	private counts = new Map<string, number>();
	/** 已提示过的键：一次连击只建议一次（成功清零后重新武装）。 */
	private hinted = new Set<string>();

	/**
	 * 记一次失败，返回当前连击数与「是否该建议接管」。
	 *
	 * `suggestTakeover` 只在**刚好达到阈值的那一次**为 true（之后继续保持计数，
	 * 但不重复刷提示）。调用方再叠加开关决定要不要落文案。
	 */
	recordFailure(
		source: string,
		category: FailureCategory,
	): { count: number; suggestTakeover: boolean } {
		const key = keyOf(source, category);
		const count = (this.counts.get(key) ?? 0) + 1;
		this.counts.set(key, count);
		if (count >= FAILURE_STREAK_THRESHOLD && !this.hinted.has(key)) {
			this.hinted.add(key);
			return { count, suggestTakeover: true };
		}
		return { count, suggestTakeover: false };
	}

	/**
	 * 成功一次即清零。按来源清**全部**类别：这个来源已经不卡了，
	 * 还留着别的类别的旧连击会在下一次小故障时误报「连着三次」。
	 */
	recordSuccess(source: string): void {
		const prefix = `${source}${SEP}`;
		for (const key of [...this.counts.keys()]) {
			if (key.startsWith(prefix)) this.counts.delete(key);
		}
		for (const key of [...this.hinted]) {
			if (key.startsWith(prefix)) this.hinted.delete(key);
		}
	}

	/** 读当前连击数（不改变状态；单测与观察用）。 */
	countOf(source: string, category: FailureCategory): number {
		return this.counts.get(keyOf(source, category)) ?? 0;
	}

	serialize(): FailureStreakSnapshot {
		return {
			counts: Object.fromEntries(this.counts),
			hinted: [...this.hinted],
		};
	}

	static restore(snapshot: FailureStreakSnapshot): FailureStreak {
		const streak = new FailureStreak();
		for (const [key, count] of Object.entries(snapshot.counts ?? {})) {
			const { source, category } = splitKey(key);
			if (!source || !(FAILURE_CATEGORIES as readonly string[]).includes(category)) continue;
			if (!Number.isInteger(count) || count <= 0) continue;
			streak.counts.set(key, count);
		}
		for (const key of snapshot.hinted ?? []) {
			if (streak.counts.has(key)) streak.hinted.add(key);
		}
		return streak;
	}
}

const shared = new FailureStreak();

/** 进程内单例：派单结算直接用它（不落盘，见文件头）。 */
export function failureStreak(): FailureStreak {
	return shared;
}

/**
 * 接管提示开关（2026-11-10 批 12 §一.4.5）：默认开，`false` / `0` / `off` 关。
 * 关掉 = 连击照常记（观察用），只是不把那句话追加到卡片与汇报里。
 */
export function takeoverHintEnabled(): boolean {
	const raw = process.env.AGENT_TAKEOVER_HINT?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}
