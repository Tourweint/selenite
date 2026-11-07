import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTools } from "./tools.ts";
import { CHIEF_PARTNER_ID, PartnersStore } from "./partners.ts";
import { createGroupChecked, resolvePartnersByName } from "./group-manage.ts";

/**
 * 群组管理 group_manage 工具单测（2026-11-07 群组入口统一）。
 *
 * 不碰真实 .data/：每个用例用临时目录建 PartnersStore，通过 ToolDeps.groupContext 注入。
 * 覆盖：总管可建群 / 值日缺省取第一位 / 成员按名字解析 / 重名与查无此人被拒 /
 * 执事会话拒建 / list 不带 uuid / 开关关掉时工具不存在。
 */

function tempRoot() {
	const root = mkdtempSync(join(tmpdir(), "lifediary-group-manage-"));
	const store = new PartnersStore(join(root, "partners.sqlite"), join(root, "homes"));
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function groupTool(store: PartnersStore, groups = true) {
	const tools = createTools({
		memory: null,
		scopeOf: () => ({ type: "global" }) as never,
		partners: true,
		groups,
		groupContext: () => ({ store }),
	});
	return tools.find((entry) => entry.name === "group_manage");
}

async function run(
	tool: NonNullable<ReturnType<typeof groupTool>>,
	args: Record<string, unknown>,
	conversationId = 100,
): Promise<string> {
	const result = await tool.execute(args as never, { conversationId } as never, {} as never);
	return (result.output ?? []).map((item) => (item.type === "text" ? item.text : "")).join("");
}

// ── 注册与开关 ───────────────────────────────────────────
test("group_manage：执事能力开着时注册；groups=false 时不存在（一行回滚）", () => {
	const env = tempRoot();
	try {
		assert.ok(groupTool(env.store), "群组开关开着应注册 group_manage");
		assert.equal(groupTool(env.store, false), undefined, "groups=false 时不该注册");
	} finally {
		env.cleanup();
	}
});

// ── create ───────────────────────────────────────────────
test("create：总管按名字建群，值日缺省取第一位成员", async () => {
	const env = tempRoot();
	try {
		env.store.create("阅读助手");
		env.store.create("记账助手");
		const tool = groupTool(env.store);
		assert.ok(tool);

		const out = await run(tool, { action: "create", name: "书房小事", members: ["阅读助手", "记账助手"] });
		assert.match(out, /群组 书房小事 已建好/);
		assert.match(out, /不 @ 时 阅读助手 回/);

		const groups = env.store.listGroups();
		assert.equal(groups.length, 1);
		assert.equal(groups[0]!.name, "书房小事");
		assert.equal(groups[0]!.members.length, 2, "两位成员都进群");
		assert.equal(
			groups[0]!.members.find((member) => member.partnerId === groups[0]!.responderPartnerId)?.name,
			"阅读助手",
			"缺省值日 = 第一位成员",
		);
	} finally {
		env.cleanup();
	}
});

test("create：显式 responder 生效，公告随群落库", async () => {
	const env = tempRoot();
	try {
		env.store.create("阅读助手");
		env.store.create("记账助手");
		const tool = groupTool(env.store);
		assert.ok(tool);

		const out = await run(tool, {
			action: "create",
			name: "值班群",
			members: ["阅读助手", "记账助手"],
			responder: "记账助手",
			notice: "每天晚饭后对一遍明天的事",
		});
		assert.match(out, /不 @ 时 记账助手 回/);
		const group = env.store.listGroups()[0]!;
		assert.equal(group.responderPartnerId, env.store.list().find((p) => p.name === "记账助手")!.id);
		assert.equal(group.notice, "每天晚饭后对一遍明天的事");
	} finally {
		env.cleanup();
	}
});

test("create：总管能进群当普通成员（不特判、不当路由者）", async () => {
	const env = tempRoot();
	try {
		env.store.ensureChief("总管 SOUL");
		env.store.create("阅读助手");
		const tool = groupTool(env.store);
		assert.ok(tool);

		const out = await run(tool, { action: "create", name: "带总管的群", members: ["总管", "阅读助手"] });
		assert.match(out, /已建好/);
		const group = env.store.listGroups()[0]!;
		assert.ok(
			group.members.some((member) => member.partnerId === CHIEF_PARTNER_ID),
			"总管在成员里",
		);
		// 值日缺省取第一位，这里第一位就是总管——他可以被设为值日，只是不参与路由决策
		assert.ok(group.responderPartnerId, "建群必须有值日");
	} finally {
		env.cleanup();
	}
});

test("create：查无此人 → 拒绝并列出可选执事（不建群）", async () => {
	const env = tempRoot();
	try {
		env.store.create("阅读助手");
		env.store.create("记账助手");
		const tool = groupTool(env.store);
		assert.ok(tool);

		const out = await run(tool, { action: "create", name: "空群", members: ["阅读助手", "查无此人"] });
		assert.match(out, /找不到执事「查无此人」/);
		assert.match(out, /阅读助手/);
		assert.equal(env.store.listGroups().length, 0, "拒了就不能留半个群");
	} finally {
		env.cleanup();
	}
});

test("create：重名成员被拒（@ 会分不清人）", async () => {
	const env = tempRoot();
	try {
		// store.create 允许重名（改名是人的决定），群这一层必须拒绝。
		// 注意人数下限先于重名判定，所以要凑够两位成员再撞重名。
		env.store.create("阅读助手");
		env.store.create("阅读助手");
		env.store.create("记账助手");
		const tool = groupTool(env.store);
		assert.ok(tool);

		const out = await run(tool, { action: "create", name: "重名群", members: ["阅读助手", "记账助手"] });
		assert.match(out, /不止一位执事叫「阅读助手」/);
		assert.equal(env.store.listGroups().length, 0);
	} finally {
		env.cleanup();
	}
});

test("create：少于 2 人 / 多于 6 人被拒（人数口径来自 shared）", async () => {
	const env = tempRoot();
	for (const name of ["甲", "乙", "丙", "丁", "戊", "己", "庚"]) env.store.create(name);
	try {
		const tool = groupTool(env.store);
		assert.ok(tool);
		assert.match(await run(tool, { action: "create", name: "人不够", members: ["甲"] }), /2–6/);
		assert.match(
			await run(tool, {
				action: "create",
				name: "人太多",
				members: ["甲", "乙", "丙", "丁", "戊", "己", "庚"],
			}),
			/2–6/,
		);
		assert.equal(env.store.listGroups().length, 0);
	} finally {
		env.cleanup();
	}
});

test("create：执事自己的会话不能建群", async () => {
	const env = tempRoot();
	try {
		const other = env.store.create("小澈");
		env.store.linkSession({
			partnerId: other.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 777,
		});
		env.store.create("阅读助手");
		const tool = groupTool(env.store);
		assert.ok(tool);
		const out = await run(tool, { action: "create", name: "不该建的群", members: ["阅读助手", "小澈"] }, 777);
		assert.equal(out, "只有总管可以建群");
		assert.equal(env.store.listGroups().length, 0);
	} finally {
		env.cleanup();
	}
});

// ── list ─────────────────────────────────────────────────
test("list：一行一群，写清成员与回应口径，不回显 uuid", async () => {
	const env = tempRoot();
	try {
		env.store.create("阅读助手");
		env.store.create("记账助手");
		const tool = groupTool(env.store);
		assert.ok(tool);
		await run(tool, { action: "create", name: "书房小事", members: ["阅读助手", "记账助手"] });

		const out = await run(tool, { action: "list" });
		assert.match(out, /书房小事 · 2 人（阅读助手、记账助手）· 值日 阅读助手/);
		for (const partner of env.store.list()) {
			assert.equal(out.includes(partner.id), false, "不回显执事 uuid");
		}
		assert.equal(out.includes(env.store.listGroups()[0]!.id), false, "不回显群 uuid");
	} finally {
		env.cleanup();
	}
});

test("list：没有群时给明确空态（不是空字符串）", async () => {
	const env = tempRoot();
	try {
		const tool = groupTool(env.store);
		assert.ok(tool);
		const out = await run(tool, { action: "list" });
		assert.match(out, /暂无群组/);
	} finally {
		env.cleanup();
	}
});

// ── 核心函数（端点与工具共用同一份）─────────────────────
test("createGroupChecked：校验文案与端点逐字一致（群名/公告/人数/值日）", () => {
	const env = tempRoot();
	try {
		env.store.create("阅读助手");
		env.store.create("记账助手");
		const ids = env.store.list().map((partner) => partner.id);
		assert.equal(createGroupChecked({ name: "", memberIds: ids }, env.store).ok, false);
		const noName = createGroupChecked({ name: "", memberIds: ids }, env.store);
		assert.equal(noName.ok === false && noName.error, "name 必填且不超过 40 字");

		const longNotice = createGroupChecked(
			{ name: "群", memberIds: ids, notice: "x".repeat(501) },
			env.store,
		);
		assert.equal(longNotice.ok === false && longNotice.error, "公告不超过 500 字");

		const noDuty = createGroupChecked({ name: "群", memberIds: ids }, env.store);
		assert.equal(noDuty.ok === false && noDuty.error, "值日执事必选（不 @ 就发给谁）");

		// 值日必须在成员里：拿两位成员的 id 建群，却把值日指给群里没有的执事
		const outsider = env.store.create("群外").id;
		const dutyOutside = createGroupChecked(
			{ name: "群", memberIds: ids, responderPartnerId: outsider },
			env.store,
		);
		assert.equal(dutyOutside.ok === false && dutyOutside.error, "值日执事必须是群成员");
	} finally {
		env.cleanup();
	}
});

test("resolvePartnersByName：去重、拒绝未知与重名", () => {
	const env = tempRoot();
	try {
		env.store.create("阅读助手");
		env.store.create("记账助手");
		const ok = resolvePartnersByName(["阅读助手", "记账助手", "阅读助手"], env.store);
		assert.equal(ok.ok, true);
		assert.equal(ok.ok && ok.value.length, 2, "同名重复只算一位");

		const missing = resolvePartnersByName(["阅读助手", "无名"], env.store);
		assert.equal(missing.ok, false);

		env.store.create("记账助手");
		const ambiguous = resolvePartnersByName(["阅读助手", "记账助手"], env.store);
		assert.equal(ambiguous.ok, false);
		assert.match(ambiguous.ok === false ? ambiguous.error : "", /不止一位/);
	} finally {
		env.cleanup();
	}
});
