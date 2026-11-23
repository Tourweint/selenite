/**
 * 注入框架（2026-11-10 批 26b 批 A + 批 27 B/C/D）单测。
 *
 * 钉住：条目形状 / 排序稳定 / 同 id 去重（后者覆盖）/ 按 channel 分流 / 审计只回元数据；
 * 外加**硬标准**——每一处接管后内容与位置与改造前逐字节一致。
 *
 * 测试自己造临时目录（PARTNERS / PROJECTS / 技能 / 技能启停位），
 * 不碰真实 `.data/`（AGENTS 的测试纪律）；env 必须在 import 之前设好——
 * assist.ts 的 memoryEngine / skillStore 是模块级单例。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { InjectionContext, InjectionProvider } from "./injection.ts";

const root = mkdtempSync(join(tmpdir(), "lifediary-injection-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "homes");
process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
process.env.MEMORY_ENABLED = "false";
process.env.AGENT_SKILLS_DIR = join(root, "skills");
process.env.AGENT_SKILLS_STATE_PATH = join(root, "skills-state.json");
// 2026-11-16 worker 人设每轮现读：指到临时目录，不碰真实 .data/worker-persona.md
process.env.WORKER_PERSONA_PATH = join(root, "worker-persona.md");
delete process.env.AGENT_INJECTION_GUARD;

const SKILL_NAME = "probe-skill";
const SKILL_SUMMARY = "探针技能摘要";
const SKILL_MANUAL = "第一行步骤\n第二行步骤";
mkdirSync(join(root, "skills"), { recursive: true });
writeFileSync(join(root, "skills", `${SKILL_NAME}.md`), `${SKILL_SUMMARY}\n${SKILL_MANUAL}\n`, "utf8");
// 逃生门测试用：默认关着的技能，SKILL_STATE=false 时应重新进索引
writeFileSync(join(root, "skills", "hidden-skill.md"), "隐藏技能摘要\n隐藏技能正文\n", "utf8");
// 2026-11-21 普通助手独立技能可见性：只给保留键 worker 开的技能
writeFileSync(join(root, "skills", "worker-skill.md"), "普通助手独开摘要\n普通助手独开正文\n", "utf8");
writeFileSync(
	join(root, "skills-state.json"),
	`${JSON.stringify({
		enabled: { [SKILL_NAME]: true },
		partners: { worker: { enabled: { "worker-skill": true } } },
	})}\n`,
	"utf8",
);

const { INJECTION_GUARD } = await import("./injection-guard.ts");
const {
	INJECTION_ORDER,
	auditInjections,
	collectInjections,
	guardProvider,
	injectionAuditEnabled,
} = await import("./injection.ts");
const { INJECTION_REGISTRY } = await import("./injection-registry.ts");
const {
	clarifyContractProvider,
	currentProjectLiveProvider,
	currentProjectProvider,
	personaProvider,
	recoverNoteProvider,
	skillSlashProvider,
	skillsProvider,
	toolIndexProvider,
	turnLimitApproachingProvider,
	turnLimitProvider,
	verificationIronLawProvider,
} = await import("./lifecycle-injections.ts");
const { LIFECYCLE_SECTIONS } = await import("./lifecycle.ts");
const { PERSONA, skillStore, taskMemoryProvider } = await import("./assist.ts");
const { readWorkerPersona, WORKER_PERSONA_CHAT_TOOLS } = await import("../worker-persona.ts");
const { buildPartnerTurnContext } = await import("./partner-context.ts");
const { PartnersStore, partnersStore } = await import("../partners.ts");
const { MAX_TURNS, TURN_LIMIT_INSTRUCTION, VERIFICATION_IRON_LAW } = await import("./turn-gate.ts");
const { CLARIFY_CONTRACT } = await import("../delegation.ts");
const { markRecoverResume } = await import("./recover-note.ts");

after(() => {
	// 单例 PartnersStore 还握着句柄：Windows 上删不掉是正常的，忽略即可
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		/* 临时目录留给系统清理 */
	}
});

