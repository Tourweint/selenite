/**
 * 例行任务条件门控（2026-11-10 批 13 §四，全景调研 #19）。
 *
 * 三件事都是**确定性纯逻辑**，单独成文件（照 cron.ts / routine-quiet.ts 的纪律）：
 *   1. `until`：模型给一句文字条件，每轮自己判断"达成没有"；判达成 → 规则置停（不删）。
 *      **不做通用表达式引擎**——文字条件由模型理解，宿主只认一个显式标记。
 *   2. `maxRuns`：跑满 N 次自动停。简单、确定、可测。
 *   3. `lastOutcome`：上一轮的结果（枚举）带给下一次触发，让规则能接着上次往下做。
 *
 * 开关 `ROUTINE_CONDITIONAL` 默认开；`false`/`0`/`off` 时新字段全部被忽略，
 * 提示词与 run 记录回到改动前（回滚一行 env）。
 */

/** 模型声明"完成条件已达成"的固定标记（回复最后单独一行）。 */
export const ROUTINE_DONE_MARKER = "[[routine-done]]";

export type RoutineOutcome = "success" | "quiet" | "skipped" | "failed" | "done";

/** 回滚开关：默认开；只有明确写 false / 0 / off 才关。 */
export function routineConditionalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.ROUTINE_CONDITIONAL ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

export interface RoutinePromptInput {
	/** 规则原文（已按上限截断） */
	prompt: string;
	/** 上一次的结局枚举；没有历史 = undefined */
	lastOutcome?: RoutineOutcome;
	/** 完成条件的文字说明 */
	untilNote?: string;
	/** 上次看到这里（游标）；只有产出被保留过才有值（批 21 §六） */
	cursorAt?: string;
	/** 开关形态：false 时两段上下文都不加（回到旧提示词） */
	conditional: boolean;
}

/**
 * 组装这一轮的提示词：`[上一次的结果]` → `[上次看到这里]` → 原文 → `[完成条件]`。
 * 顺序刻意固定：上一次的结局在前（模型先知道接着做什么），完成条件在后（最后才判停）。
 */
export function buildRoutinePrompt(input: RoutinePromptInput): string {
	if (!input.conditional) return input.prompt;
	const blocks: string[] = [];
	if (input.lastOutcome) blocks.push(`上一次的结果是 ${input.lastOutcome}。`);
	if (input.cursorAt) {
		blocks.push(`[上次看到这里] ${input.cursorAt}；这一轮只看这之后的新内容。`);
	}
	blocks.push(input.prompt);
	if (input.untilNote?.trim()) {
		blocks.push(
			`[完成条件] ${input.untilNote.trim()}\n` +
				`如果这个条件已经达成，在回复最后单独一行写 ${ROUTINE_DONE_MARKER}；没达成就不要写。`,
		);
	}
	return blocks.join("\n\n");
}

/** 从回复里认出完成标记（并把它从正文里剔除，标记本身不写进摘要）。 */
export function extractRoutineDone(raw: string): { text: string; done: boolean } {
	if (!raw.includes(ROUTINE_DONE_MARKER)) return { text: raw, done: false };
	return { text: raw.split(ROUTINE_DONE_MARKER).join("").trim(), done: true };
}

// ── 触发器的 if / ends（2026-11-10 批 21 §三）──────────────────
//
// `if` 的模型调用在 routine-gate.ts（有 I/O）；这里只放确定性部分：
// `at` 过期判定、`ends.after` 与 `maxRuns` 取更小。

export interface RoutineEndsSpec {
	at?: string;
	after?: number;
}

/** 触发器是否已过 `ends.at`（到点后不再触发）。非法时间当"没设"，不误杀老规则。 */
export function triggerEndedAt(
	trigger: { ends?: RoutineEndsSpec },
	now: number = Date.now(),
): boolean {
	const at = trigger.ends?.at;
	if (!at) return false;
	const parsed = Date.parse(at);
	return Number.isFinite(parsed) && now >= parsed;
}

