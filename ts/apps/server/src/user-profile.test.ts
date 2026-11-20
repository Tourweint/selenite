import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInjections } from "./agent/injection.ts";
import { userProfileProviderWith } from "./agent/lifecycle-injections.ts";
import {
	renderUserProfileSection,
	readUserProfile,
	USER_PROFILE_LIMIT,
	userProfileAgentsOf,
	userProfilePayload,
	writeUserProfile,
} from "./user-profile.ts";

/**
 * 「关于我」（2026-11-19）单测：
 * - 存储层：文件优先、trim、空串删文件、8192 上限；
 * - 投影：总管在前、归档不列、开关默认读；
 * - 注入 provider：总管 / 执事开关 / worker / 群会话 / 空内容 / 总闸。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-user-profile-"));
const env = { USER_PROFILE_PATH: join(root, "profile.md") } as NodeJS.ProcessEnv;

test("存储：写入后读回 trim；空串 = 删文件；缺文件读空", () => {
	assert.equal(readUserProfile(env), "");
	writeUserProfile("  我常用语音输入，可能有错字。\n", env);
	assert.equal(readUserProfile(env), "我常用语音输入，可能有错字。");
	writeUserProfile("", env);
	assert.equal(existsSync(env.USER_PROFILE_PATH ?? ""), false);
	assert.equal(readUserProfile(env), "");
});

test("存储：超过 8192 字节拒绝，且不破坏旧内容", () => {
	writeUserProfile("旧内容", env);
	assert.throws(
		() => writeUserProfile("字".repeat(USER_PROFILE_LIMIT), env),
		/字节上限/,
	);
	assert.equal(readUserProfile(env), "旧内容");
	assert.ok(readFileSync(env.USER_PROFILE_PATH ?? "", "utf8").includes("旧内容"));
});

test("注入正文：空内容 undefined；非空带固定头", () => {
	assert.equal(renderUserProfileSection(""), undefined);
	assert.equal(renderUserProfileSection("  "), undefined);
	const text = renderUserProfileSection("我常用语音输入。");
	assert.ok(text?.startsWith("【关于我】"));
	assert.ok(text?.includes("我常用语音输入。"));
});

test("投影：总管在前、归档不列、read 默认 true", () => {
	const agents = userProfileAgentsOf({
		list: () => [
			{ id: "p-1", name: "小记", status: "active" },
			{ id: "chief", name: "总管", status: "active" },
			{ id: "p-off", name: "不读的", status: "paused", userProfileRead: false },
			{ id: "p-arch", name: "归档的", status: "archived" },
		],
	});
	assert.deepEqual(
		agents.map((agent) => [agent.id, agent.kind, agent.read]),
		[
			["chief", "chief", true],
			["p-1", "partner", true],
			["p-off", "partner", false],
		],
	);
});

test("投影：总闸关 = enabled/editable false，正文照常回", () => {
	const payload = userProfilePayload(
		{ ...env, USER_PROFILE_ENABLED: "false" },
		{ list: () => [{ id: "chief", name: "总管", status: "active" }] },
	);
	assert.equal(payload.enabled, false);
	assert.equal(payload.editable, false);
	assert.equal(payload.workerReads, false);
});

test("注入 provider：总管 / 执事开关 / worker / 群会话 / 空内容 / 总闸", () => {
	const base = {
		enabled: () => true,
		content: () => "我常用语音输入，可能有识别错字。",
		reads: (agentId: string) => agentId !== "p-off",
	};
	const collect = (ctx: Parameters<typeof collectInjections>[1]) =>
		collectInjections([userProfileProviderWith(base)], ctx).system[0];

	const chief = collect({ conversationId: 1, chatKind: "chief", partnerId: null });
	assert.equal(chief?.id, "user_profile");
	assert.equal(chief?.channel, "system");
	assert.equal(chief?.scope, "session");
	assert.ok(chief?.text.includes("我常用语音输入"));

	assert.equal(
		collect({ conversationId: 2, chatKind: "worker", partnerId: null }),
		undefined,
		"普通 worker 不读",
	);
	assert.equal(
		collect({ conversationId: 3, chatKind: "chief", partnerId: null, group: true }),
		undefined,
		"群会话不读",
	);
	assert.equal(
		collect({ conversationId: 4, chatKind: "chief", partnerId: "p-1" })?.text.includes("我常用"),
		true,
		"执事开关开 = 读",
	);
	assert.equal(
		collect({ conversationId: 5, chatKind: "chief", partnerId: "p-off" }),
		undefined,
		"执事开关关 = 不读",
	);
	assert.equal(
		collectInjections(
			[userProfileProviderWith({ ...base, content: () => "   " })],
			{ conversationId: 6, chatKind: "chief", partnerId: null },
		).system[0],
		undefined,
		"空内容不注",
	);
	assert.equal(
		collectInjections(
			[userProfileProviderWith({ ...base, enabled: () => false })],
			{ conversationId: 7, chatKind: "chief", partnerId: null },
		).system[0],
		undefined,
		"总闸关不注",
	);
});
