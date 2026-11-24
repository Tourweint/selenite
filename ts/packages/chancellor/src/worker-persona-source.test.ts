/**
 * worker 人设注入单测（2026-11-16 通用 worker 配置统一 批1+批2）。
 * 钉住：TASK.md「你是谁」段的三态（注入 / 未注入 / 来源抛错）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
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

test("项目其他文件夹（隔离形态）：TASK.md 列出真实目录并放行三处写入", () => {
  const prompt = buildWorkerPrompt(
    planned(),
    "01-write-notes",
    [],
    { workDir: "/tmp/copy", taskDir: "/tmp/task" },
    [{ label: "手机端", path: "/tmp/phone", role: "extra" }],
  );
  assert.ok(prompt.includes("## 项目的其他文件夹"));
  assert.ok(prompt.includes("不在隔离副本里"));
  assert.ok(prompt.includes("- 手机端：/tmp/phone"));
  assert.ok(prompt.includes("只在三处写文件"));
  assert.ok(prompt.includes("项目副本 `/tmp/copy`"));
  assert.ok(prompt.includes("任务目录 `/tmp/task`"));
});

test("项目文件夹（非隔离形态含 primary）：列全部根，边界写项目文件夹", () => {
  const prompt = buildWorkerPrompt(
    planned(),
    "01-write-notes",
    [],
    { workDir: "/repo", taskDir: "/tmp/task" },
    [
      { label: "主仓", path: "/repo", role: "primary" },
      { label: "手机端", path: "/repo-phone", role: "extra" },
    ],
  );
  assert.ok(prompt.includes("## 项目的文件夹"));
  assert.ok(prompt.includes("- 主仓：/repo"));
  assert.ok(prompt.includes("- 手机端：/repo-phone"));
  assert.ok(prompt.includes("只在项目的文件夹（上面列出的路径）"));
  assert.ok(!prompt.includes("只在三处写文件"));
});

test("没有 roots：TASK.md 不出现项目文件夹段，边界仍是两处", () => {
  const prompt = buildWorkerPrompt(planned(), "01-x", [], { workDir: "/tmp/copy", taskDir: "/tmp/task" });
  assert.ok(!prompt.includes("## 项目的"));
  assert.ok(prompt.includes("只在两处写文件"));
});