/**
 * 实际生效的"跑满多少次停"：`routine.maxRuns` 与所有触发器的 `ends.after` 取更小。
 * 没有上限 = undefined（与批 13 的 maxRuns 语义一致）。
 */
export function effectiveMaxRuns(
	base: number | undefined,
	triggers: readonly { ends?: RoutineEndsSpec }[],
): number | undefined {
	let value =
		typeof base === "number" && Number.isFinite(base) && base > 0 ? Math.floor(base) : undefined;
	for (const trigger of triggers) {
		const after = trigger.ends?.after;
		if (typeof after !== "number" || !Number.isFinite(after) || after <= 0) continue;
		const next = Math.floor(after);
		value = value === undefined ? next : Math.min(value, next);
	}
	return value;
}

/**
 * 带 `if` 的触发器条件（按声明顺序去重）。
 * 多个触发器各带 `if` 时**全部成立才跑**：任一条判不成立就跳过本轮（保守口径）。
 */
export function routineConditionNotes(
	triggers: readonly { if?: { note: string } }[],
): string[] {
	const notes: string[] = [];
	for (const trigger of triggers) {
		const note = trigger.if?.note?.trim();
		if (note && !notes.includes(note)) notes.push(note);
	}
	return notes;
}

export interface RoutineRunVerdictInput {
	ok: boolean;
	quiet: boolean;
	/** 本轮无人值守跳过的工具数（>0 = outcome 记 skipped） */
	skippedToolCount: number;
	/** 模型是否声明完成条件达成（只在 conditional && until 存在时有意义） */
	untilMet: boolean;
	conditional: boolean;
	/** 跑满多少次自动停 */
	maxRuns?: number;
	/** 本轮之前已完成的次数（不含本轮） */
	completedRunsBefore: number;
}

export interface RoutineRunVerdict {
	outcome: RoutineOutcome;
	/** true = 这一轮之后要把规则置停（until 达成 / 跑满 maxRuns） */
	stop: boolean;
}

/**
 * 一轮跑完的结局与是否停表。
 *
 * 判定顺序：
 *   - 失败 → failed（失败也计数；跑满上限时照样停，但结局仍是 failed——不能把失败说成完成）；
 *   - until 达成 → done 且停（只在开关开时看）；
 *   - 跳过过步骤 → skipped（比 quiet 更该被看见）；
 *   - 安静轮 → quiet；
 *   - 其余 → success；
 *   - 最后判 maxRuns：本轮跑完正好满 N → 停；非失败结局升为 done。
 */
export function routineRunVerdict(input: RoutineRunVerdictInput): RoutineRunVerdict {
	const maxed =
		input.conditional &&
		typeof input.maxRuns === "number" &&
		input.maxRuns > 0 &&
		input.completedRunsBefore + 1 >= input.maxRuns;

	if (!input.ok) return { outcome: "failed", stop: maxed };
	if (input.conditional && input.untilMet) return { outcome: "done", stop: true };
	if (input.skippedToolCount > 0) {
		return { outcome: "skipped", stop: maxed };
	}
	if (input.quiet) return { outcome: "quiet", stop: maxed };
	return { outcome: maxed ? "done" : "success", stop: maxed };
}

// ── 游标推进时机（2026-11-10 批 21 §六，三B 后半）─────────────
//
// "上次看到哪里"的游标只在**本轮产出被保留**时推进：
//   - quiet（没内容）→ 不推进：下次还要从同一处看；
//   - skipped（工具被无人值守跳过，这一轮不算看完）→ 不推进；
//   - failed（读失败 / 模型失败）→ 不推进，且结局已记 failed（不是 quiet）。
// 游标本身是宿主侧的时间水位（上一轮被保留的 run.endedAt），不解析正文。

export interface CursorAdvanceInput {
	ok: boolean;
	quiet: boolean;
	/** 本轮被无人值守跳过的工具数（>0 = 没跑全） */
	skippedToolCount: number;
}

export function shouldAdvanceCursor(input: CursorAdvanceInput): boolean {
	return input.ok && !input.quiet && input.skippedToolCount === 0;
}

