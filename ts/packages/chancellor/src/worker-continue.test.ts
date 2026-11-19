import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  NO_PROGRESS_FUSE,
  buildContinueInput,
  countToolCallsSince,
  markReportBlocked,
  nextNoProgressStreak,
  planNextRound,
} from "./worker-continue.ts";

// ── planNextRound（续行判定）────────────────────────────────

test("planNextRound：预算关（0）= 不续，无论 REPORT 什么状态", () => {
  assert.equal(planNextRound({ reportStatus: null, usedBudget: 0, maxBudget: 0, noProgressStreak: 0 }).kind, "stop");
  assert.equal(
    (planNextRound({ reportStatus: null, usedBudget: 0, maxBudget: 0, noProgressStreak: 0 }) as { reason: string }).reason,
    "off",
  );
});

test("planNextRound：REPORT 非终态（waiting / progress / 没写）且有余量 → 接轮", () => {
  for (const status of ["waiting", "progress", null]) {
    assert.equal(
      planNextRound({ reportStatus: status, usedBudget: 0, maxBudget: 3, noProgressStreak: 0 }).kind,
      "arm",
      `status=${status}`,
    );
  }
});

test("planNextRound：REPORT 终态（ready/failed/dropped/blocked）→ 停", () => {
  for (const status of ["ready", "failed", "dropped", "blocked"]) {
    const decision = planNextRound({ reportStatus: status, usedBudget: 0, maxBudget: 3, noProgressStreak: 0 });
    assert.equal(decision.kind, "stop", `status=${status}`);
    assert.equal((decision as { reason: string }).reason, "terminal");
  }
});

test("planNextRound：预算用尽 → 停", () => {
  assert.equal(
    planNextRound({ reportStatus: null, usedBudget: 3, maxBudget: 3, noProgressStreak: 0 }).kind,
    "stop",
  );
});

test("续行保险丝：连续 3 个续行轮零工具调用 → blocked 退场（先于预算与终态判定）", () => {
  const fuse = planNextRound({ reportStatus: null, usedBudget: 1, maxBudget: 3, noProgressStreak: NO_PROGRESS_FUSE });
  assert.equal(fuse.kind, "stop");
  assert.equal((fuse as { reason: string }).reason, "fuse");
  // 连击没到 3 不触发：2 轮空转 + 预算还有 → 继续给机会
  assert.equal(planNextRound({ reportStatus: null, usedBudget: 1, maxBudget: 3, noProgressStreak: 2 }).kind, "arm");
  // 保险丝优先于 off / budget / terminal 的 reason（同一轮里谁先到都不放行）
  const offFuse = planNextRound({ reportStatus: "ready", usedBudget: 9, maxBudget: 0, noProgressStreak: 3 });
  assert.equal((offFuse as { reason: string }).reason, "fuse");
});

test("nextNoProgressStreak：有调用清零、零调用连击 +1", () => {
  assert.equal(nextNoProgressStreak(2, 0), 3);
  assert.equal(nextNoProgressStreak(2, 4), 0);
});

// ── markReportBlocked（保险丝退场时改写 REPORT）──────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "worker-continue-"));
}

const WAITING_REPORT = [
  "# REPORT",
  "",
  "```json",
  '{"status":"waiting","summary":"干了一半","artifacts":["a.txt"]}',
  "```",
].join("\n");

test("markReportBlocked：waiting → blocked，其余字段与正文保留，注记追加在文末", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "REPORT.md"), WAITING_REPORT, "utf8");
    const rewrote = markReportBlocked(dir, "续行保险丝触发（测试）。");
    assert.equal(rewrote, true);
    const out = fs.readFileSync(path.join(dir, "REPORT.md"), "utf8");
    assert.match(out, /"status": "blocked"/);
    assert.match(out, /干了一半/);
    assert.match(out, /"artifacts":\["a.txt"\]/);
    assert.match(out, /\[系统\] 续行保险丝触发（测试）。/);
    // 终态结论不是 ready：宿主验收按 blocked → needs_you 走"需要人"老通道。
    assert.doesNotMatch(out, /"status": "waiting"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("markReportBlocked：REPORT 缺失 → 只写注记文件，不改判定（返回 false）", () => {
  const dir = tempDir();
  try {
    const rewrote = markReportBlocked(dir, "保险丝（无 REPORT 场景）。");
    assert.equal(rewrote, false);
    const out = fs.readFileSync(path.join(dir, "REPORT.md"), "utf8");
    assert.match(out, /\[系统\] 保险丝（无 REPORT 场景）。/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("markReportBlocked：failed/dropped/blocked 终态不改写——只追加注记", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(
      path.join(dir, "REPORT.md"),
      "# REPORT\n\n```json\n{\"status\":\"failed\",\"summary\":\"挂了\",\"artifacts\":[]}\n```",
      "utf8",
    );
    assert.equal(markReportBlocked(dir, "不该改失败结论。"), false);
    const out = fs.readFileSync(path.join(dir, "REPORT.md"), "utf8");
    assert.match(out, /"status":"failed"/);
    assert.match(out, /\[系统\] 不该改失败结论。/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("markReportBlocked：ready 也改写——3 轮零调用的「自报完成」是假完成，保险丝要把它标成 blocked", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(
      path.join(dir, "REPORT.md"),
      "# REPORT\n\n```json\n{\"status\":\"ready\",\"summary\":\"done\",\"artifacts\":[]}\n```",
      "utf8",
    );
    assert.equal(markReportBlocked(dir, "空转保险丝。"), true);
    const out = fs.readFileSync(path.join(dir, "REPORT.md"), "utf8");
    assert.match(out, /"status": "blocked"/);
    assert.match(out, /done/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 其余纯件 ────────────────────────────────────────────────

test("buildContinueInput：带 [续行] 标记、带轮次与上一轮锚点", () => {
  const text = buildContinueInput(2, "干了一半");
  assert.match(text, /^\[续行\]/);
  assert.match(text, /第 2 段续轮/);
  assert.match(text, /上一轮汇报：干了一半/);
  assert.match(text, /已完成的部分（X）|盘点|剩余/);
  const withoutAnchor = buildContinueInput(1, null);
  assert.match(withoutAnchor, /没有留下汇报摘要/);
});

test("countToolCallsSince：只数 toolResult，fromIndex 之前的忽略", () => {
  const messages = [
    { role: "user" },
    { role: "assistant" },
    { role: "toolResult" },
    { role: "assistant" },
    { role: "toolResult" },
    { role: "toolResult" },
  ];
  assert.equal(countToolCallsSince(messages, 0), 3);
  assert.equal(countToolCallsSince(messages, 3), 2);
  assert.equal(countToolCallsSince(messages, 99), 0);
});
