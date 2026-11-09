import { readFileSync, renameSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
	RemoteDelegationAcceptSchema,
	type DelegationPhase,
	type RemoteDelegationStatus,
} from "@lifediary/shared";
import type { Ticket } from "../../../../../chancellor/src/types.ts";
import { runChancellor } from "../../../../../chancellor/src/index.ts";
// agent.ts 经 tools.ts → 本文件被静态可达（arch-guard 等测试要先设 env 再加载 agent），
// 因此这里只做函数内懒加载，不建立模块级依赖（依赖方向纪律）。
import type { ResolvedChat } from "./agent.ts";
// 证据裁判（2026-11-10 批 14）：本机受理的远程单同样带裁判。
import { withDelegationJudge } from "./delegation-judge.ts";
import {
	autoRequestId,
	DelegationReceipts,
	requestFingerprint,
} from "./delegation-receipts.ts";
import {
	chancellorWorkRoot,
	emitDelegation,
	startDelegation,
	type DelegationEvent,
} from "./delegation.ts";
// 任务专线双写（2026-11-08 扫尾批 8g）：远程单在本机受理/运行，任务详情同样有一条专线。
import { taskConversationMirror } from "./task-conversation.ts";
import { projectsStore, resolveDelegationProject, type ProjectRef } from "./projects.ts";
import { RelayInvokeError, type RelayClient } from "./relay-client.ts";
import { autoCandidates, queryBusyMap, selectAutoDevice } from "./relay-auto.ts";
import {
	deviceAutoDispatchEnabled,
	deviceMatrixEnabled,
	deviceMaxActivePerDevice,
} from "./relay-config.ts";

/**
 * 设备矩阵派活（2026-11-05 多端同步方案块2，阶段二）。
 *
 * 两条腿都在这个文件里：
 * - **发起端** `dispatchRemoteDelegation`：经中继把活交给目标 harness，
 *   轮询回报，相位变化 emit 进发起会话，终态把一句话汇报写回会话；
 * - **被控端** `createMatrixChannels`：`delegation/accept`（受理，锚点会话
 *   + 回执先落再入队，全走本地 delegate 同款机制）与 `delegation/status`
 *   （从回执 + ticket.json 投影相位）。
 *
 * 回滚开关：DEVICE_MATRIX_ENABLED=false（默认）→ 两个通道不装、工具参数
 * 无效、HTTP 端点 404，回本机 chancellor 形态。离线语义：目标不在线直接
 * 失败不排队（回执不落），排队只存在于发送端（方案 §四阶段二）。
 */

const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 15_000;
const POLL_FAST_ROUNDS = 5;
const STORE_PATH =
	process.env.REMOTE_DELEGATIONS_PATH?.trim() || ".data/remote-delegations.json";

interface RemoteRow {
	requestId: string;
	targetDeviceId: string;
	targetDeviceName: string;
	targetTicketId: string;
	domain: string;
	originInternalId: number;
	/** 发起端视角的相位；终态后轮询停 */
	phase: DelegationPhase;
	report?: string;
	updatedAt: number;
	/** 这台机器是点名来的还是自动挑的（2026-11-05）。旧台账行没有这个字段。 */
	pickedBy?: "explicit" | "auto";
	/** 自动挑机的决策依据（如 busy=1）；点名派活为空。 */
	pickReason?: string;
	/**
	 * 自动挑机是否挑中了主机位（2026-11-05 主机优先制）：主机满载/离线外流时为 false。
	 * 只对 `pickedBy=auto` 的行有意义；旧台账行没有这个字段。
	 */
	pickedHome?: boolean;
	/** 终态单保留多久后从 JSON 清掉（状态查询仍可问目标机） */
	finishedAt?: number;
}

