import assert from "node:assert/strict";
import { test } from "node:test";
import {
  judgeEnabled,
  judgeMaxRounds,
  judgeMaxTools,
  judgeCallsOf,
  nextJudgeRound,
  shouldConsultJudge,
  decideJudgeOutcome,
  buildJudgeInput,
  DEFAULT_JUDGE_MAX_ROUNDS,
  DEFAULT_JUDGE_MAX_TOOLS,
} from "./judge.ts";
import { buildRepairRequirement } from "./repair.ts";
import type {
  JudgeCallRecord,
  JudgeOutcome,
  PlannedTask,
  Review,
  TaskRun,
  Ticket,
} from "./types.ts";

/**
 * 证据裁判（2026-11-10 批 14）：纯逻辑在这里断言，真正的只读会话在宿主侧
 * （`ts/apps/server/src/delegation-judge.test.ts` 断言工具面）。
 */

const OK: JudgeOutcome = {
  ok: true,
  verdict: "done",
  evidence: ["读了 src/a.ts：里面已经有导出函数 run()"],
  reason: "目标已达成",
  toolsUsed: 2,
};

function call(over: Partial<JudgeCallRecord>): JudgeCallRecord {
  return {
    round: 1,
    verdict: "continue",
    raw_verdict: "continue",
    reason: "a.ts 还没写",
    evidence: [],
    tools_used: 1,
    warnings: [],
    created_at: "2026-11-10T00:00:00.000Z",
    ...over,
  };
}

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "t-1",
    prompt: "把 a.ts 补上",
    status: "reviewing",
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-10T00:00:00.000Z",
    options: {
      dry: false,
      maxTasks: 2,
      workRoot: "/tmp/runs",
      project: {
        id: "p-1",
        name: "proj",
        rootPath: "/tmp/proj",
      },
    },
    ...over,
  };
}

function task(over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    title: "写 a.ts",
    slug: "write-a",
    instruction: "写 a.ts",
    done_when: "a.ts 里有 run()",
    dependsOn: [],
    writes: ["src/a.ts"],
    ...over,
  };
}

function run(over: Partial<TaskRun> = {}): TaskRun {
  return {
    ticketId: "t-1",
    seq: 1,
    task: task(),
    dir: "/tmp/runs/t-1/01-write-a",
    dirName: "01-write-a",
    employee: "native",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    processOk: true,
    processError: null,
    sessionId: null,
    reportExists: true,
    report: { status: "ready", summary: "写好了", artifacts: [], raw: "" },
    reportError: null,
    stderrTail: "",
    ...over,
  };
}

function review(over: Partial<Review> = {}): Review {
  return {
    ticket_id: "t-1",
    seq: 1,
    slug: "write-a",
    verdict: "fail",
    reason: "声明了 1 个路径，实际 0 个变更",
    stage: "artifacts",
    ...over,
  };
}

test("DELEGATION_JUDGE：默认关；只有显式 1/true/on 才开", () => {
  assert.equal(judgeEnabled({}), false);
  assert.equal(judgeEnabled({ DELEGATION_JUDGE: "" }), false);
  assert.equal(judgeEnabled({ DELEGATION_JUDGE: "1" }), true);
  assert.equal(judgeEnabled({ DELEGATION_JUDGE: "true" }), true);
  assert.equal(judgeEnabled({ DELEGATION_JUDGE: " ON " }), true);
  // 写错的值不该悄悄开始花钱
  assert.equal(judgeEnabled({ DELEGATION_JUDGE: "yes" }), false);
  assert.equal(judgeEnabled({ DELEGATION_JUDGE: "flase" }), false);
});

