/**
 * 一人多会话批1（2026-11-17）纯函数单测：
 * 对外 id 解析 / 续话分流 / 开关包装 / 侧栏任务归属。
 * 全部不碰真实 `.data`（flag 用普通 env 夹具，走纯 env 语义）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parsePartnerExternalId,
	partnerContinuePlan,
	sideSessionsEnabled,
} from "./partner-session-role.ts";
import { dispatchOwnerOf } from "./task-chat-owner.ts";

test("parsePartnerExternalId：canonical / side / group / partnerId 含连字符 / 非 partner 前缀", () => {
	assert.deepEqual(parsePartnerExternalId("partner-diary"), {
		partnerId: "diary",
		role: "canonical",
	});
	assert.deepEqual(parsePartnerExternalId("partner-diary-side-1a2b3c4d"), {
		partnerId: "diary",
		role: "side",
	});
	assert.deepEqual(parsePartnerExternalId("partner-diary-group-abc"), {
		partnerId: "diary",
		role: "group",
	});
	// partnerId 本身含 "-"，不能 split("-") 猜
	assert.deepEqual(parsePartnerExternalId("partner-a-b"), {
		partnerId: "a-b",
		role: "canonical",
	});
	assert.equal(parsePartnerExternalId("worker-123"), null);
	assert.equal(parsePartnerExternalId(null), null);
	assert.equal(parsePartnerExternalId(undefined), null);
});

test("partnerContinuePlan：side 开关决定放行 / 拒绝，其余一律折回 canonical", () => {
	assert.equal(partnerContinuePlan("canonical", true), "canonical");
	assert.equal(partnerContinuePlan("side", true), "side");
	assert.equal(partnerContinuePlan("side", false), "reject");
	assert.equal(partnerContinuePlan("group", true), "canonical");
	assert.equal(partnerContinuePlan("routine", true), "canonical");
	assert.equal(partnerContinuePlan("topic", true), "canonical");
	assert.equal(partnerContinuePlan("delegation", true), "canonical");
	assert.equal(partnerContinuePlan(null, true), "canonical");
});

test("sideSessionsEnabled：缺省开，显式 false 关，父开关关也关", () => {
	assert.equal(sideSessionsEnabled({} as NodeJS.ProcessEnv), true);
	assert.equal(
		sideSessionsEnabled({ PARTNER_SIDE_SESSIONS: "false" } as NodeJS.ProcessEnv),
		false,
	);
	// 父子门：COMPANIONS_ENABLED 关时本开关也视为关
	assert.equal(
		sideSessionsEnabled({ COMPANIONS_ENABLED: "false" } as NodeJS.ProcessEnv),
		false,
	);
});

test("dispatchOwnerOf：group / side 都归到真正的 partnerId，非 partner 归 chief", () => {
	assert.deepEqual(dispatchOwnerOf("partner-x-group-g1"), {
		dispatchedBy: "x",
		isPartnerHost: true,
	});
	assert.deepEqual(dispatchOwnerOf("partner-x-side-1a2b3c4d"), {
		dispatchedBy: "x",
		isPartnerHost: true,
	});
	assert.deepEqual(dispatchOwnerOf("partner-a-b"), {
		dispatchedBy: "a-b",
		isPartnerHost: true,
	});
	assert.deepEqual(dispatchOwnerOf("worker-123"), {
		dispatchedBy: "chief",
		isPartnerHost: false,
	});
	assert.deepEqual(dispatchOwnerOf(null), {
		dispatchedBy: "chief",
		isPartnerHost: false,
	});
});
