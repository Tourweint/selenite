import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 总管建群探针（2026-11-07 群组入口统一）：真起服务 + 真 HTTP + faux 固定工具调用。
 *
 * 验的是"模型侧真的够得到 group_manage"这件事——单元测试只证明工具函数的逻辑，
 * 这里证明它在真实会话里被注册、被调用、参数被正确解析、群真的落库。
 *
 * 场景：
 *   1. GROUPS_ENABLED=false：同一句话不产生群（工具没注册 = 一行回滚）
 *   2. 默认开：总管会话里调 group_manage create → 群里两位成员、值日 = 第一位
 *   3. list：回读口径写清成员与值日，且不回显 uuid
 *   4. 执事会话里调同一条 → 拒（只有总管可以建群）
 *
 *   pnpm --filter @lifediary/server group-manage
 */

const PORT = 8237;
const TOKEN = "probe-token";

function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) process.exitCode = 1;
}

interface Phase {
	root: string;
	child: ChildProcess;
}

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
}

async function startServer(extraEnv: Record<string, string>): Promise<Phase> {
	const root = mkdtempSync(join(tmpdir(), "lifediary-group-manage-probe-"));
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		env: {
			...process.env,
			PORT: String(PORT),
			AGENT_TOKEN: TOKEN,
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			AGENT_DB_PATH: join(root, "agent.sqlite"),
			MEMORY_ENABLED: "false",
			MEMORY_DB_PATH: join(root, "memory.db"),
			PROJECTS_DB_PATH: join(root, "projects.sqlite"),
			PROVIDERS_PATH: join(root, "providers.json"),
			DELEGATIONS_DB_PATH: join(root, "delegations.sqlite"),
			AGENT_SSE_SEQ_DB_PATH: join(root, "chat-events.sqlite"),
			AUTONOMY_ENABLED: "false", // 探针显式关（默认已于 2026-11-13 翻成开）
			AGENT_APPROVALS_PATH: join(root, "approvals.json"),
			AGENT_POLICY_PATH: join(root, "policy.json"),
			PARTNERS_DB_PATH: join(root, "partners.sqlite"),
			PARTNER_HOMES_ROOT: join(root, "partner-homes"),
			ROUTINES_STATE_PATH: join(root, "routines.json"),
			AUTONOMY_STATE_PATH: join(root, "autonomy-state.json"),
			COMPANIONS_ENABLED: "true",
			CHANCELLOR_ENABLED: "false",
			AGENT_MAX_TURNS: "1",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	// 日志只留错误行，避免把 faux 的用量行刷满
	child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`  [server!] ${chunk}`));

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (res.ok) return { root, child };
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) throw new Error("服务 30 秒没起来");
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

async function stopServer(phase: Phase): Promise<void> {
	phase.child.kill();
	await new Promise((resolve) => setTimeout(resolve, 400));
	try {
		rmSync(phase.root, { recursive: true, force: true });
	} catch {
		/* Windows 句柄延迟 */
	}
}

async function api(
	method: string,
	path: string,
	body: unknown,
): Promise<{ status: number; body: any }> {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
		method,
		headers: authHeaders(),
		...(body === null ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	let parsed: any = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = { raw: text.slice(0, 200) };
	}
	return { status: res.status, body: parsed };
}

/**
 * 收一条完整 SSE 流。
 *
 * faux 的固定应答是"永远只调工具、不写正文"，所以断言不能看 text（那条路走不到），
 * 要看工具结果本身：`tool` 事件的 end 帧带 output（服务端拼好的、模型看到的文字）。
 * 回合上限压到 2，避免 faux 无限重放同一次调用把防打转守卫刷成铁证中断。
 */
