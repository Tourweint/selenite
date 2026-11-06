import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTools } from "./tools.ts";
import {
	CHIEF_PARTNER_ID,
	delegationSoulSeed,
	PartnersStore,
} from "./partners.ts";

/**
 * 执事管理 partner_manage 工具单测（批次D D3）。
 *
 * 不碰真实 .data/：每个用例用临时目录建 PartnersStore + chancellor 工作根，
 * 通过 ToolDeps.ministerContext 注入，端点/工具共用同一份核心实现。
 * 覆盖任务书 §3：create 成功/非法 domain/重复 domain/非总管会话拒、
 * stop 正常/拒 chief、list 投影。自主轮 verdict 断言在 autonomy-risk.test.ts。
 */

function tempRoot() {
	const root = mkdtempSync(join(tmpdir(), "lifediary-d3-"));
	const store = new PartnersStore(join(root, "partners.sqlite"), join(root, "homes"));
	const workRoot = join(root, "runs");
	return {
		root,
		store,
		workRoot,
		// managersRoot(workRoot) = dirname(resolve(workRoot))/managers = root/managers
		managers: join(root, "managers"),
		cleanup: () => {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** 用临时 store / 工作根装配工具集，取回 partner_manage。 */
function manageTool(store: PartnersStore, workRoot: string) {
	const tools = createTools({
		memory: null,
		scopeOf: () => ({ type: "global" }) as never,
		partners: true,
		ministerContext: () => ({ store, workRoot }),
	});
	const tool = tools.find((entry) => entry.name === "partner_manage");
	assert.ok(tool, "partner_manage 工具应该已注册");
	return tool;
}

/** 跑一次工具，拼回纯文本输出。conversationId 默认主人会话（解析为 chief，放行）。 */
async function run(
	tool: NonNullable<ReturnType<typeof manageTool>>,
	args: Record<string, unknown>,
	conversationId = 100,
): Promise<string> {
	const result = await tool.execute(
		args as never,
		{ conversationId } as never,
		{} as never,
	);
	return (result.output ?? [])
		.map((item) => (item.type === "text" ? item.text : ""))
		.join("");
}

// ── create ───────────────────────────────────────────────
test("create：建出执事（partners 表 + 宰相目录 + SOUL 播种），文案模型友好", async () => {
	const env = tempRoot();
	try {
		const tool = manageTool(env.store, env.workRoot);
		const out = await run(tool, { action: "create", name: "阿岚", domain: "finance" });
		assert.match(out, /执事 阿岚 已就位/);
		assert.match(out, /domain=finance/);
		assert.match(out, /之后派活用 domain/);

		const id = env.store.partnerIdByDomain("finance");
		assert.ok(id, "partners 表能按 domain 反查到执事");
		const row = env.store.get(id);
		assert.equal(row?.domain, "finance");
		assert.equal(row?.status, "active");
		assert.equal(env.store.readSoulFromHome(id), delegationSoulSeed("阿岚", "finance"));
		assert.ok(env.store.findSessionLink(id, "delegation", "finance"), "delegation 链接已登记");

		const meta = JSON.parse(readFileSync(join(env.managers, "finance", "meta.json"), "utf8"));
		assert.equal(meta.partner_id, id, "宰相目录透记了 partner_id");
	} finally {
		env.cleanup();
	}
});

test("create：soul 可选，缺省用 delegationSoulSeed、给了就用给的", async () => {
	const env = tempRoot();
	try {
		const tool = manageTool(env.store, env.workRoot);
		await run(tool, { action: "create", name: "小账", domain: "ledger", soul: "你是账房先生。" });
		const id = env.store.partnerIdByDomain("ledger");
		assert.ok(id);
		assert.equal(env.store.readSoulFromHome(id), "你是账房先生。");
	} finally {
		env.cleanup();
	}
});

test("create：非法 domain（中文）被拒，不落档案、不建目录", async () => {
	const env = tempRoot();
	try {
		const tool = manageTool(env.store, env.workRoot);
		const out = await run(tool, { action: "create", name: "坏领域", domain: "前端" });
		assert.match(out, /domain 必须是小写 ASCII/);
		assert.equal(env.store.partnerIdByDomain("前端"), null);
		assert.equal(env.store.list().length, 0, "不能建出半个执事");
		assert.equal(existsSync(join(env.managers, "前端")), false);
	} finally {
		env.cleanup();
	}
});

test("create：重复 domain 被拒（一个 domain 只对应一个执事）", async () => {
	const env = tempRoot();
	try {
		const tool = manageTool(env.store, env.workRoot);
		await run(tool, { action: "create", name: "阿岚", domain: "finance" });
		const out = await run(tool, { action: "create", name: "抢领域", domain: "finance" });
		assert.match(out, /已被其他执事占用/);
		assert.equal(env.store.list().filter((partner) => partner.domain === "finance").length, 1);
		assert.equal(existsSync(join(env.managers, "finance")), true, "原执事目录没被动");
	} finally {
		env.cleanup();
	}
});

test("create：非总管的执事会话直接拒（只有总管可以管理执事）", async () => {
	const env = tempRoot();
	try {
		const tool = manageTool(env.store, env.workRoot);
		// 模拟一条挂到普通执事的专线会话：effectivePartnerIdOfSession 落到真实 uuid。
		const other = env.store.create("小澈");
		env.store.linkSession({
			partnerId: other.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 999,
		});
		const out = await run(tool, { action: "create", name: "阿岚", domain: "finance" }, 999);
		assert.equal(out, "只有总管可以管理执事");
		assert.equal(env.store.partnerIdByDomain("finance"), null, "拒了就不能建执事");
	} finally {
		env.cleanup();
	}
});

// ── stop ─────────────────────────────────────────────────
test("stop：归档 chancellor 目录（改名 .archived-）并删档案", async () => {
	const env = tempRoot();
	try {
		const tool = manageTool(env.store, env.workRoot);
		await run(tool, { action: "create", name: "阿岚", domain: "finance" });
		const id = env.store.partnerIdByDomain("finance");
		assert.ok(id);
		const out = await run(tool, { action: "stop", partnerId: id });
		assert.match(out, /已停用并归档/);
		assert.equal(env.store.get(id), null, "档案已删");
		assert.equal(existsSync(join(env.managers, "finance")), false, "原领域目录已不在");
		const archived = readdirSync(env.managers).filter((name) =>
			name.startsWith(".archived-finance-"),
		);
		assert.equal(archived.length, 1, "改名成 .archived- 前缀，不是物理删");
	} finally {
		env.cleanup();
	}
});

test("stop：不许停总管自己，直接拒并说明，总管仍在", async () => {
	const env = tempRoot();
	try {
		const tool = manageTool(env.store, env.workRoot);
		env.store.ensureChief("总管 SOUL 播种正文");
		const out = await run(tool, { action: "stop", partnerId: CHIEF_PARTNER_ID });
		assert.match(out, /不能停总管自己/);
		assert.ok(env.store.get(CHIEF_PARTNER_ID), "总管没被删");
	} finally {
		env.cleanup();
	}
});

// ── list ─────────────────────────────────────────────────
test("list：只投影名字/domain/状态，一行一个，不带内部会话 id / 执事 uuid", async () => {
	const env = tempRoot();
	try {
		const tool = manageTool(env.store, env.workRoot);
		env.store.ensureChief("总管 SOUL 播种正文"); // chief 无 domain，不该进执事清单
		env.store.create("小澈"); // 普通执事无 domain，不该进执事清单
		await run(tool, { action: "create", name: "阿岚", domain: "finance" });
		await run(tool, { action: "create", name: "小桌", domain: "desktop-shell" });
		const finance = env.store.partnerIdByDomain("finance");
		const desktop = env.store.partnerIdByDomain("desktop-shell");
		assert.ok(finance);
		assert.ok(desktop);

		const out = await run(tool, { action: "list" });
		const lines = out.split("\n").filter(Boolean);
		assert.equal(lines.length, 2, "只列两个执事");
		assert.ok(lines.some((line) => line.includes("阿岚") && line.includes("finance") && line.includes("active")));
		assert.ok(lines.some((line) => line.includes("小桌") && line.includes("desktop-shell") && line.includes("active")));
		assert.equal(out.includes("小澈"), false, "普通执事不进执事清单");
		assert.equal(out.includes("总管"), false, "总管不进执事清单");
		assert.equal(out.includes(finance), false, "不回显执事 uuid");
		assert.equal(out.includes(desktop), false, "不回显执事 uuid");
		for (const line of lines) {
			assert.equal(line.split(" · ").length, 4, `每行应是 名字 · domain · 状态 · 派发权：${line}`);
		}

		// partnerId 可选过滤
		const filtered = await run(tool, { action: "list", partnerId: finance });
		assert.match(filtered, /阿岚/);
		assert.equal(filtered.includes("小桌"), false);
	} finally {
		env.cleanup();
	}
});

test("list：没有执事时给模型友好提示", async () => {
	const env = tempRoot();
	try {
		const tool = manageTool(env.store, env.workRoot);
		const out = await run(tool, { action: "list" });
		assert.match(out, /暂无执事/);
	} finally {
		env.cleanup();
	}
});
