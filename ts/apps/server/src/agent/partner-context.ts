import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PartnerPersonaModule } from "@lifediary/shared";
import { listManagers } from "../../../../../../chancellor/src/manager/registry.ts";
import { Store } from "../../../../../../chancellor/src/store.ts";
import type { Ticket } from "../../../../../../chancellor/src/types.ts";
import { approvalStore } from "../approvals.ts";
import { TERMINAL_TICKET_STATUS } from "../delegation-receipts.ts";
import {
	INJECTION_ORDER,
	collectInjections,
	type InjectionEntry,
	type InjectionProvider,
} from "./injection.ts";
import { RULING_DISCIPLINE, verificationIronLawFor } from "./turn-gate.ts";
import {
	ATTENTION_ONE_QUESTION,
	ATTENTION_REPLY_GUIDANCE,
	GROUNDING_DISCIPLINE,
	WORK_REVIEW_GUIDANCE,
	WORK_SILENCE_DISCIPLINE,
	chancellorWorkRoot,
} from "../delegation.ts";
import {
	CHIEF_PARTNER_ID,
	PARTNER_CONTRACT_SECTIONS,
	partnerContractEnabled,
	partnerDisciplineEditEnabled,
	partnersStore,
	type PartnersStore,
} from "../partners.ts";
import { effectivePersonaModules, personaModulesEnabled } from "../partner-persona.ts";
import { buildLivingSections, type LivingSections } from "../partner-living.ts";
import { buildLearningSection } from "../partner-learning.ts";
import { buildProactivitySection } from "../partner-proactive.ts";

/**
 * 执事轮上下文装配（2026-11-08 员工人格化刀一 E1 + E5）。
 *
 * 为什么单独一个模块：`lifecycle.ts` 的 beforeRequest 与 `group-runtime.ts` 的成员轮
 * 需要同一份「岗位契约 + 当前在办」。放在 agent/ 子模块是为了两边都能 import，
 * 同时保持 `partners.ts`（只做存储）不 import agent（8b 的装配方向）。
 *
 * 三段各归各的家（**别合并成一份文本存起来**）：
 *   1. **SOUL**：身份提示词（`renderPartnerIdentity` → configure instructions），
 *      读家目录磁盘当前值，改完下一轮生效（计数器记账）。
 *   2. **岗位契约**：读 CONTRACT.md 磁盘当前值 —— 改契约计数 +1，
 *      下一轮读到新的，当场不变身（2026-11-15 版本快照退役后的口径）。
 *   3. **当前在办**：派活单 / 待审批 / 最近一单，**全部现查现拼、零新存储**。
 *      每次请求都重新算，不写进 transcript（system 消息，与记忆注入同一条通道）。
 *
 * 回滚：`PARTNER_CONTRACT=false` 只关第 2 段；第 3 段是纯装配，没有独立开关
 * （关掉执事能力时整个 hook 不跑）。
 *
 * 人格模块开关（2026-11-14 批1）：第 2 段（契约）/ 目标 / 纪律 / 履历摘要 / 在办
 * 各是一个子开关（`contract` / `goal` / `discipline` / `workHistory` / `currentWork`），
 * 关 = 这一段不进本轮 system。**主人数据红线永不裁**：`discipline` 关掉时只留红线段；
 * SOUL（身份节）与 remember / preference 通道不在这套开关里。`PARTNER_PERSONA_MODULES=false`
 * 时全部按旧行为（谁都不裁）。
 */

// ── 汇报卡三规则（2026-11-10 批 15 §二，全景调研 #41）────────
//
// 只在**执事的汇报 / 日报类场景**注入文案与纪律（本批不做推送通道，触发时机由宿主决定）：
//   1. 没有值得报的就不发——宁可安静，不要"今天一切正常"的噪声；
//   2. 同一件事有更新就改原来那条，不新开；
//   3. 只在"今天第一次打开"或"离开三小时以上回来"出现，永不抢屏。
// 固定字节，不含日期 / 时刻 / 会话 id（与批 12 的纪律段同一口径）。

export const BRIEF_CARD_RULES = [
	"【汇报卡】",
	"- 没有值得报的就不发：宁可安静，也不要「今天一切正常」这种噪声。",
	"- 就地编辑：同一件事有更新，改原来那条，不要新开一条。",
	"- 只在「今天第一次打开」或「离开三小时以上回来」时出现；永不抢屏（不弹窗、不打断）。",
].join("\n");

/** 回滚开关：默认开；`BRIEF_CARD_RULES=false` → 纪律段回到改动前（逐字节一致）。 */
export function briefCardRulesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.BRIEF_CARD_RULES ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

