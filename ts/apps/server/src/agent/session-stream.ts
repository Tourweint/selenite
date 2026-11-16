/**
 * 流式对话（ChatStreamEvent / ChatStreamInput / chatStream / stopChat）
 *
 * 2026-11-13 从 session.ts 的 L573–L1111 整段切出；正文原文搬运，未改一行实现。
 */

import { approvalStore } from "../approvals.ts";
import { OutgoingPart } from "../attachments.ts";
import type { DelegationEvent } from "../delegation.ts";
import { watchDelegation } from "../delegation.ts";
import { watchChiefNotice, watchRelayReceipt } from "../partner-relay.ts";
import { CHIEF_PARTNER_ID, COMPANIONS_ENABLED, partnersStore } from "../partners.ts";
import { applyPartnerToolSelection } from "../partner-tools.ts";
import { noteSessionChatKind } from "../tool-visibility.ts";
import { describeStreamError } from "../stream-error.ts";
import { getHarness } from "./lifecycle.ts";
import type { ToolEvent, TurnPhase } from "./shared.ts";
import { CTX, ChatKinds, ResolvedChat, watchPhase, watchTool } from "./shared.ts";
import { TURN_LIMIT_MESSAGE, limitHits } from "./turn-gate.ts";
import { userInputSubmission } from "./user-input.ts";
import { contentText } from "@earendil-works/pi-ai";
import type { Conversation, ConversationView, LiveState, SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import { DelegationPhase, StreamErrorCode, TurnUsage } from "@lifediary/shared";
import { chatKindOfInternal, syncConversationModel } from "./session-open.ts";
import { answerText, logTurnUsage, readLastTurnUsage } from "./session-transcript.ts";

export type ChatStreamEvent =
	| { type: "delta"; text: string }
	/**
	 * 思考正文增量（2026-11-04 批次一）。
	 *
	 * `progress.phase=thinking` 只说"在想"，这个给"想了什么"：deep 档模型的
	 * thinking 块随生成流出，原样增量透传。快档不发这个事件。
	 */
	| { type: "thinking"; text: string }
	/**
	 * 这一轮此刻在干什么（2026-10-29）。
	 *
	 * 存在的理由：工具回合可能几十秒没有任何 token，客户端只看到"空白"，
	 * 用户不知道是卡死了还是在干活。这里把"思考 / 动手"这一层状态单独告诉客户端，
	 * 让它能显示"正在思考…"「正在读文件…」而不是干等。
	 */
	| { type: "progress"; phase: TurnPhase }
	/**
	 * 一次工具调用（2026-11-03）。
	 *
	 * 为什么 progress 不够：它只会说"在动手"，说不出动的是哪只手。
	 * 「正在读 agent.ts」和「正在跑 pnpm test」在界面上是两回事，出错时也完全
	 * 不同地处置。start / end 成对出现，中间可能夹着别的工具，客户端按 name 归并。
	 */
	| {
			type: "tool";
			name: string;
			status: "start" | "end";
			label?: string;
			ok?: boolean;
			/** 工具吐出来的文字（截断过），只在 end 上有 */
			output?: string;
			/** 调用参数（JSON，截断过），只在 start 上有 */
			args?: string;
			/** 编辑类工具的 unified diff（批 33，截断过），只在 end 上有；与历史 steps 同口径 */
			diff?: string;
	  }
	/**
	 * 派活的进度（2026-11-02；2026-11-03 补任务单字段）。
	 *
	 * 存在的理由跟 progress 一样：派活可能跑几分钟，客户端只看到空白。
	 * 但 progress 只有"在想/在动手"，说不出"第 2 件 / 共 3 件 / 写测试"。
	 *
	 * `ticketId` / `domain` / `phase` 是 2026-11-03 加的：前端要靠它们把多张单
	 * 分开归并、显示领域和阶段；没有单号时事件根本发不出来（见 `startDelegation`）。
	 */
	| {
			type: "delegate";
			ticketId: string;
			domain: string;
			phase: DelegationPhase;
			done: number;
			total: number;
			current: string;
			message?: string;
			project?: string;
			lastAction?: string;
			lastHeartbeat?: string;
			waitingOn?: string;
	  }
	/**
	 * 需要人回答（2026-11-02）。
	 *
	 * 一句话：「它在等你什么」。客户端据此出卡片，而不是让用户从结论那句里猜。
	 */
	| {
			type: "attention";
			ticketId: string;
			domain: string;
			kind: "need_input" | "need_decision" | "need_action";
			question: string;
	  }
	/**
	 * 写类工具要人确认（2026-11-04 批次二）。
	 *
	 * 与 attention 的分工：那个是任务单的问题，这个是权限确认；答复走 HTTP 审批端点，
	 * 不占用对话输入。`args` 已按 tool 事件口径截断。
	 */
	| {
			type: "approval";
			callId: string;
			tool: string;
			args: string;
			deadlineAt: string;
			/** 自主轮标记（批次C C2）：例行轮的审批卡；对外契约见 shared ChatEvent（纯增量） */
			origin?: "autonomous";
	  }
	| { type: "turnLimit"; message: string }
	/**
	 * 这一轮跑完了但没有回答（模型报错、被策略拦下等）。
	 *
	 * 必须显式吐出来：否则客户端只看到"空内容 + 正常结束"，等于给用户一个空气泡，
	 * 而且分不清是"模型没话说"还是"上游挂了"（实测：key 无效时就是这样）。
	 */
	| {
			type: "unanswered";
			message: string;
			/** 错误类别与脱敏摘要（2026-11-10 批 32）；index.ts 把它们透成 error 帧的 code/detail */
			code?: StreamErrorCode;
			detail?: string;
	  }
	/**
	 * 系统提示行（2026-11-07 消息即引导）。
	 *
	 * 只用于"这件事发生了变化但你不需要看模型说话"的时刻：插话请求落了队列、
	 * 补充已受理等。对外复用已有 `notice` 帧（群聊在用），不新增 SSE 类型。
	 * `steer` 是机器可读的插话落点（shared 契约），客户端据此决定要不要回读。
	 */
	| { type: "notice"; text: string; steer?: "inserted" | "new-turn" }
	/**
	 * 本轮 token 用量（2026-11-04 批次一）。**内部事件**：index.ts 捕获后挂到
	 * `done.usage` 上，不单独对外发帧——对外契约只加字段，不加类型。
	 */
	| { type: "usage"; usage: TurnUsage };

export interface ChatStreamInput {
	conversation: Conversation;
	text: string;
	/**
	 * 带图消息的分段（2026-11-08 扫尾批 4a）。有值就提交 parts（内核原生收
	 * `string | (TextContent|ImageContent)[]`），没有就仍提交 `text` 字符串。
	 * `text` 始终是"纯文本口径"，给记忆抽取、日志与回读用。
	 */
	parts?: OutgoingPart[];
	/** 客户端重试时带同一个 requestId，就不会重复扣 token、重复写记忆 */
	requestId?: string;
	/**
	 * 这一轮**真正结束**时回调（不是"这条连接结束"）。
	 *
	 * 关键区别：客户端关掉界面 / 断网，只是没人看这条流了，
	 * 那一轮还在服务端跑；它跑完才该触发记忆抽取、才该算数。
	 * 挂在这个回调上，就不会因为"用户关了个窗口"而漏记一轮对话。
	 *
	 * 第二个参数是**懒读取**：本轮最终 assistant 文本（2026-11-09 persona 接入批二）。
	 * 传函数而不是值，是为了让默认关闭的导出开关不产生额外 durable 读。
	 */
	onSettled?: (record: SettledSubmissionRecord, replyText?: () => Promise<string>) => void;
	/**
	 * 忙时投递方式（2026-11-07 消息即引导）：透传给内核的 `whenBusy`。
	 * 缺省 `followUp` = 改动前的排队行为。
	 */
	whenBusy?: "steer" | "followUp";
}

export async function conversationIsBusy(conversation: Conversation): Promise<boolean> {
	try {
		const harness = await getHarness();
		const live = await harness.snapshot(LiveDoc, conversation.id, CTX);
		return Boolean(live?.run);
	} catch {
		return false;
	}
}

export async function* chatStream(
	input: ChatStreamInput,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
	const watch = await input.conversation.watch(CTX);

	const queue: string[] = [];
	/** 待推送的思考增量（2026-11-04 批次一） */
	const thinkings: string[] = [];
	/** 待推送的阶段变化（工具钩子写进来，本流取出去） */
	const phases: TurnPhase[] = [];
	/** 待推送的派活事件（delegate 工具写进来，本流取出去） */
	const delegations: DelegationEvent[] = [];
	let emitted = "";
	let emittedThinking = "";
	/**
	 * 当前生成段的代号（2026-11-07 消息即引导）。
	 *
	 * 工具轮之后内核会起**新的一段**生成；新段的文本不是旧段的前缀，`offer` 会
	 * 直接把它挡掉（第二段永远发不出去）。所以按段重置基线，段与段之间补一条分隔线。
	 * 同一段内的重试（attempt 变化）**不重置**：重试是从头再生成同一段，仍按增量发。
	 */
	let emittedSegment: string | null = null;
	let wake: (() => void) | null = null;

	const notify = () => {
		const resume = wake;
		wake = null;
		resume?.();
	};

	/** 只在"新文本是在旧文本后面续上"时才吐增量，避免重试/回退导致重复输出 */
	const offer = (candidate: string) => {
		if (!candidate || candidate.length <= emitted.length) return;
		if (!candidate.startsWith(emitted)) return;
		queue.push(candidate.slice(emitted.length));
		emitted = candidate;
		notify();
	};

	/** 思考增量同款守卫；thinking 不在尾部补齐，流中能推多少推多少 */
	const offerThinking = (candidate: string) => {
		if (!candidate || candidate.length <= emittedThinking.length) return;
		if (!candidate.startsWith(emittedThinking)) return;
		thinkings.push(candidate.slice(emittedThinking.length));
		emittedThinking = candidate;
		notify();
	};

	const partialOf = (value: ConversationView): string => {
		const live = value.docs["pi.live"] as LiveState | undefined;
		const message = live?.generation?.message as { content?: unknown } | undefined;
		if (!message?.content) return "";
		return contentText(message.content as Parameters<typeof contentText>[0]);
	};

	/** 当前生成段的代号；没有正在生成的一段时返回 null。 */
	const segmentOf = (value: ConversationView): string | null => {
		const live = value.docs["pi.live"] as LiveState | undefined;
		if (!live?.generation) return null;
		return live.run?.taskId !== undefined ? String(live.run.taskId) : null;
	};

	/**
	 * 段切换时清空增量基线（2026-11-07）。
	 *
	 * 只在"之前已经发过正文、现在进了另一段"时插入分隔与重置；首段不插分隔。
	 * 不重置会怎样：工具轮后的第二段 `startsWith(emitted)` 恒假，整段静默丢失。
	 */
	const rollSegment = (value: ConversationView): void => {
		const segment = segmentOf(value);
		if (segment === null || segment === emittedSegment) return;
		const first = emittedSegment === null;
		emittedSegment = segment;
		if (first || emitted.length === 0) return;
		// 段与段之间空一行：客户端把它们拼成同一轮的正文，不能让两段糊在一起
		queue.push("\n\n");
		emitted = "";
		emittedThinking = "";
		notify();
	};

	/** 生成中的 thinking 块正文（2026-11-04 批次一；pi-ai 的块形状是 {type:"thinking", thinking}） */
	const thinkingOf = (value: ConversationView): string => {
		const live = value.docs["pi.live"] as LiveState | undefined;
		const message = live?.generation?.message as { content?: unknown } | undefined;
		if (!message?.content) return "";
		const parts: string[] = [];
		for (const block of message.content as Array<{ type?: string; thinking?: string }>) {
			if (block && block.type === "thinking" && typeof block.thinking === "string") {
				parts.push(block.thinking);
			}
		}
		return parts.join("");
	};

	// 用对象包着：闭包里赋值，TS 的收窄判断看不到
	const outcome: { record?: SettledSubmissionRecord; error?: Error } = {};
	let finished = false;
	// 这一轮开始前记一次；跑完对比，就知道期间有没有撞工具上限
	const conversationId = Number(input.conversation.id);
	const limitSeqBefore = limitHits.get(conversationId) ?? 0;
	// 订阅本会话的阶段变化：工具一开始执行就能立刻告诉客户端，不用等第一个 token
	const unwatchPhase = watchPhase(conversationId, (phase) => {
		phases.push(phase);
		notify();
	});
	const unwatchDelegation = watchDelegation(conversationId, (event) => {
		delegations.push(event);
		notify();
	});
	/**
	 * 执事间递话的主人通知（2026-11-08 扫尾批 8d）。
	 *
	 * 只有**主人的对话**订阅（`chatKindOfInternal === "chief"`）：执事自己那条流
	 * 已经在工具卡里看到"我递了话"，再弹一条只会让人以为收到了别人的话。
	 * 与派单进度同款——进程内轻事件，没开流就收不到、不落盘（不伪造主人的时间线）。
	 */
	const relayNotices: string[] = [];
	const kindsForNotice = COMPANIONS_ENABLED
		? await getHarness()
				.then((harness) => harness.snapshot(ChatKinds, CTX))
				.catch(() => null)
		: null;
	const unwatchRelayNotice =
		COMPANIONS_ENABLED &&
		chatKindOfInternal(conversationId, kindsForNotice?.byInternal ?? {}) === "chief"
			? watchChiefNotice((text) => {
					relayNotices.push(text);
					notify();
				})
			: () => {};
	/**
	 * 两态回执（2026-11-10 批 15 §五）：对方跑完后，settled 一句回流到**发送方
	 * 正在流式的会话**。与主人通知口同款：没开流就收不到、不落盘；持久那一份
	 * 在发送方 transcript 里（lifecycle 写 `pi.assistant` 留言条目）。
	 */
	const unwatchRelayReceipt = COMPANIONS_ENABLED
		? watchRelayReceipt(conversationId, (text) => {
				relayNotices.push(text);
				notify();
			})
		: () => {};
	/** 待推送的工具起止 */
	const tools: ToolEvent[] = [];
	const unwatchTool = watchTool(conversationId, (event) => {
		tools.push(event);
		notify();
	});

	try {
		// 运行时切模型后，还停在旧模型上的会话在这轮开跑前对齐过去（接口文档 §2.8）
		await syncConversationModel(input.conversation, conversationId);
		watch.start(async (value) => {
			rollSegment(value);
			offer(partialOf(value));
			offerThinking(thinkingOf(value));
		});
		rollSegment(watch.value);
		offer(partialOf(watch.value));
		offerThinking(thinkingOf(watch.value));

		// 提交前先看这轮是不是真的在跑：插话只对"正在跑的这一轮"有意义
		const busyBeforeSubmit = await conversationIsBusy(input.conversation);

		// 人设页工具勾选（2026-11-16 工具裁剪 B）：下一轮起生效；worker / task 不参与。
		// 总管主会话 / 执事专线 / 执事群会话 / 例行会话都走 chatStream，一处覆盖。
		// chatKindOfInternal 需要 ChatKinds 快照（上面 kindsForNotice 已取），读不到按非 chief 处理。
		// 解析出来的种类顺手记进进程内表：tool_search 执行期拿不到 ChatKinds 快照，
		// 靠这份记录才能判出"这条是总管主对话"，从而读到总管行的取消名单（2026-11-16 C 段）。
		try {
			const linked = partnersStore().partnerIdOfSession(conversationId);
			const kind = linked
				? "partner"
				: chatKindOfInternal(conversationId, kindsForNotice?.byInternal ?? {});
			noteSessionChatKind(conversationId, kind);
			const ownerId = linked ?? (kind === "chief" ? CHIEF_PARTNER_ID : null);
			const owner = ownerId ? partnersStore().get(ownerId) : null;
			if (owner) await applyPartnerToolSelection(input.conversation, owner);
		} catch {
			// 工具面读不到不该挡对话
		}

		const submission = await input.conversation.submit(
			// 产品承诺（2026-11-09 T2 §5）：人的消息永远插得上话——忙时 followUp
			// 排队到本轮收尾，不拒、不丢。缺省值写死在 userInputSubmission，不靠内核默认。
			userInputSubmission(input),
			CTX,
		);

		// 回执诚实（2026-11-07）：请求插话不等于"已经插进去了"。内核的语义是
		// "在下一次边界消费"——本轮还有工具轮就落在 postTools，已经收尾就等价于下一轮。
		// 所以只承诺"会在这轮的下一个边界生效"，不承诺"模型马上看到了"。
		//
		// 空闲时提交的 steer 不只是一个"没插进去"的降级：它会成为**新的一轮**，
		// 而调用方（插话那条短连接）按约定只收回执、不画正文。所以这里必须说清
		// "这句话已经开了新一轮"，否则用户会以为它被吞了。
		if (input.whenBusy === "steer") {
			yield {
				type: "notice",
				text: busyBeforeSubmit
					? "补充已作为插话发出：这一轮的下一个边界会带上它；没赶上就是下一轮的第一句。"
					: "这一轮刚好收尾，这句补充已经作为新的一轮开始。",
				// 机器可读落点（2026-11-07 补）：`new-turn` 时这条短连接是新一轮正文的
				// 唯一来源，而它按约定只收回执——客户端要靠这个标记安排收尾后的回读，
				// 不能靠猜文案（那是给人看的，不是给程序看的）。
				steer: busyBeforeSubmit ? "inserted" : "new-turn",
			};
		}

		void submission
			.wait(CTX)
			.then((record) => {
				outcome.record = record;
				// 这一轮尘埃落定：即便上面的流早被客户端关掉了，这里照样会跑
				try {
					// 本轮最终回复用懒读取给 settle 回调（persona 导出用；不调 = 不读）
					input.onSettled?.(record, () => answerText(input.conversation));
				} catch (error) {
					console.warn(
						`[agent] onSettled 回调失败: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				// 每轮的 usage/cacheRead 验收数据（方案 §6 步骤 1 / §7）
				void logTurnUsage(input.conversation, conversationId);
			})
			.catch((error: unknown) => {
				outcome.error = error instanceof Error ? error : new Error(String(error));
			})
			.finally(() => {
				finished = true;
				notify();
			});

		while (
			!finished ||
			queue.length > 0 ||
			thinkings.length > 0 ||
			phases.length > 0 ||
			delegations.length > 0 ||
			relayNotices.length > 0 ||
			tools.length > 0
		) {
			if (queue.length === 0 && thinkings.length === 0) {
				const tool = tools.shift();
				if (tool) {
					yield {
						type: "tool",
						name: tool.name,
						status: tool.status,
						label: tool.label,
						ok: tool.ok,
						output: tool.output,
						args: tool.args,
						// 编辑类工具的 diff（批 33）：现场与历史 steps 同一份事实
						diff: tool.diff,
					};
					continue;
				}
				const delegation = delegations.shift();
				if (delegation) {
					// 按 type 分发：approval 借这条通道，形状和 attention 不同（三元会把它发成空单号）
					if (delegation.type === "delegate") {
						yield {
							type: "delegate",
							ticketId: delegation.ticketId,
							domain: delegation.domain,
							phase: delegation.phase,
							done: delegation.done,
							total: delegation.total,
							current: delegation.current,
							message: delegation.message,
							project: delegation.project,
							lastAction: delegation.lastAction,
							lastHeartbeat: delegation.lastHeartbeat,
							waitingOn: delegation.waitingOn,
						};
					} else if (delegation.type === "attention") {
						yield {
							type: "attention",
							ticketId: delegation.ticketId,
							domain: delegation.domain,
							kind: delegation.kind,
							question: delegation.question,
						};
					} else if (delegation.type === "notice") {
						// agent 中途播报（2026-11-10 批 13 §三）：只送到当前这条流，
						// 没开流就收不到、不落盘（不伪造主人的时间线）。
						yield { type: "notice", text: delegation.text };
					} else {
						yield {
							type: "approval",
							callId: delegation.callId,
							tool: delegation.tool,
							args: delegation.args,
							deadlineAt: delegation.deadlineAt,
						};
					}
					continue;
				}
				const phase = phases.shift();
				if (phase) {
					yield { type: "progress", phase };
					continue;
				}
				// 执事间递话：主人时间线上的"谁 → 谁递了一条"（正文不在这里）
				const relayNotice = relayNotices.shift();
				if (relayNotice) {
					yield { type: "notice", text: relayNotice };
					continue;
				}
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			const thinkDelta = thinkings.shift();
			if (thinkDelta) yield { type: "thinking", text: thinkDelta };
			const delta = queue.shift();
			if (delta) yield { type: "delta", text: delta };
		}

		if (outcome.error) throw outcome.error;

		// 收尾：流式增量可能停在半句（节流或直接给了完整 answer），把尾巴补齐
		if (outcome.record?.status === "done") {
			offer(await answerText(input.conversation));
			while (queue.length > 0) {
				const delta = queue.shift();
				if (delta) yield { type: "delta", text: delta };
			}
		} else if (outcome.record?.status === "unanswered") {
			// 完整原文只进日志：里面可能带上游地址甚至 key 片段
			console.warn(
				`[agent] 本轮未回答: ${outcome.record.reason} ${JSON.stringify(outcome.record.detail ?? null)}`,
			);
			// 分类 + 脱敏后给用户一句话（批 32）：aborted/reset 返回 null——
			// 人自己停的前端已有「已中断生成」，再发错误帧就是报二遍。
			const described = describeStreamError(outcome.record.reason, outcome.record.detail);
			if (described) {
				yield {
					type: "unanswered",
					message: described.message,
					code: described.code,
					detail: described.detail,
				};
			}
		}

		// 撞了工具上限：不管模型最后有没有收尾，这句提示都由我们补，
		// 保证用户看到的措辞跟配置一致，而不是模型自己发挥的版本。
		if ((limitHits.get(conversationId) ?? 0) > limitSeqBefore) {
			yield { type: "turnLimit", message: TURN_LIMIT_MESSAGE };
		}

		// 本轮 token 用量（内部事件；index.ts 捕获后挂到 done.usage）。读不到就算了
		const usage = await readLastTurnUsage(input.conversation);
		if (usage) yield { type: "usage", usage };
	} finally {
		unwatchPhase();
		unwatchDelegation();
		unwatchTool();
		unwatchRelayNotice();
		unwatchRelayReceipt();
		// 只关掉"看"这件事，不碰正在跑的那一轮
		await watch.stop().catch(() => undefined);
	}
}

export async function stopChat(chat: ResolvedChat): Promise<void> {
	// 先把挂着的审批按 aborted 结算：否则钩子里的 await 要等 abortSignal 才醒，
	// 客户端也还会看到一条永远批不掉的卡片（2026-11-04 批次二）
	approvalStore().expireAll(chat.internalId, "aborted");
	await chat.conversation.abort(CTX);
}