test("轮数 / 工具数上限：默认 3 / 8，非法回落默认，轮数 0 合法（关）", () => {
  assert.equal(judgeMaxRounds({}), DEFAULT_JUDGE_MAX_ROUNDS);
  assert.equal(judgeMaxRounds({ DELEGATION_JUDGE_MAX_ROUNDS: "0" }), 0);
  assert.equal(judgeMaxRounds({ DELEGATION_JUDGE_MAX_ROUNDS: "5" }), 5);
  assert.equal(judgeMaxRounds({ DELEGATION_JUDGE_MAX_ROUNDS: "abc" }), DEFAULT_JUDGE_MAX_ROUNDS);
  assert.equal(judgeMaxTools({}), DEFAULT_JUDGE_MAX_TOOLS);
  assert.equal(judgeMaxTools({ DELEGATION_JUDGE_MAX_TOOLS: "3" }), 3);
  // 0 / 负数 / 非数字 → 默认：0 次工具等于"查不了还硬判"
  assert.equal(judgeMaxTools({ DELEGATION_JUDGE_MAX_TOOLS: "0" }), DEFAULT_JUDGE_MAX_TOOLS);
  assert.equal(judgeMaxTools({ DELEGATION_JUDGE_MAX_TOOLS: "-2" }), DEFAULT_JUDGE_MAX_TOOLS);
});

test("开关关着时开闸判据恒 false（裁判一次都不会被叫到 = 与今天一致）", () => {
  let called = 0;
  const judge = async () => {
    called += 1;
    return OK;
  };
  const go = shouldConsultJudge({
    enabled: judgeEnabled({}),
    hasJudge: true,
    calls: 0,
    maxRounds: judgeMaxRounds({}),
    aborted: false,
  });
  assert.equal(go, false);
  if (go) void judge();
  assert.equal(called, 0);
});

test("开闸判据：没注入 / 轮次用完 / 已中止都叫不动", () => {
  const base = { enabled: true, hasJudge: true, calls: 0, maxRounds: 3, aborted: false };
  assert.equal(shouldConsultJudge(base), true);
  assert.equal(shouldConsultJudge({ ...base, enabled: false }), false);
  assert.equal(shouldConsultJudge({ ...base, hasJudge: false }), false);
  assert.equal(shouldConsultJudge({ ...base, aborted: true }), false);
  assert.equal(shouldConsultJudge({ ...base, maxRounds: 0 }), false);
  assert.equal(shouldConsultJudge({ ...base, calls: 3 }), false);
  assert.equal(shouldConsultJudge({ ...base, calls: 2 }), true);
});

test("judge.json 形状：坏数据当没有；轮次接着已有记录数", () => {
  assert.deepEqual(judgeCallsOf(null), []);
  assert.deepEqual(judgeCallsOf({ ticket: "t-1", calls: [] }), []);
  const broken = { ticket: "t-1", calls: [{ verdict: 1 }, null] } as unknown as {
    ticket: string;
    calls: JudgeCallRecord[];
  };
  assert.deepEqual(judgeCallsOf(broken), []);
  assert.equal(nextJudgeRound(null), 1);
  assert.equal(nextJudgeRound({ ticket: "t-1", calls: [call({}), call({ round: 2 })] }), 3);
});

test("铁律一：done 但一次工具都没动 → 降级 continue + warning", () => {
  const decision = decideJudgeOutcome({ ...OK, toolsUsed: 0 }, null);
  assert.equal(decision?.verdict, "continue");
  assert.equal(decision?.downgraded, true);
  assert.match(decision?.warnings.join("\n") ?? "", /没查就给通过/);
});

test("铁律一：done 但 evidence 全空 → 同样降级", () => {
  const decision = decideJudgeOutcome({ ...OK, evidence: ["", "   "] }, null);
  assert.equal(decision?.verdict, "continue");
  assert.equal(decision?.downgraded, true);
});

test("正常 done：有工具调用 + 有证据 → 原样放行", () => {
  const decision = decideJudgeOutcome(OK, null);
  assert.equal(decision?.verdict, "done");
  assert.equal(decision?.downgraded, false);
  assert.deepEqual(decision?.warnings, []);
  assert.equal(decision?.reason, "目标已达成");
});

