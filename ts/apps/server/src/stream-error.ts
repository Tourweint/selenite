import { redactSecrets } from "@lifediary/memory";
import type { StreamErrorCode } from "@lifediary/shared";

/**
 * 上游/模型错误 → 给前端的安全短句（2026-11-10，批 32）。
 *
 * 为什么存在：`chatStream` 的 `unanswered` 记录里 `detail` 是**上游原文**
 * （内核 `generation.js` 的 `failModelError` 把原始错误文本整个存进去），
 * 可能带上游地址甚至 key 片段——硬约束"密钥不下发"意味着原文绝不能透给前端。
 * 但只发一句笼统的"生成失败"又让人没法处置（限流该等、密钥该去设置页、
 * 上下文超长该开新会话——三种错三种动作）。
 *
 * 折中：分类 + 脱敏。`message` 是按类别给的中文短句（措辞跟着 code 走，
 * 客户端只认 code 不认文案）；`detail` 是**打码后的原文摘要**——
 * `redactSecrets` 打掉 key/token/JWT/长随机串，再剥 URL 里的上游主机、截断。
 * 原始错误完整原文照旧只进服务端日志（index.ts 的 console.error），不在这里。
 *
 * 纯函数、零时钟、零 env：同类输入永远同类输出，方便单测钉住。
 */

/** 每类错误给人看的一句话。措辞目标：说出"是什么"＋"你该干什么"。 */
const MESSAGES: Record<StreamErrorCode, string> = {
	rate_limited: "上游限流了，等一会儿再试。",
	auth: "密钥没有通过校验，去设置页检查一下 API Key。",
	timeout: "上游等太久没有响应，重试一次。",
	network: "连不上上游服务，检查网络或供应商地址。",
	context_overflow: "这段对话太长，超出了模型的上下文，开个新会话或让它少带点内容。",
	model_error: "上游返回了错误，稍后再试。",
	unknown: "生成失败，请稍后重试。",
};

/** detail 摘要的最长长度：小窗里一屏能看全，再长也看不出更多 */
const DETAIL_LIMIT = 400;

/** URL 里的主机名：协议 + 主机整体打掉，只留路径形状（`…/v1/chat/completions` 有助于认出是哪家） */
function stripHosts(text: string): string {
	return text.replace(
		/\bhttps?:\/\/[^\s/:?#]+(?::\d+)?/gi,
		(match) => `«上游地址 ${new URL(match).pathname}»`,
	);
}

/** 分类成安全短句。返回 `null` 表示"这个 reason 前端不需要错误卡"（aborted 等）。 */
export function describeStreamError(reason: string, detail?: unknown): {
	code: StreamErrorCode;
	message: string;
	detail?: string;
} | null {
	// 人自己停的：前端已有「已中断生成」的痕迹行，再弹错误卡就是报二遍。
	if (reason === "aborted" || reason === "reset") return null;
	// 没配模型：设置页动作就够，不算上游错误。
	if (reason === "no_model") {
		return { code: "auth", message: MESSAGES.auth };
	}
	// model_error（以及没见过的 reason）才去读原文分类。
	const raw = typeof detail === "string" ? detail : String(detail ?? "");
	const code = classifyErrorText(raw);
	return { code, message: MESSAGES[code], ...(raw ? { detail: sanitizeDetail(raw) } : {}) };
}

/** 从上游原文猜类别。关键词来自各家 OpenAI 兼容网关的常见措辞，宁多勿漏。 */
function classifyErrorText(raw: string): StreamErrorCode {
	const text = raw.toLowerCase();
	if (/(rate\s*limit|429|too many requests|quota|限流|配额)/.test(text)) return "rate_limited";
	if (/(401|403|invalid[_\s]?api[_\s]?key|unauthorized|authentication|invalid[_\s]?request[_\s]?key|无效的密钥|鉴权)/.test(text))
		return "auth";
	if (/(timeout|timed?\s*out|etimedout|econnaborted|aborted.*timeout|请求超时)/.test(text))
		return "timeout";
	if (/(context length|context_length|maximum context|too long|上下文|超长)/.test(text))
		return "context_overflow";
	if (/(econnrefused|enotfound|ehostunreach|enetunreach|fetch failed|network|econnreset|connection error|getaddrinfo)/.test(text))
		return "network";
	return "model_error";
}

/** 脱敏三步：打码凭据 → 剥上游主机 → 截断。输出保证不含 key 片段与完整上游地址。 */
function sanitizeDetail(raw: string): string {
	const one = stripHosts(redactSecrets(String(raw).trim()));
	if (!one) return "";
	return one.length > DETAIL_LIMIT
		? `${one.slice(0, DETAIL_LIMIT)}…（还有 ${one.length - DETAIL_LIMIT} 字符）`
		: one;
}
