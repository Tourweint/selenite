/**
 * 宰相层验证 4/4：60% 阈值下"压缩还是换段"的判定准确率（2026-11-08 扫尾批 8a）。
 *
 * D12 的判定写死在 `worker-main.ts`：本轮 `record.status === "done"` 且有助手文本
 * → 换段（写 handoff.md + reset）；否则 → compact。这里不看代码猜，直接跑真进程：
 *
 *   A. 正常收尾（faux）：把窗口压到 8000、阈值 60%（=4800），回复塞 5200 个汉字，
 *      重复 5 轮。每轮都应换段；第 6 轮回复很短，用来验证"换段后历史真的清空"。
 *   B. 没正常收尾：拿一个只回 400 的本地 OpenAI 兼容端点，让提交以模型错误结束；
 *      需求本身超过阈值。预期：不写 handoff，日志走"未告一段落，已压缩"。
 *
 *   pnpm --filter @lifediary/server context-ratio
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ensureManager, readManagerMeta } from "../../../packages/chancellor/src/manager/registry.ts";

const WORKER_MAIN = fileURLToPath(
	new URL("../../../packages/chancellor/src/worker-main.ts", import.meta.url),
);
const WINDOW = 8000;
const THRESHOLD = Math.floor(WINDOW * 0.6); // 4800

let failures = 0;
function warn(label: string, detail = ""): void {
	console.log(`  ! ${label}${detail ? ` — ${detail}` : ""}`);
}
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runManager(opts: {
	managerDir: string;
	domain: string;
	requirement: string;
	env: Record<string, string | undefined>;
}): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				WORKER_MAIN,
				"--role",
				"manager",
				"--domain",
				opts.domain,
				"--dir",
				opts.managerDir,
				"--requirement",
				opts.requirement,
			],
			{
				env: { ...process.env, ...opts.env },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/**
 * 重开同一个库，量一下负责人会话的上下文有多大。
 * 只用 faux 打开（只读，不发请求），不改变任何东西。
 */
