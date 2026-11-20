/**
 * worker 人设注入单测（2026-11-16 通用 worker 配置统一 批1+批2）。
 * 钉住：TASK.md「你是谁」段的三态（注入 / 未注入 / 来源抛错）
 * 与 native 子进程的模型 env 覆盖（留空不覆盖）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnvWithModel } from "./employee/native.ts";
import { setWorkerPersonaSource } from "./worker-persona-source.ts";
import { buildWorkerPrompt } from "./worker-prompt.ts";
import type { PlannedTask } from "./types.ts";

function planned(): PlannedTask {
  return {
    title: "写材料",
    slug: "write-notes",
    instruction: "写两个文件。",
    done_when: "notes/a.md 与 notes/b.md 存在。",
    dependsOn: [],
    writes: ["notes/a.md", "notes/b.md"],
  };
}

test("未注入来源：TASK.md 不出「你是谁」段（旧行为逐字不变）", () => {
  setWorkerPersonaSource(null);
  const prompt = buildWorkerPrompt(planned(), "01-write-notes");
  assert.ok(!prompt.includes("## 你是谁"));
  assert.ok(prompt.includes("你是 chancellor 派出的独立 worker"));
});

test("注入了人设：TASK.md 出「你是谁」段，且声明冲突以任务要求为准", () => {
  setWorkerPersonaSource(() => "你说话简洁，先给结论。");
  try {
    const prompt = buildWorkerPrompt(planned(), "01-write-notes");
    assert.match(prompt, /## 你是谁/);
    assert.match(prompt, /你说话简洁，先给结论。/);
    assert.match(prompt, /以任务要求为准/);
    // 段落位置：身份行之后、任务段之前
    const personaAt = prompt.indexOf("## 你是谁");
    const taskAt = prompt.indexOf("## 任务");
    const identityAt = prompt.indexOf("你是 chancellor 派出的独立 worker");
    assert.ok(identityAt < personaAt && personaAt < taskAt);
  } finally {
    setWorkerPersonaSource(null);
  }
});

test("来源抛错 / 空串：不出段、不抛（绝不阻塞派活）", () => {
  setWorkerPersonaSource(() => {
    throw new Error("宿主读文件炸了");
  });
  try {
    assert.ok(!buildWorkerPrompt(planned(), "01-x").includes("## 你是谁"));
    setWorkerPersonaSource(() => "   ");
    assert.ok(!buildWorkerPrompt(planned(), "01-x").includes("## 你是谁"));
  } finally {
    setWorkerPersonaSource(null);
  }
});

test("childEnvWithModel：settings.model 非空覆盖 CHANCELLOR_LLM_MODEL；留空/未传不覆盖", () => {
  const base = { LLM_MODEL: "base-model", OTHER: "1" };
  assert.deepEqual(childEnvWithModel({ model: "fast-model" }, base), {
    LLM_MODEL: "base-model",
    OTHER: "1",
    CHANCELLOR_LLM_MODEL: "fast-model",
  });
  assert.equal(childEnvWithModel({ model: "  " }, base), base, "空白串 = 不覆盖");
  assert.equal(childEnvWithModel(undefined, base), base);
  assert.equal(childEnvWithModel({}, base), base);
});

test("childEnvWithModel：模型路由带 baseUrl + key（2026-11-19 模型分工）", () => {
  const base = { LLM_MODEL: "base-model", PROVIDER_KEY: "sk-test", OTHER: "1" };
  assert.deepEqual(
    childEnvWithModel(
      {
        model: "work-model",
        modelRoute: { baseUrl: "https://provider.example/v1", keyEnv: "PROVIDER_KEY" },
      },
      base,
    ),
    {
      LLM_MODEL: "base-model",
      PROVIDER_KEY: "sk-test",
      OTHER: "1",
      CHANCELLOR_LLM_MODEL: "work-model",
      CHANCELLOR_LLM_BASE_URL: "https://provider.example/v1",
      CHANCELLOR_LLM_API_KEY: "sk-test",
    },
  );
  // keyEnv 没有值：只带地址，不伪造 key（worker-main 自己回落 LLM_API_KEY）。
  assert.deepEqual(
    childEnvWithModel(
      {
        model: "work-model",
        modelRoute: { baseUrl: "https://provider.example/v1", keyEnv: "MISSING_KEY" },
      },
      base,
    ),
    {
      LLM_MODEL: "base-model",
      PROVIDER_KEY: "sk-test",
      OTHER: "1",
      CHANCELLOR_LLM_MODEL: "work-model",
      CHANCELLOR_LLM_BASE_URL: "https://provider.example/v1",
    },
  );
});
