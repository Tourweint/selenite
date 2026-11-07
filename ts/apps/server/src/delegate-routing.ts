/**
 * 派活路由判定（2026-11-07 消息即引导与执事直派）。
 *
 * 一个纯函数回答一件事：**这次 delegate 该以谁的名义、走哪条路径**。
 * 之所以单独成模块：tools.ts 的装配太重（一 import 就建 memoryEngine），
 * 而这段判定要能被单测直接钉死。
 *
 * 背景（为什么需要它）：
 *   执事 = chancellor 的分管宰相穿上执事身份。他在自己领域里派活时，若照旧按
 *   domain 注入 managerIdentity，chancellor 会为该领域再起一个"分管宰相"——
 *   等于执事把自己叫了一遍，多一层进程、多一轮模型调用、身份叠两层。
 *   他本来就是那个领域的负责人，正确做法是**直派**（managers:false），
 *   身份不再注入，但 domain 保留，任务中心仍能看出"这活是哪个领域派的"。
 */

export interface DelegateCaller {
	/** 调用方会话绑定的执事 id；`chief` = 总管，`null` = 主人普通会话。 */
	partnerId: string | null;
	/** 调用方执事的领域（小写 ASCII）；普通执事 / 总管为 null。 */
	domain: string | null;
}

export type DelegateRouting =
	/** 总管 / 主人会话：原样——按 domain 注入执事身份，chancellor 走分管路径。 */
	| { kind: "managed"; domain: string; identityDomain: string }
	/** 执事在自己领域内派活：直派 worker，不再起分管宰相。 */
	| { kind: "direct"; domain: string }
	/** 执事试图把活派到别人的领域：明确拒绝，不静默改道。 */
	| { kind: "rejected"; reason: string };

/** 总闸：`MINISTER_DIRECT_DISPATCH=false` 回到"一律走分管"的旧行为（一行 env 回滚）。 */
export function directDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.MINISTER_DIRECT_DISPATCH?.trim().toLowerCase();
	return raw !== "false" && raw !== "0";
}

/**
 * 决定这次派活的路由。
 *
 * 判定顺序即语义：
 *   1. 调用方不是执事（总管 / 主人会话）→ 原样分管；
 *   2. 总闸关 → 原样分管（回滚路径，行为与改动前逐字一致）；
 *   3. 请求的 domain 为空或等于自己 → 直派；
 *   4. 请求了别人的领域 → 拒绝。
 *
 * `requestedDomain` 为空表示"没指定领域"：执事在自己领域里干活，这是常态，
 * 不能因为模型没填 domain 就退化成"再起一个自己"。
 */
export function resolveDelegateRouting(
	caller: DelegateCaller,
	requestedDomain: string,
	env: NodeJS.ProcessEnv = process.env,
): DelegateRouting {
	const domain = requestedDomain.trim();
	const own = caller.domain?.trim() || "";

	// 不是执事：维持既有语义（含"没填 domain 就直派 worker"）
	if (!own) {
		return domain ? { kind: "managed", domain, identityDomain: domain } : { kind: "managed", domain: "", identityDomain: "" };
	}

	if (!directDispatchEnabled(env)) {
		return domain
			? { kind: "managed", domain, identityDomain: domain }
			: { kind: "managed", domain: "", identityDomain: "" };
	}

	if (!domain || domain === own) return { kind: "direct", domain: own };

	return {
		kind: "rejected",
		reason: `你是「${own}」领域的执事，只能在自己领域内派活；跨领域请让总管来派（当前请求：${domain}）。`,
	};
}

/**
 * 把路由翻译成 chancellor 请求上的两个字段。
 *
 * `managers: false` 是 chancellor 已有的硬开关（`src/index.ts:161`），
 * 递归在参数层断掉——不需要改跨仓契约。
 */
export function routingToRequestFields(
	routing: DelegateRouting,
): { domain: string; managers?: false; injectIdentity: boolean } {
	if (routing.kind === "direct") {
		return { domain: routing.domain, managers: false, injectIdentity: false };
	}
	if (routing.kind === "managed") {
		return { domain: routing.domain, injectIdentity: routing.identityDomain !== "" };
	}
	return { domain: "", managers: false, injectIdentity: false };
}
