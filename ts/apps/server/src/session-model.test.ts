import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 会话级模型切换（2026-11-19）：`ensureConversationModel` 只修复、不对齐全局。
 *
 * 用独立 providers.json 模拟真实目录；faux 关掉（faux 下这个函数直接返回）。
 * 假 conversation 只提供 agent / configure 两个方法，足以覆盖三种路径。
 */

const dir = mkdtempSync(join(tmpdir(), "lifediary-session-model-"));
const providersPath = join(dir, "providers.json");
writeFileSync(
	providersPath,
	`${JSON.stringify({
		schemaVersion: 1,
		providers: [
			{
				id: "alpha",
				name: "Alpha",
				baseUrl: "http://127.0.0.1:9/v1",
				keyEnv: "ALPHA_KEY",
				models: ["mA", "mB"],
				// mB 显式只支持 off / low / high（不含 medium）
				modelThinkingLevels: { mB: ["off", "low", "high"] },
				createdAt: "2026-11-19T00:00:00.000Z",
			},
		],
		defaultSelection: { providerId: "alpha", modelId: "mA" },
	})}\n`,
);
process.env.LLM_PROVIDER = "";
process.env.LLM_API_KEY = "test-key";
process.env.PROVIDERS_CONFIG = "true";
process.env.PROVIDERS_PATH = providersPath;
process.env.MODEL_RUNTIME_PATH = join(dir, "runtime.json");
process.env.MODEL_VARIANT_PRESEEDED = "true";

const { ensureConversationModel } = await import("./agent/session-open.ts");

interface FakeConversation {
	agent: () => Promise<{ model: { provider: string; modelId: string } | null }>;
	configure: (patch: { model: { provider: string; modelId: string } }) => Promise<void>;
}

function fakeConversation(
	initial: { provider: string; modelId: string } | null,
): { conversation: FakeConversation; configured: Array<{ provider: string; modelId: string }> } {
	let current = initial;
	const configured: Array<{ provider: string; modelId: string }> = [];
	return {
		configured,
		conversation: {
			agent: async () => ({ model: current }),
			configure: async (patch) => {
				configured.push(patch.model);
				current = patch.model;
			},
		},
	};
}

test("会话模型可用：正常路径零 configure（不再对齐全局）", async () => {
	const fake = fakeConversation({ provider: "alpha", modelId: "mB#think-low" });
	await ensureConversationModel(fake.conversation as never, 1);
	assert.deepEqual(fake.configured, []);
});

test("会话模型档位越界：只 clamp 档位，不换模型", async () => {
	const fake = fakeConversation({ provider: "alpha", modelId: "mB#think-medium" });
	await ensureConversationModel(fake.conversation as never, 2);
	assert.deepEqual(fake.configured, [{ provider: "alpha", modelId: "mB#think-low" }]);
});

test("会话模型 / 供应商被删：回退当前全局默认", async () => {
	const fake = fakeConversation({ provider: "gone", modelId: "mA#think-off" });
	await ensureConversationModel(fake.conversation as never, 3);
	assert.deepEqual(fake.configured, [{ provider: "alpha", modelId: "mA#think-off" }]);
});

test("任务参数变体（#t…）：不碰，不归一化成 think 变体", async () => {
	const fake = fakeConversation({ provider: "alpha", modelId: "mA#t0.4m4000r" });
	await ensureConversationModel(fake.conversation as never, 4);
	assert.deepEqual(fake.configured, []);
});

test("会话没有模型引用：给全局默认（off 档）", async () => {
	const fake = fakeConversation(null);
	await ensureConversationModel(fake.conversation as never, 5);
	assert.deepEqual(fake.configured, [{ provider: "alpha", modelId: "mA#think-off" }]);
});

test("CHAT_SESSION_MODEL=false：回到全局对齐旧行为", async () => {
	process.env.CHAT_SESSION_MODEL = "false";
	try {
		const fake = fakeConversation({ provider: "alpha", modelId: "mB#think-off" });
		await ensureConversationModel(fake.conversation as never, 6);
		assert.deepEqual(fake.configured, [{ provider: "alpha", modelId: "mA#think-off" }]);
	} finally {
		delete process.env.CHAT_SESSION_MODEL;
	}
});
