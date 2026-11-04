import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 审批 store（2026-11-04 批次二，A1）。
 *
 * `.data/approvals.json` 是一份**有意落盘的状态文件**，照 chat-meta.json 的惯例：
 * 它记 callId / 会话 / 工具 / 参数摘要 / 截止时间，目的是"刷新页面还能补挂、重启能说清上一轮怎么了"。
 * **永不进服务端日志**——参数里有对话内容，日志口径只记条数 / 枚举（AGENTS.md 硬约束）。
 *
 * 关键语义：
 *   - `load()` 必须在 `harness.resume()` 之前调；启动时把遗留 pending 一律置 `timeout`
 *     （fail-closed，内核恢复会重走 beforeTool 生成新审批）。
 *   - `decide()` 幂等：已决的记录返回原决定，不二次结算、不二次 resolve。
 *   - `create()` 对同一 callId 的旧记录**覆盖重置**（恢复重放会复用 callId）。
 *   - `remember` 只在进程内（`Map<会话, Set<工具>>`），重启失效、需要重新批准。
 */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout" | "aborted";
/** 结算后的状态（不再有 pending） */
export type ApprovalOutcome = Exclude<ApprovalStatus, "pending">;
export type ApprovalDecision = "approve" | "reject";

export interface ApprovalRecord {
	/** 内核的工具调用 id；答复端点的主键 */
	callId: string;
	/** durable 内部会话 id（不对外；对外查询先由 uuid 换过来） */
	conversationId: number;
	tool: string;
	/** 工具参数 JSON，按 toolArgs 口径截断 1200 字符 */
	args: string;
	createdAt: number;
	/** ISO 时间，外发给客户端倒计时 */
	deadlineAt: string;
	status: ApprovalStatus;
	decidedAt?: number;
	/**
	 * 自主轮标记（2026-11-05 批次C C2）：例行任务/事件唤醒的轮次产生的审批。
	 * 客户端据此把卡片标注为「例行任务」；纯增量字段，老客户端忽略。
	 */
	origin?: "autonomous";
}

export interface ApprovalCreateInput {
	callId: string;
	conversationId: number;
	tool: string;
	args: string;
	timeoutMs: number;
	/** 自主轮标记（批次C C2）：例行轮的审批卡带 origin，纯增量字段 */
	origin?: "autonomous";
}

export interface PendingApproval {
	record: ApprovalRecord;
	/** pending → 终态时结算（approved / rejected / timeout / aborted） */
	promise: Promise<ApprovalOutcome>;
}

/** 终态记录保留一天：够幂等重试与排障，又不让状态文件无限长 */
const TERMINAL_TTL_MS = 86_400_000;

function normalize(raw: unknown): ApprovalRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Partial<ApprovalRecord>;
	if (typeof value.callId !== "string" || !value.callId) return null;
	if (typeof value.conversationId !== "number") return null;
	if (typeof value.tool !== "string") return null;
	if (typeof value.args !== "string") return null;
	if (typeof value.createdAt !== "number") return null;
	if (typeof value.deadlineAt !== "string") return null;
	const status = value.status;
	if (
		status !== "pending" &&
		status !== "approved" &&
		status !== "rejected" &&
		status !== "timeout" &&
		status !== "aborted"
	) {
		return null;
	}
	return {
		callId: value.callId,
		conversationId: value.conversationId,
		tool: value.tool,
		args: value.args,
		createdAt: value.createdAt,
		deadlineAt: value.deadlineAt,
		status,
		...(typeof value.decidedAt === "number" ? { decidedAt: value.decidedAt } : {}),
	};
}

export class ApprovalStore {
	private readonly path: string;
	private readonly records = new Map<string, ApprovalRecord>();
	/** 每个 pending 的结算函数；decide / expire / create 覆盖时取走 */
	private readonly waiters = new Map<string, (status: ApprovalOutcome) => void>();
	/** 「本会话记住这个工具」——进程内，重启失效 */
	private readonly remembered = new Map<number, Set<string>>();
	private loaded = false;

	constructor(options: { path?: string } = {}) {
		this.path = options.path?.trim() || process.env.AGENT_APPROVALS_PATH?.trim() || ".data/approvals.json";
	}

