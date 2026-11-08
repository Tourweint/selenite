import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
	CHIEF_PARTNER_ID,
	partnersStore,
	type PartnerRow,
	type PartnersStore,
} from "./partners.ts";

/**
 * 执事间消息通道（2026-11-08 扫尾批 8d；方案 `2026-11-08-扫尾批8d方案（执事间消息通道）.md`）。
 *
 * 群聊解决"多执事看同一处"，本通道解决"A 有话单独跟 B 说"。送达**不建信箱表**：
 * 消息本体就是目标会话里的一条 user 输入（durable `submit` 持久化），目标忙就 followUp
 * 排队、空闲就触发一轮 —— 零新增存储（方案 §一.2）。
 *
 * 防乒乓是**结构保证**，不是提示词保证（宿主确定性红线）：
 *   1. hop 恒为 1：递话触发的目标轮次里 `send_to_agent` 被 beforeTool 摘掉；
 *   2. 每 run 上限 3 次；
 *   3. 正文里含 hop 标记（转述别人的递话）一律拒绝。
 * 第 1 条的事实源在 lifecycle 的 beforeTool，这里只提供"标记 / 查询"的进程内状态。
 *
 * 本模块**不 import agent/**：解析、包装、计数、通知口都是纯逻辑 + 注入的送达函数，
 * 与 tools.ts 的其它工具同层，避免 tools ← lifecycle ← session 的环。
 */

/** 工具名（lifecycle 的闸门按它识别，别在两处各写一个字面量） */
export const RELAY_TOOL_NAME = "send_to_agent";

/**
 * 回滚开关（方案 §一.8）：`PARTNER_RELAY_ENABLED=false` → 工具不上架。
 * 缺省**开**（新能力默认开 + 开关可关，符合"新能力给回滚开关"惯例）。
 */
export function partnerRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.PARTNER_RELAY_ENABLED?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

/** 单个 run 内最多递几次（方案 §一.4 第二条） */
export const RELAY_MAX_PER_RUN = 3;

/** 递话正文的字数上限（超过让模型自己压缩，不静默截断） */
export const RELAY_MESSAGE_LIMIT = 4000;

/**
 * hop 标记（方案 §一.4 第一条）。
 *
 * 通道天然只有一跳：目标轮的 `send_to_agent` 被摘掉，B 想回 A 只能用自己的话新起。
 * 这个标记的作用是**可识别**——A 把收到的递话原文贴进下一次调用时，工具据此拒绝
 * （"转述"等于两跳，绕过了结构摘除）。
 */
export const RELAY_HOP_TAG = "[relay hop=1]";

/** 被闸门拦下时回给模型的说明（lifecycle 用；措辞与 turn-gate 的拦截话术同风格） */
export const RELAY_HOP_BLOCK_MESSAGE =
	"这一轮是由别人递来的话触发的，不能再用 send_to_agent 转手递出去（这条通道只允许一跳）。" +
	"需要主人知情或回话，直接在本轮回复里说清楚，或让主人转达。";

export const RELAY_AUTONOMY_BLOCK_MESSAGE =
	"例行任务/自主轮里不能给其他执事递话（没有主人语境）。要留话请记进记忆或写进本轮汇报。";

export const RELAY_CALLER_BLOCK_MESSAGE =
	"只有执事自己的会话能递话；这是主人的对话，直接说让谁做什么就行，不需要转递。";

export const RELAY_GROUP_BLOCK_MESSAGE =
	"群聊里不做定向私聊（方案 §二）：有话在群里说，或直接告诉主人。";

export const RELAY_CHIEF_BLOCK_MESSAGE =
	"总管不参与执事间递话；要协调就用自己的话回主人。";

/** 单轮超限时给模型的引导话术（不是错误：本轮还能继续做别的） */
export function relayCapMessage(limit: number = RELAY_MAX_PER_RUN): string {
	return (
		`这一轮已经递了 ${limit} 条话，上限就是 ${limit} 条。` +
		"把剩下几件事合并成一条再说，或者等下一轮；别一条一件事地刷对方。"
	);
}

// ── 目标解析（纯函数，可单测）──────────────────────────────

export interface RelayTarget {
	id: string;
	name: string;
	domain: string | null;
}

export type RelayResolve =
	| { ok: true; target: RelayTarget }
	| {
			ok: false;
			/** `missing` = 查无此人 / `ambiguous` = 重名 / `self` = 指向自己 / `chief` = 总管 */
			reason: "missing" | "ambiguous" | "self" | "chief";
			message: string;
			/** 歧义时的候选（名字 + 领域，供模型改用长标签重试） */
			candidates?: RelayTarget[];
	  };

/** `@名字·domain` 同款长标签分隔符（与群组 @ 解析口径一致，用户输入法打得出） */
const LONG_LABEL_SEP = "·";

