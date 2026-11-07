import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * E2 #0：GET /agent/approvals 两个投影透出 ApprovalRecord.origin（自主轮标记），
 * undefined 不带键。真挂 Hono + 真开一次 faux 会话（externalChatIds 要 uuid 映射），
 * 全部用临时目录，不碰 .data/。env 在动态 import agent.ts 之前设好（模块加载即读路径）。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-approval-api-"));
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.AGENT_APPROVALS_PATH = join(root, "approvals.json");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
process.env.PROVIDERS_PATH = join(root, "providers.json");
process.env.DELEGATIONS_DB_PATH = join(root, "delegations.sqlite");
process.env.AGENT_SSE_SEQ_DB_PATH = join(root, "chat-events.sqlite");
process.env.AGENT_POLICY_PATH = join(root, "policy.json");
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.ROUTINES_STATE_PATH = join(root, "routines.json");
process.env.AUTONOMY_STATE_PATH = join(root, "autonomy-state.json");
process.env.LLM_PROVIDER = "faux";
process.env.MEMORY_ENABLED = "false";
process.env.CHANCELLOR_ENABLED = "false";
process.env.COMPANIONS_ENABLED = "true";

const { Hono } = await import("hono");
const { mountApprovalApi } = await import("./approval-api.ts");
const { approvalStore } = await import("./approvals.ts");
const { openChat } = await import("./agent.ts");

test("审批投影：全局待办与按会话都透出 origin；普通轮不带键", async () => {
	const chat = await openChat(undefined);
	assert.ok(chat, "faux 下能建一个会话");

	const store = approvalStore();
	store.create({
		callId: "api-auto",
		conversationId: chat.internalId,
		tool: "bash",
		args: "{}",
		timeoutMs: 60_000,
		origin: "autonomous",
	});
	store.create({
		callId: "api-plain",
		conversationId: chat.internalId,
		tool: "bash",
		args: "{}",
		timeoutMs: 60_000,
	});

	const app = new Hono();
	mountApprovalApi(app);

	const globalBody = (await (
		await app.request("/api/v1/agent/approvals")
	).json()) as { approvals: Array<Record<string, unknown>> };
	const autoGlobal = globalBody.approvals.find((item) => item.callId === "api-auto");
	const plainGlobal = globalBody.approvals.find((item) => item.callId === "api-plain");
	assert.equal(autoGlobal?.origin, "autonomous", "全局待办投影透出 origin");
	assert.ok(plainGlobal && !("origin" in plainGlobal), "普通轮全局投影不带 origin 键");

	const perChatBody = (await (
		await app.request(
			`/api/v1/agent/approvals?conversationId=${encodeURIComponent(chat.externalId)}`,
		)
	).json()) as { approvals: Array<Record<string, unknown>> };
	const autoPerChat = perChatBody.approvals.find((item) => item.callId === "api-auto");
	const plainPerChat = perChatBody.approvals.find((item) => item.callId === "api-plain");
	assert.equal(autoPerChat?.origin, "autonomous", "按会话投影透出 origin");
	assert.ok(plainPerChat && !("origin" in plainPerChat), "普通轮按会话投影不带 origin 键");
	// 2026-11-08 批三：按会话投影也带对外 conversationId（前端据此标「来自 …」）
	assert.equal(autoPerChat?.conversationId, chat.externalId, "按会话投影透出 conversationId");
	assert.equal(plainPerChat?.conversationId, chat.externalId);
});