const BASE: InjectionContext = { conversationId: 1 };

function collect(provider: InjectionProvider, context: Partial<InjectionContext> = {}) {
	return collectInjections([provider], { ...BASE, ...context });
}
/** system 通道首条正文（section 类注入）。 */
function sysText(provider: InjectionProvider, context: Partial<InjectionContext> = {}) {
	return collect(provider, context).system[0]?.text;
}
/** message 通道首条正文（extra.push 类注入）。 */
function msgText(provider: InjectionProvider, context: Partial<InjectionContext> = {}) {
	return collect(provider, context).message[0]?.text;
}

// ── 框架：排序 / 去重 / 分流 ────────────────────────────

test("排序：order 升序 / 同 order 按 id 字典序；打乱 providers 顺序输出一致", () => {
	const sys = (id: string, text: string, order: number): InjectionProvider => () => ({
		id,
		text,
		order,
		scope: "session",
		channel: "system",
	});
	const pA = sys("b", "B", 2);
	const pB = sys("a", "A", 1);
	const pC = sys("c", "C", 1);
	const out1 = collectInjections([pA, pB, pC], BASE);
	const out2 = collectInjections([pC, pA, pB], BASE);
	assert.deepEqual(out1, out2, "打乱输入顺序输出不变");
	assert.deepEqual(out1.system.map((item) => item.id), ["a", "c", "b"]);
});

test("同 id 去重：后者覆盖（规范序里最后一次出现胜出），不受 provider 顺序影响", () => {
	const dup: InjectionProvider = () => [
		{ id: "dup", text: "FIRST", order: 1, scope: "session", channel: "system" },
		{ id: "dup", text: "LATER", order: 2, scope: "session", channel: "system" },
	];
	const out = collectInjections([dup], BASE);
	assert.equal(out.system.length, 1);
	assert.equal(out.system[0]?.text, "LATER");
});

test("按 channel 分流：system / message 各归各位", () => {
	const both: InjectionProvider = () => [
		{ id: "m", text: "M", order: 0, scope: "turn", channel: "message" },
		{ id: "s", text: "S", order: 0, scope: "session", channel: "system" },
	];
	const out = collectInjections([both], BASE);
	assert.deepEqual(out.system.map((item) => item.id), ["s"]);
	assert.deepEqual(out.message.map((item) => item.id), ["m"]);
});

// ── 硬标准：B 期各 section 的正文逐字节一致 ────────────

test("B: injection_guard 正文 === INJECTION_GUARD（批 A 硬标准不回退）", () => {
	const item = collect(guardProvider).system[0];
	assert.equal(item?.text, INJECTION_GUARD);
	assert.equal(item?.id, "injection_guard");
	assert.equal(item?.channel, "system");
});

test("B: persona —— chief 回落 PERSONA，worker 每轮现读人设文件（默认同 WORKER_PERSONA），非 chief 执事不注", () => {
	assert.equal(sysText(personaProvider, { chatKind: "chief", partnerId: null }), PERSONA);
	assert.equal(
		sysText(personaProvider, { chatKind: "worker", partnerId: null }),
		// 2026-11-16 批2 拆层：正文（共享）+ 会话工具提示（只有会话有这三件工具）
		readWorkerPersona() + WORKER_PERSONA_CHAT_TOOLS,
	);
	assert.equal(personaProvider({ ...BASE, chatKind: "chief", partnerId: "p-1" }), undefined);
});

test("B: verification_iron_law —— 总管/无身份注，普通执事不注（由 partner-context 补）", () => {
	assert.equal(sysText(verificationIronLawProvider, { partnerId: null }), VERIFICATION_IRON_LAW);
	assert.equal(sysText(verificationIronLawProvider, { partnerId: "chief" }), VERIFICATION_IRON_LAW);
	assert.equal(verificationIronLawProvider({ ...BASE, partnerId: "p-1" }), undefined);
});