function toTarget(partner: PartnerRow): RelayTarget {
	return { id: partner.id, name: partner.name, domain: partner.domain ?? null };
}

/** 候选清单文案：`名字·domain`（没有领域的只给名字），与群组"唯一长标签"同一表达形式 */
function labelOf(target: RelayTarget): string {
	return target.domain ? `${target.name}${LONG_LABEL_SEP}${target.domain}` : target.name;
}

/**
 * 把模型给的 target 解析成一位执事（名字或 domain；重名不给猜）。
 *
 * 顺序即语义：
 *   1. `名字·domain` 长标签 → 名字与领域都要对上；
 *   2. 精确名字（在册且 active）→ 唯一通过、重名返回候选；
 *   3. 精确 domain（小写比较）→ domain 全局唯一，命中多个也不猜；
 *   4. 都不中 → missing，附现有执事清单（模型据此改口，不瞎试）。
 *
 * 排除项在**命中之后**判（总管 / 自己 / 非 active）：先让"重名 / 查无"暴露给模型，
 * 免得它以为自己是目标写错了名字。非 active 在候选集里就已滤掉，自然归到查无。
 */
export function resolveRelayTarget(
	raw: string,
	partners: PartnerRow[],
	selfId: string | null,
): RelayResolve {
	const wanted = String(raw ?? "").trim();
	if (!wanted) {
		return { ok: false, reason: "missing", message: "target 不能为空：写执事的名字或领域。" };
	}

	const active = partners.filter((partner) => partner.status === "active");

	// 1. 长标签 `名字·domain`
	const sep = wanted.indexOf(LONG_LABEL_SEP);
	if (sep > 0) {
		const name = wanted.slice(0, sep).trim();
		const domain = wanted.slice(sep + 1).trim().toLowerCase();
		const hit = active.find(
			(partner) =>
				partner.name === name &&
				(partner.domain ?? "").toLowerCase() === domain &&
				domain.length > 0,
		);
		if (hit) return guardTarget(toTarget(hit), selfId);
		// 长标签写错 = 不猜、不回退短名（与群组 @ 同一条纪律）
		return {
			ok: false,
			reason: "missing",
			message: `没有「${wanted}」这位执事（长标签是「名字·领域」）。现有执事：${listLabels(active)}`,
		};
	}

	// 2. 精确名字
	const byName = active.filter((partner) => partner.name === wanted);
	if (byName.length > 1) {
		const candidates = byName.map(toTarget);
		return {
			ok: false,
			reason: "ambiguous",
			message:
				`有 ${byName.length} 位执事都叫「${wanted}」，不猜是哪一个。` +
				`改用长标签重发：${candidates.map(labelOf).join(" / ")}`,
			candidates,
		};
	}
	if (byName.length === 1) return guardTarget(toTarget(byName[0]!), selfId);

	// 3. 精确 domain（小写）
	const lower = wanted.toLowerCase();
	const byDomain = active.filter((partner) => (partner.domain ?? "").toLowerCase() === lower);
	if (byDomain.length === 1) return guardTarget(toTarget(byDomain[0]!), selfId);
	if (byDomain.length > 1) {
		const candidates = byDomain.map(toTarget);
		return {
			ok: false,
			reason: "ambiguous",
			message: `领域「${wanted}」对上了多位执事，不猜。改用长标签：${candidates.map(labelOf).join(" / ")}`,
			candidates,
		};
	}

	// 4. 查无此人
	return {
		ok: false,
		reason: "missing",
		message: `没有叫「${wanted}」的执事。现有执事：${listLabels(active)}`,
	};
}

function listLabels(partners: PartnerRow[]): string {
	const labels = partners.map((partner) => labelOf(toTarget(partner)));
	return labels.length > 0 ? labels.join("、") : "（暂无执事）";
}

/** 命中后的排除项：总管 / 自己。放在最后一步，是为了让"重名候选"优先暴露给模型看。 */
function guardTarget(target: RelayTarget, selfId: string | null): RelayResolve {
	if (target.id === CHIEF_PARTNER_ID) {
		return {
			ok: false,
			reason: "chief",
			message: "总管不走执事间递话：他是主人这一侧，直接把话回给主人就行。",
		};
	}
	if (selfId && target.id === selfId) {
		return {
			ok: false,
			reason: "self",
			message: `「${target.name}」就是你自己。要给主人留话请直接在本轮说；要留笔记用 remember。`,
		};
	}
	return { ok: true, target };
}

// ── 正文包装（方案 §一.3）────────────────────────────────

export interface RelaySender {
	name: string;
	domain: string | null;
}

/**
 * 送达正文（逐字照方案 §一.3，hop 标记前置）。
 *
 * 三段各自的作用：
 *   - `[relay hop=1]`：一跳标记（转述检测 + 排障时一眼看出这条不是主人说的）；
 *   - `[来自执事 A（域）]`：B 知道是谁、属于哪块；
 *   - 末尾括注：主人看不到原文 → 该汇报就汇报，该走主人对话就走，不要指望 A 转达。
 */
