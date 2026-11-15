/**
 * 派活的进度与「需要你」事件（2026-11-02；2026-11-03 补异步任务单字段）。
 *
 * 为什么单独一个模块：发事件的是工具（`tools.ts` 里的 `delegate`），
 * 收事件的是对话流（`agent.ts` 的 `chatStream`）。这两个文件本来就互相引用，
 * 再把通道塞进其中一边就会成环。放中间，两边都只依赖它。
 *
 * 2026-11-03：派单改成"立即受理、后台执行"。`startDelegation` 是这一段的最小骨架：
 * 同步返回任务单号，后台跑完再发事件 / 写汇报。真正的进程管理仍然在 chancellor 里。
 *
 * 2026-11-04：审批事件**借道本通道**（`type: "approval"`），因为它与派活同样是
 * "工具钩子写、对话流读"的一对多通道。只是借传输，与派活语义无关。
 */

import { ChancellorEvent, ChancellorRequest, TicketResult } from "../../../../../chancellor/src/index.ts";
import { TAKEOVER_HINT } from "./agent/turn-gate.ts";
import type { DelegationSenderKind } from "./delegation-messages.ts";
import { CHIEF_PARTNER_ID } from "./partners.ts";
import { ProjectRef } from "./projects.ts";
import { taskConversationExternalId } from "./task-conversation.ts";
import { WorkSettlementInput } from "./work-record.ts";
import { DelegationPhase } from "@lifediary/shared";
import path from "node:path";

export type DelegationEvent =
	/** 进度：这张单在哪个阶段、办到第几件、共几件、这件叫什么 */
	| {
			type: "delegate";
			ticketId: string;
			domain: string;
			phase: DelegationPhase;
			done: number;
			total: number;
			current: string;
			message?: string;
			/** 项目名；没有项目的旧链路为空。 */
			project?: string;
			/** 最近一次动作，和 current 同源，但读接口按这个口径展示。 */
			lastAction?: string;
			/** 发事件这一刻的心跳；客户端据此判断「还活着」。 */
			lastHeartbeat?: string;
			/** 等文件租约时被谁卡住。 */
			waitingOn?: string;
	  }
	/** 需要人：一个问题，不是一句「出错了」 */
	| {
			type: "attention";
			ticketId: string;
			domain: string;
			kind: "need_input" | "need_decision" | "need_action";
			question: string;
	  }
	/** 写类工具要人确认（2026-11-04 批次二）；借本通道传输，与派活无关 */
	| {
			type: "approval";
			callId: string;
			tool: string;
			args: string;
			deadlineAt: string;
			/** 自主轮标记（批次C C2）：例行轮的审批卡，纯增量字段 */
			origin?: "autonomous";
	  }
	/**
	 * agent 中途播报（2026-11-10 批 13 §三，`report_progress`）。
	 *
	 * 只借本通道送到**正在流式的那条会话**（conversationId 就是发射方），
	 * 与派活进度同款：进程内轻事件，没开流就收不到、不落盘。
	 */
	| { type: "notice"; text: string };