test("B: clarify_contract —— 总管注、worker / 普通执事不注；开关关时整段省略", () => {
	assert.equal(
		sysText(clarifyContractProvider, { partnerId: null, chatKind: "chief" }),
		CLARIFY_CONTRACT,
	);
	assert.equal(
		clarifyContractProvider({ ...BASE, partnerId: null, chatKind: "worker" }),
		undefined,
	);
	assert.equal(clarifyContractProvider({ ...BASE, partnerId: "p-1", chatKind: "chief" }), undefined);
	const saved = process.env.AGENT_CLARIFY_CONTRACT;
	process.env.AGENT_CLARIFY_CONTRACT = "false";
	try {
		assert.equal(
			clarifyContractProvider({ ...BASE, partnerId: null, chatKind: "chief" }),
			undefined,
		);
	} finally {
		if (saved === undefined) delete process.env.AGENT_CLARIFY_CONTRACT;
		else process.env.AGENT_CLARIFY_CONTRACT = saved;
	}
});

test("B: current_project —— 固定部分与动态部分分家（2026-11-19 前缀锁定）", () => {
	// 测试环境没有工作区 / 项目 / 会话快照：固定段整段省略，不造空段。
	assert.equal(currentProjectProvider(BASE), undefined);
	// 动态的「当前项目 / 相对路径基准」走消息尾部，每轮现算。
	const live = collect(currentProjectLiveProvider, BASE).message[0];
	assert.equal(live?.channel, "message");
	assert.equal(live?.scope, "turn");
	assert.equal(live?.text, "当前无特定项目（杂事模式）。文件操作默认在主工作区。");
});

test("B: skills —— live 走 indexFor（按会话冻结的同一份），dryRun 不冻结", () => {
	const live = sysText(skillsProvider, { conversationId: 7 });
	assert.equal(live, skillStore?.indexFor(7), "与技能库渲染逐字节一致");
	assert.match(live ?? "", new RegExp(SKILL_NAME), "临时技能进了索引");
	assert.equal(sysText(skillsProvider, { conversationId: 7 }), live, "冻结后取值不变");
	assert.equal(skillsProvider({ ...BASE, conversationId: 99, dryRun: true }), undefined);
});

test("B: SKILL_STATE=false 逃生门 —— 默认关着的技能也全进索引", () => {
	const old = process.env.SKILL_STATE;
	process.env.SKILL_STATE = "false";
	try {
		const text = sysText(skillsProvider, { conversationId: 123 });
		assert.match(text ?? "", /hidden-skill/, "逃生门打开后不再按启停位过滤");
	} finally {
		if (old === undefined) delete process.env.SKILL_STATE;
		else process.env.SKILL_STATE = old;
	}
});

test("B: skills —— 普通助手（chatKind=worker）走独立命名空间，不吃别的角色的按人覆盖", () => {
	const text = sysText(skillsProvider, { conversationId: 321, chatKind: "worker" });
	assert.match(text ?? "", /worker-skill/, "worker 独开的技能进了普通助手索引");
	assert.match(text ?? "", new RegExp(SKILL_NAME), "全局已开的照旧有");
	const chief = sysText(skillsProvider, { conversationId: 322, chatKind: "chief" });
	assert.doesNotMatch(chief ?? "", /worker-skill/, "别的角色索引不吃 worker 的独开");
});

test("B: tool_index —— 无可加载 deferred 整段省略；有列表含名字与提示（开关 2026-11-21 退役恒渲染）", () => {
	assert.equal(toolIndexProvider({ ...BASE, deferred: [] }), undefined, "空列表不造空段");
	const text = sysText(toolIndexProvider, {
		deferred: [{ name: "routine_manage", description: "自建常驻自主轮。" }],
	});
	assert.match(text ?? "", /^按需工具（初始不加载）：/);
	assert.match(text ?? "", /- routine_manage：自建常驻自主轮/);
	assert.match(text ?? "", /tool_search\(\{name\}\)/);
});

