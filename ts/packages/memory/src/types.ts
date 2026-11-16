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
	/** 某一天：记录类内容的基本单位，每天自然收敛 */
	| { type: "day"; date: string } // YYYY-MM-DD
	/** 某个主题：健康、工作、某个人 */
	| { type: "topic"; name: string }
	/** 某次会话：原始对话，最易过期 */
	| { type: "session"; id: string }
	/**
	 * 某个伙伴的独立键空间（2026-11-05 批次B B1）。
	 *
	 * 伙伴记忆与主人的记忆**键空间完全隔离**：同一套存储/索引/召回，key 不同互不可见。
	 * id 是伙伴对外 uuid（partners 表主键），encode 是防 uuid 里的字符捣乱（现 uuid 安全，防御性保留）。
	 */
	| { type: "partner"; id: string }
	/**
	 * 某个登记项目的独立键空间（2026-11-15 项目记忆方案）。
	 *
	 * id 是项目库（projects.sqlite）里项目的 uuid：项目记忆跟着**已登记的项目**走，
	 * 不建平行体系。项目软删记忆保留；项目移除后 scope 成孤儿——不可见即无害。
	 * 召回只在"会话归属该项目"时把这条 scope 加进候选（见 server 的 recallContext），
	 * 所以项目记忆不会打扰其它会话。
	 */
	| { type: "project"; id: string };

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
		case "partner":
			return `partner:${encodeURIComponent(scope.id)}`;
		case "project":
			return `project:${scope.id}`;
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
	| "entity"
	/**
	 * 工作履历（2026-11-08 员工人格化刀二 E2，append-only 台账）。
	 *
	 * 每单结算落一条，只增不改：巩固不合并、召回不返回、时间衰减不作用、
	 * 按 scope 封顶 200 条删最旧。执事轮装配与盘点走结构化查询（scope+kind），
	 * 不走语义召回。与另外四种语义零交叉，旧数据天然兼容。
	 */
	| "work"
	/**
	 * 前瞻意图（2026-11-09 T4 §3）："我打算下周开始跑步"。
	 *
	 * 与 fact 的区别在**时态**：它有 `expiresAt`，过期后原地降级为 `fact`（不删），
	 * 未过期时在注入里单独成组、优先于普通事实。降级是读时惰性的（见 engine.recall），
	 * 不建定时器。巩固不合并、时间衰减不作用（与 `work` 同待遇）。
	 */
	| "intention"
	/**
	 * 经验层（2026-11-10 批 17 §一）：「这类活下次可以怎么做」。
	 *
	 * 与 `work` 的分工：work 是**发生过什么**的 append-only 台账（不进召回）；
	 * experience 是**下次怎么做**的可复用做法，进召回、不参与时间衰减（经验不该过期）、
	 * 参与巩固合并（同 scope 规范化等价的经验可合并——与 work 相反）。
	 * 写入只发生在派单 `done` 且过价值门槛时（见 server 的 work-record.ts），宁缺毋滥。
	 */
	| "experience"
	/**
	 * 印象（2026-11-15 员工人格模块批2）：伙伴对**某个对象**的印象分条。
	 *
	 * 与 `fact` 的区别是**带对象维度**（正文 JSON 的 `subject`：`owner` 或群成员 id）
	 * 以及"只由结算钩子 / 人手写、模型不可伪造"（`remember` 工具的 kind 枚举不含它）。
	 * 与 `work` 同待遇：append-only、不进语义召回、不衰减、不参与巩固合并；
	 * 读取走 `store.search({scopes, kinds:["impression"]})` 的结构化查询，
	 * 单对象 20 条封顶由写入点（server 的 partner-living.ts）自己修剪。
	 */
	| "impression";

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
	/**
	 * 意图的失效时间（ISO，2026-11-09 T4 §3）。只有 `kind === "intention"` 有意义；
	 * 过了这个时刻，读取路径把它原地降级为 `fact`（保留记录与演化链）。
	 */
	expiresAt?: string | null;
	/** 被哪条记忆取代。不删旧记录，保留可追溯的演化链 */
	supersededBy: string | null;
	/** 召回次数与最近一次召回时间，用于强化 */
	recallCount: number;
	lastRecalledAt: string | null;
	/**
	 * 使用次数与最近使用时间（2026-11-10 批 17 §三）。
	 *
	 * 与 `recallCount` 的区别：那是「被召回」的旧账（时间衰减的锚点也跟着它走），
	 * 这里只服务于**巩固时的保留优先级排序**（使用越多越该留）。召回命中时两者一起 +1。
	 * 可选字段：老数据没有这两列，读出来按 0 / null 处理。
	 */
	usageCount?: number;
	lastUsedAt?: string | null;
	/**
	 * 原文档案 id（2026-11-16 记忆原子化）。
	 *
	 * 非空 = 这条记录是从一份原文里拆出来的原子事实；`quote` 是原文里的逐字依据。
	 * 原文本体在 `memory_documents`，默认不进召回；原子记录才进召回。
	 */
	docId?: string | null;
	/** 原文里的逐字引文（必须能在 document.content 里找到）。 */
	quote?: string | null;
	/** 引文在原文里的字符偏移（可空；有就用于高亮/核对）。 */
	quoteStart?: number | null;
	quoteEnd?: number | null;
	/**
	 * 归档时间（2026-11-16）。
	 *
	 * 非空 = 这条记录不再参与召回与默认列表，但仍保留可查。
	 * 与 `supersededBy` 的分工：superseded 是"被另一条取代"；archived 是"被拆开/退役"。
	 * 长记录拆成原子后，原记录走 archived，不删除。
	 */
	archivedAt?: string | null;
}