// ── 产物交接（2026-11-10 批 19 §三；全景调研三 §四#1）────────
//
// 多执事接力时，最大的损耗是"上一棒口头总结了什么"替代了"上一棒真的留下了什么"：
// 下一棒只能重做一遍，或者接在一个不准确的转述上。这条把"产物优先"钉成契约：
// 产出物必须落盘、交接必须点名路径、下一棒从产物开始读。
// 固定字节；落点：执事纪律段（总管与普通执事共用同一装配点）。

export const ARTIFACT_HANDOFF = [
	"【产物交接】",
	"- 多执事接力时，产出物必须落盘（文件 / 任务单附件）；下一棒从产物开始，不要从转述开始。",
	"- 交接时在留言里点名产物路径（哪个文件 / 哪个目录），让下一棒能直接打开。",
	"- 没有落盘的「做完了」不算交接完成：话可以少说，产物不能少。",
].join("\n");

/** 回滚开关：默认开；`PARTNER_ARTIFACT_HANDOFF=false` → 纪律段回到改动前（逐字节一致）。 */
export function artifactHandoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.PARTNER_ARTIFACT_HANDOFF ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

// ── 主人数据红线（2026-11-10 批 21 §七；compass AGENTS.md 四条成文）────────
//
// 六 §七#5 的差半：权限分级表 / 提案制 / 引原话不打分 / 日记不可重写。
// 注入防御与"一次批准一次改动"此前已落地（批 11/批 12），不在此重复。
// 固定字节；落点：执事纪律段（总管与普通执事共用——总管同样面对主人的数据）。

export const OWNER_DATA_DISCIPLINE = [
	"【主人数据红线】",
	"- 数据域分级：主人的日记与记忆=只能追加或经提案；主人配置=只读；自己的家目录=可写。",
	"- 有判断，无权力：改主人层面的文件先提案，说清改什么、为什么；一次批准只覆盖一件事。",
	"- 日记域永不删除、重写、重排或「顺手清理」：只追加，或出一份只读报告。",
	"- 引主人的原话：引原文并标日期；不复述成自己的话，不打分不评判。",
].join("\n");

/** 回滚开关：默认开；`PARTNER_OWNER_DATA_DISCIPLINE=false` → 纪律段回到改动前（逐字节一致）。 */
export function ownerDataDisciplineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.PARTNER_OWNER_DATA_DISCIPLINE ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

// ── 岗位契约 ─────────────────────────────────────────────

/**
 * 把契约正文按固定四节切开。**只认四个二级标题**（`## 职责范围` …），
 * 标题之间直到下一个二级标题的内容算正文；文件里其它内容一律忽略。
 * 返回 Map 而非对象：节名就是键，缺节 = 没有键。
 */
export function splitContractSections(source: string): Map<string, string> {
	const sections = new Map<string, string>();
	const known = new Set<string>(PARTNER_CONTRACT_SECTIONS);
	let current: string | null = null;
	let buffer: string[] = [];
	const flush = (): void => {
		if (!current) return;
		sections.set(current, buffer.join("\n").trim());
		buffer = [];
	};
	for (const line of source.split(/\r?\n/)) {
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			flush();
			const name = heading[1] ?? "";
			current = known.has(name) ? name : null;
			continue;
		}
		if (current) buffer.push(line);
	}
	flush();
	return sections;
}

/**
 * 契约段：四节全文，**空节连标题一起省略**；四节全空 / 没有文件 → undefined
 * （整段消失，不留一个空壳标题）。开关关着也不渲染。
 */
export function renderContractSection(contractSource: string | null | undefined): string | undefined {
	if (!partnerContractEnabled()) return undefined;
	if (!contractSource?.trim()) return undefined;
	const sections = splitContractSections(contractSource);
	const blocks: string[] = [];
	for (const name of PARTNER_CONTRACT_SECTIONS) {
		const body = sections.get(name)?.trim();
		if (body) blocks.push(`## ${name}\n${body}`);
	}
	if (blocks.length === 0) return undefined;
	return ["【岗位契约】", ...blocks].join("\n\n");
}

// ── 当前在办 ─────────────────────────────────────────────

// 终态口径唯一实现在 delegation-receipts.ts（2026-11-10 收口；原注"刻意不导出"已推翻，
// 见该处注释与变更记录 2026-11-10-状态机清点）。

const STATUS_LABEL: Record<string, string> = {
	received: "已受理",
	planning: "规划中",
	planned: "拆解完成",
	dispatching: "进行中",
	reviewing: "核对中",
	done: "已完成",
	needs_you: "等你回答",
	idle: "等子单",
	failed: "失败",
	aborted: "已中止",
};

/** 明细条数上限：超过就只报"另有 N 条"，别让一段状态吃掉半个上下文。 */
const DETAIL_LIMIT = 3;