test("B: section 顺序快照（位置 = 数组下标，改序打掉提示词缓存）", () => {
	assert.deepEqual(
		LIFECYCLE_SECTIONS.map((section) => section.key),
		[
			"persona",
			// 2026-11-19：关于我（全局固定背景，紧跟 persona；worker / 群会话由 provider 跳过）。
			"user_profile",
			"verification_iron_law",
			"clarify_contract",
			"injection_guard",
			"current_project",
			// 2026-11-22 记忆外挂源批：一生库目录（固定前缀段；未配置 = 零字节）。
			"persona_catalog",
			// 2026-11-16：派活执行器知情段（新单派给谁 / 模型 / 权限）。
			"delegate_executor",
			"skills",
			"tool_index",
		],
	);
});

test("B: section render 产出与 provider 逐字节一致（框架确实在驱动）", async () => {
	const fakeInput = {
		conversationId: "1",
		read: { snapshot: async () => ({ byInternal: {} }) },
	};
	const byKey = new Map(LIFECYCLE_SECTIONS.map((section) => [section.key, section]));
	const render = (key: string) => byKey.get(key)!.render(fakeInput as never, {} as never);
	assert.equal(await render("persona"), PERSONA);
	assert.equal(await render("verification_iron_law"), VERIFICATION_IRON_LAW);
	assert.equal(await render("clarify_contract"), CLARIFY_CONTRACT);
	assert.equal(await render("injection_guard"), INJECTION_GUARD);
	// 当前项目 / 主工作区的文案随工作区是否存在变化（2026-11-16 补主工作区路径），
	// 这里只钉「框架驱动 == provider 直接调用」，不钉具体文案。
	assert.equal(
		await render("current_project"),
		sysText(currentProjectProvider, fakeInput as never),
	);
	assert.match((await render("skills")) ?? "", new RegExp(SKILL_NAME));
});

// ── 硬标准：C/D 期消息注入 ─────────────────────────────

test("C: 技能斜杠 —— 模板逐字节一致（/名字 + 手册正文 + 括注）", () => {
	assert.equal(
		msgText(skillSlashProvider, { userText: `/${SKILL_NAME} 帮我按这个做` }),
		`【技能调用 · ${SKILL_NAME}】\n${SKILL_MANUAL}\n（用户消息开头的 /${SKILL_NAME} 就是调用这份手册；其余文字是这一轮的指令。）`,
	);
	assert.equal(skillSlashProvider({ ...BASE, userText: "普通消息" }), undefined);
});

test("D: 回合上限 —— 只在 turn > MAX_TURNS 时注，正文 === TURN_LIMIT_INSTRUCTION", () => {
	assert.equal(turnLimitProvider({ ...BASE, turn: MAX_TURNS }), undefined);
	assert.equal(msgText(turnLimitProvider, { turn: MAX_TURNS + 1 }), TURN_LIMIT_INSTRUCTION);
});

test("D: 恢复注记 —— 取走即核销（每张单一次），dryRun 不消费", () => {
	const conversationId = 501;
	markRecoverResume(conversationId);
	assert.equal(recoverNoteProvider({ conversationId, dryRun: true }), undefined, "审计不消费");
	const first = collect(recoverNoteProvider, { conversationId }).message[0];
	assert.ok(first?.text, "第一次取到注记");
	assert.equal(first?.scope, "once");
	assert.equal(recoverNoteProvider({ conversationId }), undefined, "取走即核销");
});

test("C: partner-context —— 各段 text 拼回改造前那一段（顺序不变）", () => {
	const store = new PartnersStore(join(root, "partner2.sqlite"), join(root, "homes2"));
	try {
		const partner = store.create("小澈", { soulSeed: "你是小澈。" });
		store.linkSession({
			partnerId: partner.id,
			role: "canonical",
			routeKey: "canonical",
			sessionId: 606,
		});
		const context = buildPartnerTurnContext(partner.id, 606, {
			store,
			workRoot: join(root, "runs"),
			approvals: { pendingOf: () => [] },
		});
		const expected = [context.contract, context.goal, context.discipline, context.status]
			.filter((part): part is string => Boolean(part))
			.join("\n\n");
		assert.equal(context.text, expected, "合并文本 = 改造前的四段 join");
		assert.ok(!(context.text ?? "").includes("【材料安全】"), "防线已合并进 lifecycle 系统段");
	} finally {
		store.close();
	}
});

