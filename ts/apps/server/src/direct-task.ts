/**
 * 前端直派任务（2026-11-22「底层工人统一进池」）。
 *
 * 侧栏「任务 → 新建任务」不再只开一个宿主助手会话：它直接建一张票，
 * 强制交给池运行时（`DIRECT_TASK_POOL=false` 回滚成跟随设置）。
 *
 * 单号先分配、任务专线先建、用户那句话先落成 `pi.user`，然后再落单——
 * 这样专线里第一条永远是主人说的话，而不是“已受理”的进度镜像；
 * 回话 / 重试也能从 `originConversationId` 找回这条线程。
 */

import process from "node:process";

import { allocateTicketId } from "../../../packages/chancellor/src/intake.ts";
import { runChancellor } from "../../../packages/chancellor/src/index.ts";
import { deadLetterStore } from "./delegation-jobs.ts";
import { chancellorWorkRoot, startDelegation } from "./delegation.ts";
import type { DelegationMirrorEntry, DelegationRuntime } from "./delegation.ts";
import { executorForDelegation } from "./executor-config.ts";
import { projectsStore, resolveDelegationProject } from "./projects.ts";
import {
	appendTaskEvent,
	appendTaskUserMessage,
	ensureTaskConversation,
	taskConversationExternalId,
	taskConversationMirror,
} from "./task-conversation.ts";
import { recordWorkSettlement } from "./work-record.ts";

export interface DirectTaskInput {
	requirement: string;
	/** 项目 id；不传 = 项目登记表里的默认项目（与 delegate 工具同口径）。 */
	projectRef?: string;
}

export type DirectTaskResponse =
	| {
			ok: true;
			ticketId: string;
			conversationId: string;
			/** false = 专线没建起来（模型未配置 / 存储不可用），前端落到任务详情。 */
			conversationReady: boolean;
	  }
	| { ok: false; status: 400; body: Record<string, unknown> };

/** 需求正文上限：与池 `/run` 的 instruction 上限同量级，防一次请求撑爆票面。 */
const MAX_REQUIREMENT_CHARS = 200_000;

function directTaskPoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.DIRECT_TASK_POOL ?? "").trim().toLowerCase();
	return raw !== "false" && raw !== "0" && raw !== "off";
}

function escalationText(event: {
	question?: string;
	context?: string;
	options?: readonly string[];
}): string {
	const head = `【需要你】${event.question ?? "工人有一个问题等你回答"}`;
	const context = event.context?.trim();
	const options = event.options?.filter(Boolean) ?? [];
	return [
		head,
		...(context ? [`背景：${context}`] : []),
		...(options.length > 0 ? [`候选：${options.join(" / ")}`] : []),
	].join("\n");
}

export async function createDirectTask(input: DirectTaskInput): Promise<DirectTaskResponse> {
	const requirement = String(input.requirement ?? "").trim();
	if (!requirement) {
		return {
			ok: false,
			status: 400,
			body: { ok: false, error: "bad_request", message: "requirement 不能为空" },
		};
	}
	if (requirement.length > MAX_REQUIREMENT_CHARS) {
		return {
			ok: false,
			status: 400,
			body: {
				ok: false,
				error: "bad_request",
				message: `requirement 超过上限（${requirement.length} > ${MAX_REQUIREMENT_CHARS} 字符）`,
			},
		};
	}

	const gate = resolveDelegationProject(input.projectRef, projectsStore());
	if (!gate.ok) {
		return {
			ok: false,
			status: 400,
			body: { ok: false, error: "needs_project", message: gate.text },
		};
	}

	const workRoot = chancellorWorkRoot();
	const ticketId = allocateTicketId(workRoot);
	// 先把线程建起来、把主人这句话落成 pi.user；专线不可用也不挡派活（只影响可见线程）。
	const chat = await ensureTaskConversation(ticketId);
	if (chat) await appendTaskUserMessage(ticketId, requirement);

	const store = deadLetterStore();
	const runtime: DelegationRuntime = {
		run: (request, options) => runChancellor({ ...request, workRoot }, options),
		// 直派任务没有“派活人会话”可回灌：进度 / 汇报走专线 mirror；上报写进专线，
		// 不触发全局“总管代答”轮（那条链要求一个真实的上层会话）。
		emit: (_conversationId, event) => {
			if (event.type === "escalation") {
				void appendTaskEvent(event.ticketId, {
					kind: "notice",
					text: escalationText(event),
				});
			} else if (event.type === "attention") {
				void appendTaskEvent(event.ticketId, {
					kind: "notice",
					text: `【需要你】${event.question}`,
				});
			}
		},
		mirror: (id: string, entry: DelegationMirrorEntry) => taskConversationMirror(id, entry),
		autoReport: false,
		isCanceled: (id) => store.isCanceled(id),
		recordWork: recordWorkSettlement,
		log: (line) => console.warn(line),
	};

	const executor = directTaskPoolEnabled()
		? executorForDelegation(process.env, {}, "pool")
		: executorForDelegation();
	const { ticketId: accepted, outcome } = startDelegation(
		{
			conversationId: chat?.internalId ?? 0,
			domain: "",
			requirement,
			project: gate.project,
			ticketId,
			executor,
			// 留言表照写；专线镜像跳过——那句话已经以真 pi.user 落过了。
			sender: { kind: "chief", name: "主人" },
			skipMessageMirror: true,
		},
		runtime,
	);
	void outcome.catch((error: unknown) => {
		// 原始错误只进服务端日志；专线已经有留言与进度，不在这里重复播报。
		console.warn(
			`[direct-task] 单 ${ticketId.slice(0, 12)} 结算异常: ${
				error instanceof Error ? error.message.slice(0, 200) : "unknown"
			}`,
		);
	});

	const finalTicketId = accepted || ticketId;
	return {
		ok: true,
		ticketId: finalTicketId,
		conversationId: taskConversationExternalId(finalTicketId),
		// 单号被 chancellor 回落自生成（极端撞号）时，预建的那条线程是孤儿；
		// 真实线程由 mirror 首次写入时创建，前端落到任务详情更稳。
		conversationReady: chat !== null && finalTicketId === ticketId,
	};
}
