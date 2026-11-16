import assert from "node:assert/strict";
import { test } from "node:test";
import { setInternalAsk } from "../../../../../chancellor/src/index.ts";
import { planTicket } from "../../../../../chancellor/src/plan.ts";
import type { Ticket } from "../../../../../chancellor/src/types.ts";

test("planTicket 用注入的内部 ask（不再走 Qoder）", async () => {
	let calls = 0;
	let lastLabel = "";
	setInternalAsk(async (call) => {
		calls += 1;
		lastLabel = call.label;
		return {
			ok: true,
			result: [
				"```json",
				JSON.stringify({
					tasks: [
						{
							title: "写 hello",
							slug: "write-hello",
							instruction: "创建 hello.txt",
							done_when: "hello.txt 存在",
							dependsOn: [],
							writes: ["hello.txt"],
						},
					],
				}),
				"```",
			].join("\n"),
			sessionId: null,
			isError: false,
			permissionDenials: 0,
			exitCode: 0,
			timedOut: false,
			aborted: false,
			stderrTail: "",
			error: null,
		};
	});
	try {
		const ticket = {
			id: "t-test",
			prompt: "在当前项目写 hello.txt",
			status: "received",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			options: { dry: false, maxTasks: 2, workRoot: process.cwd() },
		} as unknown as Ticket;
		const result = await planTicket(ticket, 2);
		assert.equal(result.ok, true);
		assert.equal(result.tasks.length, 1);
		assert.equal(result.tasks[0]?.slug, "write-hello");
		assert.equal(calls, 1);
		assert.equal(lastLabel, "plan");
	} finally {
		setInternalAsk(null);
	}
});
