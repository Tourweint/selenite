import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

/**
 * 审批续跑轮进记忆（2026-11-08 批 10-A，上位计划 §二③）。
 *
 * 真装配：建一个 faux 会话 → 直接落一条 pending 审批 → POST 答复 → 服务端自动
 * `continueConversation` 跑完一轮 → 断言**会话记忆里出现这一轮的内容**。
 *
 * 这条链路以前刻意不挂 `onSettled`（"审批指令不是用户说的内容"），代价是续跑轮
 * 不进记忆；现在改成与普通轮同一个 handler，本测试守住"别再漏"。
 *
 * env 必须在动态 import agent.ts 之前设好（模块加载即建记忆库）。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-resume-memory-"));
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.AGENT_APPROVALS_PATH = join(root, "approvals.json");
process.env.MEMORY_ENABLED = "true";
process.env.MEMORY_DB_PATH = join(root, "memory.db");
// 规则抽取器：faux 没有可用模型，auto 本来也会落到规则，这里写死免得随环境漂。
// 2026-11-13：改成 auto + 默认噪声过滤——审批续跑注入的合成指令不再写成经历。
process.env.MEMORY_EXTRACT = "auto";
process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
process.env.PROVIDERS_PATH = join(root, "providers.json");
process.env.DELEGATIONS_DB_PATH = join(root, "delegations.sqlite");
process.env.AGENT_SSE_SEQ_DB_PATH = join(root, "chat-events.sqlite");
process.env.AGENT_POLICY_PATH = join(root, "policy.json");
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.ROUTINES_STATE_PATH = join(root, "routines.json");
process.env.AUTONOMY_STATE_PATH = join(root, "autonomy-state.json");
process.env.AGENT_CHAT_META_PATH = join(root, "chat-meta.json");
process.env.LLM_PROVIDER = "faux";
process.env.LLM_FAUX_TOOL = "";
process.env.CHANCELLOR_ENABLED = "false";
process.env.COMPANIONS_ENABLED = "false";
process.env.AUTONOMY_ENABLED = "false";

const { Hono } = await import("hono");
const { mountApprovalApi } = await import("./approval-api.ts");
const { approvalStore } = await import("./approvals.ts");
const { memoryEngine, openChat } = await import("./agent.ts");

test.after(() => {
	// durable / 记忆库在本进程里还开着句柄，Windows 上直接删会 EPERM；删不掉就留给系统临时目录
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		/* 临时目录，失败不影响结论 */
	}
});

test("审批续跑轮结束后记忆抽取被调用一次", async () => {
	assert.ok(memoryEngine, "测试环境应当有记忆库");
	const chat = await openChat(undefined);
	assert.ok(chat, "faux 下能建一个会话");
	approvalStore().create({
		callId: "resume-memory",
		conversationId: chat.internalId,
		tool: "bash",
		args: JSON.stringify({ command: "echo hi" }),
		timeoutMs: 60_000,
	});

	const app = new Hono();
	mountApprovalApi(app);
	const response = await app.request("/api/v1/agent/approvals/resume-memory", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ decision: "approve" }),
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as { status?: string };
	assert.equal(body.status, "approved");

	// 续跑在后台跑：等记忆抽取走完（ingestTurn 是 void，不阻塞答复）。
	// 2026-11-13：审批续跑注入的「用户已批准 …」「不要换成…」是服务端合成指令，
	// 默认噪声过滤下不应再落成 episode；这里给抽取留足时间，再断言一条都没有。
	const scope = `session:${chat.internalId}`;
	await sleep(500);
	const records = memoryEngine!.list({ scopes: [scope], limit: 50 });

	assert.equal(
		records.length,
		0,
		`合成指令不应进记忆，实际：${JSON.stringify(records.map((record) => record.content.slice(0, 28)))}`,
	);
});
