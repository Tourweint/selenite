import assert from "node:assert/strict";
import { test } from "node:test";
import { isExpiredRemoteRow, type RemoteRow } from "./relay-matrix.ts";

/** 最小台账行：只带 TTL 判定用得到的字段 */
function row(overrides: Partial<RemoteRow> = {}): RemoteRow {
	return {
		requestId: "req-1",
		targetDeviceId: "dev-1",
		targetDeviceName: "主机",
		targetTicketId: "T-1",
		domain: "worker",
		originInternalId: 1,
		phase: "done",
		updatedAt: 1_000,
		...overrides,
	};
}

const DAY = 24 * 60 * 60 * 1000;

test("isExpiredRemoteRow（批 31）：终态超 TTL 删、未终态留、ttl=0 不动", () => {
	const now = 10 * DAY;
	// 终态且超期：过期
	assert.equal(
		isExpiredRemoteRow(row({ finishedAt: now - 8 * DAY }), now, 7),
		true,
		"8 天前终态 > 7 天 TTL",
	);
	// 终态但未超期：留下（边界：恰好 7 天不清，超过才清）
	assert.equal(isExpiredRemoteRow(row({ finishedAt: now - 7 * DAY }), now, 7), false, "恰好 7 天 = 未超");
	assert.equal(isExpiredRemoteRow(row({ finishedAt: now - 6 * DAY }), now, 7), false);
	// 还在跑（finishedAt 未设）：永远不算过期——轮询还指着这行
	assert.equal(isExpiredRemoteRow(row({}), now, 7), false, "无 finishedAt = 未终态 = 不清");
	// ttl=0（回滚形态）：什么都不清
	assert.equal(isExpiredRemoteRow(row({ finishedAt: now - 400 * DAY }), now, 0), false, "TTL=0 = 不清理");
});
