/**
 * 宰相层验证 2/4：harness.resume() 遇到未收尾提交，会不会被新输入顶掉（2026-11-08 扫尾批 8a）。
 *
 * 造法（不 mock 内核）：
 *   1. 子进程开一个 faux 会话，提交后让模型响应永远不返回，等到提交已 placed、
 *      生成任务已存在，再被外部 taskkill —— 这就是「进程崩溃时留下未收尾提交」；
 *   2. 父进程重开同一个 SQLite + resume()，然后在两种顺序下提交新输入：
 *        A. 先 resume 再提交（正常路径）
 *        B. 先提交再 resume（用户抢在恢复前说话）
 *   3. 记录旧提交的终态、新输入的 admission 状态、以及两句话在上下文里的顺序。
 *
 * 判定标准是设计口径：旧提交不能被吞/被静默作废；忙碌时新输入应排队（followUp）。
 *
 *   pnpm --filter @lifediary/server resume-busy
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Message } from "@earendil-works/pi-ai";

const CTX = BACKGROUND_CONTEXT;

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelsOf(factory?: FauxResponseFactory) {
	const faux = fauxProvider({ models: [{ id: "faux" }], tokensPerSecond: 200 });
	const models = createModels();
	models.setProvider(faux.provider);
	const reply = (text: string) => fauxAssistantMessage(text);
	if (factory) faux.setResponses(Array.from({ length: 50 }, () => factory));
	else faux.setResponses(Array.from({ length: 50 }, (_, i) => reply(`答-${i}`)));
	return { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } };
}

/** 子进程：提交后卡在模型响应里，等外部杀。 */
async function crashHost(): Promise<void> {
	const db = process.env.PROBE_DB!;
	const metaFile = process.env.PROBE_META!;
	const { models, model } = modelsOf((context, _options, state) => {
		if (state.callCount === 1) {
			process.stdout.write("CALLED\n");
			return new Promise(() => {});
		}
		return fauxAssistantMessage("迟到的回答");
	});
	const storage = await openNodeSqliteStorage(db);
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, CTX);
	const conversation = await harness.root(CTX, { agent: { model } });
	harness.resume();
	const sub = await conversation.submit({ type: "input", content: "旧输入：未收尾" }, CTX);
	// 等生成任务真的起来（placed + 有 live task），再把身份写出去。
	for (let i = 0; i < 100; i++) {
		const state = await harness.inspect(CTX);
		const record = state.submissions.find((item) => item.id === sub.id);
		if (record?.status === "placed" && state.tasks.length > 0) break;
		await wait(50);
	}
	writeFileSync(metaFile, JSON.stringify({ conversationId: conversation.id, submissionId: sub.id }));
	process.stdout.write(`READY ${conversation.id} ${sub.id}\n`);
	await new Promise(() => {});
}

interface Meta {
	conversationId: ConversationId;
	submissionId: SubmissionId;
}

async function runVariant(name: string, order: "resume-first" | "submit-first"): Promise<void> {
	console.log(`\n[${name}] 顺序：${order === "resume-first" ? "resume → 新输入" : "新输入 → resume"}`);
	const dir = mkdtempSync(join(tmpdir(), "lifediary-resume-"));
	const db = join(dir, "chat.sqlite");
	const metaFile = join(dir, "meta.json");
	const child = spawn(
		process.execPath,
		[fileURLToPath(import.meta.url), "--phase", "crash"],
		{
			env: { ...process.env, PROBE_DB: db, PROBE_META: metaFile },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	let out = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		out += chunk;
	});
	let err = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		err = (err + chunk).slice(-2000);
	});
	for (let i = 0; i < 200 && !out.includes("READY"); i++) await wait(50);
	check(out.includes("READY"), "崩溃现场就绪（提交 placed + 生成任务在跑）", err.split("\n").filter(Boolean).slice(-1)[0] ?? "");
	spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
	await wait(400);

	const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Meta;
	// 重开：模型这次会答，但先拖 600ms，保证"旧提交还在跑时"能提交新输入。
	const { models, model } = modelsOf(async () => {
		await wait(600);
		return fauxAssistantMessage("旧提交的答案");
	});
	const harness = await Harness.open(await openNodeSqliteStorage(db), { models, registry: createRegistry() }, CTX);
	const conversation = await harness.conversation(meta.conversationId, CTX);
	check(Boolean(conversation), "重开后拿回原会话");
	await conversation!.configure({ model }, CTX);

	const before = await harness.inspect(CTX);
	const oldBefore = before.submissions.find((item) => item.id === meta.submissionId);
	check(oldBefore?.status === "placed", "重开时旧提交仍是 placed（未收尾）", `status=${oldBefore?.status}`);
	check(before.tasks.length > 0, "重开时旧生成任务仍挂在存储里", `tasks=${before.tasks.length}`);

	let newSub;
	if (order === "resume-first") {
		harness.resume();
		newSub = await conversation!.submit({ type: "input", content: "新输入：恢复后说的话" }, CTX);
	} else {
		newSub = await conversation!.submit({ type: "input", content: "新输入：恢复前抢着说的话" }, CTX);
		harness.resume();
	}

	const mid = await harness.inspect(CTX);
	const oldMid = mid.submissions.find((item) => item.id === meta.submissionId);
	const newMid = mid.submissions.find((item) => item.id === newSub.id);
	check(
		oldMid?.status === "placed" || oldMid?.status === "done",
		"旧提交没有被新输入顶掉（仍是 placed 或已 done）",
		`old=${oldMid?.status}`,
	);
	console.log(`    · 新输入 admission=${newMid?.status}（queued 表示排在旧轮之后）`);

	const oldHandle = await harness.submission(meta.submissionId, CTX);
	const oldSettled = await oldHandle!.wait(CTX);
	const newSettled = await newSub.wait(CTX);
	check(oldSettled.status === "done", "旧提交最终拿到回答", `status=${oldSettled.status}`);
	check(newSettled.status === "done", "新输入最终拿到回答", `status=${newSettled.status}`);

	const view = await conversation!.context(CTX);
	const users = view.messages
		.filter((message: Message) => message.role === "user")
		.map((message: Message) => (typeof message.content === "string" ? message.content : ""))
		.filter((text: string) => text.startsWith("旧输入") || text.startsWith("新输入"));
	check(users.length === 2, "两句用户输入都在上下文里（没被覆盖）", JSON.stringify(users));
	check(
		users[0]?.startsWith("旧输入") && users[1]?.startsWith("新输入"),
		"顺序保持：旧输入在前，新输入在后",
	);

	await harness.close(CTX);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* sqlite 句柄延迟释放时删不掉，临时目录无害 */
	}
}

if (process.argv.includes("--phase")) {
	await crashHost();
} else {
	await runVariant("A", "resume-first");
	await runVariant("B", "submit-first");
	console.log(failures === 0 ? "\n✓ 未收尾提交不会被新输入顶掉" : `\n✗ 有 ${failures} 项不对`);
	process.exit(failures === 0 ? 0 : 1);
}
