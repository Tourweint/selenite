import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changedDeclaredPaths, snapshotDeclaredPaths } from "./isolation.ts";
import { buildDependencies, runScheduledTasks, type TaskRunner } from "./scheduler.ts";
import { Store } from "./store.ts";
import { buildWorkerPrompt, renderUpstream } from "./worker-prompt.ts";
import type { PlannedTask, Task, TaskRun, Ticket } from "./types.ts";

/** 2026-11-08 扫尾批 8e：上游已验收落盘的产物路径注入下游提示。 */

const HEADER = "上游产出（已验收落盘，可直接用 read 工具查看）：";

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `chancellor-8e-${label}-`));
}

function planned(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    title: "写材料",
    slug: "write-notes",
    instruction: "写两个文件。",
    done_when: "notes/a.md 与 notes/b.md 存在。",
    dependsOn: [],
    writes: [],
    ...overrides,
  };
}

function taskRun(overrides: Partial<TaskRun>): TaskRun {
  return {
    ticketId: "t-8e",
    seq: 1,
    task: planned(),
    dir: overrides.dir ?? tmpDir("task"),
    dirName: "01-write-notes",
    employee: "native",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    processOk: true,
    processError: null,
    sessionId: null,
    reportExists: true,
    report: null,
    reportError: null,
    stderrTail: "",
    ...overrides,
  };
}

/** 真的按声明 writes 写文件，再用快照前后对比算出 changedPaths（与验收同源）。 */
function realUpstreamRun(root: string, writes: string[], files: Record<string, string>): TaskRun {
  const before = snapshotDeclaredPaths(root, writes);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  const after = snapshotDeclaredPaths(root, writes, { previous: before.entries });
  return taskRun({
    dir: tmpDir("upstream-task"),
    task: planned({ writes }),
    changedPaths: changedDeclaredPaths(before.entries, after.entries),
  });
}

test("链式两单：上游真实落两个文件 → 下游提示里带产物清单", (t) => {
  const root = tmpDir("project");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes = ["notes/a.md", "notes/b.md"];
  const upstream = realUpstreamRun(root, writes, {
    "notes/a.md": "A\n",
    "notes/b.md": "B\n",
  });
  assert.deepEqual(upstream.changedPaths, ["notes/a.md", "notes/b.md"], "快照必须看到两个真实变更");

  const downstream = planned({ slug: "use-notes", dependsOn: [1], writes: [] });
  const deps = buildDependencies(downstream, [upstream], root);
  assert.deepEqual(deps[0]?.artifactPaths, ["notes/a.md", "notes/b.md"]);

  const prompt = buildWorkerPrompt(downstream, "02-use-notes", deps);
  assert.ok(prompt.includes(HEADER), "下游 TASK 提示必须带注入段");
  assert.ok(prompt.includes("- notes/a.md"));
  assert.ok(prompt.includes("- notes/b.md"));
});

test("上游没有落盘产物 → 不注入该段（不造假）", (t) => {
  const root = tmpDir("project");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = taskRun({ dir: tmpDir("upstream-task"), changedPaths: [] });

  const downstream = planned({ slug: "use-notes", dependsOn: [1] });
  const deps = buildDependencies(downstream, [upstream], root);
  assert.deepEqual(deps[0]?.artifactPaths, []);

  const prompt = buildWorkerPrompt(downstream, "02-use-notes", deps);
  assert.ok(!prompt.includes(HEADER), "空清单不许凭空注一段");
  assert.ok(prompt.includes("## 前置任务结果"), "REPORT 文本通道必须还在");
});

test("回滚开关双向：CHANCELLOR_UPSTREAM_ARTIFACTS=false 不注，改回 true 再注", (t) => {
  const root = tmpDir("project");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = realUpstreamRun(root, ["notes/a.md"], { "notes/a.md": "A\n" });
  const downstream = planned({ slug: "use-notes", dependsOn: [1] });
  const deps = buildDependencies(downstream, [upstream], root);
  assert.deepEqual(deps[0]?.artifactPaths, ["notes/a.md"], "收集不受开关影响，注入才受控");

  const previous = process.env.CHANCELLOR_UPSTREAM_ARTIFACTS;
  t.after(() => {
    if (previous === undefined) delete process.env.CHANCELLOR_UPSTREAM_ARTIFACTS;
    else process.env.CHANCELLOR_UPSTREAM_ARTIFACTS = previous;
  });

  process.env.CHANCELLOR_UPSTREAM_ARTIFACTS = "false";
  assert.ok(!renderUpstream(deps).includes(HEADER), "关掉后不注入");
  assert.ok(!renderUpstream(deps).includes("notes/a.md"), "关掉后路径全不出现");

  process.env.CHANCELLOR_UPSTREAM_ARTIFACTS = "true";
  assert.ok(renderUpstream(deps).includes(HEADER), "打开后恢复注入");
  assert.ok(renderUpstream(deps).includes("- notes/a.md"), "打开后路径回到提示里");
});

