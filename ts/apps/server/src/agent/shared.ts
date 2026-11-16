import { existsSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { currentProjectEnabled, projectsStore, type Project } from "../projects.ts";

export const CTX = BACKGROUND_CONTEXT;

export const DB_PATH = process.env.AGENT_DB_PATH?.trim() || ".data/agent.sqlite";
/** 工具读写文件的基准目录。默认是服务进程的工作目录 */
const WORKDIR = process.env.AGENT_WORKDIR?.trim() || process.cwd();

/**
 * 当前项目（2026-11-04 侧边栏方案 §2.2/§2.3）：**每轮现读 store，不缓存**。
 * 切换后下一轮自然生效；目录没了/移出工作区时 getCurrentProject() 返回 null，
 * cwd 与系统提示回到主工作区形态。`CURRENT_PROJECT=false` 时整体旁路。
 */
export function currentProject(): Project | null {
	if (!currentProjectEnabled()) return null;
	try {
		return projectsStore().getCurrentProject();
	} catch {
		// 项目存储坏了不该让对话失败：退回主工作区
		return null;
	}
}

/**
 * 会话 cwd 的进程内缓存（2026-11-13 会话绑定即快照）。
 *
 * 真源是 `pi.agent.cwd`——新建会话时写死，之后换主文件夹也不动（老会话留在原地）。
 * 这里只是它的同步副本：内核每轮构建 env 都会把 `cwd` 交过来（`node/../../agent/lifecycle.ts`
 * 的 `env` 工厂），我们顺手记一笔，于是重启后第一轮就把缓存回填了。
 */
const sessionCwds = new Map<number, string>();

export function noteSessionCwd(conversationId: number | string, cwd?: string | null): void {
	const key = Number(conversationId);
	if (!Number.isFinite(key)) return;
	const value = typeof cwd === "string" ? cwd.trim() : "";
	if (!value) {
		sessionCwds.delete(key);
		return;
	}
	sessionCwds.set(key, value);
}

/**
 * 本轮会话执行环境的 cwd（2026-11-13 会话快照；2026-11-16 补工作区兜底）：
 * 1. 这个会话创建时钉下的项目主文件夹（快照优先，换主文件夹不影响老会话）；
 * 2. 没绑定项目的会话（杂事态 / 总管 / 改动前的旧会话）→ **主工作区根**
 *    （用户拍板：普通对话带项目记忆，没选项目就落 <主工作区> 这类默认目录）；
 * 3. 再没有 → `AGENT_WORKDIR`。
 * 快照目录没了（项目硬删 / 盘符变了）就回落，别把失效路径带进下一轮。
 */
export function sessionCwd(conversationId?: number | string): string {
	if (conversationId !== undefined) {
		const key = Number(conversationId);
		const bound = Number.isFinite(key) ? sessionCwds.get(key) : undefined;
		if (bound && existsSync(bound)) return bound;
	}
	const projectRoot = currentProject()?.rootPath;
	if (projectRoot && existsSync(projectRoot)) return projectRoot;
	try {
		const workspace = projectsStore().getWorkspace();
		if (workspace?.rootPath && existsSync(workspace.rootPath)) return workspace.rootPath;
	} catch {
		// 项目库坏了退回进程工作目录（与 currentProject() 的降级口径一致）
	}
	return WORKDIR;
}

/** 会话绑定的项目（快照的文件夹，用于注入清单）；没有绑定返回 null。 */
export function sessionBoundCwd(conversationId?: number | string): string | null {
	if (conversationId === undefined) return null;
	const key = Number(conversationId);
	const bound = Number.isFinite(key) ? sessionCwds.get(key) : undefined;
	return bound && existsSync(bound) ? bound : null;
}

// ── 对外会话 id ↔ 内部会话 id ────────────────────────────
/**
 * durable 的会话 id 是存储自增的整数，猜得到。
 * 所以对外的 id 仍是服务端生成的 uuid，存在这个 session 文档里做映射 ——
 * "id 不可猜"这条性质必须保住，否则谁都能编一个数字去读别人的历史。
 */
/**
 * 任务会话的 id 前缀（2026-10-31，与 `openai-compat.ts` 的 `X-Task` 通道约定）。
 *
 * 定义在这里是因为 `listChats` 要用它过滤——任务会话不该出现在"历史对话"列表里：
 * 它们的首句是"请整理成稿"这种**指令**，不是用户说过的话，混进列表只会让人莫名其妙。
 * 正文照旧能按 id 回读（`GET /api/v1/agent/chat/:id/messages`），只是不露头。
 */
export const TASK_CONVERSATION_PREFIX = "task-";

export const Chats = defineDoc<{ byExternal: Record<string, number> }>({
	kind: "lifediary.chats",
	version: 1,
	scope: "session",
	initial: () => ({ byExternal: {} }),
	checkpointWhen: () => false,
});

/**
 * 会话种类表（2026-11-06 侧栏调整 B2）：durable 内部会话 id → `chief | worker`。
 *
 * 为什么放 durable 而不是前端/本地文件：身份要跨刷新、跨标签页、跨重启稳定，
 * 且不能被客户端自报（否则"普通会话"只是一句 UI 文案）。存在内部 id 上，
 * 与对外 uuid 解耦——id 映射换实现时这张表不用动。
 *
 * 缺项 = 这次改动之前建的旧会话 = `chief`（默认仍是总管，手机与旧调用方零改动）。
 */
export const ChatKinds = defineDoc<{ byInternal: Record<string, "chief" | "worker"> }>({
	kind: "lifediary.chat-kinds",
	version: 1,
	scope: "session",
	initial: () => ({ byInternal: {} }),
	checkpointWhen: () => false,
});

/**
 * 会话的项目归属（2026-11-12 归档模块方案 §5）：durable 内部会话 id → 项目 uuid。
 *
 * 只在 `openChat` 新建**普通会话**（`chatKind=worker`）且当时有当前项目时写，
 * 与 `Chats` / `ChatKinds` 在同一个 init 事务里落盘（不会出现"会话建好了但归属没记上"）。
 * 执事 / 群（`partner-`）、任务（`task-`）、OpenAI 兼容自动建会话**不记**。
 *
 * 缺项 = 本次改动之前建的旧会话，没有归属（旧数据不回溯、不按目录猜）；
 * 存的是项目 uuid，项目改名不影响；项目硬删除会留下悬空 id，归档页查不到名字就不显示标签。
 */
export const ChatProjects = defineDoc<{ byInternal: Record<string, string> }>({
	kind: "lifediary.chat-projects",
	version: 1,
	scope: "session",
	initial: () => ({ byInternal: {} }),
	checkpointWhen: () => false,
});

export interface ResolvedChat {
	conversation: Conversation;
	/** 对外 id，客户端存的是这个 */
	externalId: string;
	/** 存储内部 id，记忆作用域用它（稳定，且不对客户端暴露） */
	internalId: number;
}

/** 一轮里的两个可见阶段：在想 / 在动手（工具执行中） */
export type TurnPhase = "thinking" | "working";

/** 每个会话的"当前阶段"订阅者（由 chatStream 注册，工具钩子往里推） */
const phaseSinks = new Map<number, Set<(phase: TurnPhase) => void>>();

export function watchPhase(
	conversationId: number,
	sink: (phase: TurnPhase) => void,
): () => void {
	let set = phaseSinks.get(conversationId);
	if (!set) {
		set = new Set();
		phaseSinks.set(conversationId, set);
	}
	set.add(sink);
	return () => {
		set.delete(sink);
		if (set.size === 0) phaseSinks.delete(conversationId);
	};
}

// ── 全局事件口（2026-11-05 批次B B3）：例行任务引擎的触发源之一 ──
export interface GlobalAgentEvent {
	conversationId: number;
	kind: "phase" | "tool";
	phase?: TurnPhase;
	tool?: ToolEvent;
}
const globalEventSinks = new Set<(event: GlobalAgentEvent) => void>();

export function watchAllEvents(sink: (event: GlobalAgentEvent) => void): () => void {
	globalEventSinks.add(sink);
	return () => {
		globalEventSinks.delete(sink);
	};
}

function emitGlobalAgent(event: GlobalAgentEvent): void {
	for (const sink of globalEventSinks) {
		try {
			sink(event);
		} catch {
			/* 观察方异常不影响主链路 */
		}
	}
}

export function emitPhase(conversationId: number, phase: TurnPhase): void {
	emitGlobalAgent({ conversationId, kind: "phase", phase });
	const set = phaseSinks.get(conversationId);
	if (!set) return;
	for (const sink of set) {
		try {
			sink(phase);
		} catch {
			/* 订阅方异常不该影响工具执行 */
		}
	}
}

/** 一次工具调用的起止（由 beforeTool / afterTool 钩子推，chatStream 取出去） */
export interface ToolEvent {
	name: string;
	status: "start" | "end";
	label?: string;
	ok?: boolean;
	output?: string;
	args?: string;
	/** 编辑类工具的 unified diff（2026-11-10 批 33，截断到 2000 字符）；只有 edit 这类有 details.diff 的工具才有 */
	diff?: string;
}

/** 参数也截断：`write` 的 content 可能是整个文件，塞进事件里会把流撑爆 */
const TOOL_ARGS_LIMIT = 1200;

export function toolArgs(args: unknown): { args?: string } {
	if (!args || typeof args !== "object") return {};
	const trimmed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		if (typeof value === "string" && value.length > 200) {
			trimmed[key] = `${value.slice(0, 200)}…（共 ${value.length} 字符）`;
		} else {
			trimmed[key] = value;
		}
	}
	let text: string;
	try {
		text = JSON.stringify(trimmed, null, 2);
	} catch {
		return {};
	}
	if (text.length > TOOL_ARGS_LIMIT) {
		text = `${text.slice(0, TOOL_ARGS_LIMIT)}\n…`;
	}
	return { args: text };
}

