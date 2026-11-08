import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 审批 store（2026-11-04 批次二，A1；2026-11-08 扫尾批 8c 改等待态语义）。
 *
 * `.data/approvals.json` 是一份**有意落盘的状态文件**，照 chat-meta.json 的惯例：
 * 它记 callId / 会话 / 工具 / 参数摘要 / 截止时间，目的是"刷新页面还能补挂、重启能说清上一轮怎么了"。
 * **永不进服务端日志**——参数里有对话内容，日志口径只记条数 / 枚举（AGENTS.md 硬约束）。
 *
 * 关键语义：
 *   - `load()` 必须在 `harness.resume()` 之前调。**缺省保留遗留 pending**（新形态：人随时回来批）；
 *     只有 blocking 回滚形态传 `{ expireLeftover: true }`，才把它们置 `timeout`（fail-closed）。
 *   - `decide()` 幂等：已决的记录返回原决定，不二次结算、不二次 resolve。
 *   - 批准时顺手记一条**一次性放行清单**（工具 + 参数指纹）：模型重发同一个调用时闸门核销放行。
 *     清单不按 callId 匹配——重发时内核给的是新 callId。
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
	/**
	 * 参数指纹（2026-11-08 扫尾批 8c）：稳定序列化后的 sha256。
	 * 放行清单只认它；老记录读回来没有这个字段（缺省 = 批准后不生成放行，重新问一次）。
	 */
	argsHash?: string;
	createdAt: number;
	/** ISO 时间。新形态下**只是展示用**（不据此结算）；blocking 形态才是倒计时 */
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
	/** 参数指纹（8c）；调用方拿原始 arguments 算，不要拿截断后的 args */
	argsHash?: string;
	timeoutMs: number;
	/** 自主轮标记（批次C C2）：例行轮的审批卡带 origin，纯增量字段 */
	origin?: "autonomous";
}

/**
 * 一次性放行（2026-11-08 扫尾批 8c）。
 *
 * `callId` 只用来排障（这条放行是哪次审批给的）；**匹配不靠它**——模型重发时 callId 是新的。
 */
export interface ApprovalGrant {
	callId: string;
	conversationId: number;
	tool: string;
	argsHash: string;
	grantedAt: number;
}

export interface PendingApproval {
	record: ApprovalRecord;
	/** pending → 终态时结算（approved / rejected / timeout / aborted） */
	promise: Promise<ApprovalOutcome>;
}

/** 终态记录保留一天：够幂等重试与排障，又不让状态文件无限长 */
const TERMINAL_TTL_MS = 86_400_000;
/** 放行的保鲜期：批了却一直没重发，一天后自动作废（不让"批准"无限期挂着） */
const GRANT_TTL_MS = 86_400_000;

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
		...(typeof value.argsHash === "string" && value.argsHash ? { argsHash: value.argsHash } : {}),
		...(typeof value.decidedAt === "number" ? { decidedAt: value.decidedAt } : {}),
	};
}

function normalizeGrant(raw: unknown): ApprovalGrant | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Partial<ApprovalGrant>;
	if (typeof value.callId !== "string" || !value.callId) return null;
	if (typeof value.conversationId !== "number") return null;
	if (typeof value.tool !== "string" || !value.tool) return null;
	if (typeof value.argsHash !== "string" || !value.argsHash) return null;
	if (typeof value.grantedAt !== "number") return null;
	return {
		callId: value.callId,
		conversationId: value.conversationId,
		tool: value.tool,
		argsHash: value.argsHash,
		grantedAt: value.grantedAt,
	};
}

export class ApprovalStore {
	private readonly path: string;
	private readonly records = new Map<string, ApprovalRecord>();
	/** 每个 pending 的结算函数；decide / expire / create 覆盖时取走 */
	private readonly waiters = new Map<string, (status: ApprovalOutcome) => void>();
	/** 「本会话记住这个工具」——进程内，重启失效 */
	private readonly remembered = new Map<number, Set<string>>();
	/** 一次性放行清单（同意过的工具 + 参数指纹；核销即删） */
	private readonly grants: ApprovalGrant[] = [];
	/** 从状态文件读回来的 pending（老进程留下的）。blocking 回滚时只结算这些 */
	private readonly leftovers = new Set<string>();
	/** blocking 回滚形态：启动时把遗留 pending 按 timeout 结算 */
	private expireLeftover = false;
	private loaded = false;

