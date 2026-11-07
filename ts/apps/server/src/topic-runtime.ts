import { randomUUID } from "node:crypto";
import { defineTask } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { nextCronFire } from "./cron.ts";
import { CHIEF_PARTNER_ID } from "./partners.ts";
import { TOPICS_ENABLED, topicsStore, type Topic } from "./topics.ts";

/**
 * 课题定时与研究回合（2026-11-07 长期课题跟进 §四）。
 *
 * 触发层照 `routines.ts` 的 RoutineTask：durable `sleepUntil` 落库（重启照样响）、
 * 醒来对 `revision`（课题被改 / 停 / 删就作废）、deliver 在**同一个 commit** 里先排下一次
 * 再 fire-and-forget 触发研究回合。研究执行不放在任务图里——一次模型回合几分钟，
 * 会把总管会话的任务队列堵死。
 *
 * 研究回合是一条 `task-topic-*` 后台专线对话（不进会话列表）：
 * 提示词 = 课题问题 + 全部发现日志 + 按口味选段；工具面只有 `read` + `web_search`。
 * 收尾由系统**确定性**取最后一条 assistant 文本存 finding，不靠模型调工具落盘。
 */

/** 与 routines.ts 同一背景上下文（不绑任何请求；不携带内容）。 */
const CTX = BACKGROUND_CONTEXT;

/** 提示词里回放多少条历史发现（最新在前）。 */
const FINDING_PROMPT_LIMIT = 20;
/** 单条发现正文回放上限（防止提示词无限长）。 */
const FINDING_BODY_LIMIT = 800;

export interface TopicTaskInput {
	topicId: string;
	/** 计划触发时刻（epoch 毫秒） */
	fireAt: number;
	/** 建任务时的课题版本；醒来对不上 = 课题被改 / 停 / 删，作废 */
	revision: number;
}

/** 进程内的"已排下一次"记录：让 ensureScheduled 幂等（同一 revision + 同一触发时刻只建一个任务）。 */
const scheduled = new Map<string, string>();

export const TopicTask = defineTask<
	TopicTaskInput,
	{ phase: "wait" } | { phase: "deliver" },
	string
>({
	name: "lifediary.topic",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, context) =>
			runtime.sleepUntil(task.input.fireAt, { phase: "deliver" }, context),
		deliver: async (task, runtime, context) => {
			const store = topicsStore();
			const topic = TOPICS_ENABLED ? store.get(task.input.topicId) : null;
			const current =
				topic && topic.status === "active" && topic.revision === task.input.revision
					? topic
					: null;
			await runtime.commit(
				async (tx) => {
					if (current) {
						// 先排下一个，再触发本次：崩在中间最多漏一次触发，不会断链
						const next = nextCronFire(current.cron, new Date());
						if (next) {
							await tx.createTask(
								TopicTask,
								{
									topicId: current.id,
									fireAt: next.getTime(),
									revision: current.revision,
								},
								{ ownership: { kind: "conversation" } },
							);
							rememberScheduled(current.id, current.revision, next);
						} else {
							scheduled.delete(current.id);
						}
					}
					return {
						status: "terminal",
						// outcome 只记枚举，不记课题内容
						outcome: { status: "completed", result: current ? "fired" : "stale" },
					};
				},
				context,
			);
			if (current) {
				void runResearchTurn(current.id, { trigger: "cron" });
			}
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function rememberScheduled(topicId: string, revision: number, fireAt: Date): void {
	scheduled.set(topicId, `${topicId}:${revision}:${fireAt.getTime()}`);
}

/**
 * 按当前 cron 给课题排下一次（幂等）：active 才排，paused / closed 不排。
 *
 * 挂在**总管主会话**的任务图上（照 routines.ts ensureScheduled）——会话在任务就在。
 */
export async function ensureScheduled(topicId: string): Promise<Date | null> {
	if (!TOPICS_ENABLED) return null;
	const topic = topicsStore().get(topicId);
	if (!topic || topic.status !== "active") {
		scheduled.delete(topicId);
		return null;
	}
	const next = nextCronFire(topic.cron, new Date());
	if (!next) {
		scheduled.delete(topicId);
		return null;
	}
	const key = `${topic.id}:${topic.revision}:${next.getTime()}`;
	if (scheduled.get(topicId) === key) return next;

	const chat = await (await import("./partner-runtime.ts")).ensurePartnerSession(CHIEF_PARTNER_ID);
	if (!chat) throw new Error("总管会话取不到，课题任务排不上");
	await chat.conversation.commit(
		(tx) =>
			tx.createTask(
				TopicTask,
				{ topicId: topic.id, fireAt: next.getTime(), revision: topic.revision },
				{ ownership: { kind: "conversation" } },
			),
		CTX,
	);
	rememberScheduled(topic.id, topic.revision, next);
	return next;
}

// ── 研究回合 ─────────────────────────────────────────────

export interface ResearchRunResult {
	ok: boolean;
	text: string;
	summary?: string;
	noNew?: boolean;
	/** 枚举原因：deferred / inactive / not_found / llm_not_configured / empty / failed */
	error?: string;
}

/** 同一课题串行：上一次没跑完，本次跳过（进程内足够，课题最多 5 个）。 */
const running = new Set<string>();

export type ResearchTrigger = "cron" | "manual";

/**
 * 跑一次研究回合。
 *
 * 失败只记枚举原因，不抛进程；成功追加 finding（pendingPush = true 等下一次用户活跃）。
 */
export async function runResearchTurn(
	topicId: string,
	options: { trigger: ResearchTrigger },
): Promise<ResearchRunResult> {
	if (!TOPICS_ENABLED) return { ok: false, text: "", error: "inactive" };
	if (running.has(topicId)) {
		topicsStore().setLastError(topicId, "deferred");
		return { ok: false, text: "", error: "deferred" };
	}
	const topic = topicsStore().get(topicId);
	if (!topic) return { ok: false, text: "", error: "not_found" };
	if (topic.status !== "active") return { ok: false, text: "", error: "inactive" };

	running.add(topicId);
	const startedAt = Date.now();
	try {
		// 动态 import：agent.ts 静态引用本文件的 TopicTask（任务注册），
		// 这里反向静态引用就成了模块环；运行期再取没有代价。
		const { chatStream, configureResearchChat, openOrCreateChat } = await import("./agent.ts");
		const chat = await openOrCreateChat(
			`task-topic-${topic.id.slice(0, 8)}-${Date.now()}`,
		);
		await configureResearchChat(chat, renderResearchPrompt(topic));

		let text = "";
		for await (const event of chatStream({
			conversation: chat.conversation,
			text: "开始本次研究。",
			requestId: randomUUID(),
		})) {
			if (event.type === "delta") text += event.text;
			else if (event.type === "unanswered") {
				topicsStore().setLastError(topicId, "unanswered");
			}
		}

		if (!text.trim()) {
			topicsStore().setLastError(topicId, "empty");
			return { ok: false, text: "", error: "empty" };
		}

		const parsed = parseResearchOutput(text);
		topicsStore().appendFinding(topicId, {
			summary: parsed.summary,
			body: text,
			noNew: parsed.noNew,
			runConversationId: String(chat.internalId),
		});
		// 只记条数 / 字数 / 耗时 / 枚举，不记发现正文。
		console.log(
			`[topic] 研究完成 ${topicId.slice(0, 8)} trigger=${options.trigger} chars=${text.length} noNew=${parsed.noNew} ms=${Date.now() - startedAt}`,
		);
		return { ok: true, text, summary: parsed.summary, noNew: parsed.noNew };
	} catch (error) {
		const reason = classifyResearchError(error);
		topicsStore().setLastError(topicId, reason);
		console.warn(
			`[topic] 研究失败 ${topicId.slice(0, 8)} reason=${reason} ms=${Date.now() - startedAt}`,
		);
		return { ok: false, text: "", error: reason };
	} finally {
		running.delete(topicId);
	}
}

/** 跳过 cron 立刻研究一次（探针与后续界面用）。 */
export async function runTopicNow(topicId: string): Promise<ResearchRunResult> {
	return runResearchTurn(topicId, { trigger: "manual" });
}

function classifyResearchError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/LLM 未配置|llm_not_configured|未配置模型/i.test(message)) return "llm_not_configured";
	return "failed";
}

