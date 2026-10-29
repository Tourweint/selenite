import { request as httpsRequest } from "node:https";
import { SocksProxyAgent } from "socks-proxy-agent";

/**
 * TypeSafe Jev：**不生成文本、只返回带概率的类型化判断**（System One 类模型）。
 *
 * 用途（2026-10-29 起）：给"这一轮该怎么处理"打分 —— 直接回答 / 需要动手（工具）/ 值得深入。
 * 它是**智能 if 语句**，不是聊天模型的替代品：不产出用户可见文本，只做路由与信号。
 *
 * 三条硬约束（都是实测/文档口径，不是猜测）：
 * 1. **境内直连一律 451**（区域封锁；2026-10-22 与 2026-10-29 两次实测都是）。
 *    必须配 `TYPESAFE_PROXY`（如 `socks5h://127.0.0.1:10808`）才能用；
 * 2. 经代理实测 **850–1150ms**（3 次：874 / 1121 / 854）。比"模型思考 2.5–3.5s"省，
 *    但**不是免费**——所以本模块默认只做**旁路观察**（`JEV_ROUTE=advisory`），
 *    不放在首字路径上；`gate`（真改路由）要等双模型档位就绪再开；
 * 3. 选项**顺序敏感**（Pydantic 实测），且**中文效果弱于英文**（官方自陈），
 *    所以 criteria 全部用短中文、选项顺序固定写死，别在运行时重排。
 *
 * 失败一律静默（返回 null + 一行日志）：advisory 信号不能影响主链路。
 */

export type RouteChoice = "reply_direct" | "needs_tools" | "deep_think";

export interface RouteVerdict {
	choice: RouteChoice;
	confidence: number;
	/** 同一次请求顺带拿到的会话信号（有就带上，没配就 null） */
	sessionState: string | null;
	engagement: string | null;
	emotion: string | null;
	endingIntent: number | null;
	ms: number;
}

export type JevMode = "off" | "advisory" | "gate";

interface JevConfig {
	url: string;
	apiKey: string;
	model: string;
	proxy: string | null;
}

export function jevMode(): JevMode {
	const raw = (process.env.JEV_ROUTE ?? "off").trim().toLowerCase();
	return raw === "advisory" || raw === "gate" ? raw : "off";
}

function readConfig(): JevConfig | null {
	const apiKey = process.env.TYPESAFE_API_KEY?.trim();
	if (!apiKey) return null;
	return {
		url: process.env.TYPESAFE_URL?.trim() || "https://api.typesafe.ai/v1/systemone",
		apiKey,
		model: process.env.TYPESAFE_MODEL?.trim() || "jev-latest",
		proxy: process.env.TYPESAFE_PROXY?.trim() || null,
	};
}

/**
 * 四问 + 一问路由（选项顺序固定）。
 *
 * `route` 是新增的那个"智能 if"：客户端拿它决定走直通还是 Agent、用快档还是深档模型；
 * 另外四问复刻 Java 版 `/signal/session` 的口径（收尾/参与度/情绪/结束意图），
 * 留给"Agent 自己判断该不该收尾"（P4）用。
 */
const QUESTIONS = {
	route: {
		type: "choice",
		instructions:
			"判断最后一条用户消息该怎么处理：直接回答、需要动手操作、还是需要长时间深入思考。",
		criteria: {
			reply_direct: "闲聊、情绪表达、简单事实问答，直接说话就能答，不需要查任何东西",
			needs_tools: "需要读写文件、执行命令、检索资料、设置提醒等动手操作才能完成",
			deep_think: "需要对已有材料做长文整理、多步推理或成稿，但没有外部操作需求",
		},
	},
	session_state: {
		type: "choice",
		instructions: "以最后一条用户消息为准，判断用户此刻的会话状态。",
		criteria: {
			continue: "还想继续聊，或正在正常叙述、提问、开启新话题",
			wrap_up_suggested: "出现收尾迹象（敷衍应答、简短回应、情绪收束），但还没明确说结束",
			wrap_up_confident: "明确表达了今天到此为止、结束对话的意图",
		},
	},
	engagement: {
		type: "choice",
		instructions: "评估最后一条用户消息体现的参与程度。",
		criteria: {
			engaged: "投入地叙述或提问",
			brief: "简短但有信息增量",
			perfunctory: "纯敷衍应付，无信息量",
		},
	},
	emotion: {
		type: "choice",
		instructions: "最后一条用户消息体现的主要情绪信号。",
		criteria: {
			none: "无明显情绪信号",
			positive: "正面",
			negative: "负面",
			anxious: "焦虑",
			tired: "疲惫",
			angry: "愤怒",
		},
	},
	ending_intent: {
		type: "noul",
		instructions: "最后一条用户消息是否明确表达了今天到此为止、结束对话的意图？",
		criteria: { false: "没有结束意图，还想继续", true: "明确表达了今天到此为止" },
	},
} as const;

