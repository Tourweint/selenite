import assert from "node:assert/strict";
import { test } from "node:test";
import { buildManagerPrompt } from "./manager-prompt.ts";
import type { ManagerMeta } from "./manager/registry.ts";

function meta(): ManagerMeta {
  return {
    domain: "desktop-shell",
    created_at: "2026-11-05T00:00:00.000Z",
    updated_at: "2026-11-05T00:00:00.000Z",
    work_dir: "/tmp/chancellor/managers/desktop-shell/workspace",
    runs_dir: "/tmp/chancellor/managers/desktop-shell/runs",
    db_path: "/tmp/chancellor/managers/desktop-shell/.agent.sqlite",
    conversation_id: null,
    rotations: 0,
    partner_id: null,
  };
}

test("无 identity：提示词与改动前一致（不出现「## 你是谁」）", () => {
  const prompt = buildManagerPrompt(meta());
  assert.equal(prompt.includes("## 你是谁"), false);
  assert.ok(prompt.includes("## 你的身份"));
  assert.ok(prompt.includes("## 你的工具"));
  // 「你的身份」段与「你的工具」段之间仍是原来的那一个空行，不多不少。
  assert.ok(
    prompt.includes("你只有工人。\n\n## 你的工具"),
    "没有身份注入时不得在身份段与工具段之间插入任何内容",
  );
});

test("有 identity：在「## 你的身份」之后原文追加「## 你是谁」", () => {
  const soul = "你是阿岚，desktop-shell 领域的负责人。\n第二行也不改写，含 `反引号` 与标点。";
  const prompt = buildManagerPrompt(meta(), undefined, { name: "阿岚", soul });

  assert.ok(prompt.includes("## 你的身份"));
  assert.ok(prompt.includes("## 你是谁"));
  assert.ok(prompt.indexOf("## 你的身份") < prompt.indexOf("## 你是谁"));
  assert.ok(prompt.indexOf("## 你是谁") < prompt.indexOf("## 你的工具"));

  // 精确快照：注入的那一节长什么样，name / soul 原文不改写、不截断。
  assert.ok(
    prompt.includes(`你只有工人。\n\n## 你是谁\n\n阿岚\n\n${soul}\n\n## 你的工具`),
    "身份节必须紧跟身份段、原文注入、再接工具段",
  );
  assert.ok(prompt.includes(soul), "soul 原文（含换行、反引号、标点）完整保留");
});

test("identity 与 project 同时存在：两节互不覆盖，顺序稳定", () => {
  const prompt = buildManagerPrompt(
    meta(),
    { id: "p-1", name: "宿主", rootPath: "D:/repo" },
    { name: "阿岚", soul: "一句话 SOUL。" },
  );
  assert.ok(prompt.includes("## 这张单的项目"));
  assert.ok(prompt.includes("## 你是谁\n\n阿岚\n\n一句话 SOUL。"));
});
