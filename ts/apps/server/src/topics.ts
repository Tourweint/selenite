import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nextCronFire } from "./cron.ts";
import { searchConfigured } from "./search.ts";

/**
 * 课题存储 + 纯逻辑（2026-11-07 长期课题跟进 §二）。
 *
 * 范式照 `routines.ts`：单文件（`.data/topics.json`，`TOPICS_STATE_PATH` 可覆盖），
 * 临时文件 + `renameSync` 原子替换，坏文件当空账；首次访问才读盘（进程启动不碰 .data）。
 *
 * 这里只做"户口本"：课题 / 提议 / 发现日志 / 状态机。
 * 排程（durable 闹钟）在 `topic-runtime.ts`，HTTP 形状在 `topic-api.ts`——
 * 课题不进记忆引擎，发现日志是课题私产，靠系统提示摘要给总管看。
 */

export const TOPICS_STATE_DEFAULT_PATH = ".data/topics.json";
export const TOPIC_MAX = 5;
export const TOPIC_PROPOSAL_TTL_MS = 72 * 60 * 60_000;
export const TOPIC_DEFAULT_CRON = "0 9 * * 1";

/** 回滚开关（照 tools.ts 的 envFlag 口径：只有明确 false/0 才关）。 */
export const TOPICS_ENABLED = (() => {
	const raw = process.env.TOPICS_ENABLED?.trim().toLowerCase();
	return !raw || (raw !== "false" && raw !== "0");
})();

export type TopicFlavor = "watch" | "dig";
export type TopicStatus = "active" | "paused" | "closed";
export type TopicOrigin = "user" | "proposal";
export type ProposalStatus = "pending" | "accepted" | "declined" | "expired";

export interface TopicFinding {
	id: string;
	/** YYYY-MM-DD */
	date: string;
	summary: string;
	body: string;
	noNew: boolean;
	runConversationId?: string;
}

export interface Topic {
	id: string;
	question: string;
	flavor: TopicFlavor;
	cron: string;
	status: TopicStatus;
	/** 任何 patch +1；在飞的 durable 任务醒来对不上号就作废 */
	revision: number;
	origin: TopicOrigin;
	findings: TopicFinding[];
	pendingPush: boolean;
	noNewStreak: number;
	lastRunAt?: string;
	lastError?: string;
	createdAt: string;
	closedAt?: string;
	closeReason?: string;
}

export interface TopicProposal {
	id: string;
	question: string;
	flavor: TopicFlavor;
	cron: string;
	origin: TopicOrigin;
	status: ProposalStatus;
	createdAt: string;
	/** 72h 未理 = expired（防僵尸卡） */
	expiresAt: string;
	decidedAt?: string;
}

interface TopicsState {
	version: 1;
	topics: Topic[];
	proposals: TopicProposal[];
}

