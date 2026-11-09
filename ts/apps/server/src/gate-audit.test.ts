import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditGateBlock, gateAuditEnabled } from "./gate-audit.ts";

/**
 * 闸门留痕（2026-11-09 保证实现纵深 §5）：一行落盘、字段齐全、不含参数。
 * 用 AGENT_GATE_AUDIT_PATH 指到临时目录，不碰真实 .data。
 */
test("闸门审计：写一行且只含工具名/类别/来源，不含参数", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-audit-"));
	const path = join(dir, "gate-blocks.jsonl");
	const env = { AGENT_GATE_AUDIT_PATH: path } as NodeJS.ProcessEnv;
	try {
		auditGateBlock(
			{ conversationId: 42, tool: "write", category: "policy", source: "policy" },
			env,
		);
		const lines = readFileSync(path, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
		assert.deepEqual(Object.keys(entry).sort(), [
			"at",
			"conversationId",
			"reason",
			"source",
			"tool",
		]);
		assert.equal(entry.conversationId, 42);
		assert.equal(entry.tool, "write");
		assert.equal(entry.reason, "policy");
		assert.equal(entry.source, "policy");
		assert.match(String(entry.at), /^\d{4}-\d{2}-\d{2}T/);
		// 参数 / 对话正文一律不许进账
		assert.equal(JSON.stringify(entry).includes("secret-arg"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("闸门审计：AGENT_GATE_AUDIT=false 时一行不写", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-audit-off-"));
	const path = join(dir, "gate-blocks.jsonl");
	const env = { AGENT_GATE_AUDIT: "false", AGENT_GATE_AUDIT_PATH: path } as NodeJS.ProcessEnv;
	try {
		assert.equal(gateAuditEnabled(env), false);
		auditGateBlock(
			{ conversationId: 1, tool: "bash", category: "approval", source: "approval" },
			env,
		);
		assert.throws(() => readFileSync(path, "utf8"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
