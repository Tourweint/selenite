import assert from "node:assert/strict";
import test from "node:test";
import { nextDailyAt } from "./reminder.ts";

test("nextDailyAt：正常 24h 后", () => {
	const at = new Date("2026-11-12T21:30:00+08:00").getTime();
	const now = new Date("2026-11-12T21:30:05+08:00").getTime();
	assert.equal(nextDailyAt(at, now), at + 24 * 60 * 60 * 1000);
});

test("nextDailyAt：机器睡过头跨过好几天，落在未来而不是把过去再排一次", () => {
	const at = new Date("2026-11-12T21:30:00+08:00").getTime();
	const now = new Date("2026-11-15T09:00:00+08:00").getTime();
	const next = nextDailyAt(at, now);
	assert.ok(next > now, "必须落在未来");
	assert.equal(next, new Date("2026-11-15T21:30:00+08:00").getTime());
});