class RemoteDelegationStore {
	private rows = new Map<string, RemoteRow>();
	private loaded = false;

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (!existsSync(STORE_PATH)) return;
			const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as { rows?: RemoteRow[] };
			for (const row of parsed.rows ?? []) this.rows.set(row.requestId, row);
		} catch {
			// 坏文件当空表：发起端轮询丢了可以重派（requestId 幂等兜底在目标机）
		}
	}

	private save(): void {
		mkdirSync(dirname(STORE_PATH), { recursive: true });
		const tmp = `${STORE_PATH}.tmp`;
		writeFileSync(tmp, JSON.stringify({ rows: [...this.rows.values()] }, null, 2), "utf8");
		renameSync(tmp, STORE_PATH);
	}

	get(requestId: string): RemoteRow | null {
		this.load();
		return this.rows.get(requestId) ?? null;
	}

	put(row: RemoteRow): void {
		this.load();
		this.rows.set(row.requestId, row);
		this.save();
	}

	list(): RemoteRow[] {
		this.load();
		return [...this.rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}
}

const store = new RemoteDelegationStore();
let sharedReceipts: DelegationReceipts | null = null;
function receiptsOf(): DelegationReceipts {
	sharedReceipts ??= new DelegationReceipts();
	return sharedReceipts;
}

// ── 发起端 ─────────────────────────────────────────────────────

export interface RemoteDispatchInput {
	targetDeviceId: string;
	requirement: string;
	project?: string;
	domain?: string;
	/** 发起会话（进度事件与终态汇报写回这里） */
	originInternalId: number;
}

export interface RemoteDispatchResult {
	requestId: string;
	ticketId: string;
	deviceName: string;
	/** explicit = 点名；auto = 决策器挑的（写进台账，事后能看出活为什么去了那台） */
	pickedBy?: "explicit" | "auto";
	pickReason?: string;
	/** 自动挑机挑中的是不是主机位（2026-11-05 主机优先制；点名派活不带） */
	pickedHome?: boolean;
	/** 目标设备描述（≤200 字，只给人看）：delegate 回话里作点名参考 */
	deviceDescription?: string;
}

/**
 * 自动挑机的"挑不出"结果：**不是错误**，调用方据此落本机。
 * reason 与 selectAutoDevice 共用同一套枚举，HTTP 与工具文案直接透传。
 */
export interface RemoteDispatchFallback {
	fallbackToLocal: true;
	reason: "no_candidate" | "all_busy";
}

export type RemoteDispatchOutcome = RemoteDispatchResult | RemoteDispatchFallback;

/** 相位变化如何露出到发起会话：进度走 SSE 事件，终态追加一句话汇报。 */
type Reporter = (event: DelegationEvent) => void;