test("铁律二：同一个 reason 连续两次 → blocked（空白差异不算不同）", () => {
  const first = call({ reason: "a.ts 还没写：需要补上 run()" });
  const decision = decideJudgeOutcome(
    { ok: true, verdict: "continue", evidence: ["看了 a.ts"], reason: "a.ts  还没写：\n需要补上 run()", toolsUsed: 1 },
    first,
  );
  assert.equal(decision?.verdict, "blocked");
  assert.equal(decision?.repeated, true);
  assert.match(decision?.warnings.join("\n") ?? "", /连续出现两次/);
});

test("不同 reason 的 continue 照常返工；上一次是 done 不触发连续判据", () => {
  const different = decideJudgeOutcome(
    { ok: true, verdict: "continue", evidence: ["看了 b.ts"], reason: "b.ts 缺测试", toolsUsed: 1 },
    call({ reason: "a.ts 还没写" }),
  );
  assert.equal(different?.verdict, "continue");
  const afterDone = decideJudgeOutcome(
    { ok: true, verdict: "continue", evidence: [], reason: "a.ts 还没写", toolsUsed: 1 },
    call({ verdict: "done", reason: "a.ts 还没写" }),
  );
  assert.equal(afterDone?.verdict, "continue");
});

test("裁判没给出结论（ok=false）→ null，按原有失败路径走", () => {
  assert.equal(
    decideJudgeOutcome({ ok: false, evidence: [], reason: "", toolsUsed: 0, error: "超时" }, null),
    null,
  );
  assert.equal(decideJudgeOutcome({ ...OK, verdict: undefined }, null), null);
});

test("裁判材料：cwd=合并后的项目根；没有快照时标记未检测；自报单独标注", () => {
  const input = buildJudgeInput({
    ticket: ticket({ steps: ["先读 README", "再写 a.ts"] }),
    tasks: [task()],
    runs: [run({ changedPaths: undefined })],
    reviews: [review()],
    ticketDir: "/tmp/runs/t-1",
    failureReason: "实际 0 个变更",
    maxTools: 5,
  });
  assert.equal(input.cwd, "/tmp/proj");
  assert.deepEqual(input.steps, ["先读 README", "再写 a.ts"]);
  assert.equal(input.maxTools, 5);
  assert.equal(input.failureReason, "实际 0 个变更");
  assert.equal(input.tasks[0]?.changedDetected, false);
  assert.deepEqual(input.tasks[0]?.changedPaths, []);
  assert.equal(input.tasks[0]?.reportSummary, "写好了");
  assert.equal(input.reviews[0]?.verdict, "fail");
  // 没有项目时退回任务单目录（老数据 / 无项目单）
  const noProject = buildJudgeInput({
    ticket: ticket({ options: { dry: false, maxTasks: 1, workRoot: "/tmp/runs" } }),
    tasks: [task()],
    runs: [run({ changedPaths: ["src/a.ts"] })],
    reviews: [review({ verdict: "pass" })],
    ticketDir: "/tmp/runs/t-1",
    failureReason: "整体没达成",
    maxTools: 5,
  });
  assert.equal(noProject.cwd, "/tmp/runs/t-1");
  assert.equal(noProject.tasks[0]?.changedDetected, true);
  assert.deepEqual(noProject.tasks[0]?.changedPaths, ["src/a.ts"]);
});

test("返工提示词：传裁判意见才多一段；不传时与旧文本一致", () => {
  const base = {
    requirement: "把 a.ts 补上",
    round: 1,
    reviews: [review()],
    runs: [run({ changedPaths: [] })],
  };
  const old = buildRepairRequirement(base);
  assert.doesNotMatch(old, /裁判复核意见/);
  const withJudge = buildRepairRequirement({ ...base, judgeReason: "a.ts 第 3 行少了 export" });
  assert.match(withJudge, /## 裁判复核意见/);
  assert.match(withJudge, /a\.ts 第 3 行少了 export/);
  // 旧段一个不少
  assert.match(withJudge, /## 原始要求\n把 a\.ts 补上$/);
});