export interface DelegationReport {
	ticketId: string;
	domain: string;
	phase: DelegationPhase;
	/** 写回会话的一行话，已截断到 80 字 */
	text: string;
	/**
	 * 产物目录指针（批 31 痕迹协作补课）：`result.tasks[].dir`，最多 3 个，与
	 * work 履历同口径。**只进唤醒提示词**（delegation-wake.ts 渲染成"落点"行），
	 * 汇报正文与镜像不动；没有任务目录的旧结果缺省无此字段。
	 */
	productDirs?: string[];
	/**
	 * 失败回执的可续接信息（2026-11-13 工具层结果契约化批次二，ZCode 教训 §1.4：
	 * 父模型拿不到 agentId，跑几十步的子代理无法续接）。只在 phase = failed / aborted 时带：
	 * - id：子单号（uuid），GET /api/v1/tickets/:id 可查，父模型可据此查进度 / 续派；
	 * - conversationId：子单任务专线会话的对外 id（`task-<id>`，确定性；未建过时读详情
	 *   自然 404，不拉 harness）——续接这个会话就能看到子代理已跑出的过程；
	 * - partialReport：失败前的最后一行结论（已折行、截到 160 字），交接信息与错误对象分离。
	 * 交接信息（给模型）与错误对象（给系统）分离：UI / 事件流不多字段，旧客户端忽略即可
	 * （回执 JSON 旧字段只增不改，手机端零改动）。
	 */
	resume?: {
		id: string;
		conversationId: string;
		partialReport: string;
	};
	/**
	 * 送达记账行 id（2026-11-15 回信送达兜底，方案 §A）：settle 落 in 留言时的
	 * delegation_messages 自增 id。reportDelegationResult 写回成功销 1、会话已
	 * 不存在销 2、写回异常留 0（启动补送兜底）。缺省 = 这份汇报没有待送达行
	 * （fail 路径 / 重试直报），不参与记账。服务端内部字段，不进对外契约。
	 */
	deliveryMessageId?: number;
}

export interface DelegationMirrorEntry {
	kind: "notice" | "report" | "message";
	text: string;
}

export interface DelegationRuntime {
	/** 真正跑 chancellor 的入口；测试可替换 */
	run: (
		request: ChancellorRequest,
		options: { onEvent?: (event: ChancellorEvent) => void },
	) => Promise<TicketResult>;
	emit: (conversationId: number, event: DelegationEvent) => void;
	/** 后台跑完后回灌会话；不传 = 不汇报 */
	report?: (conversationId: number, report: DelegationReport) => void;
	/**
	 * 任务专线会话的双写缝（2026-11-08 扫尾批 8g）。
	 *
	 * 推送时机与 `emit` / `recordMessage` / 终局汇报完全一致（同步调用、同步入队），
	 * 所以专线里的条目顺序 = 事件顺序。不传 = 只写留言表（单测与旧装配零改动）。
	 */
	mirror?: (ticketId: string, entry: DelegationMirrorEntry) => void;
	/** `DELEGATION_AUTO_REPORT`，默认 true */
		autoReport: boolean;
		/**
		 * 装配/测试缝（批次D D2）：按 domain 反查执事身份。不传 = 不注入身份
		 * （旧领域、远程锚点会话、以及单元测试都走这条）。只有**本机** delegate 工具装配它，
		 * 这样「不做跨电脑执事」由装配层保证，内核不查执事库、不在禁用执事时建库。
		 */
		identityHitFor?: (domain: string) => { name: string; soul: string } | null;
		/**
		 * 作废位查询（2026-11-07 扫尾批 1 A1）：单子被取消后，进度与终局都不再外发/回写。
		 * 不传 = 没有作废概念（单测与旧调用方零改动）。由装配层读 delegations 库现查，
		 * 这样取消发生后哪怕单子还在后台跑，也能立刻静默。
		 */
		isCanceled?: (ticketId: string) => boolean;
		/**
		 * 终态结算落一条 work 履历（2026-11-08 刀二 E2）。只在真终态调一次：
		 * done / failed / aborted / canceled；needs_you / idle 是中间态，不落账。
		 * 不传 = 不落账（单测与旧调用方零改动）。由装配层注入，内核不碰记忆库。
		 */
		recordWork?: (input: WorkSettlementInput) => void;
		/**
		 * 续跑前的授权重验（2026-11-10 批 19 §六）：按单号读受理回执里的审批档位。
		 * 不传 = 不重验（单测与旧调用方零改动）。
		 */
		authorityAtAccept?: (ticketId: string) => string | null;
		/** 现在的审批档位（`ask-all` / `ask-critical` / `none`）；不传 = 读不到，按更严处理。 */
		approvalLevelNow?: () => string | null;
		log?: (line: string) => void;
	}

