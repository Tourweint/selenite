import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 闸门拒绝留痕（2026-11-09 保证实现纵深 §5）。
 *
 * 为什么要有：工具被 `{ block }` 拦下时，模型看得到、SSE 有事件，但**账上没有**。
 * 排查「模型为什么绕路」「哪类拦得最多」只能翻会话日志，而日志里又不许有对话内容。
 * 这里只记一行审计：时间 / 会话 / 工具名 / 类别 / 哪一道闸，**不记参数、不记正文**。
 *
 * 落点单文件 `.data/gate-blocks.jsonl`（追加写，一行一个 JSON）。
 * 开关 `AGENT_GATE_AUDIT`：false / 0 / off → 一行不写（回滚 = 加一行 env）。
 * 测试隔离用 `AGENT_GATE_AUDIT_PATH` 指到临时目录（生产不设）。
 */

/** 闸门类别枚举（与任务书 §5.2 对齐）。`routines` 目前没有拦下点，先占位。 */
export type GateBlockCategory =
	| "policy"
	| "approval"
	| "path"
	| "loop-guard"
	| "turn-limit"
	| "relay"
	| "routines";

export interface GateBlockEntry {
	at: string;
	conversationId: number;
	tool: string;
	/** 拦下的类别（枚举） */
	reason: GateBlockCategory;
	/** 具体哪一道闸（排障用，如 `policy-recheck` / `approval-rejected`） */
	source: string;
}

/** 缺省开。只认 false / 0 / off 为关；未设走默认 true（行为不变的前提下多一行账）。 */
export function gateAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.AGENT_GATE_AUDIT ?? "").trim().toLowerCase();
	if (raw === "") return true;
	return !["false", "0", "off"].includes(raw);
}

export function gateAuditPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_GATE_AUDIT_PATH?.trim() || ".data/gate-blocks.jsonl");
}

/**
 * 记一条拦下。写失败只 warn（路径与错误，不含工具参数），绝不反过来影响闸门本身。
 * 调用方负责不把参数带进来——**这是纪律，不是接口能保证的**。
 */
export function auditGateBlock(
	input: {
		conversationId: number;
		tool: string;
		category: GateBlockCategory;
		source: string;
	},
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!gateAuditEnabled(env)) return;
	const entry: GateBlockEntry = {
		at: new Date().toISOString(),
		conversationId: input.conversationId,
		tool: input.tool,
		reason: input.category,
		source: input.source,
	};
	const path = gateAuditPath(env);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		console.warn(
			`[gate-audit] 写 ${path} 失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