// ── 事件触发器的三件门（2026-11-10 批 15 §一，全景调研 #29）────
//
// 例行规则以前只会"事件对上了就跑"。三件门回答另外三个问题：
//   - 这件事是不是**只在这一下**发生（edge）？
//   - 数值**变化够不够大**（baseline）？
//   - 刚跑过，**现在是不是还在冷却**（cooldown）？
//
// 三者可组合，判定顺序固定：cooldown → edge → baseline → 原 match 条件。
// 只对 `event` 触发器有意义（定时触发器没有"真假跃迁"与"观测值"），
// 由 routines.ts 的 onExternalEvent 装配；本文件保持纯函数。

/** 回滚开关：默认开；只有明确写 false / 0 / off 才关。关着 = 三个字段被忽略。 */
export function routineTriggerGatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.ROUTINE_TRIGGER_GATES ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 事件触发器上的三件门（字段名与 `RoutineTrigger` 的 event 分支一致）。 */
export interface TriggerGateSpec {
	/** 比上次观测值变化超过 delta 才触发（首次记基线那次不受限）。 */
	baseline?: { key: string; delta: number };
	/** 只从假变真那一下触发（状态跃迁）。 */
	edge?: true;
	/** 触发后 N 秒内不再触发（防抖）。 */
	cooldownSec?: number;
}

/** 一条触发器记住的门状态（落 routines.json 的 gates 表）。 */
export interface TriggerGateState {
	/** cooldown 截止（epoch ms） */
	cooldownUntil?: number;
	/** edge 上一次的真假 */
	lastMatch?: boolean;
	/** baseline 上一次的观测值 */
	lastValue?: number;
}

export interface TriggerGateInput {
	spec: TriggerGateSpec;
	state?: TriggerGateState;
	/** 当前时刻（epoch ms），调用方传入以便纯函数可测 */
	now: number;
	/** 原 match 条件是否满足 */
	matched: boolean;
	/** baseline.key 对应字段的数值；缺省 / 非数字 = 无法比较 */
	observed?: number;
	/** 开关：false → 只看 matched，状态原样返回（回滚口径） */
	enabled: boolean;
}

export interface TriggerGateResult {
	fire: boolean;
	state: TriggerGateState;
}

/**
 * 三件门 + 原 match 条件的唯一判定点。
 *
 * 语义细节：
 *   - **cooldown 优先短路**：冷却期内连状态都不动（不消耗 edge、不更新基线）；
 *   - **edge** 只认 `false → true`；状态里没有历史（老规则）按"上一次是假"处理，
 *     所以新加的 edge 门第一次匹配会触发，之后要再等一次由假变真；
 *   - **baseline** 首次没有 `lastValue` 时触发并记基线；之后 `|观测-上次| > delta` 才触发。
 *     观测值不是有限数字 = 这一轮不触发（宁可漏一次，不拿脏值硬比）；
 *   - **触发时才写基线 / 冷却起点**：没触发的那几轮不改变下次比较的参照。
 */
export function evaluateTriggerGate(input: TriggerGateInput): TriggerGateResult {
	const current = input.state ?? {};
	if (!input.enabled) return { fire: input.matched, state: current };

	// 1. cooldown
	if (
		typeof input.spec.cooldownSec === "number" &&
		input.spec.cooldownSec > 0 &&
		typeof current.cooldownUntil === "number" &&
		input.now < current.cooldownUntil
	) {
		return { fire: false, state: current };
	}

	const next: TriggerGateState = { ...current };
	let fire = input.matched;

	// 2. edge
	if (input.spec.edge === true) {
		fire = fire && current.lastMatch !== true;
		next.lastMatch = input.matched;
	}

	// 3. baseline
	if (input.spec.baseline && fire) {
		const observed = input.observed;
		if (typeof observed !== "number" || !Number.isFinite(observed)) {
			fire = false;
		} else if (typeof current.lastValue === "number") {
			const threshold = Math.max(0, input.spec.baseline.delta);
			// 任务书口径是"超过 delta"：相等不算超过。
			if (Math.abs(observed - current.lastValue) <= threshold) fire = false;
		}
	}

	if (!fire) return { fire: false, state: next };

	// 4. 原 match 条件已在 fire 初值里；触发后才记基线 / 冷却起点。
	if (input.spec.baseline) next.lastValue = input.observed;
	if (typeof input.spec.cooldownSec === "number" && input.spec.cooldownSec > 0) {
		next.cooldownUntil = input.now + input.spec.cooldownSec * 1000;
	}
	return { fire: true, state: next };
}

