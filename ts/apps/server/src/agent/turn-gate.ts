import { approvalStore, type ApprovalOutcome, type PendingApproval } from "../approvals.ts";

/**
 * 等一次审批：答复 / 超时 / 本轮中止，谁先到算谁。
 *
 * 超时与中止都要落终态（fail-closed）——否则状态文件里会留下一条"看起来还能批"的 pending，
 * 刷新页面又把它挂出来。`promise` 由 store 在 decide / expire 时结算，这里只补超时与 abort 两路。
 */
export function waitForApproval(
	pending: PendingApproval,
	timeoutS: number,
	signal: AbortSignal | undefined,
): Promise<ApprovalOutcome> {
	return new Promise<ApprovalOutcome>((resolve) => {
		let done = false;
		const finish = (status: ApprovalOutcome) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(status);
		};
		const onAbort = () => {
			approvalStore().expire(pending.record.callId, "aborted");
			finish("aborted");
		};
		const timer = setTimeout(() => {
			approvalStore().expire(pending.record.callId, "timeout");
			finish("timeout");
		}, timeoutS * 1000);
		void pending.promise.then(finish);
		// abortSignal 可能在挂上之前就已经 aborted（/stop 与钩子同刻发生）
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 一轮对话最多几个工具回合。默认 100（实测 30 偏紧，hermes 那类给到 300）。
 *
 * 定 100 的取舍：这个数字是"一次提问里，模型最多能来回几次"。
 * 日常记录、查资料用不到 10 轮；真要做"整理一整个目录"这种活，
 * 30 会半路截断，100 基本够；再高就要开始担心一次对话跑十几分钟没人管。
 * 撞到上限不是死路——用户再发一句就是新一轮、预算重算。
 *
 * 为什么要有：客户端断开之后那一轮还在跑（见 chatStream），
 * 没人看着的时候如果模型陷进"读文件 → 又读文件"的循环，它会一直烧 token，
 * 而没有任何人在场能按下停止。上限是唯一不需要人盯着的兜底。
 *
 * 为什么是自己实现：pi-durable 1.4.0 **没有** `maxTurns`（那是上游 main 里的东西，
 * 还没发版）。所以这里用"数一数这个 run 请求了几次模型"来做等价限制 ——
 * 一次请求 = 一个工具回合。设 0 表示不限。
 *
 * TODO(pi-durable)：等用的版本带上 `maxTurns` 之后，这一整套可以整段删掉。
 * 要删的地方一共四处：
 *   1. MAX_TURNS / TURN_LIMIT_* / runTurns / limitHits / toolsBlocked / aborting 这些常量和状态
 *   2. beforeTool 里开头那个 `toolsBlocked.has(...)` 分支
 *   3. beforeRequest 里"数回合 + 撞上限"那段（记忆注入要留着）
 *   4. chatStream 结尾那个 `limitHits` 比较 + `turnLimit` 事件
 * 然后把 `agent: { model }` 改成 `agent: { model, maxTurns: 30 }` 即可。
 * 换句话说：这不是一个要长期维护的机制，是一次性的补丁。
 */
export const MAX_TURNS = (() => {
	const raw = Number(process.env.AGENT_MAX_TURNS ?? 100);
	if (!Number.isFinite(raw) || raw < 0) return 100;
	return Math.floor(raw);
})();

/** 撞上限时给用户看的话 */
export const TURN_LIMIT_MESSAGE = "工具调用已达到上限，请重新发送请求。";

/** 撞上限之后告诉模型的：别再动手了，用人话收尾 */
export const TURN_LIMIT_INSTRUCTION =
	`本轮的可用工具调用次数已经用完（上限 ${MAX_TURNS} 次）。` +
	"不要再调用任何工具，直接用已经拿到的信息回答；" +
	"如果信息确实不够，就照实说明缺什么，并请对方重新发送请求。";

/** 每个 run 已经用掉的回合数。key = `会话id:run任务id`，进程内有效 */
export const runTurns = new Map<string, number>();
/** 撞过上限的会话 → 自增序号（聊天流靠它判断"这一轮是不是撞了"） */
export const limitHits = new Map<number, number>();
/** 撞上限后暂时封掉工具的会话 */
export const toolsBlocked = new Set<number>();
/**
 * 撞上限之后还赖着不走的，再给几次机会就硬停。
 *
 * 正常模型收到"别再调工具了"就会收尾；但万一它不听（或者 provider 抽风），
 * 光是"工具被拦住"还不够——它仍然会一轮一轮地请求模型，照样烧钱。
 * 所以这里必须有一条不依赖模型自觉的出路。
 */
export const HARD_STOP_GRACE = 3;
export const aborting = new Set<string>();

/**
 * 防打转守卫的铁证拦截话术（2026-11-05 批次A A1）。
 *
 * 与回合上限正交（那边管总量、这边管同质重复），措辞对齐 TURN_LIMIT_INSTRUCTION：
 * 别再动手，用已有信息收尾。疑似（未到铁证）只进日志不发帧——客户端没有消费场景，
 * 要放行时按"纯增量事件"口径加（批次A细化 §3.2）。
 */
export const LOOP_GUARD_BLOCK_MESSAGE =
	"已连续重复完全相同的工具调用且没有任何进展，工具被暂停。" +
	"请直接用已经拿到的信息回答；确实缺信息就照实说明，不要继续重复同一个调用。";

// ── 审批话术（2026-11-08 扫尾批 8c）────────────────────────

/**
 * 新形态下被挂起的工具调用回给模型的答复（本轮不阻塞）。
 *
 * 三件事必须说清：为什么没执行 / 别原样重试（faux 与部分真实模型会立刻重试，
 * 重试只会再挂一条同样的待批）/ 现在能做什么。批准后的续跑由服务端 followUp 触发，
 * 模型不用自己等。
 */
export const APPROVAL_WAITING_MESSAGE =
	"这个操作在等用户批准，本轮没有执行。不要原样重试（重试也只会继续等）；" +
	"你可以先把不需要批准的部分做完，或者直接告诉用户在等批准。批准后我会继续。";

/** 参数摘要进提示词前压成一行、限长（审批记录里的是 1200 字符的 JSON） */
function inlineArgs(args: string): string {
	const one = args.replace(/\s+/g, " ").trim();
	if (!one) return "";
	return one.length > 300 ? `${one.slice(0, 300)}…` : one;
}

/**
 * 批准后自动提交给会话的 followUp 指令（人类可读；它会落成一条 user 消息）。
 *
 * 明确要求"原样重发"：闸门按 tool + 参数指纹核销，改参数就不会命中 —— 与其让模型
 * 猜为什么又被拦，不如直说。
 */
export function approvalApprovedInstruction(tool: string, args: string): string {
	const summary = inlineArgs(args);
	return (
		`用户已批准 \`${tool}\`${summary ? `：${summary}` : ""}——` +
		"立即重新发起同一个工具调用（工具与参数保持完全一致），完成后继续原本的工作。" +
		"不要换成别的工具或别的参数。"
	);
}

/** 用户答复了 ask_user 的问题后自动提交的 followUp（2026-11-09 §3.1） */
export function askUserAnsweredInstruction(answer: string): string {
	return (
		`主人回答了你刚才的问题：\n${answer}\n` +
		"按这个回答继续；不要再问同一个问题，也不要原样重问。"
	);
}

/**
 * 拒绝后自动提交的 followUp 指令：别卡死，也别原样硬顶。
 *
 * `feedback`（2026-11-09 §4.1）：拒绝时人附的指导语。带了就把「你拒绝了这次 X 调用。
 * 主人的要求：<feedback>」原样交给模型；不带时**逐字节等于**旧文案。
 */
export function approvalRejectedInstruction(tool: string, feedback?: string): string {
	const note = feedback?.trim();
	if (note) return `你拒绝了这次 ${tool} 调用。主人的要求：${note}`;
	return (
		`用户拒绝了 \`${tool}\`：这个调用不要执行，也不要原样重试。` +
		"请继续其余工作，能做多少做多少；确实有必要换个做法，就提出新的调用（它仍会重新征求用户批准）。"
	);
}
