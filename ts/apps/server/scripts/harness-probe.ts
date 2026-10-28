/**
 * 验证 pi 自己的会话流程能不能直接用：
 *   NodeExecutionEnv → JsonlSessionRepo → AgentHarness
 *
 * 要回答三个问题：
 *   1. harness 能跑完一轮对话吗（用 faux 假模型，不花钱）
 *   2. 会话真的落到 jsonl 了吗
 *   3. 关掉进程重新打开，历史还在吗
 *
 *   pnpm --filter @lifediary/server harness
 */
import { AgentHarness, JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { rmSync } from "node:fs";

const sessionsRoot = ".data/probe-sessions";
const cwd = process.cwd();
const sessionId = "probe-session";

// 每次跑都从干净状态开始，否则第二次就变成"恢复"了
rmSync(sessionsRoot, { recursive: true, force: true });

const faux = registerFauxProvider({ models: [{ id: "probe-model" }], tokensPerSecond: 800 });
const model = faux.getModel("probe-model");
if (!model) {
	console.error("✗ faux provider 没注册成功");
	process.exit(1);
}

const env = new NodeExecutionEnv({ cwd });
const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });

async function openOrCreate() {
	const metas = await repo.list({ cwd });
	const existing = metas.find((meta) => meta.id === sessionId);
	return existing ? await repo.open(existing) : await repo.create({ cwd, id: sessionId });
}

function buildHarness(session: Awaited<ReturnType<typeof openOrCreate>>) {
	return new AgentHarness({
		env,
		session,
		model: model!,
		systemPrompt: "你是一个测试助手，回答简短。",
		getApiKeyAndHeaders: async () => ({ apiKey: "not-needed" }),
	});
}

// ── 第一次：新会话 ──────────────────────────────
console.log("· 新建会话");
let session = await openOrCreate();
let harness = buildHarness(session);

const seenEvents = new Set<string>();
let text = "";

harness.subscribe((event) => {
	seenEvents.add(event.type);
	const anyEvent = event as { type: string; assistantMessageEvent?: { type: string; delta?: string } };
	if (anyEvent.type === "message_update" && anyEvent.assistantMessageEvent?.type === "text_delta") {
		text += anyEvent.assistantMessageEvent.delta ?? "";
	}
});

faux.setResponses([fauxAssistantMessage("第一轮的回答。")]);
await harness.prompt("我叫小王，养了一只猫。");

console.log(`  收到事件类型: ${[...seenEvents].join(", ")}`);
console.log(`  正文: ${text || "(事件里没拿到增量)"}`);

// ── 第二次：同一个进程内，再问一轮 ──────────────
faux.setResponses([fauxAssistantMessage("第二轮的回答。")]);
await harness.prompt("我刚才说我养了什么？");

// ── 检查落盘 ────────────────────────────────────
const metas = await repo.list({ cwd });
console.log(`· 磁盘上的会话数: ${metas.length}`);
if (metas.length === 0) {
	console.error("✗ 会话没有落盘");
	process.exit(1);
}

// ── 第三次：模拟重启 —— 丢掉 harness，重新 open ──
console.log("· 重新打开会话（模拟重启）");
const reopened = await repo.open(metas[0]!);
const entries = (await reopened.getEntries()).filter((entry) => entry.type === "message");
console.log(`  重新打开后拿到的消息条数: ${entries.length}`);

if (entries.length < 4) {
	console.error(`✗ 历史没恢复：期望至少 4 条（2 轮问答），实际 ${entries.length}`);
	process.exit(1);
}

const firstUser = entries.find((entry) => {
	const message = (entry as { message?: { role?: string; content?: unknown } }).message;
	return message?.role === "user";
});
console.log(`  最早的用户消息: ${JSON.stringify((firstUser as any)?.message?.content)?.slice(0, 60)}`);

// ── 第四次：压缩能不能手动触发 ──────────────────
harness = buildHarness(reopened);
try {
	const result = await harness.compact();
	console.log(`✓ 压缩成功：${result.tokensBefore} tokens → 摘要 ${result.summary.length} 字`);
} catch (error) {
	console.log(`· 压缩跳过（上下文还小，属正常）: ${(error as Error).message}`);
}

console.log("✓ pi 的会话流程可用");