	/** 只做一次：重复调用不能把本进程里正在等的 pending 误判成 timeout */
	load(): void {
		if (this.loaded) return;
		this.loaded = true;

		let changed = false;
		const now = Date.now();
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { approvals?: unknown };
			const rows = Array.isArray(parsed.approvals) ? parsed.approvals : [];
			for (const raw of rows) {
				const record = normalize(raw);
				if (!record) continue;
				if (record.status === "pending") {
					// 上一进程留下的等待已经没人接了：按超时结算，宁拒绝不放过
					record.status = "timeout";
					record.decidedAt = now;
					changed = true;
				} else if (now - (record.decidedAt ?? record.createdAt) > TERMINAL_TTL_MS) {
					changed = true;
					continue;
				}
				this.records.set(record.callId, record);
			}
		} catch {
			// 文件不存在或坏了：当作没有审批，不影响启动
		}
		if (changed) this.persist();
	}

	/** 当前全部 pending（C1 观察层的 waiting 事件源；含自主轮标记）。 */
	pendingRecords(): ApprovalRecord[] {
		this.ensureLoaded();
		return [...this.records.values()].filter((record) => record.status === "pending");
	}

	create(input: ApprovalCreateInput): PendingApproval {
		this.ensureLoaded();
		// 同 callId 的旧记录覆盖重置：内核对中断的工具会重放同一个 callId。
		// 旧等待方已经没有人会答复，先按 aborted 放走，避免挂死。
		this.settle(input.callId, "aborted", false);

		let resolve!: (status: ApprovalOutcome) => void;
		const promise = new Promise<ApprovalOutcome>((done) => {
			resolve = done;
		});
		const record: ApprovalRecord = {
			callId: input.callId,
			conversationId: input.conversationId,
			tool: input.tool,
			args: input.args,
			createdAt: Date.now(),
			deadlineAt: new Date(Date.now() + input.timeoutMs).toISOString(),
			status: "pending",
			...(input.origin ? { origin: input.origin } : {}),
		};
		this.records.set(record.callId, record);
		this.waiters.set(record.callId, resolve);
		this.persist();
		return { record, promise };
	}

	/** 答复。未知 callId → null；已决 → 原记录（幂等，不改状态） */
	decide(callId: string, decision: ApprovalDecision, remember = false): ApprovalRecord | null {
		this.ensureLoaded();
		const record = this.records.get(callId);
		if (!record) return null;
		if (record.status !== "pending") return record;

		const status: ApprovalOutcome = decision === "approve" ? "approved" : "rejected";
		record.status = status;
		record.decidedAt = Date.now();
		if (status === "approved" && remember) this.remember(record.conversationId, record.tool);
		this.resolve(record.callId, status);
		this.persist();
		return record;
	}

	/** 单条按终态结算（超时 / 中止）。返回是否真的改了状态 */
	expire(callId: string, status: ApprovalOutcome): boolean {
		return this.settle(callId, status, true);
	}

	/** 会话级的兜底结算：/stop、会话撤掉时用；返回结算了几条 */
	expireAll(conversationId: number, status: ApprovalOutcome): number {
		this.ensureLoaded();
		const now = Date.now();
		let count = 0;
		for (const record of this.records.values()) {
			if (record.conversationId !== conversationId || record.status !== "pending") continue;
			record.status = status;
			record.decidedAt = now;
			this.resolve(record.callId, status);
			count += 1;
		}
		if (count > 0) this.persist();
		return count;
	}

	/** 该会话还在等的审批（含参数摘要）；对外接口只回这一份 */
	pendingOf(conversationId: number): ApprovalRecord[] {
		this.ensureLoaded();
		return [...this.records.values()]
			.filter((record) => record.conversationId === conversationId && record.status === "pending")
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	/** 全局待办（2026-11-04 批次六）：跨会话、只回 pending，按 createdAt 升序 */
	pendingAll(): ApprovalRecord[] {
		this.ensureLoaded();
		return [...this.records.values()]
			.filter((record) => record.status === "pending")
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	isRemembered(conversationId: number, tool: string): boolean {
		return this.remembered.get(conversationId)?.has(tool) ?? false;
	}

	remember(conversationId: number, tool: string): void {
		let tools = this.remembered.get(conversationId);
		if (!tools) {
			tools = new Set();
			this.remembered.set(conversationId, tools);
		}
		tools.add(tool);
	}

	private ensureLoaded(): void {
		if (!this.loaded) this.load();
	}

	private settle(callId: string, status: ApprovalOutcome, persist: boolean): boolean {
		const record = this.records.get(callId);
		if (!record || record.status !== "pending") return false;
		record.status = status;
		record.decidedAt = Date.now();
		this.resolve(callId, status);
		if (persist) this.persist();
		return true;
	}

	private resolve(callId: string, status: ApprovalOutcome): void {
		const resolve = this.waiters.get(callId);
		if (!resolve) return;
		this.waiters.delete(callId);
		resolve(status);
	}

	private persist(): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			// 终态记录过一天就清掉：长跑的进程也不会把它攒成一本旧账（pending 永不在这里清）
			const cutoff = Date.now() - TERMINAL_TTL_MS;
			for (const [callId, record] of this.records) {
				if (record.status !== "pending" && (record.decidedAt ?? record.createdAt) < cutoff) {
					this.records.delete(callId);
				}
			}
			const approvals = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
			writeFileSync(this.path, `${JSON.stringify({ version: 1, approvals }, null, 2)}\n`);
		} catch (error) {
			// 写不进去只影响"重启后还记得"，本次审批照常走；只记路径与错误，不记内容
			console.warn(
				`[approval] 写 ${this.path} 失败（本次仍然生效）: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

let singleton: ApprovalStore | null = null;

/** 进程内唯一实例；落点由 `AGENT_APPROVALS_PATH` 决定（默认 `.data/approvals.json`） */
export function approvalStore(): ApprovalStore {
	singleton ??= new ApprovalStore();
	return singleton;
}
