/**
 * 验证 vendored pi 真的能用，而不只是"能 import"。
 *
 * 两段：
 *   1. 模块解析 —— tsx 能不能加载 TS 源码形式的 pi
 *   2. Agent 循环 —— 用 pi 自带的 faux provider（假模型）跑完整一轮
 *      prompt → 事件流 → transcript 落状态，不需要任何 API key
 *
 *   pnpm probe
 */
import {
	Agent,
	calculateContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	shouldCompact,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { harnessStream } from "../src/provider.ts";

console.log(`pi-agent-core: Agent=${typeof Agent}`);

const faux = registerFauxProvider({
	models: [{ id: "probe-model", name: "Probe Model" }],
	tokensPerSecond: 400,
});
const model = faux.getModel("probe-model");
if (!model) {
	console.error("✗ faux provider 没注册成功");
	process.exit(1);
}

faux.setResponses([fauxAssistantMessage("你好，我是 Agent 循环跑出来的输出。")]);

const agent = new Agent({
	initialState: {
		systemPrompt: "你是一个测试助手。",
		model,
		messages: [],
	},
	getApiKey: () => "not-needed",
});

let text = "";
let deltas = 0;
let started = false;
let ended = false;

agent.subscribe((event) => {
	if (event.type === "agent_start") started = true;
	if (event.type === "agent_end") ended = true;
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		text += event.assistantMessageEvent.delta;
		deltas++;
	}
});

const began = Date.now();
await agent.prompt("你好");

if (!started || !ended) {
	console.error(`✗ 生命周期事件缺失 start=${started} end=${ended}`);
	process.exit(1);
}
if (deltas === 0 || !text.trim()) {
	console.error("✗ 没有收到任何文本增量");
	process.exit(1);
}

const transcript = agent.state.messages;
if (transcript.length < 2) {
	console.error(`✗ transcript 不完整，只有 ${transcript.length} 条`);
	process.exit(1);
}

console.log(
	`✓ Agent 循环正常：${deltas} 个增量 · transcript ${transcript.length} 条 · ${Date.now() - began}ms`,
);
console.log(`  正文: ${text}`);
console.log(`  末条角色: ${transcript.at(-1)?.role}`);

// ── 第三段：服务端自己的事件桥接 ──────────────────
// agentStream 把 Agent 的回调事件转成异步生成器，这是新增逻辑里最容易出 bug 的地方，
// 单测一条通路值得。
faux.setResponses([fauxAssistantMessage("桥接通路正常。")]);

const bridged: string[] = [];
const controller = new AbortController();
for await (const delta of harnessStream(
	{ model, apiKey: "not-needed" },
	{
		messages: [{ role: "user", content: "测试桥接" }],
		conversationId: "probe-bridge",
		systemContext: "（测试用记忆上下文）",
		signal: controller.signal,
	},
)) {
	bridged.push(delta);
}

if (bridged.length === 0) {
	console.error("✗ 桥接没有吐出任何增量");
	process.exit(1);
}
console.log(`✓ 事件桥接正常：${bridged.length} 段 → ${bridged.join("")}`);

// ── 第四段：压缩触发条件 ────────────────────────
// 不真的压缩（要额外调一次 LLM），只验证"什么时候该压"这个判断接对了。
const usageOf = (input: number) => ({
	input,
	output: 100,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const window = 131_072;
const smallTokens = calculateContextTokens(usageOf(10_000));
const largeTokens = calculateContextTokens(usageOf(120_000));

const smallShould = shouldCompact(smallTokens, window, DEFAULT_COMPACTION_SETTINGS);
const largeShould = shouldCompact(largeTokens, window, DEFAULT_COMPACTION_SETTINGS);

if (smallShould) {
	console.error(`✗ 1 万 tokens 不该触发压缩（阈值 ${JSON.stringify(DEFAULT_COMPACTION_SETTINGS)}）`);
	process.exit(1);
}
if (!largeShould) {
	console.error(`✗ 12 万 tokens 该触发压缩（阈值 ${JSON.stringify(DEFAULT_COMPACTION_SETTINGS)}）`);
	process.exit(1);
}
console.log(
	`✓ 压缩判断接入正确：1万=${smallShould} / 12万=${largeShould} · 窗口 ${window}`,
);
