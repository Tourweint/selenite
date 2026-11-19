import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { approvalStore } from "./approvals.ts";
import { approvalTimeoutSeconds } from "./approval-policy.ts";
import { flagEnabled } from "./flags.ts";
import { emitDelegation } from "./delegation.ts";
import { encodeToolResult, err, ok } from "./tool-result.ts";

/**
 * 结构化提问 `ask_user`（2026-11-09 保证实现纵深 §3）。
 *
 * 为什么单独成模块：校验 / 落 pending / 工具定义三件事必须共用一份口径
 * （工具 `execute` 与 `beforeTool` 拦截两条入口都要走同一套校验），
 * 而 tools.ts 已经是个桶，别再往里塞一份。
 *
 * 形态：借**既有审批 pending 管线**（`.data/approvals.json`），记录 `tool=ask_user`、
 * `kind=ask_user`；`args` 是校验后的问题 JSON（问题 + 选项 + 建议项），供客户端渲染。
 * 答复走 `POST /api/v1/agent/approvals/:callId/answer`，不是 approve/reject。
 *
 * 刻意不进 `WRITE_TOOLS` / `DEFAULT_CRITICAL_TOOLS`：它不写盘、不起进程，
 * 而且它本来就必然等一个人答复，再套一层审批是套娃（见 approval-policy.ts 注释）。
 */

export const ASK_USER_TOOL_NAME = "ask_user";

/** 一次一问：题 ≥1 字且 ≤200 字；选项 2-3 个、每个 1-60 字；建议项必须在范围内。 */
export const ASK_USER_QUESTION_MAX = 200;
export const ASK_USER_OPTION_MAX = 60;
export const ASK_USER_OPTIONS_MIN = 2;
export const ASK_USER_OPTIONS_MAX = 3;

/** 工具上架开关（默认 true；false / 0 / off → 不注册 = 一行回滚）。 */
export function askUserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("AGENT_ASK_USER", env);
}

/** 挂起后回给模型的那句话：本轮收尾，别重问、别自己替人答。 */
export const ASK_USER_WAITING_MESSAGE =
	"问题已交给用户，本轮先收尾。不要重复问，也不要自己替用户回答；" +
	"用户答复后我会把答复交回给你。";

export interface AskUserArgs {
	question: string;
	options: string[];
	recommended?: number;
}

export type AskUserValidation =
	| { ok: true; value: AskUserArgs }
	| { ok: false; message: string };

/**
 * 参数校验（纯函数，单测直接断言）。超限直接报错、**不建 pending**。
 * 认不出的形状一律拒绝——宁可让模型改一次参数，也不要在卡片上显示半个问题。
 */
export function validateAskUserArgs(raw: unknown): AskUserValidation {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, message: "ask_user 需要一个对象参数 { question, options?, recommended? }" };
	}
	const value = raw as { question?: unknown; options?: unknown; recommended?: unknown };
	const question = typeof value.question === "string" ? value.question.trim() : "";
	if (!question) return { ok: false, message: "question 不能为空" };
	if (question.length > ASK_USER_QUESTION_MAX) {
		return { ok: false, message: `question 最多 ${ASK_USER_QUESTION_MAX} 字（当前 ${question.length}）` };
	}

	let options: string[] = [];
	if (value.options !== undefined && value.options !== null) {
		if (!Array.isArray(value.options)) {
			return { ok: false, message: "options 必须是字符串数组" };
		}
		if (
			value.options.length < ASK_USER_OPTIONS_MIN ||
			value.options.length > ASK_USER_OPTIONS_MAX
		) {
			return {
				ok: false,
				message: `options 必须 ${ASK_USER_OPTIONS_MIN}-${ASK_USER_OPTIONS_MAX} 个（互斥选项）`,
			};
		}
		for (const item of value.options) {
			if (typeof item !== "string") {
				return { ok: false, message: "options 里每一项都必须是字符串" };
			}
			const text = item.trim();
			if (!text) return { ok: false, message: "options 里不能有空选项" };
			if (text.length > ASK_USER_OPTION_MAX) {
				return { ok: false, message: `每个选项最多 ${ASK_USER_OPTION_MAX} 字` };
			}
			options.push(text);
		}
		if (new Set(options).size !== options.length) {
			return { ok: false, message: "options 里有重复项；互斥选项应当各不相同" };
		}
	}

	let recommended: number | undefined;
	if (value.recommended !== undefined && value.recommended !== null) {
		if (!options.length) {
			return { ok: false, message: "recommended 只在给了 options 时才有意义" };
		}
		if (
			typeof value.recommended !== "number" ||
			!Number.isInteger(value.recommended) ||
			value.recommended < 0 ||
			value.recommended >= options.length
		) {
			return {
				ok: false,
				message: `recommended 必须是 0-${options.length - 1} 的整数（options 的下标）`,
			};
		}
		recommended = value.recommended;
	}

	return {
		ok: true,
		value: { question, options, ...(recommended !== undefined ? { recommended } : {}) },
	};
}