/** 该执事发起的一张派活单（只留展示需要的字段，不把 prompt 全文带进提示词）。 */
interface PartnerTicket {
	id: string;
	status: string;
	updatedAt: string;
	lastAction: string;
	waitingOn: string | null;
}

/**
 * 装配用的注入缝。生产不传（走 partnersStore / approvalStore / chancellorWorkRoot）；
 * 单测注入临时库与临时 workRoot，不碰真实 `.data/`。
 */
export interface PartnerContextDeps {
	store?: PartnersStore;
	approvals?: { pendingOf(conversationId: number): Array<{ tool: string; args: string }> };
	workRoot?: string;
	/** 每次扫描每类 runs 目录取多少张单（默认 200；够覆盖"在办 + 最近一单"）。 */
	ticketLimit?: number;
	/**
	 * 人格模块开关（2026-11-14 批1）：`currentWork` 管在办段、`workHistory` 管履历摘要。
	 * 不传 = 两个都开（旧行为；单测与旧调用方零改动）。
	 */
	persona?: { currentWork: boolean; workHistory: boolean };
	/**
	 * 该执事近 N 单 work 履历聚合（2026-11-08 刀二 E2）。
	 * 由装配层（lifecycle）注入 `workSummaryFor`；不传 = 不加履历摘要行
	 * （单测零副作用，也不去开真实记忆库）。结构化查询，不走语义召回。
	 */
	workSummary?: (partnerId: string) => {
		done: number;
		failed: number;
		stopped: number;
		total: number;
	} | null;
	/**
	 * 活模块段（2026-11-15 批2）：测试注入已渲染好的三段；不传 = 生产走 partner-living
	 * 读印象库 / 家目录文件。传 `null` = 明确"没有活内容"（等价空）。
	 */
	living?: LivingSections | null;
}

function readTicketJson(runsDir: string, ticketId: string): Ticket | null {
	try {
		return JSON.parse(
			readFileSync(join(runsDir, ticketId, "ticket.json"), "utf8"),
		) as Ticket;
	} catch {
		return null;
	}
}

/**
 * 扫出"该执事发起"的单：`ticket.json` 的 `originConversationId` 落在他的会话 id 集合里。
 *
 * 数据源与任务中心同源（chancellor `runs/`，含各领域 `managers/<domain>/runs/`），
 * 不新增索引、不新增存储 —— 一张单原来的派单记账本来就带着发起会话。
 * 老单没有 `originConversationId` 就看不到（回执反查是任务中心为了历史单做的，
 * 这里不重复一遍：状态感只需要"最近的、我在办的"，不需要全量归档）。
 */