export interface TurnSnapshot {
	recent: Array<{ role: "user" | "assistant"; text: string }>;
	today: string;
	turnCount: number;
}

/**
 * 紧凑 state（照抄 Java 版的口径，token 才 1k 出头）：
 * 只带最近 3 条、最后一条用户消息 ≤300 字、其余 ≤120 字；
 * `turn_count` / `last_user_chars` 由**代码**算好（Jev 官方自陈计数与算术不可靠）。
 */
function buildState(snapshot: TurnSnapshot): Record<string, unknown> {
	const safe = snapshot.recent.slice(-3);
	const lastUser = [...safe].reverse().find((m) => m.role === "user");
	return {
		today: snapshot.today,
		turn_count: snapshot.turnCount,
		last_user_chars: lastUser?.text.length ?? 0,
		recent: safe.map((m, index) => {
			const isLast = index === safe.length - 1 && m.role === "user";
			const cap = isLast ? 300 : 120;
			return { role: m.role, text: m.text.slice(0, cap) };
		}),
	};
}

/** 一次判断；失败/超时/未配 key 一律返回 null（调用方当"没有信号"处理）。 */
export async function classifyTurn(
	snapshot: TurnSnapshot,
	timeoutMs = 3_000,
): Promise<RouteVerdict | null> {
	const config = readConfig();
	if (!config) return null;

	const startedAt = Date.now();
	const body = JSON.stringify({
		model: config.model,
		state: buildState(snapshot),
		questions: QUESTIONS,
	});

	try {
		const payload = await postJson(config, body, timeoutMs);
		const answers = (payload.answers ?? {}) as Record<string, Record<string, unknown>>;
		const route = answers.route ?? {};
		const choice = String(route.choice ?? "");
		if (choice !== "reply_direct" && choice !== "needs_tools" && choice !== "deep_think") {
			return null;
		}
		return {
			choice,
			confidence: Number(route.confidence ?? 0),
			sessionState: str(answers.session_state?.choice),
			engagement: str(answers.engagement?.choice),
			emotion: str(answers.emotion?.choice),
			endingIntent: num(answers.ending_intent?.noul),
			ms: Date.now() - startedAt,
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// 只记类型/耗时，不记对话内容（隐私口径与 LLM 透传一致）
		console.warn(`[jev] 判定失败 ${Date.now() - startedAt}ms: ${detail}`);
		return null;
	}
}

function str(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 代理 agent 复用（2026-10-29 实测教训）：
 * 每次 new SocksProxyAgent 都要重新建隧道，实测同一条请求 1.1s → 2.8s 地抖。
 * 模块级缓存 + keepAlive 之后稳定在 1s 上下。
 */
const agentCache = new Map<string, SocksProxyAgent>();

function agentFor(proxy: string): SocksProxyAgent {
	const hit = agentCache.get(proxy);
	if (hit) return hit;
	const agent = new SocksProxyAgent(proxy, { keepAlive: true });
	agentCache.set(proxy, agent);
	return agent;
}

/** POST（可选 socks5；Node 内置 fetch 不吃 socks，所以走 node:https + agent） */
function postJson(config: JevConfig, body: string, timeoutMs: number): Promise<{ answers?: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const url = new URL(config.url);
		const request = httpsRequest(
			{
				hostname: url.hostname,
				port: url.port || 443,
				path: `${url.pathname}${url.search}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
					Authorization: `Bearer ${config.apiKey}`,
				},
				...(config.proxy ? { agent: agentFor(config.proxy) } : {}),
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
						// 451 = 区域封锁（没配代理时的典型返回值），401 = key 无效
						reject(new Error(`HTTP ${response.statusCode} ${text.slice(0, 120)}`));
						return;
					}
					try {
						resolve(JSON.parse(text) as { answers?: Record<string, unknown> });
					} catch {
						reject(new Error("响应不是 JSON"));
					}
				});
			},
		);
		request.setTimeout(timeoutMs, () => request.destroy(new Error("超时")));
		request.on("error", reject);
		request.write(body);
		request.end();
	});
}
