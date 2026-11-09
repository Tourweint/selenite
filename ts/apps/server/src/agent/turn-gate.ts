import { approvalStore, type ApprovalOutcome, type PendingApproval } from "../approvals.ts";
import { CHIEF_PARTNER_ID } from "../partners.ts";

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

/**
 * 验证铁律（2026-11-10 批 12 §一.1，按 superpowers verification-before-completion 改写）。
 *
 * 为什么要有这一条：模型最常犯的错不是做错，是**没验就说好**——「应该能过」「上次跑过」
 * 一句话把没跑过的验证糊过去；人拿着假结论继续往下走，比直接报错贵得多。
 * 运行时闸门管不到「这句结论有没有证据」，只能把「先跑、再看、后说」钉成硬纪律。
 *
 * 固定字节：不含时间 / 会话 / 名字，开关只决定注不注。
 * 落点：总管 persona 段之后（lifecycle 的 section）与执事轮输入（partner-context；
 * 非总管执事由那里注入，lifecycle 侧跳过，避免同一段进两遍）。
 */
export const VERIFICATION_IRON_LAW = [
	"【验证铁律】",
	"- 这一轮里没有真的跑过验证，就不许说「完成了 / 修好了 / 通过了」。",
	"- 五步门：先说清「哪条命令能证明这句话」→ 真跑 → 读完整个输出（看退出码、数失败数）→ 与结论对账 → 才下结论。",
	"- 主张 ↔ 证据对照：",
	"  · 说「测试通过」→ 要有 0 失败的输出；「上次跑过」「应该能过」不算。",
	"  · 说「改好了」→ 要看到原症状已经消失；只改了代码不算。",
	"  · 说「做完了」→ 要有落盘的改动；自己说做完了不算。",
	"  · 说「要求都满足了」→ 要逐条对着清单打勾；测试全绿不算。",
	"- 红旗（出现即是在撒谎，回头去跑）：说「应该 / 大概 / 看起来没问题」；没跑就先说「很好 / 完成 / 搞定」；想「就这一次不用验」；累了想收工。",
].join("\n");

/**
 * 验证铁律归谁：总管（chief）与没有执事身份的会话由 lifecycle 的 section 注入；
 * 普通执事由 `partner-context` 注入。两个入口共用下面这对判定，
 * 单测能直接断言「谁有、谁没有」而不用起 harness。
 */

/** 执事轮输入用：只有非总管执事在这里补（总管的在 persona 段之后，避免一段进两遍）。 */
export function verificationIronLawFor(partnerId: string | null): string | undefined {
	return partnerId && partnerId !== CHIEF_PARTNER_ID ? VERIFICATION_IRON_LAW : undefined;
}

/** lifecycle section 用：总管 / 无执事身份的会话由 persona 侧负责。 */
export function lifecycleOwnsVerification(partnerId: string | null): boolean {
	return !partnerId || partnerId === CHIEF_PARTNER_ID;
}

/**
 * 裁决纪律（2026-11-10 批 12 §一.2，按 superpowers subagent-driven-development 改写）。
 *
 * 为什么要有这一条：执行方最贵的浪费不是做错，是**停下来等一句「要不要继续」**——
 * 人的一天被切成十几个确认回合。纪律的落点是「四停之外自己裁决 + 留一行账」：
 * 人靠那行账事后推翻，而不是靠事前逐个点头。
 *
 * 固定字节；落点两处：执事轮输入（partner-context）与 `delegate` 工具描述尾部。
 */
export const RULING_DISCIPLINE = [
	"【裁决纪律】",
	"- 继续干，别反复请示：「要不要我继续」是在浪费人的一天；计划里的事一口气做完。",
	"- 只有四种情况停下问人：① 不可逆或破坏性的操作；② 安全敏感的动作；③ 工作目录之外的副作用（合并、推共享分支、发布）；④ 计划烂到往前每一步都是猜。",
	"- 四停之外一律自己裁决，并记一行账：`裁决：<决定了什么> — <为什么> — <错了的代价>`；写进给主人的汇报或任务单留言，让人事后看得见、能推翻。",
	"- 一个错的裁决，人看得见、也能让我改；一个卡着等回答的会话，花掉的是人一整天。",
].join("\n");

/**
 * 同类失败三次后的接管提示（2026-11-10 批 12 §一.4）。
 *
 * 为什么要有：运行时只认得「同一次工具调用重复」与「重派次数」，认不出
 * 「同一来源在同一类别上连着栽三次」。到第三次，继续换花样试的收益已经低于
 * 把决定权交回人手里；文案只说事实与出路，不评价模型。
 *
 * 固定字节（「3」是阈值不是动态内容）；`AGENT_TAKEOVER_HINT=false` 时调用方不追加。
 */
export const TAKEOVER_HINT = "这类问题已经连着 3 次没解决，建议你来接手，或者换个说法重新派一次。";

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
