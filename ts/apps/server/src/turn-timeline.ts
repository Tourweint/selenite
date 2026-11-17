/**
 * 一轮对话的时间线账（2026-11-17，方案 docs/设计方案/2026-11-17-可观测与提交门禁.md）。
 *
 * 为什么有：排查「这一轮调了什么工具 / 被哪道闸拦了 / 跑了几回合 / 花了多少 token /
 * 最后怎么结束的」要翻 tool-usage、gate-blocks、usage、server.log 四本账做连线题。
 * 这里给每轮一个单号（复用 /chat 已发出的 SSE start/done.id，uuid），把所有节点
 * 按时间追加进一张 jsonl，再用 GET 端点按单号聚合成一条时间线。
 *
 * 关联方式：钩子（beforeTool/afterTool/beforeRequest）拿不到 /chat 的流 id，
 * 但都能拿到内部 conversationId（与 gate-audit 同一个值）。beginTurn 在 /chat 入口
 * 把 internalId → turnId 记进一张进程内小表，钩子按 internalId 反查。单会话一轮一跑
 *（忙时排队），不会并发覆盖；晚到的收尾钩子仍归给同一轮。表有上限，防无界增长。
 *
 * 硬约束（AGENTS.md）：只记枚举 / 计数 / 耗时 / 字数，**绝不记**工具参数、输出、
 * diff、对话正文、原始错误文案、密钥。对外单号用 uuid，内部整数 id 不进 GET 投影。
 *
 * 落点 `.data/turn-timeline.jsonl`（追加写，一行一个 JSON）。
 * 开关 `TURN_TIMELINE`：false / 0 / off → 一行不写、端点 404（一行回滚）。
 * 测试隔离用 `AGENT_TURN_TIMELINE_PATH` 指到临时目录（生产不设）。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type TimelineKind = "start" | "round" | "tool" | "gate" | "usage" | "done" | "error";

export interface TimelineEvent {
	/** 进程内严格递增的序号，读出来按它排序（同一毫秒多条也稳定）。 */
	n: number;
	at: string;
	turnId: string;
	/** 内部自增 id，仅落盘排障用，**不进 GET 投影**。 */
	conversationId: number;
	kind: TimelineKind;
	/** 工具名 / 闸门类别 / 错误类别（都是枚举或受控名，不含正文）。 */
	name?: string;
	ok?: boolean;
	/** 回合序号或 token 数（视 kind 而定）。 */
	count?: number;
	ms?: number;
	chars?: number;
}

/** 对外投影：剥掉内部 conversationId，只留可安全下发/展示的字段。 */
export interface TimelineEventView {
	at: string;
	kind: TimelineKind;
	name?: string;
	ok?: boolean;
	count?: number;
	ms?: number;
	chars?: number;
}

export function turnTimelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.TURN_TIMELINE ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

export function turnTimelinePath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_TURN_TIMELINE_PATH?.trim() || ".data/turn-timeline.jsonl");
}

/** internalId → turnId 的小表。上限 512，超出丢最早一条（Map 保持插入序）。 */
const ACTIVE_LIMIT = 512;
const activeTurns = new Map<number, string>();

/** /chat 入口登记本轮单号。 */
export function beginTurn(conversationId: number, turnId: string): void {
	if (!turnTimelineEnabled()) return;
	if (activeTurns.has(conversationId)) activeTurns.delete(conversationId);
	activeTurns.set(conversationId, turnId);
	while (activeTurns.size > ACTIVE_LIMIT) {
		const oldest = activeTurns.keys().next();
		if (oldest.done) break;
		activeTurns.delete(oldest.value);
	}
}

/** 供测试隔离：清空进程内关联表。生产不调用。 */
export function resetTurnTimelineForTest(): void {
	activeTurns.clear();
	lastN = 0;
}

let lastN = 0;
function nextN(): number {
	const now = Date.now();
	lastN = now > lastN ? now : lastN + 1;
	return lastN;
}

/**
 * 记一条时间线事件。`turnId` 显式给出优先；否则按 internalId 从关联表反查。
 * 反查不到（ autonomo / 派活等不经 /chat 的轮）就跳过——覆盖主聊天入口是本期范围。
 * 写失败只 warn，绝不挡住主流程。调用方负责不把正文带进来——这是纪律，不是接口保证。
 */
export function recordTimelineEvent(
	input: {
		turnId?: string;
		conversationId?: number;
		kind: TimelineKind;
		name?: string;
		ok?: boolean;
		count?: number;
		ms?: number;
		chars?: number;
	},
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!turnTimelineEnabled(env)) return;
	const turnId = input.turnId ?? (input.conversationId !== undefined ? activeTurns.get(input.conversationId) : undefined);
	if (!turnId) return;
	const entry: TimelineEvent = {
		n: nextN(),
		at: new Date().toISOString(),
		turnId,
		conversationId: input.conversationId ?? -1,
		kind: input.kind,
		...(input.name !== undefined ? { name: input.name.slice(0, 80) } : {}),
		...(input.ok !== undefined ? { ok: input.ok } : {}),
		...(input.count !== undefined ? { count: Math.floor(input.count) } : {}),
		...(input.ms !== undefined ? { ms: Math.floor(input.ms) } : {}),
		...(input.chars !== undefined ? { chars: Math.floor(input.chars) } : {}),
	};
	const path = turnTimelinePath(env);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		console.warn(
			`[turn-timeline] 写 ${path} 失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** 按单号聚合时间线：读出该轮所有行，按序号升序。坏行跳过（旁路账，坏了不挡查询）。 */
export function readTurnTimeline(turnId: string, env: NodeJS.ProcessEnv = process.env): TimelineEventView[] {
	let text: string;
	try {
		text = readFileSync(turnTimelinePath(env), "utf8");
	} catch {
		return [];
	}
	const rows: TimelineEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as TimelineEvent;
			if (parsed?.turnId === turnId && typeof parsed.n === "number") rows.push(parsed);
		} catch {
			// 半行 / 坏 JSON：跳过，不影响其它行
		}
	}
	rows.sort((a, b) => a.n - b.n);
	return rows.map((row) => ({
		at: row.at,
		kind: row.kind,
		...(row.name !== undefined ? { name: row.name } : {}),
		...(row.ok !== undefined ? { ok: row.ok } : {}),
		...(row.count !== undefined ? { count: row.count } : {}),
		...(row.ms !== undefined ? { ms: row.ms } : {}),
		...(row.chars !== undefined ? { chars: row.chars } : {}),
	}));
}
