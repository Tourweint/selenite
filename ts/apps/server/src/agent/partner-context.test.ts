import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../../../../../chancellor/src/store.ts";
import type { Ticket } from "../../../../../../chancellor/src/types.ts";
import {
	buildPartnerStatusSection,
	buildPartnerTurnContext,
	renderContractSection,
	splitContractSections,
} from "./partner-context.ts";
import { ATTENTION_REPLY_GUIDANCE } from "../delegation.ts";
import {
	PARTNER_CONTRACT_SECTIONS,
	PartnersStore,
	partnerContractEnabled,
	partnerContractTemplate,
} from "../partners.ts";

/**
 * 员工人格化刀一（E1 契约 / E5 状态感 / B2 受阻口径）的最小充分单测。
 *
 * 全程临时目录：不碰真实 `.data/`（AGENTS 的测试纪律）；审批用桩（ApprovalStore
 * 是进程单例，单测里不该去读真实的 approvals.json）。
 */

function tempRoot(): { root: string; db: string; homes: string; workRoot: string } {
	const root = mkdtempSync(join(tmpdir(), "lifediary-partner-context-"));
	return {
		root,
		db: join(root, "partners.sqlite"),
		homes: join(root, "homes"),
		workRoot: join(root, "runs"),
	};
}

function ticketFixture(
	workRoot: string,
	id: string,
	status: string,
	extra: Record<string, unknown> = {},
): Ticket {
	const now = new Date().toISOString();
	return {
		id,
		prompt: `夹具 ${id}`,
		status,
		created_at: now,
		updated_at: now,
		options: { dry: true, maxTasks: 8, workRoot },
		...extra,
	} as Ticket;
}