/**
 * 工具结果的截断上限。
 *
 * 2000 字符 ≈ 一屏多一点，够看清「命令输出了什么 / 文件头长什么样」；
 * 再长就该去磁盘上看了，塞进事件里只会把流撑大。
 */
export const TOOL_OUTPUT_LIMIT = 2000;

export function toolOutput(result: { output?: unknown }): { output?: string } {
	// output 是 (TextContent | ImageContent)[]，只取文字；图片不进状态条
	const text = contentText((result.output ?? []) as never).trim();
	if (!text) return {};
	return {
		output:
			text.length > TOOL_OUTPUT_LIMIT
				? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n…（还有 ${text.length - TOOL_OUTPUT_LIMIT} 字符）`
				: text,
	};
}

/** 编辑类工具的 unified diff（2026-11-10 批 33）：与 session.ts 的 stepDiff 同口径，供 tool 事件与历史 steps 两边一致 */
export function toolDiff(result: unknown): { diff?: string } {
	const details = (result as { details?: unknown } | null | undefined)?.details;
	if (!details || typeof details !== "object") return {};
	const diff = (details as { diff?: unknown }).diff;
	if (typeof diff !== "string" || !diff.trim()) return {};
	return {
		diff:
			diff.length > TOOL_OUTPUT_LIMIT
				? `${diff.slice(0, TOOL_OUTPUT_LIMIT)}\n…（还有 ${diff.length - TOOL_OUTPUT_LIMIT} 字符）`
				: diff,
	};
}

const toolSinks = new Map<number, Set<(event: ToolEvent) => void>>();

export function watchTool(conversationId: number, sink: (event: ToolEvent) => void): () => void {
	let set = toolSinks.get(conversationId);
	if (!set) {
		set = new Set();
		toolSinks.set(conversationId, set);
	}
	set.add(sink);
	return () => {
		set.delete(sink);
		if (set.size === 0) toolSinks.delete(conversationId);
	};
}

export function emitTool(conversationId: number, event: ToolEvent): void {
	emitGlobalAgent({ conversationId, kind: "tool", tool: event });
	const set = toolSinks.get(conversationId);
	if (!set) return;
	for (const sink of set) {
		try {
			sink(event);
		} catch {
			/* 订阅方异常不该影响工具执行 */
		}
	}
}

/**
 * 从工具参数里挑一个最能说明"在干什么"的值。
 *
 * 刻意不 dump 整个 arguments：里面有正文（remember 的记忆文本、write 的文件内容），
 * 界面上一行放不下，也不该把用户正文塞进状态条。挑不到就返回 undefined，
 * 客户端退回只显示工具名。
 */
export function toolLabel(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const values = args as Record<string, unknown>;
	const keys = [
		"path",
		"file_path",
		"filePath",
		"command",
		"query",
		"pattern",
		"requirement",
		"text",
		"url",
		"name",
	];
	for (const key of keys) {
		const value = values[key];
		if (typeof value !== "string") continue;
		const one = value.replace(/\s+/g, " ").trim();
		if (one) return one.length > 72 ? `${one.slice(0, 72)}…` : one;
	}
	return undefined;
}
