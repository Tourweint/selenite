import type { Hono } from "hono";
import { chatTitles, externalChatIds, openChat } from "./agent.ts";
import { approvalMode } from "./agent/policy.ts";
import { continueConversation } from "./agent/session.ts";
import {
	approvalApprovedInstruction,
	approvalRejectedInstruction,
	askUserAnsweredInstruction,
} from "./agent/turn-gate.ts";
import { approvalStore } from "./approvals.ts";
import { onAskAnswered } from "./escalation.ts";
import { readLlmConfig } from "./provider.ts";
import { questionOfArgs, recordVerifiedAnswer } from "./verified-answer.ts";
import { snapshotPath } from "./world-state.ts";

/**
 * 审批接口（2026-11-04 批次二，A1；批次六加全局待办）。
 *
 * 为什么单独成文件：照 delegation-api.ts 的 mount 模式——路由只做"换 id、校验、转调 store"，
 * 审批语义留在 approvals.ts / agent.ts。口径照 /say：503 / 404 / 400 各归其位。
 *
 * **store 的 key 是内部自增 id**：
 *   - 带 `conversationId`（原语义）先用对外 uuid 过 `openChat` 换一次；
 *   - 不带 / 空串 = 全局待办，反查 `Chats.byExternal` 一次拿全部映射，标题只读 chat-meta.json。
 */
