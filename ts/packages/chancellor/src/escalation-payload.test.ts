import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ESCALATION_LINE_PREFIX,
  escalationLine,
  normalizeEscalationInput,
  parseEscalationLine,
  workerEscalateToolEnabled,
  workerTurnBudget,
} from "./escalation-payload.ts";

test("normalizeEscalationInput：question/context 必填；超限截断；urgency 认不出按 normal", () => {
  const missing = normalizeEscalationInput({ question: "q" });
  assert.equal(missing.ok, false);
  const noContext = normalizeEscalationInput({ question: "q", context: "  " });
  assert.equal(noContext.ok, false);

  const okCase = normalizeEscalationInput({
    question: "x".repeat(600),
    context: "y".repeat(3000),
    options: ["a".repeat(200), "b", 42, "", "c", "d"],
    urgency: "WHENEVER",
  });
  assert.ok(okCase.ok);
  if (!okCase.ok) return;
  assert.equal(okCase.value.question.length, 501); // 500 + 尾部省略号
  assert.equal(okCase.value.context.length, 2001);
  assert.deepEqual(okCase.value.options, ["a".repeat(120), "b", "c"]);
  assert.equal(okCase.value.urgency, "normal");
  assert.match(okCase.value.escalationId, /^[0-9a-f-]{36}$/);
});

test("escalationLine / parseEscalationLine：一行往返；坏行返回 null 不抛", () => {
  const normalized = normalizeEscalationInput({ question: "选 A 还是 B？", context: "背景", urgency: "high" });
  assert.ok(normalized.ok);
  if (!normalized.ok) return;
  const line = escalationLine(normalized.value);
  assert.ok(line.startsWith(ESCALATION_LINE_PREFIX));
  assert.ok(!line.includes("\n"));
  const parsed = parseEscalationLine(line);
  assert.deepEqual(parsed, normalized.value);

  assert.equal(parseEscalationLine("[worker] 普通日志行"), null);
  assert.equal(parseEscalationLine(`${ESCALATION_LINE_PREFIX}{不是json`), null);
  assert.equal(parseEscalationLine(`${ESCALATION_LINE_PREFIX}{"escalationId":"x"}`), null);
  // 多行 payload（question 里带换行）：JSON 序列化转义后仍是一行，解析原样还原
  const withNewline = normalizeEscalationInput({ question: "第一行\n第二行", context: "c" });
  assert.ok(withNewline.ok);
  if (!withNewline.ok) return;
  assert.ok(!escalationLine(withNewline.value).includes("\n"));
  assert.deepEqual(parseEscalationLine(escalationLine(withNewline.value)), withNewline.value);
});

test("workerEscalateToolEnabled：默认开；false/0/off 关；拼错值不误关", () => {
  assert.equal(workerEscalateToolEnabled({}), true);
  assert.equal(workerEscalateToolEnabled({ WORKER_ESCALATE_TOOL: "false" }), false);
  assert.equal(workerEscalateToolEnabled({ WORKER_ESCALATE_TOOL: "0" }), false);
  assert.equal(workerEscalateToolEnabled({ WORKER_ESCALATE_TOOL: "off" }), false);
  assert.equal(workerEscalateToolEnabled({ WORKER_ESCALATE_TOOL: "offx" }), true);
  assert.equal(workerEscalateToolEnabled({ WORKER_ESCALATE_TOOL: "1" }), true);
});

test("workerTurnBudget：默认 3；0=关（合法值）；负数收 0；非数字关", () => {
  assert.equal(workerTurnBudget({}), 3);
  assert.equal(workerTurnBudget({ WORKER_TURN_BUDGET: "5" }), 5);
  assert.equal(workerTurnBudget({ WORKER_TURN_BUDGET: "0" }), 0);
  assert.equal(workerTurnBudget({ WORKER_TURN_BUDGET: "-2" }), 0);
  assert.equal(workerTurnBudget({ WORKER_TURN_BUDGET: "abc" }), 0);
  assert.equal(workerTurnBudget({ WORKER_TURN_BUDGET: "2.9" }), 2);
});
