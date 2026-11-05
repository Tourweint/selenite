import assert from "node:assert/strict";
import { test } from "node:test";
import { GroupRouteError, parseMentionedIds, resolveGroupSpeakers } from "./group-routing.ts";

/** 群组发言路由纯函数（2026-11-06 群组方案 §2.3）。全部用例不碰磁盘不碰网络。 */

const MEMBERS = [
	{ partnerId: "p-shu", name: "阅读助手", position: 0 },
	{ partnerId: "p-mo", name: "记账助手", position: 1 },
	{ partnerId: "p-shuzhai", name: "阅读助手斋", position: 2 },
];

const MEMBER_SPEC = { responderKind: "member" as const, responderPartnerId: "p-mo" };

test("@解析：最长标签优先（阅读助手斋不被拆成阅读助手）", () => {
	assert.deepEqual(parseMentionedIds("@阅读助手斋 在吗", MEMBERS), ["p-shuzhai"]);
	assert.deepEqual(parseMentionedIds("@阅读助手 在吗", MEMBERS), ["p-shu"]);
});

test("@解析：词边界——邮箱尾缀不算点名", () => {
	assert.deepEqual(parseMentionedIds("写信到a@阅读助手 去了", MEMBERS), []);
	// 正常 @ 前是标点/空格/行首都行
	assert.deepEqual(parseMentionedIds("（@记账助手）看一下", MEMBERS), ["p-mo"]);
	assert.deepEqual(parseMentionedIds("先@记账助手，再@阅读助手", MEMBERS), ["p-mo", "p-shu"]);
});

test("@解析：按正文出现顺序，同一人去重", () => {
	assert.deepEqual(parseMentionedIds("@阅读助手 和 @记账助手 和 @阅读助手", MEMBERS), [
		"p-shu",
		"p-mo",
		"p-shu",
	]);
	assert.deepEqual(resolveGroupSpeakers("@阅读助手 和 @记账助手 和 @阅读助手", MEMBER_SPEC, MEMBERS), [
		"p-shu",
		"p-mo",
	]);
});

test("@解析：重名歧义直接拒绝不猜", () => {
	const dup = [
		{ partnerId: "p-a", name: "小双", position: 0 },
		{ partnerId: "p-b", name: "小双", position: 1 },
	];
	assert.throws(() => parseMentionedIds("@小双 在吗", dup), GroupRouteError);
});

test("@所有人：全员按 position，和写在正文哪里无关", () => {
	assert.deepEqual(resolveGroupSpeakers("开会了 @所有人", MEMBER_SPEC, MEMBERS), [
		"p-shu",
		"p-mo",
		"p-shuzhai",
	]);
});

test("无 @：member=值日执事（用户拍板的默认）", () => {
	assert.deepEqual(resolveGroupSpeakers("大家随便聊聊", MEMBER_SPEC, MEMBERS), ["p-mo"]);
	// 值日不在群里（配置错）→ 没人回，端点层落 system 行
	assert.deepEqual(
		resolveGroupSpeakers("大家随便聊聊", { responderKind: "member", responderPartnerId: "p-x" }, MEMBERS),
		[],
	);
});

test("无 @：everyone=全员，mentions=无人回", () => {
	assert.deepEqual(resolveGroupSpeakers("随便说说", { responderKind: "everyone" }, MEMBERS), [
		"p-shu",
		"p-mo",
		"p-shuzhai",
	]);
	assert.deepEqual(resolveGroupSpeakers("随便说说", { responderKind: "mentions" }, MEMBERS), []);
});

test("点名优先于值日：@了谁就谁回，不带值日", () => {
	assert.deepEqual(resolveGroupSpeakers("@阅读助手 看看这个", MEMBER_SPEC, MEMBERS), ["p-shu"]);
});

test("@所有人优先于点名：正文中两者都有时全员回", () => {
	assert.deepEqual(resolveGroupSpeakers("@阅读助手 @所有人 到齐了", MEMBER_SPEC, MEMBERS), [
		"p-shu",
		"p-mo",
		"p-shuzhai",
	]);
});
