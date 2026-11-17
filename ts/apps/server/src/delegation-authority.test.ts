import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChancellorEvent, TicketResult } from "../../../packages/chancellor/src/index.ts";
import {
	authorityRank,
	authorityRecheckEnabled,
	currentApprovalLevel,
	currentAuthority,
	recheckAuthority,
} from "./delegation-authority.ts";
import { DelegationReceipts } from "./delegation-receipts.ts";
import { startDelegation } from "./delegation.ts";

/**
 * 批 19 §六：授权依据写入 + 续跑前重验。纯函数 + 回执库 + 假 chancellor，不碰真实 `.data/`。
 */

test("档位排序：none < ask-critical < ask-all；认不出 → null", () => {
	assert.equal(authorityRank("none"), 0);
	assert.equal(authorityRank("ask-critical"), 1);
	assert.equal(authorityRank("ask-all"), 2);
	assert.equal(authorityRank(""), null);
	assert.equal(authorityRank("weird"), null);
	assert.equal(authorityRank(null), null);
});

test("重验：更严只 warning；更松 / 相同直接跑；读不到按更严", () => {
	const stricter = recheckAuthority("none", "ask-all");
	assert.equal(stricter.verdict, "stricter");
	assert.equal(stricter.stricter, true);
	assert.match(stricter.warning ?? "", /审批档更严了/);
	assert.match(stricter.warning ?? "", /受理时=none 现在=ask-all/);

	const looser = recheckAuthority("ask-all", "none");
	assert.equal(looser.verdict, "looser");
	assert.equal(looser.stricter, false);
	assert.equal(looser.warning, undefined);

	const same = recheckAuthority("ask-critical", "ask-critical");
	assert.equal(same.verdict, "same");
	assert.equal(same.stricter, false);

	for (const [before, now] of [
		[null, "none"],
		["none", null],
		[null, null],
		["bad", "none"],
	] as const) {
		const unknown = recheckAuthority(before, now);
		assert.equal(unknown.verdict, "unknown");
		assert.equal(unknown.stricter, true, "读不到按更严");
		assert.match(unknown.warning ?? "", /档位读不到/);
	}
});

test("回执落 authority：受理时写入 {level, at}", () => {
	const root = mkdtempSync(join(tmpdir(), "lifediary-authority-"));
	const db = join(root, "delegations.sqlite");
	try {
		const store = new DelegationReceipts(db);
		const at = new Date("2026-11-10T01:02:03.000Z");
		store.begin("req-auth", "fp", { explicit: true, authority: currentAuthority(at) });
		store.accept("req-auth", "T-auth");
		const receipt = store.lookup("req-auth");
		assert.deepEqual(receipt?.authority, { level: currentApprovalLevel(), at: at.toISOString() });
		store.close();

		// 重开读回（JSON 列解析容错路径）
		const reopened = new DelegationReceipts(db);
		assert.deepEqual(reopened.lookup("req-auth")?.authority, {
			level: currentApprovalLevel(),
			at: at.toISOString(),
		});
		reopened.close();
	} finally {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* Windows 句柄回收延迟 */
		}
	}
});

function resumeRuntime(logs: string[], authority: string | null, current: string | null) {
	return {
		run: (_request: unknown, options: { onEvent?: (event: ChancellorEvent) => void }) => {
			options.onEvent?.({ type: "ticket", ticketId: "T-resume", message: "已受理" });
			return Promise.resolve({
				ticketId: "T-resume",
				status: "done",
				line: "续上了",
				tasks: [],
			} as TicketResult);
		},
		emit: () => undefined,
		autoReport: false,
		authorityAtAccept: () => authority,
		approvalLevelNow: () => current,
		log: (line: string) => logs.push(line),
	};
}

test("续跑重验：现在更严 → 记 warning，照常续跑", async () => {
	const logs: string[] = [];
	const { outcome } = startDelegation(
		{ conversationId: 1, domain: "x", requirement: "继续", resumeTicketId: "T-resume" },
		resumeRuntime(logs, "none", "ask-all") as never,
	);
	await outcome;
	assert.equal(logs.filter((line) => line.includes("审批档更严了")).length, 1);
});

test("续跑重验：开关关掉 / 更松 → 不记 warning", async () => {
	const logs: string[] = [];
	await startDelegation(
		{ conversationId: 1, domain: "x", requirement: "继续", resumeTicketId: "T-resume" },
		resumeRuntime(logs, "ask-all", "none") as never,
	).outcome;
	assert.equal(logs.length, 0, "更松直接跑");

	const saved = process.env.DELEGATION_AUTHORITY_RECHECK;
	process.env.DELEGATION_AUTHORITY_RECHECK = "false";
	try {
		const offLogs: string[] = [];
		await startDelegation(
			{ conversationId: 1, domain: "x", requirement: "继续", resumeTicketId: "T-resume" },
			resumeRuntime(offLogs, "none", "ask-all") as never,
		).outcome;
		assert.equal(offLogs.length, 0, "开关关掉不比对");
		assert.equal(authorityRecheckEnabled(), false);
	} finally {
		if (saved === undefined) delete process.env.DELEGATION_AUTHORITY_RECHECK;
		else process.env.DELEGATION_AUTHORITY_RECHECK = saved;
	}
});
