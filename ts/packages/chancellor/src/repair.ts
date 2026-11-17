import type { Review, TaskRun, TicketOutcomeStatus } from "./types.ts";

/**
 * 验收「核对-修复」循环（2026-11-09 保证实现纵深 §1）。
 *
 * 背景：验收快照（D13）核对一次，不合格就交人。行业做法是把这一步做成循环：
 * 失败 → 带着**验收原话**自动修一轮 → 再核；轮次有上限，到了还不行才交人。
 *
 * 落点（与任务书 T0 的判断一致）：循环在 `runChancellor` 的收尾处，**同一张单**重跑
 * （不改单号、不建父/子单），所以不需要改 `delegate`、也不需要宿主二次派单；
 * `decideAfterReview` 仍是纯函数，派单判断不进去。
 *
 * 这里只放纯逻辑（轮次读取 / 该不该修 / 修复 requirement 拼装），
 * 让单测能直接断言；有副作用的重跑与目录归档留在 `index.ts`。
 */

export const ACCEPT_ROUNDS_ENV = "DELEGATION_ACCEPT_ROUNDS";
/** 默认 1 轮；0 = 关闭（回到旧行为，逐字节一致）。 */
export const DEFAULT_ACCEPT_ROUNDS = 1;

/**
 * 读 `DELEGATION_ACCEPT_ROUNDS`。**0 是合法值**（旧行为），所以不能用现有的
 * `readPositiveInt`（它把 0 当非法回落默认值）。
 * 未设 / 空串 / 非数字 → 默认 1；负数 → 0（宁可关掉，也不做负数轮）。
 */
export function acceptRounds(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[ACCEPT_ROUNDS_ENV];
	if (raw === undefined || raw.trim() === "") return DEFAULT_ACCEPT_ROUNDS;
	const value = Number(raw.trim());
	if (!Number.isFinite(value)) return DEFAULT_ACCEPT_ROUNDS;
	return Math.max(0, Math.floor(value));
}

/**
 * 这一轮失败后该不该自动修。`repairRound` = 已经修过的轮数（0 起）。
 * 0 轮上限 → 永远 false（单测断言：与今天逐字节一致）。
 */
export function shouldStartRepair(
	status: TicketOutcomeStatus,
	repairRound: number,
	maxRounds: number,
): boolean {
	if (status !== "failed") return false;
	if (maxRounds <= 0) return false;
	return repairRound < maxRounds;
}

/** 压成一行并截断（验收 reason 可能带换行 / 长 stderr 尾巴）。 */
function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function verdictLabel(verdict: Review["verdict"]): string {
	if (verdict === "fail") return "失败";
	if (verdict === "blocked") return "卡住";
	return "通过";
}

export interface RepairPromptInput {
	/** 原始要求（第一轮那张单的 prompt） */
	requirement: string;
	/** 这是第几轮返工（1 起） */
	round: number;
	/** 上一轮验收结论（全部 review；通过项也会列出，用来告诉模型"别重做"） */
	reviews: Review[];
	/** 上一轮的执行结果（拿声明路径与变更情况） */
	runs: TaskRun[];
	/**
	 * 裁判复核意见（2026-11-10 批 14）：验收判 fail 时裁判自己查过工作区给出的
	 * 具体下一步。比机械的"0 个变更"更能指导返工；不传 = 旧提示词逐字节一致。
	 */
	judgeReason?: string;
}

/**
 * 拼修复轮的 requirement。
 *
 * 必须包含三样（任务书 §1.1/§1.4）：
 *   1. 上一单验收结论的**原话**（不是"请修一下"）；
 *   2. 声明路径逐项状态（哪些变了、哪些没变）；
 *   3. "只修这些，别重做"。
 * 再把原始要求附在最后，避免修复轮丢了上下文。
 */
export function buildRepairRequirement(input: RepairPromptInput): string {
	const lines: string[] = [];
	lines.push(`## 上轮验收未通过（第 ${input.round} 轮返工）`);
	lines.push("上一轮已经执行完，结论如下。**只修下面未通过的部分，不要把已经通过的部分重做。**");
	lines.push("");
	for (const review of input.reviews) {
		lines.push(
			`- 任务 ${review.seq}（${review.slug}）：${verdictLabel(review.verdict)}：${oneLine(review.reason, 400)}`,
		);
	}
	if (input.reviews.length === 0) lines.push("- （上一轮没有验收记录；按原始要求重做未完成的部分）");

	lines.push("", "## 声明路径逐项状态");
	const pathLines: string[] = [];
	for (const run of input.runs) {
		const writes = run.task.writes ?? [];
		if (writes.length === 0) continue;
		const changed = new Set(run.changedPaths ?? []);
		const detected = Array.isArray(run.changedPaths);
		for (const declaredPath of writes) {
			const state = !detected
				? "未检测（按未变更处理，本轮必须补上）"
				: changed.has(declaredPath)
					? "已变更（保留它，不要重做）"
					: "未变更（本轮必须补上）";
			pathLines.push(`- ${declaredPath}：${state}`);
		}
	}
	if (pathLines.length === 0) pathLines.push("- （上一轮没有声明要写的路径）");
	lines.push(...pathLines);

	// 裁判意见（2026-11-10 批 14 §2.5）：放在"要求"之前，因为它是对"差在哪"更具体的一次定性。
	// 不传时整段省略——旧调用方的提示词逐字节不变。
	const judgeReason = input.judgeReason?.trim();
	if (judgeReason) {
		lines.push(
			"",
			"## 裁判复核意见（独立会话查过工作区，不是执行者自报）",
			oneLine(judgeReason, 800),
		);
	}

	lines.push(
		"",
		"## 要求",
		"只处理上面未通过的部分：缺的补上、错的改正；已经通过或已正确变更的内容不要重写。",
		"完成后照常写 REPORT.md 收尾。",
		"",
		"## 原始要求",
		input.requirement,
	);
	return lines.join("\n");
}

/** 最后一轮失败的原话（给「已自动修 N 轮仍失败」的文案用；取第一条 fail）。 */
export function lastFailReason(reviews: Review[]): string {
	const failed = reviews.find((review) => review.verdict === "fail");
	return oneLine(failed?.reason ?? "（没有验收结论）", 240);
}

/**
 * 轮次用完仍失败时给宿主的那一行（§1.2：必须带"已修几轮 + 最后一轮验收原话"）。
 * 抽出来是为了单测能直接断言文案，不必起整个 runChancellor。
 */
export function renderAcceptLimitLine(
	ticketId: string,
	rounds: number,
	reason: string,
): string {
	return `⚠ [${ticketId}] 已自动修 ${rounds} 轮仍失败，原文：${oneLine(reason, 240)}`;
}
