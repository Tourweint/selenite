/**
 * 验证工具链路：模型发起调用 → pi 执行 → 结果回灌 → 模型继续说话。
 *
 * 用 faux 假模型预置两轮响应，不花钱也不碰真实文件系统（只列目录）。
 *
 *   pnpm --filter @lifediary/server tools
 */
import { Agent } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { createTools } from "../src/tools.ts";

const faux = registerFauxProvider({ models: [{ id: "tools-model" }], tokensPerSecond: 2000 });
const model = faux.getModel("tools-model");
if (!model) {
	console.error("✗ faux provider 没注册成功");
	process.exit(1);
}

const tools = createTools({ cwd: process.cwd(), memory: null });
console.log(`注册工具 ${tools.length} 个: ${tools.map((t) => t.name).join(", ")}`);

// 第一轮：模型要求列目录；第二轮：模型拿到结果后作答
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("list_dir", { path: "." })], { stopReason: "toolUse" }),
	fauxAssistantMessage("我看到了目录内容，谢谢。"),
]);

const agent = new Agent({
	initialState: {
		systemPrompt: "你是一个测试助手。",
		model,
		messages: [],
		tools,
	},
	getApiKey: () => "not-needed",
});

const toolEvents: string[] = [];
agent.subscribe((event) => {
	if (event.type === "tool_execution_start") toolEvents.push(`start:${event.toolName}`);
	if (event.type === "tool_execution_end") {
		toolEvents.push(`end:${event.toolName}:${event.isError ? "error" : "ok"}`);
	}
});

await agent.prompt("看看当前目录有什么");

console.log(`工具事件: ${toolEvents.join(" | ") || "(无)"}`);
if (toolEvents.length === 0) {
	console.error("✗ 模型发起工具调用后，pi 没有执行");
	process.exit(1);
}
if (toolEvents.some((e) => e.includes(":error"))) {
	console.error(`✗ 工具执行报错: ${toolEvents.join(" | ")}`);
	process.exit(1);
}

// transcript 里应当有一条 toolResult
const roles = agent.state.messages.map((m) => m.role);
console.log(`transcript 角色序列: ${roles.join(" → ")}`);
if (!roles.includes("toolResult")) {
	console.error("✗ transcript 里没有工具结果消息");
	process.exit(1);
}

const lastMessage = agent.state.messages.at(-1);
const finalText =
	lastMessage?.role === "assistant"
		? (lastMessage.content as Array<{ type: string; text?: string }>)
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("")
		: "";
console.log(`最终回复: ${finalText}`);
console.log("✓ 工具链路正常（模型调用 → 执行 → 结果回灌 → 继续生成）");
