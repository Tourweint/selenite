/**
 * delegation-start-delegation
 *
 * 2026-11-14 从 delegation.ts 的 L532–L895 整段切出；正文原文搬运，未改一行实现。
 * 内含：startDelegation
 */

import { ChancellorEvent, ChancellorRequest, TicketResult } from "../../../packages/chancellor/src/index.ts";
import type { EmployeeProfile } from "../../../packages/chancellor/src/types.ts";
import { TAKEOVER_HINT } from "./agent/turn-gate.ts";
import { authorityRecheckEnabled, recheckAuthority } from "./delegation-authority.ts";
import { executorForDelegation, type ExecutorKind } from "./executor-config.ts";
import type { DelegationSenderKind } from "./delegation-messages.ts";
import { delegationMessages } from "./delegation-messages.ts";
import { failureStreak, takeoverHintEnabled } from "./failure-streak.ts";
import { noteWorkSettlementForConversation } from "./partner-living.ts";
import { WorkStatus } from "./work-record.ts";
import { DelegationPhase } from "@lifediary/shared";
import { buildManagerIdentity, formatMessageLine, formatProgressLine, formatReport, truncate } from "./delegation-delegation-kickoff.ts";
import type { DelegationKickoff, DelegationReport, DelegationRuntime } from "./delegation-delegation-kickoff.ts";