async function chat(text: string, conversationId?: string): Promise<{
	status: number;
	text: string;
	tools: string[];
	outputs: string[];
	conversationId?: string;
}> {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/agent/chat`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			messages: [{ role: "user", content: text }],
			...(conversationId ? { conversationId } : {}),
		}),
	});
	const raw = await res.text();
	const out = { status: res.status, text: "", tools: [] as string[], outputs: [] as string[], conversationId };
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		let ev: any;
		try {
			ev = JSON.parse(line.slice(5).trim());
		} catch {
			continue;
		}
		if (ev.type === "delta" && typeof ev.text === "string") out.text += ev.text;
		if (ev.type === "tool" && ev.status === "start" && typeof ev.name === "string") out.tools.push(ev.name);
		if (ev.type === "tool" && ev.status === "end" && typeof ev.output === "string") out.outputs.push(ev.output);
		if (ev.type === "start" && ev.conversationId) out.conversationId = ev.conversationId;
	}
	return out;
}

async function main(): Promise<void> {
	// ── 阶段一：关掉群组 = 工具不注册，模型没手可用 ──
	const off = await startServer({
		GROUPS_ENABLED: "false",
		LLM_FAUX_TOOL: "group_manage",
		LLM_FAUX_ARGS: JSON.stringify({ action: "create", name: "不该出生", members: ["阅读助手", "记账助手"] }),
	});
	try {
		await api("POST", "/api/v1/partners", { name: "阅读助手" });
		await api("POST", "/api/v1/partners", { name: "记账助手" });
		const offChat = await chat("帮我建个群");
		check(
			"GROUPS_ENABLED=false：group_manage 不注册（模型调不到）",
			!offChat.tools.includes("group_manage"),
			`tools=${offChat.tools.join(",") || "（无）"}`,
		);
	} finally {
		await stopServer(off);
	}

	// ── 阶段二：默认开，总管会话里真的建出群 ──
	const server = await startServer({
		LLM_FAUX_TOOL: "group_manage",
		LLM_FAUX_ARGS: JSON.stringify({
			action: "create",
			name: "书房小事",
			members: ["阅读助手", "记账助手"],
			notice: "每天晚饭后对一遍明天的事",
		}),
	});
	try {
		for (const name of ["阅读助手", "记账助手"]) await api("POST", "/api/v1/partners", { name });
		const said = await chat("把 阅读助手 和 记账助手 拉个群，叫书房小事");
		check("总管会话里模型调到了 group_manage", said.tools.includes("group_manage"), `tools=${said.tools.join(",")}`);

		const groups = await api("GET", "/api/v1/groups", null);
		const list = (groups.body.groups ?? []) as any[];
		check("群真的落库了（1 个）", list.length === 1, `count=${list.length}`);
		const group = list[0];
		check("群名与公告正确", group?.name === "书房小事" && group?.notice === "每天晚饭后对一遍明天的事");
		check(
			"两位成员都进群",
			(group?.members ?? []).length === 2 &&
				((group?.members ?? []) as any[]).map((m) => m.name).join(",") === "阅读助手,记账助手",
			`members=${((group?.members ?? []) as any[]).map((m) => m.name).join(",")}`,
		);
		check(
			"值日缺省 = 第一位成员（阅读助手）",
			((group?.members ?? []) as any[]).find((m) => m.partnerId === group?.responderPartnerId)?.name ===
				"阅读助手",
		);
	} finally {
		await stopServer(server);
	}

	// ── 阶段三：list 口径 + 执事会话拒建 ──
	const listPhase = await startServer({
		LLM_FAUX_TOOL: "group_manage",
		LLM_FAUX_ARGS: JSON.stringify({ action: "list" }),
	});
	try {
		const created = await api("POST", "/api/v1/partners", { name: "阅读助手" });
		await api("POST", "/api/v1/partners", { name: "记账助手" });
		const partnerId = created.body.partner?.id as string;
		const partner2 = (await api("GET", "/api/v1/partners", null)).body.partners.find(
			(p: any) => p.name === "记账助手",
		).id;
		const group = await api("POST", "/api/v1/groups", {
			name: "书房小事",
			memberIds: [partnerId, partner2],
			responderKind: "member",
			responderPartnerId: partnerId,
		});
		const groupId = group.body.group?.id as string;

		const listChat = await chat("现在有哪些群");
		const listOut = listChat.outputs.join("|");
		check(
			"list 回读写清成员与值日",
			listOut.includes("书房小事") && listOut.includes("值日 阅读助手"),
			listOut.trim().slice(0, 80),
		);
		check("list 不回显执事 uuid", !listOut.includes(partnerId) && !listOut.includes(groupId));

		// 执事会话：先让群跑一轮，把成员会话真的建出来（group-runtime 懒建），
		// 再从那条 partner-<id>-group-<gid> 会话里调同一条——没跑过的话它还不存在，
		// POST 会新开一条无主会话（回落总管），测的就不是"执事会话"了。
		await fetch(`http://127.0.0.1:${PORT}/api/v1/groups/${groupId}/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ text: "报到" }),
		}).then((res) => res.text());
		const partnerChat = await chat("帮我建个群", `partner-${partnerId}-group-${groupId}`);
		const partnerOut = partnerChat.outputs.join("|");
		check(
			"执事会话里建群被拒（只有总管可以建群）",
			partnerOut.includes("只有总管可以建群"),
			partnerOut.trim().slice(0, 80),
		);
		const after = await api("GET", "/api/v1/groups", null);
		check("被拒后群数量不变（没有半个群）", (after.body.groups ?? []).length === 1);
	} finally {
		await stopServer(listPhase);
	}

	console.log(process.exitCode ? "✗ 总管建群探针有失败项" : "✓ 总管建群探针全部通过");
}

await main();