function ticketsOfPartner(
	workRoot: string,
	sessionIds: Set<number>,
	limit: number,
): PartnerTicket[] {
	const dirs: string[] = [];
	try {
		// 只扫**已经存在**的目录：没有 runs/ 时开 Store 会顺手建库，一个纯读的状态段
		// 不该在磁盘上留下东西（chancellor 从未跑过的机器上尤其明显）。
		if (existsSync(workRoot)) {
			dirs.push(workRoot);
			for (const entry of listManagers(workRoot)) {
				const runsDir = entry.meta?.runs_dir;
				if (runsDir && existsSync(runsDir)) dirs.push(runsDir);
			}
		}
	} catch {
		// 领域清单读不出来就只看顶层：状态感不能因为一个目录读失败而整段消失
	}

	const byId = new Map<string, PartnerTicket>();
	for (const dir of dirs) {
		let store: Store | null = null;
		try {
			store = new Store(dir);
			for (const row of store.listTickets(limit)) {
				const ticket = readTicketJson(dir, row.id);
				if (!ticket) continue;
				const origin = Number(String(ticket.originConversationId ?? "").trim());
				if (!Number.isInteger(origin) || !sessionIds.has(origin)) continue;
				const id = String(ticket.id);
				if (byId.has(id)) continue;
				byId.set(id, {
					id,
					status: String(ticket.status ?? ""),
					updatedAt: String(ticket.updated_at ?? ticket.created_at ?? ""),
					lastAction: String(ticket.lastAction ?? "").trim(),
					waitingOn: ticket.waitingOn ? String(ticket.waitingOn) : null,
				});
			}
		} catch {
			// 单个 runs 目录坏了不挡其它目录
		} finally {
			store?.close();
		}
	}
	return [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function ticketDetail(ticket: PartnerTicket): string {
	const label = STATUS_LABEL[ticket.status] ?? ticket.status;
	const extra = ticket.lastAction ? `：${oneLine(ticket.lastAction, 60)}` : "";
	const waiting = ticket.waitingOn ? `（等 ${oneLine(ticket.waitingOn, 20)}）` : "";
	return `- ${ticket.id}（${label}${waiting}）${extra}`;
}

function approvalDetail(record: { tool: string; args: string }): string {
	const args = oneLine(record.args, 60);
	return `- ${record.tool}${args ? `：${args}` : ""}`;
}

/**
 * 「当前在办」段（E5）：①未终态的派活单 ②本会话待审批 ③最近一单结果。
 * 三项皆空 → undefined（整段省略）。明细 ≤3 条，超出只报条数。
 *
 * 2026-11-14 批1：按人格开关拆两半——`currentWork` 管前三项，`workHistory` 管段尾的
 * 履历摘要 + 盘点口径。只开履历不开在办时不再拼「【当前在办】」这个空壳头
 * （有履历没在办的情况下，头与「答不了怎么办」口径都没有意义）。
 */
export function buildPartnerStatusSection(
	partnerId: string,
	conversationId: number,
	deps: PartnerContextDeps = {},
): string | undefined {
	const store = deps.store ?? partnersStore();
	const showCurrent = deps.persona?.currentWork ?? true;
	const showHistory = deps.persona?.workHistory ?? true;
	const sessionIds = showCurrent ? new Set(store.sessionIdsOf(partnerId)) : new Set<number>();
	const tickets = sessionIds.size
		? ticketsOfPartner(deps.workRoot ?? chancellorWorkRoot(), sessionIds, deps.ticketLimit ?? 200)
		: [];
	const active = tickets.filter((ticket) => !TERMINAL_TICKET_STATUS.has(ticket.status));
	const last = tickets.find((ticket) => TERMINAL_TICKET_STATUS.has(ticket.status));

	let approvals: Array<{ tool: string; args: string }> = [];
	try {
		const sink = deps.approvals ?? approvalStore();
		approvals = showCurrent ? sink.pendingOf(conversationId) : [];
	} catch {
		// 审批库读不出来不影响其它两项
		approvals = [];
	}

	// 履历摘要（**过去时**）与在办（**现在时**）两层互补别混：
	// 在办来自 runs 扫描（刀一），履历来自 work 记录的结构化查询（刀二）。
	// 零记录不加（workSummary 返回 null 或 total=0）。
	const summary = showHistory ? (deps.workSummary?.(partnerId) ?? null) : null;
	const workLine =
		summary && summary.total > 0
			? `近 10 单：完成 ${summary.done}、失败 ${summary.failed}、中止 ${summary.stopped}`
			: null;

	const lines: string[] = [];
	// 在办三项都在才算"有在办"：有一项就拼头，一项都没有时连头一起省。
	if (showCurrent && (active.length > 0 || approvals.length > 0 || last)) {
		lines.push("【当前在办】");
		if (active.length > 0) {
			lines.push("在办的单：");
			for (const ticket of active.slice(0, DETAIL_LIMIT)) lines.push(ticketDetail(ticket));
			if (active.length > DETAIL_LIMIT) lines.push(`（另有 ${active.length - DETAIL_LIMIT} 单在办）`);
		}
		if (approvals.length > 0) {
			lines.push("等你批的：");
			for (const record of approvals.slice(0, DETAIL_LIMIT)) lines.push(approvalDetail(record));
			if (approvals.length > DETAIL_LIMIT) {
				lines.push(`（另有 ${approvals.length - DETAIL_LIMIT} 条待批）`);
			}
		}
		if (last) {
			const label = STATUS_LABEL[last.status] ?? last.status;
			const detail = last.lastAction ? `：${oneLine(last.lastAction, 80)}` : "";
			lines.push(`最近一单：${last.id}（${label}）${detail}`);
		}
		// 有在办/待批时把「答不了怎么办」的口径带上（B2）：模型只在真有工人等它时才需要它。
		lines.push("", ATTENTION_REPLY_GUIDANCE);
	}
	if (!lines.length && !workLine) return undefined;
	// 段末尾挂一行履历摘要 + 周期盘点口径（刀二 E2/E4）：有履历才出现。
	if (workLine) {
		if (lines.length) lines.push("");
		lines.push(workLine, "", WORK_REVIEW_GUIDANCE);
	}
	return lines.join("\n");
}

// ── 当前目标 ─────────────────────────────────────────────

/**
 * 【当前目标】段（2026-11-08 刀二 E4）：有目标才出现，一行。
 *
 * 目标**不版本化**（不是身份，是"现在在奔什么"），现取现用：改完下一轮读到新的。
 * 与契约（低频、版本化、下一轮生效）刻意分开；空 / 全空白 = 整段省略。
 */
export function buildPartnerGoalSection(
	partnerId: string,
	store: PartnersStore = partnersStore(),
): string | undefined {
	const goal = store.get(partnerId)?.currentGoal?.trim();
	return goal ? `【当前目标】${goal}` : undefined;
}

// ── 整体装配 ─────────────────────────────────────────────

/** 段 id → 框架顺序（2026-11-10 批 27）。顺序 = 改造前 `[contract, goal, discipline, status]` 的拼接顺序。 */
const ORDER: Record<string, number> = {
	partner_contract: INJECTION_ORDER.partner_contract,
	partner_goal: INJECTION_ORDER.partner_goal,
	partner_verification: INJECTION_ORDER.partner_verification,
	partner_ruling: INJECTION_ORDER.partner_ruling,
	partner_work_silence: INJECTION_ORDER.partner_work_silence,
	partner_grounding: INJECTION_ORDER.partner_grounding,
	partner_artifact_handoff: INJECTION_ORDER.partner_artifact_handoff,
	partner_owner_data: INJECTION_ORDER.partner_owner_data,
	partner_brief_card: INJECTION_ORDER.partner_brief_card,
	partner_attention: INJECTION_ORDER.partner_attention,
	partner_status: INJECTION_ORDER.partner_status,
	partner_learning: INJECTION_ORDER.partner_learning,
	partner_proactivity: INJECTION_ORDER.partner_proactivity,
	partner_impression: INJECTION_ORDER.partner_impression,
	partner_mood: INJECTION_ORDER.partner_mood,
	partner_heart: INJECTION_ORDER.partner_heart,
};

/** 纪律段在合并文本里的次序（`buildPartnerDisciplineSection` 靠它拼，测试也照它断言）。 */
const DISCIPLINE_IDS = [
	"partner_verification",
	"partner_ruling",
	"partner_work_silence",
	"partner_grounding",
	"partner_artifact_handoff",
	"partner_owner_data",
	"partner_brief_card",
	"partner_attention",
] as const;

/**
 * 纪律覆盖文件（`DISCIPLINE.md`，2026-11-16）的固定标题。
 * 只认这些标题：缺节 = 用宿主默认；空节 = 删掉这条；不认识的标题直接拒。
 * 主人数据红线不在可覆盖清单里——它始终由宿主常量注入。
 */
const DISCIPLINE_TITLE_BY_ID: Record<(typeof DISCIPLINE_IDS)[number], string> = {
	partner_verification: "验证铁律",
	partner_ruling: "裁决纪律",
	partner_work_silence: "干活期间",
	partner_grounding: "答案接地",
	partner_artifact_handoff: "产物交接",
	partner_owner_data: "主人数据红线",
	partner_brief_card: "汇报卡",
	partner_attention: "提问纪律",
};
const DISCIPLINE_EDITABLE_TITLE_TO_ID = new Map<string, string>(
	Object.entries(DISCIPLINE_TITLE_BY_ID)
		.filter(([id]) => id !== "partner_owner_data")
		.map(([id, title]) => [title, id]),
);

/** 从一段纪律正文里取 `【标题】`（默认块的第一行）；没有就返回 null。 */
function disciplineTitleOf(text: string): string | null {
	return /^【(.+?)】/.exec(text)?.[1] ?? null;
}

/**
 * 校验人写的 `DISCIPLINE.md`：只允许固定可覆盖标题；不接受主人数据红线。
 * 返回 null = 可保存；返回字符串 = 给界面看的拒绝原因。
 */
export function validateDisciplineSource(source: string): string | null {
	const headings = source
		.split(/\r?\n/)
		.map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1] ?? null)
		.filter((title): title is string => title !== null);
	if (headings.length === 0) {
		return "纪律覆盖要用固定二级标题（如「## 验证铁律」），不能是一段没有标题的正文";
	}
	for (const title of headings) {
		if (title === DISCIPLINE_TITLE_BY_ID.partner_owner_data) {
			return "「主人数据红线」由宿主固定注入，不能覆盖；其余纪律可以改";
		}
		if (!DISCIPLINE_EDITABLE_TITLE_TO_ID.has(title)) {
			return `不认识的纪律标题「${title}」；可用：${[...DISCIPLINE_EDITABLE_TITLE_TO_ID.keys()].join(" / ")}`;
		}
	}
	return null;
}

