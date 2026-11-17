import assert from "node:assert/strict";
import { test } from "node:test";
import { enforceChildClosure } from "./stage.ts";
import type { ManagerDecision } from "./stage.ts";
import type { Ticket, TicketStatus } from "./types.ts";

function ticket(id: string, status: TicketStatus, error?: string): Ticket {
  return {
    id,
    prompt: `prompt of ${id}`,
    status,
    created_at: "2026-11-08T00:00:00.000Z",
    updated_at: "2026-11-08T00:00:00.000Z",
    options: { dry: false, maxTasks: 3, workRoot: "/tmp/chancellor/runs" },
    ...(error ? { error } : {}),
  };
}

function doneDecision(): ManagerDecision {
  return { status: "done", stage: "done", line: "✅ 父单完成", error: null };
}

test("子单 idle：父单不得 done，回 idle 并在文案里点名该子单", () => {
  const decided = enforceChildClosure(
    doneDecision(),
    [ticket("t-child-1", "idle")],
    "t-parent",
  );

  assert.equal(decided.status, "idle", "idle 子单是可续跑的非终态，父单不能宣布 done");
  assert.equal(decided.stage, "idle");
  assert.ok(decided.line.includes("t-child-1"), "文案必须点名是哪个子单");
  assert.ok(decided.line.includes("idle"), "文案要带出子单当前状态");
});

test("子单全部 done：父单 done 照旧", () => {
  const decided = enforceChildClosure(
    doneDecision(),
    [ticket("t-child-1", "done"), ticket("t-child-2", "done")],
    "t-parent",
  );

  assert.equal(decided.status, "done");
  assert.equal(decided.stage, "done");
  assert.equal(decided.line, "✅ 父单完成");
});

test("子单 failed：父单照旧转 needs_you 并点名", () => {
  const decided = enforceChildClosure(
    doneDecision(),
    [ticket("t-child-1", "failed", "验收没过")],
    "t-parent",
  );

  assert.equal(decided.status, "needs_you");
  assert.equal(decided.stage, "person/blocked");
  assert.ok(decided.line.includes("t-child-1"));
  assert.ok(decided.error?.includes("子单未完成"));
});
