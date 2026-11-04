import { createHash } from "node:crypto";

/**
 * 工具防打转守卫（2026-11-05 批次A A1）。
 *
 * 参考实现：cindy `agents/shared/loop-guard.ts`（阈值是那边踩坑调出来的，照抄不改；
 * "辅助模型复核"属 v1 明确不做，见批次A细化方案 §一）。与本仓回合上限（AGENT_MAX_TURNS）
 * 正交：上限管"总量"，这里管"同质重复"——模型陷在"读文件 → 又读同一个文件"的循环里时，
 * 回合数可能远没到上限，但 token 一直在烧。
 *
 * 判据（两级）：
 *   铁证 → beforeTool 直接拦下（block），模型必须用已有信息回答；
 *   疑似 → 只打日志（v1 不对外发帧，客户端无消费场景；要放行时按"纯增量事件"口径加）。
 *
 * 指纹两级：`name+args`（call 指纹，pingpong/轮转用）与 `name+args+结果摘要`
 * （full 指纹，"完全相同"判据用）。豁免：距上次调用 ≥30s 的节奏轮询不计入
 * （等任务、看日志是合法行为，不能误杀）；只统计顶层调用（嵌套调用不喂，防放大误判）。
 *
 * 纯类零 IO：状态全在实例里，注册表（loopGuardFor）也只在内存——一轮一个实例，
 * 新一轮由 beforeRequest 的 used===1 分支重置。崩溃丢状态无所谓：守卫是护栏不是账本。
 */

/** 铁证 1：同一指纹（含结果）连续这么多次 → 拦 */
const IDENTICAL_INTERRUPT = 30;
/** 铁证 2：同一指纹持续这么久还在重复 → 拦（cindy：同结果持续 60 分钟） */
const STALE_MS = 60 * 60_000;
/** 铁证 3：读类窗口（本仓读类工具只有 read，128 窗口对它是"128 次读"） */
const READ_WINDOW = 128;
const READ_DISTINCT_LIMIT = 32;
const READ_MAX_REPEAT = 4;
/** 疑似 1：同一指纹连续这么多次（4）→ 告警 */
const STREAK_WARN = 4;
/** 疑似 2：12 次滑窗 distinct ≤2（pingpong） */
const PINGPONG_WINDOW = 12;
const PINGPONG_DISTINCT = 2;
/** 疑似 3：16 次滑窗 distinct ≤4（轮转） */
const ROTATION_WINDOW = 16;
const ROTATION_DISTINCT = 4;
/** 节奏轮询豁免：距上次调用 ≥30s 不计入重复判据 */
const RHYTHM_GAP_MS = 30_000;
/** 读类工具（pi-durable CodingTools 里唯一的只读工具；自有工具全是写/派生，不在此列） */
const READ_TOOLS = new Set(["read"]);
/** 结果摘要截断：结果太长时只取头部做指纹（内容不同摘要大概率不同，足够判重） */
const OUTPUT_DIGEST_LIMIT = 200;

export type LoopGuardPattern = "repeat" | "stale" | "read-rotation" | "pingpong" | "rotation";

export interface LoopGuardHit {
	pattern: LoopGuardPattern;
	/** 命中时的关键计数（连续次数 / 窗口 distinct） */
	count: number;
}

/** beforeTool 喂进来；返回 interrupt 表示铁证，调用方应当 block 这次调用。 */
export type LoopGuardBefore = "ok" | ({ verdict: "interrupt" } & LoopGuardHit);
/** afterTool 喂进来；返回 warn 表示疑似，调用方只记日志。 */
export type LoopGuardAfter = "ok" | ({ verdict: "warn" } & LoopGuardHit);

export class LoopGuard {
	/** 最近一次 full 指纹（连续相同判据的锚点） */
	private lastFullFp = "";
	private streak = 0;
	private streakFirstAt = 0;
	/** 最近一次 call 指纹（判断"这次调用是不是还在重复同一件事"） */
	private lastCallFp = "";
	/** call 指纹滑窗（pingpong / 轮转判据） */
	private callWindow: string[] = [];
	/** 读类调用的 full 指纹窗（长读轮转判据） */
	private readWindow: string[] = [];
	private lastCallAt = 0;
	/** 每种疑似只在实例生命周期内告警一次，不然日志会被刷爆 */
	private warned = new Set<LoopGuardPattern>();

	/** 一次节奏豁免（≥30s 间隔）把窗口清空重来：慢节奏的重复是合法轮询 */
	private rhythmReset(): void {
		this.callWindow = [];
		this.readWindow = [];
		this.streak = 0;
		this.lastFullFp = "";
		this.lastCallFp = "";
		this.warned.clear();
	}