/** 解析覆盖文件：标题 → 正文；空节正文为空串（渲染时删掉该条）。 */
function parseDisciplineOverride(source: string | null | undefined): Map<string, string> | null {
	if (!source?.trim()) return null;
	const map = new Map<string, string>();
	let current: string | null = null;
	let buffer: string[] = [];
	const flush = (): void => {
		if (!current) return;
		map.set(current, buffer.join("\n").trim());
		buffer = [];
	};
	for (const line of source.split(/\r?\n/)) {
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			flush();
			current = DISCIPLINE_EDITABLE_TITLE_TO_ID.get(heading[1] ?? "") ?? null;
			continue;
		}
		if (current) buffer.push(line);
	}
	flush();
	return map.size > 0 ? map : null;
}

/** 把覆盖正文套回宿主块的 `【标题】` 形状；正文里重复的标题行去掉。 */
function renderDisciplineOverride(blockText: string, body: string): string {
	const title = disciplineTitleOf(blockText) ?? "纪律";
	const clean = body.replace(/^【(.+?)】\s*/u, "").trim();
	return `【${title}】\n${clean}`;
}

function entry(id: string, text: string | undefined): InjectionEntry | undefined {
	if (!text) return undefined;
	return { id, text, order: ORDER[id] ?? 0, scope: "session", channel: "message" };
}

