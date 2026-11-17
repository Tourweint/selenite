import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  decideResume,
  dispatchTask,
  readSessionId,
  RESUME_NOTICE_DISABLED,
  RESUME_NOTICE_NO_SESSION,
  RESUME_NOTICE_UNSUPPORTED,
  sessionFileFor,
  writeSessionRecord,
} from "./dispatch.ts";
import type { Employee, EmployeeOutcome, EmployeeTask } from "./employee/index.ts";
import {
  buildCodeBuddyInvocation,
  CODEBUDDY_CAPABILITIES,
  createCodeBuddyEmployee,
  type CodeBuddyCall,
} from "./employee/codebuddy.ts";
import {
  buildQoderInvocation,
  createQoderEmployee,
  QODER_CAPABILITIES,
  type QoderCall,
} from "./employee/qoder.ts";
import { buildResumePrompt } from "./employee/task-prompt.ts";
import { runScheduledTasks, type TaskRunner } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { PlannedTask, Task, Ticket } from "./types.ts";

/** 2026-11-08 扫尾批 8f：外部执行续跑（按 CLI 能力分档）。 */

const REPORT = '```json\n{"status":"ready","summary":"完成","artifacts":[]}\n```';

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `chancellor-8f-${label}-`));
}

function planned(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    title: "写材料",
    slug: "write-notes",
    instruction: "写一份材料。",
    done_when: "REPORT.md 里说清了结论。",
    dependsOn: [],
    writes: [],
    ...overrides,
  };
}

function baseTask(dir: string, sessionId?: string): EmployeeTask {
  return {
    instruction: "写一份材料。",
    doneWhen: "REPORT.md 里说清了结论。",
    upstream: "",
    dir,
    ...(sessionId ? { sessionId } : {}),
  };
}

function outcome(sessionId: string | null): EmployeeOutcome {
  return {
    processOk: true,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    reportRaw: REPORT,
    stderrTail: "",
    sessionId,
    error: null,
  };
}

function qoderResult(sessionId: string | null) {
  return {
    ok: true,
    result: "done",
    sessionId,
    isError: false,
    permissionDenials: 0,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    stderrTail: "",
    error: null,
  };
}

function ticket(workRoot: string): Ticket {
  return {
    id: "t-8f",
    prompt: "写材料。",
    status: "dispatching",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    options: { dry: false, maxTasks: 1, workRoot },
  };
}

test("buildResumePrompt 两形态：真续接只发人的回答；重派给整份任务书 + 回答", (t) => {
  const dir = tmpDir("prompt");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "TASK.md"), "旧的任务书：写材料。\n", "utf8");
  const task = baseTask(dir, "sess-10b-001");

  // 有会话号 = 真续接：旧会话里已经有任务书，这里只递人的答话（批 10-B）。
  const resumed = buildResumePrompt(task, "就选 A 方案", "sess-10b-001");
  assert.equal(resumed, "用户回复：就选 A 方案", "真续接提示就是一行回答");
  assert.ok(!resumed.includes("旧的任务书"), "续接提示不许出现 TASK.md 正文");
  assert.ok(!resumed.includes(task.dir), "续接提示不许带任务目录回顾");
  assert.ok(!resumed.includes("续跑"), "续接提示不许带续跑纪律段");

  // 没有会话号 = 重派：会话接不上，任务书和回答都得给。
  const redispatched = buildResumePrompt(task, "就选 A 方案", null);
  assert.ok(redispatched.startsWith("旧的任务书"), "重派第一段就是整份 TASK.md");
  assert.ok(redispatched.includes("就选 A 方案"), "重派也要把人的回答递过去");
  assert.ok(!redispatched.includes("这是续跑"), "重派不是续跑，不许注入续跑纪律");
});

test("qoder 续跑：-r <sessionId> 一起透传，提示只发人的回答", async (t) => {
  const dir = tmpDir("qoder");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "TASK.md"), "旧的任务书：写材料。\n", "utf8");

  const calls: QoderCall[] = [];
  const employee = createQoderEmployee("qoder-intl", async (call) => {
    calls.push(call);
    return qoderResult(call.resumeSessionId ?? null);
  });

  const result = await employee.resume!(
    baseTask(dir, "sess-8f-001"),
    "就选 A 方案",
    undefined,
  );
  const call = calls[0];
  assert.ok(call, "假 CLI 必须被调用一次");
  assert.equal(call.resumeSessionId, "sess-8f-001", "会话号必须原样透传");
  assert.equal(call.prompt, "用户回复：就选 A 方案", "真续接只递人的回答");
  assert.ok(!call.prompt.includes("旧的任务书"), "续接提示里不许出现 TASK.md 正文");
  assert.equal(result.sessionId, "sess-8f-001");

  const invocation = buildQoderInvocation(call, "m");
  const at = invocation.args.indexOf("-r");
  assert.ok(at >= 0, "qoder 参数里必须有 -r");
  assert.equal(invocation.args[at + 1], "sess-8f-001", "-r 后面必须紧跟会话号");
});

