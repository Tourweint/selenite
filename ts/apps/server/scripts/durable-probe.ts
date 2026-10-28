/**
 * 验证 pi-durable 1.4.0 能不能当 lifediary 的基座。
 *
 * 这个脚本回答七个问题（全部用 faux 假模型 + SQLite，不花钱、不联网）：
 *   1. 一轮对话能不能跑完，流式增量能不能从 watch 的状态里拿到
 *   2. 同一个 requestId 重发，会不会变成两轮
 *   3. 工具调用能不能走通，beforeTool 钩子能不能拦住危险调用
 *   4. 定时任务（sleepUntil）真的会到点唤醒吗
 *   5. 用量计数有没有
 *   6. 关掉进程重开，历史还在不在
 *   7. 重启后能不能继续对话
 *
 *   pnpm --filter @lifediary/server durable
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	hook,
	ToolTask,
	type AgentState,
	type ConversationView,
	type LiveState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { rmSync } from "node:fs";

const DB = ".data/probe-durable.sqlite";
const CTX = BACKGROUND_CONTEXT;
const CWD = process.cwd();

rmSync(DB, { force: true });

let failures = 0;

function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── 假模型 ───────────────────────────────────────────────
const faux = fauxProvider({ models: [{ id: "probe-model" }], tokensPerSecond: 40 });
const models = createModels();
models.setProvider(faux.provider);
const ref = { provider: faux.getModel().provider, modelId: faux.getModel().id };

// ── 工具 + 闸门 ──────────────────────────────────────────
let echoCalls = 0;
let blockedRan = false;

const echo = defineTool({
	name: "echo",
	description: "把一段文字原样回显",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (args) => {
		echoCalls += 1;
		return { output: [{ type: "text", text: `echo:${args.text}` }] };
	},
});

const wipe = defineTool({
	name: "wipe_all",
	description: "危险操作，测试闸门用",
	parameters: Type.Object({}),
	execute: async () => {
		blockedRan = true;
		return { output: [{ type: "text", text: "不该跑到这里" }] };
	},
});

/** 定时提醒：睡到点，然后把一段文字写进一条 entry。 */
const Reminder = defineTask<
	{ text: string; at: number },
	{ phase: "wait" } | { phase: "deliver"; text: string },
	string
>({
	name: "probe.reminder",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, context) =>
			runtime.sleepUntil(task.input.at, { phase: "deliver", text: task.input.text }, context),
		deliver: async (task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "completed", result: task.input.text },
				}),
				context,
			);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const agentExt = defineExtension({
	name: "probe",
	sections: [
		{
			key: "persona",
			render: () => "你是一个测试助手，回答极短。",
		},
	],
	tools: [echo, wipe],
	hooks: [
		hook(ToolTask, {
			beforeTool: (call) =>
				call.name === "wipe_all" ? { block: "擦除类操作需要主人确认" } : undefined,
		}),
	],
	tasks: [Reminder],
});

const registry = createRegistry();
registry.install(agentExt);

// ── 打开 Harness ─────────────────────────────────────────
async function open(): Promise<Harness> {
	const storage = await openNodeSqliteStorage(DB);
	return Harness.open(
		storage,
		{
			models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? CWD }),
			// 默认 100ms 才提交一次流式增量；这里压到 0，好让探针看到中间态
			settings: { progress: { partialIntervalMs: 0, outputIntervalMs: 0 } },
		},
		CTX,
	);
}

const agent = { model: ref };

let harness = await open();
let root = await harness.root(CTX, { agent });

// ── 1. 一轮对话 + 流式 ───────────────────────────────────
console.log("\n· 1. 一轮对话：提交 → 流式 → 答案");

