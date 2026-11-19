import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { buildQaRequirement, parseQaConclusion, qaRunnerAvailable, setQaRunner } from "./qa.ts";
import type { TaskRun, Ticket } from "./types.ts";

test("parseQaConclusion：三种结论行；取最后一个匹配；带质检前缀", () => {
  assert.deepEqual(parseQaConclusion("DONE: 全部达成"), { verdict: "pass", reason: "质检 worker：全部达成" });
  assert.deepEqual(parseQaConclusion("CONTINUE: 第 2 条差一个字段"), {
    verdict: "fail",
    reason: "质检 worker：第 2 条差一个字段",
  });
  assert.deepEqual(parseQaConclusion("BLOCKED: 无法核对"), { verdict: "blocked", reason: "质检 worker：无法核对" });
  // 全角冒号也认（模板允许）
  assert.equal(parseQaConclusion("DONE：完成")?.verdict, "pass");
  // 多行文本里取最后一个结论行（summary 以结论行结尾的口径）
  const report = ["# REPORT", "第一条 DONE: 作废", "CONTINUE: 还差一样"].join("\n");
  assert.equal(parseQaConclusion(report)?.verdict, "fail");
  // 模板主口径：结论行在 json 块的 summary 里（转义换行），整段扫描也能接住
  const jsonReport = [
    "# REPORT",
    "",
    "```json",
    '{"status":"ready","summary":"验证完成\\nDONE: 三条全部亲自读到","artifacts":[]}',
    "```",
  ].join("\n");
  assert.deepEqual(parseQaConclusion(jsonReport), {
    verdict: "pass",
    reason: "质检 worker：三条全部亲自读到",
  });
  // 没给结论行 → null（调用方判 blocked 交人）
  assert.equal(parseQaConclusion("干完了，挺好的"), null);
  assert.equal(parseQaConclusion(""), null);
  assert.equal(parseQaConclusion(null), null);
});

test("buildQaRequirement：qa.md 模板占位符全部替换成任务材料", () => {
  const ticket: Ticket = {
    id: "ticket-1",
    prompt: "要求",
    status: "dispatching",
    created_at: "",
    updated_at: "",
    options: { dry: false, maxTasks: 1, workRoot: "" },
  };
  const run = {
    ticketId: "ticket-1",
    seq: 2,
    task: {
      title: "写报告",
      slug: "report",
      instruction: "写一份报告",
      done_when: "report.md 存在",
      dependsOn: [],
      writes: [],
    },
    dir: "/tmp/ticket-1/02-report",
    dirName: "02-report",
    employee: "native" as const,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    processOk: true,
    processError: null,
    sessionId: null,
    reportExists: true,
    report: {
      status: "ready" as const,
      summary: "写完了",
      artifacts: ["report.md", "notes.md"],
      raw: "",
    },
    reportError: null,
    stderrTail: "",
    workDir: "/tmp/project",
  } as unknown as TaskRun;
  const requirement = buildQaRequirement({ run, ticket, total: 3 });
  assert.ok(!requirement.includes("{TICKET_ID}"));
  assert.match(requirement, /ticket-1（任务 2\/3：写报告）/);
  assert.match(requirement, /写一份报告/);
  assert.match(requirement, /report\.md 存在/);
  assert.match(requirement, /\/tmp\/project/);
  assert.match(requirement, /\/tmp\/ticket-1\/02-report/);
  assert.match(requirement, /report\.md、notes\.md/);
  // 模板纪律段还在（亲自验证、别信汇报、结论行）
  assert.match(requirement, /亲自验证/);
  assert.match(requirement, /DONE:/);
  assert.match(requirement, /CONTINUE:/);
  assert.match(requirement, /BLOCKED:/);
  // 模板文件是可编辑文本：真的从 templates/qa.md 读的
  const template = fs.readFileSync(
    new URL("./templates/qa.md", import.meta.url),
    "utf8",
  );
  assert.match(template, /CONTINUE: <原因>/);
});

test("setQaRunner：注入 / 卸载缝（宿主装配点用）", () => {
  assert.equal(qaRunnerAvailable(), false);
  setQaRunner(async () => "DONE: ok");
  assert.equal(qaRunnerAvailable(), true);
  setQaRunner(null);
  assert.equal(qaRunnerAvailable(), false);
});