test("qoder 没有会话号：resume 退回整份 TASK.md，不带 -r（不假装续接）", async (t) => {
  const dir = tmpDir("qoder-nosession");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "TASK.md"), "旧的任务书：写材料。\n", "utf8");

  const calls: QoderCall[] = [];
  const employee = createQoderEmployee("qoder-intl", async (call) => {
    calls.push(call);
    return qoderResult(null);
  });

  await employee.resume!(baseTask(dir), "就选 A 方案", undefined);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.resumeSessionId, undefined, "没有会话号不许带 -r");
  assert.ok(call.prompt.includes("旧的任务书"), "退回重派要拿到完整任务书");
  assert.ok(call.prompt.includes("就选 A 方案"), "重派也要把人的回答递过去");
  assert.ok(!call.prompt.includes("这是续跑"), "重派不是续跑，不许注入续跑纪律");
});

test("codebuddy 续跑：能力开闸，-r <sessionId> 一起透传，提示只发人的回答", async (t) => {
  const dir = tmpDir("codebuddy");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "TASK.md"), "旧的任务书：写材料。\n", "utf8");

  const calls: CodeBuddyCall[] = [];
  const employee = createCodeBuddyEmployee(async (call) => {
    calls.push(call);
    return qoderResult(call.resumeSessionId ?? null);
  });

  assert.equal(CODEBUDDY_CAPABILITIES.resumeWithSession, true);

  const result = await employee.resume!(
    baseTask(dir, "sess-8f2-001"),
    "就选 A 方案",
    undefined,
  );
  const call = calls[0];
  assert.ok(call, "假 CLI 必须被调用一次");
  assert.equal(call.resumeSessionId, "sess-8f2-001", "会话号必须原样透传");
  assert.equal(call.prompt, "用户回复：就选 A 方案", "真续接只递人的回答");
  assert.ok(!call.prompt.includes("旧的任务书"), "续接提示里不许出现 TASK.md 正文");
  assert.equal(result.sessionId, "sess-8f2-001", "会话号要能回传给上层落盘");

  const invocation = buildCodeBuddyInvocation(call.prompt, "m", call.resumeSessionId);
  const at = invocation.args.indexOf("-r");
  assert.ok(at >= 0, "CodeBuddy 参数里必须有 -r");
  assert.equal(invocation.args[at + 1], "sess-8f2-001", "-r 后面必须紧跟会话号");

  // 长提示（>8000）走 stdin 时也要带 -r：真机验过这个组合可用。
  const longInvocation = buildCodeBuddyInvocation("x".repeat(9000), "m", "sess-8f2-001");
  assert.ok(longInvocation.stdin !== null, "长提示必须走 stdin");
  assert.ok(longInvocation.args.includes("-r"), "走 stdin 也必须带 -r");
});

test("codebuddy 没有会话号：resume 退回整份 TASK.md，不带 -r（不假装续接）", async (t) => {
  const dir = tmpDir("codebuddy-nosession");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "TASK.md"), "旧的任务书：写材料。\n", "utf8");

  const calls: CodeBuddyCall[] = [];
  const employee = createCodeBuddyEmployee(async (call) => {
    calls.push(call);
    return qoderResult(null);
  });

  await employee.resume!(baseTask(dir), "就选 A 方案", undefined);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.resumeSessionId, undefined, "没有会话号不许带 -r");
  assert.ok(call.prompt.includes("旧的任务书"), "退回重派要拿到完整任务书");
  assert.ok(call.prompt.includes("就选 A 方案"), "重派也要把人的回答递过去");
  assert.ok(!call.prompt.includes("这是续跑"), "重派不是续跑，不许注入续跑纪律");
  assert.ok(!buildCodeBuddyInvocation("继续").args.includes("-r"), "普通派活不许带 -r");
});