// ── 看护单例交接（2026-11-10 批 15 §四，全景调研 #47）──────────
//
// 看护类规则（带 `until` 的"一直盯到条件达成"）**同一时刻最多一个在跑**。
// 新规则接手时，旧规则只暂停（enabled=false）并记下 handedTo，不删除——
// 避免"两个都在盯"和"盯丢了"。交接只做一次：同一对 old→new 重复经过不会
// 再写一遍 handedTo。

export interface RoutineWatchEntry {
	routineId: string;
	name: string;
	/** 接手时刻（ISO） */
	since: string;
}

export interface RoutineWatchFile {
	version: 1;
	/** key（同一执事）→ 当前看护规则 */
	watches: Record<string, RoutineWatchEntry>;
	/** 旧规则 id → 交接给的新规则 id（只记一次） */
	handedTo: Record<string, string>;
}

export function emptyRoutineWatchFile(): RoutineWatchFile {
	return { version: 1, watches: {}, handedTo: {} };
}

export interface RoutineWatchPlanInput {
	file: RoutineWatchFile;
	/** 看护的归属键：同一执事同一时刻只允许一个看护 */
	key: string;
	routineId: string;
	name: string;
	now: string;
	/** 这条规则是否仍要看护（无 until / 已停用的规则不该来认领） */
	wantsWatch: boolean;
	/** 开关：false → 原样返回，不认领、不交接 */
	enabled: boolean;
}

export interface RoutineWatchPlan {
	file: RoutineWatchFile;
	/** 有值 = 这次要把这条旧规则交接出去（调用方负责 enabled=false） */
	handoffFrom?: string;
	/** 本规则是否（仍然）是当前看护 */
	takeOver: boolean;
}

/**
 * 纯决策：这条规则此刻该不该接手看护、要不要把旧规则交接掉。
 * I/O（读文件、停旧规则）留在 routines.ts；这里只算"下一份 watch.json 长什么样"。
 */
export function planRoutineWatch(input: RoutineWatchPlanInput): RoutineWatchPlan {
	if (!input.enabled || !input.wantsWatch) {
		return { file: input.file, takeOver: false };
	}
	const current = input.file.watches[input.key];
	if (current && current.routineId === input.routineId) {
		return { file: input.file, takeOver: true };
	}

	const handedTo = { ...input.file.handedTo };
	let handoffFrom: string | undefined;
	if (current && current.routineId !== input.routineId) {
		// 已经给这位新规则交接过的，不再写第二遍（"交接只交一次"）。
		if (handedTo[current.routineId] !== input.routineId) {
			handoffFrom = current.routineId;
			handedTo[current.routineId] = input.routineId;
		}
	}

	return {
		file: {
			version: 1,
			watches: {
				...input.file.watches,
				[input.key]: { routineId: input.routineId, name: input.name, since: input.now },
			},
			handedTo,
		},
		...(handoffFrom ? { handoffFrom } : {}),
		takeOver: true,
	};
}

/** 规则停了 / 删了：把它从 watches 里摘掉（handedTo 账保留，便于追溯）。 */
export function releaseRoutineWatch(file: RoutineWatchFile, routineId: string): RoutineWatchFile {
	let changed = false;
	const watches: Record<string, RoutineWatchEntry> = {};
	for (const [key, entry] of Object.entries(file.watches)) {
		if (entry.routineId === routineId) {
			changed = true;
			continue;
		}
		watches[key] = entry;
	}
	return changed ? { ...file, watches } : file;
}