test("上游把文件删了：changedPaths 里有，但不存在就不注入（验收取的是落盘）", (t) => {
  const root = tmpDir("project");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "keep.md"), "K\n", "utf8");

  const upstream = taskRun({
    dir: tmpDir("upstream-task"),
    changedPaths: ["notes/keep.md", "notes/gone.md"],
  });
  const deps = buildDependencies(planned({ dependsOn: [1] }), [upstream], root);
  assert.deepEqual(deps[0]?.artifactPaths, ["notes/keep.md"]);
});

test("产物超过 20 条：只列前 20 条，并给总数说明", () => {
  const paths = Array.from({ length: 25 }, (_, index) => `out/f${String(index).padStart(2, "0")}.md`);
  const deps = buildDependencies(planned({ dependsOn: [1] }), [
    taskRun({ dir: tmpDir("upstream-task"), changedPaths: paths }),
  ]);
  const text = renderUpstream(deps);

  assert.equal((text.match(/^- out\//gm) ?? []).length, 20, "最多 20 条");
  assert.ok(text.includes("（共 25 条，只列前 20 条）"), "截断必须说清总数");
});

test("端到端调度：两单链式跑完，下游 TASK 提示里看得到上游落盘文件", async (t) => {
  const root = tmpDir("e2e");
  const workRoot = path.join(root, "runs");
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const store = new Store(workRoot);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const upstream = planned({
    slug: "write-notes",
    writes: ["notes/a.md", "notes/b.md"],
    dependsOn: [],
  });
  const downstream = planned({ slug: "use-notes", writes: [], dependsOn: [1] });
  const tasks = [upstream, downstream];

  const ticket: Ticket = {
    id: "t-8e-chain",
    prompt: "先写两份材料，再基于它总结。",
    status: "dispatching",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    options: { dry: false, maxTasks: 2, workRoot },
  };
  store.saveTicket(ticket);
  const rows: Task[] = tasks.map((task, index) => {
    const seq = index + 1;
    return {
      ticket_id: ticket.id,
      seq,
      slug: task.slug,
      title: task.title,
      dir: path.join(store.ticketDir(ticket.id), `${String(seq).padStart(2, "0")}-${task.slug}`),
      status: "pending",
      employee: null,
      updated_at: new Date().toISOString(),
    };
  });

  const prompts = new Map<number, string>();
  const runner: TaskRunner = async (
    _ticket,
    task,
    seq,
    ticketDir,
    _signal,
    deps,
    options,
  ): Promise<TaskRun> => {
    const dirName = `${String(seq).padStart(2, "0")}-${task.slug}`;
    const dir = path.join(ticketDir, dirName);
    const workDir = options?.workDir ?? dir;
    fs.mkdirSync(dir, { recursive: true });
    for (const relPath of task.writes) {
      const abs = path.join(workDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `落盘内容 ${relPath}\n`, "utf8");
    }
    const raw = '```json\n{"status":"ready","summary":"完成","artifacts":[]}\n```';
    fs.writeFileSync(path.join(dir, "REPORT.md"), raw, "utf8");
    prompts.set(seq, buildWorkerPrompt(task, dirName, deps, { workDir, taskDir: dir }));
    return {
      ticketId: _ticket.id,
      seq,
      task,
      dir,
      dirName,
      employee: "native",
      exitCode: 0,
      timedOut: false,
      aborted: false,
      processOk: true,
      processError: null,
      sessionId: null,
      reportExists: true,
      report: { status: "ready", summary: "完成", artifacts: [], raw },
      reportError: null,
      stderrTail: "",
      workDir,
    };
  };

  const result = await runScheduledTasks({
    ticket,
    store,
    tasks,
    rows,
    project: { id: "p-8e", name: "p8e", rootPath: projectRoot, vcs: "none" },
    employeeKind: "native",
    emit: () => {},
    runner,
    isolation: "direct",
  });

  assert.equal(result.runs.length, 2, "两单都要跑完");
  assert.deepEqual(result.runs[0]?.changedPaths, ["notes/a.md", "notes/b.md"]);
  const downstreamPrompt = prompts.get(2) ?? "";
  assert.ok(downstreamPrompt.includes(HEADER), "下游 TASK.md 必须带注入段");
  assert.ok(downstreamPrompt.includes("- notes/a.md"));
  assert.ok(downstreamPrompt.includes("- notes/b.md"));
});