// ── 顺序常量快照 ───────────────────────────────────────

test("顺序快照：INJECTION_ORDER 是缓存前缀资产（改它 = 有意的契约变更）", () => {
	const ordered = Object.entries(INJECTION_ORDER)
		.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
		.map(([key]) => key);
	assert.deepEqual(ordered, [
		"persona",
		// 2026-11-19：关于我（order 5，紧跟 persona；新增 system 段 = 有意的契约变更）
		"user_profile",
		"verification_iron_law",
		"clarify_contract",
		"injection_guard",
		"current_project",
		// 2026-11-19 前缀锁定：当前项目的动态一半（走消息尾部）
		"current_project_live",
		// 2026-11-22 记忆外挂源批：一生库目录常驻段（order 46，skills 之前，进静态前缀）
		"persona_catalog",
		"skills",
		// 2026-11-16 C 段：低频工具索引排在消息注入之前
		"tool_index",
		// 2026-11-15 项目记忆多挂载：负责项目索引排在记忆召回之前
		// （先知道"负责哪几摊"，后面那批记忆行才有归属可对）
		"project_index",
		"memory_recall",
		// 2026-11-22 记忆外挂源批：一生库轻召回（order 105，小库之后、技能斜杠之前）
		"persona_recall_light",
		"skill_slash",
		"recover_note",
		"turn_limit_approaching",
		"turn_limit",
		"partner_context",
		"partner_contract",
		"partner_goal",
		"partner_verification",
		"partner_ruling",
		"partner_work_silence",
		"partner_grounding",
		"partner_artifact_handoff",
		"partner_owner_data",
		"partner_brief_card",
		"partner_attention",
		"partner_status",
		// 2026-11-15 批3：学习 / 主动性挂在状态段之后
		"partner_learning",
		"partner_proactivity",
		// 2026-11-15 批2：活模块三段挂在在办之后（印象 → 心情 → 心里话）
		"partner_impression",
		"partner_mood",
		"partner_heart",
		"task_memory",
	]);
	const values = Object.values(INJECTION_ORDER);
	assert.equal(new Set(values).size, values.length, "order 不允许重值");
});

// ── 一生记忆库外挂注入（2026-11-22 记忆外挂源批 §六.3 后两项）────────────

