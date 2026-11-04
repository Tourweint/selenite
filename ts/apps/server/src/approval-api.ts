import type { Hono } from "hono";
import { chatTitles, externalChatIds, openChat } from "./agent.ts";
import { approvalStore } from "./approvals.ts";
import { readLlmConfig } from "./provider.ts";

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
				callId: record.callId,
				tool: record.tool,
				args: record.args,
				deadlineAt: record.deadlineAt,
				createdAt: record.createdAt,
			}));
		return c.json({ ok: true, approvals });
	});

	app.post("/api/v1/agent/approvals/:callId", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { decision?: string; remember?: unknown }
			| null;
		const decision = body?.decision;
		if (decision !== "approve" && decision !== "reject") {
			return c.json({ error: "bad_request", message: "decision 只能是 approve / reject" }, 400);
		}

		const callId = c.req.param("callId").trim();
		const record = approvalStore().decide(callId, decision, body?.remember === true);
		if (!record) return c.json({ ok: false, error: "unknown_approval" }, 404);

		// 已决的再发一次也回 200 + 原状态（幂等：不二次结算、不二次唤醒钩子）
		return c.json({ ok: true, status: record.status });
	});
}
