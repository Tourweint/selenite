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

test("@解析：重名歧义直接拒绝不猜（400 带候选清单）", () => {
	const dup = [
		{ partnerId: "p-a", name: "小双", position: 0, domain: "math" },
		{ partnerId: "p-b", name: "小双", position: 1, domain: "words" },
	];
	assert.throws(() => parseMentionedIds("@小双 在吗", dup), GroupRouteError);
	try {
		parseMentionedIds("@小双 在吗", dup);
	} catch (error) {
		assert.ok(error instanceof GroupRouteError);
		assert.deepEqual(error.candidates, [
			{ name: "小双", domain: "math" },
			{ name: "小双", domain: "words" },
		]);
	}
});

test("@解析：唯一长标签 @名字·domain 能点名重名中的一个", () => {
	const dup = [
		{ partnerId: "p-a", name: "小双", position: 0, domain: "math" },
		{ partnerId: "p-b", name: "小双", position: 1, domain: "words" },
	];
	assert.deepEqual(parseMentionedIds("@小双·words 看一下", dup), ["p-b"]);
	assert.deepEqual(parseMentionedIds("@小双·math 和 @小双·words", dup), ["p-a", "p-b"]);
	// 无重名时短名照旧；长标签同样成立
	assert.deepEqual(parseMentionedIds("@小双·math 在吗", [dup[0]!]), ["p-a"]);
	assert.deepEqual(parseMentionedIds("@小双 在吗", [dup[0]!]), ["p-a"]);
});

test("@解析：长标签打错域 → 不命中（按普通文本，不回退短名）", () => {
	const dup = [
		{ partnerId: "p-a", name: "小双", position: 0, domain: "math" },
		{ partnerId: "p-b", name: "小双", position: 1, domain: "words" },
	];
	assert.deepEqual(parseMentionedIds("@小双·bogus 在吗", dup), []);
	// 打错域也不该被当成短名 → 不抛歧义错，按无 @ 走值日
	assert.deepEqual(
		resolveGroupSpeakers("@小双·bogus 在吗", { responderKind: "member", responderPartnerId: "p-a" }, dup),
		["p-a"],
	);
	// 成员没有 domain 时长标签同样不命中
	assert.deepEqual(parseMentionedIds("@阅读助手·math 在吗", MEMBERS), []);
});

test("@解析：重名但正文没用这个名字 → 不报错（走值日）", () => {
	const dup = [
		{ partnerId: "p-a", name: "小双", position: 0, domain: "math" },
		{ partnerId: "p-b", name: "小双", position: 1, domain: "words" },
	];
	assert.deepEqual(parseMentionedIds("大家好", dup), []);
	assert.deepEqual(
		resolveGroupSpeakers("大家好", { responderKind: "member", responderPartnerId: "p-a" }, dup),
		["p-a"],
	);
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