export function mountApprovalApi(app: Hono): void {
	app.get("/api/v1/agent/approvals", async (c) => {
		if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);

		const conversationId = (c.req.query("conversationId") ?? "").trim();
		const rawLimit = Number(c.req.query("limit") ?? 50);
		const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 50;

		if (!conversationId) {
			// 全局待办（2026-11-04 批次六）：跨会话、只回 pending、按 createdAt 升序。
			// 不逐会话 openChat：title 只认改名表，取不到就省略（界面显示「未命名会话」）。
			const records = approvalStore().pendingAll();
			// 手机轮询很频繁：没有待办就不碰 durable（省一次快照）
			if (records.length === 0) return c.json({ ok: true, approvals: [], limit });
			const external = await externalChatIds();
			const titles = chatTitles();
			const approvals: Record<string, unknown>[] = [];
			for (const record of records) {
				if (approvals.length >= limit) break;
				const externalId = external.get(record.conversationId);
				// 没有对外 uuid 的内部会话不露头（宁可少一条，也不编一个 id）
				if (!externalId) continue;
				approvals.push({
					conversationId: externalId,
					...(titles[externalId] ? { chatTitle: titles[externalId] } : {}),
					callId: record.callId,
					tool: record.tool,
					args: record.args,
					deadlineAt: record.deadlineAt,
					createdAt: record.createdAt,
					// ask_user 的问题卡（2026-11-09）：纯增量；老客户端按普通审批处理。
					...(record.kind ? { kind: record.kind } : {}),
					// 自主轮标记纯增量透出（E2 #0）：undefined 不带键，老客户端忽略。
					...(record.origin ? { origin: record.origin } : {}),
				});
			}
			return c.json({ ok: true, approvals, limit });
		}

		const chat = await openChat(conversationId);
		if (!chat) return c.json({ error: "unknown_conversation" }, 404);

		// 只回 pending：这是"刷新后补挂"用的，已决的没必要再挂出来
		const approvals = approvalStore()
			.pendingOf(chat.internalId)
			.map((record) => ({
				// 2026-11-08 批三：带上对外会话 id，让前端能给审批卡标「来自 …」
				// （与全局形态同名字段；纯增量，老客户端忽略）。
				conversationId,
				callId: record.callId,
				tool: record.tool,
				args: record.args,
				deadlineAt: record.deadlineAt,
				createdAt: record.createdAt,
				// ask_user 的问题卡（2026-11-09）：纯增量；老客户端按普通审批处理。
				...(record.kind ? { kind: record.kind } : {}),
				// 自主轮标记纯增量透出（E2 #0）：undefined 不带键，老客户端忽略。
				...(record.origin ? { origin: record.origin } : {}),
			}));
		return c.json({ ok: true, approvals });
	});

	app.post("/api/v1/agent/approvals/:callId", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { decision?: string; remember?: unknown; feedback?: unknown }
			| null;
		const decision = body?.decision;
		if (decision !== "approve" && decision !== "reject") {
			return c.json({ error: "bad_request", message: "decision 只能是 approve / reject" }, 400);
		}
		// 拒绝带指导语（2026-11-09 §4.2）：可选，≤500 字；不填 = 旧行为。
		const feedback = typeof body?.feedback === "string" ? body.feedback.trim() : "";
		if (feedback.length > 500) {
			return c.json(
				{ error: "bad_request", message: "feedback 最多 500 字" },
				400,
			);
		}

		const callId = c.req.param("callId").trim();
		// ask_user 的答复走 /answer（§4.4）：approve/reject 对它没有语义。
		const before = approvalStore().recordOf(callId);
		if (!before) return c.json({ ok: false, error: "unknown_approval" }, 404);
		if (before.kind === "ask_user") {
			return c.json(
				{
					ok: false,
					error: "ask_user_answer_required",
					message: "这是一个提问，请走 POST /api/v1/agent/approvals/:callId/answer 答复",
				},
				400,
			);
		}
		// 先记"这次答复之前是不是 pending"：幂等重发不能重复开一轮续跑
		const wasPending = before.status === "pending";
		// 世界状态（批 19 §七）：批准这一刻重拍目标指纹（创建 pending 时的旧快照会被覆盖），
		// 执行前再比对——"批准之后被改过"才算数。只在创建时拍过快照的 write / edit 上发生。
		const approvedWorldState =
			decision === "approve" && before.worldState
				? snapshotPath(before.worldState.path)
				: undefined;
		const record = approvalStore().decide(
			callId,
			decision,
			body?.remember === true,
			decision === "reject" ? feedback : undefined,
			approvedWorldState,
		);
		if (!record) return c.json({ ok: false, error: "unknown_approval" }, 404);

		// 2026-11-08 扫尾批 8c：async 形态下答复即触发续跑——
		// 批准 → 让模型重发那个调用（闸门按 one-shot 放行清单核销）；
		// 拒绝 → 让模型继续别的工作。blocking 形态靠钩子里 waitForApproval 自己醒，不能重复开轮。
		if (
			wasPending &&
			approvalMode() === "async" &&
			(record.status === "approved" || record.status === "rejected")
		) {
			const text =
				record.status === "approved"
					? approvalApprovedInstruction(record.tool, record.args)
					: approvalRejectedInstruction(record.tool, record.feedback);
			void continueConversation(record.conversationId, text);
		}

		// 已决的再发一次也回 200 + 原状态（幂等：不二次结算、不二次唤醒钩子）
		return c.json({ ok: true, status: record.status });
	});

	// ask_user 的答复（2026-11-09 §3.1 / §4.4）：同一张 pending 表，单独的语义。
	// 答复正文会作为 followUp 交回模型；不带 approval 的批准/拒绝含义。
	app.post("/api/v1/agent/approvals/:callId/answer", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { answer?: unknown } | null;
		const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
		if (!answer) {
			return c.json({ error: "bad_request", message: "需要 answer" }, 400);
		}
		if (answer.length > 1000) {
			return c.json({ error: "bad_request", message: "answer 最多 1000 字" }, 400);
		}

		const callId = c.req.param("callId").trim();
		const before = approvalStore().recordOf(callId);
		if (!before) return c.json({ ok: false, error: "unknown_approval" }, 404);
		if (before.kind !== "ask_user") {
			return c.json(
				{ ok: false, error: "not_a_question", message: "这条待办不是提问，请走审批答复" },
				400,
			);
		}
		const wasPending = before.status === "pending";
		const record = approvalStore().answer(callId, answer);
		if (!record) return c.json({ ok: false, error: "unknown_approval" }, 404);
		// 幂等：重复答复不重复续跑
		if (wasPending && record.status === "answered") {
			// 决策上报升级链（2026-11-19 批2）：这张 ask 卡是工人上报升级给主人的，
			// 答复要经批1 插话通道直接投回 worker（复用 /answer 一个答复口，不造第二套问答）；
			// 就不再给总管续跑一轮（总管已把拍板权交出，再续只会重复作答）。
			// 不在关联表里 → 普通提问，走既有续跑。
			const escalationHandled = await onAskAnswered(callId, answer);
			if (!escalationHandled) {
				// 答案沉淀（2026-11-10 批 19 §二）：人亲口答过的问题下次不用再问。
				// 只落记忆，不改答复语义；群会话与开关关闭都在 recordVerifiedAnswer 内旁路。
				recordVerifiedAnswer({
					conversationId: record.conversationId,
					question: questionOfArgs(before.args),
					answer: record.answer ?? answer,
				});
				void continueConversation(record.conversationId, askUserAnsweredInstruction(answer));
			}
		}
		return c.json({ ok: true, status: record.status });
	});
}