function emptyState(): TopicsState {
	return { version: 1, topics: [], proposals: [] };
}

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeQuestion(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function validFlavor(value: unknown): value is TopicFlavor {
	return value === "watch" || value === "dig";
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/** 给提示词 / 列表用的本地时间（不带秒，够读）。 */
export function formatTopicWhen(date: Date): string {
	return (
		`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
		`${pad2(date.getHours())}:${pad2(date.getMinutes())}`
	);
}

/** 课题下一次触发；cron 非法 / 扫不到返回 null。 */
export function nextTopicFire(topic: Topic, from: Date = new Date()): Date | null {
	return nextCronFire(topic.cron, from);
}

export type ProposeTopicInput = {
	question: string;
	flavor: TopicFlavor;
	cron?: string;
	origin: TopicOrigin;
};

export type ProposeTopicResult =
	| { ok: true; proposal: TopicProposal }
	| {
			ok: false;
			reason: "exists" | "limit" | "search_not_configured" | "invalid";
			existingTopicId?: string;
			message: string;
	  };

export type AcceptProposalResult =
	| { ok: true; topic: Topic }
	| {
			ok: false;
			reason: "not_found" | "expired" | "search_not_configured" | "limit" | "exists";
			existingTopicId?: string;
			message: string;
	  };

export type TopicPatchResult =
	| { ok: true; topic: Topic }
	| { ok: false; reason: "not_found" | "bad_cron" | "bad_status" };

export class TopicsStore {
	private state: TopicsState = emptyState();
	private stateLoaded = false;
	private readonly statePath: string;

	constructor(statePath?: string) {
		this.statePath = statePath?.trim() || process.env.TOPICS_STATE_PATH?.trim() || TOPICS_STATE_DEFAULT_PATH;
	}

	// ── 状态文件（原子写；坏文件当空账）──
	private load(): TopicsState {
		if (this.stateLoaded) return this.state;
		this.stateLoaded = true;
		if (!existsSync(this.statePath)) return this.state;
		try {
			const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<TopicsState>;
			this.state = {
				version: 1,
				topics: Array.isArray(parsed.topics) ? parsed.topics.filter(isTopicLike) : [],
				proposals: Array.isArray(parsed.proposals)
					? parsed.proposals.filter(isProposalLike)
					: [],
			};
		} catch {
			this.state = emptyState();
		}
		return this.state;
	}

	private save(): void {
		mkdirSync(dirname(this.statePath), { recursive: true });
		const tmp = `${this.statePath}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
		try {
			renameSync(tmp, this.statePath);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				/* 清理失败就算了 */
			}
			throw error;
		}
	}

	// ── 读 ──
	list(): Topic[] {
		return [...this.load().topics];
	}

	/** 进行中（active + paused）：上限与查重都按它算。 */
	listOngoing(): Topic[] {
		return this.load().topics.filter((topic) => topic.status !== "closed");
	}

	listActive(): Topic[] {
		return this.load().topics.filter((topic) => topic.status === "active");
	}

	get(id: string): Topic | null {
		return this.load().topics.find((topic) => topic.id === id) ?? null;
	}

	getProposal(id: string): TopicProposal | null {
		return this.load().proposals.find((proposal) => proposal.id === id) ?? null;
	}

	// ── 提议 ──
	/**
	 * 提交一条待确认提议（**永不在这里建课题**）。
	 *
	 * 硬前提：搜索没配置就开不了课题（方案 S4）——没有搜索的"每周研究"是纯推理瞎说。
	 */
	proposeTopic(input: ProposeTopicInput): ProposeTopicResult {
		this.expireProposals();
		if (!searchConfigured()) {
			return {
				ok: false,
				reason: "search_not_configured",
				message: "搜索还没配置：去 设置 → 模型 → 搜索 添加一个搜索源。",
			};
		}
		const question = normalizeQuestion(input.question);
		if (!question || question.length > 200) {
			return { ok: false, reason: "invalid", message: "question 需要是一句不超过 200 字的话" };
		}
		const cron = (input.cron?.trim() || TOPIC_DEFAULT_CRON).replace(/\s+/g, " ");
		if (nextCronFire(cron, new Date()) === null) {
			return { ok: false, reason: "invalid", message: "cron 表达式看不懂（需要 5 段：分 时 日 月 周）" };
		}
		const existing = this.load().topics.find(
			(topic) => topic.status !== "closed" && normalizeQuestion(topic.question) === question,
		);
		if (existing) {
			return {
				ok: false,
				reason: "exists",
				existingTopicId: existing.id,
				message: "这个课题已经在跟了，不用重复提。",
			};
		}
		if (this.listOngoing().length >= TOPIC_MAX) {
			return {
				ok: false,
				reason: "limit",
				message: `在跟的课题最多 ${TOPIC_MAX} 个，先关掉一个再提。`,
			};
		}
		const now = Date.now();
		const proposal: TopicProposal = {
			id: randomUUID(),
			question,
			flavor: validFlavor(input.flavor) ? input.flavor : "watch",
			cron,
			origin: input.origin === "user" ? "user" : "proposal",
			status: "pending",
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + TOPIC_PROPOSAL_TTL_MS).toISOString(),
		};
		this.load().proposals.push(proposal);
		this.save();
		return { ok: true, proposal };
	}

	/**
	 * 确认提议 → 建课题。
	 *
	 * 排程**不在存储层做**：调用方（topic-runtime）建好后 ensureScheduled。
	 */
	acceptProposal(id: string): AcceptProposalResult {
		this.expireProposals();
		const proposal = this.getProposal(id);
		if (!proposal) return { ok: false, reason: "not_found", message: "提议不存在" };
		if (proposal.status === "expired") {
			return { ok: false, reason: "expired", message: "这条提议已经过期了，重新提一次吧。" };
		}
		if (proposal.status !== "pending") {
			return { ok: false, reason: "not_found", message: "提议已经处理过了" };
		}
		if (!searchConfigured()) {
			return {
				ok: false,
				reason: "search_not_configured",
				message: "搜索还没配置：去 设置 → 模型 → 搜索 添加一个搜索源。",
			};
		}
		const duplicated = this.load().topics.find(
			(topic) =>
				topic.status !== "closed" &&
				normalizeQuestion(topic.question) === normalizeQuestion(proposal.question),
		);
		if (duplicated) {
			return {
				ok: false,
				reason: "exists",
				existingTopicId: duplicated.id,
				message: "这个课题已经在跟了，不用重复建。",
			};
		}
		if (this.listOngoing().length >= TOPIC_MAX) {
			return {
				ok: false,
				reason: "limit",
				message: `在跟的课题最多 ${TOPIC_MAX} 个，先关掉一个再建。`,
			};
		}
		const now = nowIso();
		const topic: Topic = {
			id: randomUUID(),
			question: proposal.question,
			flavor: proposal.flavor,
			cron: proposal.cron,
			status: "active",
			revision: 1,
			origin: proposal.origin,
			findings: [],
			pendingPush: false,
			noNewStreak: 0,
			createdAt: now,
		};
		this.load().topics.push(topic);
		proposal.status = "accepted";
		proposal.decidedAt = now;
		this.save();
		return { ok: true, topic };
	}

	declineProposal(id: string): boolean {
		const proposal = this.getProposal(id);
		if (!proposal || proposal.status !== "pending") return false;
		proposal.status = "declined";
		proposal.decidedAt = nowIso();
		this.save();
		return true;
	}

	/** 扫描 pending 且过 72h → expired；读路径可顺带调（幂等）。 */
	expireProposals(): number {
		const now = Date.now();
		let changed = 0;
		for (const proposal of this.load().proposals) {
			if (proposal.status !== "pending") continue;
			if (Date.parse(proposal.expiresAt) > now) continue;
			proposal.status = "expired";
			proposal.decidedAt = new Date(now).toISOString();
			changed += 1;
		}
		if (changed > 0) this.save();
		return changed;
	}

	// ── 课题状态 ──
	appendFinding(
		topicId: string,
		input: {
			summary: string;
			body: string;
			noNew: boolean;
			runConversationId?: string;
		},
	): TopicFinding | null {
		const topic = this.get(topicId);
		if (!topic) return null;
		const now = new Date();
		const finding: TopicFinding = {
			id: randomUUID(),
			date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
			summary: input.summary.slice(0, 200),
			body: input.body,
			noNew: input.noNew,
			...(input.runConversationId ? { runConversationId: input.runConversationId } : {}),
		};
		topic.findings.unshift(finding);
		topic.pendingPush = true;
		topic.noNewStreak = input.noNew ? topic.noNewStreak + 1 : 0;
		topic.lastRunAt = now.toISOString();
		delete topic.lastError;
		this.save();
		return finding;
	}

	markPushed(topicId: string): void {
		const topic = this.get(topicId);
		if (!topic || !topic.pendingPush) return;
		topic.pendingPush = false;
		this.save();
	}

	/** 渲染即视为已通知：取走攒着的简报并一次性清空（每课题每次活跃只报一次）。 */
	drainPendingPushes(): Topic[] {
		const pending = this.load().topics.filter((topic) => topic.pendingPush);
		if (pending.length === 0) return [];
		for (const topic of pending) topic.pendingPush = false;
		this.save();
		return pending.map((topic) => ({ ...topic, findings: [...topic.findings] }));
	}

	setLastError(topicId: string, error: string): void {
		const topic = this.get(topicId);
		if (!topic) return;
		topic.lastError = error;
		this.save();
	}

	patch(id: string, input: { cron?: string; status?: TopicStatus }): TopicPatchResult {
		const topic = this.get(id);
		if (!topic) return { ok: false, reason: "not_found" };
		if (input.status !== undefined && input.status !== "active" && input.status !== "paused") {
			return { ok: false, reason: "bad_status" };
		}
		if (input.cron !== undefined) {
			const cron = input.cron.trim().replace(/\s+/g, " ");
			if (!cron || nextCronFire(cron, new Date()) === null) {
				return { ok: false, reason: "bad_cron" };
			}
			topic.cron = cron;
		}
		if (input.status !== undefined) {
			topic.status = input.status;
			if (input.status === "active") {
				delete topic.closedAt;
				delete topic.closeReason;
			}
		}
		topic.revision += 1;
		this.save();
		return { ok: true, topic };
	}

	close(id: string, reason?: string): Topic | null {
		const topic = this.get(id);
		if (!topic) return null;
		if (topic.status !== "closed") {
			topic.status = "closed";
			topic.revision += 1;
			topic.pendingPush = false;
			topic.closedAt = nowIso();
			const text = reason?.trim();
			if (text) topic.closeReason = text.slice(0, 200);
			else delete topic.closeReason;
			this.save();
		}
		return topic;
	}

	// ── 提示词摘要 ──
	/**
	 * 给 agent section 用的紧凑清单：题目 / 口味 / 下次研究时间 / 最新发现一句。
	 * 只列 active 课题（paused 的不会跑，没必要每轮提醒）。
	 */
	digestForInjection(from: Date = new Date()): string {
		const active = this.listActive();
		if (active.length === 0) return "";
		return active
			.map((topic) => {
				const next = nextTopicFire(topic, from);
				const when = next ? formatTopicWhen(next) : "未排";
				const flavor = topic.flavor === "watch" ? "盯梢" : "啃题";
				const latest = topic.findings[0];
				const tail = latest ? `最新：${latest.summary.slice(0, 60)}` : "还没有发现";
				return `- ${topic.question} · ${flavor} · 下次 ${when} · ${tail}`;
			})
			.join("\n");
	}
}

function isTopicLike(value: unknown): value is Topic {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.question === "string" &&
		(row.flavor === "watch" || row.flavor === "dig") &&
		typeof row.cron === "string" &&
		(row.status === "active" || row.status === "paused" || row.status === "closed") &&
		typeof row.revision === "number" &&
		Array.isArray(row.findings)
	);
}

function isProposalLike(value: unknown): value is TopicProposal {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.question === "string" &&
		(row.flavor === "watch" || row.flavor === "dig") &&
		typeof row.cron === "string" &&
		(row.status === "pending" ||
			row.status === "accepted" ||
			row.status === "declined" ||
			row.status === "expired") &&
		typeof row.createdAt === "string" &&
		typeof row.expiresAt === "string"
	);
}

// ── 单例（风格照 partnersStore / projectsStore：进程启动不碰磁盘）──
let store: TopicsStore | null = null;

export function topicsStore(): TopicsStore {
	store ??= new TopicsStore();
	return store;
}