	before(name: string, args: unknown): LoopGuardBefore {
		const now = Date.now();
		if (this.lastCallAt && now - this.lastCallAt >= RHYTHM_GAP_MS) this.rhythmReset();
		this.lastCallAt = now;

		const callFp = callFingerprint(name, args);
		if (this.streak >= IDENTICAL_INTERRUPT) {
			return { verdict: "interrupt", pattern: "repeat", count: this.streak };
		}
		if (
			this.streak >= 2 &&
			this.lastCallFp === callFp &&
			now - this.streakFirstAt >= STALE_MS
		) {
			return { verdict: "interrupt", pattern: "stale", count: this.streak };
		}
		if (READ_TOOLS.has(name) && this.readWindow.length >= 32) {
			const distinct = new Set(this.readWindow).size;
			const maxRepeat = Math.max(...tally(this.readWindow).values());
			if (distinct <= READ_DISTINCT_LIMIT && maxRepeat >= READ_MAX_REPEAT) {
				return {
					verdict: "interrupt",
					pattern: "read-rotation",
					count: distinct,
				};
			}
		}
		return "ok";
	}

	after(
		name: string,
		args: unknown,
		result: { isError?: boolean; output?: unknown },
	): LoopGuardAfter {
		const callFp = callFingerprint(name, args);
		const fullFp = `${callFp}|${resultDigest(result)}`;

		if (fullFp === this.lastFullFp) {
			this.streak += 1;
		} else {
			this.streak = 1;
			this.streakFirstAt = Date.now();
		}
		this.lastFullFp = fullFp;
		this.lastCallFp = callFp;

		this.callWindow.push(callFp);
		if (this.callWindow.length > ROTATION_WINDOW) this.callWindow.shift();
		if (READ_TOOLS.has(name)) {
			this.readWindow.push(fullFp);
			if (this.readWindow.length > READ_WINDOW) this.readWindow.shift();
		}

		// 疑似告警：每种 pattern 只报一次（v1 只进日志，见文件头）
		if (this.streak === STREAK_WARN && !this.warned.has("repeat")) {
			this.warned.add("repeat");
			return { verdict: "warn", pattern: "repeat", count: this.streak };
		}
		if (!this.warned.has("pingpong") && this.callWindow.length === PINGPONG_WINDOW) {
			const distinct = new Set(this.callWindow).size;
			if (distinct <= PINGPONG_DISTINCT) {
				this.warned.add("pingpong");
				return { verdict: "warn", pattern: "pingpong", count: distinct };
			}
		}
		if (!this.warned.has("rotation") && this.callWindow.length === ROTATION_WINDOW) {
			const distinct = new Set(this.callWindow).size;
			if (distinct <= ROTATION_DISTINCT) {
				this.warned.add("rotation");
				return { verdict: "warn", pattern: "rotation", count: distinct };
			}
		}
		return "ok";
	}

	/** 新一轮开始（beforeRequest 的 used===1 分支调用）：判据全部清零 */
	reset(): void {
		this.lastFullFp = "";
		this.lastCallFp = "";
		this.streak = 0;
		this.streakFirstAt = 0;
		this.callWindow = [];
		this.readWindow = [];
		this.lastCallAt = 0;
		this.warned.clear();
	}
}

// ── 会话级注册表（进程内，一轮一实例）──────────────────────
const guards = new Map<number, LoopGuard>();

export function loopGuardFor(conversationId: number): LoopGuard {
	let guard = guards.get(conversationId);
	if (!guard) {
		guard = new LoopGuard();
		guards.set(conversationId, guard);
	}
	return guard;
}

export function resetLoopGuard(conversationId: number): void {
	guards.get(conversationId)?.reset();
}

/** 回滚开关：只有明确写 false/0 才关；不配 = 开。每次读 env，单测可在同进程切。 */
export function loopGuardEnabled(): boolean {
	const raw = process.env.TOOL_LOOP_GUARD?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

// ── 指纹 ─────────────────────────────────────────────────
/** 对象键排序后序列化（args 键序不稳会让指纹漂移） */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function callFingerprint(name: string, args: unknown): string {
	return `${name}:${stableStringify(args ?? null)}`;
}

function resultDigest(result: { isError?: boolean; output?: unknown }): string {
	const head = stableStringify(result.output ?? null);
	return createHash("sha256")
		.update(`${result.isError ? "1" : "0"}|${head.slice(0, OUTPUT_DIGEST_LIMIT)}`)
		.digest("hex")
		.slice(0, 16);
}

function tally(values: string[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
	return map;
}