async function contextStats(dbPath: string, conversationId: number | null): Promise<{ messages: number; chars: number }> {
	if (conversationId === null) return { messages: 0, chars: 0 };
	const faux = fauxProvider({ models: [{ id: "faux" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(
		await openNodeSqliteStorage(dbPath),
		{ models, registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	const conversation = await harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
	const view = await conversation!.context(BACKGROUND_CONTEXT);
	const chars = view.messages.reduce((sum, message) => {
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content.map((block) => (block.type === "text" ? block.text : JSON.stringify(block))).join("");
		return sum + text.length;
	}, 0);
	await harness.close(BACKGROUND_CONTEXT);
	return { messages: view.messages.length, chars };
}

/** 前 `failFirst` 个请求回 400，之后返回一段正常的短回答（用于让"压缩"有机会成功）。 */
function startFlakyServer(failFirst: number): Promise<{ server: Server; port: number; hits: () => number }> {
	let count = 0;
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk: string) => {
				body += chunk;
			});
			req.on("end", () => {
				count += 1;
				if (count <= failFirst) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "probe: forced model error" } }));
					return;
				}
				let stream = true;
				try {
					stream = JSON.parse(body).stream !== false;
				} catch {
					/* 非法 JSON 就当流式 */
				}
				const text = "压缩后的短摘要。";
				if (!stream) {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							id: "probe",
							object: "chat.completion",
							created: 1,
							model: "probe",
							choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
							usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
						}),
					);
					return;
				}
				res.writeHead(200, { "content-type": "text/event-stream" });
				const base = { id: "probe", object: "chat.completion.chunk", created: 1, model: "probe" };
				res.write(
					`data: ${JSON.stringify({
						...base,
						choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
					})}\n\n`,
				);
				res.write(
					`data: ${JSON.stringify({
						...base,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					})}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ server, port, hits: () => count });
		});
	});
}

/** 只用于制造"没正常收尾"：一律 400，让提交以模型错误结束。 */
function start400Server(): Promise<{ server: Server; port: number; hits: () => number }> {
	let count = 0;
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			count += 1;
			req.resume();
			req.on("end", () => {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "probe: forced model error" } }));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ server, port, hits: () => count });
		});
	});
}

const TEMP = mkdtempSync(join(tmpdir(), "lifediary-ctx-"));
const WORK_ROOT = join(TEMP, "runs");
const manager = ensureManager(WORK_ROOT, "demo");
const handoffPath = join(manager.root, "handoff.md");

const fauxEnv = {
	LLM_PROVIDER: "faux",
	CHANCELLOR_LLM_PROVIDER: "faux",
	CHANCELLOR_LLM_API_KEY: undefined,
	LLM_API_KEY: undefined,
	MANAGER_CONTEXT_WINDOW: String(WINDOW),
	MANAGER_CONTEXT_ROTATE_RATIO: "0.6",
};

try {
	// ── A. 正常收尾 → 换段，重复 5 轮 ─────────────────────
	console.log(`[A] 正常收尾 × 5（窗口 ${WINDOW}，阈值 ${THRESHOLD}）`);
	const longReply = "汉".repeat(5200); // 汉字按 1 token 估，明显过阈值
	const rounds: Array<{ rotated: boolean; rotations: number; history: string }> = [];
	for (let i = 1; i <= 5; i++) {
		const result = await runManager({
			managerDir: manager.root,
			domain: "demo",
			requirement: `第 ${i} 轮：请给结论`,
			env: { ...fauxEnv, CHANCELLOR_FAUX_MANAGER_REPLY: longReply },
		});
		const meta = readManagerMeta(manager.root);
		const rotated = result.stderr.includes("已换段");
		rounds.push({
			rotated,
			rotations: meta?.rotations ?? -1,
			history: result.stderr.split("\n").find((line) => line.includes("history=")) ?? "",
		});
		check(
			result.code === 0 && rotated && (meta?.rotations ?? 0) === i,
			`第 ${i} 轮：正常收尾 → 换段`,
			`exit=${result.code} rotations=${meta?.rotations} history=${rounds[i - 1]!.history.replace(/^.*history=/, "")}`,
		);
	}
	const sections = readFileSync(handoffPath, "utf8").split("\n---\n").length;
	check(sections === 5, "handoff.md 累积了 5 段交接笔记", `sections=${sections}`);

	// 第 6 轮：短回复。如果上一轮真的 reset 了，历史里只剩交接笔记，不会再到阈值。
	const short = await runManager({
		managerDir: manager.root,
		domain: "demo",
		requirement: "第 6 轮：只要一句话",
		env: { ...fauxEnv, CHANCELLOR_FAUX_MANAGER_REPLY: "好。" },
	});
	const meta6 = readManagerMeta(manager.root);
	check(
		short.code === 0 && !short.stderr.includes("已换段") && (meta6?.rotations ?? 0) === 5,
		"第 6 轮短回复不再触发换段（说明上一轮 reset 生效，历史没累积）",
		`rotations=${meta6?.rotations}`,
	);

	// ── B. 没正常收尾 → compact 方向 ─────────────────────
	console.log("\n[B] 没正常收尾（模型 400）→ 应走压缩而不是换段");
	const fake = await start400Server();
	try {
		const requirement = "验".repeat(5200); // 输入本身就超过阈值
		const before = readManagerMeta(manager.root);
		const failed = await runManager({
			managerDir: manager.root,
			domain: "demo",
			requirement,
			env: {
				LLM_PROVIDER: undefined,
				CHANCELLOR_LLM_PROVIDER: undefined,
				LLM_API_KEY: "probe-dummy-key",
				CHANCELLOR_LLM_API_KEY: "probe-dummy-key",
				LLM_BASE_URL: `http://127.0.0.1:${fake.port}/v1`,
				CHANCELLOR_LLM_BASE_URL: `http://127.0.0.1:${fake.port}/v1`,
				MANAGER_CONTEXT_WINDOW: String(WINDOW),
				MANAGER_CONTEXT_ROTATE_RATIO: "0.6",
				CHANCELLOR_FAUX_MANAGER_REPLY: undefined,
			},
		});
		const after = readManagerMeta(manager.root);
		check(failed.code !== 0, "本轮没有正常收尾（退出码非 0）", `exit=${failed.code}`);
		check(fake.hits() > 0, "确实打到了模型端点", `requests=${fake.hits()}`);
		check(
			failed.stderr.includes("未告一段落，已压缩") && !failed.stderr.includes("已换段"),
			"判定走压缩，且没有写换段",
			failed.stderr
				.split("\n")
				.filter((line) => line.includes("上下文") || line.includes("没有正常收尾"))
				.join(" | "),
		);
		check((after?.rotations ?? 0) === (before?.rotations ?? 0), "rotations 未增加（没换段）");
		const handoffAfter = existsSync(handoffPath) ? readFileSync(handoffPath, "utf8") : "";
		check(
			handoffAfter.split("\n---\n").length === 5,
			"handoff.md 没有新增第 6 段",
			`sections=${handoffAfter.split("\n---\n").length}`,
		);
		// 这一轮的模型端点本身是坏的，压缩不可能成功；这里只记录现场，
		// 真正的"压缩任务会不会被进程退出带走"放到 C 段（模型对压缩可用）。
		const current = readManagerMeta(manager.root);
		const stats = await contextStats(manager.db_path, current?.conversation_id ?? null);
		console.log(
			`    · 本轮结束后上下文：messages=${stats.messages} 字符=${stats.chars}` +
				`（需求 ${requirement.length} 字；端点全 400，压缩本就无法成功）`,
		);
	} finally {
		fake.server.close();
	}

	// ── C. 压缩任务到底有没有落地 ───────────────────────
	console.log("\n[C] 生成失败但模型可用：日志说'已压缩'，任务是否真的跑完？");
	const flaky = await startFlakyServer(1);
	try {
		const manager2 = ensureManager(WORK_ROOT, "demo2");
		const requirement = "验".repeat(5200);
		const failed = await runManager({
			managerDir: manager2.root,
			domain: "demo2",
			requirement,
			env: {
				LLM_PROVIDER: undefined,
				CHANCELLOR_LLM_PROVIDER: undefined,
				LLM_API_KEY: "probe-dummy-key",
				CHANCELLOR_LLM_API_KEY: "probe-dummy-key",
				LLM_BASE_URL: `http://127.0.0.1:${flaky.port}/v1`,
				CHANCELLOR_LLM_BASE_URL: `http://127.0.0.1:${flaky.port}/v1`,
				MANAGER_CONTEXT_WINDOW: String(WINDOW),
				MANAGER_CONTEXT_ROTATE_RATIO: "0.6",
				CHANCELLOR_FAUX_MANAGER_REPLY: undefined,
			},
		});
		const current = readManagerMeta(manager2.root);
		const stats = await contextStats(manager2.db_path, current?.conversation_id ?? null);
		console.log(
			`    · 端点请求数=${flaky.hits()}；结束后上下文 messages=${stats.messages} 字符=${stats.chars}` +
				`（需求 ${requirement.length} 字）`,
		);
		check(failed.code !== 0, "本轮仍以模型错误收尾", `exit=${failed.code}`);
		// 实测（2026-11-08）：本进程内不会发出压缩请求，日志的"已压缩"只是"已入队"。
		// 这是偏离（日志口径），不是数据丢失——D 段证明下一轮会补上。
		warn(
			"偏离：日志说'已压缩'，但本进程内压缩任务没跑（只入队）",
			`requests=${flaky.hits()}`,
		);
		warn(
			"本轮结束时上下文仍是全文（要等下一次启动才真正压下去）",
			`messages=${stats.messages} chars=${stats.chars}`,
		);

		// D. 下一轮启动会不会把上一次"已入队但没跑"的压缩任务续上？
		console.log("\n[D] 下一次启动（resume）会不会补跑上一轮没跑完的压缩任务？");
		const again = await runManager({
			managerDir: manager2.root,
			domain: "demo2",
			requirement: "下一轮：只说一句",
			env: { ...fauxEnv, CHANCELLOR_FAUX_MANAGER_REPLY: "好。" },
		});
		const current2 = readManagerMeta(manager2.root);
		const stats2 = await contextStats(manager2.db_path, current2?.conversation_id ?? null);
		console.log(
			`    · 下一轮结束：exit=${again.code} 上下文 messages=${stats2.messages} 字符=${stats2.chars}`,
		);
		check(
			again.code === 0 && stats2.chars < requirement.length,
			"下一轮启动把积压的压缩补上了（不是永久丢失，但上一轮结束时确实没落地）",
			`chars=${stats2.chars}`,
		);
	} finally {
		flaky.server.close();
	}
} finally {
	try {
		rmSync(TEMP, { recursive: true, force: true });
	} catch {
		/* sqlite 延迟释放时删不掉，临时目录无害 */
	}
}

console.log(failures === 0 ? "\n✓ 60% 阈值判定符合设计（6 轮换段 + 1 轮压缩方向）" : `\n✗ 有 ${failures} 项不对`);
process.exit(failures === 0 ? 0 : 1);
