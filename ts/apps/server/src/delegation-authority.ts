import type { ReceiptAuthority } from "./delegation-receipts.ts";

/**
 * 授权依据 + 恢复前重验（2026-11-10 批 19 §六；全景调研四 §4.3）。
 *
 * 派单受理时把当时的审批档位写进回执（`ReceiptAuthority {level, at}`，批 16 只落了列）；
 * `resumeTicket` 续跑前比对"受理时"与"现在"的档位：
 *   - 现在更严 → **照常续跑，只记 warning**（不阻断：一单跑到一半被档位变化卡死更糟）；
 *   - 现在相同 / 更松 → 直接跑；
 *   - 任一边读不到 → 按"更严"处理（同样只记 warning）。
 *
 * 这里只产出"结论 + 日志文案"，不碰存储、不碰会话；写回执与打日志分别在调用方。
 */

export type AuthorityRecheckVerdict = "same" | "looser" | "stricter" | "unknown";

export interface AuthorityRecheck {
	verdict: AuthorityRecheckVerdict;
	/** 是否按"更严"处理（stricter / unknown）。只用于记 warning，永不阻断。 */
	stricter: boolean;
	/** 服务端日志文案；不含对话内容，只有档位枚举。 */
	warning?: string;
}

/** 三档排序：none 最松，ask-all 最严；认不出的档位名 → null（按读不到处理）。 */
export function authorityRank(level: string | null | undefined): number | null {
	const value = (level ?? "").trim().toLowerCase();
	if (value === "none") return 0;
	if (value === "ask-critical") return 1;
	if (value === "ask-all") return 2;
	return null;
}

/** 回滚开关：默认开；`DELEGATION_AUTHORITY_RECHECK=false` → 续跑不比对（逐字节回到改动前）。 */
export function authorityRecheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.DELEGATION_AUTHORITY_RECHECK ?? "").trim().toLowerCase();
	if (!raw) return true;
	return !["false", "0", "off"].includes(raw);
}

/**
 * 当前审批档位的来源（由装配层 `agent/lifecycle.ts` 在模块加载时注入）。
 *
 * 为什么不用 `import { policy }`：`tools.ts` 在 arch-guard 里是**静态 import** 的，
 * 它的模块图若静态可达 `agent/policy.ts`，policy 会在测试设 env 之前就加载好初值，
 * 只读闸门的回归断言会全部落空。这里留一个 setter，保持 `tools → delegation`
 * 这条链不碰 policy；没注入时按 `none`（与旧行为一致的安静默认）。
 */
let approvalLevelSource: () => string = () => "none";

export function setApprovalLevelSource(source: () => string): void {
	approvalLevelSource = source;
}

export function currentApprovalLevel(): string {
	try {
		return approvalLevelSource();
	} catch {
		return "none";
	}
}

/** 受理时刻的授权依据快照（写进回执；时间由调用方给，便于单测固定）。 */
export function currentAuthority(at: Date = new Date()): ReceiptAuthority {
	return { level: currentApprovalLevel(), at: at.toISOString() };
}

/**
 * 比对两个档位（纯函数）。`recorded` = 受理回执里记的；`current` = 现在的审批档。
 * 缺 / 认不出都按"更严"处理——宁可多一条 warning，也不要默认放行一次档位不明的续跑。
 */
export function recheckAuthority(
	recorded: string | null | undefined,
	current: string | null | undefined,
): AuthorityRecheck {
	const before = authorityRank(recorded);
	const now = authorityRank(current);
	if (before === null || now === null) {
		return {
			verdict: "unknown",
			stricter: true,
			warning: `[delegate] 续跑授权重验：档位读不到（受理时=${recorded ?? "无"} 现在=${
				current ?? "无"
			}），按更严处理，照常续跑`,
		};
	}
	if (now > before) {
		return {
			verdict: "stricter",
			stricter: true,
			warning: `[delegate] 续跑授权重验：审批档更严了（受理时=${recorded} 现在=${current}），照常续跑并记 warning`,
		};
	}
	return { verdict: now === before ? "same" : "looser", stricter: false };
}
