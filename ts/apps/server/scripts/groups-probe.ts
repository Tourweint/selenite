import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSseDecoder } from "@lifediary/shared";

/**
 * 群组探针（2026-11-06 群组方案 §四）：真起服务 + 真 HTTP + 真 SSE。
 *
 * 场景：
 *   1. `GROUPS_ENABLED=false` / `COMPANIONS_ENABLED=false`：群端点 404（双开关口径）
 *   2. faux 全链路：建群校验（人数 2–6 / 值日必选 / 值日必须是成员 / 重名拒绝）
 *      → 发消息（值日回）→ @点名（按正文顺序串行）→ @所有人（全员按 position）
 *      → 改名撞重名后 @ → 400 歧义拒绝不猜 → 回读分页（beforeSeq）→ stop（幂等 200）
 *      → 成员暂停：跳过并落 system 行
 *
 *   pnpm --filter @lifediary/server groups
 */

const PORT = 8196;
const ROOT = mkdtempSync(join(tmpdir(), "lifediary-groups-probe-"));

function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
	// ── 阶段一：双开关回滚口径 ──
	const offGroups = await startServer({ GROUPS_ENABLED: "false", LLM_PROVIDER: "faux" });
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/groups`, { headers: authHeaders() });
		check("GROUPS_ENABLED=false：群端点 404（未启用语义）", res.status === 404, `status=${res.status}`);
	} finally {
		await stopServer(offGroups);
	}
	const offCompanions = await startServer({ COMPANIONS_ENABLED: "false", LLM_PROVIDER: "faux" });
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/groups`, { headers: authHeaders() });
		check("COMPANIONS_ENABLED=false：群端点同样 404（成员都没了）", res.status === 404, `status=${res.status}`);
	} finally {
		await stopServer(offCompanions);
	}

	// ── 阶段二：faux 全链路 ──
	const server = await startServer({ LLM_PROVIDER: "faux" });
	try {
		// 7 名执事：3 个主角 + 4 个凑「超上限」用
		const ids: string[] = [];
		const names = ["阅读助手", "记账助手", "小斋", "甲", "乙", "丙", "丁"];
		for (const name of names) {
			const created = await api("POST", "/api/v1/partners", { name });
			if (created.status !== 201) throw new Error(`建执事 ${name} 失败`);
			ids.push(created.body.partner.id as string);
		}
		const [shu, mo, zhai] = ids;

		// ── 建群校验 ──
		const tooFew = await api("POST", "/api/v1/groups", { name: "人不够", memberIds: [shu] });
		check("1 名成员：400（下限 2）", tooFew.status === 400, `status=${tooFew.status}`);
		const tooMany = await api("POST", "/api/v1/groups", {
			name: "人太多",
			memberIds: ids,
		});
		check("7 名成员：400（上限 6）", tooMany.status === 400, `status=${tooMany.status}`);
		const noDuty = await api("POST", "/api/v1/groups", {
			name: "没值日",
			memberIds: [shu, mo, zhai],
		});
		check("kind=member 缺值日：400（值日必选，用户拍板）", noDuty.status === 400);
		const dutyOutside = await api("POST", "/api/v1/groups", {
			name: "值日在群外",
			memberIds: [shu, mo],
			responderPartnerId: zhai,
		});
		check("值日不是成员：400", dutyOutside.status === 400);

		// 正常建群：值日 = 记账助手
		const created = await api("POST", "/api/v1/groups", {
			name: "探针群",
			notice: "这是群公告",
			memberIds: [shu, mo, zhai],
			responderKind: "member",
			responderPartnerId: mo,
		});
		check(
			"建群：201 且带成员投影与值日",
			created.status === 201 &&
				created.body.group?.responderPartnerId === mo &&
				created.body.group?.members?.length === 3,
			`status=${created.status}`,
		);
		const groupId = created.body.group?.id as string;

		// ── 发消息：无 @ → 值日回 ──
		const round1 = await postSse(`/api/v1/groups/${groupId}/chat`, { text: "大家报个到" });
		const starts1 = round1.events.filter((e) => e.type === "start");
		const done1 = round1.events.find((e) => e.type === "done");
		check(
			"值日制无 @：只有值日发言（start.sender=记账助手）",
			starts1.length === 1 && starts1[0]?.sender?.name === "记账助手",
			`starts=${starts1.map((s) => s.sender?.name).join(",")}`,
		);
		check(
			"值日轮有 delta 与收尾 done",
			round1.events.some((e) => e.type === "delta") && done1?.finishReason === "stop",
		);
		const timeline1 = await api("GET", `/api/v1/groups/${groupId}/messages`, null);
		const msgs1 = timeline1.body.messages ?? [];
		check(
			"时间线：主人消息在前、值日应答在后（作者快照）",
			msgs1[0]?.authorKind === "user" &&
				msgs1[msgs1.length - 1]?.authorKind === "partner" &&
				msgs1[msgs1.length - 1]?.authorName === "记账助手",
			`条数=${msgs1.length}`,
		);

		// ── @点名：按正文出现顺序串行 ──
		const round2 = await postSse(`/api/v1/groups/${groupId}/chat`, {
			text: "@小斋 然后 @阅读助手 各说一句",
		});
		const starts2 = round2.events.filter((e) => e.type === "start");
		check(
			"@点名：按正文顺序（小斋 → 阅读助手），不带值日",
			starts2.map((s) => s.sender?.name).join(",") === "小斋,阅读助手",
			starts2.map((s) => s.sender?.name).join(","),
		);

		// ── @所有人：全员按 position ──
		const round3 = await postSse(`/api/v1/groups/${groupId}/chat`, { text: "开会 @所有人" });
		const starts3 = round3.events.filter((e) => e.type === "start");
		check(
			"@所有人：全员按 position（阅读助手、记账助手、小斋）",
			starts3.map((s) => s.sender?.name).join(",") === "阅读助手,记账助手,小斋",
			starts3.map((s) => s.sender?.name).join(","),
		);

		// ── running 中再发 → 409（faux 太快抢不到窗口的话就跳过断言，只验不崩）──
		const busyProbe = await fetch(`http://127.0.0.1:${PORT}/api/v1/groups/${groupId}/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ text: "趁乱再发一条" }),
		});
		check(
			"并发再发：409 或轮已结束后的正常发言（faux 快，两者都合规）",
			busyProbe.status === 409 || busyProbe.status === 200,
			`status=${busyProbe.status}`,
		);
		if (busyProbe.status === 200) await busyProbe.text(); // 读干净

		// ── @ 歧义：把阅读助手改名成记账助手 → @记账助手 分不清人 → 400 ──
		await api("PATCH", `/api/v1/partners/${shu}`, { name: "记账助手" });
		const ambiguous = await postSse(`/api/v1/groups/${groupId}/chat`, { text: "@记账助手 在吗" });
		check(
			"重名后 @：400 拒绝不猜（SSE 前就拒）",
			ambiguous.status === 400,
			`status=${ambiguous.status}`,
		);
		// 改回去，别影响后面的场景
		await api("PATCH", `/api/v1/partners/${shu}`, { name: "阅读助手" });

		// ── 回读分页：beforeSeq 取之前的升序窗口 ──
		const all = await api("GET", `/api/v1/groups/${groupId}/messages`, null);
		const lastSeq = all.body.lastSeq as number;
		const paged = await api(
			"GET",
			`/api/v1/groups/${groupId}/messages?beforeSeq=${lastSeq}&limit=2`,
			null,
		);
		const pagedMsgs = paged.body.messages ?? [];
		check(
			"回读分页：beforeSeq 之前、升序、条数对",
			pagedMsgs.length === 2 &&
				pagedMsgs[0].seq < pagedMsgs[1].seq &&
				pagedMsgs[1].seq < lastSeq,
			`seq=${pagedMsgs.map((m: { seq: number }) => m.seq).join(",")} last=${lastSeq}`,
		);

		// ── stop：幂等 200（faux 轮次快，能停进实时轮就停，停不到也必须不崩）──
		const stop1 = await api("POST", `/api/v1/groups/${groupId}/stop`, null);
		check("stop：200 幂等", stop1.status === 200, `status=${stop1.status}`);
		const stop2 = await api("POST", `/api/v1/groups/${groupId}/stop`, null);
		check("stop 再按一次：仍 200（幂等）", stop2.status === 200);

		// ── 成员暂停：@点名他 → 跳过 + system 行 ──
		await api("PATCH", `/api/v1/partners/${zhai}`, { status: "paused" });
		const round4 = await postSse(`/api/v1/groups/${groupId}/chat`, { text: "@小斋 出来" });
		const notices = round4.events.filter((e) => e.type === "notice");
		check(
			"成员暂停：HTTP 200 且 notice 提示跳过、没有他的 start",
			round4.status === 200 &&
				notices.length >= 1 &&
				round4.events.every((e) => e.type !== "start" || e.sender?.id !== zhai),
			`status=${round4.status} notice=${notices.map((n) => n.text).join("|")}`,
		);
		const timeline4 = await api("GET", `/api/v1/groups/${groupId}/messages`, null);
		const sysLine = (timeline4.body.messages ?? []).find(
			(m: { kind: string; content: string }) => m.kind === "system",
		);
		check("跳过也落 system 行（回读可复现）", Boolean(sysLine), sysLine?.content ?? "无");

		// ── 删群：硬删（群 + 成员 + 消息）──
		const del = await api("DELETE", `/api/v1/groups/${groupId}`, null);
		const afterDel = await api("GET", `/api/v1/groups/${groupId}/messages`, null);
		check(
			"删群：200，时间线随之消失（硬删口径）",
			del.status === 200 && afterDel.status === 404,
		);
		// 群成员会话（partner-…-group-…）不进会话列表是 **web 端前缀过滤**（方案 §2.2），
		// 服务端 /agent/chats 原样返回——口径核对在浏览器点验，不在本探针。
	} finally {
		await stopServer(server);
	}

	console.log(`${process.exitCode ? "✗ 群组探针有红" : "✓ 群组探针全部通过"}`);
}

// ── 起服务 / 请求辅助（companion-probe 同款骨架）────────────
let child: ReturnType<typeof spawn> | null = null;

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: "Bearer probe-token" };
}

async function startServer(extraEnv: Record<string, string>): Promise<ReturnType<typeof spawn>> {
	const proc = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		env: {
			...process.env,
			PORT: String(PORT),
			AGENT_TOKEN: "probe-token",
			AGENT_DB_PATH: join(ROOT, `agent-${Math.random().toString(36).slice(2, 8)}.sqlite`),
			MEMORY_DB_PATH: join(ROOT, "memory.db"),
			MEMORY_ENABLED: "false",
			PROJECTS_DB_PATH: join(ROOT, "projects.sqlite"),
			PROVIDERS_PATH: join(ROOT, "providers.json"),
			DELEGATIONS_DB_PATH: join(ROOT, "delegations.sqlite"),
			AGENT_SSE_SEQ_DB_PATH: join(ROOT, "chat-events.sqlite"),
			AGENT_APPROVALS_PATH: join(ROOT, "approvals.json"),
			AGENT_POLICY_PATH: join(ROOT, "policy.json"),
			PARTNERS_DB_PATH: join(ROOT, "partners.sqlite"),
			PARTNER_HOMES_ROOT: join(ROOT, "partner-homes"),
			ROUTINES_STATE_PATH: join(ROOT, "routines.json"),
			AUTONOMY_STATE_PATH: join(ROOT, "autonomy-state.json"),
			CHANCELLOR_ENABLED: "false",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`  [server] ${chunk}`));
	proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`  [server!] ${chunk}`));
	child = proc;

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (res.ok) return proc;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) {
			throw new Error("服务 30 秒没起来（看上面的 [server!] 输出）");
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

async function stopServer(proc: ReturnType<typeof spawn>): Promise<void> {
	if (child !== proc) return;
	child = null;
	proc.kill();
	await new Promise((resolve) => setTimeout(resolve, 300));
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

/** POST SSE 端点：读完整条流，返回 {status, events}（帧解析用共享解码器，与服务端同源） */
async function postSse(path: string, body: unknown): Promise<{ status: number; events: any[] }> {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(body),
	});
	if (res.status !== 200 || !res.body) {
		const text = await res.text();
		let parsed: any = null;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			parsed = { raw: text.slice(0, 120) };
		}
		return { status: res.status, events: [{ type: "__http_error", body: parsed }] };
	}
	const decoder = createSseDecoder();
	const reader = res.body.getReader();
	const textDecoder = new TextDecoder();
	const events: any[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		for (const event of decoder.push(textDecoder.decode(value, { stream: true }))) {
			events.push(event);
		}
	}
	return { status: res.status, events };
}

main()
	.catch((error) => {
		console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			rmSync(ROOT, { recursive: true, force: true });
		} catch {
			/* Windows 上服务进程刚死可能还占着目录，清不掉就算了 */
		}
	});