/**
 * 确定性收尾解析：
 *   - 最后一行含「无新进展」→ noNew（解析失败一律当有进展）；
 *   - 最后一条「结论：…」→ summary（缺失就取全文前 80 字）。
 */
export function parseResearchOutput(text: string): { summary: string; noNew: boolean } {
	const lines = text
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const last = lines.at(-1) ?? "";
	const noNew = last.includes("相比上次") && last.includes("无新进展");
	const conclusion = [...lines]
		.reverse()
		.find((line) => /^结论[:：]/.test(line))
		?.replace(/^结论[:：]\s*/, "")
		.trim();
	const summary = (conclusion || text.replace(/\s+/g, " ").trim()).slice(0, 80);
	return { summary, noNew };
}

/** 研究提示词：公共头 + 课题 + 发现日志 + 口味段 + 收尾格式（硬约定）。 */
export function renderResearchPrompt(topic: Topic): string {
	const findings = topic.findings.slice(0, FINDING_PROMPT_LIMIT);
	const log =
		findings.length === 0
			? "（这是第一次研究，还没有历史发现。）"
			: findings
					.map((finding, index) => {
						const body = finding.body.replace(/\s+/g, " ").trim().slice(0, FINDING_BODY_LIMIT);
						return `${index + 1}. ${finding.date}｜${finding.summary}｜${body}`;
					})
					.join("\n");

	const flavor =
		topic.flavor === "watch"
			? [
					"# 本轮要求（盯梢型 watch）",
					"重点是**与上次相比有什么变化**：新消息、新数据、政策/价格/论文/动态的变动。",
					"查不到新东西就明说，不许为了凑字数把旧结论换个说法再说一遍。",
					"先摸清事实再下判断；能用 web_search 查到的公开资料优先用搜索。",
				].join("\n")
			: [
					"# 本轮要求（啃题型 dig）",
					"重点是**接着上次往下啃一小块**：在已有理解上推进一个具体的小问题，并说明这次推进了哪一块。",
					"不要重复上一轮已经说清的背景；把这一轮的边界（懂了什么、还差什么）写出来。",
					"能用 web_search 查到的公开资料优先用搜索；需要看本地资料时用 read。",
				].join("\n");

	return [
		"你是总管的研究分身，正在执行一次定时研究。只做调查与综合：不改文件、不派活、不碰任务中心。",
		`本轮工具只有只读的 read 与 web_search；回答要像一个靠谱的研究员，不编造来源。`,
		"",
		`# 课题\n${topic.question}`,
		`口味：${topic.flavor === "watch" ? "watch（盯梢型）" : "dig（啃题型）"}`,
		"",
		"# 已有发现（最新在前）",
		log,
		"",
		flavor,
		"",
		"# 收尾格式（硬约定，必须照做）",
		"倒数第二行：结论：<一句话结论>",
		"最后一行：相比上次：<变化描述>；如果确实没有新进展，就写「相比上次：无新进展」。",
	].join("\n");
}