	constructor(options: { path?: string } = {}) {
		this.path = options.path?.trim() || process.env.AGENT_APPROVALS_PATH?.trim() || ".data/approvals.json";
	}

	/**
	 * 只做一次：重复调用不能把本进程里正在等的 pending 误判成 timeout。
	 *
	 * `expireLeftover`（2026-11-08 扫尾批 8c）：只有 blocking 回滚形态传 true。
	 * 缺省 false = 遗留 pending 保留可答（等待态落库的本意就是"人随时回来批"）。
	 * 标志是粘性的：即使别处先触发了一次隐式 load（如 autonomy 的 sweep），
	 * 之后显式传入也会把**从文件读回来的**那批 pending 结算掉，不碰本进程的活等待。
	 */
	load(options: { expireLeftover?: boolean } = {}): void {
		if (options.expireLeftover) this.expireLeftover = true;
		if (!this.loaded) {
			this.loaded = true;
			this.read();
		}
		if (this.expireLeftover) this.settleLeftovers();
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
		// 这个 callId 现在归本进程的活等待，不再算"启动遗留"（防止之后被误结算）
		this.leftovers.delete(input.callId);

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
			...(input.argsHash ? { argsHash: input.argsHash } : {}),
			...(input.origin ? { origin: input.origin } : {}),
		};
		this.records.set(record.callId, record);
		this.waiters.set(record.callId, resolve);
		this.persist();
		return { record, promise };
	}

	/** 答复。未知 callId → null；已决 → 原记录（幂等，不改状态、不重复放行） */
	decide(callId: string, decision: ApprovalDecision, remember = false): ApprovalRecord | null {
		this.ensureLoaded();
		const record = this.records.get(callId);
		if (!record) return null;
		if (record.status !== "pending") return record;

		const status: ApprovalOutcome = decision === "approve" ? "approved" : "rejected";
		record.status = status;
		record.decidedAt = Date.now();
		if (status === "approved") {
			if (remember) this.remember(record.conversationId, record.tool);
			// 一次性放行：模型重发同一个工具调用时核销。没有指纹的老记录不外发放行（重新问一次）
			if (record.argsHash) this.grant(record);
		}
		this.resolve(record.callId, status);
		this.persist();
		return record;
	}

	/** 单条按终态结算（超时 / 中止）。返回是否真的改了状态 */
	expire(callId: string, status: ApprovalOutcome): boolean {
		return this.settle(callId, status, true);
	}

	/** 会话级的兜底结算：/stop、会话撤掉时用；返回结算了几条。放行清单一并作废（停止 = 撤销） */
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
		const dropped = this.dropGrants(conversationId);
		if (count > 0 || dropped > 0) this.persist();
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

	/** 单条记录快照（答复端点用来判断"这次是不是真的结算了"，决定要不要触发续跑） */
	recordOf(callId: string): ApprovalRecord | undefined {
		this.ensureLoaded();
		const record = this.records.get(callId);
		return record ? { ...record } : undefined;
	}

	/**
	 * 同会话里是否已有「同工具 + 同参数」的 pending（8c）。
	 *
	 * 用途：新形态下模型可能在同一轮里重试被挂起的调用（尤其 faux 这种不肯收尾的），
	 * 没有这道去重就会一屏同样的卡片。同工具 + 同指纹 = 同一件事，一张卡就够。
	 */
	findPending(conversationId: number, tool: string, argsHash: string): ApprovalRecord | undefined {
		if (!argsHash) return undefined;
		this.ensureLoaded();
		return [...this.records.values()].find(
			(record) =>
				record.conversationId === conversationId &&
				record.tool === tool &&
				record.argsHash === argsHash &&
				record.status === "pending",
		);
	}

	/**
	 * 核销一条放行：同会话 + 同工具 + 同参数指纹 → 删掉并返回 true。
	 * 不命中返回 false（换参数重发 = 重新审批）。空指纹永不命中。
	 */
	consumeGrant(conversationId: number, tool: string, argsHash: string): boolean {
		this.ensureLoaded();
		if (!argsHash) return false;
		const index = this.grants.findIndex(
			(grant) =>
				grant.conversationId === conversationId &&
				grant.tool === tool &&
				grant.argsHash === argsHash,
		);
		if (index < 0) return false;
		this.grants.splice(index, 1);
		this.persist();
		return true;
	}

	/** 还剩几条放行（单测与探针核销断言用；不含参数内容） */
	grantCount(conversationId?: number): number {
		this.ensureLoaded();
		return conversationId === undefined
			? this.grants.length
			: this.grants.filter((grant) => grant.conversationId === conversationId).length;
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

	/** 从状态文件读一次（只读文件，不清本进程状态） */
	private read(): void {
		let changed = false;
		const now = Date.now();
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as {
				approvals?: unknown;
				grants?: unknown;
			};
			const rows = Array.isArray(parsed.approvals) ? parsed.approvals : [];
			for (const raw of rows) {
				const record = normalize(raw);
				if (!record) continue;
				if (record.status === "pending") {
					// 新形态：保留可答（blocking 回滚在 load() 里另行结算）。
					// 记进 leftovers，等显式 expireLeftover 时才动它。
					this.leftovers.add(record.callId);
				} else if (now - (record.decidedAt ?? record.createdAt) > TERMINAL_TTL_MS) {
					changed = true;
					continue;
				}
				this.records.set(record.callId, record);
			}
			const grants = Array.isArray(parsed.grants) ? parsed.grants : [];
			for (const raw of grants) {
				const grant = normalizeGrant(raw);
				if (!grant) continue;
				if (now - grant.grantedAt > GRANT_TTL_MS) {
					changed = true;
					continue;
				}
				this.grants.push(grant);
			}
		} catch {
			// 文件不存在或坏了：当作没有审批，不影响启动
		}
		if (changed) this.persist();
	}

	/** blocking 回滚：把从文件读回来的 pending 按 timeout 结算（fail-closed） */
	private settleLeftovers(): void {
		if (this.leftovers.size === 0) return;
		const now = Date.now();
		let changed = false;
		for (const callId of this.leftovers) {
			this.leftovers.delete(callId);
			const record = this.records.get(callId);
			if (!record || record.status !== "pending") continue;
			record.status = "timeout";
			record.decidedAt = now;
			changed = true;
		}
		if (changed) this.persist();
	}

	private grant(record: ApprovalRecord): void {
		if (!record.argsHash) return;
		const exists = this.grants.some(
			(grant) =>
				grant.conversationId === record.conversationId &&
				grant.tool === record.tool &&
				grant.argsHash === record.argsHash,
		);
		if (exists) return;
		this.grants.push({
			callId: record.callId,
			conversationId: record.conversationId,
			tool: record.tool,
			argsHash: record.argsHash,
			grantedAt: Date.now(),
		});
	}

	private dropGrants(conversationId: number): number {
		let dropped = 0;
		for (let index = this.grants.length - 1; index >= 0; index -= 1) {
			if (this.grants[index]?.conversationId !== conversationId) continue;
			this.grants.splice(index, 1);
			dropped += 1;
		}
		return dropped;
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
			// 放行清单同款：批了却一直没重发的，过一天作废
			const grantCutoff = Date.now() - GRANT_TTL_MS;
			for (let index = this.grants.length - 1; index >= 0; index -= 1) {
				if ((this.grants[index]?.grantedAt ?? 0) < grantCutoff) this.grants.splice(index, 1);
			}
			const approvals = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
			const grants = [...this.grants].sort((a, b) => a.grantedAt - b.grantedAt);
			writeFileSync(this.path, `${JSON.stringify({ version: 1, approvals, grants }, null, 2)}\n`);
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
