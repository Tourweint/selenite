import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DELEGATION_STEPS_MAX,
	DELEGATION_STEP_MAX_CHARS,
	normalizeDelegationSteps,
} from "./delegation.ts";
import { intake } from "../../../../../chancellor/src/intake.ts";
import { appendPlanSteps } from "../../../../../chancellor/src/plan.ts";
import { Store } from "../../../../../chancellor/src/store.ts";
import type { Ticket } from "../../../../../chancellor/src/types.ts";

/**
 * 计划附件（2026-11-09 保证实现纵深 §2）：delegate 参数校验 + 落点 + 规划器可见。
 */

test("steps 校验：不传/空数组 = 旧行为；超 12 条 / 超 200 字 / 非字符串都拒绝", () => {
	assert.deepEqual(normalizeDelegationSteps(undefined), { ok: true });
	assert.deepEqual(normalizeDelegationSteps(null), { ok: true });
	assert.deepEqual(normalizeDelegationSteps([]), { ok: true });

	assert.equal(normalizeDelegationSteps(["a", "b"]).ok, true);
	const long = normalizeDelegationSteps(Array.from({ length: DELEGATION_STEPS_MAX + 1 }, (_, i) => `第${i}步`));
	assert.equal(long.ok, false);
	assert.equal(
		normalizeDelegationSteps(["x".repeat(DELEGATION_STEP_MAX_CHARS + 1)]).ok,
		false,
	);
	assert.equal(normalizeDelegationSteps([1] as unknown).ok, false);
	assert.equal(normalizeDelegationSteps(["  "]).ok, false);
	assert.equal(normalizeDelegationSteps("不是数组").ok, false);

	const trimmed = normalizeDelegationSteps(["  读 src/a.ts  ", "改完跑测试"]);
	assert.deepEqual(trimmed, { ok: true, steps: ["读 src/a.ts", "改完跑测试"] });
});

test("steps 落点：ticket.json 带 steps（不传时没有这个键）", () => {
	const root = mkdtempSync(join(tmpdir(), "steps-ticket-"));
	try {
		const store = new Store(root);
		try {
			const withSteps = intake(
				store,
				"把两件事做完",
				{ dry: true, maxTasks: 3, workRoot: root },
				"native",
				undefined,
				undefined,
				undefined,
				["读 a.ts", "改 b.ts"],
			);
			const raw = JSON.parse(
				readFileSync(join(root, withSteps.id, "ticket.json"), "utf8"),
			) as Ticket;
			assert.deepEqual(raw.steps, ["读 a.ts", "改 b.ts"]);

			const without = intake(
				store,
				"一件小事",
				{ dry: true, maxTasks: 3, workRoot: root },
				"native",
			);
			const plain = JSON.parse(
				readFileSync(join(root, without.id, "ticket.json"), "utf8"),
			) as Ticket;
			assert.equal("steps" in plain, false);
		} finally {
			store.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("steps 进规划器：拼成 ## 步骤 段；没有 steps 时逐字节不变", () => {
	assert.equal(appendPlanSteps("做两件事"), "做两件事");
	assert.equal(appendPlanSteps("做两件事", []), "做两件事");
	const withSteps = appendPlanSteps("做两件事", ["读 a.ts", "改 b.ts"]);
	assert.match(withSteps, /## 步骤/);
	assert.match(withSteps, /1\. 读 a\.ts\n2\. 改 b\.ts/);
	assert.ok(withSteps.startsWith("做两件事"));
});