export interface DelegationKickoff {
	conversationId: number;
	/** 领域负责人；空串表示按 v0.3 直接派 worker（兼容旧行为） */
	domain: string;
	requirement: string;
	/** 这张单落在哪个已登记项目里（2026-11-03 方案 §5.5）；续跑时沿用原单 */
	project?: ProjectRef;
	/** 有值 = 续跑这张单；没有 = 新派 */
	resumeTicketId?: string;
	/** 幂等键；回执先落再入队，重启后同 id 只返回原单号。 */
	requestId?: string;
	/**
	 * 硬开关（2026-11-07 执事直派）：false 时 chancellor 忽略 domain，绝不建分管宰相。
	 * 只由"执事在自己领域内派活"这一条路由设置——他本来就是该领域的负责人，
	 * 再起一个分管等于把同一身份跑两遍。缺省 = 走既有分管路径。
	 */
	managers?: false;
	/**
	 * 这条派活是谁说的（2026-11-07 派活留言）。
	 *
	 * 只用于**旁路簿记**：派单落一条"来自 X · 时间 · 原文"的留言，让任务详情
	 * 能回答"谁让我干这个"。不影响派单语义，也不改 chancellor 的任何输入。
	 * 缺省 = 不记留言（单测与旧调用方零改动）。
	 */
	sender?: { kind: DelegationSenderKind; name: string };
	/**
	 * 计划附件（2026-11-09 保证实现纵深 §2）：这条要求拆成的可核对动作序列。
	 * 已由 `normalizeDelegationSteps` 校验；缺省 = 旧行为（不落字段、不进提示词）。
	 */
	steps?: string[];
	/**
	 * 只续跑、不许改派（2026-11-08 扫尾批 8g 任务回话）。
	 *
	 * `delegate` 工具的既有语义是"续跑被拒就按新活派"；任务详情里的回话不能这样——
	 * 主人是回答这张单，不是让总管重开一件。true 时续跑在派活前被拒就只返回
	 * `fellBack=true`，不建新单（调用方据此提示"这单已经不在等回答"）。
	 */
	resumeOnly?: boolean;
	/**
	 * 不把 out 留言再镜像进专线（2026-11-08 扫尾批 8g）。
	 *
	 * 任务详情的回话已经以**用户条目**写进专线了，续跑时再镜像一条 `【留言】主人：…`
	 * 等于同一句话出现两次。留言表照写（过渡期兜底视图），只跳过会话镜像。
	 */
	skipMessageMirror?: boolean;
}

export function chancellorWorkRoot(): string {
	const configured = process.env.CHANCELLOR_WORK_ROOT?.trim();
	return path.resolve(configured || path.join(process.cwd(), "runs"));
}

type Sink = (event: DelegationEvent) => void;

const sinks = new Map<number, Set<Sink>>();

export function watchDelegation(conversationId: number, sink: Sink): () => void {
	let set = sinks.get(conversationId);
	if (!set) {
		set = new Set();
		sinks.set(conversationId, set);
	}
	set.add(sink);
	return () => {
		set.delete(sink);
		if (set.size === 0) sinks.delete(conversationId);
	};
}

const delegationSinks = new Set<(event: DelegationEvent, conversationId: number) => void>();

export function watchAllDelegationEvents(
	sink: (event: DelegationEvent, conversationId: number) => void,
): () => void {
	delegationSinks.add(sink);
	return () => delegationSinks.delete(sink);
}

export function emitDelegation(conversationId: number, event: DelegationEvent): void {
	for (const sink of delegationSinks) {
		try {
			sink(event, conversationId);
		} catch {
			/* 订阅方异常不该影响派活 */
		}
	}
	const set = sinks.get(conversationId);
	if (!set) return;
	for (const sink of set) {
		try {
			sink(event);
		} catch {
			/* 订阅方异常不该影响派活 */
		}
	}
}

export function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export const DELEGATION_STEPS_MAX = 12;

export const DELEGATION_STEP_MAX_CHARS = 200;