test("persona_catalog：配置了 + 成功拉过才注；群聊 / 非 chief 执事 / 未拉过不注", async () => {
	const { personaCatalogProvider } = await import("./lifecycle-injections.ts");
	const { refreshPersonaCatalogInjection, resetPersonaCatalogForTests } = await import(
		"../persona-inject.ts"
	);
	resetPersonaCatalogForTests();
	// 还没成功拉过目录：整段不注（不造空标题段）。
	assert.equal(personaCatalogProvider(BASE), undefined, "没拉过目录不注");

	// provider 读的是 process.env（生产契约，无注入口）：父闸两个键临时挂上，测完复原。
	const savedAsk = process.env.PERSONA_MEMORY_ASK;
	const savedPython = process.env.PERSONA_PYTHON;
	process.env.PERSONA_MEMORY_ASK = join(root, "ask.py");
	process.env.PERSONA_PYTHON = "py3";
	const catalogEnv: NodeJS.ProcessEnv = {
		...process.env,
		AGENT_FLAGS_PATH: join(root, `persona-catalog-${process.pid}.json`),
	};
	delete catalogEnv.PERSONA_MEMORY_INJECT;
	delete catalogEnv.PERSONA_MEMORY_ENABLED;
	writeFileSync(catalogEnv.AGENT_FLAGS_PATH!, "{}\n", "utf8");
	// 假 spawn：catalog 走 --catalog-only，stdout 喂两行边界文本（不真起 python）。
	const catalogSpawn = ((command: string, args: string[]) => {
		assert.ok(String(command), "python 命令非空");
		assert.ok(args.includes("--catalog-only"), "目录走 --catalog-only 入口");
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): boolean };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => true;
		queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from("库里 100 个事件 / 74 个月\n常提的人：a、b\n", "utf8"));
			child.emit("close", 0);
		});
		return child as never;
	}) as unknown as typeof import("node:child_process").spawn;
	await refreshPersonaCatalogInjection({ env: catalogEnv, spawnFn: catalogSpawn });
	try {
		const item = personaCatalogProvider(BASE);
		assert.ok(item && !Array.isArray(item), "配置齐 + 拉过 → 注入");
		if (item && !Array.isArray(item)) {
			assert.equal(item.id, "persona_catalog");
			assert.equal(item.channel, "system");
			assert.equal(item.scope, "session");
			assert.match(item.text ?? "", /^以下是主人一生记忆库的边界/);
		}
		assert.equal(
			personaCatalogProvider({ ...BASE, group: true }),
			undefined,
			"群聊不注（群聊不走个人记忆）",
		);
		assert.equal(
			personaCatalogProvider({ ...BASE, partnerId: "p-1" }),
			undefined,
			"非 chief 执事不注（执事轮已有大量 partner_context，目录收益低）",
		);
		// 审计投影自动覆盖：登记表里走一遍，persona_catalog 要出现。
		const rows = auditInjections(
			INJECTION_REGISTRY.filter((row) => row.source === "lifecycle"),
			{ conversationId: 1, chatKind: "chief", partnerId: null, dryRun: true },
		);
		assert.ok(
			rows.some((row) => row.id === "persona_catalog"),
			"审计投影覆盖新注入 id（无白名单要补）",
		);
	} finally {
		resetPersonaCatalogForTests();
		if (savedAsk === undefined) delete process.env.PERSONA_MEMORY_ASK;
		else process.env.PERSONA_MEMORY_ASK = savedAsk;
		if (savedPython === undefined) delete process.env.PERSONA_PYTHON;
		else process.env.PERSONA_PYTHON = savedPython;
		rmSync(catalogEnv.AGENT_FLAGS_PATH!, { force: true });
	}
});

test("总闸 PERSONA_MEMORY_INJECT=false：catalog 段与轻召回两处净增消失", async () => {
	const { personaCatalogProvider } = await import("./lifecycle-injections.ts");
	const {
		personaCatalogCachedText,
		personaInjectGatesClosed,
		refreshPersonaCatalogInjection,
		resetPersonaCatalogForTests,
	} = await import("../persona-inject.ts");
	resetPersonaCatalogForTests();
	const catalogEnv: NodeJS.ProcessEnv = {
		...process.env,
		AGENT_FLAGS_PATH: join(root, `persona-catalog-off-${process.pid}.json`),
		PERSONA_MEMORY_ASK: join(root, "ask.py"),
		PERSONA_MEMORY_INJECT: "false",
	};
	writeFileSync(catalogEnv.AGENT_FLAGS_PATH!, "{}\n", "utf8");
	try {
		assert.equal(personaInjectGatesClosed(catalogEnv), true, "总闸关 = 闸门判关");
		await refreshPersonaCatalogInjection({ env: catalogEnv });
		assert.equal(personaCatalogCachedText(), null, "总闸关时不拉目录");
		assert.equal(personaCatalogProvider(BASE), undefined, "catalog 段消失");
		// 审计走真实 process.env：本进程未配 PERSONA_MEMORY_ASK，父闸不过 = 不注册（同回滚口径）。
		const rows = auditInjections(INJECTION_REGISTRY, {
			conversationId: 1,
			chatKind: "chief",
			partnerId: null,
			dryRun: true,
		});
		assert.ok(!rows.some((row) => row.id === "persona_catalog"), "审计清单里没有 catalog");
		assert.ok(
			!rows.some((row) => row.id === "persona_recall_light"),
			"轻召回走 beforeRequest 拼条目，总闸关/父闸不过时整条不产生",
		);
	} finally {
		resetPersonaCatalogForTests();
		rmSync(catalogEnv.AGENT_FLAGS_PATH!, { force: true });
	}
});