export function startDelegation(
	kick: DelegationKickoff,
	runtime: DelegationRuntime,
): {
	ticketId: string;
	outcome: Promise<TicketResult>;
	/** 续跑被拒、已改派新单（单号对不上，不能当成续跑成功）。 */
	fellBack: boolean;
	/** 新单实际用的执行器（2026-11-16）：续跑不返回，沿用原单。 */
	executor?: { employee: ExecutorKind; profile: EmployeeProfile };
} {
	let ticketId = "";
	let total = 0;
	let done = 0;
	let current = "";
	let settled = false;

	const projectName = kick.project?.name || kick.project?.id;
	// 身份在派单开始时取一次快照，两次 launch（含续跑失败回退）共用同一个值：
	// 单次派单内不变，不与「改 SOUL 下一轮生效」的版本化语义打架。
	// 直派（2026-11-07）不注入身份：调用者本人就是该领域的负责人，再注入等于叠两层。
	const managerIdentity =
		kick.domain && kick.managers !== false
			? buildManagerIdentity(runtime.identityHitFor?.(kick.domain) ?? null)
			: undefined;
	const emitProgress = (phase: DelegationPhase, next?: string, waitingOn?: string): void => {
		if (next !== undefined) current = next;
		// 单号还没出来时先不发：前端要靠 ticketId 归并，发空号只会多一条噪声。
		if (!ticketId) return;
		// 作废单点 2：已取消就不再转发进度事件（SSE 安静）。
		if (runtime.isCanceled?.(ticketId)) return;
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
		// 双写（8g）：同一刻、同一内容进专线会话，不额外合并进度。
		runtime.mirror?.(ticketId, {
			kind: "notice",
			text: formatProgressLine({ phase, done, total, current, ...(waitingOn ? { waitingOn } : {}) }),
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
			// worker 决策上报（2026-11-19 批2）：原样发到派活方会话出上报卡；
			// 路由（唤醒总管 / 升级用户 / 限流）由 escalation.ts 的全局订阅接手，
			// 这里只管"事件到会话"这一跳。
			case "escalation":
				if (event.escalation) {
					if (runtime.isCanceled?.(event.ticketId)) break;
					runtime.emit(kick.conversationId, {
						type: "escalation",
						ticketId: event.ticketId,
						domain: kick.domain,
						escalationId: event.escalation.escalationId,
						question: event.escalation.question,
						context: event.escalation.context,
						...(event.escalation.options && event.escalation.options.length > 0
							? { options: event.escalation.options }
							: {}),
						urgency: event.escalation.urgency,
					});
				}
				break;
			default:
				break;
		}
	};

	const settle = (result: TicketResult): void => {
		if (settled) return;
		settled = true;
		ticketId = result.ticketId || ticketId;
		// 终态结算（2026-11-08 刀二 E2）：真终态落一条 work 履历，settled 守卫保证一次。
		//
		// 放在作废位判断**之前**：取消 / 中止也要结算（终态=canceled / aborted）。
		// needs_you / idle 是"等回答 / 等子单"的中间态，不落账——否则续跑后会
		// 对同一单再落一条，违反"每单一条、终态写一次、中间态不写"。
		// 写失败只 warn，不影响结算主流程（recordWork 自身也兜了一层）。
		const canceled = runtime.isCanceled?.(ticketId) ?? false;
		const workStatus: WorkStatus | null = canceled
			? "canceled"
			: result.status === "done" || result.status === "failed" || result.status === "aborted"
				? result.status
				: null;
		if (workStatus && runtime.recordWork) {
			try {
				runtime.recordWork({
					ticketId,
					requirement: kick.requirement,
					status: workStatus,
					line: result.line,
					productDirs: (result.tasks ?? []).map((task) => task.dir).filter(Boolean),
					originConversationId: kick.conversationId,
					domain: kick.domain,
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[work] 履历落账异常（不影响结算）: ${detail.slice(0, 200)}`);
			}
			// 人格活模块（2026-11-15 批2）：连续两单失败 / 中止 → 心情低落（可见规则）。
			// 与履历落账同一处结算点、同一判据认执事；模块关着时内部直接返回。
			noteWorkSettlementForConversation(kick.conversationId, workStatus);
		}
		// 作废单点 1：已取消的单既不写回会话（不 recordMessage、不发 report），
		// 也不为它发任何事件（作废单点 4：SSE 不再为该单发事件）。
		// 执行端照常跑完、产物照常落盘——只是 harness 不再搬运结果。
		if (canceled) return;
		// 同类失败连击（2026-11-10 批 12 §一.4）：按来源（领域，无领域退回 worker）
		// 记连续失败，成功一次清零。取消是用户动作，不记（上面已 return）。
		// 只有 needs_you / failed / aborted 算失败；idle 是等子单的中间态，不记。
		const streakSource = kick.domain || "worker";
		let takeover = false;
		if (result.status === "done") {
			failureStreak().recordSuccess(streakSource);
		} else if (
			result.status === "needs_you" ||
			result.status === "failed" ||
			result.status === "aborted"
		) {
			const streak = failureStreak().recordFailure(
				streakSource,
				result.status === "needs_you" ? "needs_you" : "unresolved",
			);
			// 开关只决定"追不追加那句话"；连击记账照常（关掉后仍可在别处观察）。
			takeover = streak.suggestTakeover && takeoverHintEnabled();
		}
		const report = formatReport(result, kick.domain, { takeover });
		// 结论也落成一条留言：任务详情里 out / in 成对，读起来就是一段经过
		// 送达记账（2026-11-15 回信送达兜底）：in 行落库记"待送达"，行 id 随汇报
		// 交给 reportDelegationResult 销账；终态落盘到写回会话之间进程崩溃的话，
		// 这行就是启动补送的依据（方案 §A）。
		const deliveryMessageId = recordMessage(
			"in",
			result.line || report.text,
			{ kind: "system", name: "执行端" },
			ticketId,
			{ trackDelivery: true },
		);
		const reportWithDelivery: DelegationReport = {
			...report,
			...(deliveryMessageId ? { deliveryMessageId } : {}),
		};
		// 双写（8g）：REPORT 落 assistant 条目，语义 = 执行端向主人汇报。
		// 用完整的那句 result.line（留言表同源），不是 80 字截断的 report.text。
		runtime.mirror?.(ticketId, { kind: "report", text: `【汇报】${result.line || report.text}` });
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
				// 接管建议只追加在卡片文案末尾（批 12 §一.4.3）；问题原文不动。
				question: takeover
					? `${result.attention.question}\n${TAKEOVER_HINT}`
					: result.attention.question,
			});
		}
		// idle = 父单还有子任务没终态，或等下一个触发：只更新事件，不汇报。
		if (runtime.autoReport && runtime.report && result.status !== "idle") {
			runtime.report(kick.conversationId, reportWithDelivery);
		} else if (deliveryMessageId) {
			// 按设计没往宿主会话写汇报（idle 中间态 / autoReport 关 / 无 report 通道）：
			// 这不是"丢了"，销账为跳过，防止启动补送把设计内不发的汇报再发一遍。
			try {
				delegationMessages().markDelivery(deliveryMessageId, 2);
			} catch (error) {
				runtime.log?.(
					`[delegate] 送达销账失败（留 0，下次启动重扫）: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	};

	const fail = (error: unknown, fallbackTicketId: string): void => {
		if (settled) return;
		settled = true;
		// 续跑在派活前被拒时没有新单号；这时失败归属原单，不要发成「(未受理)」。
		ticketId = ticketId || kick.resumeTicketId || fallbackTicketId;
		const line = error instanceof Error ? error.message : String(error);
		// 原始错误只进服务端日志：可能带上游地址甚至 key 片段。
		runtime.log?.(`[delegate] 失败: ${line}`);
		// 终态结算（刀二 E2）：派单失败也是一条终态（failed）；没有单号就不记
		// （没有可归属的单）。作废单的失败照样结算，但终态按用户的取消记 canceled
		// （与 settle 口径一致）。结果行固定，不把原始错误写进履历（日志纪律）。
		const canceled = runtime.isCanceled?.(ticketId) ?? false;
		if (runtime.recordWork && ticketId) {
			try {
				runtime.recordWork({
					ticketId,
					requirement: kick.requirement,
					status: canceled ? "canceled" : "failed",
					line: "派单失败，请稍后再试",
					productDirs: [],
					originConversationId: kick.conversationId,
					domain: kick.domain,
				});
			} catch (recordError) {
				const detail = recordError instanceof Error ? recordError.message : String(recordError);
				console.warn(`[work] 履历落账异常（不影响结算）: ${detail.slice(0, 200)}`);
			}
			// 同一个结算点（2026-11-15 批2）：派单失败也参与"连续两单没成"的心情规则。
			noteWorkSettlementForConversation(kick.conversationId, canceled ? "canceled" : "failed");
		}
		// 作废单失败也保持静默：不往对话里发 failed 帧、不汇报。
		if (canceled) return;
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
		// 双写（8g）：失败也是一条单的动态，专线里要能看见（不含原始错误）。
		if (ticketId) {
			runtime.mirror?.(ticketId, { kind: "notice", text: "【汇报】派单失败，请稍后再试" });
		}
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

	let dispatchedExecutor: { employee: ExecutorKind; profile: EmployeeProfile } | null = null;

	const launch = (request: ChancellorRequest): { id: string; promise: Promise<TicketResult> } => {
		// 2026-11-16 多 CLI：每次派单懒读执行器设置，新单带上 employee / profile。
		// 续跑时 chancellor 按 ticket.employee 与原单快照走，这两个字段不会改派。
		const executor = executorForDelegation();
		// 2026-11-17：按单指定的权限档只覆盖**新单**；续跑沿用原单快照，不在这里改。
		const profile: EmployeeProfile =
			!request.resumeTicketId && kick.employeePermission
				? { ...executor.profile, permission: kick.employeePermission }
				: executor.profile;
		// 只有新单才把执行器回传给工具层；续跑沿用原单，不在结果里谎报当前默认。
		if (!request.resumeTicketId) dispatchedExecutor = { employee: executor.employee, profile };
		const promise = runtime.run(
			{
				...request,
				employee: executor.employee,
				employeeProfile: profile,
			},
			{ onEvent: translate },
		);
		// 这里必须同步读：run 的同步段已经把单号发出来了。
		return { id: ticketId, promise };
	};

	/**
	 * 记一条派活留言（2026-11-07）。
	 *
	 * 写失败**不挡派单**：留言是簿记，派单是主链路。丢了留言最多是任务详情少一段
	 * 来历，丢了一张单才是真事故。所以这里 catch 后只告警。
	 */
	const recordMessage = (
		direction: "out" | "in" | "system",
		body: string,
		sender?: { kind: DelegationSenderKind; name: string },
		ticket = ticketId,
		options: { trackDelivery?: boolean } = {},
	): number | undefined => {
		if (!sender || !ticket) return undefined;
		let rowId: number | undefined;
		try {
			rowId = delegationMessages().append(
				{
					ticketId: ticket,
					direction,
					fromKind: sender.kind,
					fromName: sender.name,
					body,
					createdAt: new Date().toISOString(),
				},
				// 送达记账（2026-11-15 回信送达兜底）：只有 settle 的结论文 in 行参与
				// 补送，落行时先记"待送达"；写回成功由 reportDelegationResult 销账。
				options.trackDelivery ? { delivered: 0 } : {},
			);
		} catch (error) {
			runtime.log?.(
				`[delegate] 留言落库失败（不挡派单）：${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// 双写（8g）：留言表之外同步抄一份进专线会话。
		// in 方向（settle 的结论文）由 REPORT 镜像覆盖，这里跳过，避免同一句话两份。
		if (direction !== "in" && !kick.skipMessageMirror) {
			runtime.mirror?.(ticket, {
				kind: "message",
				text: formatMessageLine(sender.name, body),
			});
		}
		return rowId;
	};

	const projectField = kick.project ? { project: kick.project } : {};
	const idempotency = kick.requestId ? { idempotencyKey: kick.requestId } : {};
	// 质检方式（2026-11-19 批2）：新派带进 ChancellorRequest（只影响新单）。
	// 懒读一次（executor-config 有 mtime 缓存）；launch() 里的 executor 读不受影响。
	const qaForNewTickets = executorForDelegation().qa;
	// 授权重验（批 19 §六）：续跑前把"受理时的审批档位"和"现在的档位"对一遍。
	// **不阻断**：更严 / 读不到都只记一行 warning；档位变了不是撤销授权。
	if (kick.resumeTicketId && authorityRecheckEnabled() && runtime.authorityAtAccept) {
		try {
			const check = recheckAuthority(
				runtime.authorityAtAccept(kick.resumeTicketId),
				runtime.approvalLevelNow?.() ?? null,
			);
			if (check.warning) {
				runtime.log?.(`${check.warning} ticket=${kick.resumeTicketId.slice(0, 12)}`);
			}
		} catch {
			// 回执 / 策略读取异常：不挡续跑；只记一句枚举式告警。
			runtime.log?.(
				`[delegate] 续跑授权重验读取失败（照常续跑） ticket=${kick.resumeTicketId.slice(0, 12)}`,
			);
		}
	}
	// 执事在自己领域内直派（2026-11-07）：managers:false 让 chancellor 不建分管宰相。
	// 递归在参数层断掉，不需要改跨仓契约。
	const managerSwitch = kick.managers === false ? { managers: false as const } : {};
	const first = launch(
		kick.resumeTicketId
			? { resumeTicketId: kick.resumeTicketId, answer: kick.requirement }
			: {
					requirement: kick.requirement,
					...(kick.domain ? { domain: kick.domain } : {}),
					...(managerIdentity ? { managerIdentity } : {}),
					...managerSwitch,
					...projectField,
					...idempotency,
					// 计划附件（2026-11-09 §2）：只有新派带；续跑沿用原单，不覆盖。
					...(kick.steps && kick.steps.length > 0 ? { steps: kick.steps } : {}),
					// 工作目录（2026-11-17）：只有新派带；续跑沿用原单快照。
					...(kick.workDir ? { workDir: kick.workDir } : {}),
					// 质检方式（2026-11-19 批2）：只有新派带；续跑沿用现状（内部请求）。
					...(qaForNewTickets === "qa-worker" ? { qaWorker: true } : {}),
					// 来源对话只透传（2026-11-05 跨仓契约）：chancellor 落 ticket.json，
					// 子单从父单继承；这里给内部会话 id 的字符串形式，接口层再换对外 uuid。
					originConversationId: String(kick.conversationId),
				},
	);
	let accepted = first;
	let fellBack = false;
	let dispatched = true;
	if (kick.resumeTicketId && first.id === "") {
		// 续跑在派活之前就被拒了（单子已完成/找不到）：没有可续的单，按新活派。
		// 拒跑之前不会动 worker，所以不会和原单抢同一个屏幕。
		fellBack = true;
		first.promise.catch(() => undefined);
		if (kick.resumeOnly) {
			// 任务回话（8g）：主人回答的是这张单，被拒就明确失败，绝不悄悄重开一件。
			dispatched = false;
		} else {
			accepted = launch({
				requirement: kick.requirement,
				...(kick.domain ? { domain: kick.domain } : {}),
				...(managerIdentity ? { managerIdentity } : {}),
				...managerSwitch,
				...projectField,
				...idempotency,
				...(kick.steps && kick.steps.length > 0 ? { steps: kick.steps } : {}),
				// 回退重派也是一张新单：工作目录照传。
				...(kick.workDir ? { workDir: kick.workDir } : {}),
				// 质检方式（批2）：回退重派同为新单，照带。
				...(qaForNewTickets === "qa-worker" ? { qaWorker: true } : {}),
				originConversationId: String(kick.conversationId),
			});
		}
	}

	// 派活留言（2026-11-07）：单号一确定就落一条"谁在什么时候说了什么"。
	// 放在 launch 之后而不是之前：ticketId 要等 chancellor 的同步段发出来才有值。
	if (kick.sender && !kick.resumeTicketId) {
		recordMessage("out", kick.requirement, kick.sender, accepted.id || ticketId);
	}
	if (kick.sender && kick.resumeTicketId) {
		// 续跑也是一句话：谁在回答、答了什么。方向仍是 out（从发出方看）。
		recordMessage(
			"out",
			`（回答上一轮的提问）${kick.requirement}`,
			kick.sender,
			accepted.id || ticketId,
		);
	}

	// resumeOnly 且续跑被拒：没有可结算的东西（没建新单，原单也不动），
	// 调用方从 `fellBack` 拿到结论自己提示；这里不再走 fail 的"派单失败"播报。
	if (dispatched) {
		accepted.promise.then(settle).catch((error: unknown) => fail(error, accepted.id));
	}

	return {
		ticketId,
		outcome: accepted.promise,
		fellBack,
		...(dispatchedExecutor ? { executor: dispatchedExecutor } : {}),
	};
}
