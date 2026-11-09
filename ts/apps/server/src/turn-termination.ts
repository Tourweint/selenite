/**
 * 条件终止清单（2026-11-10 批 16 §四；全景调研二 §2.3）。
 *
 * 一句话：这一轮**什么情况下必须停**。清单存在的理由是"别把停当成故障"——
 * 每一停都有明确落点与可核对的理由，模型 / 外壳 / 人看到同一句话时知道该去找哪段代码，
 * 而不是笼统地"好像卡住了"。
 *
 * 这只是可核对的表，**不做运行时联动**：运行时各机制在自己的文件里已经生效，
 * 这份表只保证"写下来的入口真的存在"（`turn-termination.test.ts` 逐个断言文件存在，
 * 防清单腐化——文件改名 / 机制删掉时这张表必须同步）。
 *
 * 字段：
 *   - `key`：稳定标识（小写下划线），日志 / 文档 / 将来事件字段用它；
 *   - `label`：给人看的一句话；
 *   - `where`：落点文件，**相对 `ts/apps/server/src/`**；
 *   - `note`：为什么停 / 停了之后是什么状态（固定字节，不含日期与编号）。
 */
export interface TerminationCondition {
	key: string;
	label: string;
	where: string;
	note: string;
}

export const TERMINATION_CONDITIONS: readonly TerminationCondition[] = [
	{
		key: "max_turns",
		label: "回合上限",
		where: "agent/turn-gate.ts",
		note: "一轮里请求模型的次数撞到 AGENT_MAX_TURNS（默认 100，0 = 不限）。停掉的是这一轮，用户再发一句即新一轮、预算重算。",
	},
	{
		key: "user_cancel",
		label: "用户取消",
		where: "agent/session.ts",
		note: "人按了停止（stopChat）：先把挂着的审批按 aborted 结算，再向本轮发 abort；排队的输入撤回，之后再说一句就是新一轮。",
	},
	{
		key: "permission_denied",
		label: "权限拒绝",
		where: "approval-policy.ts",
		note: "人明确拒绝这次调用（或策略 block 优先命中）。只停这一个调用，本轮其余工作继续；拒绝理由按 denialReason 回给模型。",
	},
	{
		key: "approval_timeout",
		label: "审批超时",
		where: "approval-policy.ts",
		note: "blocking 形态下等待超过 AGENT_APPROVAL_TIMEOUT_S（默认 120 秒）按拒绝处理（fail-closed）；async 形态 pending 不过期，超时只影响展示。",
	},
	{
		key: "tool_output_truncated",
		label: "工具输出截断",
		where: "agent/shared.ts",
		note: "工具结果超过 TOOL_OUTPUT_LIMIT（2000 字符）只保留前段并标注剩余字数。不能再据此宣称「读完了」；要全文就换读取方式，不许脑补被截掉的部分。",
	},
	{
		key: "model_retry_exhausted",
		label: "模型重试上限",
		where: "reliability.ts",
		note: "上游连续失败，内核重试（默认 3 次 / 2s 起步 / 60s 封顶）用尽后本轮失败。宿主只透传旋钮，不改重试语义。",
	},
	{
		key: "loop_guard_interrupt",
		label: "防打转铁证",
		where: "loop-guard.ts",
		note: "同一模式重复 / 原地打转 / 读写轮转撞到铁证时中断本轮，不靠模型自述「我知道了」。",
	},
	{
		key: "compaction_failed",
		label: "上下文压缩失败",
		where: "agent/session.ts",
		note: "压缩任务受理后超过 AGENT_COMPACT_WAIT_MS（默认 60 秒）没等到终局：受理仍有效，但这一轮不能假装上下文已经变小，如实说「压缩还没完成」。",
	},
] as const;
