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

import path from "node:path";
import type { DelegationPhase } from "@lifediary/shared";
import type {
	ChancellorEvent,
	ChancellorRequest,
	TicketResult,
} from "../../../../../chancellor/src/index.ts";
import type { ProjectRef } from "./projects.ts";

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
	  };

export interface DelegationReport {
	ticketId: string;
	domain: string;
	phase: DelegationPhase;
	/** 写回会话的一行话，已截断到 80 字 */
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
	/** `DELEGATION_AUTO_REPORT`，默认 true */
		autoReport: boolean;
		/**
		 * 装配/测试缝（批次D D2）：按 domain 反查执事身份。不传 = 不注入身份
		 * （旧领域、远程锚点会话、以及单元测试都走这条）。只有**本机** delegate 工具装配它，
		 * 这样「不做跨电脑执事」由装配层保证，内核不查执事库、不在禁用执事时建库。
		 */
		identityHitFor?: (domain: string) => { name: string; soul: string } | null;
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
}

/**
 * chancellor 的任务单落在哪。默认沿用它的 `process.cwd()/runs`；
 * 服务端和只读接口必须读同一个位置，所以用同一个入口。
 */
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

// ── 全局事件口（2026-11-05 批次B B3）：例行任务引擎的触发源 ──
// 跨会话广播，不落盘、不重放；订阅方（routines/观察层）异常绝不影响派活主链路。
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

/** 压成一行再按字数截断；派活汇报与恢复回灌共用（2026-11-04）。 */
export function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** 注入给 chancellor 的宰相身份正文上限（批次D D2）：宿主侧按 UTF-8 字节截断，chancellor 只透传。 */
export const MANAGER_SOUL_LIMIT_BYTES = 4 * 1024;

/**
 * 纯函数：把按 domain 命中的执事组装成 ChancellorRequest.managerIdentity。
 * 没命中（旧领域 / 执事库不可用）返回 undefined —— 请求不带身份，行为与改动前一致。
 * soul 取调用方给的**当前版本快照正文**（不读磁盘当前值），按字节截到 ≤4KB、不切坏多字节字符。
 * 抽成导出的纯函数是为了单测能直接断言组装结果，不必起服务。
 */
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

/** 结论怎么写成会话里那一行。80 字上限是方案里定的。 */
export function formatReport(
	result: TicketResult,
	domain: string,
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
				? `有一项需要你处理：${result.attention?.question ?? result.line}`
				: phase === "aborted"
					? `已中断：${result.line}`
					: `未完成：${result.line}`;
	return {
		ticketId: result.ticketId,
		domain,
		phase,
		text: truncate(`${head}${body}`, 80),
	};
}

/**
 * 立即受理：同步返回任务单号，后台跑完再发事件/汇报。
 *
 * 为什么能同步拿到单号：`runChancellor` 在第一次 `await` 之前就会发出
 * `ticket`（v0.3 路径）或 `manager`（分管路径）事件，两张都带 `ticketId`。
 * 所以这里不需要改 chancellor 的契约，也不需要预生成单号。
 */