/**
 * 纪律段（2026-11-10 批 12 + 批 16）：执事轮常量口径，全部固定字节、不含动态内容。
 *
 * 为什么集中在这里：任务的七件里有四件是提示词纪律，它们与契约 / 状态一样
 * 「每轮现渲染、不写进 transcript」。**总管（chief）的验证铁律由 lifecycle 的
 * persona 段注入**，这里跳过，避免同一段进两遍；普通执事没有 persona 段，在这里补。
 * 答案接地（批 16 §五）不按身份分：谁汇报谁负责。
 */
function disciplineBlocks(
	partnerId: string,
	includeDiscipline = true,
	store?: PartnersStore,
	opts: { ignoreOverrides?: boolean } = {},
): Array<{ id: string; text: string }> {
	// 主人数据红线（批 21 §七）：数据域分级/提案制/日记不可重写/引原话不打分；
	// 不按身份分——总管与执事同样面对主人的数据。
	// 2026-11-14 批1：它是**必选核心**，`discipline` 模块关掉时也只留这一段（永不裁）。
	const ownerData = ownerDataDisciplineEnabled() ? OWNER_DATA_DISCIPLINE : undefined;
	if (!includeDiscipline) {
		return ownerData ? [{ id: "partner_owner_data", text: ownerData }] : [];
	}
	const defaults: Array<{ id: string; text: string | undefined }> = [
		{ id: "partner_verification", text: verificationIronLawFor(partnerId) },
		{ id: "partner_ruling", text: RULING_DISCIPLINE },
		{ id: "partner_work_silence", text: WORK_SILENCE_DISCIPLINE },
		// 答案接地（批 16 §五）：总管与执事都要——它管的是"说出口的事实"，
		// 谁汇报谁负责，不按身份分。
		{ id: "partner_grounding", text: GROUNDING_DISCIPLINE },
		// 产物交接（批 19 §三）：接力时产物优先；同样不按身份分，谁交接谁负责。
		{
			id: "partner_artifact_handoff",
			text: artifactHandoffEnabled() ? ARTIFACT_HANDOFF : undefined,
		},
		{ id: "partner_owner_data", text: ownerData },
		// 汇报卡三规则（批 15 §二）：只给普通执事；总管那条时间线由界面承载，
		// 加进来会改变总管纪律段的固定字节，故跳过。
		{
			id: "partner_brief_card",
			text:
				partnerId === CHIEF_PARTNER_ID || !briefCardRulesEnabled()
					? undefined
					: BRIEF_CARD_RULES,
		},
		{ id: "partner_attention", text: ATTENTION_ONE_QUESTION },
	];
	const blocks = defaults.filter(
		(part): part is { id: string; text: string } => Boolean(part.text),
	);
	if (opts.ignoreOverrides || !partnerDisciplineEditEnabled()) return blocks;

	const storeForRead = store ?? partnersStore();
	const overrides = parseDisciplineOverride(storeForRead.readDisciplineFromHome(partnerId));
	if (!overrides) return blocks;
	const merged: Array<{ id: string; text: string }> = [];
	for (const block of blocks) {
		if (!overrides.has(block.id)) {
			merged.push(block);
			continue;
		}
		const body = overrides.get(block.id) ?? "";
		// 空节 = 人明确删掉这一条（不是"回默认"；回默认 = 删掉整个文件/对应标题）。
		if (!body.trim()) continue;
		merged.push({ id: block.id, text: renderDisciplineOverride(block.text, body) });
	}
	return merged;
}

export function buildPartnerDisciplineSection(partnerId: string, store?: PartnersStore): string {
	return disciplineBlocks(partnerId, true, store)
		.map((block) => block.text)
		.join("\n\n");
}

/**
 * 宿主默认的行为纪律（不含主人数据红线）——给人看的编辑模板。
 * 只用于档案页；真实注入仍然走 `disciplineBlocks`，避免界面和请求两套拼装逻辑。
 */