let partialSeen = "";
let deliveries = 0;
const view = await root.watch(CTX);
const render = (value: ConversationView) => {
	const live = value.docs["pi.live"] as unknown as LiveState | undefined;
	const message = live?.generation?.message as
		| { content?: readonly { type: string; text?: string }[] }
		| undefined;
	const text = (message?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
	if (text.length > partialSeen.length) partialSeen = text;
};
render(view.value);
view.start(async (value) => {
	deliveries += 1;
	if (process.env.DEBUG_LIVE) {
		const live = value.docs["pi.live"];
		console.log(
			`    [live#${deliveries}] docs=${Object.keys(value.docs).join(",")} live=${JSON.stringify(live)?.slice(0, 220)}`,
		);
	}
	render(value);
});

// 长一点，让 faux 有足够多的分片：太短的回复在一两次提交内就结束了，看不到中间态
faux.setResponses([
	fauxAssistantMessage(`第一轮的回答。${"这段话只是为了让流式传输有足够的时长。".repeat(12)}`),
]);
const startedAt = Date.now();
const first = await root.submit({ type: "input", content: "我叫小王，养了一只猫" }, CTX);
const firstSettled = await first.wait(CTX);
const elapsed = Date.now() - startedAt;
check(elapsed > 300, "生成耗时足够长，才有中间态可观察", `${elapsed}ms`);

check(firstSettled.status === "done", "提交在 done 状态结算", firstSettled.status);
check(
	partialSeen.includes("第一轮"),
	"watch 里能看到流式增量",
	`deliveries=${deliveries} partial=${JSON.stringify(partialSeen.slice(0, 24))}`,
);

// ── 2. requestId 幂等 ────────────────────────────────────
console.log("\n· 2. 重发同一个 requestId");
faux.setResponses([fauxAssistantMessage("不该出现的第二次回答。")]);
const againA = await root.submit({ type: "input", content: "我叫小王，养了一只猫", requestId: "r-1" }, CTX);
const againB = await root.submit({ type: "input", content: "我叫小王，养了一只猫", requestId: "r-1" }, CTX);
await againA.wait(CTX);
check(againA.id === againB.id, "同一个 requestId 拿到同一个提交", String(againA.id));

// ── 3. 工具调用 + 闸门 ───────────────────────────────────
console.log("\n· 3. 工具调用与 beforeTool 闸门");
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("echo", { text: "你好" })], { stopReason: "toolUse" }),
	fauxAssistantMessage("工具已经调用过了。"),
]);
const toolRun = await root.submit({ type: "input", content: "帮我 echo 一下" }, CTX);
const toolSettled = await toolRun.wait(CTX);
check(toolSettled.status === "done", "工具轮次正常结束", toolSettled.status);
check(echoCalls === 1, "echo 被真实执行了一次", `calls=${echoCalls}`);
if (echoCalls !== 1) {
	const agentNow = await root.agent(CTX);
	console.log(`    可用工具: ${agentNow.tools.map((tool) => tool.name).join(", ") || "(空)"}`);
	const entries = (await root.context(CTX)).entries;
	console.log(`    entry 种类: ${entries.map((entry) => entry.kind).join(", ")}`);
}

faux.setResponses([
	fauxAssistantMessage([fauxToolCall("wipe_all", {})], { stopReason: "toolUse" }),
	fauxAssistantMessage("被拦住了。"),
]);
const blockedRun = await root.submit({ type: "input", content: "把所有东西擦掉" }, CTX);
await blockedRun.wait(CTX);
check(!blockedRan, "危险工具被闸门拦住，没有执行");

// ── 4. 定时提醒 ──────────────────────────────────────────
console.log("\n· 4. 定时任务（sleepUntil）");
const dueAt = Date.now() + 300;
const taskId = await root.commit(
	(tx) => tx.createTask(Reminder, { text: `提醒：该写日记了（${dueAt}）`, at: dueAt }, { ownership: { kind: "conversation" } }),
	CTX,
);
const settledTask = await harness.waitForTask(taskId, CTX);
check(settledTask.state.outcome.status === "completed", "提醒任务到点完成", settledTask.state.outcome.status);
check(Date.now() >= dueAt, "确实等到了目标时间之后");

// ── 5. 用量 ──────────────────────────────────────────────
console.log("\n· 5. 用量计数");
const usage = await harness.usage(CTX);
const modelUsage = Object.entries(usage.models);
check(modelUsage.length > 0, "有用量记录", modelUsage.map(([key, value]) => `${key}:${value.totalTokens ?? 0}`).join(", "));

// ── 6. 关掉重开，历史还在 ────────────────────────────────
console.log("\n· 6. 关闭进程后重开");
await view.stop();
const beforeCount = (await root.context(CTX)).entries.length;
await harness.close(CTX);

harness = await open();
harness.resume();
root = await harness.root(CTX);
const afterContext = await root.context(CTX);
check(afterContext.entries.length === beforeCount, "历史条数一致", `${beforeCount} → ${afterContext.entries.length}`);
check(
	afterContext.messages.some((message) => message.role === "user"),
	"上下文里能拿回用户消息",
);

// ── 7. 重启后继续对话 ────────────────────────────────────
console.log("\n· 7. 重启后继续对话");
faux.setResponses([fauxAssistantMessage("你的猫叫团子。")]);
const third = await root.submit({ type: "input", content: "我刚才说了什么？" }, CTX);
const thirdSettled = await third.wait(CTX);
check(thirdSettled.status === "done", "重启后仍能完成一轮", thirdSettled.status);

await harness.close(CTX);

console.log(failures === 0 ? "\n✓ pi-durable 可用，全部检查通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