export function startDelegation(
	kick: DelegationKickoff,
	runtime: DelegationRuntime,
): {
	ticketId: string;
	outcome: Promise<TicketResult>;
	/** 续跑被拒、已改派新单（单号对不上，不能当成续跑成功）。 */
	fellBack: boolean;
} {
	let ticketId = "";
	let total = 0;
	let done = 0;
	let current = "";
	let settled = false;

	const projectName = kick.project?.name || kick.project?.id;
	// 身份在派单开始时取一次快照，两次 launch（含续跑失败回退）共用同一个值：
	// 单次派单内不变，不与「改 SOUL 下一轮生效」的版本化语义打架。
	const managerIdentity = kick.domain
		? buildManagerIdentity(runtime.identityHitFor?.(kick.domain) ?? null)
		: undefined;
	const emitProgress = (phase: DelegationPhase, next?: string, waitingOn?: string): void => {
		if (next !== undefined) current = next;
		// 单号还没出来时先不发：前端要靠 ticketId 归并，发空号只会多一条噪声。
		if (!ticketId) return;
		runtime.emit(kick.conversationId, {
			type: "delegate",
			ticketId,
			domain: kick.domain,
			phase,
			done,
			total,
			current,
			lastAction: current,
			lastHeartbeat: new Date().toISOString(),
			...(projectName ? { project: projectName } : {}),
			...(waitingOn ? { waitingOn } : {}),
		});
	};

	const translate = (event: ChancellorEvent): void => {
		if (event.ticketId && !ticketId) ticketId = event.ticketId;
		switch (event.type) {
			case "ticket":
				emitProgress("accepted", event.message ?? "已受理");
				break;
			case "manager":
				emitProgress("planning", "领域负责人接手");
				break;
			case "planned":
				total = event.total ?? total;
				emitProgress("running", "拆好了，开始派");
				break;
			case "task-start":
				emitProgress("running", event.slug ?? current);
				break;
			case "task-done":
				done += 1;
				emitProgress("running", event.slug ?? current);
				break;
			case "task-waiting":
				// 租约没拿到：任务没启动，不算完成；把等待对象带给前端。
				emitProgress("running", event.message ?? current, event.waitingOn);
				break;
			case "reviewing":
				emitProgress("reviewing", "核对");
				break;
			case "goal":
				emitProgress("reviewing", "核对结论");
				break;
			default:
				break;
		}
	};

	const settle = (result: TicketResult): void => {
		if (settled) return;
		settled = true;
		ticketId = result.ticketId || ticketId;
		const report = formatReport(result, kick.domain);
		runtime.emit(kick.conversationId, {
			type: "delegate",
			ticketId,
			domain: kick.domain,
			phase: report.phase,
			done,
			total,
			current: "",
			lastAction: result.line,
			lastHeartbeat: new Date().toISOString(),
			...(projectName ? { project: projectName } : {}),
			message: result.line,
		});
		if (result.attention) {
			runtime.emit(kick.conversationId, {
				type: "attention",
				ticketId,
				domain: kick.domain,
				kind: result.attention.kind,
				question: result.attention.question,
			});
		}
		// idle = 父单还有子任务没终态，或等下一个触发：只更新事件，不汇报。
		if (runtime.autoReport && runtime.report && result.status !== "idle") {
			runtime.report(kick.conversationId, report);
		}
	};

	const fail = (error: unknown, fallbackTicketId: string): void => {
		if (settled) return;
		settled = true;
		ticketId = ticketId || fallbackTicketId;
		const line = error instanceof Error ? error.message : String(error);
		// 原始错误只进服务端日志：可能带上游地址甚至 key 片段。
		runtime.log?.(`[delegate] 失败: ${line}`);
		runtime.emit(kick.conversationId, {
			type: "delegate",
			ticketId: ticketId || "(未受理)",
			domain: kick.domain,
			phase: "failed",
			done,
			total,
			current: "",
			message: "派单失败，请稍后再试",
		});
		if (runtime.autoReport && runtime.report) {
			runtime.report(kick.conversationId, {
				ticketId: ticketId || "(未受理)",
				domain: kick.domain,
				phase: "failed",
				text: truncate(
					`【任务 ${ticketId || "未受理"}${kick.domain ? ` · ${kick.domain}` : ""}】派单失败，请稍后再试`,
					80,
				),
			});
		}
	};

	const launch = (request: ChancellorRequest): { id: string; promise: Promise<TicketResult> } => {
		const promise = runtime.run(request, { onEvent: translate });
		// 这里必须同步读：run 的同步段已经把单号发出来了。
		return { id: ticketId, promise };
	};

	const projectField = kick.project ? { project: kick.project } : {};
	const idempotency = kick.requestId ? { idempotencyKey: kick.requestId } : {};
	const first = launch(
		kick.resumeTicketId
			? { resumeTicketId: kick.resumeTicketId, answer: kick.requirement }
			: {
				requirement: kick.requirement,
				...(kick.domain ? { domain: kick.domain } : {}),
				...(managerIdentity ? { managerIdentity } : {}),
				...projectField,
				...idempotency,
				// 来源对话只透传（2026-11-05 跨仓契约）：chancellor 落 ticket.json，
				// 子单从父单继承；这里给内部会话 id 的字符串形式，接口层再换对外 uuid。
				originConversationId: String(kick.conversationId),
			},
	);
	let accepted = first;
	let fellBack = false;
	if (kick.resumeTicketId && first.id === "") {
		// 续跑在派活之前就被拒了（单子已完成/找不到）：没有可续的单，按新活派。
		// 拒跑之前不会动 worker，所以不会和原单抢同一个屏幕。
		fellBack = true;
		first.promise.catch(() => undefined);
		accepted = launch({
			requirement: kick.requirement,
			...(kick.domain ? { domain: kick.domain } : {}),
			...(managerIdentity ? { managerIdentity } : {}),
			...projectField,
			...idempotency,
			originConversationId: String(kick.conversationId),
		});
	}

	accepted.promise.then(settle).catch((error: unknown) => fail(error, accepted.id));

	return { ticketId, outcome: accepted.promise, fellBack };
}