export function buildPartnerDisciplineDefault(partnerId: string, store?: PartnersStore): string {
	return disciplineBlocks(partnerId, true, store, { ignoreOverrides: true })
		.filter((block) => block.id !== "partner_owner_data")
		.map((block) => {
			const title = disciplineTitleOf(block.text) ?? "纪律";
			const body = block.text.replace(/^【(.+?)】\s*\n?/u, "").trim();
			return `## ${title}\n${body}`;
		})
		.join("\n\n");
}

/** 主人数据红线（固定段）——给档案页只读展示，不参与覆盖。 */
export function buildPartnerDisciplineRedLine(): string {
	return ownerDataDisciplineEnabled() ? OWNER_DATA_DISCIPLINE : "";
}

/**
 * 执事轮的各段 provider（2026-11-10 批 27 §二.2 接管）。
 *
 * 每段一个 id / order：框架负责排序与去重，`buildPartnerTurnContext` 只是把它们
 * 按 `\n\n` 拼回改造前那一段消息。**注入防线不在这里**——`injection_guard` 已由
 * lifecycle 的 system 段统一注入，原先执事尾巴那份是同 id 同正文的重复，批 27 合并。
 *
 * `status` 在审计（dryRun）下跳过：它要扫 chancellor 的 runs/ 目录 + 开 SQLite，
 * 读端点不该付这份代价（契约 / 目标 / 纪律仍照常列出）。
 */
export function partnerContextProviders(
	partnerId: string,
	conversationId: number,
	deps: PartnerContextDeps = {},
): InjectionProvider[] {
	const store = deps.store ?? partnersStore();
	const partner = store.get(partnerId);
	// 人格开关：`PARTNER_PERSONA_MODULES=false` 或行读不出来 → null = 全部按开（旧行为，谁都不裁）。
	const personaModules =
		partner && personaModulesEnabled() ? effectivePersonaModules(partner) : null;
	const personaOn = (id: PartnerPersonaModule): boolean =>
		personaModules === null || personaModules[id] === true;

	// 活模块三段（批2）：一轮只取一次（印象要开库、内心生活要读文件）。
	// `deps.living` 显式给了就以调用方为准（单测）；没给才走生产读取。
	let livingLoaded = false;
	let living: LivingSections | undefined;
	const livingOf = (): LivingSections | undefined => {
		if (livingLoaded) return living;
		livingLoaded = true;
		living =
			deps.living !== undefined
				? (deps.living ?? undefined)
				: buildLivingSections(partner, store);
		return living;
	};

	const providers: InjectionProvider[] = [
		// 契约读磁盘当前值（2026-11-15 快照退役：磁盘是当前值唯一事实源）。
		() =>
			personaOn("contract")
				? entry(
						"partner_contract",
						renderContractSection(store.readContractFromHome(partnerId)),
					)
				: undefined,
		() =>
			personaOn("goal") ? entry("partner_goal", buildPartnerGoalSection(partnerId, store)) : undefined,
		...disciplineBlocks(partnerId, personaOn("discipline"), store).map(
			(block) => () => entry(block.id, block.text),
		),
		(ctx) =>
			ctx.dryRun || (!personaOn("currentWork") && !personaOn("workHistory"))
				? undefined
				: entry(
						"partner_status",
						buildPartnerStatusSection(partnerId, conversationId, {
							...deps,
							store,
							// 只传当前生效的开关；deps 里调用方显式给了 persona 就以调用方为准（单测）。
							persona: deps.persona ?? {
								currentWork: personaOn("currentWork"),
								workHistory: personaOn("workHistory"),
							},
						}),
					),
		// 学习 / 主动性（2026-11-15 批3）：状态段之后、印象之前。
		// 模块关 / 总开关 false / 内容空 → 各自的 provider 返回 undefined（整段不出现）。
		() =>
			personaModulesEnabled() && personaOn("learning") && partner
				? entry("partner_learning", buildLearningSection(partner, store))
				: undefined,
		() =>
			personaModulesEnabled() && personaOn("proactivity") && partner
				? entry("partner_proactivity", buildProactivitySection(partner))
				: undefined,
		// 活模块三段（2026-11-15 批2）：印象 → 心情 → 心里话，挂在在办段之后。
		// 模块关 / 空内容 → 各自的 provider 返回 undefined（整段不出现）。
		// `PARTNER_PERSONA_MODULES=false` 时活模块本来不存在 → 整段不注（不靠 deps 兜）。
		() =>
			personaModulesEnabled() && personaOn("impression")
				? entry("partner_impression", livingOf()?.impression)
				: undefined,
		() =>
			personaModulesEnabled() && personaOn("mood")
				? entry("partner_mood", livingOf()?.mood)
				: undefined,
		() =>
			personaModulesEnabled() && personaOn("heart")
				? entry("partner_heart", livingOf()?.heart)
				: undefined,
	];
	return providers;
}

