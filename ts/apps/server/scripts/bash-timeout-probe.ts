/**
 * bash 默认超时探针（2026-11-04 批次一 A4）。
 *
 * 为什么不用单测：要证明的不只是"注入函数算得对"，而是**扩展的 beforeTool 钩子
 * 返回 `{ arguments }` 后，内核真的拿新参数去校验并执行**。所以这里真起 Harness
 * （faux 模型 + CodingTools + NodeExecutionEnv），让模型发三次 bash 调用：
 *   ① 默认超时（AGENT_BASH_TIMEOUT_S=1）下 `sleep 5` 被杀，错误含 `timed out after 1 seconds`
 *   ② 模型显式传 `timeout: 10` 不被覆盖，`sleep 2` 正常完成
 *   ③ `AGENT_BASH_TIMEOUT_S=0` 时不注入，`sleep 2` 正常完成
 *
 * beforeTool 里的注入逻辑与 agent.ts 的钩子保持同一形状（探针不 import agent.ts：
 * 它模块加载即建 memoryEngine / skillStore，会碰开发数据）。
 *
 *   pnpm --filter @lifediary/server bash-timeout
 */
import { rmSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	contentText,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	Harness,
	hook,
	ToolTask,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { bashTimeoutSeconds } from "../src/reliability.ts";

const DB = ".data/probe-bash-timeout.sqlite";
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

interface ToolRecord {
	name: string;
	isError: boolean;
	text: string;
}

const captured: ToolRecord[] = [];

const faux = fauxProvider({ models: [{ id: "probe-model" }] });
const models = createModels();
models.setProvider(faux.provider);
const ref = { provider: faux.getModel().provider, modelId: faux.getModel().id };

const ext = defineExtension({
	name: "probe-bash-timeout",
	hooks: [
		hook(ToolTask, {
			// 与 agent.ts 的注入同一形状；env 每次现读，好在同一进程里跑三种取值
			beforeTool: (call) => {
				const timeoutS = bashTimeoutSeconds(process.env);
				if (call.name === "bash" && timeoutS > 0) {
					const a = call.arguments as { timeout?: number };
					if (a.timeout === undefined) return { arguments: { ...a, timeout: timeoutS } };
				}
				return undefined;
			},
			afterTool: (call, result: ToolExecutionResult) => {
				captured.push({
					name: call.name,
					isError: result.isError === true,
					text: [
						contentText((result.output ?? []) as never),
						...(result.diagnostics ?? []).map((diagnostic) => diagnostic.message),
					]
						.filter(Boolean)
						.join(" | "),
				});
				return undefined;
			},
		}),
	],
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(ext);

const storage = await openNodeSqliteStorage(DB);
const harness = await Harness.open(
	storage,
	{
		models,
		registry,
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? CWD }),
	},
	CTX,
);
const agent = { model: ref };

async function runCall(
	envValue: string,
	label: string,
	args: Record<string, string | number>,
): Promise<{ record: ToolRecord; elapsed: number }> {
	process.env.AGENT_BASH_TIMEOUT_S = envValue;
	const conversation = await harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent },
		CTX,
	);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("做完了。"),
	]);
	const started = Date.now();
	const submission = await conversation.submit({ type: "input", content: label }, CTX);
	await submission.wait(CTX);
	const elapsed = Date.now() - started;
	const record = captured.shift();
	if (!record) throw new Error(`${label}: 没有捕获到 bash 调用`);
	return { record, elapsed };
}

console.log("\n· ① 默认超时：sleep 5 应在 1 秒被杀");
const first = await runCall("1", "跑一个久一点的命令", { command: "sleep 5" });
check(first.record.isError, "bash 返回错误", first.record.text);
check(
	first.record.text.includes("timed out after 1 seconds"),
	"错误里是最初注入的 1 秒",
	first.record.text,
);
check(first.elapsed < 4000, "没有等满 5 秒", `${first.elapsed}ms`);

console.log("\n· ② 模型显式传 timeout: 10，不被默认值覆盖");
const second = await runCall("1", "跑两秒，超时按我说的", { command: "sleep 2", timeout: 10 });
check(!second.record.isError, "bash 正常完成", second.record.text || "(无输出)");
check(second.elapsed >= 1500, "确实跑过了注入的 1 秒", `${second.elapsed}ms`);

console.log("\n· ③ env=0 时不注入，sleep 2 正常完成");
const third = await runCall("0", "关掉默认超时跑两秒", { command: "sleep 2" });
check(!third.record.isError, "bash 正常完成", third.record.text || "(无输出)");
check(third.elapsed >= 1500, "确实跑了 2 秒的量级", `${third.elapsed}ms`);

await harness.close(CTX);
rmSync(DB, { force: true });

console.log(failures === 0 ? "\n✓ bash 默认超时注入全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
