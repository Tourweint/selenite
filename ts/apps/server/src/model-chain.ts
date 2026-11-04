
/**
 * 伙伴的模型候选链（2026-11-05 批次B B4）。
 *
 * 参考 cindy `botModelChain.ts`（~100 行纯函数）的核心纪律：
 *   - **只切用户显式配置的链里的下一项，绝不从目录发明路由**；
 *   - fallback 只改当前轮的重试路由，不暗改档案（下一轮仍从链头试，除非用户改链）；
 *   - "不可用"才切。cindy 的"额度耗尽不切（同账号每个候选都一样死）"在本仓**不成立**：
 *     候选链是跨供应商的（不同账号），一家的额度死不影响另一家——所以 429/配额也算可切。
 *     真正不切的三类照抄：用户主动停止（aborted）、权限拒绝/参数错误、上下文超限
 *     （切了只会掩盖真因）。
 *
 * 密钥纪律（硬约束）：链项只存 `keyEnv` **名**，绝不存值；解析走 provider.ts 的
 * envApiKeyAuth（每次解析现读 env，与密钥直填的热注入天然兼容）。
 */

export interface ModelChainItem {
	providerId: string;
	modelId: string;
	/** env 变量名（不是值！） */
	keyEnv: string;
	/** 可选思考档（off/low/medium/high；validateModelChain 校验过）。v1 落库未接线 */
	thinkingLevel?: string;
}

export type UnansweredClass = "switchable" | "final";

/**
 * 把 durable 结算的 unanswered reason 归类。
 *
 * switchable（换下一候选有意义）：连接类（ECONN系列、ETIMEDOUT、ENOTFOUND）、超时、
 * 上游 5xx、429/限流/配额（跨供应商链里下一家是另一个账号）、鉴权失败（401/403、
 * invalid key——单家的 key 坏了换一家）、模型不存在/下线。
 * final（切了也白切或掩盖真因）：用户中止、上下文超限、参数/请求非法。
 */
export function classifyUnanswered(reason: string): UnansweredClass {
	const text = (reason ?? "").toLowerCase();
	if (!text) return "final";
	if (
		/abort|cancelled|canceled|user.?stop|interrupt/.test(text) ||
		/context.{0,12}(length|window|too.{0,6}long)|maximum context|token limit exceed/.test(text) ||
		/invalid.{0,12}(parameter|request|body)|bad request|unprocessable/.test(text)
	) {
		return "final";
	}
	if (
		/econn|etimedout|enotfound|ehostunreach|enetunreach|timeout|socket hang up/.test(text) ||
		/\b5\d\d\b|bad gateway|service unavailable|gateway timeout|overloaded|capacity/.test(text) ||
		/\b429\b|rate.?limit|too many requests|quota|exceeded/.test(text) ||
		/\b401\b|\b403\b|unauthorized|invalid api key|authentication|api key/.test(text) ||
		/model.{0,12}(not.{0,6}found|not.{0,6}exist|decommission|unavailable)/.test(text)
	) {
		return "switchable";
	}
	// 认不出的原因不切（切了是赌博，不切最多慢一拍）
	return "final";
}

export interface ChainVerdict {
	action: "retry" | "give-up";
	target?: ModelChainItem;
	/** 判定理由（枚举口径，给日志） */
	reason: string;
}

/**
 * 给出下一个候选。
 *
 * 当前路由在链里 → 取它之后的第一项；不在链里 → 从链头开始（cindy 同款：
 * 用户配的链就是全部事实，没配就别自作聪明）。
 */
export function nextChainCandidate(
	chain: ModelChainItem[],
	current: { provider: string; modelId: string } | null,
	unansweredReason: string,
): ChainVerdict {
	if (chain.length === 0) return { action: "give-up", reason: "链为空" };
	if (classifyUnanswered(unansweredReason) === "final") {
		return { action: "give-up", reason: "原因不可切（用户停止/上下文/参数类）" };
	}
	// durable 会话的 modelId 带 #think- 后缀（档位变体），比对时剥掉
	const bareCurrent = current?.modelId.split("#")[0] ?? "";
	const index = chain.findIndex(
		(item) => item.providerId === current?.provider && item.modelId === bareCurrent,
	);
	const start = index === -1 ? 0 : index + 1;
	if (index !== -1 && start >= chain.length) {
		return { action: "give-up", reason: "链已到尾" };
	}
	const target = chain[index === -1 ? 0 : start];
	if (!target) return { action: "give-up", reason: "链已到尾" };
	return {
		action: "retry",
		target,
		reason: index === -1 ? "当前路由不在链内，从链头重试" : `链内第 ${start + 1} 项`,
	};
}

/** 结构校验：给 HTTP 写入口用。只允许引用（keyEnv 名），出现疑似值的字段直接拒。 */
export function validateModelChain(items: unknown): string | null {
	if (!Array.isArray(items)) return "modelChain 必须是数组";
	if (items.length > 5) return "候选链最多 5 项（cindy 同款上限）";
	for (const raw of items) {
		const item = raw as Partial<ModelChainItem> & Record<string, unknown>;
		if (typeof item.providerId !== "string" || !item.providerId.trim()) {
			return "链项缺 providerId";
		}
		if (typeof item.modelId !== "string" || !item.modelId.trim()) {
			return "链项缺 modelId";
		}
		if (typeof item.keyEnv !== "string" || !item.keyEnv.trim()) {
			return "链项缺 keyEnv（env 变量名）";
		}
		// 密钥纪律：keyEnv 只能是 env 变量名形状（值走 env，永不落档案）
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item.keyEnv)) {
			return "keyEnv 必须是 env 变量名（字母/数字/下划线）";
		}
		for (const forbidden of ["apiKey", "api_key", "secret", "token"]) {
			if (forbidden in item) {
				return `链项不许带 ${forbidden}（只允许 keyEnv 名，密钥纪律）`;
			}
		}
		if (item.thinkingLevel !== undefined && !["off", "low", "medium", "high"].includes(String(item.thinkingLevel))) {
			return "thinkingLevel 只能是 off / low / medium / high";
		}
	}
	return null;
}