test("codebuddy 开闸后分到 session 档；缺号按重派并给对应文案", () => {
  assert.deepEqual(decideResume("codebuddy", "sess-anything"), {
    mode: "session",
    notice: null,
  });
  assert.equal(decideResume("codebuddy", null).mode, "redispatch");
  assert.equal(decideResume("codebuddy", null).notice, RESUME_NOTICE_NO_SESSION);
  // 其他档位不受影响：能力字段仍是唯一判据。
  assert.equal(RESUME_NOTICE_UNSUPPORTED, "该执行者不支持续跑，已重派新单，上一段上下文不延续");

  // 原生 / MCP / 手机有自己的 resume 语义，不属于外部 CLI 分档，也不该被塞提示。
  assert.deepEqual(decideResume("native", "sess-anything"), { mode: "employee", notice: null });
  assert.deepEqual(decideResume("phone", null), { mode: "employee", notice: null });
});

test("qoder 有会话号才分到 session 档；缺号按重派并给对应文案", () => {
  assert.deepEqual(decideResume("qoder-intl", "sess-1"), { mode: "session", notice: null });
  assert.equal(QODER_CAPABILITIES.resumeWithSession, true);
  assert.equal(decideResume("qoder-intl", null).mode, "redispatch");
  assert.equal(decideResume("qoder-intl", null).notice, RESUME_NOTICE_NO_SESSION);
  assert.equal(decideResume("mercenary", "sess-1").mode, "session", "旧名字走同一份能力");
});

test("会话号落盘：下一次 dispatch（等同重启后的新调用）能读回并透传给雇员", async (t) => {
  const root = tmpDir("session");
  const workRoot = path.join(root, "runs");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tk = ticket(workRoot);
  const task = planned();

  const seen: Array<string | null | undefined> = [];
  const employee: Employee = {
    kind: "qoder-intl",
    capabilities: QODER_CAPABILITIES,
    run: async () => outcome("sess-disk-1"),
    resume: async (employeeTask) => {
      seen.push(employeeTask.sessionId);
      return outcome(employeeTask.sessionId ?? null);
    },
  };

  const first = await dispatchTask(tk, task, 1, workRoot, undefined, [], {
    employeeKind: "qoder-intl",
    employeeFactory: () => employee,
  });
  assert.equal(first.sessionId, "sess-disk-1", "TaskRun 上也要带这次会话号");
  assert.equal(
    readSessionId(first.dir),
    "sess-disk-1",
    "落盘的 session.json 必须能被新读回（不靠内存）",
  );
  assert.ok(fs.existsSync(sessionFileFor(first.dir)));

  // 第二次是全新调用，除磁盘外没有任何状态；必须仍然读得到。
  const second = await dispatchTask(tk, task, 1, workRoot, undefined, [], {
    employeeKind: "qoder-intl",
    resumeAnswer: "就选 A 方案",
    employeeFactory: () => employee,
  });
  assert.deepEqual(seen, ["sess-disk-1"], "resume 必须拿到重启前落盘的会话号");
  assert.equal(second.sessionId, "sess-disk-1");
});