export async function dispatchRemoteDelegation(
	client: RelayClient,
	input: RemoteDispatchInput,
	report: Reporter = (event) => emitDelegation(input.originInternalId, event),
): Promise<RemoteDispatchOutcome> {
	if (!deviceMatrixEnabled()) {
		throw new RelayInvokeError("remote_disabled", "设备矩阵未开启（DEVICE_MATRIX_ENABLED）");
	}
	// 名册先拉新：welcome 快照只反映连上那一刻，中间上线的设备不刷就"不存在"
	await client.refreshDevices();
	let targetDeviceId = input.targetDeviceId;
	let pickedBy: "explicit" | "auto" = "explicit";
	let pickReason: string | undefined;
	// 只有自动挑机才有值：台账里 false 也要落（外流场景要能和"没设主机"区分开）
	let pickedHome: boolean | undefined;
	if (targetDeviceId === "auto") {
		// 双保险：HTTP/工具层已经挡过一次，直接调本函数也不能绕过开关。
		if (!deviceAutoDispatchEnabled()) {
			throw new RelayInvokeError("auto_disabled", "自动挑机未开启（DEVICE_AUTO_DISPATCH）");
		}
		// 决策在发起端：候选机的在跑单数先并发问一遍，中继保持哑（方案 §2.2）。
		const selfDeviceId = client.selfDeviceId ?? "";
		// 没有自身 id 就分不清"本机"，宁可不挑，也不能把活派回自己。
		if (!selfDeviceId) return { fallbackToLocal: true, reason: "no_candidate" };
		// 主机位从现成的名册快照取（refreshDevices 刚拉过，devices 带 isHome），
		// 不为它单开一条通道：中继仍只当名册的持有者。
		const homeDeviceId = client.devices.find((device) => device.isHome === true)?.id ?? null;
		const candidates = autoCandidates(client.devices, selfDeviceId);
		const busyMap = await queryBusyMap(client, candidates);
		const picked = selectAutoDevice({
			devices: client.devices,
			selfDeviceId,
			busyMap,
			maxActivePerDevice: deviceMaxActivePerDevice(),
			homeDeviceId,
		});
		if ("fallback" in picked) {
			// 挑不出必须可见：原因原样交回调用方（工具落本机、HTTP 返回决策结果）。
			return { fallbackToLocal: true, reason: picked.reason };
		}
		targetDeviceId = picked.picked;
		pickedBy = "auto";
		pickedHome = picked.pickedHome;
		// 依据保持 v1 形状（busy=N），主机位另用 pickedHome 记——探针两处都断言
		pickReason = `busy=${picked.busy}`;
	}
	const target = client.devices.find((device) => device.id === targetDeviceId);
	if (!target) {
		throw new RelayInvokeError("unknown_device", "目标设备不在中结名册里");
	}
	// 在场快照说离线就直接失败（fail-fast，不排队）；快照说在线但实际掉了，
	// 由 invoke 超时/错误帧兜住，走下面的异步"没有受理"汇报。
	if (!target.online) {
		throw new RelayInvokeError("device_offline", "目标设备当前离线");
	}
	if (!target.capabilities.includes("matrix")) {
		throw new RelayInvokeError("remote_disabled", "目标设备没有开通矩阵派活能力");
	}
	const requestId = autoRequestId(input.originInternalId, input.requirement);
	void (async () => {
		try {
			const accepted = (await client.invoke(
				targetDeviceId,
				"delegation/accept",
				{
					requestId,
					prompt: input.requirement,
					...(input.project ? { project: input.project } : {}),
					...(input.domain ? { domain: input.domain } : {}),
					originDeviceId: client.selfDeviceId ?? "",
					createdAt: Date.now(),
				},
				90_000,
			)) as { ticketId?: string };
			const ticketId = accepted.ticketId ?? "";
			store.put({
				requestId,
				targetDeviceId,
				targetDeviceName: target.name,
				targetTicketId: ticketId,
				domain: input.domain ?? "",
				originInternalId: input.originInternalId,
				phase: "accepted",
				updatedAt: Date.now(),
				pickedBy,
				...(pickReason ? { pickReason } : {}),
				...(pickedHome === undefined ? {} : { pickedHome }),
			});
			report({
				type: "delegate",
				ticketId,
				domain: input.domain ?? "remote",
				phase: "accepted",
				done: 0,
				total: 0,
				current: "",
				lastAction: `远端单已交由设备「${target.name}」受理`,
				lastHeartbeat: new Date().toISOString(),
				...(input.project ? { project: input.project } : {}),
			});
			schedulePoll(client, requestId, 0, report);
		} catch (error) {
			// 受理失败 = 没有单、没有回执：把原因直接告诉会话，不排队不重试。
			const message = error instanceof Error ? error.message.slice(0, 200) : "受理失败";
			await (await import("./agent.ts")).sayInConversation(input.originInternalId, `远端派活没有受理（设备「${target.name}」）：${message}。目标在线后再派。`).catch(
				() => {},
			);
		}
	})();
	return {
		requestId,
		ticketId: "",
		deviceName: target.name,
		pickedBy,
		...(pickReason ? { pickReason } : {}),
		...(pickedHome === undefined ? {} : { pickedHome }),
		...(target.description ? { deviceDescription: target.description } : {}),
	};
}

function schedulePoll(client: RelayClient, requestId: string, round: number, report: Reporter): void {
	const delay = round < POLL_FAST_ROUNDS ? POLL_FAST_MS : POLL_SLOW_MS;
	const timer = setTimeout(() => void pollOnce(client, requestId, round, report), delay);
	timer.unref?.();
}