// ── 审计 ───────────────────────────────────────────────

test("审计：只回 {id,source,scope,channel,length}，不回正文", () => {
	const rows = auditInjections(INJECTION_REGISTRY, {
		conversationId: 1,
		chatKind: "chief",
		partnerId: null,
		dryRun: true,
	});
	const ids = rows.map((row) => row.id);
	assert.ok(ids.includes("injection_guard"));
	assert.ok(ids.includes("persona"));
	assert.ok(!ids.includes("skills"), "按会话冻结的技能不进审计（避免冻结）");
	assert.ok(!ids.includes("task_memory"), "任务近况要摄入日记，审计不跑");
	for (const row of rows) {
		assert.deepEqual(Object.keys(row).sort(), ["channel", "id", "length", "scope", "source"]);
		assert.equal(row.source, "lifecycle");
		assert.ok(!("text" in row));
	}
	assert.ok(!JSON.stringify(rows).includes("【材料安全】"), "全文不含注入正文");
});

test("审计：执事会话列出 partner-context 各段（source 能区分来源模块）", () => {
	// 必须落在**单例**库（PARTNERS_DB_PATH）里：审计走 partnersStore()，不接测试注入的 deps
	const store = partnersStore();
	const partner = store.create("阿岚", { soulSeed: "你是阿岚。" });
	store.linkSession({
		partnerId: partner.id,
		role: "canonical",
		routeKey: "canonical",
		sessionId: 707,
	});
	const rows = auditInjections(INJECTION_REGISTRY, {
		conversationId: 707,
		chatKind: "chief",
		partnerId: partner.id,
		dryRun: true,
	});
	const ids = rows.filter((row) => row.source === "partner-context").map((row) => row.id);
	assert.ok(ids.includes("partner_contract"));
	assert.ok(ids.includes("partner_ruling"));
	assert.ok(ids.includes("partner_attention"));
	assert.ok(!ids.includes("partner_status"), "在办要扫 runs/，审计不列");
	// 普通执事：lifecycle 的 persona / 铁律 / 课题都不注，防线仍注（system 段）
	assert.ok(!rows.some((row) => row.id === "persona"));
	assert.ok(rows.some((row) => row.id === "injection_guard"));
});

test("审计开关 AGENT_INJECTION_AUDIT：默认开，显式 false 关", () => {
	assert.equal(injectionAuditEnabled({}), true);
	assert.equal(injectionAuditEnabled({ AGENT_INJECTION_AUDIT: "" }), true);
	assert.equal(injectionAuditEnabled({ AGENT_INJECTION_AUDIT: "0" }), true);
	assert.equal(injectionAuditEnabled({ AGENT_INJECTION_AUDIT: "FALSE" }), false);
});

test("taskMemoryProvider：审计不跑（会摄入日记镜像）", () => {
	assert.equal(taskMemoryProvider({ conversationId: 0, dryRun: true }), undefined);
});

// ── 撞上限前提示（2026-11-13 工具层结果契约化批次三 §2.2）────────────

test("D: 撞上限前提示 —— 剩最后 5 轮（MAX_TURNS-4..MAX_TURNS）注，更早与超限后不注", () => {
	assert.equal(turnLimitApproachingProvider({ ...BASE, turn: MAX_TURNS - 5 }), undefined, "≤MAX_TURNS-5 不注");
	assert.match(msgText(turnLimitApproachingProvider, { turn: MAX_TURNS - 4 }), /即将到达轮次上限/);
	assert.ok(turnLimitApproachingProvider({ ...BASE, turn: MAX_TURNS }), "第 MAX_TURNS 轮仍注");
	assert.equal(turnLimitApproachingProvider({ ...BASE, turn: MAX_TURNS + 1 }), undefined, "超限后交给硬上限 turn_limit");
});