/**
 * 原文档案（2026-11-16 记忆原子化）。
 *
 * 长文不是记忆：导入的记忆文件、项目 changelog、一次长对话的整理稿都放这里。
 * 默认不进召回；记忆页可看、可核对、可重新拆。原子记录通过 `docId` 指回它。
 */
export interface MemoryDocument {
	id: string;
	scope: string;
	title: string;
	content: string;
	/** 来源：`import:<sourceId>` / `conversation` / `manual` … */
	source: string;
	/** 文件路径 / 会话 id / 轮次等可回查指针 */
	sourceRef: string | null;
	sha256: string | null;
	chars: number;
	createdAt: string;
	updatedAt: string | null;
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
	/** 仅 intention 使用（2026-11-09 T4 §3）。 */
	expiresAt?: string | null;
}

export interface RecallQuery {
	/** 要召回给谁看：本次对话的上下文 */
	text: string;
	/** 优先从这里找 */
	scopes: string[];
	/**
	 * 闸门 scopes（2026-11-15 项目记忆多挂载）：只从「字面命中」路径进候选、
	 * 不吃最近窗口，且候选须与 text 直接字面相关（复用「也许值得提起」同款判据）；
	 * text 为空 / 切不出关键词时一律不贡献。"聊到才注入"由这层保证，
	 * 不靠打分巧合。与 scopes 重复的 key 以更严的 gated 为准（防御，调用方应传不相交两列）。
	 */
	gatedScopes?: string[];
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
	/**
	 * 是否渲染「也许值得提起」分组（2026-11-10 批 17 §二）。
	 *
	 * 默认 false —— 这是"主动开口"类能力，先观望。只有总管主对话装配层会传 true
	 * （执事轮不传：避免执事跑题）。开关落在 server 的 env，这一层不读环境变量。
	 */
	proactive?: boolean;
	/**
	 * 项目归属标注（2026-11-15 项目记忆多挂载）：入参是记录的 scope key
	 * （只有 `project:` 前缀的会来问），返回要显示的名字；返回 null / 不传 =
	 * 不标注（输出与旧格式逐字节兼容）。engine 不认识项目库，名字由装配层解析。
	 */
	scopeLabel?: (scopeKey: string) => string | null;
	/**
	 * 召回后去重（2026-11-15 上下文预算批）：同一件事的多种说法只保留分数最高的
	 * 那条进注入。默认 false = 库层旧行为；server 装配处按 `MEMORY_INJECT_DEDUPE`
	 * 传 true（默认开）。只影响本轮注入，不动库。
	 */
	dedupe?: boolean;
}

export interface RememberInput {
	kind: MemoryKind;
	scope: MemoryScope;
	content: string;
	importance?: number;
	veracity?: Veracity;
	source?: string;
	validUntil?: string | null;
	/** 仅 intention 使用（2026-11-09 T4 §3）。 */
	expiresAt?: string | null;
}