async function pollOnce(client: RelayClient, requestId: string, round: number, report: Reporter): Promise<void> {
	const row = store.get(requestId);
	if (!row) return;
	if (isTerminal(row.phase)) return;
	let status: RemoteDelegationStatus | null = null;
	try {
		status = (await client.invoke(row.targetDeviceId, "delegation/status", { requestId }, 20_000)) as RemoteDelegationStatus | null;
	} catch {
		// 目标离线：保留最后相位继续轮（不判失败——恢复语义归目标机的回执机制）
		schedulePoll(client, requestId, round + 1, report);
		return;
	}
	if (status && status.phase !== row.phase) {
		row.phase = status.phase;
		row.updatedAt = Date.now();
		if (status.report) row.report = status.report;
		if (status.ticketId && !row.targetTicketId) row.targetTicketId = status.ticketId;
		store.put(row);
		report({
			type: "delegate",
			ticketId: row.targetTicketId,
			domain: row.domain || "remote",
			phase: row.phase,
			done: 0,
			total: 0,
			current: "",
			lastAction: `远端：${phaseLabel(row.phase)}${status.report ? ` — ${status.report.slice(0, 80)}` : ""}`,
			lastHeartbeat: new Date().toISOString(),
		});
		if (isTerminal(row.phase)) {
			row.finishedAt = Date.now();
			store.put(row);
			const line = `远端单 ${row.targetTicketId || requestId.slice(0, 8)}（设备「${row.targetDeviceName}」）${phaseLabel(row.phase)}${row.report ? `：${row.report}` : ""}`;
			await (await import("./agent.ts")).sayInConversation(row.originInternalId, line).catch(() => {});
			return;
		}
	}
	schedulePoll(client, requestId, round + 1, report);
}

/** 状态查询（HTTP/界面用）：发起端视角的远端单列表。 */
export function listRemoteDelegations(): Array<Omit<RemoteRow, never>> {
	return store.list();
}

function isTerminal(phase: DelegationPhase): boolean {
	return phase === "done" || phase === "needs_you" || phase === "failed" || phase === "aborted";
}

function phaseLabel(phase: DelegationPhase): string {
	const labels: Record<DelegationPhase, string> = {
		accepted: "已受理",
		planning: "规划中",
		running: "执行中",
		reviewing: "核对中",
		done: "完成",
		needs_you: "需要你",
		failed: "失败",
		aborted: "已中止",
	};
	return labels[phase];
}

// ── 被控端 ─────────────────────────────────────────────────────

export interface MatrixChannels {
	accept: (payload: unknown) => Promise<{ ticketId: string; conversationId: string }>;
	status: (payload: unknown) => Promise<RemoteDelegationStatus | null>;
	/** 自动挑机的忙碌位：本机回执库里非终态单的数量。 */
	busy: () => Promise<{ active: number }>;
}

/** chancellor TicketStatus → 对外 8 相（DelegationPhase）。 */
function phaseOfTicket(ticket: Ticket | null, receiptOutcome: string): DelegationPhase {
	if (receiptOutcome === "failed") return "failed";
	const status = ticket?.status;
	switch (status) {
		case "received":
			return "accepted";
		case "planning":
			return "planning";
		case "planned":
		case "dispatching":
			return "running";
		case "reviewing":
			return "reviewing";
		case "done":
			return "done";
		case "needs_you":
			return "needs_you";
		case "failed":
			return "failed";
		case "aborted":
			return "aborted";
		case "idle":
			return "needs_you";
		default:
			return "accepted";
	}
}

function readTicket(runsDir: string, ticketId: string): Ticket | null {
	if (!ticketId) return null;
	try {
		return JSON.parse(readFileSync(`${runsDir}/${ticketId}/ticket.json`, "utf8")) as Ticket;
	} catch {
		return null;
	}
}

