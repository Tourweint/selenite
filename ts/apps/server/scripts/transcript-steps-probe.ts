/**
 * 工作过程回放探针（2026-11-07）。
 *
 * 验的是 `readTranscript` 能不能把 durable 里的工具调用重建成「步骤」：
 *   pi.user → pi.assistant(toolCall) → pi.tool-result → pi.assistant(正文)
 *
 * 现场只有 faux，所以全程真起 durable + 真跑工具（echo / 失败工具），
 * 不 mock 存储层——这样验的是"落库的东西能不能读回来"，不是"我写的函数返回了什么"。
 *
 *   pnpm --filter @lifediary/server transcript-steps
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
	defineTool,
	Harness,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { rmSync } from "node:fs";
import { readTranscript, type ResolvedChat } from "../src/agent.ts";

const DB = ".data/probe-transcript-steps.sqlite";
const CTX = BACKGROUND_CONTEXT;

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

// 两个工具：一个成功（带输出），一个永远失败——成功与失败都要能读回来
let echoCalls = 0;
const tools = defineExtension({
	name: "probe-tools",
	tools: [
		defineTool({
			name: "echo",
			description: "回显传入的文本",
			parameters: Type.Object({ text: Type.String() }),
			async execute(args) {
				echoCalls += 1;
				return { output: [{ type: "text", text: `回声：${args.text}` }] };
			},
		}),
		defineTool({
			name: "boom",
			description: "总是失败，用来验失败步骤",
			parameters: Type.Object({}),
			async execute() {
				return { output: [{ type: "text", text: "炸了" }], isError: true };
			},
		}),
	],
});

const faux = fauxProvider({ models: [{ id: "probe-model" }], tokensPerSecond: 400 });
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(tools);

const storage = await openNodeSqliteStorage(DB);
const harness = await Harness.open(
	storage,
	{
		models,
		registry,
		env: () => new NodeExecutionEnv({ cwd: process.cwd() }),
	},
	CTX,
);
const root = await harness.root(CTX, {
	agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
});
// 一轮：echo（成功）→ boom（失败）→ 正文回答
// 时间戳显式错开：faux 默认同一毫秒出三条，workMs 会算成 0，验不出"整轮时长"这条断言。
// 用户消息的时间由 durable 自己盖（就是"现在"），所以后两条往后推即可。
const t0 = Date.now();
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("echo", { text: "你好世界" })], {
		stopReason: "toolUse",
		timestamp: t0 + 1_000,
	}),
	fauxAssistantMessage([fauxToolCall("boom", {})], { stopReason: "toolUse", timestamp: t0 + 4_000 }),
	fauxAssistantMessage("两件事都做完了。", { timestamp: t0 + 9_000 }),
]);

const run = await root.submit({ type: "input", content: "先 echo 再炸一下" }, CTX);
const settled = await run.wait(CTX);
check(settled.status === "done", "这一轮正常结算", settled.status);
check(echoCalls === 1, "echo 真的执行了一次", `calls=${echoCalls}`);

const chat: ResolvedChat = {
	conversation: root,
	externalId: "probe-transcript",
	internalId: 1,
};
const messages = await readTranscript(chat, 50);
const answer = [...messages].reverse().find((message) => message.role === "assistant");

check(Boolean(answer), "读回了一条助手回答");
check(answer?.text === "两件事都做完了。", "回答正文完整", JSON.stringify(answer?.text));
check(answer?.steps?.length === 2, "两个工具调用都成了步骤", `steps=${answer?.steps?.length}`);

const [first, second] = answer?.steps ?? [];
check(first?.name === "echo", "第一步是 echo", String(first?.name));
check(first?.label === "你好世界", "步骤带上了能说明在干什么的参数", String(first?.label));
check(first?.ok === true, "成功步骤 ok=true");
check(first?.output === "回声：你好世界", "工具输出读回来了", JSON.stringify(first?.output));
check(typeof first?.ms === "number", "步骤带耗时", String(first?.ms));
check(first?.args?.includes("你好世界") === true, "调用参数也读回来了");
check(second?.name === "boom", "第二步是 boom", String(second?.name));
check(second?.ok === false, "失败步骤 ok=false（不能画成成功）");
if (process.env.DEBUG_TIMES) {
	for (const m of messages) console.log(`    ${m.role} at=${m.at} workMs=${m.workMs} steps=${m.steps?.length ?? 0}`);
}
check(
	typeof answer?.workMs === "number" && answer.workMs >= 8_000,
	"整轮墙钟时长 = 提问到收尾",
	`${answer?.workMs}ms`,
);
if (process.env.DEBUG_TIMES) {
	for (const m of messages) console.log(`    ${m.role} at=${m.at} workMs=${m.workMs}`);
}

// 第二轮不带工具：不该凭空长出 steps
faux.setResponses([fauxAssistantMessage("这次只说话。")]);
const plain = await root.submit({ type: "input", content: "只聊两句" }, CTX);
await plain.wait(CTX);
const after = await readTranscript(chat, 50);
const last = [...after].reverse().find((message) => message.role === "assistant");
check(last?.text === "这次只说话。", "第二轮回答读回");
check(last?.steps === undefined, "没有工具调用就不下发 steps 字段");

// 中间回合（带 toolCall、正文为空）不能变成独立的"回答"
const assistantCount = after.filter((message) => message.role === "assistant").length;
check(assistantCount === 2, "两轮就是两条回答（工具回合不单独成条）", `count=${assistantCount}`);

// ── 没有正文的轮次（撞上限 / 被停 / 崩在工具里）：步骤不能凭空消失 ──
// 模拟法：直接把 faux 设成"只调工具不收尾"，跑一轮撞不到上限也会留下步骤。
// 这里用更直接的办法——给会话写一条只有 toolCall 的 assistant，不写结果，
// 再从 readTranscript 读回来，验兜底那条"只有步骤、正文为空"的记录。
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("echo", { text: "孤儿步骤" })], { stopReason: "toolUse" }),
]);
const orphan = await root.submit({ type: "input", content: "这一轮没有收尾" }, CTX);
await orphan.wait(CTX);
const orphanRead = await readTranscript(chat, 50);
const tail = orphanRead.at(-1);
check(tail?.role === "assistant" && tail.text === "", "没有正文的轮次也留下一条记录", JSON.stringify(tail?.text));
check((tail?.steps?.length ?? 0) > 0, "那条记录带着步骤（否则最该看过程的一轮反而丢了）", `steps=${tail?.steps?.length}`);

await harness.close(CTX);

rmSync(DB, { force: true });

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