export function normalizeDelegationSteps(
	raw: unknown,
): { ok: true; steps?: string[] } | { ok: false; message: string } {
	if (raw === undefined || raw === null) return { ok: true };
	if (!Array.isArray(raw)) return { ok: false, message: "steps 必须是字符串数组" };
	if (raw.length === 0) return { ok: true };
	if (raw.length > DELEGATION_STEPS_MAX) {
		return { ok: false, message: `steps 最多 ${DELEGATION_STEPS_MAX} 条（当前 ${raw.length}）` };
	}
	const steps: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") return { ok: false, message: "steps 每一项都必须是字符串" };
		const text = item.trim();
		if (!text) return { ok: false, message: "steps 里不能有空步骤" };
		if (text.length > DELEGATION_STEP_MAX_CHARS) {
			return {
				ok: false,
				message: `每条步骤最多 ${DELEGATION_STEP_MAX_CHARS} 字（当前 ${text.length}）`,
			};
		}
		steps.push(text);
	}
	return { ok: true, steps };
}

export const ATTENTION_REPLY_GUIDANCE = [
	"工人回报「需要你」（need_input / need_decision / need_action）时：",
	"- 答得了就直接答（缺什么信息就补什么，要主人拍板的就明确说是哪一项）。",
	"- 一时答不了，就明确告诉工人：「这一项先跳过，继续其余部分，这项回头再补」——不要让整单停在这一项上，也不要自己猜一个答案糊过去。",
].join("\n");

export const ATTENTION_ONE_QUESTION = [
	"【提问纪律】",
	"- 一次只问一个具体问题，别把三个问题塞进一段话。",
	"- 问题要点名对象与期望：「第 2 条的标题你想要哪种：A / B」，不要问「这样可以吗」。",
	"- 问题若是因为某条消息 / 某个文件引起的，点名那条消息或文件，别让人自己去回忆。",
].join("\n");

export const WORK_REVIEW_GUIDANCE = [
	"按周期盘点自己干过的活时：读自己的 work 工作履历，用一段自然语言说清这一阵子",
	"接了几单、成了几单、哪一单卡过、有什么该记取的教训（不打分、不列 KPI 数字）；",
	"把这段总结用 remember 落一条 kind=episode 的记忆，再向主人汇报。",
	"不要自己悄悄创建回顾规则——要主人配，或主人说一句你再用 routine_manage 建。",
].join("\n");

export const REPORT_FOUR_LINES = [
	"状态：完成 / 部分完成 / 卡住",
	"结果：一句话说清做成了什么（不是过程）",
	"证据：拿什么证明的（改了哪个文件 / 跑了什么命令 / 看到什么输出）",
	"解锁：卡住时，下一步需要谁做什么；没卡住就写「无」",
].join("\n");

export const WORK_SILENCE_DISCIPLINE = [
	"【干活期间】",
	"- 接单确认只发一次，点名说清要干什么；之后干活期间不说话（不播报「我正在…」）。",
	"- 再开口只有三种情况：有结果了 / 需要人做决定 / 干不完要交代。",
	"- 交付物必须自己带着验收证据：改了哪个文件、跑了什么、看到什么。没有证据的「做完了」不算完成。",
].join("\n");

export const GROUNDING_DISCIPLINE = [
	"【答案接地】",
	"- 汇报里的数值、日期、引文，必须真的能在记忆 / transcript / 文件里查到；查不到就不写。",
	"- 说「你上次说过 X」之前，先用 recall 或 recall_sessions 确认 X 真的存在。",
	"- 查不到就说「我记不清了」，不要编；宁可少说一句，不要补一个像真的细节。",
].join("\n");

export const CLARIFY_CONTRACT = [
	"【开工前先问清】",
	"- 大活（要改 3 个以上文件 / 要跑命令 / 涉及不可逆操作）开工前，先用 ask_user 确认三件事：",
	"  ① 对象是什么（哪个文件 / 哪个 App / 哪段时间）② 你期望的结果长什么样 ③ 怎么算做好了。",
	"- 一次只问一个，别把三个问题塞进一次；上一问答完再问下一句。",
	"- 小活不问（一句话能答的、单文件小改）——问多了是骚扰。",
].join("\n");