export function createMatrixChannels(): MatrixChannels {
	return {
		/** 受理：锚点会话 + 回执先落再入队（与本地 delegate 同款机制）。 */
		async accept(payload) {
			const parsed = RemoteDelegationAcceptSchema.safeParse(payload);
			if (!parsed.success) {
				throw new RelayInvokeError("bad_request", "accept 载荷不符合契约");
			}
			const input = parsed.data;
			if (process.env.CHANCELLOR_ENABLED?.trim().toLowerCase() === "false") {
				throw new RelayInvokeError("remote_disabled", "本机未启用派活（CHANCELLOR_ENABLED=false）");
			}
			// 锚点会话：远端单在本机也要有一个家——恢复/看板/汇报机制才能原样工作。
			const agent = await import("./agent.ts");
			const chat = await agent.openChat(undefined);
			if (!chat) throw new RelayInvokeError("internal", "本机没有可用的模型配置，不能受理远端单");
			void agent.renameChat(chat.externalId, `远端单 ${input.requestId.slice(0, 8)}`);
			// 锚点里落一行受理回执：空会话不进 durable 的列表快照，写一条才有 firstText，
			// 本机会话索引与镜像端才能看到这张单（探针实测踩过）。
			await agent.sayInChat(chat as ResolvedChat, `远端单 ${input.requestId.slice(0, 8)} 已受理（来自设备 ${input.originDeviceId.slice(0, 8)}）：${input.prompt.slice(0, 120)}`);

			let project: ProjectRef | undefined;
			if (input.project?.trim()) {
				const gate = resolveDelegationProject(input.project, projectsStore());
				if (!gate.ok) {
					throw new RelayInvokeError("bad_request", `目标机项目前置未过：${gate.text.slice(0, 160)}`);
				}
				project = gate.project;
			}

			const receipts = receiptsOf();
			const begun = receipts.begin(input.requestId, requestFingerprint({
				conversationId: chat.internalId,
				requirement: input.prompt,
				domain: input.domain ?? "",
				projectId: project?.id ?? "",
			}), { explicit: true, workRoot: chancellorWorkRoot() });
			if (begun.kind === "conflict") {
				throw new RelayInvokeError("bad_request", "同 requestId 但内容不同（冲突），拒绝受理");
			}
			if (begun.kind === "uncertain") {
				throw new RelayInvokeError("internal", "同 requestId 的旧单受理中断过，结果未知；请人工确认后换号重派");
			}

			const { ticketId, outcome } = startDelegation(
				{
					conversationId: chat.internalId,
					domain: input.domain ?? "",
					requirement: input.prompt,
					project,
					requestId: input.requestId,
				},
				{
					run: (request, options) =>
						runChancellor(
							{ ...request, workRoot: chancellorWorkRoot() },
							withDelegationJudge(options),
						),
					// 锚点会话里也发事件（本机任务中心可见）；不写锚点汇报——
					// 汇报经 status 轮询回发起端（方案 §四阶段二）。
					emit: emitDelegation,
					// 本机受理的远程单同样有任务详情，双写走同一条专线（2026-11-08 扫尾批 8g）。
					mirror: taskConversationMirror,
					autoReport: false,
					log: (line) => console.warn(line),
				},
			);
			receipts.accept(input.requestId, ticketId, chat.internalId);
			void outcome
				.then((result) => receipts.accept(input.requestId, result.ticketId || ticketId, chat.internalId))
				.catch(() => receipts.markFailed(input.requestId));
			return { ticketId, conversationId: chat.externalId };
		},

		/** 忙碌位：读本机回执库，返回非终态（accepting/accepted）单数。 */
		async busy() {
			return { active: receiptsOf().countActive() };
		},

		/** 相位投影：回执（受理态）+ ticket.json（运行态）。 */
		async status(payload) {
			const requestId = (payload as { requestId?: unknown } | null)?.requestId;
			if (typeof requestId !== "string" || !requestId) {
				throw new RelayInvokeError("bad_request", "需要 requestId");
			}
			const receipt = receiptsOf().lookup(requestId);
			if (!receipt) return null;
			const ticket = readTicket(chancellorWorkRoot(), receipt.ticketId);
			const phase = phaseOfTicket(ticket, receipt.outcome);
			return {
				requestId,
				ticketId: receipt.ticketId,
				phase,
				...(phase === "done" || phase === "failed" || phase === "needs_you"
					? {
							report: (ticket?.error ?? ticket?.lastAction ?? "").slice(0, 4000),
						}
					: {}),
				updatedAt: Date.now(),
			};
		},
	};
}
