/**
 * 记忆的**框架层类型**。
 *
 * 这一层只定"有哪些概念、边界在哪"，不实现任何策略。
 * 以后换存储、换抽取算法、换召回排序，都只替换实现，不动这里。
 *
 * 概念来源（两份参考的共同抽象）：
 * - oh-my-pi/mnemopi：WorkingMemory → EpisodicMemory 两级，
 *   记录带 importance / veracity / validUntil / supersededBy / recallCount
 * - hermes-agent：内置 MEMORY.md + USER.md 两个极简文件，其余靠 provider 插件挂
 * 我们取两者的交集：**记录模型照 mnemopi，接入点照 hermes**。
 */

/** 记忆属于谁的地盘。个人 Agent 的作用域比 coding agent 更贴近时间。 */
export type MemoryScope =
	/** 跨时间稳定的：用户是谁、偏好、长期目标 */
	| { type: "global" }
	/** 某一天：日记的核心单位，每天自然收敛 */
	| { type: "day"; date: string } // YYYY-MM-DD
	/** 某个主题：健康、工作、某个人 */
	| { type: "topic"; name: string }
	/** 某次会话：原始对话，最易过期 */
	| { type: "session"; id: string };

export function scopeKey(scope: MemoryScope): string {
	switch (scope.type) {
		case "global":
			return "global";
		case "day":
			return `day:${scope.date}`;
		case "topic":
			return `topic:${scope.name}`;
		case "session":
			return `session:${scope.id}`;
	}
}

/** 记忆的形态。决定它以后怎么被召回、怎么过期。 */
export type MemoryKind =
	/** 从对话里提炼出的事实（"我养了一只叫豆豆的猫"） */
	| "fact"
	/** 一个事件/一段经历（"今天面试挂了"） */
	| "episode"
	/** 偏好与风格（"不喜欢被追问太多"） */
	| "preference"
	/** 人/地点/物（"豆豆"是猫） */
	| "entity";

/**
 * 可信度来源。参考 mnemopi 的 veracity：
 * 自己说的和别人推测的，价值完全不同，召回时必须能区分。
 */
export type Veracity = "stated" | "inferred" | "tool" | "imported" | "unknown";

export interface MemoryRecord {
	id: string;
	kind: MemoryKind;
	/** scopeKey() 的结果 */
	scope: string;
	content: string;
	/** 0..1，影响召回排序与淘汰顺序 */
	importance: number;
	veracity: Veracity;
	/** 谁写的：user / extract / import */
	source: string;
	createdAt: string;
	/** 过了这个时间就不该再被召回（临时状态类记忆） */
	validUntil: string | null;
	/** 被哪条记忆取代。不删旧记录，保留可追溯的演化链 */
	supersededBy: string | null;
	/** 召回次数与最近一次召回时间，用于强化 */
	recallCount: number;
	lastRecalledAt: string | null;
}

/** 抽取层产出、尚未入库的候选 */
export interface MemoryCandidate {
	kind: MemoryKind;
	scope: string;
	content: string;
	importance: number;
	veracity: Veracity;
	source: string;
	validUntil?: string | null;
}

export interface RecallQuery {
	/** 要召回给谁看：本次对话的上下文 */
	text: string;
	/** 优先从这里找 */
	scopes: string[];
	limit?: number;
	/** 只召回这个时间点之后创建的 */
	since?: string;
}

export interface RecallHit {
	record: MemoryRecord;
	score: number;
}

/** 注入结果的预算约束：prompt 里给记忆留多少字 */
export interface InjectOptions {
	maxChars?: number;
}

export interface RememberInput {
	kind: MemoryKind;
	scope: MemoryScope;
	content: string;
	importance?: number;
	veracity?: Veracity;
	source?: string;
	validUntil?: string | null;
}