export function clarifyContractEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.AGENT_CLARIFY_CONTRACT ?? "").trim().toLowerCase();
	if (!raw) return true;
	return !["false", "0", "off"].includes(raw);
}

export function clarifyContractFor(partnerId: string | null): string | undefined {
	if (!clarifyContractEnabled()) return undefined;
	if (partnerId && partnerId !== CHIEF_PARTNER_ID) return undefined;
	return CLARIFY_CONTRACT;
}

export const MANAGER_SOUL_LIMIT_BYTES = 4 * 1024;

export function buildManagerIdentity(
	hit: { name: string; soul: string } | null | undefined,
): { name: string; soul: string } | undefined {
	if (!hit) return undefined;
	return { name: hit.name, soul: truncateUtf8(hit.soul, MANAGER_SOUL_LIMIT_BYTES) };
}

function truncateUtf8(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let end = maxBytes;
	// 回退到不切断 UTF-8 多字节序列的边界（续字节 10xxxxxx 一律往回让）。
	while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return buf.subarray(0, end).toString("utf8");
}

export function formatReport(
	result: TicketResult,
	domain: string,
	options: {
		/**
		 * 同类失败连击已达阈值（2026-11-10 批 12 §一.4）：在 needs_you 那行末尾
		 * 追加接管建议。默认 false，旧调用方逐字节不变。
		 */
		takeover?: boolean;
	} = {},
): DelegationReport {
	const phase: DelegationPhase =
		result.status === "done"
			? "done"
			: result.status === "needs_you"
				? "needs_you"
				: result.status === "aborted"
					? "aborted"
					: "failed";
	const head = `【任务 ${result.ticketId}${domain ? ` · ${domain}` : ""}】`;
	const body =
		phase === "done"
			? `已完成：${result.line}`
			: phase === "needs_you"
				? `有一项需要你处理：${result.attention?.question ?? result.line}${
						options.takeover ? `（${TAKEOVER_HINT}）` : ""
					}`
				: phase === "aborted"
					? `已中断：${result.line}`
					: `未完成：${result.line}`;
	// 可续接信息（2026-11-13 批次二）：只挂在失败 / 中断单上；成功与 needs_you 不带（验收口径）。
	const resume =
		phase === "failed" || phase === "aborted"
			? {
					id: result.ticketId,
					conversationId: taskConversationExternalId(result.ticketId),
					partialReport: truncate(result.line, 160),
				}
			: undefined;
	return {
		ticketId: result.ticketId,
		domain,
		phase,
		text: truncate(`${head}${body}`, 80),
		...(result.tasks?.some((task) => task.dir)
			? { productDirs: result.tasks.map((task) => task.dir).filter(Boolean).slice(0, 3) }
			: {}),
		...(resume ? { resume } : {}),
	};
}

const PROGRESS_LABEL: Partial<Record<DelegationPhase, string>> = {
	accepted: "已受理",
	planning: "规划中",
	running: "进行中",
	reviewing: "核对中",
};

export function formatProgressLine(input: {
	phase: DelegationPhase;
	done: number;
	total: number;
	current: string;
	waitingOn?: string;
}): string {
	const label = PROGRESS_LABEL[input.phase] ?? input.phase;
	const count = input.total > 0 ? `（${input.done}/${input.total}）` : "";
	const waiting = input.waitingOn ? `，等 ${input.waitingOn}` : "";
	return `【进度】${label}：${input.current || "…"}${count}${waiting}`;
}

export function formatMessageLine(name: string, body: string): string {
	return `【留言】${name}：${body}`;
}

export { PROGRESS_LABEL, delegationSinks, sinks, truncateUtf8 };
export type { Sink };