test("回滚闸门双向：CHANCELLOR_RESUME_EXTERNAL=false 不传会话号，=true 再传", async (t) => {
  const root = tmpDir("rollback");
  const workRoot = path.join(root, "runs");
  const ticketDir = path.join(workRoot, "t-8f");
  const taskDir = path.join(ticketDir, "01-write-notes");
  fs.mkdirSync(taskDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSessionRecord(taskDir, {
    ticket_id: "t-8f",
    seq: 1,
    employee: "qoder-intl",
    session_id: "sess-rollback",
    updated_at: new Date().toISOString(),
  });

  const previous = process.env.CHANCELLOR_RESUME_EXTERNAL;
  t.after(() => {
    if (previous === undefined) delete process.env.CHANCELLOR_RESUME_EXTERNAL;
    else process.env.CHANCELLOR_RESUME_EXTERNAL = previous;
  });

  const seen: Array<string | null | undefined> = [];
  const employee: Employee = {
    kind: "qoder-intl",
    capabilities: QODER_CAPABILITIES,
    run: async () => outcome(null),
    resume: async (employeeTask) => {
      seen.push(employeeTask.sessionId);
      return outcome(employeeTask.sessionId ?? null);
    },
  };
  const tk = ticket(workRoot);
  const task = planned();

  process.env.CHANCELLOR_RESUME_EXTERNAL = "false";
  assert.deepEqual(decideResume("qoder-intl", "sess-rollback"), {
    mode: "redispatch",
    notice: RESUME_NOTICE_DISABLED,
  });
  await dispatchTask(tk, task, 1, ticketDir, undefined, [], {
    employeeKind: "qoder-intl",
    resumeAnswer: "就选 A 方案",
    employeeFactory: () => employee,
  });
  assert.deepEqual(seen, [undefined], "关掉后不许把会话号交给雇员");

  process.env.CHANCELLOR_RESUME_EXTERNAL = "true";
  assert.equal(decideResume("qoder-intl", "sess-rollback").mode, "session");
  await dispatchTask(tk, task, 1, ticketDir, undefined, [], {
    employeeKind: "qoder-intl",
    resumeAnswer: "就选 A 方案",
    employeeFactory: () => employee,
  });
  assert.deepEqual(seen, [undefined, "sess-rollback"], "打开后恢复透传");
});

test("链式续跑：上游 blocked 后 resume 带会话号重跑，下游只跑一次", async (t) => {
  const root = tmpDir("chain");
  const workRoot = path.join(root, "runs");
  const ticketDir = path.join(workRoot, "t-8f-chain");
  fs.mkdirSync(ticketDir, { recursive: true });
  const store = new Store(workRoot);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const upstream = planned({ slug: "collect" });
  const downstream = planned({ slug: "summary", dependsOn: [1] });
  const tasks = [upstream, downstream];
  const tk: Ticket = { ...ticket(workRoot), id: "t-8f-chain" };
  store.saveTicket(tk);
  const rows: Task[] = tasks.map((task, index) => {
    const seq = index + 1;
    return {
      ticket_id: tk.id,
      seq,
      slug: task.slug,
      title: task.title,
      dir: `${String(seq).padStart(2, "0")}-${task.slug}`,
      status: "pending",
      employee: null,
      updated_at: new Date().toISOString(),
    };
  });

  const executions = new Map<number, number>();
  const resumeAnswers: string[] = [];
  const blockedReport =
    '```json\n{"status":"blocked","summary":"缺参数","artifacts":[],"attention":{"question":"选 A 还是 B？","kind":"need_decision"}}\n```';
  const employee: Employee = {
    kind: "qoder-intl",
    capabilities: QODER_CAPABILITIES,
    run: async (employeeTask) => {
      const seq = employeeTask.dir.endsWith("01-collect") ? 1 : 2;
      executions.set(seq, (executions.get(seq) ?? 0) + 1);
      return seq === 1
        ? { ...outcome("sess-chain-1"), reportRaw: blockedReport }
        : outcome(null);
    },
    resume: async (employeeTask, answer) => {
      resumeAnswers.push(answer);
      executions.set(1, (executions.get(1) ?? 0) + 1);
      return outcome(employeeTask.sessionId ?? null);
    },
  };

  let resumePhase = false;
  const runner: TaskRunner = (ticketArg, task, seq, dir, signal, deps, options) =>
    dispatchTask(ticketArg, task, seq, dir, signal, deps, {
      ...(options ?? {}),
      employeeKind: "qoder-intl",
      employeeFactory: () => employee,
      ...(resumePhase && seq === 1 ? { resumeAnswer: "选 A" } : {}),
    });

  // 第一轮：上游 blocked + 落会话号，下游照常依赖上游的报告跑完。
  const first = await runScheduledTasks({
    ticket: tk,
    store,
    tasks,
    rows,
    employeeKind: "qoder-intl",
    emit: () => {},
    runner,
    isolation: "direct",
  });
  assert.equal(first.runs.length, 2);
  assert.equal(executions.get(1), 1);
  assert.equal(executions.get(2), 1);
  assert.equal(readSessionId(path.join(ticketDir, "01-collect")), "sess-chain-1");
  const downstreamPrompt = fs.readFileSync(
    path.join(ticketDir, "02-summary", "TASK.md"),
    "utf8",
  );
  assert.ok(downstreamPrompt.includes("缺参数"), "下游必须看得到上游的 blocked 报告");

  // 第二轮：只续跑上游（与 resumeTicket 的 onlySeqs 同形），下游不许重跑。
  resumePhase = true;
  const second = await runScheduledTasks({
    ticket: tk,
    store,
    tasks,
    rows,
    employeeKind: "qoder-intl",
    emit: () => {},
    runner,
    isolation: "direct",
    initialRuns: first.runs.filter((run) => run.seq === 2),
    onlySeqs: [1],
  });
  assert.equal(executions.get(1), 2, "上游必须被续跑一次");
  assert.equal(executions.get(2), 1, "下游不许被续跑顺带重跑");
  assert.deepEqual(resumeAnswers, ["选 A"], "人的回答必须交给 resume");
  assert.equal(second.runs.length, 2, "续跑结果要合回 runs");
});
