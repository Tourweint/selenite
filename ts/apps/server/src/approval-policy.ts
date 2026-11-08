/**
 * 审批判定（2026-11-04 批次二，A1）。
 *
 * 单独成模块的理由同 reliability.ts：agent.ts 模块加载即建 memoryEngine / skillStore，
 * 单测 import 它会有副作用。这里只做"给定策略与工具名 → 拦 / 问 / 放"的纯判断。
 *
 * **独立轴**：三档（access）是能力边界，审批档是确认策略，两者可以同时成立。
 * 同时成立时**拦优先**——只读模式下问都不用问，直接拒。
 *
 * 2026-11-08 扫尾批 10-C：确认轴从布尔 `confirmWrites` 升级为三档
 * （`ask-all` / `ask-critical` / `none`）；旧布尔在 policy 层做兼容映射。
 */

/**
 * 会写文件 / 起进程 / 派活的工具。新工具必须加进来，否则 `AGENT_TOOL_POLICY=read-only` 就是个谎。
 * `delegate` 本身不写文件，但它会起 worker 去写；`propose_project` 只写 proposal 行，
 * 但会引出"建目录/登记项目"，与 delegate 同档。
 */
// partner_skill_write（2026-11-05 批次B B2）：写执事的技能文件——写盘即进闸门，这是硬约束。
// partner_manage（批次D D3）：建 / 停执事 = "授予常驻指令 / 新建任务"类，
// 会改角色与 chancellor 领域目录，同样进 WRITE_TOOLS（D14 备忘兑现）。
// group_manage（2026-11-07 群组入口统一）：总管建群 = 新建常驻多成员会话，
// 与 partner_manage 同档（会改"谁跟谁在一起"的关系，不是只读）。
export const WRITE_TOOLS = new Set([
	"write",
	"edit",
	"bash",
	"powershell",
	"delegate",
	"propose_project",
	"partner_skill_write",
	"partner_manage",
	"group_manage",
]);

export interface ApprovalPolicy {
	/** 审批档：全问 / 只问高危 / 全不问 */
	approvalLevel: ApprovalLevel;
}

/** 审批三档（2026-11-08 扫尾批 10-C，用户拍板） */
export type ApprovalLevel = "ask-all" | "ask-critical" | "none";

/**
 * `ask-critical` 的缺省高危清单：会起执行 / 烧 token 的动作。
 *
 * 文件 write / edit 这类常规写**不在**清单里——"只问重要的"就是让它们自动放行。
 * `send_to_agent` 不在 `WRITE_TOOLS`（它不写文件），但它会起一轮对方模型调用，
 * 同样属于"会花钱"的一类，所以单列进来。
 */
export const DEFAULT_CRITICAL_TOOLS = [
	"bash",
	"powershell",
	"delegate",
	"partner_manage",
	"send_to_agent",
] as const;

/**
 * 实际生效的高危清单。`AGENT_APPROVAL_CRITICAL_TOOLS`（逗号分隔）可整体覆盖；
 * 空串 / 未设回落缺省（配错了宁可多问，不能悄悄变成"全不问"）。
 */
export function approvalCriticalTools(
	env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
	const raw = env.AGENT_APPROVAL_CRITICAL_TOOLS?.trim();
	if (!raw) return new Set(DEFAULT_CRITICAL_TOOLS);
	return new Set(
		raw
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
	);
}

export type ApprovalVerdict =
	/** 已有策略直接拦下，与审批无关 */
	| { kind: "block"; reason: string }
	/** 挂起等客户端答复 */
	| { kind: "ask" }
	/** 照常放行 */
	| { kind: "allow" };

/**
 * 这次工具调用该拦、该问、还是放行。
 *
 * `blockReason` 来自现有的 `readOnlyBlockReason()`：黑名单、只读档、不跑命令档都在这里落地。
 * 它优先于审批——被策略拦下的调用没有"确认后就能跑"的说法。
 *
 * 三档（2026-11-08 扫尾批 10-C）：
 *   - `ask-all`：写类工具（`WRITE_TOOLS`）全问，另加高危清单——保证三档单调
 *     （`ask-all` 一定包含 `ask-critical` 问的那些；`send_to_agent` 不在 `WRITE_TOOLS`，
 *     旧布尔只有 true/false，没有"全问却漏掉递话"的道理）；
 *   - `ask-critical`：只问 `critical` 清单（缺省命令 / 派活 / 执事管理 / 递话）；
 *   - `none`：不问——与旧 `confirmWrites:false` 一致。
 */
export function needsApproval(
	policy: ApprovalPolicy,
	tool: string,
	blockReason?: string,
	critical: ReadonlySet<string> = approvalCriticalTools(),
): ApprovalVerdict {
	if (blockReason) return { kind: "block", reason: blockReason };
	if (policy.approvalLevel === "ask-all" && (WRITE_TOOLS.has(tool) || critical.has(tool))) {
		return { kind: "ask" };
	}
	if (policy.approvalLevel === "ask-critical" && critical.has(tool)) return { kind: "ask" };
	return { kind: "allow" };
}

export type ApprovalDenial = "rejected" | "timeout" | "aborted";

/** 拒绝/超时/中止时回给模型的理由（没有参数内容，只有工具名与状态） */
export function denialReason(
	status: ApprovalDenial,
	tool: string,
	timeoutS: number,
): string {
	if (status === "rejected") return `你拒绝了这次 ${tool} 调用，工具没有执行。`;
	if (status === "timeout") {
		return `审批等待超过 ${timeoutS} 秒没有答复，已按拒绝处理，${tool} 没有执行。`;
	}
	return `本轮已停止，${tool} 的审批被取消，工具没有执行。`;
}

/**
 * 审批等待秒数。默认 120（两分钟够人看见并决定，又不至于让一轮对话僵住）。
 * 非法值或 `0` 一律回落 120 —— 这是安全机制，不能因为配错就变成"永不超时"。
 */
export function approvalTimeoutSeconds(env: Record<string, string | undefined>): number {
	const raw = Number(env.AGENT_APPROVAL_TIMEOUT_S?.trim());
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120;
}
