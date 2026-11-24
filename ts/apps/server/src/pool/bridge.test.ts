import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { startPoolBridge, type BridgePoolClient } from "./bridge.ts";
import type { QueuedRun, TicketEvent } from "./run-queue.ts";

function runOf(ticketId: string): QueuedRun {
	return {
		ticketId,
		dir: `C:\\tmp\\${ticketId}`,
		workDir: `C:\\tmp\\${ticketId}`,
		instruction: "干一件小事",
		doneWhen: "写完 REPORT.md",
		writes: ["src/a.ts"],
		roots: [{ label: "手机端", path: path.resolve("tmp", `${ticketId}-phone`), role: "extra" }],
	};
}

async function readEvents(response: Response): Promise<TicketEvent[]> {
	assert.equal(response.status, 200);
	const text = await response.text();
	return text
		.split("\n\n")
		.map((frame) => {
			const line = frame.split("\n").find((item) => item.startsWith("data:"));
			if (!line) return null;
			return JSON.parse(line.slice(5).trim()) as TicketEvent;
		})
		.filter((event): event is TicketEvent => event !== null);
}

test("池桥：鉴权、收票、SSE 回放与 settled", async () => {
	const events: string[] = [];
	const seen: QueuedRun[] = [];
	const client: BridgePoolClient = {
		async run(run, onEvent) {
			seen.push(run);
			onEvent({ type: "progress", message: "开工" });
			onEvent({
				type: "escalation",
				escalation: { escalationId: "e1", question: "选 A 还是 B", context: "背景" },
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			onEvent({ type: "settled", ok: true, reason: "done" });
			return { ok: true, reason: "done" };
		},
		async say(ticketId, text) {
			events.push(`say:${ticketId}:${text}`);
			return { ok: true };
		},
		async abort(ticketId) {
			events.push(`abort:${ticketId}`);
			return { ok: true };
		},
	};
	const escalations: Array<{ ticketId: string; escalation: Record<string, unknown> }> = [];
	const bridge = await startPoolBridge(client, {
		onEscalation: (ticketId, escalation) => escalations.push({ ticketId, escalation }),
		onLog: () => {},
	});
	try {
		const unauth = await fetch(`${bridge.endpoint}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(runOf("t-1")),
		});
		assert.equal(unauth.status, 403);
		assert.equal(await unauth.text(), "");

		const posted = await fetch(`${bridge.endpoint}/run`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bridge.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(runOf("t-1")),
		});
		assert.equal(posted.status, 202);
		assert.deepEqual(seen[0]?.writes, ["src/a.ts"]);
		assert.deepEqual(seen[0]?.roots, [
			{ label: "手机端", path: path.resolve("tmp", "t-1-phone"), role: "extra" },
		]);

		const stream = await fetch(`${bridge.endpoint}/run/t-1/events`, {
			headers: { authorization: `Bearer ${bridge.token}` },
		});
		const received = await readEvents(stream);
		assert.deepEqual(
			received.map((event) => event.type),
			["progress", "escalation", "settled"],
		);
		assert.equal(escalations.length, 1);
		assert.equal(escalations[0]?.ticketId, "t-1");
		assert.equal(escalations[0]?.escalation.question, "选 A 还是 B");

		const said = await fetch(`${bridge.endpoint}/run/t-1/say`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bridge.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ text: "A" }),
		});
		assert.equal(said.status, 200);
		assert.deepEqual(events, ["say:t-1:A"]);

		const health = await fetch(`${bridge.endpoint}/health`);
		assert.equal(health.status, 200);
	} finally {
		await bridge.close();
	}
});

test("池桥：重复票 409；缺字段 400", async () => {
	const client: BridgePoolClient = {
		run() {
			return new Promise(() => {}); // 永不结算
		},
		async say() {
			return { ok: true };
		},
		async abort() {
			return { ok: true };
		},
	};
	const bridge = await startPoolBridge(client, { onLog: () => {} });
	try {
		const headers = {
			authorization: `Bearer ${bridge.token}`,
			"content-type": "application/json",
		};
		const first = await fetch(`${bridge.endpoint}/run`, {
			method: "POST",
			headers,
			body: JSON.stringify(runOf("t-2")),
		});
		assert.equal(first.status, 202);
		const duplicate = await fetch(`${bridge.endpoint}/run`, {
			method: "POST",
			headers,
			body: JSON.stringify(runOf("t-2")),
		});
		assert.equal(duplicate.status, 409);
		const bad = await fetch(`${bridge.endpoint}/run`, {
			method: "POST",
			headers,
			body: JSON.stringify({ ticketId: "t-3" }),
		});
		assert.equal(bad.status, 400);
		const badRoots = await fetch(`${bridge.endpoint}/run`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				...runOf("t-4"),
				roots: [{ label: "x", path: "relative/dir", role: "extra" }],
			}),
		});
		assert.equal(badRoots.status, 400);
	} finally {
		await bridge.close();
	}
});