export function relayBody(from: RelaySender, message: string): string {
	const domain = from.domain?.trim() || "无领域";
	return (
		`${RELAY_HOP_TAG}[来自执事 ${from.name}（${domain}）] ${message}\n` +
		"（这是执事间递话，主人看不到原文；需要主人知情或回话请用汇报或主人对话。）"
	);
}

/** 主人时间线上的那一条（正文不展示：只给"谁递给了谁"，点开 B 的会话看原文） */
export function relayNoticeText(from: RelaySender, to: RelayTarget): string {
	return `执事「${from.name}」→「${to.name}」：递了一条话（正文不在这里，点开「${to.name}」的会话可看）。`;
}

// ── 进程内状态：每 run 计数 / 递话触发的轮次标记 / 主人通知口 ──

/** run 身份键：与 turn-gate 的回合计数同一口径（`inputs[0] ?? taskId`，每轮都变） */
export function relayRunKey(
	conversationId: number,
	live: { run?: { inputs?: readonly unknown[]; taskId?: unknown } } | null | undefined,
): string {
	return `${conversationId}:${String(live?.run?.inputs?.[0] ?? live?.run?.taskId ?? "none")}`;
}

/** 每 run 已递条数（key = run 键） */
const relayUses = new Map<string, number>();
/** 会话 → 当前 run 键（由 beforeRequest 每次请求写入；beforeTool 据此判"是不是递话触发的轮"） */
const currentRun = new Map<number, string>();

/** 新 run 的第一步调用它：把上一轮的计数丢掉，避免 Map 随 run 数无限增长 */
export function beginRelayRun(conversationId: number, runKey: string): void {
	const previous = currentRun.get(conversationId);
	if (previous && previous !== runKey) relayUses.delete(previous);
	currentRun.set(conversationId, runKey);
}

/** 这个会话当前 run 的键（beforeRequest 已写过）；没有 = 还没跑过请求 */
export function currentRelayRunKey(conversationId: number): string | undefined {
	return currentRun.get(conversationId);
}

/** 取一个递话名额；返回 false = 这一轮已经到上限 */
export function takeRelaySlot(
	conversationId: number,
	runKey: string,
): { allowed: boolean; used: number } {
	beginRelayRun(conversationId, runKey);
	const used = relayUses.get(runKey) ?? 0;
	if (used >= RELAY_MAX_PER_RUN) return { allowed: false, used };
	const next = used + 1;
	relayUses.set(runKey, next);
	return { allowed: true, used: next };
}

/** 测试用：把计数清干净（生产没有"重开一轮"之外的入口） */
export function resetRelayState(): void {
	relayUses.clear();
	currentRun.clear();
	relayTriggered.clear();
	pendingRelay.clear();
}

/**
 * 递话触发的轮次（会话 → run 键）。
 *
 * 递送时先 `markRelayTarget`，目标的下一次 `beforeRequest` 把它认领到当前 run 键上；
 * beforeTool 据此摘掉 `send_to_agent` —— 这是"hop 恒为 1"的结构保证。
 */
const relayTriggered = new Map<number, string>();
/** 已提交、等下一轮认领的会话（一次性） */
const pendingRelay = new Set<number>();

/** 送达前调用（**先于 submit**：目标那一轮的第一个 beforeRequest 要读到它） */
export function markRelayTarget(sessionId: number): void {
	pendingRelay.add(sessionId);
}

/** 提交失败时撤销标记（否则下一个无关轮次会被误摘工具） */
export function clearRelayTarget(sessionId: number): void {
	pendingRelay.delete(sessionId);
}

/** 目标轮次开始时调用：认领一次性标记，返回这一轮是不是递话触发的 */
export function claimRelayTarget(sessionId: number): boolean {
	if (!pendingRelay.delete(sessionId)) return false;
	return true;
}

/** 把"这一轮是递话触发的"记在 run 键上（重复认领同一 run 时覆盖成同一个值） */
export function markRelayRun(sessionId: number, runKey: string): void {
	relayTriggered.set(sessionId, runKey);
}

/** 当前 run 是不是递话触发的（beforeTool 用来摘工具） */
export function isRelayRun(sessionId: number, runKey: string): boolean {
	return relayTriggered.get(sessionId) === runKey;
}

// ── 主人知情：进程内轻事件口（形态同 delegation 通道，不落盘）──
//
// 为什么不是"写给主对话一条消息"：那会伪造主人/助手说过的话，污染上下文；
// 为什么不是 per-conversation 的 emit：递话发生时不持有"主对话"的会话 id
// （主人的主对话可以有任意多条）。所以做成全局口，由**正在流式的主对话**认领。
const chiefNoticeSinks = new Set<(text: string) => void>();