export interface PartnerDisciplineField {
	/** 与 `partnerContextProviders` 的 entry id 对齐，例如 `partner_verification`。 */
	id: string;
	/** 纪律块的固定标题（`【验证铁律】` 里的那一段）。 */
	title: string;
	/** 原始块正文，带 `【标题】` 第一行；默认页按这个字段单独展示。 */
	text: string;
}

export interface PartnerTurnContext {
	/** 身份正文（当前版本快照）。调用方放进 instructions；这里带出来是为了整体断言。 */
	soul: string;
	/** 岗位契约段（开关关 / 空 → null） */
	contract: string | null;
	/** 当前目标段（E4，无目标 → null） */
	goal: string | null;
	/** 纪律段（批 12：验证 / 裁决 / 干活期间 / 提问；批 16：答案接地；固定字节，永远非空） */
	discipline: string;
	/** 纪律按固定块拆开（2026-11-16 续）：默认页逐节展示 / 逐节编辑用。 */
	disciplineFields: PartnerDisciplineField[];
	/** 当前在办段（三项皆空 + 无履历 → null） */
	status: string | null;
	/** 表达习惯段（批3；模块关 / 规则空 → null） */
	learning: string | null;
	/** 主动一点段（批3；模块关 → null） */
	proactivity: string | null;
	/** 印象段（批2；模块关 / 空 → null） */
	impression: string | null;
	/** 心情段（批2；模块关 / 初始态 → null） */
	mood: string | null;
	/** 心里话段（批2；愿望与成长笔记都空 → null） */
	heart: string | null;
	/** 注入模型请求的附加段：契约 + 目标 + 纪律 + 在办 + 活模块（都空 → undefined） */
	text: string | undefined;
}

/**
 * 执事轮输入的单一装配点（E1 + E5；2026-11-10 批 27 走注入框架）。
 *
 * 顺序固定：**SOUL（身份）→ 岗位契约 → 当前目标 → 纪律 → 当前在办**。前两段来自同一个身份版本，
 * 后三段现查现拼。`text` 只含后四段：SOUL 在 instructions 里，重复一遍等于每轮
 * 白付一份 token，还会让模型看到两个版本的身份。
 *
 * 刀二只在同一装配点加两段（目标 / 履历摘要），批 12 再加一段固定纪律，
 * **没有第二条注入通道**。批 27 起各段带 id 过 `collectInjections`（排序 + 去重），
 * 再按改造前的顺序拼回同一段文本——内容与位置逐字节不变。
 */
export function buildPartnerTurnContext(
	partnerId: string,
	conversationId: number,
	deps: PartnerContextDeps = {},
): PartnerTurnContext {
	const store = deps.store ?? partnersStore();
	// SOUL 读磁盘当前值（2026-11-15 快照退役：磁盘是当前值唯一事实源，版本行已 DROP）。
	const soul = store.readSoulFromHome(partnerId) ?? "";
	const entries = collectInjections(partnerContextProviders(partnerId, conversationId, deps), {
		conversationId,
		partnerId,
	}).message;
	const byId = new Map(entries.map((item) => [item.id, item.text]));
	const disciplineFields: PartnerDisciplineField[] = DISCIPLINE_IDS.map((id) => {
		const text = byId.get(id) ?? "";
		return { id, title: DISCIPLINE_TITLE_BY_ID[id], text };
	});
	const discipline = disciplineFields
		.filter((field) => Boolean(field.text))
		.map((field) => field.text)
		.join("\n\n");
	const text = entries.map((item) => item.text).join("\n\n");
	return {
		soul,
		contract: byId.get("partner_contract") ?? null,
		goal: byId.get("partner_goal") ?? null,
		discipline,
		disciplineFields,
		status: byId.get("partner_status") ?? null,
		learning: byId.get("partner_learning") ?? null,
		proactivity: byId.get("partner_proactivity") ?? null,
		impression: byId.get("partner_impression") ?? null,
		mood: byId.get("partner_mood") ?? null,
		heart: byId.get("partner_heart") ?? null,
		text: text || undefined,
	};
}

/**
 * 审计用的 provider（`source: "partner-context"`）：只在 ctx 带执事 id 时展开各段。
 * 没有执事 id（主人会话 / 未解析会话）→ 什么都不注，与改造前一致。
 */
export const partnerContextInjectionProvider: InjectionProvider = (ctx) => {
	if (!ctx.partnerId) return undefined;
	return collectInjections(
		partnerContextProviders(ctx.partnerId, Number(ctx.conversationId)),
		ctx,
	).message;
};