test("契约：新建执事播种四节空模板；改契约 = 双快照 bump，SOUL / 能力延续", () => {
	const { root, db, homes } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("小澈");
		assert.equal(partner.currentVersion, 1);
		assert.ok(existsSync(join(store.homeOf(partner.id), "CONTRACT.md")), "新建执事要有 CONTRACT.md");
		assert.equal(store.readContractFromHome(partner.id), partnerContractTemplate());
		// 空模板 = 只有四个标题，渲染出来是空（没有一节有正文）
		assert.equal(renderContractSection(store.readContractFromHome(partner.id)), undefined);

		const v1Soul = store.getVersion(partner.id, 1)?.soulSource ?? "";
		const contract1 = [
			"## 职责范围",
			"负责前端与桌面壳。",
			"",
			"## 决策分级",
			"改样式自己定；改接口先申请。",
			"",
			"## 验收标准",
			"跑通 typecheck + 探针。",
			"",
			"## 汇报对象",
			"向总管汇报，每周一次。",
		].join("\n");
		const v2 = store.bumpContract(partner.id, contract1);
		assert.equal(v2, 2);
		const current2 = store.currentVersion(partner.id);
		assert.equal(current2?.contractSource, contract1);
		assert.equal(current2?.soulSource, v1Soul, "改契约不动 SOUL 正文");

		// 冻结：v1 的契约快照仍是空模板（演化链可追溯）
		assert.equal(store.getVersion(partner.id, 1)?.contractSource, partnerContractTemplate());

		// 再改 SOUL：新版本必须把当前契约一起快照过去（一个版本 = 一对）
		const v3 = store.bumpSoul(partner.id, "你是小澈，改过的人格。");
		assert.equal(v3, 3);
		assert.equal(store.currentVersion(partner.id)?.contractSource, contract1);

		// 切模型链同样不冲掉契约
		const v4 = store.setModelChain(partner.id, [
			{ providerId: "faux", modelId: "faux", keyEnv: "PROBE_KEY" },
		]);
		assert.equal(v4, 4);
		assert.equal(store.currentVersion(partner.id)?.contractSource, contract1);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("契约：老库（partner_versions 没有 contract_source 列）打开不炸，旧行读出 null", () => {
	const { root, db, homes } = tempRoot();
	try {
		// 手工造一份改动前的库结构（没有 contract_source）
		const legacy = new DatabaseSync(db);
		legacy.exec(`
			CREATE TABLE partners (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
				current_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
			CREATE TABLE partner_versions (
				partner_id TEXT NOT NULL, version INTEGER NOT NULL, soul_source TEXT NOT NULL,
				capabilities TEXT, created_at TEXT NOT NULL, PRIMARY KEY (partner_id, version)
			);
		`);
		const now = new Date().toISOString();
		legacy.prepare(
			"INSERT INTO partners (id, name, status, current_version, created_at, updated_at) VALUES (?, ?, 'active', 1, ?, ?)",
		).run("legacy-id", "老执事", now, now);
		legacy.prepare(
			"INSERT INTO partner_versions (partner_id, version, soul_source, capabilities, created_at) VALUES (?, 1, ?, NULL, ?)",
		).run("legacy-id", "老身份", now);
		legacy.close();

		const store = new PartnersStore(db, homes);
		try {
			const version = store.currentVersion("legacy-id");
			assert.ok(version, "旧库打开后仍能读版本");
			assert.equal(version?.soulSource, "老身份");
			assert.equal(version?.contractSource, null, "缺列 = null（无契约快照），不补数据");
			// 迁移补列后新版本能正常带契约
			const next = store.bumpContract("legacy-id", "## 职责范围\n新契约");
			assert.equal(next, 2);
			assert.match(store.currentVersion("legacy-id")?.contractSource ?? "", /新契约/);
		} finally {
			store.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("开关旁路：PARTNER_CONTRACT=false → 不播种文件、不渲染契约；在办段不受影响", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const previous = process.env.PARTNER_CONTRACT;
	process.env.PARTNER_CONTRACT = "false";
	const store = new PartnersStore(db, homes);
	try {
		assert.equal(partnerContractEnabled(), false);
		const partner = store.create("小澈");
		assert.equal(existsSync(join(store.homeOf(partner.id), "CONTRACT.md")), false, "关着就不建文件");
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 101,
		});
		// 即使库里有契约快照，关着也不渲染
		assert.equal(renderContractSection("## 职责范围\n写点什么"), undefined);

		const saved = new Store(workRoot);
		saved.saveTicket(ticketFixture(workRoot, "T-off", "dispatching", { originConversationId: "101" }));
		saved.close();

		const context = buildPartnerTurnContext(partner.id, 101, {
			store,
			workRoot,
			approvals: { pendingOf: () => [] },
		});
		assert.equal(context.contract, null);
		assert.match(context.status ?? "", /T-off/, "在办段与契约开关无关");
		assert.ok(!(context.text ?? "").includes("【岗位契约】"));
	} finally {
		store.close();
		if (previous === undefined) delete process.env.PARTNER_CONTRACT;
		else process.env.PARTNER_CONTRACT = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("装配：SOUL / 岗位契约 / 当前在办三段各自可见，顺序 = 契约 → 在办", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("阿岚", { soulSeed: "你是阿岚，管桌面壳。" });
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 202,
		});
		store.bumpContract(
			partner.id,
			[
				"## 职责范围",
				"桌面壳与安装包。",
				"",
				"## 决策分级",
				"文案自己定；动安装流程先申请。",
				"",
				"## 验收标准",
				"能装能卸，探针全绿。",
				"",
				"## 汇报对象",
				"向总管汇报。",
			].join("\n"),
		);

		const saved = new Store(workRoot);
		saved.saveTicket(
			ticketFixture(workRoot, "T-doing", "dispatching", {
				originConversationId: "202",
				lastAction: "在改安装脚本",
			}),
		);
		saved.saveTicket(
			ticketFixture(workRoot, "T-done", "done", {
				originConversationId: "202",
				lastAction: "三个探针全绿",
				updated_at: new Date(Date.now() + 1000).toISOString(),
			}),
		);
		// 别人发起的单不该出现在他的在办里
		saved.saveTicket(
			ticketFixture(workRoot, "T-other", "dispatching", { originConversationId: "999" }),
		);
		saved.close();

		const context = buildPartnerTurnContext(partner.id, 202, {
			store,
			workRoot,
			approvals: { pendingOf: () => [{ tool: "bash", args: "npm run build" }] },
		});

		// ① SOUL（身份正文）
		assert.match(context.soul, /你是阿岚/, "SOUL 段来自当前版本快照");
		// ② 岗位契约：四节全文
		assert.match(context.contract ?? "", /【岗位契约】/);
		assert.match(context.contract ?? "", /## 职责范围\n桌面壳与安装包。/);
		assert.match(context.contract ?? "", /## 决策分级/);
		assert.match(context.contract ?? "", /## 验收标准/);
		assert.match(context.contract ?? "", /## 汇报对象/);
		// ③ 当前在办：在办单 / 待审批 / 最近一单
		assert.match(context.status ?? "", /【当前在办】/);
		assert.match(context.status ?? "", /T-doing（进行中）：在改安装脚本/);
		assert.match(context.status ?? "", /bash：npm run build/);
		assert.match(context.status ?? "", /最近一单：T-done（已完成）：三个探针全绿/);
		assert.ok(!(context.status ?? "").includes("T-other"), "别人发起的单不进他的在办");

		// 合并文本：契约在前、在办在后
		const text = context.text ?? "";
		assert.ok(text.indexOf("【岗位契约】") < text.indexOf("【当前在办】"));
		assert.ok(text.includes("【岗位契约】") && text.includes("【当前在办】"));
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("空态省略：空契约 + 无在办 / 无待批 / 无最近单 → 三段都不注入", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("空空");
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 303,
		});
		const context = buildPartnerTurnContext(partner.id, 303, {
			store,
			workRoot,
			approvals: { pendingOf: () => [] },
		});
		assert.match(context.soul, /空空/, "SOUL 永远在");
		assert.equal(context.contract, null);
		assert.equal(context.status, null);
		assert.equal(context.text, undefined, "两段都空 → 不注入任何东西");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("在办段：明细 ≤3 条 + 超出只报条数；attention 口径文案在段内", () => {
	const { root, db, homes, workRoot } = tempRoot();
	const store = new PartnersStore(db, homes);
	try {
		const partner = store.create("忙人");
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 404,
		});
		const saved = new Store(workRoot);
		for (let index = 0; index < 5; index += 1) {
			saved.saveTicket(
				ticketFixture(workRoot, `T-${index}`, "dispatching", {
					originConversationId: "404",
					updated_at: new Date(Date.now() + index * 1000).toISOString(),
				}),
			);
		}
		saved.close();

		const section = buildPartnerStatusSection(partner.id, 404, {
			store,
			workRoot,
			approvals: {
				pendingOf: () => [
					{ tool: "bash", args: "npm test" },
					{ tool: "write", args: "a.ts" },
					{ tool: "edit", args: "b.ts" },
					{ tool: "bash", args: "rm -rf x" },
				],
			},
		});
		assert.ok(section);
		assert.equal((section.match(/^- T-/gm) ?? []).length, 3, "在办明细最多 3 条");
		assert.match(section ?? "", /另有 2 单在办/);
		assert.match(section ?? "", /另有 1 条待批/);
		// 只说"有几条"不说全量参数正文（日志 / 提示词纪律）
		assert.equal((section.match(/^- (bash|write|edit)：/gm) ?? []).length, 3);
		assert.match(section ?? "", /先跳过，继续其余部分，这项回头再补/);
		assert.equal(ATTENTION_REPLY_GUIDANCE.includes("答得了就直接答"), true);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("契约解析：只认四个固定标题，空节连标题一起省略", () => {
	const source = [
		"# 我的契约（这行不是节标题，忽略）",
		"",
		"## 职责范围",
		"只管前端。",
		"",
		"### 子标题保留",
		"细节。",
		"",
		"## 决策分级",
		"",
		"## 验收标准",
		"探针全绿。",
		"",
		"## 汇报对象",
		"## 无关章节",
		"不该出现。",
	].join("\n");
	const sections = splitContractSections(source);
	assert.deepEqual([...sections.keys()].sort(), [...PARTNER_CONTRACT_SECTIONS].sort());
	assert.equal(sections.get("职责范围"), "只管前端。\n\n### 子标题保留\n细节。");
	assert.equal(sections.get("决策分级"), "");
	const rendered = renderContractSection(source) ?? "";
	assert.match(rendered, /## 职责范围/);
	assert.ok(!rendered.includes("## 决策分级"), "空节省略标题");
	assert.ok(!rendered.includes("不该出现"), "四节之外的内容不注入");
});