/** pending 的 args 摘要（与 toolArgs 同口径：一行 JSON，≤1200 字，前端据此渲染问题卡）。 */
export function askUserArgsSummary(value: AskUserArgs): string {
	const json = JSON.stringify(value);
	return json.length > 1200 ? `${json.slice(0, 1199)}…` : json;
}

export type AskUserPendingResult =
	| { ok: true; callId: string }
	| { ok: false; message: string };

/**
 * 校验并落一条 pending。同一会话已有 pending 提问时拒绝（一次一问）。
 * 错误只回给模型，不建记录、不发事件。
 */
export function createAskUserPending(input: {
	conversationId: number;
	callId: string;
	args: unknown;
}): AskUserPendingResult {
	const validation = validateAskUserArgs(input.args);
	if (!validation.ok) return { ok: false, message: validation.message };

	const store = approvalStore();
	const existing = store
		.pendingOf(input.conversationId)
		.find((record) => record.kind === "ask_user");
	if (existing) {
		return { ok: false, message: "已经有一个问题在等用户回答；一次只问一个，等答复了再问。" };
	}

	const timeoutS = approvalTimeoutSeconds(process.env);
	const pending = store.create({
		callId: input.callId,
		conversationId: input.conversationId,
		tool: ASK_USER_TOOL_NAME,
		args: askUserArgsSummary(validation.value),
		timeoutMs: timeoutS * 1000,
		kind: "ask_user",
	});
	// 与审批同一通道：客户端把 tool=ask_user 的画成问题卡（SSE 契约不改，question 在 args 里）
	emitDelegation(input.conversationId, {
		type: "approval",
		callId: pending.record.callId,
		tool: pending.record.tool,
		args: pending.record.args,
		deadlineAt: pending.record.deadlineAt,
	});
	return { ok: true, callId: pending.record.callId };
}

/**
 * 工具定义。正常路径由 `lifecycle.ts` 的 beforeTool 拦下来建 pending（本轮直接收尾）；
 * 这里的 execute 是兜底：别的装配（探针 / 老宿主）没有那道钩子时也能工作。
 */
export function createAskUserTool(): ToolRegistration {
	return defineTool({
		name: ASK_USER_TOOL_NAME,
		description:
			"向用户提一个结构化问题，等他回答后再继续。只在**真有分叉**时问：" +
			"两条都合理的路线要人选、缺一个只有他知道的事实、要不要动一件不可逆的事。" +
			// 选项 / recommended 的格式只在参数里（2026-11-18 去重）。
			"**一次只问一个**；**能从文件 / 记忆 / 工具查到的事实先自己查，别问人**；" +
			"也不要拿它问确认（要批准的操作走审批）。" +
			"用户的回答会影响整张任务单时，用 delegate 的 resume 把答复交回去。",
		parameters: Type.Object({
			question: Type.String({
				description: `要问的一句话，≤${ASK_USER_QUESTION_MAX} 字`,
			}),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: `2-3 个互斥选项，每个 ≤${ASK_USER_OPTION_MAX} 字；没有明确选项时省略`,
				}),
			),
			recommended: Type.Optional(
				Type.Number({ description: "建议项在 options 里的下标（0 起）；可选" }),
			),
		}),
		execute: async (args, api) => {
			const created = createAskUserPending({
				conversationId: Number(api.conversationId),
				callId: api.callId,
				args,
			});
			// 统一返回契约（批 16 §一）：新工具走 ToolResult，旧工具不动。
			const result = created.ok
				? ok({ status: "waiting", callId: created.callId, message: ASK_USER_WAITING_MESSAGE })
				: err(
						"ask_user_rejected",
						created.message,
						"改一次参数再问；能从文件 / 记忆 / 工具查到的事实先自己查，别问人。",
					);
			return { output: [{ type: "text" as const, text: encodeToolResult(result) }] };
		},
	});
}