export function watchChiefNotice(sink: (text: string) => void): () => void {
	chiefNoticeSinks.add(sink);
	return () => {
		chiefNoticeSinks.delete(sink);
	};
}

export function emitChiefNotice(text: string): void {
	for (const sink of chiefNoticeSinks) {
		try {
			sink(text);
		} catch {
			/* 订阅方异常不该影响递话 */
		}
	}
}

// ── 工具 ─────────────────────────────────────────────────

export interface RelayDeliverResult {
	ok: boolean;
	/** 递送这一刻对方是否正忙（忙 → followUp 排队；文案据此诚实说明） */
	busy?: boolean;
	error?: string;
}

export interface PartnerRelayDeps {
	/** 执事库；不传用全局 store（单测注入临时库） */
	store?: () => PartnersStore;
	/**
	 * 真正送达：把包装好的正文提交进目标执事的会话。
	 * 装配层（agent/lifecycle.ts）实现——它才持有 harness；本模块不 import agent/。
	 */
	deliver: (targetPartnerId: string, body: string) => Promise<RelayDeliverResult>;
}

/**
 * `send_to_agent`：执事 A 给执事 B 递一条话。
 *
 * 这里的 execute 只做业务校验（目标 / 转述 / 上限 / 送达）；"这一轮能不能用"由
 * lifecycle 的 beforeTool 结构性地拦（主人对话 / 群会话 / 自主轮 / 递话触发的轮）。
 * 两处都查，是因为闸门是安全边界，execute 只负责把话说清楚。
 */
export function createSendToAgentTool(deps: PartnerRelayDeps): ToolRegistration {
	const store = () => (deps.store ?? partnersStore)();

	return defineTool({
		name: RELAY_TOOL_NAME,
		description:
			"给另一位执事递一条话（只送到对方的会话里，主人看不到原文）。" +
			"适合：把自己查到的事交给对口的执事、跟对方对一下口径。" +
			"target 写执事的名字或领域；重名时用「名字·领域」。" +
			"一次只说一件事、一条话别拆成好几条（每轮最多 3 条）；" +
			"收到别人递来的话那一轮不能再往外递。",
		parameters: Type.Object({
			target: Type.String({ description: "执事的名字或领域（重名用「名字·领域」）" }),
			message: Type.String({
				description: `要递的话，用自己的话写，不超过 ${RELAY_MESSAGE_LIMIT} 字`,
			}),
		}),
		execute: async (args, api, context) => {
			const message = String(args.message ?? "").trim();
			if (!message) return text("message 不能为空。");
			if (message.length > RELAY_MESSAGE_LIMIT) {
				return text(
					`这条话 ${message.length} 字，超过 ${RELAY_MESSAGE_LIMIT} 字上限。压缩成要点再发，别整篇转贴。`,
				);
			}
			// 转述别人的递话 = 两跳（方案 §一.4 第一条）
			if (message.includes(RELAY_HOP_TAG)) {
				return text(
					"这条内容里带着别人递话的原文（hop 标记）。不要转述别人的递话——用自己的话说，或者直接回主人。",
				);
			}

			const db = store();
			const selfId = db.partnerIdOfSession(api.conversationId);
			const self = selfId ? db.get(selfId) : null;
			if (!selfId || !self) {
				return text("这个会话不属于任何执事，不能递话。");
			}

			const resolved = resolveRelayTarget(args.target, db.list(), selfId);
			if (!resolved.ok) return text(resolved.message);

			// 每 run 上限：run 身份与 turn-gate 同源（beforeRequest 写的 `inputs[0] ?? taskId`）
			const live = await api.snapshot(LiveDoc, api.conversationId, context);
			const runKey =
				currentRelayRunKey(Number(api.conversationId)) ?? relayRunKey(Number(api.conversationId), live);
			const slot = takeRelaySlot(Number(api.conversationId), runKey);
			if (!slot.allowed) return text(relayCapMessage());

			const from: RelaySender = { name: self.name, domain: self.domain };
			const delivered = await deps.deliver(resolved.target.id, relayBody(from, message));
			if (!delivered.ok) {
				return text(`没递出去：${delivered.error ?? "未知原因"}`);
			}

			// 主人知情（方案 §一.6）：只报"谁 → 谁"，不递原文
			emitChiefNotice(relayNoticeText(from, resolved.target));

			// 大实话：对方正忙时这条排在它本轮之后，不是"已经读了"
			const when = delivered.busy ? "对方正在忙，这条排在它本轮之后" : "对方空闲，已开始看";
			return text(
				`已递给「${resolved.target.name}」（${when}）。` +
					"主人那边只会看到一条通知、看不到原文；需要主人知道的事，你自己也要在回复里说。",
			);
		},
	});
}

function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}
